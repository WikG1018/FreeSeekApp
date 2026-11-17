import { createId } from '../../utils/id.js'
import { openDB, type DBSchema } from 'idb'

export type LogScope =
  | 'app'
  | 'api'
  | 'upload'
  | 'chat'
  | 'storage'
  | 'backup'
  | 'update'
  | 'speech'
  | 'ui'
  | 'diagnostics'
export type LogLevel = 'info' | 'warn' | 'error'
export type DiagnosticEvent = {
  id: string
  timestamp: number
  runId: string
  source: 'client' | 'native'
  scope: string
  event: string
  level: LogLevel
  details: Record<string, unknown>
}
interface LogDB extends DBSchema {
  events: { key: string; value: DiagnosticEvent; indexes: { timestamp: number } }
}
export const LOG_LIMIT = 2000
export const LOG_RETENTION_MS = 7 * 24 * 3600_000
const runId = createId()
const secrets = new Set<string>()
const recent: DiagnosticEvent[] = []
const pending: DiagnosticEvent[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let writing = Promise.resolve()
let dbPromise: ReturnType<typeof openDB<LogDB>> | undefined
let unavailableWrites = 0
const db = () =>
  (dbPromise ??= openDB<LogDB>('freeseek-diagnostics', 1, {
    upgrade(database) {
      database.createObjectStore('events', { keyPath: 'id' }).createIndex('timestamp', 'timestamp')
    },
  }).catch((error) => {
    dbPromise = undefined
    throw error
  }))

/** 只用于内存内脱敏，从不持久化或导出此集合。 */
export const registerLogSecret = (value: string | null | undefined) => {
  if (value && value.length >= 6) {
    secrets.add(value)
    if (secrets.size > 20) {
      secrets.delete(secrets.values().next().value ?? '')
    }
  }
}
const redactString = (value: string): string => {
  let result = value
  for (const secret of secrets) {
    result = result.replaceAll(secret, '[REDACTED]')
  }
  return result
    .replace(/Bearer\s+[^\s,;)]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\/data\/user\/|\/storage\/)[^\s)]+/g, '[PATH]')
    .slice(0, 800)
}
const privateKeys = new Set([
  'apikey',
  'authorization',
  'password',
  'secret',
  'cookie',
  'headers',
  'body',
  'content',
  'messages',
  'message',
  'prompt',
  'text',
  'filename',
  'transcript',
  'audio',
  'base64',
  'blob',
])
export const sanitizeDetails = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return '[DEPTH_LIMIT]'
  }
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeDetails(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [
          key,
          privateKeys.has(key.toLowerCase().replace(/[^a-z]/g, ''))
            ? '[REDACTED]'
            : sanitizeDetails(item, depth + 1),
        ])
    )
  }
  return undefined
}

/** 错误仅记录类型、协议状态、已知原因和栈帧，不记录可能回显正文的原始 error.message。 */
export const diagnosticError = (error: unknown): Record<string, unknown> => {
  const item = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const message = typeof item.message === 'string' ? item.message : ''
  const reasons: [string, RegExp][] = [
    ['invalid-image', /unsupported|invalid.*image|image.*large/i],
    ['quota', /quota|count limit|storage.*limit/i],
    ['invalid-file-id', /file_id|file data not found/i],
    ['context-limit', /context.{0,30}(?:length|limit|exceed)|maximum.*token/i],
    ['timeout', /timeout|timed out/i],
    ['json-format', /json/i],
    ['no-space', /ENOSPC|QuotaExceeded/i],
  ]
  const local =
    item.localMessage && typeof item.localMessage === 'object'
      ? (item.localMessage as Record<string, unknown>)
      : {}
  return {
    name: typeof item.name === 'string' && /^[\w.]{1,100}$/.test(item.name) ? item.name : 'Error',
    ...(typeof item.status === 'number' ? { status: item.status } : {}),
    ...(typeof item.kind === 'string' && /^[\w-]{1,30}$/.test(item.kind)
      ? { kind: item.kind }
      : {}),
    ...(typeof local.key === 'string' ? { localKey: local.key } : {}),
    reason: reasons.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unclassified',
    field: /\bmessages\.\d+(?:\.[\w]+|\.\d+)*/.exec(message)?.[0],
    frames:
      typeof item.stack === 'string'
        ? item.stack
            .split('\n')
            .slice(1, 7)
            .map((line) =>
              line.replace(/https?:\/\/[^\s)]+/g, (value) => {
                try {
                  const url = new URL(value)
                  return url.origin + '/' + url.pathname.split('/').at(-1)
                } catch {
                  return '[URL]'
                }
              })
            )
        : [],
  }
}

export const logEvent = (
  scope: LogScope,
  event: string,
  details: Record<string, unknown> = {},
  level: LogLevel = 'info'
) => {
  const safe = sanitizeDetails(details) as Record<string, unknown>
  const entry: DiagnosticEvent = {
    id: createId(),
    timestamp: Date.now(),
    runId,
    source: 'client',
    scope,
    event,
    level,
    details: JSON.stringify(safe).length <= 3000 ? safe : { truncated: true },
  }
  recent.push(entry)
  if (recent.length > LOG_LIMIT) {
    recent.shift()
  }
  pending.push(entry)
  if (pending.length > LOG_LIMIT) {
    pending.shift()
  }
  if (timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined
      void flushDiagnosticLogs()
    }, 500)
  }
}

export const flushDiagnosticLogs = (): Promise<void> => {
  clearTimeout(timer)
  timer = undefined
  if (!pending.length) {
    return writing
  }
  const batch = pending.splice(0)
  writing = writing.then(async () => {
    try {
      const database = await db(),
        tx = database.transaction('events', 'readwrite')
      void tx.done.catch(() => {})
      await Promise.all(batch.map((entry) => tx.store.put(entry)))
      const cutoff = Date.now() - LOG_RETENTION_MS
      for (
        let cursor = await tx.store.index('timestamp').openCursor(IDBKeyRange.upperBound(cutoff));
        cursor;
        cursor = await cursor.continue()
      ) {
        await cursor.delete()
      }
      let excess = Math.max(0, (await tx.store.count()) - LOG_LIMIT)
      for (
        let cursor = await tx.store.index('timestamp').openCursor();
        cursor && excess > 0;
        cursor = await cursor.continue(), excess--
      ) {
        await cursor.delete()
      }
      await tx.done
    } catch {
      unavailableWrites += batch.length
    }
  })
  return writing
}

export const readDiagnosticLogs = async (): Promise<{
  events: DiagnosticEvent[]
  unavailableWrites: number
}> => {
  let stored: DiagnosticEvent[] = []
  try {
    await Promise.race([
      flushDiagnosticLogs(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), 2000)),
    ])
    stored = await Promise.race([
      db().then((database) => database.getAll('events')),
      new Promise<DiagnosticEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Log timeout')), 2000)
      ),
    ])
  } catch {
    /* 日志存储不可用时仍能导出内存记录。 */
  }
  const unique = new Map([...stored, ...recent].map((entry) => [entry.id, entry]))
  return {
    events: [...unique.values()]
      .filter((entry) => entry.timestamp > Date.now() - LOG_RETENTION_MS)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-LOG_LIMIT),
    unavailableWrites,
  }
}

export const initDiagnostics = () => {
  logEvent('app', 'started', {
    online: navigator.onLine,
    language: navigator.language,
    secureContext: window.isSecureContext,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    version: document.querySelector('meta[name="application-version"]')?.getAttribute('content'),
  })
  window.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLElement && event.target !== document.documentElement) {
        const resource = event.target
        logEvent(
          'ui',
          'resource.failed',
          {
            tag: resource.tagName,
            localResource:
              resource instanceof HTMLScriptElement || resource instanceof HTMLLinkElement,
          },
          'warn'
        )
        return
      }
      logEvent('ui', 'uncaught-error', diagnosticError(event.error), 'error')
    },
    true
  )
  window.addEventListener('unhandledrejection', (event) =>
    logEvent('app', 'unhandled-rejection', diagnosticError(event.reason), 'error')
  )
  window.addEventListener('online', () => logEvent('app', 'online'))
  window.addEventListener('offline', () => logEvent('app', 'offline', {}, 'warn'))
  document.addEventListener('visibilitychange', () => {
    logEvent('app', 'visibility', { state: document.visibilityState })
    if (document.visibilityState === 'hidden') {
      void flushDiagnosticLogs()
    }
  })
  window.addEventListener('pagehide', () => {
    void flushDiagnosticLogs()
  })
}
