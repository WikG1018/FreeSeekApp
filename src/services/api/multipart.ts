import { createId } from '../../utils/id.js'
import { ApiError } from './errorTypes.js'
import { describeKnownApiError } from './knownErrors.js'
import { diagnosticError, logEvent, registerLogSecret } from '../diagnostics/log.js'
import { apiRequestRoute } from './windowsTransport.js'

export const uploadPolicy = {
  idleTimeoutMs: 120_000,
  processingTimeoutMs: 300_000,
  totalTimeoutMs: 20 * 60_000,
}
export type UploadProgress = {
  requestId: string
  loaded: number
  total: number
  phase: 'uploading' | 'processing' | 'receiving'
}
type Options = {
  headers: Record<string, string>
  body: FormData
  signal?: AbortSignal
  operation: 'upload' | 'asr'
  onProgress?: (progress: UploadProgress) => void
}

/** 上传进度重置闲置计时；大文件只要持续上传就不会被“等待响应头 120 秒”误杀。 */
export const postMultipart = (url: string, options: Options): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(),
      requestId = createId(),
      started = performance.now()
    let settled = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      lastPercent = -10
    const auth =
      options.headers['x-api-key'] ?? options.headers.Authorization?.replace(/^Bearer\s+/i, '')
    registerLogSecret(auth)
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      logEvent(
        'api',
        'multipart.failed',
        {
          requestId,
          operation: options.operation,
          elapsedMs: Math.round(performance.now() - started),
          ...diagnosticError(error),
        },
        'error'
      )
      reject(error)
    }
    const watchdog = (timeout: number, phase: string) => {
      if (settled) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => {
        fail(
          new ApiError('network', 'Upload ' + phase + ' timeout', undefined, {
            key: 'uploadTimedOut',
          })
        )
        xhr.abort()
      }, timeout)
    }
    const abort = () => {
      fail(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      xhr.abort()
    }
    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const route = apiRequestRoute(url, options.headers)
      xhr.open('POST', route.url)
      xhr.timeout = uploadPolicy.totalTimeoutMs
      new Headers(route.headers).forEach((value, key) => xhr.setRequestHeader(key, value))
    } catch (error) {
      fail(error)
      return
    }
    xhr.upload.onprogress = (event) => {
      watchdog(uploadPolicy.idleTimeoutMs, 'uploading')
      options.onProgress?.({
        requestId,
        loaded: event.loaded,
        total: event.total,
        phase: 'uploading',
      })
      const percent = event.total ? Math.floor((event.loaded / event.total) * 100) : -1
      if (percent >= lastPercent + 10) {
        lastPercent = percent
        logEvent('upload', 'progress', {
          requestId,
          percent,
          transferredBytes: event.loaded,
          totalBytes: event.total,
        })
      }
    }
    xhr.upload.onload = () => {
      watchdog(
        xhr.readyState < 2 ? uploadPolicy.processingTimeoutMs : uploadPolicy.idleTimeoutMs,
        'processing'
      )
      options.onProgress?.({ requestId, loaded: 0, total: 0, phase: 'processing' })
      logEvent('api', 'multipart.processing', { requestId, operation: options.operation })
    }
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2) {
        watchdog(uploadPolicy.idleTimeoutMs, 'response')
      }
    }
    xhr.onprogress = (event) => {
      watchdog(uploadPolicy.idleTimeoutMs, 'response')
      options.onProgress?.({
        requestId,
        loaded: event.loaded,
        total: event.total,
        phase: 'receiving',
      })
      if (event.loaded > 2 * 1024 * 1024) {
        fail(new ApiError('protocol', { key: 'uploadResponseInvalid' }))
        xhr.abort()
      }
    }
    xhr.onerror = () => fail(new ApiError('network', 'Upload network error'))
    xhr.onabort = () => {
      if (!settled) {
        fail(new DOMException('Aborted', 'AbortError'))
      }
    }
    xhr.ontimeout = () =>
      fail(new ApiError('network', 'Upload total timeout', undefined, { key: 'uploadTimedOut' }))
    xhr.onload = () => {
      if (settled) {
        return
      }
      let body: unknown
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* HTTP 状态优先；成功但非 JSON 则按协议错误。 */
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const apiBody = body as { error?: { message?: unknown } } | undefined
        const message =
          typeof apiBody?.error?.message === 'string' ? apiBody.error.message : 'HTTP ' + xhr.status
        fail(new ApiError('http', message, xhr.status, describeKnownApiError(message)))
        return
      }
      if (!body || typeof body !== 'object') {
        fail(new ApiError('protocol', { key: 'uploadResponseInvalid' }))
        return
      }
      settled = true
      cleanup()
      logEvent('api', 'multipart.completed', {
        requestId,
        operation: options.operation,
        status: xhr.status,
        elapsedMs: Math.round(performance.now() - started),
        responseBytes: xhr.responseText.length,
        upstreamRequestId: xhr.getResponseHeader('x-ds-request-id') ?? undefined,
      })
      resolve(body)
    }
    logEvent('api', 'multipart.started', { requestId, operation: options.operation })
    watchdog(uploadPolicy.idleTimeoutMs, 'connecting')
    try {
      xhr.send(options.body)
    } catch (error) {
      fail(error)
    }
  })
