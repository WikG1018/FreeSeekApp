import { Capacitor, registerPlugin } from '@capacitor/core'
import { saveBackup } from './saveBackup.js'
import { blobBase64 } from '../utils/blobBase64.js'
import { beginDiagnosticOperation, diagnosticError } from './diagnostics/log.js'

const Native = registerPlugin<{
  create(options: { fileName: string; size: number }): Promise<{ id: string }>
  write(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ launched: boolean }>
  cancel(options: { id: string }): Promise<void>
}>('DiagnosticShare')
/** 返回面板是否已打开，不将打开分享面板误称为已发送给他人。 */
export const shareDiagnostics = async (
  name: string,
  blob: Blob
): Promise<'shared' | 'saved' | false> => {
  const native = Capacitor.getPlatform() === 'android'
  const finish = beginDiagnosticOperation('diagnostics', 'share', { bytes: blob.size, native })
  let stage = native ? 'prepare' : 'web-share'
  let id: string | undefined
  let writtenBytes = 0
  try {
    if (!native) {
      const file = new File([blob], name, { type: 'application/zip' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'FreeSeek' })
        finish('completed', { stage })
        return 'shared'
      }
      stage = 'browser-download'
      const saved = await saveBackup(name, blob, 'diagnostics')
      finish(saved ? 'completed' : 'cancelled', { stage })
      return saved ? 'saved' : false
    }
    const target = await Native.create({ fileName: name, size: blob.size })
    id = target.id
    stage = 'write'
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      const part = blob.slice(start, start + 256 * 1024)
      await Native.write({ id, data: await blobBase64(part) })
      writtenBytes += part.size
    }
    stage = 'chooser'
    const launched = (await Native.finish({ id })).launched
    finish(launched ? 'completed' : 'cancelled', { stage, writtenBytes })
    return launched ? 'shared' : false
  } catch (error) {
    if (id) {
      await Native.cancel({ id }).catch(() => {})
    }
    if (!native && stage === 'web-share' && error instanceof Error && error.name === 'AbortError') {
      finish('cancelled', { stage })
      return false
    }
    finish('failed', { stage, writtenBytes, ...diagnosticError(error) })
    throw error
  }
}
