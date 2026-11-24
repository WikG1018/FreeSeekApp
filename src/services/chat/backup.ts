import { formatDate } from '../../utils/format.js'
import { createId } from '../../utils/id.js'
import * as db from './db.js'
import {
  mergeHistory,
  replaceHistory,
  useChatStore,
  loadBackupFile,
  flushChatUpdates,
  unsavedChatSnapshot,
  snapshotAgentHistory,
} from './store.js'
import type { Session } from './types.js'
import { restoreNativeSettings, type NativeBackupSettings } from './history/nativeArchive.js'
import { beginDiagnosticOperation, diagnosticError, logEvent } from '../diagnostics/log.js'
import type { ImportProgress } from './history/readJson.js'
import { BackupError } from './history/errors.js'
import { discardImportedWorkspaces } from '../tasks/workspaces.js'

export { BackupError } from './history/errors.js'
export type HistoryImportPreview = db.HistoryImportPreview & { skipped: number }

export type HistoryImportResult = {
  added: number
  replaced: number
  kept: number
  skipped: number
  firstImportedId?: string
}

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(
  operation: string,
  run: () => Promise<T>,
  details: Record<string, unknown> = {}
): Promise<T> => {
  const task = backupQueue.then(async () => {
    const finish = beginDiagnosticOperation('backup', operation, details)
    try {
      const result = await run()
      finish('completed')
      return result
    } catch (error) {
      const failure =
        operation === 'import' &&
        error instanceof DOMException &&
        error.name === 'QuotaExceededError'
          ? new BackupError('backupStorageFull')
          : error
      finish('failed', {
        ...diagnosticError(error),
        ...(failure instanceof BackupError ? { failureKey: failure.key } : {}),
      })
      throw failure
    }
  })
  backupQueue = task.catch(() => {})
  return task
}

/** 导出 FreeSeek 会话备份。跳过记录时，生成明确标记的部分备份。 */
export const exportHistory = (): Promise<{
  name: string
  blob: Blob
  skipped: number
  missingOriginals: number
}> =>
  enqueueBackup('export', async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    flushChatUpdates()
    const { ready, sessions, sessionCache } = useChatStore.getState()
    if (!ready) {
      throw new BackupError('sessionListLoadFailed')
    }
    // 索引里有、正文读不到的会话（数据库被系统清空后内存列表还留着旧条目）跳过而不是整次失败：
    // 备份剩下的会话远比「一条读不到就什么都导不出」有用。
    let skipped = 0
    const missing = new Set<string>()
    const skipSession = (error: unknown) => {
      skipped += 1
      logEvent('backup', 'export.session-skipped', diagnosticError(error), 'warn')
    }
    const loadOriginal = async (id: string) => {
      if (missing.has(id)) {
        return undefined
      }
      try {
        const blob = await loadBackupFile(id)
        if (blob) {
          return blob
        }
      } catch (error) {
        logEvent('backup', 'export.original-unavailable', diagnosticError(error), 'warn')
      }
      missing.add(id)
      return undefined
    }
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const cached = Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : null
        try {
          const session = cached ?? (await db.loadSession(summary.id))
          if (!session) {
            skipped += 1
            continue
          }
          // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
          yield await snapshotAgentHistory({ ...session, ...summary })
        } catch (error) {
          skipSession(error)
        }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(
      readSessions(),
      loadOriginal,
      () => skipped || missing.size
        ? {
            kind: 'unreadable',
            skippedSessions: skipped,
            ...(missing.size > 0 && { missingOriginals: missing.size }),
          }
        : undefined,
      skipSession
    )
    if (skipped && skipped === sessions.length) {
      // 一条都没读到：与其给用户一个空备份，不如明确报错。
      throw new BackupError('sessionListLoadFailed')
    }
    logEvent('backup', 'export.archive', {
      sessionCount: sessions.length - skipped,
      skipped,
      missingOriginals: missing.size,
      bytes: blob.size,
    })
    const name = ['freeseek', skipped || missing.size ? 'partial-backup' : 'backup', formatDate(now)].join('-')
    return { name: name + '.zip', blob, skipped, missingOriginals: missing.size }
  })

export const exportRecoveryHistory = () =>
  enqueueBackup('export-recovery', async () => {
    const { sessions, originals } = unsavedChatSnapshot()
    if (!sessions.length) {
      return undefined
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const missing = new Set<string>()
    const loadRecoveryFile = async (id: string) => {
      const cached = originals.get(id)
      if (cached) {
        return cached
      }
      if (!missing.has(id)) {
        try {
          const stored = await db.loadFile(id)
          if (stored) {
            return stored
          }
        } catch (error) {
          logEvent('backup', 'export.recovery-original-unavailable', diagnosticError(error), 'warn')
        }
        missing.add(id)
      }
      return undefined
    }
    const blob = await exportArchive(sessions, loadRecoveryFile, () => ({ kind: 'recovery' }))
    logEvent('backup', 'export.recovery-archive', {
      sessionCount: sessions.length,
      missingCount: missing.size,
      bytes: blob.size,
    })
    return {
      name: 'freeseek-recovery-' + formatDate(new Date()) + '.zip',
      blob,
      missing: missing.size,
    }
  })

/** Validate and stage the archive before asking which duplicate chats to replace. */
export const importHistory = (
  file: File,
  onProgress?: ImportProgress,
  choose?: (preview: HistoryImportPreview) => Promise<ReadonlySet<string> | null>
): Promise<HistoryImportResult | null> =>
  enqueueBackup(
    'import',
    async () => {
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      await checkArchiveFormat(file)
      let settings: NativeBackupSettings | undefined
      let skipped = 0
      const result = await mergeHistory(
        async (reservedFileIds) => {
          const remapped = new Map<string, string>()
          const mapFileId = (id: string) => {
            if (!reservedFileIds.has(id)) {
              return id
            }
            let next = remapped.get(id)
            if (!next) {
              next = createId()
              remapped.set(id, next)
            }
            return next
          }
          const parsed = await importArchive(file, mapFileId, onProgress)
          settings = parsed.settings
          skipped = parsed.skipped
        },
        async (preview) => {
          if (choose && (preview.conflicts.length || skipped)) {
            return choose({ ...preview, skipped })
          }
          if (skipped) {
            throw new BackupError('backupInvalidBranches')
          }
          return new Set<string>()
        },
        () => discardImportedWorkspaces(settings?.importedWorkspaces ?? [])
      )
      if (!result) {
        logEvent('backup', 'import.merge-cancelled')
        return null
      }
      if (settings?.importedWorkspaces?.length) {
        const used = new Set(
          result.imported.flatMap(({ id }) => settings?.workspacesBySession?.get(id) ?? [])
        )
        await discardImportedWorkspaces(settings.importedWorkspaces.filter((id) => !used.has(id)))
          .catch(db.reportStorageError('discard unselected imported projects'))
      }
      if (result.previousSessionCount === 0 && result.added > 0) {
        restoreNativeSettings(settings)
      }
      const { added, kept } = result
      const replaced = result.replaced.size
      logEvent('backup', 'import.archive', {
        previousSessionCount: result.previousSessionCount,
        sessionCount: result.summaries.length,
        added,
        replaced,
        kept,
        skipped,
        bytes: file.size,
      })
      return {
        added,
        replaced,
        kept,
        skipped,
        firstImportedId: result.imported.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id,
      }
    },
    { bytes: file.size }
  )

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup('clear', async () => {
    const previousSessionCount = useChatStore.getState().sessions.length
    await replaceHistory(async () => {})
    logEvent('backup', 'history.cleared', { previousSessionCount })
  })
