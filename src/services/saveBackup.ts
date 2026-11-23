import { Capacitor, registerPlugin } from '@capacitor/core'
import { blobBase64 } from '../utils/blobBase64.js'
import { beginDiagnosticOperation, diagnosticError } from './diagnostics/log.js'

type BackupNative = {
  create: (options: {
    fileName: string
    size: number
  }) => Promise<{ id?: string; cancelled?: boolean }>
  write: (options: { id: string; data: string }) => Promise<void>
  finish: (options: { id: string }) => Promise<void>
  cancel: (options: { id: string }) => Promise<void>
}
const Native = registerPlugin<BackupNative>('Backup')

/** Android 使用系统保存器和分片传输，避免 blob 下载无效或大备份撑爆 JS 桥。 */
export const saveBackup = async (
  fileName: string,
  blob: Blob,
  scope: 'backup' | 'diagnostics' | 'persona' | 'chat' = 'backup'
): Promise<boolean> => {
  const native = Capacitor.getPlatform() === 'android'
  const finish = beginDiagnosticOperation(scope, 'file.save', { bytes: blob.size, native })
  let stage = native ? 'picker' : 'browser-download'
  let id: string | undefined
  let writtenBytes = 0
  try {
    if (!native) {
      const url = URL.createObjectURL(blob)
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = fileName
        link.click()
        finish('completed', { stage })
        return true
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
    }
    const result = await Native.create({ fileName, size: blob.size })
    if (result.cancelled) {
      finish('cancelled', { stage })
      return false
    }
    if (!result.id) {
      throw new Error('Unable to create backup file')
    }
    id = result.id
    stage = 'write'
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      const part = blob.slice(start, start + 256 * 1024)
      await Native.write({ id, data: await blobBase64(part) })
      writtenBytes += part.size
    }
    stage = 'finalize'
    await Native.finish({ id })
    finish('completed', { stage, writtenBytes })
    return true
  } catch (error) {
    if (id) {
      await Native.cancel({ id }).catch(() => {})
    }
    finish('failed', { stage, writtenBytes, ...diagnosticError(error) })
    throw error
  }
}
