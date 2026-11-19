import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
const PAYLOAD_CHUNK_BYTES = 2 * 1024 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024
const ZIP64_16 = 0xffff
const ZIP64_32 = 0xffffffff

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const uint64 = (view: DataView, offset: number): number => {
  if (offset + 8 > view.byteLength) {
    return invalid()
  }
  const value = view.getUint32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true)
  return Number.isSafeInteger(value) ? value : invalid()
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    length > file.size - start
  ) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

type ByteReader = (start: number, length: number) => Promise<Uint8Array>

/** 旧 WebView 的每次 Blob 读取都要异步过桥，合并连续的小读取，最多缓存一片。 */
const cachedReader = (file: File): ByteReader => {
  let offset = 0
  let cached = new Uint8Array(0)
  return async (start, length) => {
    if (start < 0 || length < 0 || length > file.size - start) {
      return invalid()
    }
    if (length === 0) {
      return new Uint8Array(0)
    }
    if (start < offset || start + length > offset + cached.length) {
      cached = await readBytes(
        file,
        start,
        Math.min(file.size - start, Math.max(READ_CHUNK_BYTES, length))
      )
      offset = start
    }
    return cached.subarray(start - offset, start - offset + length)
  }
}

const zip64Extra = (bytes: Uint8Array): DataView | undefined => {
  const view = viewOf(bytes)
  let zip64: DataView | undefined
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      return invalid()
    }
    const end = offset + 4 + view.getUint16(offset + 2, true)
    if (end > bytes.length) {
      return invalid()
    }
    if (view.getUint16(offset, true) === 1) {
      if (zip64) {
        return invalid()
      }
      zip64 = viewOf(bytes.subarray(offset + 4, end))
    }
    offset = end
  }
  return zip64
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

type Directory = { entries: Entry[]; offset: number }
type DirectoryLocation = { count: number; size: number; offset: number }

const directoryLocation = async (
  file: File,
  legacy: DataView,
  legacyOffset: number
): Promise<DirectoryLocation> => {
  const disk = legacy.getUint16(4, true)
  const firstDisk = legacy.getUint16(6, true)
  const diskCount = legacy.getUint16(8, true)
  const count = legacy.getUint16(10, true)
  const size = legacy.getUint32(12, true)
  const offset = legacy.getUint32(16, true)
  if (
    disk === 0 &&
    firstDisk === 0 &&
    diskCount === count &&
    count !== ZIP64_16 &&
    size !== ZIP64_32 &&
    offset !== ZIP64_32 &&
    offset + size === legacyOffset
  ) {
    return { count, size, offset }
  }

  // Some writers already switch to ZIP64 when an archive passes 2 GiB. Their legacy fields
  // can still hold the values, so follow the locator instead of only checking for sentinels.
  const locatorOffset = legacyOffset - 20
  const locator = viewOf(await readBytes(file, locatorOffset, 20))
  if (
    locator.getUint32(0, true) !== 0x07064b50 ||
    locator.getUint32(4, true) !== 0 ||
    locator.getUint32(16, true) !== 1 ||
    (disk !== 0 && disk !== ZIP64_16) ||
    (firstDisk !== 0 && firstDisk !== ZIP64_16)
  ) {
    return invalid()
  }
  const endOffset = uint64(locator, 8)
  if (endOffset > locatorOffset - 56) {
    return invalid()
  }
  const end = viewOf(await readBytes(file, endOffset, 56))
  const zip64Count = uint64(end, 32)
  const zip64Size = uint64(end, 40)
  const zip64Offset = uint64(end, 48)
  if (
    end.getUint32(0, true) !== 0x06064b50 ||
    uint64(end, 4) !== locatorOffset - endOffset - 12 ||
    end.getUint32(16, true) !== 0 ||
    end.getUint32(20, true) !== 0 ||
    uint64(end, 24) !== zip64Count ||
    zip64Size !== endOffset - zip64Offset ||
    (diskCount !== ZIP64_16 && diskCount !== zip64Count) ||
    (count !== ZIP64_16 && count !== zip64Count) ||
    (size !== ZIP64_32 && size !== zip64Size) ||
    (offset !== ZIP64_32 && offset !== zip64Offset)
  ) {
    return invalid()
  }
  return { count: zip64Count, size: zip64Size, offset: zip64Offset }
}

const readDirectory = async (file: File): Promise<Directory> => {
  if (!Number.isSafeInteger(file.size) || file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const { count, size, offset } = await directoryLocation(
    file,
    viewOf(tail.subarray(end)),
    tailStart + end
  )
  if (count > Math.floor(size / 46)) {
    invalid()
  }
  const entries: Entry[] = []
  const read = cachedReader(file)
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(await read(offset + cursor, 46))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(32, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      ((view.getUint32(38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    // 名称需跨条目保留，复制短名称，避免把整片索引缓存挂在每个条目上。
    const name = (await read(offset + cursor + 46, nameLength)).slice()
    const extra = zip64Extra(await read(offset + cursor + 46 + nameLength, extraLength))
    let extraOffset = 0
    const extended = (position: number) => {
      const value = view.getUint32(position, true)
      if (value !== ZIP64_32) {
        return value
      }
      if (!extra) {
        return invalid()
      }
      const large = uint64(extra, extraOffset)
      extraOffset += 8
      return large
    }
    const entrySize = extended(24)
    const compressedSize = extended(20)
    const entryOffset = extended(42)
    const disk = view.getUint16(34, true)
    const firstDisk =
      disk === ZIP64_16 && extra && extraOffset + 4 <= extra.byteLength
        ? extra.getUint32(extraOffset, true)
        : disk
    if (
      firstDisk !== 0 ||
      entryOffset >= offset ||
      (method === 0 && compressedSize !== entrySize)
    ) {
      invalid()
    }
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

const directories = new WeakMap<File, Promise<Directory>>()
const directoryFor = (file: File) => {
  const cached = directories.get(file)
  if (cached) {
    return cached
  }
  const directory = readDirectory(file).catch((error: unknown) => {
    directories.delete(file)
    throw error
  })
  directories.set(file, directory)
  return directory
}

const readEntryOffset = async (read: ByteReader, entry: Entry, boundary: number) => {
  if (boundary - entry.offset < 30) {
    invalid()
  }
  const view = viewOf(await read(entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    entry.compressedSize > boundary - start
  ) {
    invalid()
  }
  const metadata = await read(entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  const extra = zip64Extra(metadata.subarray(nameLength))
  const size = view.getUint32(22, true)
  const compressed = view.getUint32(18, true)
  const hasDescriptor = Boolean(entry.flags & 8)
  const matches = (actual: number, expected: number) =>
    actual === expected || (hasDescriptor && actual === 0)
  const localSize = (value: number, position: number) =>
    value === ZIP64_32 ? (extra ? uint64(extra, position) : invalid()) : value
  if (
    !matches(view.getUint32(14, true), entry.crc) ||
    !matches(localSize(size, 0), entry.size) ||
    !matches(localSize(compressed, 8), entry.compressedSize)
  ) {
    invalid()
  }
  if (hasDescriptor) {
    if (end + 12 > boundary) {
      invalid()
    }
    const descriptor = viewOf(await read(end, Math.min(24, boundary - end)))
    const matchesAt = (shift: number) => {
      if (shift + 12 > descriptor.byteLength || descriptor.getUint32(shift, true) !== entry.crc) {
        return false
      }
      return (
        (descriptor.getUint32(shift + 4, true) === entry.compressedSize &&
          descriptor.getUint32(shift + 8, true) === entry.size) ||
        (shift + 20 <= descriptor.byteLength &&
          uint64(descriptor, shift + 4) === entry.compressedSize &&
          uint64(descriptor, shift + 12) === entry.size)
      )
    }
    if (!((descriptor.getUint32(0, true) === 0x08074b50 && matchesAt(4)) || matchesAt(0))) {
      invalid()
    }
  }
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  stream: AsyncIterable<Uint8Array>
}

/** Read sizes from the same directory used for entry validation. */
export const archiveSize = async (file: File) => {
  const directory = await directoryFor(file)
  const entries = directory.entries.filter(({ path }) => !path.endsWith('/'))
  return {
    total: entries.length,
    expandedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  }
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await directoryFor(file)
  const read = cachedReader(file)
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    const start = await readEntryOffset(read, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    let completed = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        for (let i = 0; i < chunk.length; i++) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[i]) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      for (let offset = 0; offset < entry.compressedSize; offset += PAYLOAD_CHUNK_BYTES) {
        const chunk = await read(
          start + offset,
          Math.min(PAYLOAD_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield { path: entry.path, size: entry.size, stream: stream() }
    if (!completed) {
      invalid()
    }
  }
}

/** Verify and copy each chunk so attachments survive after the original ZIP is moved or deleted. */
export const readEntry = async (
  entry: ArchiveEntry,
  onRead?: (bytes: number, total: number) => void
): Promise<Blob> => {
  const parts: Blob[] = []
  let bytes = 0,
    yieldedAt = performance.now()
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
    bytes += chunk.length
    if (onRead && performance.now() - yieldedAt >= 16) {
      onRead(bytes, entry.size)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      yieldedAt = performance.now()
    }
  }
  onRead?.(bytes, entry.size)
  return new Blob(parts)
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
