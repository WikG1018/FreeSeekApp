import { Capacitor } from '@capacitor/core'
import { NativeDiagnostics } from './native.js'
import {
  readDiagnosticLogs,
  logEvent,
  registerLogSecret,
  sanitizeDetails,
  diagnosticError,
} from './log.js'
import { getStorageSummary } from '../chat/db.js'
import { useChatStore } from '../chat/store.js'
import { useSettings } from '../settings.js'
import { useUploads } from '../attachments.js'
import { useUpdate } from '../update.js'
import { API_ORIGIN } from '../api/client.js'
import { writeArchive } from '../chat/history/zipWriter.js'

const bounded = async <T>(
  task: Promise<T>,
  timeoutMs = 4000
): Promise<T | { unavailable: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<{ unavailable: true }>((resolve) => {
        timer = setTimeout(() => resolve({ unavailable: true }), timeoutMs)
      }),
    ])
  } catch {
    return { unavailable: true }
  } finally {
    clearTimeout(timer)
  }
}
const objectBlob = (value: unknown) =>
  new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
const jsonl = (entries: unknown[]) =>
  new Blob([entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'], {
    type: 'application/x-ndjson',
  })

/** 诊断包与会话备份独立：只采集运行元信息，不读取或打包正文、Key 和附件字节。 */
export const createDiagnosticBundle = async (): Promise<{ name: string; blob: Blob }> => {
  const started = performance.now(),
    settings = useSettings.getState()
  registerLogSecret(settings.apiKey)
  logEvent('diagnostics', 'export.started')
  const [client, storage, browserStorage, native] = await Promise.all([
    readDiagnosticLogs(),
    bounded(getStorageSummary()),
    bounded(navigator.storage?.estimate?.() ?? Promise.resolve({})),
    Capacitor.getPlatform() === 'android'
      ? bounded(NativeDiagnostics.snapshot())
      : Promise.resolve({ unavailable: true as const }),
  ])
  const nativeEvents =
    'events' in native && Array.isArray(native.events)
      ? native.events.slice(-1000).map((entry) => sanitizeDetails(entry))
      : []
  const state = useChatStore.getState()
  const active = state.activeId ? state.sessionCache[state.activeId] : undefined
  const lastReply = active?.messages.toReversed().find((message) => message.role === 'assistant')
  const usage =
    lastReply?.role === 'assistant'
      ? (lastReply.usageHistory?.at(-1)?.usage ?? lastReply.usage)
      : undefined
  const taskCounts = { uploading: 0, done: 0, error: 0 }
  Object.values(useUploads.getState().tasks).forEach((task) => {
    taskCounts[task.status]++
  })
  const update = useUpdate.getState()
  const heap = (
    performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory
  let apiHost = 'unknown'
  try {
    apiHost = new URL(API_ORIGIN).host
  } catch {
    /* 不导出自定义地址原文。 */
  }
  const environment = sanitizeDetails({
    app: {
      version: document.querySelector('meta[name="application-version"]')?.getAttribute('content'),
      platform: Capacitor.getPlatform(),
      apiHost,
      apiKeyConfigured: Boolean(settings.apiKey),
    },
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      createImageBitmap: typeof createImageBitmap === 'function',
      mediaDevices: Boolean(navigator.mediaDevices),
      jsHeap: heap
        ? { usedJSHeapSize: heap.usedJSHeapSize, jsHeapSizeLimit: heap.jsHeapSizeLimit }
        : undefined,
    },
    preferences: {
      locale: settings.locale,
      theme: settings.themePreference,
      fontScale: settings.fontScale,
      showUsage: settings.showUsage,
      thinking: settings.thinking,
      search: settings.search,
      voice: settings.ttsVoice,
      locationConfigured: Boolean(settings.location),
    },
    state: {
      ready: state.ready,
      initError: state.initError,
      importing: state.importingHistory,
      sessionCount: state.sessions.length,
      cachedSessions: Object.keys(state.sessionCache).length,
      activeMessages: active?.messages.length,
      inheritedMessages: active?.inherited?.messages.length ?? 0,
      streamingCount: Object.keys(state.streaming).length,
      saveErrors: Object.values(state.sessionSaveErrors).filter(Boolean).length,
      lastRequestInputTokens: usage
        ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
        : undefined,
      lastRequestOutputTokens: usage?.output_tokens,
      uploads: taskCounts,
    },
    update: {
      status: update.status,
      release: update.release?.version,
      percent: update.percent,
      lastCheckedAt: update.lastCheckedAt,
    },
    storage,
    browserStorage,
    native: 'environment' in native ? native.environment : native,
  })
  const events = client.events.map((entry) => ({
    ...entry,
    details: sanitizeDetails(entry.details),
  }))
  const errorEvents = [...events, ...nativeEvents].filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      'level' in entry &&
      ['error', 'warn'].includes(String(entry.level))
  )
  const summary = {
    clientEvents: events.length,
    nativeEvents: nativeEvents.length,
    unavailableClientWrites: client.unavailableWrites,
    unavailableNativeWrites: 'failedWrites' in native ? native.failedWrites : undefined,
    recentIssues: errorEvents
      .sort((a, b) => {
        const left =
          a && typeof a === 'object' && 'timestamp' in a && typeof a.timestamp === 'number'
            ? a.timestamp
            : 0
        const right =
          b && typeof b === 'object' && 'timestamp' in b && typeof b.timestamp === 'number'
            ? b.timestamp
            : 0
        return left - right
      })
      .slice(-30),
    createdInMs: Math.round(performance.now() - started),
  }
  const createdAt = new Date().toISOString()
  const manifest = {
    diagnostic_format_version: 1,
    createdAt,
    version: document.querySelector('meta[name="application-version"]')?.getAttribute('content'),
    privacy: {
      apiKey: 'excluded',
      chatContent: 'excluded',
      attachmentOriginals: 'excluded',
      audio: 'excluded',
    },
    retention: { days: 7, clientLimit: 2000, nativeLimit: 1000 },
  }
  try {
    const blob = await writeArchive([
      { name: 'manifest.json', blob: objectBlob(manifest) },
      { name: 'environment.json', blob: objectBlob(environment) },
      { name: 'summary.json', blob: objectBlob(summary) },
      { name: 'client-events.jsonl', blob: jsonl(events) },
      { name: 'native-events.jsonl', blob: jsonl(nativeEvents) },
      {
        name: 'README.txt',
        blob: new Blob(
          [
            'FreeSeek 诊断包\n包含版本、环境、请求状态、上传、重试、存储、更新与运行错误。\n不包含 API Key、聊天正文、附件原件或录音。\n日志最多保留最近7天（客户端2000条、原生1000条）。\n反馈问题时请说明发生时间与操作步骤。\n不是聊天备份，请勿用此包恢复对话。\n',
          ],
          { type: 'text/plain' }
        ),
      },
    ])
    logEvent('diagnostics', 'export.created', {
      bytes: blob.size,
      clientEvents: events.length,
      nativeEvents: nativeEvents.length,
    })
    return { name: 'freeseek-diagnostics-' + createdAt.replace(/[.:]/g, '-') + '.zip', blob }
  } catch (error) {
    logEvent('diagnostics', 'export.failed', diagnosticError(error), 'error')
    throw error
  }
}
