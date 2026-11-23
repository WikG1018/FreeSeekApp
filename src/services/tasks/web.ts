import type { ToolDefinition } from '../api/searchTool.js'
import {
  fitCheckpointEntries,
  MAX_SOURCE_CHARS,
  MAX_WEB_CHECKPOINT_BYTES,
  sourceIdFor,
  utf8Size,
  type TaskCachedSource,
  type TaskReadCheckpoint,
  type TaskReadResult,
  type TaskReadReason,
} from './evidence.js'
import {
  commitSha,
  githubActions,
  githubLinkQuery,
  githubPinKey,
  githubPinRequests,
  githubQuery,
  githubRepo,
  githubRequests,
  needsGithubPin,
  parseGithubData,
  type GithubRepo,
  type GithubRequest,
} from './githubRead.js'
import { isTaskWebError, publicWebUrl, readPublicWeb, type TaskWebError } from './publicWeb.js'
import { recordSchema } from './toolSchema.js'
import {
  excerptEvidence,
  readPosition,
  textExcerpt,
  textPosition,
  type TextPosition,
} from './readerRange.js'

export { readPosition, textExcerpt, textPosition } from './readerRange.js'

const MAX_LINKS = 120
const MAX_ATTEMPTS = 24
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const MAX_PINS = 80

const string = { type: 'string' }

const pageTool: ToolDefinition = {
  name: 'read_web_page',
  description:
    'Read an authorized public HTTPS link from the user or tool results. For long sources, search via find, read start_line/end_line, or pass the returned next_offset. Cite the retrieved source and its stated coverage.',
  parameters: recordSchema({ url: string, ...readPosition }, ['url']),
}

const githubTool: ToolDefinition = {
  name: 'browse_github_repository',
  description:
    'Inspect an already linked public GitHub repository. Read README, a directory, a file at a pinned commit, one Issue or PR by number, or the latest release. List issues or pulls with state and next_cursor. For long files use find, a line range or next_offset. Omit ref for the default branch; pass ref explicitly for branch names with slashes.',
  parameters: recordSchema(
    {
      repository_url: string,
      action: { type: 'string', enum: githubActions },
      path: string,
      ref: string,
      number: { type: 'integer', minimum: 1 },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      cursor: { type: 'string', maxLength: 5 },
      ...readPosition,
    },
    ['repository_url', 'action']
  ),
}

export const taskWebDefinitions = [pageTool, githubTool]

export const taskLinksIn = (text: string): string[] => {
  const candidates =
    text.match(
      /\b(?:https?:\/\/|(?:www\.)?github\.com\/|raw\.githubusercontent\.com\/)[^\s<>"'，。；、！？（）]+/gi
    ) ?? []
  return candidates.slice(0, 16).flatMap((value) => {
    const address = value.replace(/[),.;\]}\x60]+$/g, '')
    const url = publicWebUrl(/^https?:/i.test(address) ? address : 'https://' + address)
    return url ? [url.href] : []
  })
}

type PageRequest = {
  address: string
  github?: GithubRequest
}
type WebAction = {
  kind: 'web' | 'github'
  label: string
  read: (timeoutMs: number) => Promise<TaskReadResult>
}
type PageFault = { error: TaskReadReason; status?: number; retryAt?: number }

const htmlText = (html: string, url: URL) => {
  // Template contents are inert. Discard active and hidden content before collecting text.
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const title = fragment.querySelector('title')?.textContent?.trim().slice(0, 240) || url.hostname
  fragment
    .querySelectorAll(
      'script,style,noscript,iframe,object,embed,form,svg,canvas,nav,footer,header,aside,[hidden],[aria-hidden=true],template'
    )
    .forEach((node) => node.remove())
  const body =
    fragment.querySelector('article.markdown-body, article[itemprop=text]') ||
    fragment.querySelector('main, article, [role=main]') ||
    fragment
  const links = new Set<string>()
  for (const anchor of Array.from(body.querySelectorAll('a[href]'))) {
    const link = publicWebUrl(anchor.getAttribute('href'), url)
    if (link && link.href !== url.href) {
      links.add(link.href)
    }
    if (links.size >= 24) {
      break
    }
  }
  body
    .querySelectorAll('p,div,li,tr,pre,h1,h2,h3,h4,h5,h6,br,section,blockquote')
    .forEach((node) => node.after(document.createTextNode('\n')))
  const content = (body.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, content, links: [...links] }
}

const safeText = (text: string) =>
  text.replace(/\p{Cc}/gu, (char) => ('\t\r\n'.includes(char) ? char : ''))

const failureText: Record<TaskWebError | 'read-budget' | 'unverified-revision', string> = {
  blocked: 'This address is outside the public web scope for this task.',
  dns: 'The site name could not be resolved on this device.',
  redirect: 'The website redirected without an accessible destination.',
  timeout: 'The website took too long to respond.',
  unsupported:
    'The website returned an unsupported file type. Read a public text page or ask for an attachment.',
  network: 'This device could not connect to the website.',
  browser:
    'This site cannot be read directly from the browser edition. Use a public GitHub source or a file supplied by the user.',
  http: 'The website refused the request or the page could not be found.',
  'rate-limit':
    'The remote website is limiting requests. This is separate from the task read budget.',
  empty: 'The response did not contain readable text.',
  'read-budget':
    'The task reached the local website request budget. Keep the sources and continue from the checkpoint.',
  'unverified-revision':
    'The repository revision could not be resolved. Check the public repository and branch, or provide its full commit SHA.',
}

const fault = ({ error, status, retryAt }: PageFault): TaskReadResult => ({
  isError: true,
  reason: error,
  ...(isTaskWebError(error) && { failure: error }),
  ...(retryAt !== undefined && { retryAt }),
  text:
    (failureText[error as keyof typeof failureText] ?? 'The source could not be read.') +
    (status ? ' HTTP ' + status + '.' : '') +
    (retryAt !== undefined ? ' Retry after ' + new Date(retryAt).toISOString() + '.' : ''),
})

const pageKey = ({ address, github }: PageRequest) =>
  JSON.stringify([address, Boolean(github?.raw), github?.view ?? 'text'])

const fromGithub = (requests: GithubRequest[]): PageRequest[] =>
  requests.map((github) => ({ address: github.address, github }))

export const createTaskWeb = (
  initial: string[],
  signal: AbortSignal,
  previous?: TaskReadCheckpoint
) => {
  const links = new Set<string>()
  const repos = new Set<string>()
  const pins = new Map<string, string>()
  const sources = new Map<string, { page: TaskCachedSource; size: number }>()
  const inFlight = new Map<string, Promise<TaskCachedSource | PageFault>>()
  let fetched = 0
  let cachedBytes = 0
  let githubRetryAt: number | undefined

  const addLinks = (values: readonly string[]) => {
    for (const value of values) {
      if (links.size >= MAX_LINKS) {
        break
      }
      const url = publicWebUrl(value)
      if (!url) {
        continue
      }
      links.add(url.href)
      const repo = githubRepo(url)
      if (repo) {
        repos.add(repo.key)
      }
    }
  }

  const keep = (page: TaskCachedSource) => {
    const size = utf8Size(JSON.stringify(page))
    if (size > MAX_CACHE_BYTES) {
      return
    }
    cachedBytes -= sources.get(page.key)?.size ?? 0
    sources.delete(page.key)
    while (cachedBytes + size > MAX_CACHE_BYTES) {
      const oldest = sources.entries().next().value
      if (!oldest) {
        break
      }
      cachedBytes -= oldest[1].size
      sources.delete(oldest[0])
    }
    sources.set(page.key, { page, size })
    cachedBytes += size
  }

  addLinks(initial)
  const restored = previous?.version === 1 ? previous.web : undefined
  if (restored && Array.isArray(restored.sources)) {
    // Re-admit cached sources only through the current task's trusted URL/repository scope.
    // Process newest first for persistence, but restore reachable links from older pages first.
    for (const item of restored.sources.slice(0, 24).reverse()) {
      const url = publicWebUrl(item?.evidence?.url)
      if (
        !url ||
        !(links.has(url.href) || repos.has(githubRepo(url)?.key ?? '')) ||
        typeof item.key !== 'string' ||
        item.key.length > 2200 ||
        typeof item.text !== 'string' ||
        item.text.length > MAX_SOURCE_CHARS ||
        !Array.isArray(item.links) ||
        (item.evidence.kind !== 'web' && item.evidence.kind !== 'github')
      ) {
        continue
      }
      const knownLinks = item.links
        .slice(0, 24)
        .map((entry) => publicWebUrl(entry)?.href)
        .filter((entry): entry is string => Boolean(entry))
      const restoredPage = {
        ...item,
        evidence: { ...item.evidence, url: url.href },
        links: knownLinks,
      }
      keep(restoredPage)
      addLinks([url.href, ...knownLinks])
    }
  }
  if (restored && Array.isArray(restored.pins)) {
    for (const pin of restored.pins.slice(0, MAX_PINS)) {
      if (
        Array.isArray(pin) &&
        typeof pin[0] === 'string' &&
        pin[0].length <= 310 &&
        repos.has(pin[0].split(':', 1)[0]) &&
        commitSha(pin[1])
      ) {
        pins.set(pin[0], pin[1])
      }
    }
  }
  if (
    typeof restored?.retryAt === 'number' &&
    Number.isFinite(restored.retryAt) &&
    restored.retryAt > Date.now() &&
    restored.retryAt <= Date.now() + 7 * 24 * 60 * 60 * 1000
  ) {
    githubRetryAt = restored.retryAt
  }

  const fetchPage = async (
    request: PageRequest,
    key: string,
    remainingMs: number
  ): Promise<TaskCachedSource | PageFault> => {
    const url = publicWebUrl(request.address)
    if (!url) {
      return { error: 'blocked' }
    }
    if (url.hostname === 'api.github.com' && githubRetryAt && githubRetryAt > Date.now()) {
      return { error: 'rate-limit', retryAt: githubRetryAt }
    }
    if (fetched >= MAX_ATTEMPTS) {
      return { error: 'read-budget' }
    }
    fetched++
    const github = request.github
    const result = await readPublicWeb(url, Boolean(github?.raw), signal, remainingMs, {
      sameOrigin: Boolean(github),
    })
    if ('error' in result) {
      if (url.hostname === 'api.github.com' && result.error === 'rate-limit') {
        githubRetryAt = result.retryAt
      }
      return result
    }
    if (github && githubRepo(result.url)?.key !== github.repo) {
      return { error: 'blocked' }
    }
    const html = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(result.contentType)
    let data
    try {
      data = github?.view
        ? !result.truncated && !html
          ? parseGithubData(JSON.parse(result.text), github, result.link)
          : undefined
        : html
          ? github?.revision
            ? undefined
            : htmlText(result.text, result.url)
          : {
              title: github?.path || (github?.revision ? 'Repository README' : result.url.hostname),
              content: result.text,
              links: [],
            }
    } catch {
      return { error: result.truncated ? 'source-truncated' : 'empty' }
    }
    if (!data?.content.trim()) {
      return { error: result.truncated ? 'source-truncated' : 'empty' }
    }
    const decoded = safeText(data.content).replace(/\r\n?/g, '\n')
    const text = decoded.slice(0, MAX_SOURCE_CHARS)
    const source =
      ('source' in data && typeof data.source === 'string' ? data.source : undefined) ??
      github?.source ??
      result.url.href
    const nextCursor =
      'nextCursor' in data && typeof data.nextCursor === 'string' ? data.nextCursor : undefined
    const sourceTruncated =
      result.truncated ||
      text.length < decoded.length ||
      ('sourceTruncated' in data && data.sourceTruncated === true)
    const kind = github ? 'github' : 'web'
    const page: TaskCachedSource = {
      key,
      text,
      links: data.links,
      nextCursor,
      evidence: {
        sourceId: sourceIdFor(kind, github?.revision ? source : result.url.href),
        kind,
        title: safeText(data.title).trim().slice(0, 240),
        url: source,
        path: github?.path || undefined,
        revision: github?.revision,
        retrievedAt: Date.now(),
        downloadedBytes: result.bytes,
        availableChars: text.length,
        partial: sourceTruncated || Boolean(nextCursor),
        sourceTruncated,
        nextCursor,
      },
    }
    keep(page)
    return page
  }

  const download = (request: PageRequest, remainingMs: number) => {
    const key = pageKey(request)
    const cached = sources.get(key)
    if (cached) {
      sources.delete(key)
      sources.set(key, cached)
      return Promise.resolve(cached.page)
    }
    const running = inFlight.get(key)
    if (running) {
      return running
    }
    const pending = fetchPage(request, key, remainingMs).finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, pending)
    return pending
  }

  const getPage = async (
    requests: PageRequest[],
    deadline: number
  ): Promise<TaskCachedSource | PageFault> => {
    let faulted: PageFault | undefined
    for (const request of requests) {
      const remaining = Math.min(15_000, deadline - performance.now())
      if (remaining <= 0) {
        return faulted ?? { error: 'timeout' }
      }
      const page = await download(request, remaining)
      if (!('error' in page)) {
        return page
      }
      if (
        page.error === 'rate-limit' ||
        page.error === 'read-budget' ||
        page.error === 'source-truncated'
      ) {
        return page
      }
      if (!faulted || faulted.error === 'browser') {
        faulted = page
      }
    }
    return faulted ?? { error: 'empty' }
  }

  const resolvePin = async (repo: GithubRepo, ref: string | undefined, deadline: number) => {
    if (commitSha(ref)) {
      return { revision: ref.toLowerCase() }
    }
    const key = githubPinKey(repo, ref)
    const known = pins.get(key)
    if (known) {
      return { revision: known }
    }
    const page = await getPage(fromGithub(githubPinRequests(repo, ref)), deadline)
    if ('error' in page) {
      return {
        failure:
          page.error === 'empty' || page.status === 404
            ? { ...page, error: 'unverified-revision' as const }
            : page,
      }
    }
    const revision = page.text
    if (!commitSha(revision)) {
      return { failure: { error: 'unverified-revision' as const } }
    }
    if (pins.size >= MAX_PINS) {
      const oldest = pins.keys().next().value
      if (oldest) {
        pins.delete(oldest)
      }
    }
    pins.set(key, revision)
    return { revision }
  }

  const read = async (
    url: URL,
    repo: GithubRepo | undefined,
    query: ReturnType<typeof githubQuery>,
    position: TextPosition,
    timeoutMs: number
  ): Promise<TaskReadResult> => {
    const deadline = performance.now() + timeoutMs
    let revision: string | undefined
    if (repo && query && needsGithubPin(query)) {
      const resolved = await resolvePin(repo, query.ref, deadline)
      if (resolved.failure) {
        return fault(resolved.failure)
      }
      revision = resolved.revision
    }
    const requests =
      repo && query ? fromGithub(githubRequests(repo, query, revision)) : [{ address: url.href }]
    const page = await getPage(requests, deadline)
    if ('error' in page) {
      return fault(page)
    }
    const source = page.evidence.url
    addLinks([...(source ? [source] : []), ...page.links])
    const excerpt = textExcerpt(page.text, position)
    const evidence = excerptEvidence(page.evidence, excerpt, position, page.text.length)
    if ('content' in excerpt && !excerpt.content.length) {
      return {
        isError: true,
        reason: 'empty-range',
        source,
        evidence,
        text: JSON.stringify({
          error: 'There is no text at that offset or line range in the available source.',
          evidence,
        }),
      }
    }
    return {
      source,
      evidence,
      sourceUrls: source ? [source] : undefined,
      text: JSON.stringify({
        external_reference: true,
        url: source,
        requested_url: source === url.href ? undefined : url.href,
        title: evidence.title,
        revision,
        path: evidence.path,
        source_download_truncated: evidence.sourceTruncated,
        next_cursor: page.nextCursor,
        ...excerpt,
        evidence,
        links: page.links.slice(0, 16),
      }),
    }
  }

  return {
    prepare(name: string, input: Record<string, unknown>): WebAction | TaskReadResult | undefined {
      if (name !== pageTool.name && name !== githubTool.name) {
        return undefined
      }
      const position = textPosition(input)
      if (!position) {
        return {
          isError: true,
          reason: 'invalid-arguments',
          text: 'Use a valid offset, line range or short search phrase.',
        }
      }
      const direct = name === pageTool.name
      const url = publicWebUrl(direct ? input.url : input.repository_url)
      if (!url) {
        return fault({ error: 'blocked' })
      }
      const repo = githubRepo(url)
      if ((direct && !links.has(url.href)) || (!direct && (!repo || !repos.has(repo.key)))) {
        return fault({ error: 'blocked' })
      }
      const query = direct ? repo && githubLinkQuery(repo, url) : githubQuery(input)
      if (!direct && !query) {
        return {
          isError: true,
          reason: 'invalid-arguments',
          text: 'Provide a supported GitHub action and a valid path, ref, issue number or cursor.',
        }
      }
      return {
        kind: repo ? 'github' : 'web',
        label: repo?.namespace ?? url.hostname,
        read: (timeoutMs) => read(url, repo, query, position, timeoutMs),
      }
    },
    addLinks,
    hasLink: (url: URL) => links.has(url.href),
    checkpoint: (): TaskReadCheckpoint => {
      const revisions = [...pins].slice(-MAX_PINS)
      const budget = MAX_WEB_CHECKPOINT_BYTES - utf8Size(JSON.stringify(revisions)) - 256
      return {
        version: 1,
        web: {
          pins: revisions,
          sources: fitCheckpointEntries(
            [...sources.values()].reverse().map(({ page }) => page),
            budget,
            24
          ),
          ...(githubRetryAt && githubRetryAt > Date.now() && { retryAt: githubRetryAt }),
        },
      }
    },
  }
}
