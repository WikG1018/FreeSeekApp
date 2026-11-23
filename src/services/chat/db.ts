import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type ChatMode, type Session, type SessionSummary } from './types.js'
import { allSessionMessages, messageFiles } from './sessionData.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { blobChunks, jsonBlob } from './history/jsonBlob.js'
import {
  browserHistoryLocks,
  historyFilesAvailable,
  pruneDiskOriginals,
  readDiskOriginal,
  removeDiskOriginals,
  type DiskOriginal,
} from './historyFiles.js'
import { BackupError } from './history/errors.js'
import { readPreviousHistory, recordHistoryCheckpoint } from './historyCheckpoint.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 15
const BLOB_SESSION_THRESHOLD = 32 * 1024 * 1024

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}
type ArchivedFile = StoredFile | { id: string; disk: DiskOriginal }

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[]; goalRunIds?: string[] }

// Large conversations can exceed WebView's single IndexedDB value limit. Store their text in a
// Blob with the list metadata alongside it, so copying and renaming don't deserialize the text.
type PackedSession = { id: string; payload: Blob; summary: StoredSessionSummary }
type StoredSession = Session | PackedSession
const isPacked = (session: StoredSession): session is PackedSession => 'payload' in session

interface ChatDB extends DBSchema {
  /** Each pair can be active or staging. IndexedDB commits the selection with the chat list. */
  sessions: { key: string; value: StoredSession }
  files: { key: string; value: ArchivedFile }
  sessionsStaging: { key: string; value: StoredSession }
  filesStaging: { key: string; value: ArchivedFile }
  historyState: { key: string; value: boolean }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
}
const HISTORY_STORES = [
  'historyState',
  'sessions',
  'files',
  'sessionsStaging',
  'filesStaging',
  'sessionSummaries',
] as const
const ACTIVE_HISTORY_KEY = 'useStagingStores'
const COMMITTED_HISTORY_KEY = 'committedUseStagingStores'
const CONFIRMED_EMPTY_KEY = 'confirmedEmpty'
const INCOMPLETE_STAGING_KEY = 'incompleteStaging'

export class HistoryMissingError extends Error {
  constructor(
    readonly canStartFresh = false,
    readonly previousHistoryKnown = true
  ) {
    super('Previously saved conversations could not be found')
  }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  mode: session.mode ?? 'chat',
  fileIds: [
    ...new Set(
      allSessionMessages(session)
        .flatMap(messageFiles)
        .map(({ id }) => id)
    ),
  ],
  goalRunIds: session.messages.flatMap((message) =>
    message.role === 'assistant' && message.task?.run?.mode === 'goal' ? [message.task.run.id] : []
  ),
})

const exceedsInlineSize = (value: unknown) => {
  let bytes = 0
  const visit = (value: unknown): boolean => {
    bytes += typeof value === 'string' ? value.length * 2 + 16 : 16
    if (bytes > BLOB_SESSION_THRESHOLD) {
      return true
    }
    if (Array.isArray(value)) {
      return value.some(visit)
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).some(([key, item]) => visit(key) || visit(item))
    }
    return false
  }
  return visit(value)
}

const sessionRecord = (session: Session, summary?: StoredSessionSummary): StoredSession =>
  exceedsInlineSize(session)
    ? { id: session.id, payload: jsonBlob(session), summary: summary ?? storedSummary(session) }
    : session

const recordSummary = (value: StoredSession) =>
  isPacked(value) ? value.summary : storedSummary(value)

const unpackSession = async (value: StoredSession): Promise<Session> => {
  if (!isPacked(value)) {
    return value
  }
  const { readJsonEntry } = await import('./history/readJson.js')
  const payload = value.payload
  const session = (await readJsonEntry(
    {
      path: 'session.json',
      size: payload.size,
      stream: blobChunks(payload),
    },
    undefined,
    'local'
  )) as Session
  if (!session || session.id !== value.id || !Array.isArray(session.messages)) {
    throw new Error('Invalid stored conversation')
  }
  return { ...session, title: value.summary.title }
}

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const openHistory = () => {
  let previousVersion: number | undefined
  logEvent('storage', 'history.db-open-started', { requestedVersion: DB_VERSION })
  const opening = openDB<ChatDB>('freeseek', DB_VERSION, {
    blocked(currentVersion, blockedVersion) {
      logEvent(
        'storage',
        'history.db-open-blocked',
        {
          previousVersion: currentVersion,
          requestedVersion: blockedVersion,
        },
        'warn'
      )
    },
    blocking(_current, _blocked, event) {
      const database = event.target as IDBDatabase
      database.close()
      if (dbPromise === opening) {
        dbPromise = null
      }
    },
    terminated() {
      if (dbPromise === opening) {
        dbPromise = null
      }
      logEvent('storage', 'history.connection-terminated', {}, 'warn')
    },
    upgrade(db, oldVersion, _newVersion, tx) {
      previousVersion = oldVersion
      logEvent('storage', 'history.db-upgrade-started', {
        previousVersion,
        requestedVersion: DB_VERSION,
      })
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      if (!db.objectStoreNames.contains('historyState')) {
        db.createObjectStore('historyState')
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      // v13 重建旧 WebView 可能未遍历完整的摘要/引用索引，正文与原件保持原样。
      if (oldVersion < 13) {
        void (async () => {
          try {
            const staged = (await tx.objectStore('historyState').get(ACTIVE_HISTORY_KEY)) === true
            const sessions = tx.objectStore(staged ? 'sessionsStaging' : 'sessions')
            const expected = await sessions.count()
            await summaries.clear()
            for (
              let cursor = await sessions.openCursor();
              cursor;
              cursor = await cursor.continue()
            ) {
              await summaries.put(recordSummary(cursor.value))
            }
            if ((await summaries.count()) !== expected) {
              throw new Error('Incomplete session index migration')
            }
          } catch (error) {
            logEvent(
              'storage',
              'history.db-upgrade-failed',
              { previousVersion, ...diagnosticError(error) },
              'error'
            )
            abortTransaction(tx)
          }
        })()
      }
    },
  })
    .then((database) => {
      logEvent('storage', 'history.db-opened', {
        databaseVersion: database.version,
        previousVersion,
        createdDatabase: previousVersion === 0,
      })
      return database
    })
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      if (dbPromise === opening) {
        dbPromise = null
      }
      logEvent(
        'storage',
        'history.db-open-failed',
        { requestedVersion: DB_VERSION, ...diagnosticError(error) },
        'error'
      )
      throw error
    })
  return opening
}
const getDB = () => (dbPromise ??= openHistory())

const historyTransaction = async <Mode extends 'readonly' | 'readwrite'>(mode: Mode) => {
  const opening = getDB()
  let database = await opening
  const begin = () => database.transaction(HISTORY_STORES, mode)
  let tx: ReturnType<typeof begin>
  try {
    tx = begin()
  } catch (error) {
    // Some WebViews invalidate the connection before delivering the close event.
    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') {
      throw error
    }
    if (dbPromise === opening) {
      dbPromise = null
      database.close()
    }
    logEvent('storage', 'history.connection-reopening', { mode }, 'warn')
    database = await getDB()
    tx = begin()
  }
  void tx.done.catch(() => {})
  const state = tx.objectStore('historyState')
  const [selector, committed] = await Promise.all([
    state.get(ACTIVE_HISTORY_KEY),
    state.get(COMMITTED_HISTORY_KEY),
  ])
  const selectorPresent = typeof selector === 'boolean'
  const committedSelectorPresent = typeof committed === 'boolean'
  const useStagingStores = (selectorPresent ? selector : committed) === true
  return {
    tx,
    state,
    useStagingStores,
    selectorPresent,
    committedSelectorPresent,
    selectionConfirmed: selector === useStagingStores && committed === useStagingStores,
    selectionConflict: selectorPresent && committedSelectorPresent && selector !== committed,
    databaseVersion: database.version,
    summaries: tx.objectStore('sessionSummaries'),
    sessions: tx.objectStore(useStagingStores ? 'sessionsStaging' : 'sessions'),
    files: tx.objectStore(useStagingStores ? 'filesStaging' : 'files'),
    stagingSessions: tx.objectStore(useStagingStores ? 'sessions' : 'sessionsStaging'),
    stagingFiles: tx.objectStore(useStagingStores ? 'files' : 'filesStaging'),
  }
}

type HistoryView = Awaited<ReturnType<typeof historyTransaction>>
type WritableHistoryView = Awaited<ReturnType<typeof historyTransaction<'readwrite'>>>

const confirmHistorySelection = (view: WritableHistoryView, usingStaging = view.useStagingStores) =>
  Promise.all([
    view.state.put(usingStaging, ACTIVE_HISTORY_KEY),
    view.state.put(usingStaging, COMMITTED_HISTORY_KEY),
  ])

const inspectHistoryIndex = async (view: HistoryView) => {
  const [stored, indexCount, ids, activeCount, alternateCount, confirmedEmpty, interruptedImport] =
    await Promise.all([
      view.summaries.getAll(),
      view.summaries.count(),
      view.sessions.getAllKeys(),
      view.sessions.count(),
      view.stagingSessions.count(),
      view.state.get(CONFIRMED_EMPTY_KEY),
      view.state.get(INCOMPLETE_STAGING_KEY),
    ])
  if (stored.length !== indexCount || ids.length !== activeCount) {
    logEvent(
      'storage',
      'history.index-read-incomplete',
      {
        indexCount,
        indexEntryCount: stored.length,
        activeCount,
        actualKeyCount: ids.length,
        alternateCount,
        usingStagingStores: view.useStagingStores,
      },
      'error'
    )
    throw new Error('Incomplete conversation list read')
  }
  const matches = (keys: string[]) => {
    const known = new Set(keys)
    return stored.length === keys.length && stored.every(({ id }) => known.has(id))
  }
  const current = matches(ids)
  const alternate =
    !current &&
    indexCount > 0 &&
    indexCount === alternateCount &&
    matches(await view.stagingSessions.getAllKeys())
  return {
    stored,
    indexCount,
    activeCount,
    alternateCount,
    confirmedEmpty: confirmedEmpty === true,
    interruptedImport: interruptedImport === true,
    current,
    alternate,
  }
}

export const loadSessionSummaries = async ({
  previousSelection = false,
  allowEmpty = false,
  forReplacement = false,
}: { previousSelection?: boolean; allowEmpty?: boolean; forReplacement?: boolean } = {}): Promise<
  SessionSummary[]
> => {
  const view = await historyTransaction('readonly')
  const index = await inspectHistoryIndex(view)
  await view.tx.done
  logEvent('storage', 'history.index-checked', {
    sessionCount: index.activeCount,
    indexCount: index.indexCount,
    alternateCount: index.alternateCount,
    confirmedEmpty: index.confirmedEmpty,
    usingStagingStores: view.useStagingStores,
    selectorPresent: view.selectorPresent,
    committedSelectorPresent: view.committedSelectorPresent,
    selectionConflict: view.selectionConflict,
    interruptedImport: index.interruptedImport,
  })
  if (forReplacement && index.activeCount === 0 && index.alternateCount === 0) {
    // A verified replacement can proceed even if only old index entries survived. That
    // index is left intact until the replacement has been validated and is ready to commit.
    return []
  }
  if (allowEmpty && index.current && index.activeCount === 0 && index.alternateCount === 0) {
    logEvent('storage', 'history.started-without-restore')
    return []
  }
  if (!index.activeCount && !index.alternate && !index.confirmedEmpty) {
    if (index.alternateCount > 0 && (!index.interruptedImport || view.selectionConflict)) {
      // An old import could have left either committed records or incomplete staging here.
      // Without an index or a recorded commit, neither exposing nor deleting them is safe.
      logEvent(
        'storage',
        'history.selection-uncertain',
        {
          indexCount: index.indexCount,
          alternateCount: index.alternateCount,
          selectorPresent: view.selectorPresent,
          committedSelectorPresent: view.committedSelectorPresent,
          selectionConflict: view.selectionConflict,
        },
        'warn'
      )
      throw new HistoryMissingError()
    }
    const previous = await readPreviousHistory()
    const expected = previousSelection || previous.present
    const canStartFresh = index.indexCount === 0 && index.alternateCount === 0
    // A late native reply is not evidence that an existing installation is empty.
    if (!expected && previous.timedOut && !allowEmpty) {
      throw new HistoryMissingError(canStartFresh, false)
    }
    // An incomplete import can also leave data in the other store. Only switch stores when
    // every session ID matches the committed index, and keep ambiguous records intact.
    if (index.indexCount > 0 || (expected && (!allowEmpty || index.alternateCount > 0))) {
      logEvent(
        'storage',
        'history.unexpected-empty',
        {
          indexCount: index.indexCount,
          alternateCount: index.alternateCount,
          previousSelection,
          expected,
          previousSessionCount: previous.sessionCount,
          verifiedAt: previous.verifiedAt,
          checkpointPresent: previous.present,
        },
        'warn'
      )
      throw new HistoryMissingError(canStartFresh)
    }
  }
  if (index.current && (view.selectionConfirmed || index.activeCount === 0)) {
    if (index.activeCount > 0) {
      recordHistoryCheckpoint(true, index.activeCount)
    }
    return index.stored.map(toSessionSummary)
  }

  const history = await historyTransaction('readwrite')
  const rebuilt: SessionSummary[] = []
  try {
    const latest = await inspectHistoryIndex(history)
    if (latest.current) {
      if (latest.activeCount > 0 && !history.selectionConfirmed) {
        await confirmHistorySelection(history)
      }
      await history.tx.done
      if (latest.activeCount > 0) {
        recordHistoryCheckpoint(true, latest.activeCount)
      }
      return latest.stored.map(toSessionSummary)
    }
    if (latest.alternate) {
      await confirmHistorySelection(history, !history.useStagingStores)
      await history.state.delete(CONFIRMED_EMPTY_KEY)
      await history.state.delete(INCOMPLETE_STAGING_KEY)
      await history.tx.done
      recordHistoryCheckpoint(true, latest.indexCount)
      logEvent(
        'storage',
        'history.store-selection-recovered',
        { sessionCount: latest.indexCount },
        'warn'
      )
      return latest.stored.map(toSessionSummary)
    }
    const count = latest.activeCount
    if (count === 0) {
      throw new HistoryMissingError()
    }
    await history.summaries.clear()
    for (
      let cursor = await history.sessions.openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      const summary = recordSummary(cursor.value)
      await history.summaries.put(summary)
      rebuilt.push(toSessionSummary(summary))
    }
    if (rebuilt.length !== count || (await history.summaries.count()) !== count) {
      throw new Error('Incomplete history index repair')
    }
    if (!history.selectionConfirmed) {
      await confirmHistorySelection(history)
    }
    await history.tx.done
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
  recordHistoryCheckpoint(true, rebuilt.length)
  logEvent(
    'storage',
    'history.index-rebuilt',
    {
      previousCount: index.indexCount,
      restoredCount: rebuilt.length,
    },
    'warn'
  )
  return rebuilt
}

/** Repair old list metadata in small batches after history has opened. */
export const backfillSessionModes = async (
  ids: readonly string[],
  shouldContinue: () => boolean,
  publish: (modes: ReadonlyMap<string, ChatMode>) => void
) => {
  const report = reportStorageError('read legacy conversation type')
  for (let start = 0; start < ids.length && shouldContinue(); start += 16) {
    const batch = ids.slice(start, start + 16)
    const view = await historyTransaction('readonly')
    if (!view.selectionConfirmed || !shouldContinue()) {
      return
    }
    const packed: PackedSession[] = []
    const candidates: { id: string; mode: ChatMode; createdAt: number }[] = []
    for (const id of batch) {
      const entry = await view.sessions.get(id)
      if (!entry) {
        continue
      }
      if (isPacked(entry) && entry.summary.mode === undefined) {
        packed.push(entry)
      } else {
        const { createdAt, mode } = isPacked(entry) ? entry.summary : entry
        candidates.push({ id, mode: mode ?? 'chat', createdAt })
      }
    }
    await view.tx.done

    for (const entry of packed) {
      if (!shouldContinue()) {
        return
      }
      try {
        const mode = (await unpackSession(entry)).mode ?? 'chat'
        candidates.push({ id: entry.id, mode, createdAt: entry.summary.createdAt })
      } catch (error) {
        report(error)
      }
    }
    if (!shouldContinue() || !candidates.length) {
      continue
    }
    const current = await historyTransaction('readwrite')
    if (
      !shouldContinue() ||
      !current.selectionConfirmed ||
      current.useStagingStores !== view.useStagingStores
    ) {
      return
    }
    const modes = new Map<string, ChatMode>()
    for (const { id, mode, createdAt } of candidates) {
      const saved = await current.summaries.get(id)
      if (saved && saved.createdAt === createdAt) {
        if (saved.mode === undefined) {
          await current.summaries.put({ ...saved, mode })
        }
        modes.set(id, saved.mode ?? mode)
      }
    }
    await current.tx.done
    if (modes.size && shouldContinue()) {
      publish(modes)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const { sessions, tx } = await historyTransaction('readonly')
  const [record] = await Promise.all([sessions.get(id), tx.done])
  return record === undefined ? undefined : unpackSession(record)
}

/** 读取全部会话详情；用于本地用量统计等一次性遍历 */
export const loadAllSessions = async (): Promise<Session[]> => {
  const { sessions, tx } = await historyTransaction('readonly')
  const [records] = await Promise.all([sessions.getAll(), tx.done])
  const all: Session[] = []
  for (const record of records) {
    all.push(await unpackSession(record))
  }
  return all
}

/** 用游标逐个处理会话，统计时只保留当前会话的内容。 */
export const visitStoredSessions = async (
  visit: (session: Session) => void,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  const { sessions, tx } = await historyTransaction('readonly')
  const packed: PackedSession[] = []
  const stop = () => abortTransaction(tx)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    await Promise.all([
      (async () => {
        try {
          signal?.throwIfAborted()
          for (let cursor = await sessions.openCursor(); cursor; cursor = await cursor.continue()) {
            const value = cursor.value
            if (isPacked(value)) {
              packed.push(value)
            } else {
              visit(value)
            }
          }
        } catch (error) {
          stop()
          throw error
        }
      })(),
      tx.done,
    ])
    for (const value of packed) {
      signal?.throwIfAborted()
      const session = await unpackSession(value)
      signal?.throwIfAborted()
      visit(session)
    }
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const record = sessionRecord(session, summary)
  const history = await historyTransaction('readwrite')
  let newSessionCount: number | undefined
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await history.files.put(file)
        }
        const existing = await history.sessions.getKey(session.id)
        await history.sessions.put(record)
        await history.summaries.put(summary)
        await history.state.delete(CONFIRMED_EMPTY_KEY)
        if (!history.selectionConfirmed) {
          await confirmHistorySelection(history)
        }
        if (existing === undefined) {
          newSessionCount = await history.sessions.count()
        }
      } catch (error) {
        abortTransaction(history.tx)
        throw error
      }
    })(),
    history.tx.done,
  ])
  recordHistoryCheckpoint(true, newSessionCount)
  if (newSessionCount !== undefined) {
    logEvent('storage', 'history.session-created', {
      sessionCount: newSessionCount,
      fileCount: files.length,
    })
  }
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const { sessions, summaries, tx } = await historyTransaction('readwrite')
  await Promise.all([
    (async () => {
      try {
        const value = await sessions.get(id)
        if (value) {
          const mode =
            isPacked(value) && value.summary.mode === undefined
              ? (await summaries.get(id))?.mode
              : undefined
          const updated = isPacked(value)
            ? { ...value, summary: { ...value.summary, title, ...(mode && { mode }) } }
            : { ...value, title }
          await sessions.put(updated)
          await summaries.put(recordSummary(updated))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const loadSessionGoalRuns = async (sessionId: string): Promise<string[]> => {
  const { summaries, tx } = await historyTransaction('readonly')
  const [summary] = await Promise.all([summaries.get(sessionId), tx.done])
  return summary?.goalRunIds?.filter((id) => /^[\w-]{1,80}$/.test(id)) ?? []
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const { sessions, files, summaries, state, tx } = await historyTransaction('readwrite')
  const removed: string[] = []
  let sessionCount: number | undefined
  await Promise.all([
    (async () => {
      try {
        const summary = await summaries.get(sessionId)
        await sessions.delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            const file = await files.get(id)
            if (file && 'disk' in file) {
              removed.push(file.disk.key)
            }
            await files.delete(id)
          }
        }
        if (summary) {
          sessionCount = await sessions.count()
          if (sessionCount === 0) {
            await state.put(true, CONFIRMED_EMPTY_KEY)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  if (sessionCount !== undefined) {
    recordHistoryCheckpoint(sessionCount > 0, sessionCount)
    logEvent('storage', 'history.delete-committed', { sessionCount })
  }
  if (removed.length) {
    await removeDiskOriginals(removed).catch(reportStorageError('remove imported originals'))
  }
}

const putFiles = async (staging: boolean, files: ArchivedFile[]) => {
  const history = await historyTransaction('readwrite')
  const store = staging ? history.stagingFiles : history.files
  try {
    await Promise.all([
      ...files.map((file) => store.put(file)),
      ...(staging && files.length ? [history.state.put(true, INCOMPLETE_STAGING_KEY)] : []),
      history.tx.done,
    ])
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles(false, files)

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const { files, tx } = await historyTransaction('readonly')
  const [record] = await Promise.all([files.get(id), tx.done])
  return record && ('disk' in record ? readDiskOriginal(record.disk) : record.blob)
}

const diskKeys = async (files: {
  getAll(): Promise<ArchivedFile[]>
  count(): Promise<number>
}): Promise<string[] | undefined> => {
  if (!historyFilesAvailable()) {
    return undefined
  }
  const [records, count] = await Promise.all([files.getAll(), files.count()])
  if (records.length !== count) {
    throw new Error('Incomplete list of saved attachments')
  }
  return records.flatMap((file) => ('disk' in file ? [file.disk.key] : []))
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (onlyInterrupted = false): Promise<void> => {
  const view = await historyTransaction('readwrite')
  const { files, stagingSessions, stagingFiles, state, tx } = view
  if (onlyInterrupted) {
    if (!(await state.get(INCOMPLETE_STAGING_KEY))) {
      await tx.done
      return
    }
    const index = await inspectHistoryIndex(view)
    if (
      !view.selectionConfirmed ||
      !index.current ||
      (!index.activeCount && !index.confirmedEmpty)
    ) {
      await tx.done
      return
    }
  }
  const [sessions, originals] = await Promise.all([stagingSessions.count(), stagingFiles.count()])
  const keep = await diskKeys(files)
  await state.delete(INCOMPLETE_STAGING_KEY)
  if (sessions || originals) {
    await Promise.all([stagingSessions.clear(), stagingFiles.clear(), tx.done])
    logEvent('storage', 'history.staging-cleared', { sessions, originals })
  } else {
    await tx.done
  }
  if (keep) {
    await pruneDiskOriginals(keep).catch(reportStorageError('clean unfinished import originals'))
  }
}

export const addStagingSession = async (session: Session): Promise<void> => {
  const record = sessionRecord(session)
  const { stagingSessions, state, tx } = await historyTransaction('readwrite')
  await Promise.all([stagingSessions.add(record), state.put(true, INCOMPLETE_STAGING_KEY), tx.done])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> => putFiles(true, files)

export const saveStagingDiskFile = (id: string, disk: DiskOriginal): Promise<void> =>
  putFiles(true, [{ id, disk }])

const HISTORY_REPLACEMENT_LOCK = 'freeseek:history-replacement'

export const withHistoryReplacement = <T>(work: () => Promise<T>): Promise<T> =>
  browserHistoryLocks()?.request(HISTORY_REPLACEMENT_LOCK, { ifAvailable: true }, (lock) => {
    if (!lock) {
      throw new BackupError('backupOtherTabBusy')
    }
    return work()
  }) ?? work()

/** Only reclaim an interrupted import whose staging store was marked before writing. */
export const recoverStaging = async () => {
  const locks = browserHistoryLocks()
  if (!locks) {
    await clearStaging(true)
    return
  }
  await locks.request(HISTORY_REPLACEMENT_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) {
      await clearStaging(true)
    }
  })
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (
  types: ReadonlyMap<string, string>,
  sessionIds: ReadonlySet<string>
): Promise<void> => {
  // 无图片或未保存原件时所有 MIME 已是空值；不要为了空操作重新读取巨型会话。
  if (types.size === 0 || sessionIds.size === 0) {
    return
  }
  for (const id of sessionIds) {
    const read = await historyTransaction('readonly')
    const [value] = await Promise.all([read.stagingSessions.get(id), read.tx.done])
    if (!value) {
      continue
    }
    const session = await unpackSession(value)
    let changed = false
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        const type = types.get(file.id) ?? ''
        if (file.mimeType !== type) {
          file.mimeType = type
          changed = true
        }
      }
    }
    if (changed) {
      const record = sessionRecord(session)
      const { stagingSessions, tx } = await historyTransaction('readwrite')
      await Promise.all([stagingSessions.put(record), tx.done])
    }
  }
}

/**
 * Both sets of records already live in this database. Rebuild the small chat list, make
 * the staged set active, and clear the old set in one transaction. The payload stays put.
 */
export const commitStaging = async (allowEmpty = true): Promise<SessionSummary[]> => {
  const history = await historyTransaction('readwrite')
  const imported: SessionSummary[] = []
  let keep: string[] | undefined
  let previousSessionCount: number
  try {
    previousSessionCount = await history.sessions.count()
    const expected = await history.stagingSessions.count()
    if (!allowEmpty && expected === 0) {
      throw new BackupError('backupEmptyHistory')
    }
    await history.summaries.clear()
    for (
      let cursor = await history.stagingSessions.openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      const summary = recordSummary(cursor.value)
      await history.summaries.put(summary)
      imported.push(toSessionSummary(summary))
    }
    if (imported.length !== expected || (await history.summaries.count()) !== expected) {
      throw new Error('Incomplete history replacement')
    }
    keep = await diskKeys(history.stagingFiles)
    await Promise.all([
      confirmHistorySelection(history, !history.useStagingStores),
      history.state.put(expected === 0, CONFIRMED_EMPTY_KEY),
      history.state.delete(INCOMPLETE_STAGING_KEY),
      history.sessions.clear(),
      history.files.clear(),
      history.tx.done,
    ])
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
  recordHistoryCheckpoint(imported.length > 0, imported.length)
  logEvent('storage', 'history.replacement-committed', {
    previousSessionCount,
    sessionCount: imported.length,
    usingStagingStores: !history.useStagingStores,
  })
  if (keep) {
    await pruneDiskOriginals(keep).catch(reportStorageError('clean replaced originals'))
  }
  return imported
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  logEvent('storage', 'operation.failed', { operation: action, ...diagnosticError(error) }, 'error')
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** 诊断仅取数量和体积，不读取会话正文或附件字节。 */
export const getStorageSummary = async () => {
  const { sessions, files, summaries, stagingSessions, useStagingStores, tx, databaseVersion } =
    await historyTransaction('readonly')
  const [sessionCount, fileCount] = await Promise.all([sessions.count(), files.count()])
  const [indexCount, alternateSessionCount] = await Promise.all([
    summaries.count(),
    stagingSessions.count(),
  ])
  let originalBytes = 0
  for (let cursor = await files.openCursor(); cursor; cursor = await cursor.continue()) {
    const value = cursor.value
    originalBytes += 'disk' in value ? value.disk.size : value.blob.size
  }
  await tx.done
  return {
    databaseVersion,
    sessionCount,
    fileCount,
    originalBytes,
    indexCount,
    alternateSessionCount,
    useStagingStores,
  }
}
