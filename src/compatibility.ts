// 必须在应用和依赖模块求值前执行，覆盖旧浏览器缺少的标准 API。
// 体积大的 core-js / abortcontroller 补丁已移到 src/polyfills.ts，由 bootstrap 按能力按需加载；
// 这里的补丁都先判断能力，现代内核上不产生任何实际工作。
import { ResizeObserver as ResizeObserverPolyfill } from '@juggle/resize-observer'

// idb 8 使用 cursor.request；Chrome/WebView 76 之前缺少它，会让遍历在首条记录后提前结束。
// 从产生游标的原生请求关联回去，覆盖导入、旧库索引迁移、文件统计与日志清理。
if (
  typeof IDBCursor === 'function' &&
  typeof IDBRequest === 'function' &&
  !('request' in IDBCursor.prototype)
) {
  const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result')
  if (descriptor?.get && descriptor.configurable) {
    const readResult = descriptor.get
    const requests = new WeakMap<IDBCursor, IDBRequest>()
    Object.defineProperty(IDBRequest.prototype, 'result', {
      ...descriptor,
      get(this: IDBRequest) {
        const result: unknown = readResult.call(this)
        if (result instanceof IDBCursor) {
          requests.set(result, this)
        }
        return result
      },
    })
    Object.defineProperty(IDBCursor.prototype, 'request', {
      configurable: true,
      enumerable: true,
      get(this: IDBCursor) {
        return requests.get(this)
      },
    })
  }
}

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
