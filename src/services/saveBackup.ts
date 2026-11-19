import { Capacitor, registerPlugin } from '@capacitor/core'

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
const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(new DOMException('Read cancelled', 'AbortError'))
    reader.readAsDataURL(blob)
  })

/** Android 使用系统保存器和分片传输，避免 blob 下载无效或大备份撑爆 JS 桥。 */
export const saveBackup = async (fileName: string, blob: Blob): Promise<boolean> => {
  if (Capacitor.getPlatform() !== 'android') {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  }
  const result = await Native.create({ fileName, size: blob.size })
  if (result.cancelled) {
    return false
  }
  if (!result.id) {
    throw new Error('Unable to create backup file')
  }
  const id = result.id
  try {
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      await Native.write({ id, data: await toBase64(blob.slice(start, start + 256 * 1024)) })
    }
    await Native.finish({ id })
    return true
  } catch (error) {
    await Native.cancel({ id }).catch(() => {})
    throw error
  }
}
