import { Capacitor } from '@capacitor/core'
import { strToU8, zipSync } from 'fflate'
import { NativeDiagnostics } from './native.js'
import { flushRetainedClientEvents, retainedClientWriteStatus } from './retained.js'
import { browserEnvironment } from './browser.js'
import { isWindowsDesktop } from '../api/windowsTransport.js'
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
import { readLocalCheckpoint } from '../chat/historyCheckpoint.js'
import { useHistoryVault } from '../chat/historyVault.js'
import { historyVaultAvailable, NativeVault } from '../chat/historyVaultNative.js'
import { useChatStore } from '../chat/store.js'
import { useAssistantLibrary } from '../assistants/library.js'
import { useSettings } from '../settings.js'
import { useUploads } from '../attachments.js'
import { useUpdate } from '../update.js'
import { API_ORIGIN } from '../api/client.js'
import {
  providerModelContextWindow,
  providerModelOutputLimit,
  providerModelParameters,
  useProviders,
} from '../providers.js'

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
const jsonBytes = (value: unknown) => strToU8(JSON.stringify(value, null, 2))
const jsonl = (entries: unknown[]) =>
  strToU8(entries.map((entry) => JSON.stringify(entry) + '\n').join(''))

const timeline = (events: { timestamp: number }[]) => ({
  count: events.length,
  ...(events.length
    ? {
        firstAt: Math.min(...events.map(({ timestamp }) => timestamp)),
        lastAt: Math.max(...events.map(({ timestamp }) => timestamp)),
      }
    : {}),
})

const unavailable = { unavailable: true } as const

const historyVaultPhases = ['checking', 'idle', 'protecting', 'restoring', 'error']

const readHistoryVaultStatus = async () => {
  try {
    const { sessionCount, originalCount, missingOriginalCount, bytes, pendingId } =
      await NativeVault.status()
    if (![sessionCount, originalCount, missingOriginalCount, bytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )) {
      return { status: 'failed' as const }
    }
    return {
      status: 'available' as const,
      sessionCount,
      originalCount,
      missingOriginalCount,
      bytes,
      pendingCommit: typeof pendingId === 'string' && pendingId.length > 0,
    }
  } catch (error) {
    const { name, code } = error && typeof error === 'object'
      ? (error as { name?: string; code?: string })
      : {}
    if (name === 'SecurityError' || name === 'NotAllowedError' ||
        (code && ['PERMISSION', 'PERMISSION_DENIED', 'EACCES', 'EPERM'].includes(code))) {
      return { status: 'permission' as const }
    }
    if (name === 'TimeoutError' || code === 'TIMEOUT') {
      return { status: 'timeout' as const }
    }
    return { status: 'failed' as const }
  }
}

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
  registerLogSecret(settings.roleVoice.custom.apiKey)
  const providers = useProviders.getState()
  providers.profiles.forEach((profile) => {
    registerLogSecret(profile.apiKey)
    Object.values(profile.headers).forEach(registerLogSecret)
  })
  logEvent('diagnostics', 'export.started')
  const platform = isWindowsDesktop() ? 'windows' : Capacitor.getPlatform()
  const desktopDiagnostics = platform === 'windows' ? window.freeseekDesktopDiagnostics : undefined
  const hasVault = platform === 'android' && historyVaultAvailable()
  const vaultPhase = useHistoryVault.getState().phase
  const [client, storage, browserStorage, browser, native, vault] = await Promise.all([
    readDiagnosticLogs(),
    capture(getStorageSummary),
    navigator.storage?.estimate
      ? capture(() => navigator.storage.estimate())
      : { status: 'unsupported' as const, value: undefined },
    capture(async () => browserEnvironment()),
    platform === 'android'
      ? capture(async () => {
          await capture(flushRetainedClientEvents, 800)
          return NativeDiagnostics.snapshot()
        }, 4800)
      : desktopDiagnostics
        ? capture(desktopDiagnostics)
        : { status: 'unsupported' as const, value: undefined },
    hasVault
      ? capture(readHistoryVaultStatus, 1600)
      : { status: 'unsupported' as const, value: undefined },
  ])
  const vaultStatus = vault.value?.status ?? vault.status
  const nativeLog = native.value
    ? { status: 'available' as const, value: native.value }
    : platform === 'android'
      ? await capture(() => NativeDiagnostics.readEvents(), 1500)
      : { status: 'unsupported' as const, value: undefined }
  const nativeEvents = Array.isArray(nativeLog.value?.events)
    ? nativeLog.value.events.slice(-1000).flatMap((entry) => eventFields(entry, 'native'))
    : []
  const retained = nativeLog.value?.retainedClient
  const retainedEvents = Array.isArray(retained?.events)
    ? retained.events.slice(-512).flatMap((entry) => eventFields(entry, 'client'))
    : []
  const state = useChatStore.getState()
  const library = useAssistantLibrary.getState()
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
  const modelParameters = profile && providerModelParameters(profile, providers.selection.model)
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
                'HistoryVault',
                'Update',
                'CustomHttp',
                'StartupHandoff',
                'StartupRoute',
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
      useSystemFont: settings.useSystemFont,
      showUsage: settings.showUsage,
      roleVoiceEnabled: settings.roleVoice.enabled,
      roleVoiceSource: settings.roleVoice.source,
      roleVoiceCustomConfigured: Boolean(
        settings.roleVoice.custom.url && settings.roleVoice.custom.apiKey
      ),
      showModelSwitcher: settings.showModelSwitcher,
      composerEnter: settings.composerEnter,
      showReasoningPicker: settings.showReasoningPicker,
      autoCompress: settings.autoCompress,
      customProvider: providers.selection.providerId !== 'deepseek',
      providerCount: providers.profiles.length,
      protocol: profile?.protocol ?? 'deepseek',
      officialModel:
        providers.selection.providerId === 'deepseek' ? providers.selection.model : undefined,
      customStream: modelParameters?.stream,
      customStreamUsage: modelParameters?.streamUsage,
      customContextTokens:
        profile && providerModelContextWindow(profile, providers.selection.model),
      customOutputLimitTokens:
        profile && providerModelOutputLimit(profile, providers.selection.model),
      customMaxOutputTokens: modelParameters?.maxOutputTokens,
      customVision: modelParameters?.vision,
      customPdf: modelParameters?.pdf,
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
      historyUpgradeBlocked: state.historyUpgradeBlocked,
      historyMissing: state.historyMissing,
      historyRecoveryReason: state.historyRecoveryReason,
      importing: state.importingHistory,
      sessionCount: state.sessions.length,
      memory:
        library.ready && !library.failed
          ? {
              status: 'available',
              enabled: library.data.enabled,
              automatic: library.data.automatic,
              currentChatPaused: active?.memoryPaused ?? false,
              notes: library.data.memories.length,
              requests: library.data.maintenance.requests,
              lastAttemptAt: library.data.maintenance.lastAt,
            }
          : { status: library.failed ? 'failed' : 'not-loaded' },
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
    localHistoryCheckpoint: readLocalCheckpoint(),
    historyCheckpoint: nativeLog.value?.historyCheckpoint,
    historyVault: platform === 'android'
      ? {
          ...(vault.value ?? { status: vault.status }),
          phase: hasVault && historyVaultPhases.includes(vaultPhase) ? vaultPhase : undefined,
        }
      : undefined,
    browserStorage: browserStorage.value ?? unavailable,
    native: native.value?.environment ?? unavailable,
  })
  const webviewEvents = client.events.flatMap((entry) => eventFields(entry, 'client'))
  const localIds = new Set(webviewEvents.map(({ id }) => id))
  const recovered = retainedEvents.filter(({ id }) => id && !localIds.has(id))
  const events = [
    ...webviewEvents,
    ...recovered.map((entry) => ({ ...entry, recoveredFromNative: true })),
  ].sort((a, b) => a.timestamp - b.timestamp)
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
    recoveredClientEvents: recovered.length,
    timeline: {
      webview: timeline(webviewEvents),
      native: timeline(nativeEvents),
      retainedClient: timeline(retainedEvents),
    },
    clientIndexedDBEvents: client.persistedEvents,
    clientIndexedDBCreatedThisRun: client.databaseCreatedThisRun,
    nativeEvents: nativeEvents.length,
    clientStorageAvailable: client.storageAvailable,
    nativeSnapshotAvailable: Boolean(native.value?.environment),
    unavailableClientWrites: client.unavailableWrites,
    clientLogRead: client.readStatus,
    clientLogFlush: client.flushStatus,
    clientPendingEvicted: client.pendingEvicted,
    unavailableNativeWrites: nativeLog.value?.failedWrites,
    retainedClient: retained
      ? {
          limit: retained.limit,
          historyReserve: retained.historyReserve,
          issueReserve: retained.issueReserve,
          readState: retained.readState,
          evicted: retained.evicted,
          expired: retained.expired,
          rejected: retained.rejected,
          failedWrites: retained.failedWrites,
          bridge: retainedClientWriteStatus(),
        }
      : undefined,
    nativeLogReadFailure:
      nativeLog.value?.readFailure === 'size-limit' || nativeLog.value?.readFailure === 'unreadable'
        ? nativeLog.value.readFailure
        : undefined,
    collection: {
      clientEvents: client.storageAvailable ? 'available' : 'memory-only',
      native: native.status,
      historyVault: vaultStatus,
      nativeEvents: nativeLog.status,
      retainedClient:
        retained?.readState ??
        (nativeLog.status === 'available' ? 'unsupported' : nativeLog.status),
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
      retainedClientLimit: retained?.limit,
    },
  }
  try {
    // Android sharing targets often read their content URI sequentially with ZipInputStream.
    // These six bounded metadata files have known sizes. Include sizes and CRCs in local headers.
    const bytes = zipSync(
      {
        'manifest.json': jsonBytes(manifest),
        'environment.json': jsonBytes(environment),
        'summary.json': jsonBytes(summary),
        'client-events.jsonl': jsonl(events),
        'native-events.jsonl': jsonl(nativeEvents),
        'README.txt': strToU8(
          'FreeSeek 诊断包\n设备、当前存储和最后核实的历史数量见 environment.json。采集状态、各来源的时间范围、日志淘汰及写入失败计数见 summary.json。\nclient-events.jsonl 与 native-events.jsonl 记录操作、处理结果和失败阶段。相同 operationId 或 requestId 可串起同一次操作。recoveredFromNative 表示从安卓独立日志中补回的记录。\n不包含 API Key、聊天正文、搜索词、附件原件、录音或设备唯一标识。\n日志最多保留最近 7 天。客户端最多 2000 条，原生系统日志最多 1000 条，安卓额外保存最多 512 条关键客户端记录。\n'
        ),
      },
      { level: 0 }
    )
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
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
