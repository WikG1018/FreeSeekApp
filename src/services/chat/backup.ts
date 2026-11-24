import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import {
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

const backupFileName = (date: Date) => `freeseek-backup-${formatDate(date)}.zip`

/** 导出完整 FreeSeek 会话备份，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob; skipped: number }> =>
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
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const cached = Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : null
        const session = cached ?? (await db.loadSession(summary.id).catch(() => null))
        if (!session) {
          skipped += 1
          continue
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield await snapshotAgentHistory({ ...session, ...summary })
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), loadBackupFile)
    if (skipped && skipped === sessions.length) {
      // 一条都没读到：与其给用户一个空备份，不如明确报错。
      throw new BackupError('sessionListLoadFailed')
    }
    logEvent('backup', 'export.archive', {
      sessionCount: sessions.length - skipped,
      skipped,
      bytes: blob.size,
    })
    return { name: backupFileName(now), blob, skipped }
  })

export const exportRecoveryHistory = () =>
  enqueueBackup('export-recovery', async () => {
    const { sessions, originals } = unsavedChatSnapshot()
    if (!sessions.length) {
      return undefined
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const missing = new Set<string>()
    const blob = await exportArchive(sessions, async (id) => {
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
    })
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

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File, onProgress?: ImportProgress): Promise<number> =>
  enqueueBackup(
    'import',
    async () => {
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      await checkArchiveFormat(file)
      const previousSessionCount = useChatStore.getState().sessions.length
      let settings: NativeBackupSettings | undefined
      const count = await replaceHistory(
        async () => {
          settings = await importArchive(file, onProgress)
        },
        false,
        () => discardImportedWorkspaces(settings?.importedWorkspaces ?? [])
      )
      restoreNativeSettings(settings)
      logEvent('backup', 'import.archive', {
        previousSessionCount,
        sessionCount: count,
        bytes: file.size,
      })
      return count
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
