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

const nativeHistoryFiles = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('HistoryFiles')

export const browserHistoryLocks = () =>
  Capacitor.getPlatform() === 'web' ? navigator.locks : undefined

const browserHistoryFiles = () =>
  Boolean(browserHistoryLocks()) &&
  typeof navigator.storage?.getDirectory === 'function' &&
  typeof globalThis.FileSystemFileHandle?.prototype.createWritable === 'function'

export const historyFilesAvailable = () => nativeHistoryFiles() || browserHistoryFiles()

const originalsDirectory = async () => {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('freeseek-history-originals', { create: true })
}

export const prepareDiskOriginals = async () =>
  nativeHistoryFiles() ||
  (browserHistoryFiles() &&
    originalsDirectory().then(
      () => true,
      () => false
    ))

const writeBrowserOriginal = async (
  { key, size }: DiskOriginal,
  contents: AsyncIterable<Uint8Array>,
  onWrite?: (bytes: number, total: number) => void
) => {
  const directory = await originalsDirectory()
  const handle = await directory.getFileHandle(key, { create: true })
  const writer = await handle.createWritable()
  let written = 0,
    updated = performance.now()
  try {
    for await (const data of contents) {
      await writer.write(data as Uint8Array<ArrayBuffer>)
      written += data.byteLength
      if (performance.now() - updated >= 16) {
        onWrite?.(written, size)
        updated = performance.now()
      }
    }
    if (written !== size) {
      throw new Error('Incomplete imported attachment')
    }
    await writer.close()
    onWrite?.(written, size)
  } catch (error) {
    await writer.abort().catch(() => {})
    throw error
  }
}

export const writeDiskOriginal = async (
  original: DiskOriginal,
  contents: AsyncIterable<Uint8Array>,
  onWrite?: (bytes: number, total: number) => void
) => {
  if (!nativeHistoryFiles()) {
    return writeBrowserOriginal(original, contents, onWrite)
  }
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
  if (!nativeHistoryFiles()) {
    const directory = await originalsDirectory()
    const file = await (await directory.getFileHandle(key)).getFile()
    if (file.size !== size) {
      throw new Error('Incomplete imported attachment')
    }
    return new Blob([file], { type })
  }
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

const removeBrowserOriginal = async (directory: FileSystemDirectoryHandle, key: string) => {
  try {
    await directory.removeEntry(key)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      throw error
    }
  }
}

export const pruneDiskOriginals = async (keep: string[]) => {
  if (nativeHistoryFiles()) {
    return Native.prune({ keep })
  }
  const directory = await originalsDirectory()
  const retained = new Set(keep)
  for await (const [key, original] of directory.entries()) {
    if (original.kind === 'file' && !retained.has(key)) {
      await removeBrowserOriginal(directory, key)
    }
  }
}

export const removeDiskOriginals = async (keys: string[]) => {
  if (nativeHistoryFiles()) {
    return Native.remove({ keys })
  }
  const directory = await originalsDirectory()
  for (const key of keys) {
    await removeBrowserOriginal(directory, key)
  }
}
