// 必须在应用和依赖模块求值前执行，覆盖旧 Android WebView 缺少的标准 API。
import 'core-js/stable'
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
import { ResizeObserver as ResizeObserverPolyfill } from '@juggle/resize-observer'

if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = ResizeObserverPolyfill as typeof window.ResizeObserver
}

if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value: function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'))
        reader.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
        reader.readAsArrayBuffer(this)
      })
    },
  })
}
if (typeof Blob.prototype.text !== 'function') {
  Object.defineProperty(Blob.prototype, 'text', {
    configurable: true,
    writable: true,
    value: async function (this: Blob): Promise<string> {
      return new TextDecoder().decode(await this.arrayBuffer())
    },
  })
}
if (typeof Blob.prototype.stream !== 'function') {
  Object.defineProperty(Blob.prototype, 'stream', {
    configurable: true,
    writable: true,
    value: function (this: Blob): ReadableStream<Uint8Array> {
      let offset = 0,
        cancelled = false
      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (offset >= this.size) {
            controller.close()
            return
          }
          try {
            const chunk = new Uint8Array(
              await this.slice(offset, offset + 256 * 1024).arrayBuffer()
            )
            if (!cancelled) {
              offset += chunk.length
              controller.enqueue(chunk)
            }
          } catch (error) {
            if (!cancelled) {
              controller.error(error)
            }
          }
        },
        cancel() {
          cancelled = true
        },
      })
    },
  })
}
if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
    configurable: true,
    writable: true,
    value: function (this: AbortSignal) {
      if (this.aborted) {
        throw this.reason ?? new DOMException('Aborted', 'AbortError')
      }
    },
  })
}
