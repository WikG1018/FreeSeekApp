import { describeKnownApiError } from './knownErrors.js'
import { ApiError } from './errorTypes.js'
import { readServerSentEvents } from './sse.js'
import { providerFetch } from './providerTransport.js'
import { providerOutputBudget, validateProfile, type ProviderProfile } from '../providers.js'
import { applyReasoning, customReasoning, type ReasoningChoice } from '../reasoning.js'
import type { ProviderMessage, ProviderPart } from './providerContent.js'
import type { MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { logEvent, diagnosticError, registerLogSecret } from '../diagnostics/log.js'
import { createId } from '../../utils/id.js'

type Json = Record<string, unknown>
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const endpoint = (
  profile: ProviderProfile,
  operation: 'models' | 'chat',
  model: string,
  streaming = true
) => {
  if (operation === 'models' && profile.modelListUrl) {
    return profile.modelListUrl
  }
  const url = new URL(profile.url)
  let path = url.pathname.replace(/\/+$/, '')
  path = path
    .replace(/\/(chat\/completions|responses|messages)$/, '')
    .replace(/\/models\/[^/]+:(streamGenerateContent|generateContent)$/, '')
  if (!path) {
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
const headersFor = (profile: ProviderProfile): Record<string, string> => {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  })
  if (profile.apiKey) {
    headers.set(
      profile.protocol === 'anthropic'
        ? 'x-api-key'
        : profile.protocol === 'gemini'
          ? 'x-goog-api-key'
          : 'Authorization',
      ['anthropic', 'gemini'].includes(profile.protocol)
        ? profile.apiKey
        : `Bearer ${profile.apiKey}`
    )
  }
  if (profile.protocol === 'anthropic') {
    headers.set('anthropic-version', '2023-06-01')
  }
  for (const [key, value] of Object.entries(profile.headers)) {
    headers.set(key, value)
    registerLogSecret(value)
  }
  registerLogSecret(profile.apiKey)
  return Object.fromEntries(headers.entries())
}
const remoteLimit = (data: Json) => {
  const detail = record(data.error ?? record(data.response).error ?? data)
  return describeKnownApiError(text(detail.message), text(detail.code || detail.type))
}
export const readApiJson = async (
  response: Response,
  signal: AbortSignal,
  limit = 8 * 1024 * 1024
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
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, 60000)
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.length
      if (size > limit) {
        throw new ApiError('protocol', { key: 'providerResponseTooLarge' })
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
    signal.removeEventListener('abort', abort)
    abort()
    reader.releaseLock()
  }
}
const fetchResponse = async (
  profile: ProviderProfile,
  url: string,
  body: unknown | undefined,
  signal: AbortSignal
) => {
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  if (serialized && new Blob([serialized]).size > 32 * 1024 * 1024) {
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
    protocol: profile.protocol,
    operation: body === undefined ? 'models' : 'chat',
  })
  try {
    const response = await providerFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headersFor(profile),
      body: serialized,
      signal: controller.signal,
    })
    if (!response.ok) {
      const known =
        response.status === 400 || response.status === 413 || response.status === 422
          ? remoteLimit(await readApiJson(response, controller.signal, 32768).catch(() => ({})))
          : undefined
      void response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
      throw new ApiError(
        'http',
        known ?? { key: 'providerHttpError', params: { status: response.status } },
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
    logEvent('api', 'provider.failed', diagnosticError(error), 'error')
    if (signal.aborted) {
      signal.throwIfAborted()
    }
    if (error instanceof ApiError) {
      throw error
    }
    throw new ApiError('network', { key: timedOut ? 'streamIdleTimeout' : 'providerNetworkError' })
  } finally {
    clearTimeout(timer)
  }
}
export type ProviderCatalogModel = { id: string; contextWindow?: number }
export const fetchProviderCatalog = async (
  input: ProviderProfile,
  signal: AbortSignal
): Promise<ProviderCatalogModel[]> => {
  const profile = validateProfile(input, false),
    models = new Map<string, ProviderCatalogModel>()
  let next: string | undefined
  for (let page = 0; page < 10; page++) {
    const url = new URL(endpoint(profile, 'models', ''))
    if (next) {
      url.searchParams.set(profile.protocol === 'gemini' ? 'pageToken' : 'after_id', next)
    }
    const { response, dispose } = await fetchResponse(profile, url.toString(), undefined, signal)
    try {
      const data = await readApiJson(response, signal)
      const items = profile.protocol === 'gemini' ? data.models : data.data
      if (!Array.isArray(items)) {
        throw new ApiError('protocol', { key: 'providerInvalidResponse' })
      }
      for (const item of items) {
        const value = record(item)
        if (
          profile.protocol === 'gemini' &&
          Array.isArray(value.supportedGenerationMethods) &&
          !value.supportedGenerationMethods.includes('generateContent')
        ) {
          continue
        }
        const id = text(value.id || value.name).replace(
          profile.protocol === 'gemini' ? /^models\// : /$^/,
          ''
        )
        if (id && id.length <= 200 && !Array.from(id).some((char) => char.charCodeAt(0) < 32)) {
          const advertised = value.context_length ?? value.context_window ?? value.inputTokenLimit
          const contextWindow =
            typeof advertised === 'number' &&
            Number.isSafeInteger(advertised) &&
            advertised >= 512 &&
            advertised <= 10000000
              ? advertised
              : undefined
          models.set(id, { id, contextWindow })
        }
      }
      const token =
        profile.protocol === 'gemini'
          ? text(data.nextPageToken)
          : profile.protocol === 'anthropic' && data.has_more
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
  profile: ProviderProfile,
  model: string,
  messages: ProviderMessage[],
  system: string
): Json => {
  const converted = messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => partFor(part, profile.protocol, message.role)),
  }))
  const common = {
    ...profile.extraBody,
    ...(profile.temperature !== null ? { temperature: profile.temperature } : {}),
  }
  if (profile.protocol === 'gemini') {
    return {
      ...profile.extraBody,
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: message.content.map((part) => partFor(part, 'gemini', message.role)),
      })),
      generationConfig: {
        ...record(profile.extraBody.generationConfig),
        maxOutputTokens: profile.maxOutputTokens,
        ...(profile.temperature !== null ? { temperature: profile.temperature } : {}),
      },
    }
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

const usageFor = (raw: unknown, protocol: ProviderProfile['protocol']): MessageUsage => {
  const u = record(raw)
  if (protocol === 'anthropic') {
    return {
      input_tokens: count(u.input_tokens),
      cache_creation_input_tokens: count(u.cache_creation_input_tokens),
      cache_read_input_tokens: count(u.cache_read_input_tokens),
      output_tokens: count(u.output_tokens),
    }
  }
  const cached = count(
    protocol === 'gemini'
      ? u.cachedContentTokenCount
      : record(u.prompt_tokens_details || u.input_tokens_details).cached_tokens
  )
  const input = count(
    protocol === 'gemini' ? u.promptTokenCount : (u.prompt_tokens ?? u.input_tokens)
  )
  return {
    input_tokens: Math.max(0, input - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: count(
      protocol === 'gemini'
        ? count(u.candidatesTokenCount) + count(u.thoughtsTokenCount)
        : (u.completion_tokens ?? u.output_tokens)
    ),
  }
}
const stopReason = (value: unknown): StopReason =>
  /length|max_tokens|MAX_TOKENS|max_output_tokens/.test(text(value))
    ? 'max_tokens'
    : /tool_calls|tool_use/.test(text(value))
      ? 'tool_use'
      : 'end_turn'

/** 各协议统一成现有消息事件，保留停止、用量和错误语义。 */
export async function* streamProviderMessage(
  input: ProviderProfile,
  model: string,
  messages: ProviderMessage[],
  system: string,
  signal: AbortSignal,
  reasoning?: ReasoningChoice
): AsyncGenerator<MessageStreamEvent> {
  const profile = validateProfile({ ...input, model })
  const { response, dispose } = await fetchResponse(
    profile,
    endpoint(profile, 'chat', model, profile.stream),
    applyReasoning(providerBody(profile, model, messages, system), profile.protocol, reasoning),
    signal
  )
  let completed = false,
    emitted = false,
    reason: StopReason = 'end_turn',
    usage: MessageUsage | undefined
  const opened = new Set<number>()
  const delta = function* (value: unknown, thinking = false): Generator<MessageStreamEvent> {
    if (typeof value !== 'string' || !value) {
      return
    }
    emitted = true
    const index = thinking ? 1 : 0
    if (!opened.has(index)) {
      opened.add(index)
      yield {
        type: 'content_block_start',
        index,
        content_block: thinking
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' },
      }
    }
    yield {
      type: 'content_block_delta',
      index,
      delta: thinking
        ? { type: 'thinking_delta', thinking: value }
        : { type: 'text_delta', text: value },
    }
  }
  const consume = function* (data: Json): Generator<MessageStreamEvent> {
    if (data.error || data.type === 'error' || data.type === 'response.failed') {
      throw new ApiError('stream', remoteLimit(data) ?? { key: 'providerRemoteError' })
    }
    if (profile.protocol === 'openai') {
      const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined),
        content = record(choice.delta || choice.message)
      yield* delta(content.reasoning_content || content.reasoning, true)
      if (Array.isArray(content.content)) {
        for (const part of content.content) {
          yield* delta(record(part).text)
        }
      } else {
        yield* delta(content.content || content.refusal)
      }
      if (array(content.tool_calls).length) {
        reason = 'tool_use'
      }
      if (choice.finish_reason) {
        reason = stopReason(choice.finish_reason)
        completed = true
      }
      if (data.usage) {
        usage = usageFor(data.usage, profile.protocol)
      }
    } else if (profile.protocol === 'responses') {
      if (data.type === 'response.output_text.delta' || data.type === 'response.refusal.delta') {
        yield* delta(data.delta)
      }
      if (
        data.type === 'response.reasoning_summary_text.delta' ||
        data.type === 'response.reasoning_text.delta'
      ) {
        yield* delta(data.delta, true)
      }
      const result = data.response ? record(data.response) : data
      if (
        data.type === 'response.completed' ||
        data.type === 'response.incomplete' ||
        (!data.type && Array.isArray(data.output))
      ) {
        if (!emitted && Array.isArray(result.output)) {
          for (const item of result.output) {
            for (const part of array(record(item).content)) {
              yield* delta(record(part).text || record(part).refusal)
            }
          }
        }
        if (result.status === 'failed' || result.error) {
          throw new ApiError('stream', remoteLimit(result) ?? { key: 'providerRemoteError' })
        }
        completed = true
        reason = stopReason(record(result.incomplete_details).reason)
        if (result.usage) {
          usage = usageFor(result.usage, profile.protocol)
        }
      }
    } else if (profile.protocol === 'gemini') {
      const candidate = record(Array.isArray(data.candidates) ? data.candidates[0] : undefined)
      if (record(data.promptFeedback).blockReason) {
        throw new ApiError('stream', { key: 'providerRemoteError' })
      }
      const parts = record(candidate.content).parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          yield* delta(record(part).text, record(part).thought === true)
        }
      }
      if (candidate.finishReason) {
        completed = true
        reason = stopReason(candidate.finishReason)
      }
      if (data.usageMetadata) {
        usage = usageFor(data.usageMetadata, profile.protocol)
      }
    } else {
      if (data.type === 'message_start') {
        usage = usageFor(record(data.message).usage, profile.protocol)
      }
      if (data.type === 'content_block_start') {
        const block = record(data.content_block)
        if (block.type === 'text') {
          yield* delta(block.text)
        } else if (block.type === 'thinking') {
          yield* delta(block.thinking, true)
        } else if (block.type === 'tool_use') {
          reason = 'tool_use'
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
      }
      if (data.type === 'message_delta') {
        reason = stopReason(record(data.delta).stop_reason)
        if (data.usage) {
          usage = usageFor({ ...usage, ...record(data.usage) }, profile.protocol)
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
        reason = stopReason(data.stop_reason)
        usage = data.usage ? usageFor(data.usage, profile.protocol) : undefined
        completed = true
      }
    }
  }
  try {
    yield { type: 'message_start', message: { id: createId(), model } }
    if (response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
      if (!response.body) {
        throw new ApiError('protocol', { key: 'providerInvalidResponse' })
      }
      for await (const event of readServerSentEvents(response.body, signal)) {
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
        if (
          data.type === 'message_stop' ||
          data.type === 'response.completed' ||
          data.type === 'response.incomplete'
        ) {
          break
        }
      }
    } else {
      yield* consume(await readApiJson(response, signal))
    }
    signal.throwIfAborted()
    if (!completed) {
      throw new ApiError('interrupted', { key: 'providerInterrupted' })
    }
    if ((reason as StopReason) === 'tool_use') {
      throw new ApiError('protocol', { key: 'providerToolUnsupported' })
    }
    if (!emitted) {
      throw new ApiError('protocol', { key: 'providerInvalidResponse' })
    }
    for (const index of opened) {
      yield { type: 'content_block_stop', index }
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      ...(usage ? { usage } : {}),
    }
    yield { type: 'message_stop' }
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
  const capability = customReasoning(validateProfile(profile), profile.model)
  let result = ''
  for await (const event of streamProviderMessage(
    { ...profile, maxOutputTokens: Math.min(providerOutputBudget(profile, profile.model), 1024) },
    profile.model,
    [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
    'This is a connection test. Reply briefly.',
    signal,
    capability && { adapter: capability.adapter, level: capability.defaultLevel }
  )) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      result += event.delta.text
    }
  }
  if (!result.trim()) {
    throw new ApiError('protocol', { key: 'providerInvalidResponse' })
  }
  return { text: result.slice(0, 200), elapsedMs: Math.round(performance.now() - started) }
}
