import type { ToolDefinition } from '../api/searchTool.js'
import { readerDocument, readerPage, type BrowserPage } from './browserDocument.js'
import {
  fitCheckpointEntries,
  MAX_BROWSER_CHECKPOINT_BYTES,
  sourceIdFor,
  utf8Size,
  type TaskCachedBrowserPage,
  type TaskReadCheckpoint,
  type TaskReadResult,
} from './evidence.js'
import { readNativeBrowser, type NativeBrowserSnapshot } from './nativeBrowser.js'
import { publicWebUrl, readPublicWeb } from './publicWeb.js'
import {
  excerptEvidence,
  readPosition,
  textExcerpt,
  textPosition,
  type TextPosition,
} from './readerRange.js'
import { recordSchema } from './toolSchema.js'

type BrowserAction = { label?: string; run: (timeoutMs: number) => Promise<TaskReadResult> }
type BrowserOptions = { checkpoint?: TaskReadCheckpoint; nativeReader?: typeof readNativeBrowser }

const invalid = (text: string): TaskReadResult => ({
  isError: true,
  reason: 'invalid-arguments',
  text,
})

const fields = { type: 'string' }
const names = {
  open: 'browser_open',
  view: 'browser_snapshot',
  follow: 'browser_follow_link',
  scroll: 'browser_scroll',
  history: 'browser_history',
} as const

const definitions: ToolDefinition[] = [
  {
    name: names.open,
    description:
      'Open a public website in the task browser using an exact URL entered by the user or discovered by a web tool. Returns the page title, available text, headings and numbered links. The result identifies rendered or static-only coverage.',
    parameters: recordSchema({ url: fields }, ['url']),
  },
  {
    name: names.view,
    description:
      'Inspect the current browser page. Use find or a line range, or use next_offset to read another part. Links are numbered for browser_follow_link.',
    parameters: recordSchema(
      { ...readPosition, links_offset: { type: 'integer', minimum: 0 } },
      []
    ),
  },
  {
    name: names.follow,
    description:
      'Open a numbered public link from the current browser page. Read the new page before following other links.',
    parameters: recordSchema({ link: { type: 'integer', minimum: 1 } }, ['link']),
  },
  {
    name: names.scroll,
    description: 'Scroll the task browser in the given direction and read that area.',
    parameters: recordSchema(
      { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } },
      ['direction']
    ),
  },
  {
    name: names.history,
    description: 'List the open browser history or move back or forward by one page.',
    parameters: recordSchema({ action: { type: 'string', enum: ['list', 'back', 'forward'] } }, [
      'action',
    ]),
  },
]

const MAX_LOADS = 12
const MAX_HISTORY = 16
const MAX_CACHE = 12
const WINDOW = 7200
const MAX_PAGE_TEXT_BYTES = 176 * 1024
const MAX_PAGE_LINK_BYTES = 64 * 1024
export const taskBrowserDefinitions = definitions

const sanitizeBrowserRecord = (
  record: TaskCachedBrowserPage
): TaskCachedBrowserPage | undefined => {
  const url = publicWebUrl(record?.url)
  if (
    !url ||
    typeof record.title !== 'string' ||
    typeof record.text !== 'string' ||
    !Array.isArray(record.links) ||
    !Array.isArray(record.headings)
  ) {
    return undefined
  }
  const encoder = new TextEncoder()
  const bytes = encoder.encode(record.text.slice(0, 150_000))
  const encoded = bytes.subarray(0, MAX_PAGE_TEXT_BYTES)
  const text = new TextDecoder().decode(encoded)
  let linkBytes = 0
  const links: TaskCachedBrowserPage['links'] = []
  const seen = new Set<string>()
  for (const link of record.links.slice(0, 80)) {
    const target = publicWebUrl(link?.url, url)
    if (
      !target ||
      typeof link?.label !== 'string' ||
      target.href === url.href ||
      seen.has(target.href)
    ) {
      continue
    }
    const label = link.label.trim().slice(0, 160)
    if (!label) {
      continue
    }
    linkBytes += utf8Size(target.href) + utf8Size(label) + 32
    if (linkBytes > MAX_PAGE_LINK_BYTES) {
      break
    }
    seen.add(target.href)
    links.push({ label, url: target.href })
  }
  const requestedUrl = publicWebUrl(record.requestedUrl)?.href
  return {
    url: url.href,
    title: record.title.trim().slice(0, 240) || url.hostname,
    text,
    links,
    headings: record.headings
      .slice(0, 28)
      .filter((heading) => typeof heading === 'string')
      .map((heading) => heading.trim().slice(0, 180)),
    sourceTruncated:
      Boolean(record.sourceTruncated) ||
      encoded.byteLength < bytes.byteLength ||
      record.text.length > 150_000,
    bytes:
      typeof record.bytes === 'number' && Number.isSafeInteger(record.bytes) && record.bytes >= 0
        ? record.bytes
        : undefined,
    retrievedAt:
      typeof record.retrievedAt === 'number' && Number.isFinite(record.retrievedAt)
        ? record.retrievedAt
        : undefined,
    mode: record.mode === 'rendered' ? 'rendered' : 'static',
    renderNotice:
      record.renderNotice === 'rendering-unavailable' || record.renderNotice === 'rendering-timeout'
        ? record.renderNotice
        : undefined,
    requestedUrl,
  }
}

const renderedPage = (snapshot: NativeBrowserSnapshot, requestedUrl: string, retrievedAt: number) =>
  sanitizeBrowserRecord({
    ...snapshot,
    sourceTruncated: snapshot.truncated,
    mode: 'rendered',
    requestedUrl,
    retrievedAt,
  })

const staticPage = (
  page: BrowserPage,
  requestedUrl: string,
  bytes: number,
  retrievedAt: number,
  renderNotice?: TaskCachedBrowserPage['renderNotice']
) =>
  sanitizeBrowserRecord({
    ...page,
    sourceTruncated: page.truncated || renderNotice !== undefined,
    renderNotice,
    mode: 'static',
    requestedUrl,
    bytes,
    retrievedAt,
  })

const browserFailure = (
  result: Extract<Awaited<ReturnType<typeof readNativeBrowser>>, { error: unknown }>
): TaskReadResult => ({
  isError: true,
  failure: result.error,
  reason: result.error,
  ...('retryAt' in result && typeof result.retryAt === 'number' && { retryAt: result.retryAt }),
  text:
    'Could not open this page. Reason: ' +
    result.error +
    (result.status ? ' (HTTP ' + result.status + ').' : '.'),
})

export const createTaskBrowser = (
  signal: AbortSignal,
  known: (url: URL) => boolean,
  addLinks: (urls: string[]) => void,
  options: BrowserOptions = {}
) => {
  const pages: TaskCachedBrowserPage[] = []
  const cache = new Map<string, TaskCachedBrowserPage>()
  let index = -1
  let offset = 0
  let loads = 0
  const current = () => pages[index]
  const nativeReader = options.nativeReader ?? readNativeBrowser

  const remember = (page: TaskCachedBrowserPage) => {
    cache.set(page.requestedUrl ?? page.url, page)
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest) {
        cache.delete(oldest)
      }
    }
    addLinks([page.url, ...page.links.map((link) => link.url)])
  }

  const restored = options.checkpoint?.version === 1 ? options.checkpoint.browser : undefined
  if (restored && Array.isArray(restored.pages)) {
    for (const [savedIndex, item] of restored.pages.slice(0, MAX_HISTORY).entries()) {
      const page = sanitizeBrowserRecord(item)
      const url = page && publicWebUrl(page.requestedUrl ?? page.url)
      if (!page || !url || !known(url)) {
        continue
      }
      pages.push(page)
      remember(page)
      if (savedIndex === restored.currentIndex) {
        index = pages.length - 1
      }
    }
    if (index < 0) {
      index = pages.findIndex((page) => page.url === restored.currentUrl)
    }
    if (index < 0) {
      index = pages.length - 1
    }
    if (Number.isSafeInteger(restored.offset) && restored.offset >= 0) {
      offset = Math.min(restored.offset, current()?.text.length ?? 0)
    }
  }

  const render = (
    page: TaskCachedBrowserPage,
    position: TextPosition = { offset },
    linksOffset = 0
  ): TaskReadResult => {
    const excerpt = textExcerpt(page.text, position, WINDOW)
    const evidence = excerptEvidence(
      {
        sourceId: sourceIdFor('browser', page.url),
        kind: 'browser',
        title: page.title,
        url: page.url,
        retrievedAt: page.retrievedAt,
        downloadedBytes: page.bytes,
        partial: page.sourceTruncated,
        sourceTruncated: page.sourceTruncated,
      },
      excerpt,
      position,
      page.text.length
    )
    return {
      source: page.url,
      sourceUrls: [page.url],
      evidence,
      text: JSON.stringify({
        external_reference: true,
        url: page.url,
        title: page.title,
        reader_mode: page.mode,
        reader_notice: page.renderNotice,
        headings: page.headings,
        ...excerpt,
        page_truncated: page.sourceTruncated,
        total_chars: page.text.length,
        links: page.links.slice(linksOffset, linksOffset + 20).map((link, i) => ({
          ...link,
          id: linksOffset + i + 1,
        })),
        next_link_offset: linksOffset + 20 < page.links.length ? linksOffset + 20 : null,
        can_go_back: index > 0,
        can_go_forward: index < pages.length - 1,
        evidence,
      }),
    }
  }

  const navigate = async (url: URL, timeoutMs: number): Promise<TaskReadResult> => {
    let page = cache.get(url.href)
    if (!page) {
      if (loads >= MAX_LOADS) {
        return {
          isError: true,
          reason: 'read-budget',
          text: 'The browser reached the local page budget. The task can continue from its checkpoint.',
        }
      }
      loads++
      const started = performance.now()
      const retrievedAt = Date.now()
      const result = await nativeReader(url, signal, timeoutMs)
      signal.throwIfAborted()
      if ('snapshot' in result) {
        page = renderedPage(result.snapshot, url.href, retrievedAt)
      } else if (result.error === 'browser' || (result.error === 'timeout' && result.fallback)) {
        const remaining = timeoutMs - (performance.now() - started)
        const fallback =
          result.fallback ??
          (remaining > 0
            ? await readPublicWeb(url, false, signal, remaining)
            : { error: 'timeout' as const })
        if ('error' in fallback) {
          return browserFailure(fallback)
        }
        const parsed = readerPage(
          fallback.text,
          fallback.url,
          fallback.contentType,
          fallback.truncated
        )
        const scriptCoverage =
          result.reason !== 'no-scripts' &&
          /^text\/html\b|^application\/xhtml\+xml\b/i.test(fallback.contentType) &&
          /<script\b/i.test(fallback.text)
        page = staticPage(
          parsed,
          url.href,
          fallback.bytes,
          retrievedAt,
          scriptCoverage
            ? result.error === 'timeout'
              ? 'rendering-timeout'
              : 'rendering-unavailable'
            : undefined
        )
      } else {
        return browserFailure(result)
      }
      if (!page || (!page.text && !page.links.length)) {
        return {
          isError: true,
          failure: 'empty',
          reason: 'empty',
          text: 'The page has no readable HTML or text.',
        }
      }
      remember(page)
    }
    if (current() !== page) {
      pages.splice(index + 1, pages.length, page)
      if (pages.length > MAX_HISTORY) {
        pages.shift()
      }
      index = pages.length - 1
    }
    offset = 0
    return render(page)
  }

  const prepare = (
    name: string,
    input: Record<string, unknown>
  ): BrowserAction | TaskReadResult | undefined => {
    if (!definitions.some((tool) => tool.name === name)) {
      return undefined
    }
    const page = current()
    if (name === names.open || name === names.follow) {
      const clicked =
        name === names.follow
          ? typeof input.link === 'number' && Number.isSafeInteger(input.link) && input.link >= 1
            ? page?.links[input.link - 1]?.url
            : undefined
          : input.url
      const url = publicWebUrl(clicked)
      if (!url || (name === names.open && !known(url))) {
        return {
          ...invalid('Use a link from the user, search results or the current page.'),
          failure: 'blocked',
          reason: 'blocked',
        }
      }
      return { label: url.hostname, run: (timeoutMs) => navigate(url, timeoutMs) }
    }
    if (!page) {
      return invalid('Use browser_open first.')
    }
    if (name === names.view) {
      const position = textPosition({ ...input, offset: input.offset ?? offset })
      const linksOffset = input.links_offset ?? 0
      if (
        !position ||
        typeof linksOffset !== 'number' ||
        !Number.isSafeInteger(linksOffset) ||
        linksOffset < 0
      ) {
        return invalid('Provide a valid offset, line range or search phrase.')
      }
      return { label: page.title, run: async () => render(page, position, linksOffset) }
    }
    if (name === names.scroll) {
      const direction = input.direction
      if (
        direction !== 'up' &&
        direction !== 'down' &&
        direction !== 'top' &&
        direction !== 'bottom'
      ) {
        return invalid('Use up, down, top or bottom.')
      }
      return {
        label: page.title,
        run: async () => {
          const maximum = Math.max(0, page.text.length - WINDOW)
          switch (direction) {
            case 'up':
              offset = Math.max(0, offset - WINDOW)
              break
            case 'down':
              offset = Math.min(maximum, offset + WINDOW)
              break
            case 'top':
              offset = 0
              break
            case 'bottom':
              offset = maximum
              break
          }
          return render(page)
        },
      }
    }
    if (input.action === 'list') {
      return {
        text: JSON.stringify({
          current: index + 1,
          pages: pages.map(({ title, url }) => ({ title, url })),
        }),
      }
    }
    const next = input.action === 'back' ? index - 1 : input.action === 'forward' ? index + 1 : -1
    if (!pages[next]) {
      return invalid('There is no page in that direction.')
    }
    return {
      label: pages[next].title,
      run: async () => {
        index = next
        offset = 0
        return render(pages[index])
      },
    }
  }

  return {
    prepare,
    checkpoint(): TaskReadCheckpoint {
      const first = current()
      // Retain the current page first, then the most recent reachable history.
      const ranked = pages
        .map((page, savedIndex) => ({ page, savedIndex }))
        .filter((item) => item.savedIndex !== index)
        .reverse()
      if (first) {
        ranked.unshift({ page: first, savedIndex: index })
      }
      const retained = new Set(
        fitCheckpointEntries(ranked, MAX_BROWSER_CHECKPOINT_BYTES - 4096, MAX_HISTORY).map(
          (item) => item.savedIndex
        )
      )
      const saved = pages.filter((_, savedIndex) => retained.has(savedIndex))
      const currentIndex = retained.has(index)
        ? [...retained].filter((savedIndex) => savedIndex < index).length
        : undefined
      return {
        version: 1,
        browser: {
          pages: saved,
          currentUrl: first?.url,
          currentIndex,
          offset,
        },
      }
    },
  }
}

export const openBrowserPreview = async (url: string, signal: AbortSignal) => {
  const target = publicWebUrl(url)
  if (!target) {
    return { error: 'blocked' } as const
  }
  const result = await readPublicWeb(target, false, signal, 15_000)
  return 'error' in result
    ? result
    : { page: readerPage(result.text, result.url, result.contentType, result.truncated) }
}

export { readerDocument }
