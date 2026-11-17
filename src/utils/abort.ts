/** 旧 WebView 的 signal.reason 可能为空，取消仍用标准 AbortError 表达。 */
export const abortReason = (signal?: AbortSignal) =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError')
export const abortableDelay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
