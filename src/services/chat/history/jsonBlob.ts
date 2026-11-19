const CHUNK_CHARS = 256 * 1024

/** Encode JSON in bounded pieces, including a single very long message or explanation. */
function* jsonPieces(value: unknown): Generator<string> {
  if (typeof value === 'string' && value.length > CHUNK_CHARS) {
    yield '"'
    for (let start = 0; start < value.length; ) {
      let end = Math.min(value.length, start + CHUNK_CHARS)
      if (end < value.length && (value.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
        end--
      }
      yield JSON.stringify(value.slice(start, end)).slice(1, -1)
      start = end
    }
    yield '"'
  } else if (Array.isArray(value)) {
    yield '['
    for (const [index, item] of value.entries()) {
      if (index > 0) {
        yield ','
      }
      yield* jsonPieces(item)
    }
    yield ']'
  } else if (value !== null && typeof value === 'object') {
    yield '{'
    let first = true
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue
      }
      if (!first) {
        yield ','
      }
      first = false
      yield JSON.stringify(key)
      yield ':'
      yield* jsonPieces(item)
    }
    yield '}'
  } else {
    yield JSON.stringify(value) ?? 'null'
  }
}

export function jsonBlob(value: unknown): Blob
export function jsonBlob(value: unknown, maxBytes: number): Blob | undefined
export function jsonBlob(value: unknown, maxBytes = Infinity): Blob | undefined {
  const parts: Blob[] = []
  let bytes = 0,
    pending = ''
  const write = () => {
    const blob = new Blob([pending])
    bytes += blob.size
    parts.push(blob)
    pending = ''
    return bytes <= maxBytes
  }
  for (const piece of jsonPieces(value)) {
    pending += piece
    if (pending.length >= CHUNK_CHARS && !write()) {
      return undefined
    }
  }
  return write() ? new Blob(parts, { type: 'application/json' }) : undefined
}

export async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < blob.size; start += CHUNK_CHARS) {
    yield new Uint8Array(await blob.slice(start, start + CHUNK_CHARS).arrayBuffer())
  }
}
