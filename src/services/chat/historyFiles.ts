import { Capacitor, registerPlugin } from '@capacitor/core'
import { blobBase64 } from '../../utils/blobBase64.js'

export type DiskOriginal = { key: string; size: number; type: string }
const CHUNK_BYTES = 512 * 1024
const Native = registerPlugin<{
  begin(options: { key: string; size: number }): Promise<void>
  append(options: { key: string; data: string }): Promise<void>
  finish(options: { key: string }): Promise<void>
  locate(options: { key: string; size: number }): Promise<{ path: string }>
  prune(options: { keep: string[] }): Promise<void>
  remove(options: { keys: string[] }): Promise<void>
}>('HistoryFiles')

export const historyFilesAvailable = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('HistoryFiles')

export const writeDiskOriginal = async (
  original: DiskOriginal,
  contents: AsyncIterable<Uint8Array>,
  onWrite?: (bytes: number, total: number) => void
) => {
  const { key, size } = original
  let written = 0,
    updated = performance.now()
  try {
    await Native.begin({ key, size })
    for await (const data of contents) {
      for (let start = 0; start < data.length; start += CHUNK_BYTES) {
        const chunk = data.subarray(start, start + CHUNK_BYTES) as Uint8Array<ArrayBuffer>
        await Native.append({ key, data: await blobBase64(new Blob([chunk])) })
        written += chunk.length
        if (performance.now() - updated >= 16) {
          onWrite?.(written, size)
          updated = performance.now()
        }
      }
    }
    await Native.finish({ key })
    onWrite?.(written, size)
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'NO_SPACE') {
      throw new DOMException('No space for history attachment', 'QuotaExceededError')
    }
    throw error
  }
}

export const readDiskOriginal = async ({ key, size, type }: DiskOriginal): Promise<Blob> => {
  const { path } = await Native.locate({ key, size })
  const response = await fetch(Capacitor.convertFileSrc(path))
  if (!response.ok) {
    throw new Error('Unable to open imported attachment')
  }
  const blob = await response.blob()
  if (blob.size !== size) {
    throw new Error('Incomplete imported attachment')
  }
  return new Blob([blob], { type })
}

export const pruneDiskOriginals = (keep: string[]) => Native.prune({ keep })
export const removeDiskOriginals = (keys: string[]) => Native.remove({ keys })
