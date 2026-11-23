import { Capacitor } from '@capacitor/core'
import { beginDiagnosticOperation } from '../diagnostics/log.js'
import { publicWebUrl, readPublicWeb, type TaskWebError, type WebText } from './publicWeb.js'

export type NativeBrowserSnapshot = {
  url: string
  title: string
  text: string
  headings: string[]
  links: { label: string; url: string }[]
  truncated: boolean
}

type StaticDocument = Extract<WebText, { url: URL }>
type UnavailableReason = 'no-scripts' | 'no-dynamic-content' | 'engine-unavailable'
type BrowserFailure = {
  error: TaskWebError
  status?: number
  reason?: UnavailableReason
  fallback?: StaticDocument
}
export type NativeBrowserResult =
  | { snapshot: NativeBrowserSnapshot; status?: number }
  | BrowserFailure

export type ResourceReply = { status?: number; text?: string; url?: string; truncated?: boolean }
export type BrowserWorkerInput =
  | { type: 'start'; url: string; html: string; truncated: boolean; timeoutMs: number }
  | { type: 'resource-result'; id: number; result: ResourceReply }
export type BrowserWorkerOutput =
  | { type: 'resource'; id: number; url: string; purpose: 'script' | 'data' }
  | { type: 'snapshot'; data: NativeBrowserSnapshot }
  | { type: 'unavailable'; reason: UnavailableReason }

const MAX_TIMEOUT = 15_000
const MAX_REQUESTS = 24
const MAX_RESOURCE_BYTES = 640_000
const MAX_TOTAL_RESOURCE_BYTES = 1_800_000
const htmlType = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i
const scriptType =
  /^(?:text\/(?:plain|javascript|ecmascript)|application\/(?:javascript|ecmascript))(?:;|$)/i
let activeWorkers = 0

// Keep navigation scope independent of the guest implementation.
const publicResource = (value: string, source: URL) => {
  try {
    const candidate = new URL(value, source)
    const url = publicWebUrl(candidate.href)
    return url && candidate.protocol === 'https:' && url.origin === source.origin ? url : undefined
  } catch {
    return undefined
  }
}

const sanitizeSnapshot = (
  snapshot: NativeBrowserSnapshot,
  source: URL
): NativeBrowserSnapshot | undefined => {
  if (
    !snapshot ||
    snapshot.url !== source.href ||
    typeof snapshot.title !== 'string' ||
    typeof snapshot.text !== 'string' ||
    !Array.isArray(snapshot.links) ||
    !Array.isArray(snapshot.headings)
  ) {
    return undefined
  }
  const links: NativeBrowserSnapshot['links'] = []
  const seen = new Set<string>()
  for (const item of snapshot.links.slice(0, 80)) {
    if (!item || typeof item.url !== 'string' || typeof item.label !== 'string') {
      continue
    }
    const url = publicWebUrl(item.url, source)
    const label = item.label.trim().slice(0, 160)
    if (url && label && url.href !== source.href && !seen.has(url.href)) {
      links.push({ label, url: url.href })
      seen.add(url.href)
    }
  }
  const text = snapshot.text.slice(0, 150_000).trim()
  if (!text && !links.length) {
    return undefined
  }
  return {
    url: source.href,
    title: snapshot.title.trim().slice(0, 240) || source.hostname,
    text,
    headings: snapshot.headings
      .slice(0, 28)
      .filter((heading) => typeof heading === 'string')
      .map((heading) => heading.trim().slice(0, 180))
      .filter(Boolean),
    links,
    truncated: Boolean(snapshot.truncated || snapshot.text.length > 150_000),
  }
}

const renderDocument = async (
  source: StaticDocument,
  signal: AbortSignal,
  expires: number,
  counts: { resources: number; bytes: number }
): Promise<NativeBrowserResult> => {
  const remaining = () => Math.max(0, expires - Date.now())
  if (!remaining()) {
    return { error: 'timeout' }
  }
  // The worker interprets site scripts in a bounded, isolated Wasm runtime.
  // Its only remote I/O is this credential-free native HTTP reader.
  let worker: Worker
  try {
    worker = new Worker(new URL('./nativeBrowser.worker.ts', import.meta.url))
  } catch {
    return { error: 'browser', reason: 'engine-unavailable', fallback: source }
  }
  const requests = new Set<number>()
  const controller = new AbortController()
  let stop = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  let closed = false
  try {
    return await new Promise<NativeBrowserResult>((resolve, reject) => {
      const send = (message: BrowserWorkerInput) => {
        if (!closed) {
          worker.postMessage(message)
        }
      }
      const finish = (result: NativeBrowserResult) => {
        closed = true
        resolve(result)
      }
      stop = () => {
        closed = true
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', stop, { once: true })
      timeout = setTimeout(() => finish({ error: 'timeout', fallback: source }), remaining())
      worker.onerror = () =>
        finish({ error: 'browser', reason: 'engine-unavailable', fallback: source })
      worker.onmessage = (event: MessageEvent<BrowserWorkerOutput>) => {
        const result = event.data
        if (closed || !result) {
          return
        }
        if (result.type === 'snapshot') {
          const snapshot = sanitizeSnapshot(result.data, source.url)
          finish(
            snapshot
              ? { snapshot }
              : { error: 'browser', reason: 'no-dynamic-content', fallback: source }
          )
        } else if (result.type === 'unavailable') {
          finish({ error: 'browser', reason: result.reason, fallback: source })
        } else if (
          result.type === 'resource' &&
          Number.isInteger(result.id) &&
          !requests.has(result.id)
        ) {
          const id = result.id
          const complete = (reply: ResourceReply) =>
            send({ type: 'resource-result', id, result: reply })
          const resource = typeof result.url === 'string' && publicResource(result.url, source.url)
          if (
            !resource ||
            requests.size >= MAX_REQUESTS ||
            counts.bytes >= MAX_TOTAL_RESOURCE_BYTES ||
            !remaining() ||
            (result.purpose !== 'script' && result.purpose !== 'data')
          ) {
            complete({})
            return
          }
          requests.add(id)
          counts.resources += 1
          void readPublicWeb(resource, false, controller.signal, remaining(), { sameOrigin: true })
            .then((response) => {
              if ('error' in response) {
                complete({ status: response.error === 'http' ? response.status : undefined })
                return
              }
              counts.bytes += response.bytes
              if (
                response.url.origin !== source.url.origin ||
                counts.bytes > MAX_TOTAL_RESOURCE_BYTES ||
                response.bytes > MAX_RESOURCE_BYTES ||
                (result.purpose === 'script' && !scriptType.test(response.contentType))
              ) {
                complete({})
                return
              }
              complete({
                status: 200,
                url: response.url.href,
                text: response.text,
                truncated: response.truncated,
              })
            })
            .catch(() => complete({}))
        }
      }
      signal.throwIfAborted()
      send({
        type: 'start',
        url: source.url.href,
        html: source.text,
        truncated: source.truncated,
        timeoutMs: remaining(),
      })
    })
  } finally {
    closed = true
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    controller.abort()
    worker.terminate()
  }
}

export const readNativeBrowser = async (
  target: URL,
  signal: AbortSignal,
  timeoutMs: number
): Promise<NativeBrowserResult> => {
  signal.throwIfAborted()
  const url = publicWebUrl(target.href)
  if (!url) {
    return { error: 'blocked' }
  }
  if (
    typeof Worker !== 'function' ||
    typeof WebAssembly !== 'object' ||
    (Capacitor.getPlatform() !== 'android' && !window.freeseekPublicWeb) ||
    activeWorkers >= 2
  ) {
    return { error: 'browser', reason: 'engine-unavailable' }
  }
  const started = Date.now()
  const deadline =
    started +
    Math.min(MAX_TIMEOUT, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMEOUT))
  const diagnostics = beginDiagnosticOperation('chat', 'task.browser.document', {
    timeoutMs: deadline - started,
  })
  const counts = { resources: 0, bytes: 0 }
  activeWorkers += 1
  try {
    const source = await readPublicWeb(url, false, signal, deadline - Date.now())
    if ('error' in source) {
      diagnostics('failed', { reason: source.error, httpStatus: source.status })
      return source
    }
    if (!htmlType.test(source.contentType) || !/<script\b/i.test(source.text)) {
      diagnostics('completed', { reason: 'no-scripts' })
      return { error: 'browser', reason: 'no-scripts', fallback: source }
    }
    const result = await renderDocument(source, signal, deadline, counts)
    diagnostics('snapshot' in result || result.reason === 'no-scripts' ? 'completed' : 'failed', {
      reason: 'error' in result ? (result.reason ?? result.error) : undefined,
      receivedBytes: counts.bytes,
      resourceCount: counts.resources,
      truncated: 'snapshot' in result && result.snapshot.truncated,
    })
    return result
  } catch {
    diagnostics(signal.aborted ? 'cancelled' : 'failed', {
      reason: signal.aborted ? 'cancelled' : 'engine-unavailable',
      resourceCount: counts.resources,
    })
    signal.throwIfAborted()
    return { error: 'browser', reason: 'engine-unavailable' }
  } finally {
    activeWorkers -= 1
  }
}
