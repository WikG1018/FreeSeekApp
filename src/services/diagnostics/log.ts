import { createId } from '../../utils/id.js'
import { openDB, type DBSchema } from 'idb'
import { apiLimitCounts, describeKnownApiError } from '../api/knownErrors.js'
import { zh } from '../../i18n/zh.js'
import { flushRetainedClientEvents, retainClientEvent } from './retained.js'

export type LogScope =
  | 'app'
  | 'api'
  | 'upload'
  | 'chat'
  | 'storage'
  | 'backup'
  | 'update'
  | 'speech'
  | 'search'
  | 'settings'
  | 'persona'
  | 'usage'
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
  events: { key: string; value: DiagnosticEvent; indexes: { timestamp: number; level: LogLevel } }
}
export const LOG_LIMIT = 2000
export const LOG_RETENTION_MS = 7 * 24 * 3600_000
export const LOG_ISSUE_RESERVE = 300
const runId = createId()
const encoder = new TextEncoder()
const DETAIL_BYTE_LIMIT = 3000
const secrets = new Set<string>()
const recent: DiagnosticEvent[] = []
const pending: DiagnosticEvent[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let writing = Promise.resolve()
let dbPromise: ReturnType<typeof openDB<LogDB>> | undefined
let unavailableWrites = 0
let databaseCreatedThisRun = false
const db = () =>
  (dbPromise ??= openDB<LogDB>('freeseek-diagnostics', 2, {
    upgrade(database, previous, _version, transaction) {
      const store =
        previous === 0
          ? database.createObjectStore('events', { keyPath: 'id' })
          : transaction.objectStore('events')
      if (previous === 0) {
        store.createIndex('timestamp', 'timestamp')
        databaseCreatedThisRun = true
      }
      store.createIndex('level', 'level')
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
    .replace(/\bhttps?:\/\/[^\s<>"')]+/gi, '[URL]')
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
  'systemprompt',
  'query',
  'searchterms',
  'snippet',
  'text',
  'filename',
  'filepath',
  'title',
  'sessiontitle',
  'conversationtitle',
  'requesturl',
  'baseurl',
  'url',
  'endpoint',
  'payload',
  'errormessage',
  'transcript',
  'serial',
  'imei',
  'androidid',
  'deviceid',
  'fingerprint',
  'ipaddress',
  'macaddress',
  'ssid',
  'bssid',
  'audio',
  'base64',
  'blob',
])
const errorNames = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'ReferenceError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'QuotaExceededError',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'InvalidStateError',
  'NotSupportedError',
  'SecurityError',
  'DataError',
  'ConstraintError',
  'UnknownError',
  'VersionError',
  'TransactionInactiveError',
  'EncodingError',
  'ApiError',
  'ProviderConfigError',
  'UnsupportedImageError',
  'BackupError',
  'ArchiveError',
  'ArchiveLimitError',
  'StreamIdleTimeoutError',
  'StreamReadError',
])
const errorKinds = new Set(['http', 'stream', 'network', 'interrupted', 'protocol'])
const messageField =
  /\bmessages\.\d{1,7}(?:\.(?:content|role|type|source|file_id|\d{1,7})){0,7}(?![\w.])/
const opaqueId = /^(?:file-api-|custom-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export const diagnosticId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const fallback = /^([0-9a-z]{8,10})-[0-9a-z]{1,20}$/.exec(value)
  const timestamp = fallback ? Number.parseInt(fallback[1], 36) : 0
  return opaqueId.test(value) || (timestamp >= 1577836800000 && timestamp < 4102444800000)
    ? redactString(value)
    : undefined
}

const safeFrames = (frames: unknown[]) =>
  frames.slice(0, 12).flatMap((value) => {
    if (typeof value !== 'string' || value.length > 1024) {
      return []
    }
    const frame = value.trim()
    const script = /(?:^|\/)([\w-]{1,64}\.[a-f0-9]{8}\.js:\d{1,7}:\d{1,7})\)?$/.exec(frame)
    if (script) {
      return [script[1]]
    }
    return /^(?:app\.freeseek\.chat\.|com\.getcapacitor\.|androidx?\.|javax?\.|dalvik\.)[\w.$]{1,180}\([\w.$-]{1,80}\.java:\d{1,7}\)$/.test(
      frame
    )
      ? [frame]
      : []
  })

const sanitizeField = (key: string, item: unknown, depth: number): unknown => {
  if (privateKeys.has(key.toLowerCase().replace(/[^a-z]/g, ''))) {
    return '[REDACTED]'
  }
  if (key === 'frames') {
    return Array.isArray(item) ? safeFrames(item) : []
  }
  if (key === 'name' && typeof item === 'string') {
    return errorNames.has(item) ? item : 'Error'
  }
  if (key === 'kind' && typeof item === 'string') {
    return errorKinds.has(item) ? item : undefined
  }
  if (key === 'localKey') {
    return typeof item === 'string' && Object.hasOwn(zh, item) ? item : undefined
  }
  if (key === 'field') {
    return typeof item === 'string' && item.length <= 200 ? messageField.exec(item)?.[0] : undefined
  }
  if (
    /^(?:previous)?(?:session|request|reply|file|message|operation|upstreamRequest|run|provider)Id$/i.test(
      key
    )
  ) {
    return diagnosticId(item)
  }
  return sanitizeDetails(item, depth + 1)
}

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
        .slice(0, 64)
        .filter(([key]) => /^[A-Za-z][\w-]{0,63}$/.test(key))
        .map(([key, item]) => [key, sanitizeField(key, item, depth)])
    )
  }
  return undefined
}

export const boundedLogDetails = (value: unknown): Record<string, unknown> => {
  const safe = sanitizeDetails(value)
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return {}
  }
  const byteLength = encoder.encode(JSON.stringify(safe)).length
  return byteLength <= DETAIL_BYTE_LIMIT ? (safe as Record<string, unknown>) : { truncated: true }
}

/** 错误仅记录类型、协议状态、已知原因和栈帧，不记录可能回显正文的原始 error.message。 */
export const diagnosticError = (error: unknown): Record<string, unknown> => {
  const item = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const message = typeof item.message === 'string' ? item.message : ''
  const name = typeof item.name === 'string' && errorNames.has(item.name) ? item.name : 'Error'
  const reasons: [string, RegExp][] = [
    ['no-space', /ENOSPC|QuotaExceeded|no space|disk.*full/i],
    ['permission', /EACCES|permission denied|not allowed/i],
    ['invalid-image', /unsupported|invalid.*image|image.*large/i],
    ['quota', /quota|count limit|storage.*limit/i],
    ['invalid-file-id', /file_id|file data not found/i],
    ['timeout', /timeout|timed out/i],
    ['json-format', /json/i],
  ]
  const local =
    item.localMessage && typeof item.localMessage === 'object'
      ? (item.localMessage as Record<string, unknown>)
      : {}
  const limitKey = describeKnownApiError(message)?.key
  return {
    name,
    ...(typeof item.status === 'number' ? { status: item.status } : {}),
    ...(typeof item.kind === 'string' && errorKinds.has(item.kind) ? { kind: item.kind } : {}),
    ...(typeof local.key === 'string' && Object.hasOwn(zh, local.key)
      ? { localKey: local.key }
      : {}),
    reason:
      limitKey === 'replyContextTooLong'
        ? 'context-limit'
        : limitKey === 'replyOutputLimitInvalid'
          ? 'output-limit'
          : (reasons.find(([, pattern]) => pattern.test(message + ' ' + name))?.[0] ??
            'unclassified'),
    ...(limitKey ? { limits: apiLimitCounts(message) } : {}),
    field: messageField.exec(message)?.[0],
    frames:
      typeof item.stack === 'string'
        ? safeFrames(
            item.stack
              .slice(0, 12_000)
              .split('\n')
              .filter((line) => /^\s*at /.test(line))
          )
        : [],
  }
}

/** Reserve a small part of the bounded timeline for problems that preceded a burst of info logs. */
const trimLogBuffer = (events: DiagnosticEvent[]) => {
  let excess = events.length - LOG_LIMIT
  if (excess <= 0) {
    return events
  }
  let issues = events.filter((entry) => entry.level !== 'info').length
  for (let index = 0; excess > 0; ) {
    const issue = events[index].level !== 'info'
    if (issue && issues <= LOG_ISSUE_RESERVE) {
      index++
      continue
    }
    events.splice(index, 1)
    excess--
    if (issue) {
      issues--
    }
  }
  return events
}

export const logEvent = (
  scope: LogScope,
  event: string,
  details: Record<string, unknown> = {},
  level: LogLevel = 'info'
) => {
  const entry: DiagnosticEvent = {
    id: createId(),
    timestamp: Date.now(),
    runId,
    source: 'client',
    scope,
    event,
    level,
    details: boundedLogDetails(details),
  }
  recent.push(entry)
  trimLogBuffer(recent)
  pending.push(entry)
  trimLogBuffer(pending)
  retainClientEvent(entry)
  if (timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined
      void flushDiagnosticLogs()
    }, 500)
  }
}

export const beginDiagnosticOperation = (
  scope: LogScope,
  event: string,
  details: Record<string, unknown> = {}
) => {
  const operationId = createId()
  const started = performance.now()
  logEvent(scope, event + '.started', { ...details, operationId })
  return (outcome: 'completed' | 'cancelled' | 'failed', result: Record<string, unknown> = {}) =>
    logEvent(
      scope,
      event + '.' + outcome,
      { ...details, ...result, operationId, elapsedMs: Math.round(performance.now() - started) },
      outcome === 'failed' ? 'error' : 'info'
    )
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
      const levels = tx.store.index('level')
      let issues = excess ? (await levels.count('warn')) + (await levels.count('error')) : 0
      for (
        let cursor = await tx.store.index('timestamp').openCursor();
        cursor && excess > 0;
        cursor = await cursor.continue()
      ) {
        const issue = cursor.value.level === 'warn' || cursor.value.level === 'error'
        if (issue && issues <= LOG_ISSUE_RESERVE) {
          continue
        }
        await cursor.delete()
        excess--
        if (issue) {
          issues--
        }
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
  storageAvailable: boolean
  persistedEvents: number
  databaseCreatedThisRun: boolean
}> => {
  let stored: DiagnosticEvent[] = []
  let storageAvailable = false
  try {
    await Promise.race([
      flushDiagnosticLogs(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), 2000)),
    ])
    stored = await Promise.race([
      db().then(async (database) => {
        const tx = database.transaction('events')
        const range = IDBKeyRange.lowerBound(Date.now() - LOG_RETENTION_MS, true)
        const entries: DiagnosticEvent[] = []
        for (
          let cursor = await tx.store.index('timestamp').openCursor(range, 'prev');
          cursor;
          cursor = await cursor.continue()
        ) {
          const entry = cursor.value
          if (entry && typeof entry.id === 'string' && Number.isFinite(entry.timestamp)) {
            entries.push(entry)
            if (entries.length === LOG_LIMIT) {
              break
            }
          }
        }
        await tx.done
        return entries
      }),
      new Promise<DiagnosticEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Log timeout')), 2000)
      ),
    ])
    storageAvailable = true
  } catch {
    /* 日志存储不可用时仍能导出内存记录。 */
  }
  const unique = new Map([...stored, ...recent].map((entry) => [entry.id, entry]))
  return {
    events: trimLogBuffer(
      [...unique.values()]
        .filter((entry) => entry.timestamp > Date.now() - LOG_RETENTION_MS)
        .sort((a, b) => a.timestamp - b.timestamp)
    ),
    unavailableWrites,
    storageAvailable,
    persistedEvents: stored.length,
    databaseCreatedThisRun,
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
      void flushRetainedClientEvents()
    }
  })
  window.addEventListener('pagehide', () => {
    void flushDiagnosticLogs()
    void flushRetainedClientEvents()
  })
}
