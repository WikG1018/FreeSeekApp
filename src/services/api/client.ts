import { createId } from '../../utils/id.js'
import { ApiError } from './errorTypes.js'
import { postMultipart, type UploadProgress } from './multipart.js'
import { diagnosticError, logEvent, registerLogSecret } from '../diagnostics/log.js'
export { ApiError } from './errorTypes.js'
export type { ApiErrorKind } from './errorTypes.js'
import { readMessageEvent } from './parseEvent.js'
import { describeKnownApiError } from './knownErrors.js'
import { StreamIdleTimeoutError, StreamReadError, readServerSentEvents } from './sse.js'
import {
  streamWithProviderSearch,
  type SearchTool,
  type SearchTurnCollector,
} from './searchTool.js'
import {
  supportsOfficialChatExtensions,
  type ApiErrorBody,
  type CreateMessageRequest,
  type FileObject,
  type FilePurpose,
  type MessageParam,
  type MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  let text = ''
  const reader = response.body?.getReader()
  if (reader) {
    const timeout =
      (globalThis as { __FS_RESPONSE_BODY_MS__?: number }).__FS_RESPONSE_BODY_MS__ ?? 120_000
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
    }, timeout)
    try {
      const decoder = new TextDecoder()
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        size += value.length
        if (size > 2 * 1024 * 1024) {
          break
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch {
      /* 仍按 HTTP 状态给出可恢复的本地提示。 */
    } finally {
      clearTimeout(timer)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  let message = text || fallback
  let code = ''
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      const kind = body.error.code ?? body.error.type
      code = typeof kind === 'string' ? kind : ''
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  // 原文保留在 error.message 里供匹配，界面展示用本地文案
  return new ApiError(kind, message, response.status, describeKnownApiError(message, code))
}

export const request = async (
  url: string,
  init: RequestInit,
  requestId = createId()
): Promise<Response> => {
  const started = performance.now()
  const headers = new Headers(init.headers)
  registerLogSecret(headers.get('x-api-key'))
  registerLogSecret(headers.get('Authorization')?.replace(/^Bearer\s+/i, ''))
  let route = 'unknown'
  try {
    route = new URL(url).pathname.replace(/(\/files\/)\S+/, '$1:fileId')
  } catch {
    /* 不记录无效 URL 原文。 */
  }
  logEvent('api', 'request.started', {
    requestId,
    method: init.method ?? 'GET',
    route,
    bodyBytes: typeof init.body === 'string' ? new Blob([init.body]).size : undefined,
  })
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(init.signal?.reason)
  if (init.signal?.aborted) {
    forwardAbort()
  } else {
    init.signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  const timeoutMs =
    (globalThis as { __FS_REQUEST_HEADERS_MS__?: number }).__FS_REQUEST_HEADERS_MS__ ?? 120_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    logEvent(
      'api',
      'request.failed',
      {
        requestId,
        route,
        elapsedMs: Math.round(performance.now() - started),
        timedOut,
        ...diagnosticError(error),
      },
      'error'
    )
    init.signal?.removeEventListener('abort', forwardAbort)
    if (init.signal?.aborted) {
      throw error
    }
    if (timedOut) {
      throw new ApiError('network', 'Response headers timeout', undefined, {
        key: 'streamIdleTimeout',
      })
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
  // 成功响应保留信号关联，上传/语音读取响应体期间仍可取消；一次性信号随请求回收。
  if (!response.ok) {
    const error = await readErrorResponse(response)
    const serverId = response.headers.get('x-ds-request-id')
    logEvent(
      'api',
      'http.failed',
      {
        requestId,
        route,
        ...(serverId && /^[\da-f-]{36}$/i.test(serverId) ? { serverId } : {}),
        ...diagnosticError(error),
      },
      'error'
    )
    throw error
  }
  logEvent('api', 'response.headers', {
    requestId,
    route,
    status: response.status,
    elapsedMs: Math.round(performance.now() - started),
    upstreamRequestId: response.headers.get('x-ds-request-id'),
  })
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const response = await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  void response.body?.cancel().catch(() => {})
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal,
  onProgress?: (progress: UploadProgress) => void
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const result = await postMultipart(`${ANTHROPIC_BASE_URL}/files`, {
    operation: 'upload',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
    onProgress,
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('id' in result) ||
    typeof result.id !== 'string' ||
    !result.id.trim() ||
    result.id.length > 512
  ) {
    logEvent('upload', 'response.invalid', { reason: 'missing-file-id' }, 'error')
    throw new ApiError('protocol', { key: 'uploadResponseInvalid' })
  }
  return result as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/** Enforce the model's limits at the wire boundary, including requests reconstructed from history. */
const officialRequestForModel = (body: CreateMessageRequest): CreateMessageRequest => {
  if (supportsOfficialChatExtensions(body.model)) {
    return body
  }
  const request = {
    ...body,
    messages: body.messages.flatMap((message): MessageParam[] => {
      if (message.role === 'latest_reminder') {
        return []
      }
      if (message.role !== 'assistant') {
        return [message]
      }
      const content = message.content.filter(
        (block) => block.type === 'text' || block.type === 'thinking'
      )
      return content.length ? [{ ...message, content }] : []
    }),
  }
  delete request.tools
  delete request.title
  return request
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  requestId = createId(),
  search?: SearchTool
): AsyncGenerator<MessageStreamEvent> {
  const payload = officialRequestForModel(body)
  const includeFiles = hasFile(payload)
  if (!search || payload.model !== 'deepseek-v4-pro') {
    yield* streamMessageRound(apiKey, payload, signal, requestId, includeFiles)
    return
  }
  // Pro uses client tools on the Messages API with the sanitized request and safety check.
  let nextRequestId: string | undefined = requestId
  yield* streamWithProviderSearch(payload, 'anthropic', search, signal, (round, collector) => {
    const id = nextRequestId ?? createId()
    nextRequestId = undefined
    return streamMessageRound(apiKey, round, signal, id, includeFiles, {
      collector,
      answerOnly: !collector,
    })
  })
}

async function* streamMessageRound(
  apiKey: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  requestId: string,
  includeFiles: boolean,
  { collector, answerOnly }: { collector?: SearchTurnCollector; answerOnly?: boolean } = {}
): AsyncGenerator<MessageStreamEvent, ReturnType<SearchTurnCollector['finish']>> {
  const response = await request(
    `${ANTHROPIC_BASE_URL}/messages`,
    {
      method: 'POST',
      headers: {
        ...anthropicHeaders(apiKey, includeFiles),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    },
    requestId
  )
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  try {
    let toolRequested = false
    for await (const { event: eventName, data } of readServerSentEvents(
      response.body,
      signal,
      (globalThis as { __FS_STREAM_IDLE_MS__?: number }).__FS_STREAM_IDLE_MS__
    )) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError(
          'stream',
          payload.error.message,
          undefined,
          describeKnownApiError(
            payload.error.message,
            typeof payload.error.code === 'string' ? payload.error.code : payload.error.type
          )
        )
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data, undefined, describeKnownApiError(data))
      }
      if (collector && payload && typeof payload === 'object') {
        collector.read(payload as Record<string, unknown>)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      if (event.type === 'message_delta') {
        toolRequested = event.delta.stop_reason === 'tool_use'
      } else if (event.type === 'message_stop' && toolRequested && (collector || answerOnly)) {
        const turn = collector?.finish()
        if (!turn) {
          throw new ApiError('protocol', { key: 'providerToolUnsupported' })
        }
        return turn
      }
      yield event
      if (event.type === 'message_stop') {
        return undefined
      }
    }
  } catch (error) {
    if (error instanceof StreamReadError) {
      logEvent(
        'api',
        'response.body.failed',
        { requestId, receivedBytes: error.receivedBytes },
        'warn'
      )
      throw new ApiError('network', { key: 'streamConnectionLost' })
    }
    if (error instanceof StreamIdleTimeoutError) {
      // 连接静默挂起：按网络问题归类（可重试），给本地文案
      throw new ApiError('network', 'Stream idle timeout', undefined, {
        key: 'streamIdleTimeout',
      })
    }
    throw error
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
