import { agentProbePrompt, agentProbeSystem, verifyAgentTools } from './toolProbe.js'
import { describeKnownApiError } from './knownErrors.js'
import { ApiError } from './errorTypes.js'
import {
  ChatStreamProgress,
  StreamIdleTimeoutError,
  StreamReadError,
  readServerSentEvents,
} from './sse.js'
import { isAndroidProviderResponse, providerFetch } from './providerTransport.js'
import {
  streamWithProviderSearch,
  streamWithTaskTools,
  type SearchTool,
  type SearchTurnCollector,
  type TaskToolset,
} from './searchTool.js'
import {
  modelSettingsFor,
  providerModelParameters,
  providerOutputBudget,
  validateProfile,
  validateProviderModelOutput,
  type ProviderModelParameters,
  type ProviderProfile,
} from '../providers.js'
import { isOfficialMiMoV26, isOpenCodeGoUrl, OPEN_CODE_GO_PATH } from '../providerPresets.js'
import { applyReasoning, customReasoning, type ReasoningChoice } from '../reasoning.js'
import type { ProviderMessage, ProviderPart } from './providerContent.js'
import type { MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { createProviderUsageReader } from './providerUsage.js'
import {
  beginDiagnosticOperation,
  logEvent,
  diagnosticError,
  registerLogSecret,
} from '../diagnostics/log.js'
import { createId } from '../../utils/id.js'
import { abortableDelay } from '../../utils/abort.js'
import type { TranslationKey } from '../../i18n/index.js'

type Json = Record<string, unknown>
type ProviderRequestProfile = ProviderProfile & ProviderModelParameters
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const goProtocolPath: Record<ProviderProfile['protocol'], string> = {
  openai: '/openai/v1',
  responses: '/openai/v1',
  anthropic: '/anthropic/v1',
  gemini: '/google/v1beta',
}
export const providerEndpoint = (
  profile: ProviderProfile,
  operation: 'models' | 'chat',
  model: string,
  streaming = true
) => {
  if (operation === 'models' && profile.modelListUrl) {
    return profile.modelListUrl
  }
  const url = new URL(profile.url)
  const go = isOpenCodeGoUrl(url)
  let path = url.pathname.replace(/\/+$/, '')
  path = path
    .replace(/\/(chat\/completions|responses|messages)$/, '')
    .replace(/\/models\/[^/]+:(streamGenerateContent|generateContent)$/, '')
  if (go) {
    path = OPEN_CODE_GO_PATH + (operation === 'models' ? '/v1' : goProtocolPath[profile.protocol])
  } else if (!path) {
    path = profile.protocol === 'gemini' ? '/v1beta' : '/v1'
  }
  if (operation === 'models') {
    path += '/models'
  } else if (profile.protocol === 'gemini') {
    path += `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:${streaming ? 'streamGenerateContent' : 'generateContent'}`
  } else {
    path +=
      profile.protocol === 'openai'
        ? '/chat/completions'
        : profile.protocol === 'responses'
          ? '/responses'
          : '/messages'
  }
  url.pathname = path
  if (profile.protocol === 'gemini') {
    if (operation === 'chat' && streaming) {
      url.searchParams.set('alt', 'sse')
    } else {
      url.searchParams.delete('alt')
    }
  }
  return url.toString()
}
type RequestContext = { requestId?: string; sessionId?: string; operationId?: string }
const browserGoSessions = new Map<string, string>()
const goSessionHeader = async (profile: ProviderProfile, sessionId?: string) => {
  if (!sessionId) {
    return `ses_${createId()}`
  }
  // Imported conversation IDs can be arbitrary strings. Send only an opaque identifier.
  const session = JSON.stringify([profile.id, sessionId])
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session))
    const hash = Array.from(new Uint8Array(bytes, 0, 16), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    return `ses_${hash}`
  }
  // Pages served over plain HTTP do not expose SubtleCrypto.
  const value = browserGoSessions.get(session) ?? `ses_${createId()}`
  browserGoSessions.set(session, value)
  return value
}
const headersFor = async (
  profile: ProviderProfile,
  go: boolean,
  chat: boolean,
  sessionId?: string
): Promise<Record<string, string>> => {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  })
  if (profile.apiKey) {
    const auth =
      !go && profile.protocol === 'anthropic'
        ? 'x-api-key'
        : !go && profile.protocol === 'gemini'
          ? 'x-goog-api-key'
          : 'Authorization'
    headers.set(auth, auth === 'Authorization' ? `Bearer ${profile.apiKey}` : profile.apiKey)
  }
  if (profile.protocol === 'anthropic') {
    headers.set('anthropic-version', '2023-06-01')
  }
  if (go) {
    const version = document
      .querySelector('meta[name="application-version"]')
      ?.getAttribute('content')
    headers.set('User-Agent', version ? `FreeSeek/${version}` : 'FreeSeek')
    if (chat) {
      headers.set('x-opencode-session', await goSessionHeader(profile, sessionId))
    }
  }
  for (const [key, value] of Object.entries(profile.headers)) {
    headers.set(key, value)
    registerLogSecret(value)
  }
  registerLogSecret(profile.apiKey)
  return Object.fromEntries(headers.entries())
}
const goHttpErrors: Partial<Record<number, TranslationKey>> = {
  401: 'providerOpenCodeGoUnauthorized',
  402: 'providerOpenCodeGoQuota',
  403: 'providerOpenCodeGoForbidden',
}
const remoteLimit = (data: Json) => {
  const detail = record(data.error ?? record(data.response).error ?? data)
  return describeKnownApiError(text(detail.message), text(detail.code || detail.type))
}
export const readApiJson = async (
  response: Response,
  signal: AbortSignal,
  limit = 8 * 1024 * 1024,
  timing?: { idleMs: number; maxMs: number }
): Promise<Json> => {
  if (!response.body) {
    throw new ApiError('protocol', { key: 'providerInvalidResponse' })
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let body = '',
    size = 0,
    timedOut = false
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  const timeout = () => {
    timedOut = true
    abort()
  }
  let timer = timing || !isAndroidProviderResponse(response)
    ? setTimeout(timeout, timing?.idleMs ?? 60000)
    : undefined
  const deadline = timing && setTimeout(timeout, timing.maxMs)
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read().catch((error: unknown) => {
        signal.throwIfAborted()
        if (timedOut) {
          throw new ApiError('network', { key: 'streamIdleTimeout' })
        }
        if (error instanceof ApiError) {
          throw error
        }
        throw new StreamReadError(size, error)
      })
      if (done) {
        break
      }
      size += value.length
      if (size > limit) {
        throw new ApiError('protocol', { key: 'providerResponseTooLarge' })
      }
      if (timing && value.length && !timedOut) {
        clearTimeout(timer)
        timer = setTimeout(timeout, timing.idleMs)
      }
      body += decoder.decode(value, { stream: true })
    }
    signal.throwIfAborted()
    if (timedOut) {
      throw new ApiError('network', { key: 'streamIdleTimeout' })
    }
    body += decoder.decode()
    try {
      return record(JSON.parse(body))
    } catch {
      throw new ApiError('protocol', { key: 'providerInvalidResponse' })
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    abort()
    reader.releaseLock()
  }
}
export const fetchProviderResponse = async (
  profile: ProviderProfile,
  url: string,
  body: unknown | undefined,
  signal: AbortSignal,
  { requestId = createId(), sessionId, operationId }: RequestContext = {}
) => {
  const started = performance.now()
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const bodyBytes = serialized ? new Blob([serialized]).size : 0
  if (bodyBytes > 32 * 1024 * 1024) {
    logEvent(
      'api',
      'provider.request-too-large',
      { requestId, protocol: profile.protocol, bodyBytes },
      'warn'
    )
    throw new ApiError('protocol', { key: 'providerFileTooLarge' })
  }
  const controller = new AbortController(),
    abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 120000)
  logEvent('api', 'provider.request', {
    requestId,
    operationId,
    protocol: profile.protocol,
    operation: body === undefined ? 'models' : 'chat',
    bodyBytes,
  })
  try {
    const go = isOpenCodeGoUrl(new URL(url))
    const response = await providerFetch(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: await headersFor(profile, go, body !== undefined, sessionId),
        body: serialized,
        signal: controller.signal,
      },
      requestId
    )
    logEvent('api', 'provider.response', {
      requestId,
      operationId,
      upstreamRequestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-ds-request-id'),
      status: response.status,
      openCodeGo: go,
      streaming: response.headers.get('Content-Type')?.includes('text/event-stream'),
      elapsedMs: Math.round(performance.now() - started),
    })
    if (!response.ok) {
      const known =
        response.status === 400 || response.status === 413 || response.status === 422
          ? remoteLimit(await readApiJson(response, controller.signal, 32768).catch(() => ({})))
          : undefined
      void response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
      const goError = go ? goHttpErrors[response.status] : undefined
      throw new ApiError(
        'http',
        known ??
          (goError
            ? { key: goError }
            : { key: 'providerHttpError', params: { status: response.status } }),
        response.status
      )
    }
    return {
      response,
      dispose: () => {
        signal.removeEventListener('abort', abort)
        controller.abort()
      },
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    logEvent(
      'api',
      signal.aborted ? 'provider.cancelled' : 'provider.failed',
      {
        requestId,
        operationId,
        timedOut,
        elapsedMs: Math.round(performance.now() - started),
        ...diagnosticError(error),
      },
      signal.aborted ? 'info' : 'error'
    )
    if (signal.aborted) {
      signal.throwIfAborted()
    }
    if (error instanceof ApiError) {
      throw error
    }
    const nativeTimeout = (error as { code?: unknown } | undefined)?.code === 'TIMEOUT'
    throw new ApiError('network', { key: timedOut || nativeTimeout ? 'streamIdleTimeout' : 'providerNetworkError' })
  } finally {
    clearTimeout(timer)
  }
}
export type ProviderCatalogModel = { id: string; contextWindow?: number; outputLimit?: number }
const loadProviderCatalog = async (
  input: ProviderProfile,
  signal: AbortSignal
): Promise<ProviderCatalogModel[]> => {
  const profile = validateProfile(input, false),
    models = new Map<string, ProviderCatalogModel>()
  const url = new URL(providerEndpoint(profile, 'models', ''))
  const go = isOpenCodeGoUrl(url)
  const gemini = !go && profile.protocol === 'gemini'
  let next: string | undefined
  for (let page = 0; page < 10; page++) {
    if (next) {
      url.searchParams.set(gemini ? 'pageToken' : 'after_id', next)
    }
    const { response, dispose } = await fetchProviderResponse(profile, url.toString(), undefined, signal)
    try {
      const data = await readApiJson(response, signal)
      const items = gemini ? data.models : data.data
      if (!Array.isArray(items)) {
        throw new ApiError('protocol', { key: 'providerInvalidResponse' })
      }
      for (const item of items) {
        const value = record(item)
        if (
          gemini &&
          Array.isArray(value.supportedGenerationMethods) &&
          !value.supportedGenerationMethods.includes('generateContent')
        ) {
          continue
        }
        const id = text(value.id || value.name).replace(gemini ? /^models\// : /$^/, '')
        if (id && id.length <= 200 && !Array.from(id).some((char) => char.charCodeAt(0) < 32)) {
          const advertised =
            value.context_length ??
            value.context_window ??
            value.inputTokenLimit ??
            record(value.limit).context
          const contextWindow =
            typeof advertised === 'number' &&
            Number.isSafeInteger(advertised) &&
            advertised >= 512 &&
            advertised <= 10000000
              ? advertised
              : undefined
          const output = value.outputTokenLimit ?? value.max_output_tokens ?? value.max_completion_tokens ??
            record(value.top_provider).max_completion_tokens
          const outputLimit = typeof output === 'number' && Number.isSafeInteger(output) &&
            output >= 16 && output <= 1048576 ? output : undefined
          models.set(id, { id, contextWindow, ...(outputLimit !== undefined && { outputLimit }) })
        }
      }
      const token = gemini
        ? text(data.nextPageToken)
        : !go && profile.protocol === 'anthropic' && data.has_more
          ? text(data.last_id)
          : ''
      if (!token || token === next || models.size >= 5000) {
        break
      }
      next = token
    } finally {
      dispose()
    }
  }
  if (!models.size) {
    throw new ApiError('protocol', { key: 'providerModelsEmpty' })
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5000)
}

export const fetchProviderCatalog = async (
  input: ProviderProfile,
  signal: AbortSignal
): Promise<ProviderCatalogModel[]> => {
  const finish = beginDiagnosticOperation('api', 'provider.catalog', { protocol: input.protocol })
  try {
    const models = await loadProviderCatalog(input, signal)
    finish('completed', { modelCount: models.length })
    return models
  } catch (error) {
    finish(signal.aborted ? 'cancelled' : 'failed', diagnosticError(error))
    throw error
  }
}

export const fetchProviderModels = async (input: ProviderProfile, signal: AbortSignal) =>
  (await fetchProviderCatalog(input, signal)).map(({ id }) => id)
const partFor = (
  part: ProviderPart,
  protocol: ProviderProfile['protocol'],
  role: 'user' | 'assistant'
): Json => {
  if (protocol === 'gemini') {
    return part.type === 'text'
      ? { text: part.text }
      : { inlineData: { mimeType: part.mime, data: part.data } }
  }
  if (protocol === 'anthropic') {
    return part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: part.type === 'image' ? 'image' : 'document',
          source: { type: 'base64', media_type: part.mime, data: part.data },
        }
  }
  if (protocol === 'responses') {
    return part.type === 'text'
      ? { type: role === 'user' ? 'input_text' : 'output_text', text: part.text }
      : part.type === 'image'
        ? { type: 'input_image', image_url: `data:${part.mime};base64,${part.data}` }
        : {
            type: 'input_file',
            filename: part.name,
            file_data: `data:${part.mime};base64,${part.data}`,
          }
  }
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : part.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } }
      : {
          type: 'file',
          file: { filename: part.name, file_data: `data:${part.mime};base64,${part.data}` },
        }
}
export const providerBody = (
  profile: ProviderRequestProfile,
  model: string,
  messages: ProviderMessage[],
  system: string
): Json => {
  const converted = messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => partFor(part, profile.protocol, message.role)),
  }))
  const common = { ...profile.extraBody }
  // The chosen model setting owns the output budget. Sending two aliases can make the request invalid.
  delete common.max_tokens
  delete common.max_completion_tokens
  delete common.max_output_tokens
  delete common.maxOutputTokens
  if (profile.protocol === 'gemini') {
    delete common.temperature
    return {
      ...common,
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: message.content.map((part) => partFor(part, 'gemini', message.role)),
      })),
      generationConfig: {
        ...record(common.generationConfig),
        maxOutputTokens: profile.maxOutputTokens,
        ...(profile.temperature !== null ? { temperature: profile.temperature } : {}),
      },
    }
  }
  if (profile.temperature !== null) {
    common.temperature = profile.temperature
  }
  if (profile.protocol === 'responses') {
    return {
      ...common,
      model,
      instructions: system,
      input: converted,
      max_output_tokens: profile.maxOutputTokens,
      stream: profile.stream,
      store: false,
    }
  }
  if (profile.protocol === 'anthropic') {
    return {
      ...common,
      model,
      system,
      messages: converted,
      max_tokens: profile.maxOutputTokens,
      stream: profile.stream,
    }
  }
  return {
    ...common,
    model,
    messages: [{ role: 'system', content: system }, ...converted],
    [profile.tokenParameter]: profile.maxOutputTokens,
    stream: profile.stream,
    ...(profile.stream && profile.streamUsage
      ? { stream_options: { include_usage: true, ...record(profile.extraBody.stream_options) } }
      : {}),
  }
}

const providerStopReason = (
  value: unknown
): StopReason | 'interrupted' | 'context-limit' | undefined => {
  switch (text(value).toLowerCase()) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'max_tokens'
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool_use'
    case 'refusal':
    case 'content_filter':
    case 'safety':
    case 'blocklist':
    case 'prohibited_content':
    case 'spii':
    case 'recitation':
    case 'image_safety':
    case 'image_prohibited_content':
    case 'image_recitation':
      return 'refusal'
    case 'pause_turn':
      return 'interrupted'
    case 'model_context_window_exceeded':
      return 'context-limit'
    default:
      return undefined
  }
}

const responseEnded = (type: unknown) =>
  type === 'response.completed' ||
  type === 'response.incomplete' ||
  type === 'response.cancelled' ||
  type === 'response.canceled'

export async function* streamProviderMessage(
  input: ProviderProfile,
  model: string,
  messages: ProviderMessage[],
  system: string,
  signal: AbortSignal,
  reasoning?: ReasoningChoice,
  {
    requestId = createId(),
    sessionId,
    search,
    maxOutputTokens,
    managedTools,
    task,
    retryInitialRequest,
  }: RequestContext & {
    search?: SearchTool
    maxOutputTokens?: number
    managedTools?: boolean
    task?: TaskToolset
    retryInitialRequest?: boolean
  } = {}
): AsyncGenerator<MessageStreamEvent> {
  validateProviderModelOutput(input, model)
  const configuration = validateProfile({
    ...input,
    model,
    ...(maxOutputTokens === undefined
      ? {}
      : {
          modelSettings: {
            ...input.modelSettings,
            [model]: { ...modelSettingsFor(input, model), maxOutputTokens },
          },
        }),
  })
  validateProviderModelOutput(configuration, model)
  const profile = { ...configuration, ...providerModelParameters(configuration, model) }
  const body: Json = applyReasoning(
    providerBody(profile, model, messages, system),
    profile.protocol,
    reasoning
  )
  if (profile.protocol === 'openai' && isOfficialMiMoV26(profile.url, model)) {
    if (record(body.thinking).type !== 'disabled') {
      // MiMo's reasoning mode controls sampling at the service.
      delete body.temperature
      delete body.top_p
    } else if (body.temperature !== undefined && (
      typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) ||
      body.temperature < 0 || body.temperature > 1.5
    )) {
      throw new ApiError('protocol', { key: 'providerMiMoTemperatureRange' })
    }
  }
  const context = { requestId, sessionId, operationId: requestId }
  if (managedTools || task) {
    // Agent runs expose the app's allowed tools, not tools inherited from provider options.
    delete body.tools
    delete body.tool_choice
    delete body.tool_config
    delete body.toolConfig
    delete body.functions
    delete body.function_call
  }
  // Keep explicitly configured provider tools intact.
  if (search && (array(body.tools).length || array(body.functions).length)) {
    logEvent(
      'search',
      'tool.unavailable',
      { protocol: profile.protocol, reason: 'provider-tools-configured' },
      'warn'
    )
    search.unavailable()
    search = undefined
  }
  if (!search && !task) {
    const canRetry = retryInitialRequest && !array(body.tools).length && !array(body.functions).length
    yield* streamProviderRound(profile, model, body, signal, context, undefined, false, canRetry)
    return
  }
  if (
    task?.host &&
    (await task.host({
      protocol: profile.protocol,
      url: providerEndpoint(profile, 'chat', model, profile.stream),
      headers: await headersFor(profile, isOpenCodeGoUrl(new URL(profile.url)), true, sessionId),
      body,
    }))
  ) {
    return
  }
  let nextRequestId: string | undefined = context.requestId
  const runRound = (round: Json, collector?: SearchTurnCollector, requestSignal = signal) => {
    const requestId = nextRequestId
    nextRequestId = undefined
    return streamProviderRound(
      profile,
      model,
      round,
      requestSignal,
      { ...context, requestId },
      collector,
      Boolean(task),
      Boolean(!task && requestId && retryInitialRequest)
    )
  }
  if (task) {
    yield* streamWithTaskTools(body, profile.protocol, task, signal, runRound)
  } else if (search) {
    yield* streamWithProviderSearch(body, profile.protocol, search, signal, runRound)
  }
}

/** 各协议统一成现有消息事件，保留停止、用量和错误语义。 */
async function* streamProviderRound(
  profile: ProviderRequestProfile,
  model: string,
  body: Json,
  signal: AbortSignal,
  { requestId = createId(), sessionId, operationId }: RequestContext,
  collector?: SearchTurnCollector,
  showToolInput = false,
  retryInitialRequest = false
): AsyncGenerator<MessageStreamEvent, ReturnType<SearchTurnCollector['finish']>> {
  const url = providerEndpoint(profile, 'chat', model, profile.stream)
  let activeRequestId = requestId
  const { response, dispose } = await fetchProviderResponse(profile, url, body, signal, { requestId, sessionId, operationId })
    .catch(async (error: unknown) => {
      if (!retryInitialRequest || signal.aborted || !(error instanceof ApiError) || !(
        [502, 503, 504].includes(error.status ?? 0) || error.localMessage?.key === 'providerNetworkError'
      )) {
        throw error
      }
      activeRequestId = createId()
      logEvent('api', 'provider.initial-request-retry', {
        requestId, retryRequestId: activeRequestId, operationId, sessionId, ...diagnosticError(error),
      }, 'warn')
      await abortableDelay(650, signal)
      return fetchProviderResponse(profile, url, body, signal, { requestId: activeRequestId, sessionId, operationId })
    })
  let completed = false,
    emitted = false,
    emittedText = false,
    reason: StopReason = 'end_turn',
    usage: MessageUsage | undefined
  const progress = new ChatStreamProgress()
  let receivedToolInput = false
  let stopFailure: ApiError | undefined
  const readUsage = createProviderUsageReader(profile.protocol)
  const rememberUsage = (raw: unknown) => {
    usage = readUsage(raw) ?? usage
  }
  const setReason = (value: unknown) => {
    if (value == null || value === '' || reason === 'refusal') {
      return
    }
    const parsed = providerStopReason(value)
    if (parsed === 'context-limit') {
      stopFailure ??= new ApiError('protocol', { key: 'replyContextTooLong' })
    } else if (parsed === 'interrupted') {
      stopFailure ??= new ApiError('interrupted', { key: 'providerInterrupted' })
    } else if (parsed === undefined) {
      stopFailure ??= new ApiError('interrupted', { key: 'providerUnknownStopReason' })
    } else {
      reason = parsed
    }
  }
  let nextBlock = 0
  let activeBlock: { index: number; thinking: boolean } | undefined
  const closeBlock = function* (): Generator<MessageStreamEvent> {
    if (activeBlock) {
      const { index } = activeBlock
      activeBlock = undefined
      yield { type: 'content_block_stop', index }
    }
  }
  const toolInput = function* (): Generator<MessageStreamEvent> {
    progress.advance()
    receivedToolInput = true
    yield* closeBlock()
    if (showToolInput) {
      yield { type: 'agent_tool_input' }
    }
  }
  const delta = function* (value: unknown, thinking = false): Generator<MessageStreamEvent> {
    if (typeof value !== 'string' || !value) {
      return
    }
    progress.advance()
    emitted = true
    if (!thinking) {
      emittedText = true
    }
    if (!activeBlock || activeBlock.thinking !== thinking) {
      yield* closeBlock()
      activeBlock = { index: nextBlock++, thinking }
      yield {
        type: 'content_block_start',
        index: activeBlock.index,
        content_block: thinking
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' },
      }
    }
    yield {
      type: 'content_block_delta',
      index: activeBlock.index,
      delta: thinking
        ? { type: 'thinking_delta', thinking: value }
        : { type: 'text_delta', text: value },
    }
  }
  const consume = function* (data: Json): Generator<MessageStreamEvent> {
    if (data.error || data.type === 'error' || data.type === 'response.failed') {
      if (data.type === 'response.failed') {
        rememberUsage(record(data.response).usage)
      }
      throw new ApiError('stream', remoteLimit(data) ?? { key: 'providerRemoteError' })
    }
    collector?.read(data)
    if (profile.protocol === 'openai') {
      const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined),
        content = record(choice.delta || choice.message)
      if (text(content.refusal)) {
        reason = 'refusal'
      }
      yield* delta(content.reasoning_content || content.reasoning, true)
      if (Array.isArray(content.content)) {
        for (const part of content.content) {
          const item = record(part)
          if (item.type === 'refusal') {
            reason = 'refusal'
          } else {
            yield* delta(item.text)
          }
        }
      } else {
        yield* delta(content.content)
      }
      if (array(content.tool_calls).length && reason !== 'refusal') {
        reason = 'tool_use'
        yield* toolInput()
      }
      if (choice.finish_reason) {
        setReason(choice.finish_reason)
        completed = true
      }
      rememberUsage(data.usage)
    } else if (profile.protocol === 'responses') {
      if (
        data.type === 'response.function_call_arguments.delta' ||
        (data.type === 'response.output_item.added' && record(data.item).type === 'function_call')
      ) {
        yield* toolInput()
      }
      if (data.type === 'response.output_text.delta') {
        yield* delta(data.delta)
      }
      if (data.type === 'response.refusal.delta' || data.type === 'response.refusal.done') {
        reason = 'refusal'
      }
      if (
        data.type === 'response.reasoning_summary_text.delta' ||
        data.type === 'response.reasoning_text.delta'
      ) {
        yield* delta(data.delta, true)
      }
      const result = data.response ? record(data.response) : data
      if (responseEnded(data.type) || (!data.type && Array.isArray(data.output))) {
        const includeText = !emittedText
        if (Array.isArray(result.output)) {
          for (const value of result.output) {
            const item = record(value)
            if (item.type && item.type !== 'message') {
              continue
            }
            for (const value of array(item.content)) {
              const part = record(value)
              if (part.type === 'refusal' || text(part.refusal)) {
                reason = 'refusal'
              } else if (includeText) {
                yield* delta(part.text)
              }
            }
          }
        }
        rememberUsage(result.usage)
        if (result.status === 'failed' || result.error) {
          throw new ApiError('stream', remoteLimit(result) ?? { key: 'providerRemoteError' })
        }
        setReason(record(result.incomplete_details).reason)
        const status = text(result.status)
        const incomplete = status === 'incomplete' || data.type === 'response.incomplete'
        if (
          (status && status !== 'completed' && status !== 'incomplete') ||
          data.type === 'response.cancelled' ||
          data.type === 'response.canceled' ||
          (incomplete && reason !== 'max_tokens' && reason !== 'refusal')
        ) {
          stopFailure ??= new ApiError('interrupted', { key: 'providerInterrupted' })
        }
        completed = true
      }
    } else if (profile.protocol === 'gemini') {
      const candidate = record(Array.isArray(data.candidates) ? data.candidates[0] : undefined)
      if (record(data.promptFeedback).blockReason) {
        reason = 'refusal'
        completed = true
      }
      const parts = record(candidate.content).parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const value = record(part)
          if (value.functionCall) {
            yield* toolInput()
          } else {
            yield* delta(value.text, value.thought === true)
          }
        }
      }
      if (candidate.finishReason) {
        completed = true
        setReason(candidate.finishReason)
      }
      rememberUsage(data.usageMetadata)
    } else {
      if (data.type === 'message_start') {
        rememberUsage(record(data.message).usage)
      }
      if (data.type === 'content_block_start') {
        const block = record(data.content_block)
        if (block.type === 'text') {
          yield* delta(block.text)
        } else if (block.type === 'thinking') {
          yield* delta(block.thinking, true)
        } else if (block.type === 'tool_use') {
          if (reason !== 'refusal') {
            reason = 'tool_use'
          }
          yield* toolInput()
        }
      }
      if (data.type === 'content_block_delta') {
        const change = record(data.delta)
        if (change.type === 'text_delta') {
          yield* delta(change.text)
        }
        if (change.type === 'thinking_delta') {
          yield* delta(change.thinking, true)
        }
        if (change.type === 'input_json_delta' && reason === 'tool_use') {
          yield* toolInput()
        }
      }
      if (data.type === 'content_block_stop') {
        yield* closeBlock()
      }
      if (data.type === 'message_delta') {
        const stop = text(record(data.delta).stop_reason)
        setReason(stop)
        rememberUsage(data.usage)
        if (stop && !receivedToolInput && reason !== 'tool_use') {
          completed = true
        }
      }
      if (data.type === 'message_stop') {
        completed = true
      }
      if (data.type === 'message' && Array.isArray(data.content)) {
        for (const part of data.content) {
          const block = record(part)
          yield* delta(block.text || block.thinking, block.type === 'thinking')
        }
        setReason(data.stop_reason)
        rememberUsage(data.usage)
        completed = true
      }
    }
    if (completed && !receivedToolInput && reason !== 'tool_use') {
      progress.finish()
    }
  }
  try {
    yield { type: 'message_start', message: { id: createId(), model } }
    if (response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
      if (!response.body) {
        throw new ApiError('protocol', { key: 'providerInvalidResponse' })
      }
      // For native responses, the Android socket owns the idle timeout while WebView is suspended.
      const idleMs = isAndroidProviderResponse(response) ? null : undefined
      for await (const event of readServerSentEvents(
        response.body,
        signal,
        idleMs,
        undefined,
        progress
      )) {
        if (event.data.trim() === '[DONE]') {
          completed = true
          break
        }
        let data: Json
        try {
          data = record(JSON.parse(event.data))
        } catch {
          throw new ApiError('protocol', { key: 'providerInvalidResponse' })
        }
        yield* consume(data)
        if (data.type === 'message_stop' || responseEnded(data.type)) {
          break
        }
      }
    } else {
      yield* consume(await readApiJson(response, signal))
    }
    signal.throwIfAborted()
    const finalReason = reason as StopReason
    if (stopFailure && finalReason !== 'refusal') {
      throw stopFailure
    }
    if (!completed && finalReason !== 'refusal') {
      throw new ApiError('interrupted', { key: 'providerInterrupted' })
    }
    const turn =
      finalReason === 'max_tokens' || finalReason === 'refusal' ? undefined : collector?.finish()
    if (finalReason === 'tool_use' && !turn) {
      throw new ApiError('protocol', { key: 'providerToolUnsupported' })
    }
    if (!emitted && !turn && finalReason !== 'max_tokens' && finalReason !== 'refusal') {
      throw new ApiError('protocol', { key: 'providerInvalidResponse' })
    }
    yield* closeBlock()
    yield {
      type: 'message_delta',
      delta: { stop_reason: turn ? 'tool_use' : reason, stop_sequence: null },
      ...(usage ? { usage } : {}),
    }
    if (turn) {
      return turn
    }
    yield { type: 'message_stop' }
    return undefined
  } catch (error) {
    if (usage) {
      yield { type: 'message_usage', usage }
    }
    if ((reason as StopReason) === 'refusal') {
      signal.throwIfAborted()
      throw new ApiError('protocol', { key: 'replyRefused' })
    }
    if (error instanceof StreamReadError) {
      const nativeError = error.cause instanceof ApiError ? error.cause : undefined
      logEvent(
        'api',
        'response.body.failed',
        { requestId: activeRequestId, operationId, receivedBytes: error.receivedBytes, localKey: nativeError?.localMessage?.key },
        'warn'
      )
      throw nativeError ?? new ApiError('network', { key: 'streamConnectionLost' })
    }
    if (error instanceof StreamIdleTimeoutError) {
      const stalled = error.waitingFor === 'progress'
      logEvent(
        'api',
        stalled ? 'response.progress.timeout' : 'response.body.timeout',
        { requestId: activeRequestId, operationId, receivedBytes: error.receivedBytes, reason: 'timeout' },
        'warn'
      )
      throw new ApiError('network', { key: stalled ? 'streamProgressTimeout' : 'streamIdleTimeout' })
    }
    throw error
  } finally {
    dispose()
    void response.body?.cancel().catch(() => {})
  }
}
export const testProviderModel = async (
  profile: ProviderProfile,
  signal: AbortSignal
): Promise<{ text: string; elapsedMs: number }> => {
  const started = performance.now()
  const requestId = createId()
  const finish = beginDiagnosticOperation('api', 'provider.test', {
    requestId,
    protocol: profile.protocol,
  })
  try {
    const configuration = validateProfile(profile)
    const capability = customReasoning(configuration, configuration.model)
    const ceiling = providerOutputBudget(configuration, configuration.model)
    const budgets = new Set([Math.min(ceiling, 1024), Math.min(ceiling, 4096)])
    for (const budget of budgets) {
      let result = ''
      let reason: StopReason | null | undefined
      for await (const event of streamProviderMessage(
        configuration,
        configuration.model,
        [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
        'This is a connection test. Reply briefly.',
        signal,
        capability && { adapter: capability.adapter, level: capability.defaultLevel },
        { requestId, maxOutputTokens: budget }
      )) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          result += event.delta.text
        } else if (event.type === 'message_delta') {
          reason = event.delta.stop_reason
        }
      }
      if (reason === 'max_tokens') {
        continue
      }
      if (reason === 'refusal') {
        throw new ApiError('protocol', { key: 'replyRefused' })
      }
      if (reason === 'end_turn' && result.trim()) {
        finish('completed')
        return { text: result.slice(0, 200), elapsedMs: Math.round(performance.now() - started) }
      }
      throw new ApiError('protocol', { key: 'providerInvalidResponse' })
    }
    throw new ApiError('protocol', { key: 'providerTestOutputExhausted' })
  } catch (error) {
    finish(signal.aborted ? 'cancelled' : 'failed', diagnosticError(error))
    throw error
  }
}

/** Verify the configured model without exposing conversation data. */
export const testProviderTools = async (profile: ProviderProfile, signal: AbortSignal) => {
  const configuration = validateProfile(profile)
  const capability = customReasoning(configuration, configuration.model)
  return verifyAgentTools(
    configuration,
    (task) =>
      streamProviderMessage(
        configuration,
        configuration.model,
        [{ role: 'user', content: [{ type: 'text', text: agentProbePrompt }] }],
        agentProbeSystem,
        signal,
        capability && { adapter: capability.adapter, level: capability.defaultLevel },
        {
          task,
          maxOutputTokens: Math.min(providerOutputBudget(configuration, configuration.model), 1024),
        }
      ),
    signal
  )
}
