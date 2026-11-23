import { Capacitor, registerPlugin } from '@capacitor/core'
import { createId } from '../../utils/id.js'
import { beginDiagnosticOperation } from '../diagnostics/log.js'

const MAX_BYTES = 1024 * 1024
const MAX_TIMEOUT = 15_000
const fixedBrowserHosts = new Set(['api.github.com', 'raw.githubusercontent.com'])
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i
const localDomain = /\.(?:localhost|local|lan|internal|home\.arpa|onion)$/i
const credential =
  /^(?:access[-_]?token|auth(?:orization)?|api[-_]?key|key|token|session(?:id)?|signature|sig|password|x-amz-.+|x-goog-.+)$/i
const textMime =
  /^(?:text\/[^;]+|application\/(?:[\w.-]+\+)?(?:json|xml|xhtml\+xml|x-yaml|yaml|javascript))(?:;|$)/i
const webErrors = [
  'blocked',
  'dns',
  'redirect',
  'timeout',
  'unsupported',
  'network',
  'browser',
  'http',
  'rate-limit',
  'empty',
] as const
export type TaskWebError = (typeof webErrors)[number]
export const isTaskWebError = (value: unknown): value is TaskWebError =>
  webErrors.some((error) => error === value)

export const publicWebUrl = (value: unknown, base?: URL): URL | undefined => {
  if (typeof value !== 'string' || value.length > 2048) {
    return undefined
  }
  try {
    const url = new URL(value, base)
    if (url.protocol === 'http:' && !url.port) {
      url.protocol = 'https:'
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname.length > 253 ||
      !hostname.test(url.hostname) ||
      localDomain.test(url.hostname) ||
      Array.from(url.searchParams.keys()).some((key) => credential.test(key))
    ) {
      return undefined
    }
    url.hash = ''
    return url.href.length <= 2048 ? url : undefined
  } catch {
    return undefined
  }
}

type ReaderHeaders = {
  link?: string
  retryAfter?: string
  rateRemaining?: string
  rateReset?: string
}
type WebResult = {
  url?: string
  status?: number
  contentType?: string
  bytes?: string | Uint8Array
  error?: string
  truncated?: boolean
  redirects?: number
  headers?: ReaderHeaders
}
type Reader = {
  read: (options: {
    id: string
    url: string
    raw: boolean
    timeoutMs: number
    sameOrigin?: boolean
  }) => Promise<WebResult>
  cancel: (options: { id: string }) => Promise<void>
}

declare global {
  interface Window {
    freeseekPublicWeb?: Reader
  }
}
const Android = registerPlugin<Reader>('PublicWeb')

const browserRead = async (url: URL, raw: boolean, signal: AbortSignal): Promise<WebResult> => {
  if (!fixedBrowserHosts.has(url.hostname)) {
    return { error: 'browser' }
  }
  const response = await fetch(url.href, {
    signal,
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/json, text/plain' },
  })
  const contentType = response.headers.get('content-type') ?? ''
  const result = {
    status: response.status,
    contentType,
    url: url.href,
    headers: {
      link: response.headers.get('link')?.slice(0, 4096),
      retryAfter: response.headers.get('retry-after')?.slice(0, 96),
      rateRemaining: response.headers.get('x-ratelimit-remaining')?.slice(0, 16),
      rateReset: response.headers.get('x-ratelimit-reset')?.slice(0, 16),
    },
  }
  if (!response.ok) {
    return result
  }
  if (!response.body || !textMime.test(contentType)) {
    return { ...result, error: 'unsupported' }
  }
  const arrays: Uint8Array[] = []
  let size = 0
  let truncated = false
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const accepted = value.subarray(0, MAX_BYTES - size)
      arrays.push(accepted)
      size += accepted.length
      if (accepted.length < value.length) {
        truncated = true
        break
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of arrays) {
    bytes.set(part, offset)
    offset += part.length
  }
  return { ...result, bytes, truncated }
}

const decodeText = (bytes: Uint8Array, type: string) => {
  const declared = /\bcharset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1]
  const inferred = type.startsWith('text/html')
    ? /\bcharset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder().decode(bytes.subarray(0, 8192)))?.[1]
    : undefined
  try {
    return new TextDecoder(declared ?? inferred ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

export type WebText =
  | {
      url: URL
      contentType: string
      text: string
      bytes: number
      truncated: boolean
      link?: string
    }
  | { error: TaskWebError; status?: number; retryAt?: number }

const rateRetryAt = (headers: ReaderHeaders | undefined) => {
  const now = Date.now()
  const retry = headers?.retryAfter
  const after =
    typeof retry === 'string' && /^\d{1,9}$/.test(retry)
      ? now + Number(retry) * 1000
      : typeof retry === 'string' && retry.length <= 96
        ? Date.parse(retry)
        : NaN
  const resetHeader = headers?.rateReset
  const reset =
    headers?.rateRemaining === '0' && resetHeader && /^\d{1,12}$/.test(resetHeader)
      ? Number(resetHeader) * 1000
      : now
  const until = Math.max(after > now ? after : now, reset > now ? reset : now)
  return until > now ? Math.min(until, now + 7 * 24 * 60 * 60 * 1000) : now + 60_000
}

export const readPublicWeb = async (
  url: URL,
  raw: boolean,
  signal: AbortSignal,
  remainingMs: number,
  options: { sameOrigin?: boolean } = {}
): Promise<WebText> => {
  signal.throwIfAborted()
  const native = Capacitor.getPlatform() === 'android'
  const bridge = native ? Android : window.freeseekPublicWeb
  const id = createId()
  const timeoutMs = Math.max(1, Math.floor(Math.min(MAX_TIMEOUT, remainingMs)))
  const finish = beginDiagnosticOperation('chat', 'task.web-read', {
    requestId: id,
    source: native ? 'android' : bridge ? 'windows' : 'web',
    timeoutMs,
  })
  const controller = new AbortController()
  const stop = () => controller.abort()
  let cancel = () => {}
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      void bridge?.cancel({ id }).catch(() => {})
      reject(new Error('Web read interrupted'))
    }
    controller.signal.addEventListener('abort', cancel, { once: true })
  })
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, timeoutMs)
  try {
    const result = await Promise.race([
      bridge
        ? bridge.read({
            id,
            url: url.href,
            raw,
            timeoutMs,
            ...(options.sameOrigin && { sameOrigin: true }),
          })
        : browserRead(url, raw, controller.signal),
      stopped,
    ])
    signal.throwIfAborted()
    const status = result.status
    const mime = result.contentType ?? ''
    const finalUrl = publicWebUrl(result.url)
    if (options.sameOrigin && finalUrl && finalUrl.origin !== url.origin) {
      finish('failed', { httpStatus: status, reason: 'blocked' })
      return { error: 'blocked', status }
    }
    const limited =
      status === 429 ||
      (status === 403 &&
        url.hostname === 'api.github.com' &&
        (result.headers?.rateRemaining === '0' || Boolean(result.headers?.retryAfter)))
    const reason = isTaskWebError(result.error)
      ? result.error
      : limited
        ? 'rate-limit'
        : status && (status < 200 || status >= 300)
          ? 'http'
          : !finalUrl || !textMime.test(mime)
            ? 'unsupported'
            : !result.bytes
              ? 'empty'
              : undefined
    if (reason || !finalUrl || !result.bytes) {
      finish('failed', { httpStatus: status, reason: reason ?? 'empty' })
      return {
        error: reason ?? 'empty',
        status,
        ...(reason === 'rate-limit' && { retryAt: rateRetryAt(result.headers) }),
      }
    }
    const bytes =
      typeof result.bytes === 'string'
        ? Uint8Array.from(atob(result.bytes), (char) => char.charCodeAt(0))
        : result.bytes
    const text = decodeText(bytes, mime)
    finish('completed', {
      httpStatus: status,
      receivedBytes: bytes.length,
      truncated: Boolean(result.truncated),
      redirectCount: result.redirects ?? 0,
    })
    return {
      url: finalUrl,
      contentType: mime,
      text,
      bytes: bytes.length,
      truncated: Boolean(result.truncated),
      link:
        finalUrl.hostname === 'api.github.com' && typeof result.headers?.link === 'string'
          ? result.headers.link.slice(0, 4096)
          : undefined,
    }
  } catch {
    const reason = controller.signal.aborted ? 'timeout' : 'network'
    finish(signal.aborted ? 'cancelled' : 'failed', {
      reason: signal.aborted ? 'cancelled' : reason,
    })
    signal.throwIfAborted()
    return { error: reason }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    controller.signal.removeEventListener('abort', cancel)
  }
}
