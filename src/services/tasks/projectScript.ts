import type { SourceProject } from './projectFiles.js'

type ScriptResult = {
  success: boolean
  assertions?: number
  reason?: 'project-timeout' | 'project-script-error' | 'project-runtime-unavailable'
  text: string
  model?: string
}

export const runProjectScript = (
  files: SourceProject,
  entry: string,
  signal: AbortSignal,
  captureModel = false
) => {
  signal.throwIfAborted()
  return new Promise<ScriptResult>((resolve, reject) => {
    const worker = new Worker(new URL('./projectScript.worker.ts', import.meta.url))
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const finish = (result: ScriptResult) => {
      cleanup()
      resolve(result)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'))
    }
    const timeout = setTimeout(
      () => finish({ success: false, reason: 'project-timeout', text: 'The script timed out.' }),
      6_000
    )
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<ScriptResult>) => finish(event.data)
    worker.onerror = () =>
      finish({
        success: false,
        reason: 'project-runtime-unavailable',
        text: 'The local JavaScript runtime could not start.',
      })
    worker.postMessage({ files, entry, captureModel })
  })
}
