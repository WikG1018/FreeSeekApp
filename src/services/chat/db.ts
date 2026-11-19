import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import { allSessionMessages } from './sessionData.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { blobChunks, jsonBlob } from './history/jsonBlob.js'
import {
  historyFilesAvailable,
  pruneDiskOriginals,
  readDiskOriginal,
  removeDiskOriginals,
  type DiskOriginal,
} from './historyFiles.js'

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
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

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

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      allSessionMessages(session).flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
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
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('freeseek', DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
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
            const expected = await tx.objectStore('sessions').count()
            await summaries.clear()
            for (
              let cursor = await tx.objectStore('sessions').openCursor();
              cursor;
              cursor = await cursor.continue()
            ) {
              await summaries.put(recordSummary(cursor.value))
            }
            if ((await summaries.count()) !== expected) {
              throw new Error('Incomplete session index migration')
            }
          } catch {
            abortTransaction(tx)
          }
        })()
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

const historyTransaction = async <Mode extends 'readonly' | 'readwrite'>(mode: Mode) => {
  const database = await getDB()
  const tx = database.transaction(HISTORY_STORES, mode)
  void tx.done.catch(() => {})
  const state = tx.objectStore('historyState')
  const useStagingStores = (await state.get(ACTIVE_HISTORY_KEY)) === true
  return {
    tx,
    state,
    useStagingStores,
    databaseVersion: database.version,
    summaries: tx.objectStore('sessionSummaries'),
    sessions: tx.objectStore(useStagingStores ? 'sessionsStaging' : 'sessions'),
    files: tx.objectStore(useStagingStores ? 'filesStaging' : 'files'),
    stagingSessions: tx.objectStore(useStagingStores ? 'sessions' : 'sessionsStaging'),
    stagingFiles: tx.objectStore(useStagingStores ? 'files' : 'filesStaging'),
  }
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const view = await historyTransaction('readonly')
  const [stored, ids] = await Promise.all([
    view.summaries.getAll(),
    view.sessions.getAllKeys(),
    view.tx.done,
  ])
  const known = new Set(ids)
  if (stored.length === ids.length && stored.every(({ id }) => known.has(id))) {
    return stored.map(toSessionSummary)
  }

  const history = await historyTransaction('readwrite')
  const rebuilt: SessionSummary[] = []
  try {
    const count = await history.sessions.count()
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
    await history.tx.done
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
  logEvent(
    'storage',
    'history.index-rebuilt',
    {
      previousCount: stored.length,
      restoredCount: rebuilt.length,
    },
    'warn'
  )
  return rebuilt
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
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await history.files.put(file)
        }
        await history.sessions.put(record)
        await history.summaries.put(summary)
      } catch (error) {
        abortTransaction(history.tx)
        throw error
      }
    })(),
    history.tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const { sessions, summaries, tx } = await historyTransaction('readwrite')
  await Promise.all([
    (async () => {
      try {
        const value = await sessions.get(id)
        if (value) {
          const updated = isPacked(value)
            ? { ...value, summary: { ...value.summary, title } }
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

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const { sessions, files, summaries, tx } = await historyTransaction('readwrite')
  const removed: string[] = []
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
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  if (removed.length) {
    await removeDiskOriginals(removed).catch(reportStorageError('remove imported originals'))
  }
}

const putFiles = async (staging: boolean, files: ArchivedFile[]) => {
  const history = await historyTransaction('readwrite')
  const store = staging ? history.stagingFiles : history.files
  try {
    await Promise.all([...files.map((file) => store.put(file)), history.tx.done])
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
export const clearStaging = async (): Promise<void> => {
  const { files, stagingSessions, stagingFiles, tx } = await historyTransaction('readwrite')
  const [sessions, originals] = await Promise.all([stagingSessions.count(), stagingFiles.count()])
  const keep = await diskKeys(files)
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
  const { stagingSessions, tx } = await historyTransaction('readwrite')
  await Promise.all([stagingSessions.add(record), tx.done])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> => putFiles(true, files)

export const saveStagingDiskFile = (id: string, disk: DiskOriginal): Promise<void> =>
  putFiles(true, [{ id, disk }])

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
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const history = await historyTransaction('readwrite')
  const imported: SessionSummary[] = []
  let keep: string[] | undefined
  try {
    const expected = await history.stagingSessions.count()
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
      history.state.put(!history.useStagingStores, ACTIVE_HISTORY_KEY),
      history.sessions.clear(),
      history.files.clear(),
      history.tx.done,
    ])
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
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
  const { sessions, files, tx, databaseVersion } = await historyTransaction('readonly')
  const [sessionCount, fileCount] = await Promise.all([sessions.count(), files.count()])
  let originalBytes = 0
  for (let cursor = await files.openCursor(); cursor; cursor = await cursor.continue()) {
    const value = cursor.value
    originalBytes += 'disk' in value ? value.disk.size : value.blob.size
  }
  await tx.done
  return { databaseVersion, sessionCount, fileCount, originalBytes }
}
