import { createId } from '../../../utils/id.js'
import { saveStagingDiskFile, saveStagingFiles } from '../db.js'
import { prepareDiskOriginals, writeDiskOriginal } from '../historyFiles.js'
import { readEntry, type ArchiveEntry } from './zipReader.js'

export const useDiskForArchive = async (expandedBytes: number) =>
  expandedBytes >= 512 * 1024 * 1024 && (await prepareDiskOriginals())

type MimeType = string | ((prefix: Uint8Array) => string)

export const stageArchiveFile = async (
  entry: ArchiveEntry,
  id: string,
  mimeType: MimeType,
  onRead: (bytes: number, total: number) => void,
  useDisk: boolean
): Promise<string> => {
  if (!useDisk) {
    const blob = await readEntry(entry, onRead)
    const type =
      typeof mimeType === 'string'
        ? mimeType
        : mimeType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))
    await saveStagingFiles([{ id, blob: new Blob([blob], { type }) }])
    return type
  }

  const stream = entry.stream[Symbol.asyncIterator]()
  const buffered: Uint8Array[] = []
  let type = typeof mimeType === 'string' ? mimeType : ''
  try {
    if (typeof mimeType === 'function') {
      const prefix = new Uint8Array(16)
      let length = 0
      while (length < prefix.length) {
        const next = await stream.next()
        if (next.done) {
          break
        }
        buffered.push(next.value)
        const fragment = next.value.subarray(0, prefix.length - length)
        prefix.set(fragment, length)
        length += fragment.length
      }
      type = mimeType(prefix.subarray(0, length))
    }
    const contents = async function* () {
      yield* buffered
      for (;;) {
        const next = await stream.next()
        if (next.done) {
          return
        }
        yield next.value
      }
    }
    const original = { key: createId(), size: entry.size, type }
    // Record it before writing so a later import can clean up after interruption.
    await saveStagingDiskFile(id, original)
    await writeDiskOriginal(original, contents(), onRead)
    return type
  } finally {
    await stream.return?.()
  }
}
