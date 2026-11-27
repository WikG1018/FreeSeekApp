import { Capacitor, registerPlugin } from '@capacitor/core'
import { blobBase64 } from '../utils/blobBase64.js'
import { beginDiagnosticOperation, diagnosticError } from './diagnostics/log.js'
import { BackupError } from './chat/history/errors.js'
import type { DiskOriginal } from './chat/historyFiles.js'

type BackupNative = {
  create: (options: {
    fileName: string
    size: number
    archiveEntries?: number
  }) => Promise<{ id?: string; cancelled?: boolean }>
  beginArchiveEntry: (options: { id: string; name: string; size: number; key?: string }) => Promise<void>
  write: (options: { id: string; data: string }) => Promise<void>
  finish: (options: { id: string }) => Promise<void>
  cancel: (options: { id: string }) => Promise<void>
}
const Native = registerPlugin<BackupNative>('Backup')
const SAVE_CHUNK_BYTES = 256 * 1024
const NATIVE_FAULT_CODES = new Set([
  'BACKUP_INVALID_NAME', 'BACKUP_INVALID_SIZE', 'BACKUP_INVALID_ARCHIVE',
  'BACKUP_PICKER_BUSY', 'BACKUP_PICKER_OPEN', 'BACKUP_DESTINATION_OPEN',
  'BACKUP_WRITE', 'BACKUP_FINALIZE', 'HISTORY_ARCHIVE_SOURCE', 'HISTORY_ARCHIVE_WRITE',
])

type SaveScope = 'backup' | 'diagnostics' | 'persona' | 'chat'

const sendBlob = async (id: string, blob: Blob, onWrite: (bytes: number) => void) => {
  for (let start = 0; start < blob.size; start += SAVE_CHUNK_BYTES) {
    const part = blob.slice(start, start + SAVE_CHUNK_BYTES)
    let data: string
    try {
      data = await blobBase64(part)
    } catch {
      throw new BackupError('historyExportReadFailed')
    }
    await Native.write({ id, data })
    onWrite(part.size)
  }
}

const saveNativeFile = async (
  fileName: string,
  size: number,
  scope: SaveScope,
  write: (id: string, onWrite: (bytes: number) => void) => Promise<void>,
  archiveEntries?: number
): Promise<boolean> => {
  const finish = beginDiagnosticOperation(scope, 'file.save', {
    bytes: size,
    native: true,
    ...(archiveEntries && { archiveEntries }),
  })
  let stage = 'picker'
  let id: string | undefined
  let writtenBytes = 0
  try {
    const result = await Native.create({ fileName, size, archiveEntries })
    if (result.cancelled) {
      finish('cancelled', { stage })
      return false
    }
    if (!result.id) {
      throw new Error('Unable to create backup file')
    }
    id = result.id
    stage = 'write'
    await write(id, (bytes) => { writtenBytes += bytes })
    if (writtenBytes !== size) {
      throw new BackupError('historyExportWriteFailed')
    }
    stage = 'finalize'
    await Native.finish({ id })
    finish('completed', { stage, writtenBytes })
    return true
  } catch (error) {
    if (id) {
      await Native.cancel({ id }).catch(() => {})
    }
    const code = (error as { code?: unknown } | null)?.code
    finish('failed', {
      stage,
      writtenBytes,
      ...diagnosticError(error),
      ...(typeof code === 'string' && NATIVE_FAULT_CODES.has(code) && { faultCode: code }),
      ...(error instanceof BackupError && { failureKey: error.key }),
    })
    if (!archiveEntries || error instanceof BackupError) {
      throw error
    }
    throw new BackupError(code === 'HISTORY_ARCHIVE_SOURCE'
      ? 'historyExportReadFailed'
      : 'historyExportWriteFailed')
  }
}

export const canSaveHistoryArchive = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('Backup')

/** Write disk-backed originals directly to the selected document. Other entries cross the bridge in bounded chunks. */
export const saveHistoryArchive = async (
  fileName: string,
  entries: readonly { name: string; source: Blob | DiskOriginal }[]
) => {
  const size = entries.reduce((total, { source }) => total + source.size, 0)
  if (!Number.isSafeInteger(size) || size >= 0xffff_ffff || entries.length < 1 || entries.length >= 0xffff) {
    throw new BackupError('historyExportTooLarge')
  }
  return saveNativeFile(fileName, size, 'backup', async (id, onWrite) => {
    for (const { name, source } of entries) {
      if (source instanceof Blob) {
        await Native.beginArchiveEntry({ id, name, size: source.size })
        await sendBlob(id, source, onWrite)
      } else {
        await Native.beginArchiveEntry({ id, name, key: source.key, size: source.size })
        onWrite(source.size)
      }
    }
  }, entries.length)
}

/** Android 使用系统保存器和分片传输，避免 blob 下载无效或大备份撑爆 JS 桥。 */
export const saveBackup = async (
  fileName: string,
  blob: Blob,
  scope: SaveScope = 'backup'
): Promise<boolean> => {
  if (Capacitor.getPlatform() === 'android') {
    return saveNativeFile(fileName, blob.size, scope, (id, onWrite) => sendBlob(id, blob, onWrite))
  }
  const finish = beginDiagnosticOperation(scope, 'file.save', { bytes: blob.size, native: false })
  let url: string | undefined
  const stage = 'browser-download'
  try {
    url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    finish('completed', { stage, result: 'download-started' })
    return true
  } catch (error) {
    finish('failed', { stage, faultCode: 'BACKUP_DOWNLOAD_START', ...diagnosticError(error) })
    throw error
  } finally {
    if (url) {
      const release = url
      setTimeout(() => URL.revokeObjectURL(release), 10_000)
    }
  }
}
