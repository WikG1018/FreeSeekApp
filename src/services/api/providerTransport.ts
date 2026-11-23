import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { createId } from '../../utils/id.js'
import { abortReason } from '../../utils/abort.js'
import { fetchApiRequest } from './windowsTransport.js'

type TransferEvent = { id: string; type: 'chunk' | 'end' | 'error'; data?: string }
const Native = registerPlugin<{
  start(options: {
    id: string
    requestId?: string
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<{ status: number; contentType: string; mcpSessionId?: string }>
  ack(options: { id: string }): Promise<void>
  cancel(options: { id: string }): Promise<void>
  requestLocalNetwork(): Promise<{ granted: boolean }>
  addListener(
    event: 'transfer',
    listener: (event: TransferEvent) => void
  ): Promise<PluginListenerHandle>
}>('CustomHttp')

/** 原生分片有确认窗口，JS 暂停时不会无限积压通知；网页仍遵循浏览器 CORS。 */
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
  let controller: ReadableStreamDefaultController<Uint8Array>,
    listener: PluginListenerHandle | undefined
  let ended = false
  const clean = () => {
    init.signal.removeEventListener('abort', onAbort)
    void listener?.remove()
  }
  const finish = (error?: unknown) => {
    if (ended) {
      return
    }
    ended = true
    if (error) {
      controller.error(error)
    } else {
      controller.close()
    }
    clean()
  }
  const onAbort = () => {
    void Native.cancel({ id }).catch(() => {})
    finish(abortReason(init.signal))
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      ended = true
      clean()
      return Native.cancel({ id })
    },
  })
  listener = await Native.addListener('transfer', (event) => {
    if (event.id !== id || ended) {
      return
    }
    if (event.type === 'chunk') {
      try {
        const binary = atob(event.data ?? '')
        controller.enqueue(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
        void Native.ack({ id }).catch((error) => finish(error))
      } catch (error) {
        onAbort()
        finish(error)
      }
    } else if (event.type === 'end') {
      finish()
    } else {
      finish(new Error(event.data ?? 'NETWORK_ERROR'))
    }
  })
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
    return new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      headers: {
        'Content-Type': response.contentType,
        ...(response.mcpSessionId && { 'Mcp-Session-Id': response.mcpSessionId }),
      },
    })
  } catch (error) {
    ended = true
    clean()
    void Native.cancel({ id }).catch(() => {})
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
