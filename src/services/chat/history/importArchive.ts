import * as db from '../db.js'
import { mapSessionFileIds } from '../sessionData.js'
import { logEvent } from '../../diagnostics/log.js'
import { readJsonEntry as readJson, type ImportProgress } from './readJson.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { BranchImportError, toLocalSession } from './toLocal.js'
import {
  isNativeManifest,
  readNativeManifest,
  importNativeEntries,
  type NativeBackupSettings,
} from './nativeArchive.js'
import {
  ArchiveError,
  archiveSize,
  isZipFile,
  readArchive,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'
import { stageArchiveFile, useDiskForArchive } from './stageArchiveFile.js'

export type ArchivePartial = { skippedSessions: number; missingOriginals: number }

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      const data = await readJson(entry)
      if (isNativeManifest(data)) {
        const native = readNativeManifest(data)
        if (!native.sessions.length) {
          fail('backupEmptyHistory')
        }
        return
      }
      checkManifest(data)
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  return fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  file: File,
  mapFileId: (id: string) => string,
  onProgress?: ImportProgress
): Promise<{ settings?: NativeBackupSettings; skipped: number; archivePartial?: ArchivePartial }> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const seenSessions = new Set<string>()
  const branchErrors: Partial<Record<BranchImportError['reason'], number>> = {}
  let skipped = 0
  let recoveredSelections = 0
  const images = new Map<string, string>()
  const sessionsWithImages = new Set<string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  let processed = 0
  const { total, expandedBytes } = await archiveSize(file)
  const useDisk = await useDiskForArchive(expandedBytes)
  logEvent('backup', 'import.directory-read', {
    entryCount: total,
    expandedBytes,
    diskStaging: useDisk,
  })
  const onRead = (bytes: number, size: number) =>
    onProgress?.(processed, total, { bytes, total: size })

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const type = await stageArchiveFile(entry, id, imageType, onRead, useDisk)
    stored.set(id, type)
  }

  onProgress?.(processed, total)
  const read = (entry: ArchiveEntry, kind?: 'session') => readJson(entry, onRead, kind)

  try {
    const entries = readArchive(file)
    for await (const entry of entries) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        const data = await read(entry)
        if (isNativeManifest(data)) {
          const native = readNativeManifest(data)
          logEvent('backup', 'import.format-detected', {
            format: 'freeseek',
            sessionCount: native.sessions.length,
            partial: native.partial?.kind,
          })
          if (!native.sessions.length) {
            fail('backupEmptyHistory')
          }
          const settings = await importNativeEntries(
            entries, native, total, useDisk, mapFileId, onProgress
          )
          const archivePartial = native.partial?.kind === 'unreadable'
            ? {
                skippedSessions: native.partial.skippedSessions,
                missingOriginals: native.partial.missingOriginals ?? 0,
              }
            : undefined
          return { settings, skipped: 0, archivePartial }
        }
        checkManifest(data)
        logEvent('backup', 'import.format-detected', { format: 'deepseek' })
        manifest = true
      } else if (path === USER_PATH && !index && seenSessions.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const session = readSessionFile(await read(entry, 'session'))
        if (session.id !== sessionId || seenSessions.has(sessionId)) {
          fail('backupIncomplete')
        }
        seenSessions.add(sessionId)
        currentSessionId = sessionId
        try {
          const local = toLocalSession(session)
          if (local.images.size > 0) {
            sessionsWithImages.add(sessionId)
          }
          for (const [imagePath, id] of local.images) {
            images.set(imagePath, mapFileId(id))
          }
          await db.addStagingSession(mapSessionFileIds(local.session, mapFileId))
          recoveredSelections += Number(local.recoveredSelection)
        } catch (error) {
          if (!(error instanceof BranchImportError)) {
            throw error
          }
          skipped += 1
          branchErrors[error.reason] = (branchErrors[error.reason] ?? 0) + 1
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await read(entry))
      } else if (
        index
          ? seenSessions.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
      processed += 1
      onProgress?.(processed, total)
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== seenSessions.size ||
    [...seenSessions].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  if (!seenSessions.size) {
    fail('backupEmptyHistory')
  }
  if (skipped || recoveredSelections) {
    logEvent(
      'backup',
      'import.branches-checked',
      { recoveredSelections, skippedSessions: skipped, ...branchErrors },
      skipped ? 'warn' : 'info'
    )
  }
  if (skipped === seenSessions.size) {
    fail('backupInvalidBranches')
  }
  await db.updateStagingFileTypes(stored, sessionsWithImages)
  return { skipped }
}
