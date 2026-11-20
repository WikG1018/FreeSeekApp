import { Capacitor } from '@capacitor/core'
import { NativeDiagnostics } from './native.js'
import { browserEnvironment } from './browser.js'
import {
  readDiagnosticLogs,
  logEvent,
  registerLogSecret,
  sanitizeDetails,
  boundedLogDetails,
  diagnosticError,
  diagnosticId,
  LOG_ISSUE_RESERVE,
  LOG_LIMIT,
} from './log.js'
import { getStorageSummary } from '../chat/db.js'
import { useChatStore } from '../chat/store.js'
import { useSettings } from '../settings.js'
import { useUploads } from '../attachments.js'
import { useUpdate } from '../update.js'
import { API_ORIGIN } from '../api/client.js'
import { writeArchive } from '../chat/history/zipWriter.js'
import { useProviders } from '../providers.js'

type Capture<T> =
  | { status: 'available'; value: T }
  | {
      status: 'unsupported' | 'failed' | 'timeout'
      value?: undefined
      problem?: Record<string, unknown>
    }

const capture = async <T>(task: () => Promise<T>, timeoutMs = 4000): Promise<Capture<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(task)
        .then((value) => ({ status: 'available' as const, value })),
      new Promise<Capture<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
      }),
    ])
  } catch (error) {
    return { status: 'failed', problem: diagnosticError(error) }
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

const unavailable = { unavailable: true } as const

const eventFields = (entry: unknown, source: 'client' | 'native') => {
  if (!entry || typeof entry !== 'object') {
    return []
  }
  const event = entry as Record<string, unknown>
  const { timestamp, event: name, scope, level } = event
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    typeof name !== 'string' ||
    !/^[\w.-]{1,90}$/.test(name) ||
    typeof scope !== 'string' ||
    !/^[\w-]{1,32}$/.test(scope)
  ) {
    return []
  }
  return [
    {
      source,
      timestamp,
      id: diagnosticId(event.id),
      runId: diagnosticId(event.runId),
      scope,
      event: name,
      level: level === 'warn' || level === 'error' ? level : 'info',
      details: boundedLogDetails(event.details),
    },
  ]
}

/** 诊断包与会话备份独立：只采集运行元信息，不读取或打包正文、Key 和附件字节。 */
export const createDiagnosticBundle = async (): Promise<{ name: string; blob: Blob }> => {
  const started = performance.now(),
    settings = useSettings.getState()
  registerLogSecret(settings.apiKey)
  registerLogSecret(settings.thirdPartySearch.apiKey)
  const providers = useProviders.getState()
  providers.profiles.forEach((profile) => {
    registerLogSecret(profile.apiKey)
    Object.values(profile.headers).forEach(registerLogSecret)
  })
  logEvent('diagnostics', 'export.started')
  const platform = Capacitor.getPlatform()
  const [client, storage, browserStorage, browser, native] = await Promise.all([
    readDiagnosticLogs(),
    capture(getStorageSummary),
    navigator.storage?.estimate
      ? capture(() => navigator.storage.estimate())
      : { status: 'unsupported' as const, value: undefined },
    capture(async () => browserEnvironment()),
    platform === 'android'
      ? capture(() => NativeDiagnostics.snapshot())
      : { status: 'unsupported' as const, value: undefined },
  ])
  const nativeLog = native.value
    ? { status: 'available' as const, value: native.value }
    : platform === 'android'
      ? await capture(() => NativeDiagnostics.readEvents(), 1500)
      : { status: 'unsupported' as const, value: undefined }
  const nativeEvents = Array.isArray(nativeLog.value?.events)
    ? nativeLog.value.events.slice(-1000).flatMap((entry) => eventFields(entry, 'native'))
    : []
  const state = useChatStore.getState()
  const active = state.activeId ? state.sessionCache[state.activeId] : undefined
  const lastReply = active?.messages.findLast((message) => message.role === 'assistant')
  const usage =
    lastReply?.role === 'assistant'
      ? (lastReply.usageHistory?.at(-1)?.usage ?? lastReply.usage)
      : undefined
  const taskCounts = { uploading: 0, done: 0, error: 0 }
  Object.values(useUploads.getState().tasks).forEach((task) => {
    taskCounts[task.status]++
  })
  const update = useUpdate.getState()
  const profile = providers.profiles.find((item) => item.id === providers.selection.providerId)
  let apiHost = 'unknown'
  try {
    apiHost = new URL(API_ORIGIN).host
  } catch {
    /* 不导出自定义地址原文。 */
  }
  const environment = sanitizeDetails({
    app: {
      version: document.querySelector('meta[name="application-version"]')?.getAttribute('content'),
      platform,
      apiHost,
      apiKeyConfigured: Boolean(settings.apiKey),
      uptimeMs: Math.round(performance.now()),
      nativePlugins:
        platform === 'android'
          ? Object.fromEntries(
              [
                'Diagnostics',
                'DiagnosticShare',
                'Backup',
                'HistoryFiles',
                'Update',
                'CustomHttp',
                'StartupHandoff',
                'MicPermission',
              ].map((plugin) => [plugin, Capacitor.isPluginAvailable(plugin)])
            )
          : undefined,
    },
    browser: browser.value ?? unavailable,
    preferences: {
      locale: settings.locale,
      theme: settings.themePreference,
      startupPage: settings.startupPage,
      fontScale: settings.fontScale,
      showUsage: settings.showUsage,
      showModelSwitcher: settings.showModelSwitcher,
      showReasoningPicker: settings.showReasoningPicker,
      autoCompress: settings.autoCompress,
      customProvider: providers.selection.providerId !== 'deepseek',
      providerCount: providers.profiles.length,
      protocol: profile?.protocol ?? 'deepseek',
      officialModel:
        providers.selection.providerId === 'deepseek' ? providers.selection.model : undefined,
      customStream: profile?.stream,
      customStreamUsage: profile?.streamUsage,
      customContextTokens: profile?.contextWindows?.[providers.selection.model],
      customMaxOutputTokens:
        profile?.modelSettings?.[providers.selection.model]?.maxOutputTokens ??
        profile?.maxOutputTokens,
      customVision: profile?.vision,
      customPdf: profile?.pdf,
      thinking: settings.thinking,
      search: settings.search,
      proSearch: settings.proSearchOn,
      thirdPartySearch: settings.thirdPartySearchOn,
      independentSearchConfigured: settings.thirdPartySearch.enabled,
      searchKeySource: settings.thirdPartySearch.keySource,
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
      loadErrors: Object.values(state.sessionLoadErrors).filter(Boolean).length,
      saveErrors: Object.values(state.sessionSaveErrors).filter(Boolean).length,
      lastReplyStatus: lastReply?.status,
      lastStopReason: lastReply?.stopReason,
      lastReplyHttpStatus: lastReply?.error?.status,
      localKey: lastReply?.error?.localMessage?.key,
      lastReasoningLevel: lastReply?.reasoning?.level,
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
    storage: storage.value ?? unavailable,
    browserStorage: browserStorage.value ?? unavailable,
    native: native.value?.environment ?? unavailable,
  })
  const events = client.events.flatMap((entry) => eventFields(entry, 'client'))
  const allEvents = [...events, ...nativeEvents]
  const errorEvents = allEvents.filter((entry) => entry.level === 'error' || entry.level === 'warn')
  const scopes: Record<string, { events: number; issues: number; latestAt: number }> =
    Object.create(null)
  for (const entry of allEvents) {
    const scope = (scopes[entry.scope] ??= { events: 0, issues: 0, latestAt: 0 })
    scope.events++
    scope.issues += Number(entry.level !== 'info')
    scope.latestAt = Math.max(scope.latestAt, entry.timestamp)
  }
  const summary = {
    clientEvents: events.length,
    nativeEvents: nativeEvents.length,
    clientStorageAvailable: client.storageAvailable,
    nativeSnapshotAvailable: Boolean(native.value?.environment),
    unavailableClientWrites: client.unavailableWrites,
    unavailableNativeWrites: nativeLog.value?.failedWrites,
    nativeLogReadFailure:
      nativeLog.value?.readFailure === 'size-limit' || nativeLog.value?.readFailure === 'unreadable'
        ? nativeLog.value.readFailure
        : undefined,
    collection: {
      clientEvents: client.storageAvailable ? 'available' : 'memory-only',
      native: native.status,
      nativeEvents: nativeLog.status,
      browser: browser.status,
      storage: storage.status,
      browserStorage: browserStorage.status,
    },
    collectionErrors: Object.fromEntries(
      Object.entries({ native, nativeEvents: nativeLog, browser, storage, browserStorage }).flatMap(
        ([source, entry]) => ('problem' in entry && entry.problem ? [[source, entry.problem]] : [])
      )
    ),
    scopes,
    recentIssues: errorEvents.sort((a, b) => a.timestamp - b.timestamp).slice(-30),
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
      searchTerms: 'excluded',
      deviceIdentifiers: 'excluded',
      attachmentOriginals: 'excluded',
      audio: 'excluded',
    },
    retention: {
      days: 7,
      clientLimit: LOG_LIMIT,
      nativeLimit: 1000,
      clientIssueReserve: LOG_ISSUE_RESERVE,
      nativeIssueReserve: 150,
    },
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
            'FreeSeek 诊断包\n环境信息见 environment.json，采集状态和近期问题见 summary.json。\nclient-events.jsonl 与 native-events.jsonl 记录操作、处理结果和失败阶段。带有相同 operationId 或 requestId 的记录可以一起查看。\n不包含 API Key、聊天正文、搜索词、附件原件、录音或设备唯一标识。\n日志最多保留最近 7 天。客户端最多 2000 条，原生最多 1000 条，满额时给近期警告和错误保留空间。\n反馈问题时请说明发生时间与操作步骤。\n',
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
