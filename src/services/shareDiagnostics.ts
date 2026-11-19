import { Capacitor, registerPlugin } from '@capacitor/core'
import { saveBackup } from './saveBackup.js'

const Native = registerPlugin<{
  create(options: { fileName: string; size: number }): Promise<{ id: string }>
  write(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ launched: boolean }>
  cancel(options: { id: string }): Promise<void>
}>('DiagnosticShare')
const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(new DOMException('Read cancelled', 'AbortError'))
    reader.readAsDataURL(blob)
  })

/** 返回面板是否已打开，不将打开分享面板误称为已发送给他人。 */
export const shareDiagnostics = async (
  name: string,
  blob: Blob
): Promise<'shared' | 'saved' | false> => {
  if (Capacitor.getPlatform() !== 'android') {
    const file = new File([blob], name, { type: 'application/zip' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'FreeSeek' })
        return 'shared'
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return false
        }
        throw error
      }
    }
    return (await saveBackup(name, blob)) ? 'saved' : false
  }
  const { id } = await Native.create({ fileName: name, size: blob.size })
  try {
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      await Native.write({ id, data: await base64(blob.slice(start, start + 256 * 1024)) })
    }
    return (await Native.finish({ id })).launched ? 'shared' : false
  } catch (error) {
    await Native.cancel({ id }).catch(() => {})
    throw error
  }
}
