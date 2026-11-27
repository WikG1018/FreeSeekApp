import { JSONParser, TokenType } from '@streamparser/json'
import { BackupError, fail } from './errors.js'
import type { ArchiveEntry } from './zipReader.js'
import { INDEX_PATH, MANIFEST_PATH } from './paths.js'

/** These limits apply to one decompressed JSON entry, never to the whole archive. */
export const MAX_JSON_BYTES = 128 * 1024 * 1024
export const MAX_SESSION_JSON_BYTES = 256 * 1024 * 1024
const PARSE_CHUNK_BYTES = 64 * 1024
const MAX_DEPTH = 64
const MAX_TOKENS = 2_000_000
const MAX_SESSION_TOKENS = 4_000_000

/** 导出遵守相同的结构预算，避免产生本应用无法再读取的备份。 */
export const assertJsonStructure = (value: unknown): number => {
  let tokens = 0
  const visit = (value: unknown, depth: number) => {
    if (value !== null && typeof value === 'object') {
      if (depth >= MAX_DEPTH) {
        fail('backupJsonTooLarge')
      }
      if (Array.isArray(value)) {
        tokens += 2 + Math.max(0, value.length - 1)
        if (tokens > MAX_TOKENS) {
          fail('backupJsonTooLarge')
        }
        for (const item of value) {
          visit(item, depth + 1)
        }
      } else {
        const keys = Object.keys(value).filter(
          (key) => (value as Record<string, unknown>)[key] !== undefined
        )
        tokens += 2 + Math.max(0, keys.length - 1) + keys.length * 2
        if (tokens > MAX_TOKENS) {
          fail('backupJsonTooLarge')
        }
        for (const key of keys) {
          visit((value as Record<string, unknown>)[key], depth + 1)
        }
      }
    } else {
      tokens++
    }
    if (tokens > MAX_TOKENS) {
      fail('backupJsonTooLarge')
    }
  }
  visit(value, 0)
  return tokens
}

export type ImportProgress = (
  processed: number,
  total: number,
  reading?: { bytes: number; total: number }
) => void

export const readJsonEntry = async (
  entry: ArchiveEntry,
  onRead?: (bytes: number, total: number) => void,
  kind: 'metadata' | 'session' | 'local' = 'metadata'
): Promise<unknown> => {
  const maxBytes =
    kind === 'local' ? entry.size : kind === 'session' ? MAX_SESSION_JSON_BYTES : MAX_JSON_BYTES
  const maxTokens =
    kind === 'local' ? Infinity : kind === 'session' ? MAX_SESSION_TOKENS : MAX_TOKENS
  const limitKey =
    kind === 'session' && !entry.path.startsWith('freeseek/workspaces/')
      ? 'backupSessionJsonTooLarge'
      : entry.path === INDEX_PATH
        ? 'backupIndexJsonTooLarge'
        : entry.path === MANIFEST_PATH
          ? 'backupManifestJsonTooLarge'
          : 'backupJsonTooLarge'
  if (entry.size > maxBytes) {
    fail(limitKey)
  }
  const parser = new JSONParser({ paths: ['$'], stringBufferSize: 64 * 1024 })
  let result: unknown
  let depth = 0
  let tokens = 0
  let bytes = 0
  let yieldedAt = performance.now()
  parser.onValue = ({ value }) => {
    result = value
  }
  parser.onToken = ({ token }) => {
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      depth++
    }
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      depth--
    }
    if (depth > MAX_DEPTH || ++tokens > maxTokens) {
      fail(limitKey)
    }
  }
  parser.onError = (error) => {
    if (error instanceof BackupError) {
      throw error
    }
    fail('backupInvalidJson')
  }
  // 必须消费到流结束：JSON 根值解析完后仍需校验尾部、声明大小和 ZIP CRC。
  // 只由解析器转换语法错误；ZIP 校验错误交给导入层处理，避免误报为 JSON 错误。
  for await (const chunk of entry.stream) {
    for (let offset = 0; offset < chunk.byteLength; offset += PARSE_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + PARSE_CHUNK_BYTES)
      bytes += part.byteLength
      if (bytes > maxBytes) {
        fail(limitKey)
      }
      parser.write(part)
      if (performance.now() - yieldedAt >= 16) {
        onRead?.(bytes, entry.size)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        yieldedAt = performance.now()
      }
    }
  }
  if (!parser.isEnded) {
    parser.end()
  }
  if (result === undefined) {
    fail('backupInvalidJson')
  }
  onRead?.(bytes, entry.size)
  return result
}
