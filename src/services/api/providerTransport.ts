import { Capacitor, registerPlugin } from '@capacitor/core'
import { createId } from '../../utils/id.js'
import { abortReason } from '../../utils/abort.js'
import { fetchApiRequest } from './windowsTransport.js'
import { ApiError } from './errorTypes.js'

const Native = registerPlugin<{
  start(options: {
    id: string
    requestId?: string
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<{ status: number; contentType: string; mcpSessionId?: string }>
  read(options: { id: string }): Promise<{ data: string } | { done: true }>
  cancel(options: { id: string }): Promise<void>
  requestLocalNetwork(): Promise<{ granted: boolean }>
}>('CustomHttp')

const androidResponses = new WeakSet<Response>()
export const isAndroidProviderResponse = (response: Response) => androidResponses.has(response)

const nativeBodyFailure = (error: unknown) => {
  switch ((error as { code?: unknown } | undefined)?.code) {
    case 'TIMEOUT': return new ApiError('network', { key: 'streamIdleTimeout' })
    case 'BUFFER_ERROR': return new ApiError('network', { key: 'providerResponseBufferFailed' })
    case 'RESPONSE_TOO_LARGE': return new ApiError('protocol', { key: 'providerResponseTooLarge' })
    default: return new ApiError('network', { key: 'streamConnectionLost' })
  }
}

/** Android keeps receiving in native code and WebView pulls the bytes when it can run. */
export const providerFetch = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
  requestId?: string,
  allowPermission = true
): Promise<Response> => {
  init.signal.throwIfAborted()
  if (Capacitor.getPlatform() !== 'android') {
    return fetchApiRequest(url, { ...init, redirect: 'error', credentials: 'omit' })
  }
  const id = createId()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let ended = false
  const clean = () => {
    ended = true
    init.signal.removeEventListener('abort', onAbort)
  }
  const finish = (error?: unknown) => {
    if (ended) {
      return
    }
    clean()
    if (error) {
      controller.error(error)
    } else {
      controller.close()
    }
  }
  const cancel = () => {
    clean()
    return Native.cancel({ id }).catch(() => {})
  }
  const onAbort = () => {
    finish(abortReason(init.signal))
    void cancel()
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    async pull() {
      try {
        const part = await Native.read({ id })
        if (ended) {
          return
        }
        if ('done' in part) {
          finish()
          return
        }
        const binary = atob(part.data)
        controller.enqueue(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
      } catch (error) {
        if (!ended) {
          finish(init.signal.aborted ? abortReason(init.signal) : nativeBodyFailure(error))
          void cancel()
        }
      }
    },
    cancel,
  }, { highWaterMark: 0 })
  init.signal.addEventListener('abort', onAbort, { once: true })
  try {
    init.signal.throwIfAborted()
    const response = await Native.start({
      id,
      requestId,
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
    init.signal.throwIfAborted()
    const noBody = [101, 204, 205, 304].includes(response.status)
    const result = new Response(noBody ? null : body, {
      status: response.status,
      headers: {
        'Content-Type': response.contentType,
        ...(response.mcpSessionId && { 'Mcp-Session-Id': response.mcpSessionId }),
      },
    })
    if (noBody) {
      void cancel()
    }
    androidResponses.add(result)
    return result
  } catch (error) {
    void cancel()
    if (
      !init.signal.aborted &&
      allowPermission &&
      (error as { code?: string })?.code === 'LOCAL_NETWORK_PERMISSION'
    ) {
      const result = await Native.requestLocalNetwork()
      if (result.granted) {
        return providerFetch(url, init, requestId, false)
      }
    }
    throw init.signal.aborted ? abortReason(init.signal) : error
  }
}
