import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { toSessionSummary, type ChatMode, type Session, type SessionSummary } from './types.js'
import { sessionOriginalIds } from './sessionData.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { blobChunks, jsonBlob } from './history/jsonBlob.js'
import {
  browserHistoryLocks,
  checkDiskOriginal,
  historyFilesAvailable,
  pruneDiskOriginals,
  readDiskOriginal,
  removeDiskOriginals,
  type DiskOriginal,
} from './historyFiles.js'
import { BackupError } from './history/errors.js'
import { readLocalCheckpoint, readPreviousHistory, recordHistoryCheckpoint } from './historyCheckpoint.js'
import { createId } from '../../utils/id.js'
import type { StartupPagePreference } from '../settings.js'
import { historyVaultAvailable } from './historyVaultNative.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 15
const BLOB_SESSION_THRESHOLD = 32 * 1024 * 1024
const UPGRADE_BLOCKED_TIMEOUT_MS = 2_000

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}
type ArchivedFile = (StoredFile | { id: string; disk: DiskOriginal }) & { revision?: string }

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & {
  fileIds: string[]
  goalRunIds?: string[]
  revision?: string
  vaultRevision?: string
}

// Large conversations can exceed WebView's single IndexedDB value limit. Store their text in a
// Blob with the list metadata alongside it, so copying and renaming don't deserialize the text.
type PackedSession = { id: string; payload: Blob; summary: StoredSessionSummary }
type StoredSession = Session | PackedSession
// This token follows an in-memory edit only. It is never included in an archive or API request.
type EditVersion = { exists: boolean; revision?: string; writing?: Promise<void> }
const editVersions = new WeakMap<Session, EditVersion>()
export const continueSessionEdit = (previous: Session, next: Session) => {
  const version = editVersions.get(previous)
  if (version) {
    editVersions.set(next, version)
  }
}
export class ChangedSessionError extends Error {
  constructor() {
    super('Saved conversation changed in another window')
    this.name = 'ChangedSessionError'
  }
}
const isPacked = (session: StoredSession): session is PackedSession => 'payload' in session

interface ChatDB extends DBSchema {
  /** Each pair can be active or staging. IndexedDB commits the selection with the chat list. */
  sessions: { key: string; value: StoredSession }
  files: { key: string; value: ArchivedFile }
  sessionsStaging: { key: string; value: StoredSession }
  filesStaging: { key: string; value: ArchivedFile }
  historyState: { key: string; value: boolean | StartupPagePreference | { activeChat: string | null } | { vaultCommit: string } }
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
const INCOMPLETE_FILE_REFERENCES_KEY = 'incompleteFileReferences'

export type HistoryRecoveryReason =
  | 'empty-after-known-history'
  | 'unreadable'
  | 'read-timeout'
  | 'checkpoint-timeout'
  | 'selection-uncertain'

export class HistoryMissingError extends Error {
  constructor(
    readonly reason: HistoryRecoveryReason,
    readonly canStartFresh = false,
    readonly previousHistoryKnown = true
  ) {
    super('Previously saved conversations could not be read')
    this.name = 'HistoryMissingError'
  }
}

export class HistoryUpgradeBlockedError extends Error {
  constructor() {
    super('An older window is blocking the history upgrade')
    this.name = 'HistoryUpgradeBlockedError'
  }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  mode: session.mode ?? 'chat',
  fileIds: sessionOriginalIds(session),
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

const validSummary = (value: StoredSessionSummary | undefined) =>
  value &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  Number.isFinite(value.createdAt) &&
  Number.isFinite(value.updatedAt) &&
  Array.isArray(value.fileIds) &&
  value.fileIds.every((id) => typeof id === 'string')

const recoverSummary = (
  id: string,
  value: StoredSession,
  previous: StoredSessionSummary | undefined
): { summary: StoredSessionSummary; incomplete: boolean } => {
  try {
    const summary = recordSummary(value)
    if (validSummary(summary) && summary.id === id) {
      return {
        summary: previous?.revision ? { ...summary, revision: previous.revision } : summary,
        incomplete: false,
      }
    }
  } catch {
    // Retain a partial row so a malformed conversation cannot block other chats.
  }
  const header = isPacked(value) ? value.summary : value
  const prior = validSummary(previous) ? previous : undefined
  const title = typeof header?.title === 'string' ? header.title : (prior?.title ?? '')
  const createdAt = Number.isFinite(header?.createdAt) ? header.createdAt : (prior?.createdAt ?? 0)
  return {
    summary: {
      id,
      title,
      createdAt,
      updatedAt: Number.isFinite(header?.updatedAt) ? header.updatedAt : (prior?.updatedAt ?? createdAt),
      pinned: header?.pinned === true,
      mode: header?.mode === 'agent' ? 'agent' : 'chat',
      fileIds: Array.isArray(previous?.fileIds)
        ? previous.fileIds.filter((id) => typeof id === 'string')
        : [],
      revision: previous?.revision,
    },
    incomplete: true,
  }
}

const unpackSession = async (value: StoredSession): Promise<Session> => {
  if (!isPacked(value)) {
    if (!Array.isArray(value.messages)) {
      throw new Error('Invalid stored conversation')
    }
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
  return {
    ...session,
    title: typeof value.summary?.title === 'string' ? value.summary.title : session.title,
  }
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
  let blockedTimer: ReturnType<typeof setTimeout> | undefined
  let abandoned = false
  let rejectBlocked: (error: HistoryUpgradeBlockedError) => void = () => {}
  const blocked = new Promise<never>((_, reject) => {
    rejectBlocked = reject
  })
  logEvent('storage', 'history.db-open-started', { requestedVersion: DB_VERSION })
  const request = openDB<ChatDB>('freeseek', DB_VERSION, {
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
      blockedTimer ??= setTimeout(() => {
        abandoned = true
        rejectBlocked(new HistoryUpgradeBlockedError())
      }, UPGRADE_BLOCKED_TIMEOUT_MS)
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
      // 连接被系统中断后，内存里的会话列表可能已经与库对不上（库被清空时会只剩幽灵条目）。
      // 通知上层重新读一次列表，别让用户对着已经不存在的会话点来点去。
      try {
        window.dispatchEvent(new Event('freeseek:history-terminated'))
      } catch {
        /* 非浏览器环境忽略。 */
      }
    },
    upgrade(db, oldVersion, _newVersion, tx) {
      clearTimeout(blockedTimer)
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
            const state = tx.objectStore('historyState')
            const staged = (await state.get(ACTIVE_HISTORY_KEY)) === true
            const sessions = tx.objectStore(staged ? 'sessionsStaging' : 'sessions')
            const expected = await sessions.count()
            const previous = new Map(
              (await summaries.getAll()).map((summary) => [summary.id, summary])
            )
            let incomplete = 0
            await summaries.clear()
            for (
              let cursor = await sessions.openCursor();
              cursor;
              cursor = await cursor.continue()
            ) {
              const { summary, incomplete: partial } = recoverSummary(
                cursor.primaryKey,
                cursor.value,
                previous.get(cursor.primaryKey)
              )
              await summaries.put(summary)
              incomplete += Number(partial)
            }
            if ((await summaries.count()) !== expected) {
              throw new Error('Incomplete session index migration')
            }
            await state.put(incomplete > 0, INCOMPLETE_FILE_REFERENCES_KEY)
            if (incomplete) {
              logEvent(
                'storage',
                'history.index-recovery-records-unreadable',
                { count: incomplete },
                'warn'
              )
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
  // IndexedDB cannot cancel a blocked open request. Close its handle if it opens after the timeout.
  void request.then((database) => {
    if (abandoned) {
      database.close()
    }
  }, () => {})
  const opening = Promise.race([request, blocked])
    .then((database) => {
      logEvent('storage', 'history.db-opened', {
        databaseVersion: database.version,
        previousVersion,
        createdDatabase: previousVersion === 0,
      })
      return database
    })
    .finally(() => clearTimeout(blockedTimer))
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

// The WebView can be killed after a chat is committed but before localStorage flushes.
// A stored null preserves an explicitly opened home screen across the same interruption.
const ACTIVE_CHAT_KEY = 'activeChat'
type StartupRoute = { activeChat?: string | null; startupPage?: StartupPagePreference }
const nativeRoute = registerPlugin<{
  read(): Promise<StartupRoute>
  save(value: StartupRoute): Promise<void>
}>('StartupRoute')
const hasNativeRoute = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('StartupRoute')
export const saveActiveChat = async (id: string | null) => {
  if (hasNativeRoute()) {
    await nativeRoute.save({ activeChat: id })
    return
  }
  const db = await getDB()
  await db.put('historyState', { activeChat: id }, ACTIVE_CHAT_KEY)
}

export const saveStartupPreference = async (startupPage: StartupPagePreference) => {
  if (hasNativeRoute()) {
    await nativeRoute.save({ startupPage })
    return
  }
  await (await getDB()).put('historyState', startupPage, 'startupPage')
}

export const loadStartupRoute = async () => {
  const native = hasNativeRoute() ? await nativeRoute.read().catch((error: unknown) => {
    logEvent('storage', 'active-session.native-route-unavailable', diagnosticError(error), 'warn')
    return undefined
  }) : undefined
  if (native && native.startupPage !== undefined && native.activeChat !== undefined) {
    return { ...native, pageSource: 'native', chatSource: 'native' }
  }
  const tx = (await getDB()).transaction('historyState', 'readonly')
  const [value, choice] = await Promise.all([tx.store.get(ACTIVE_CHAT_KEY), tx.store.get('startupPage'), tx.done])
  const activeChat = value && typeof value === 'object' && 'activeChat' in value &&
    (value.activeChat === null || typeof value.activeChat === 'string') ? value.activeChat : undefined
  const startupPage = choice === 'last-chat' || choice === 'new-chat' ? choice : undefined
  return {
    activeChat, startupPage, ...native,
    pageSource: native?.startupPage !== undefined ? 'native' : 'database',
    chatSource: native?.activeChat !== undefined ? 'native' : 'database',
  }
}

const historyTransaction = async <Mode extends 'readonly' | 'readwrite'>(mode: Mode, durable = false) => {
  const opening = getDB()
  let database = await opening
  const begin = () => {
    if (durable) {
      try {
        return database.transaction(HISTORY_STORES, mode, { durability: 'strict' })
      } catch (error) {
        // Older WebViews may reject the optional transaction dictionary.
        if (!(error instanceof TypeError)) {
          throw error
        }
      }
    }
    return database.transaction(HISTORY_STORES, mode)
  }
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

const inspectHistoryIndex = async (view: HistoryView, { tolerant = false } = {}) => {
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
    // 容错模式：把计数不一致交给上层重建，而不是把整个历史列表挡在报错页。
    if (!tolerant) {
      throw new Error('Incomplete conversation list read')
    }
  }
  const matches = (keys: string[], count: number) => {
    if (count !== indexCount || keys.length !== count || stored.length !== indexCount) {
      return false
    }
    const known = new Set(keys)
    return stored.every((summary) => validSummary(summary) && known.has(summary.id))
  }
  const current = matches(ids, activeCount)
  const alternate =
    !current &&
    indexCount > 0 &&
    indexCount === alternateCount &&
    matches(await view.stagingSessions.getAllKeys(), alternateCount)
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

const canRestoreOtherBank = (
  view: HistoryView,
  index: Awaited<ReturnType<typeof inspectHistoryIndex>>
) =>
  !index.interruptedImport &&
  !index.confirmedEmpty &&
  ((index.alternate && (!view.selectionConfirmed || index.activeCount === 0)) ||
    (view.selectionConflict && index.activeCount === 0 && index.alternateCount > 0))

const historySelectionUnresolved = (
  view: HistoryView,
  index: Awaited<ReturnType<typeof inspectHistoryIndex>>
) =>
  !view.selectionConfirmed &&
  (view.selectionConflict || (index.alternateCount > 0 && !index.interruptedImport))

type HistoryLoadOptions = {
  previousSelection?: boolean
  allowEmpty?: boolean
  forReplacement?: boolean
}

const checkEmptyHistory = async (
  view: HistoryView,
  index: Awaited<ReturnType<typeof inspectHistoryIndex>>,
  { previousSelection = false, allowEmpty = false, forReplacement = false }: HistoryLoadOptions
) => {
  if (index.confirmedEmpty || (forReplacement && index.alternateCount === 0)) {
    return
  }
  if (allowEmpty && index.current && index.alternateCount === 0) {
    logEvent('storage', 'history.started-without-restore')
    return
  }
  if (index.alternateCount > 0 && (!index.interruptedImport || view.selectionConflict)) {
    const historyReason = 'selection-uncertain'
    logEvent(
      'storage',
      'history.selection-uncertain',
      {
        historyReason,
        activeCount: index.activeCount,
        indexCount: index.indexCount,
        alternateCount: index.alternateCount,
        selectorPresent: view.selectorPresent,
        committedSelectorPresent: view.committedSelectorPresent,
        selectionConflict: view.selectionConflict,
      },
      'warn'
    )
    throw new HistoryMissingError(historyReason)
  }
  const previous = await readPreviousHistory()
  const expected = previous.present || (previousSelection && !previous.confirmedEmpty)
  const canStartFresh = index.indexCount === 0 && index.alternateCount === 0
  if (!expected && previous.timedOut && !allowEmpty) {
    logEvent('storage', 'history.checkpoint-read-timed-out', {
      historyReason: 'checkpoint-timeout',
      canStartFresh,
    }, 'warn')
  }
  if (index.indexCount > 0 || (expected && (!allowEmpty || index.alternateCount > 0))) {
    const knownEmpty =
      expected && index.activeCount === 0 && index.current && canStartFresh && !index.interruptedImport
    const historyReason = view.selectionConflict
      ? 'selection-uncertain'
      : previous.timedOut
        ? 'checkpoint-timeout'
        : knownEmpty
          ? 'empty-after-known-history'
          : 'unreadable'
    logEvent(
      'storage',
      'history.unexpected-empty',
      {
        historyReason,
        activeCount: index.activeCount,
        indexCount: index.indexCount,
        alternateCount: index.alternateCount,
        previousSelection,
        expected,
        previousSessionCount: previous.sessionCount,
        verifiedAt: previous.verifiedAt,
        checkpointPresent: previous.present,
        canStartFresh,
      },
      'warn'
    )
    throw new HistoryMissingError(historyReason, canStartFresh)
  }
}

export const loadSessionSummaries = async (
  options: HistoryLoadOptions = {}
): Promise<SessionSummary[]> => {
  const view = await historyTransaction('readonly')
  let index: Awaited<ReturnType<typeof inspectHistoryIndex>> | undefined
  try {
    index = await inspectHistoryIndex(view)
  } catch (error) {
    // 摘要表与主表的计数在同一只读事务里对不上：索引坏了，不阻断启动，直接走重建。
    logEvent('storage', 'history.index-repair-needed', diagnosticError(error), 'warn')
  }
  await view.tx.done
  if (!index) {
    return reconstructHistoryIndex(options)
  }
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
  // 数量骤降要留证据：下面的守卫只处理「变成 0」，而库被系统清空后往往只剩被回写的一两条，
  // 从 205 掉到 1 反而一声不响地通过（线上真的发生过）。这里只记录，不动任何数据。
  const previousLocal = readLocalCheckpoint()
  const restoreOtherBank = canRestoreOtherBank(view, index)
  const committedCount = restoreOtherBank ? index.alternateCount : index.activeCount
  if (
    previousLocal.sessionCount !== undefined &&
    previousLocal.sessionCount > committedCount &&
    previousLocal.sessionCount - committedCount >= 5
  ) {
    const dropped = previousLocal.sessionCount - committedCount
    logEvent(
      'storage',
      'history.shrank',
      {
        previousCount: previousLocal.sessionCount,
        sessionCount: committedCount,
        alternateCount: index.alternateCount,
        dropped,
      },
      dropped >= 10 ? 'error' : 'warn'
    )
  }
  if (!index.activeCount && !restoreOtherBank) {
    await checkEmptyHistory(view, index, options)
    return []
  }
  if (!restoreOtherBank && index.current && (view.selectionConfirmed || index.activeCount === 0)) {
    if (index.activeCount > 0) {
      recordHistoryCheckpoint(true, index.activeCount)
    }
    return index.stored.map(toSessionSummary)
  }

  return reconstructHistoryIndex(options, index.indexCount)
}

/** Rebuild the list from conversation records and keep metadata for unreadable rows. */
const rebuildHistorySummaries = async (
  view: WritableHistoryView,
  source: WritableHistoryView['sessions'],
  expected: number,
  previous: StoredSessionSummary[]
) => {
  const known = new Map(previous.map((summary) => [summary.id, summary]))
  const rebuilt: SessionSummary[] = []
  let incomplete = 0
  await view.summaries.clear()
  for (let cursor = await source.openCursor(); cursor; cursor = await cursor.continue()) {
    const { summary, incomplete: partial } = recoverSummary(
      cursor.primaryKey,
      cursor.value,
      known.get(cursor.primaryKey)
    )
    await view.summaries.put(summary)
    rebuilt.push(toSessionSummary(summary))
    incomplete += Number(partial)
  }
  if (rebuilt.length !== expected || (await view.summaries.count()) !== expected) {
    throw new Error('Incomplete history index repair')
  }
  await view.state.put(incomplete > 0, INCOMPLETE_FILE_REFERENCES_KEY)
  if (incomplete) {
    logEvent('storage', 'history.index-recovery-records-unreadable', { count: incomplete }, 'warn')
  }
  return rebuilt
}

const reconstructHistoryIndex = async (
  options: HistoryLoadOptions,
  previousCount = 0
): Promise<SessionSummary[]> => {
  const history = await historyTransaction('readwrite')
  let rebuilt: SessionSummary[]
  try {
    const latest = await inspectHistoryIndex(history, { tolerant: true })
    const switched = canRestoreOtherBank(history, latest)
    if (!switched && latest.activeCount === 0) {
      await history.tx.done
      await checkEmptyHistory(history, latest, options)
      return []
    }
    if (!switched && latest.current) {
      if (latest.activeCount > 0 && !history.selectionConfirmed) {
        await confirmHistorySelection(history)
      }
      await history.tx.done
      if (latest.activeCount > 0) {
        recordHistoryCheckpoint(true, latest.activeCount)
      }
      return latest.stored.map(toSessionSummary)
    }
    if (switched && latest.alternate) {
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
    const source = switched ? history.stagingSessions : history.sessions
    const count = switched ? latest.alternateCount : latest.activeCount
    if (!switched && historySelectionUnresolved(history, latest)) {
      throw new HistoryMissingError('selection-uncertain')
    }
    rebuilt = await rebuildHistorySummaries(history, source, count, latest.stored)
    if (switched || !history.selectionConfirmed) {
      await confirmHistorySelection(
        history,
        switched ? !history.useStagingStores : history.useStagingStores
      )
    }
    if (switched) {
      await history.state.delete(CONFIRMED_EMPTY_KEY)
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
      previousCount,
      restoredCount: rebuilt.length,
    },
    'warn'
  )
  return rebuilt
}

export type HistoryRepair = {
  activeCount: number
  alternateCount: number
  indexCount: number
  /** 修复后激活库里的记录数 */
  sessionCount: number
  switched: boolean
  /** one-store：只有一个库有记录；conflict：两个都有；both-empty：都没有；consistent：本来不需要修 */
  state: 'one-store' | 'conflict' | 'both-empty' | 'consistent'
}

/** Preserve the committed bank and rebuild its list. A staged import is never a recovery source. */
export const repairHistoryStateAndIndex = async (): Promise<HistoryRepair> => {
  const view = await historyTransaction('readwrite')
  try {
    const index = await inspectHistoryIndex(view, { tolerant: true })
    const bothEmpty = index.activeCount === 0 && index.alternateCount === 0
    const switched =
      canRestoreOtherBank(view, index) ||
      (!index.activeCount &&
        index.alternateCount > 0 &&
        !view.selectionConfirmed &&
        !view.selectionConflict &&
        !index.interruptedImport &&
        !index.confirmedEmpty)
    const target = switched ? !view.useStagingStores : view.useStagingStores
    const source = switched ? view.stagingSessions : view.sessions
    const sessionCount = switched ? index.alternateCount : index.activeCount
    const consistent =
      !switched &&
      index.current &&
      index.indexCount === index.activeCount &&
      view.selectionConfirmed
    if (consistent || bothEmpty || (!sessionCount && index.confirmedEmpty)) {
      await view.tx.done
      return {
        activeCount: index.activeCount,
        alternateCount: index.alternateCount,
        indexCount: index.indexCount,
        sessionCount,
        switched: false,
        state: bothEmpty ? 'both-empty' : 'consistent',
      }
    }
    if (
      !switched &&
      (!sessionCount || (!index.current && historySelectionUnresolved(view, index)))
    ) {
      throw new HistoryMissingError(
        historySelectionUnresolved(view, index) ? 'selection-uncertain' : 'unreadable'
      )
    }
    await confirmHistorySelection(view, target)
    await view.state.delete(CONFIRMED_EMPTY_KEY)
    const rebuilt = await rebuildHistorySummaries(view, source, sessionCount, index.stored)
    await view.tx.done
    const state: HistoryRepair['state'] =
      index.activeCount > 0 && index.alternateCount > 0 ? 'conflict' : 'one-store'
    recordHistoryCheckpoint(true, rebuilt.length)
    logEvent(
      'storage',
      'history.repaired',
      {
        state,
        sessionCount: rebuilt.length,
        activeCount: index.activeCount,
        alternateCount: index.alternateCount,
        indexCount: index.indexCount,
        switched,
      },
      'info'
    )
    return {
      activeCount: index.activeCount,
      alternateCount: index.alternateCount,
      indexCount: index.indexCount,
      sessionCount: rebuilt.length,
      switched,
      state,
    }
  } catch (error) {
    abortTransaction(view.tx)
    throw error
  }
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
  const { sessions, summaries, tx } = await historyTransaction('readonly')
  let [record, summary] = await Promise.all([sessions.get(id), summaries.get(id)])
  if (record === undefined) {
    record = (await sessions.openCursor(id))?.value
    if (record !== undefined) {
      logEvent('storage', 'history.session-read-recovered', { lookup: 'cursor' }, 'warn')
    }
  }
  await tx.done
  if (record === undefined) {
    return undefined
  }
  const session = await unpackSession(record)
  editVersions.set(session, { exists: true, revision: summary?.revision })
  return session
}

export type VaultReceipt = { id: string; revisions: Map<string, string> }
const VAULT_COMMIT_KEY = 'lastCommittedRecoveryBatch'
export const vaultCommitProof = async () => {
  const view = await historyTransaction('readonly')
  const [marker, active, alternate, index, empty, interrupted] = await Promise.all([
    view.state.get(VAULT_COMMIT_KEY), view.sessions.count(), view.stagingSessions.count(),
    view.summaries.count(), view.state.get(CONFIRMED_EMPTY_KEY),
    view.state.get(INCOMPLETE_STAGING_KEY), view.tx.done,
  ])
  const allEmpty = active === 0 && alternate === 0 && index === 0
  const emptyAfterLoss = allEmpty && empty !== true
  return {
    id: marker && typeof marker === 'object' && 'vaultCommit' in marker ? marker.vaultCommit : undefined,
    confirmedEmpty: allEmpty && empty === true,
    emptyAfterLoss,
    canRestoreAutomatically: emptyAfterLoss && !view.selectionConflict && interrupted !== true,
  }
}
const vaultRevision = (summary: StoredSessionSummary) =>
  summary.vaultRevision ?? summary.revision ?? 'legacy-' + summary.createdAt + '-' + summary.updatedAt

export const vaultSessionIndex = async (staging = false) => {
  const view = await historyTransaction('readonly')
  if (staging) {
    const [keys, count] = await Promise.all([view.stagingSessions.getAllKeys(), view.stagingSessions.count(), view.tx.done])
    if (keys.length !== count) {
      throw new BackupError('backupIncomplete')
    }
    return keys.map((id) => ({ id, revision: '' }))
  }
  const [rows, count] = await Promise.all([view.summaries.getAll(), view.sessions.count(), view.tx.done])
  if (rows.length !== count) {
    throw new BackupError('sessionListLoadFailed')
  }
  return rows.map((summary) => ({ id: summary.id, revision: vaultRevision(summary) }))
}

export const vaultSession = async (id: string, staging: boolean) => {
  const view = await historyTransaction('readonly')
  const [record, summary] = await Promise.all([
    (staging ? view.stagingSessions : view.sessions).get(id),
    staging ? undefined : view.summaries.get(id), view.tx.done,
  ])
  if (!record) {
    return undefined
  }
  return { session: await unpackSession(record), revision: summary ? vaultRevision(summary) : createId() }
}

export const vaultOriginal = async (id: string, staging: boolean) => {
  const view = await historyTransaction('readonly')
  const [file] = await Promise.all([(staging ? view.stagingFiles : view.files).get(id), view.tx.done])
  if (!file || 'disk' in file || file.revision) {
    return file
  }
  // Legacy Blob records have no version. Stamp the current bytes in the same transaction that reads them.
  const write = await historyTransaction('readwrite')
  const store = staging ? write.stagingFiles : write.files
  let current = await store.get(id)
  if (current && 'blob' in current && !current.revision) {
    current = { ...current, revision: createId() }
    await store.put(current)
  }
  await write.tx.done
  return current
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

type CopyOriginals = { missing: number; disk: DiskOriginal[] }
export const saveSession = async (
  session: Session,
  files: StoredFile[] = [],
  edit?: EditVersion,
  originals?: CopyOriginals
): Promise<void> => {
  const summary = { ...storedSummary(session), revision: createId() }
  const record = sessionRecord(session, summary)
  const history = await historyTransaction('readwrite', true)
  let newSessionCount: number | undefined
  await Promise.all([
    (async () => {
      try {
        const existing = await history.sessions.getKey(session.id)
        if (edit && (
          edit.exists !== (existing !== undefined) ||
          (edit.exists && (await history.summaries.get(session.id))?.revision !== edit.revision)
        )) {
          throw new ChangedSessionError()
        }
        for (const file of files) {
          await history.files.put({ ...file, revision: createId() })
        }
        if (originals) {
          for (const id of summary.fileIds) {
            const record = await history.files.get(id)
            if (!record) {
              originals.missing++
            } else if ('disk' in record) {
              originals.disk.push(record.disk)
            }
          }
        }
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
  const committed = edit ?? { exists: true }
  committed.exists = true
  committed.revision = summary.revision
  editVersions.set(session, committed)
  recordHistoryCheckpoint(true, newSessionCount)
  if (newSessionCount !== undefined) {
    logEvent('storage', 'history.session-created', {
      sessionCount: newSessionCount,
      fileCount: files.length,
    })
  }
  if (historyVaultAvailable()) {
    await (await import('./historyVault.js')).protectChangedSession(session.id)
  }
}

/** Serialize this window’s snapshots and compare the revision again inside each write transaction. */
export const saveEditedSession = (session: Session, files?: StoredFile[]) => {
  const edit: EditVersion = editVersions.get(session) ?? { exists: false }
  editVersions.set(session, edit)
  const save = () => saveSession(session, files, edit)
  const write = edit.writing ? edit.writing.then(save, save) : save()
  edit.writing = write
  return write.finally(() => {
    if (edit.writing === write) {
      delete edit.writing
    }
  })
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
          await summaries.put({ ...recordSummary(updated), revision: createId() })
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  if (historyVaultAvailable()) {
    await (await import('./historyVault.js')).protectChangedSession(id)
  }
}

export const loadSessionGoalRuns = async (sessionId: string): Promise<string[]> => {
  const { summaries, tx } = await historyTransaction('readonly')
  const [summary] = await Promise.all([summaries.get(sessionId), tx.done])
  return summary?.goalRunIds?.filter((id) => /^[\w-]{1,80}$/.test(id)) ?? []
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  if (historyVaultAvailable()) {
    const vault = await import('./historyVault.js')
    return vault.protectDeletion(sessionId, (receipt) => deleteSessionRecord(sessionId, receipt))
  }
  return deleteSessionRecord(sessionId)
}
const deleteSessionRecord = async (sessionId: string, receipt?: VaultReceipt): Promise<void> => {
  const { sessions, files, summaries, state, tx } = await historyTransaction('readwrite', true)
  const removed: string[] = []
  let sessionCount: number | undefined
  await Promise.all([
    (async () => {
      try {
        const summary = await summaries.get(sessionId)
        const incomplete = await state.get(INCOMPLETE_FILE_REFERENCES_KEY)
        await sessions.delete(sessionId)
        await summaries.delete(sessionId)
        if (receipt) {
          await state.put({ vaultCommit: receipt.id }, VAULT_COMMIT_KEY)
        }
        for (const id of incomplete ? [] : summary?.fileIds ?? []) {
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
    await Promise.all(files.map((file) => store.put('disk' in file ? file : { ...file, revision: createId() })))
    if (staging && files.length) {
      await history.state.put(true, INCOMPLETE_STAGING_KEY)
    } else if (historyVaultAvailable()) {
      for (const file of files) {
        const rows = await history.summaries.index('fileIds').getAll(file.id)
        for (const row of rows) {
          await history.summaries.put({ ...row, vaultRevision: createId() })
        }
      }
    }
    await history.tx.done
  } catch (error) {
    abortTransaction(history.tx)
    throw error
  }
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  await putFiles(false, files)
  if (historyVaultAvailable() && files.length) {
    const view = await historyTransaction('readonly')
    const rows = await Promise.all(files.map(({ id }) => view.summaries.index('fileIds').getAllKeys(id)))
    await view.tx.done
    const vault = await import('./historyVault.js')
    for (const sessionId of new Set(rows.flat())) {
      await vault.protectChangedSession(sessionId)
    }
  }
}

const loadFileRecord = async (id: string): Promise<ArchivedFile | undefined> => {
  const { files, tx } = await historyTransaction('readonly')
  const [record] = await Promise.all([files.get(id), tx.done])
  return record
}

export const loadDiskOriginalRef = async (id: string): Promise<DiskOriginal | undefined> => {
  const record = await loadFileRecord(id)
  return record && 'disk' in record ? record.disk : undefined
}

export const saveSessionCopy = async (session: Session, files?: StoredFile[]): Promise<number> => {
  const originals: CopyOriginals = { missing: 0, disk: [] }
  await saveSession(session, files, { exists: false }, originals)
  for (const disk of originals.disk) {
    try {
      await checkDiskOriginal(disk)
    } catch {
      originals.missing++
    }
  }
  return originals.missing
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const record = await loadFileRecord(id)
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
export const clearStaging = async ({
  onlyInterrupted = false,
}: { onlyInterrupted?: boolean } = {}): Promise<void> => {
  const view = await historyTransaction('readwrite')
  const { files, stagingSessions, stagingFiles, state, tx } = view
  if (onlyInterrupted) {
    if (!(await state.get(INCOMPLETE_STAGING_KEY))) {
      await tx.done
      return
    }
    const index = await inspectHistoryIndex(view)
    if (!view.selectionConfirmed || !index.current) {
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
let localReplacementRunning = false

export const withHistoryReplacement = async <T>(work: () => Promise<T>): Promise<T> => {
  const locks = browserHistoryLocks()
  if (locks) {
    return locks.request(HISTORY_REPLACEMENT_LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        throw new BackupError('backupOtherTabBusy')
      }
      return work()
    })
  }
  if (localReplacementRunning) {
    throw new BackupError('backupHistoryBusy')
  }
  localReplacementRunning = true
  try {
    return await work()
  } finally {
    localReplacementRunning = false
  }
}

/** Only reclaim an interrupted import whose staging store was marked before writing. */
export const recoverStaging = async () => {
  const { state, tx } = await historyTransaction('readonly')
  const [interrupted] = await Promise.all([state.get(INCOMPLETE_STAGING_KEY), tx.done])
  if (!interrupted) {
    return
  }
  try {
    await withHistoryReplacement(() => clearStaging({ onlyInterrupted: true }))
  } catch (error) {
    if (
      !(error instanceof BackupError) ||
      (error.key !== 'backupOtherTabBusy' && error.key !== 'backupHistoryBusy')
    ) {
      throw error
    }
  }
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
export const commitStaging = async ({
  allowEmpty = true,
}: { allowEmpty?: boolean } = {}): Promise<SessionSummary[]> => {
  if (historyVaultAvailable()) {
    const vault = await import('./historyVault.js')
    return vault.protectStagedChange('replace', undefined, (receipt) => commitStagedRecords(allowEmpty, receipt))
  }
  return commitStagedRecords(allowEmpty)
}
const commitStagedRecords = async (allowEmpty: boolean, receipt?: VaultReceipt): Promise<SessionSummary[]> => {
  const history = await historyTransaction('readwrite', true)
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
      const summary = { ...recordSummary(cursor.value), revision: receipt?.revisions.get(cursor.primaryKey) ?? createId() }
      await history.summaries.put(summary)
      imported.push(toSessionSummary(summary))
    }
    if (imported.length !== expected || (await history.summaries.count()) !== expected) {
      throw new Error('Incomplete history replacement')
    }
    keep = await diskKeys(history.stagingFiles)
    if (receipt) {
      await history.state.put({ vaultCommit: receipt.id }, VAULT_COMMIT_KEY)
    }
    await Promise.all([
      confirmHistorySelection(history, !history.useStagingStores),
      history.state.put(expected === 0, CONFIRMED_EMPTY_KEY),
      history.state.delete(INCOMPLETE_STAGING_KEY),
      history.state.delete(INCOMPLETE_FILE_REFERENCES_KEY),
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

export type HistoryImportPreview = {
  added: number
  conflicts: { local: SessionSummary; backup: SessionSummary; revision?: string }[]
  usingStagingStores: boolean
}

export const prepareHistoryMerge = async () => {
  await clearStaging({ onlyInterrupted: true })
  const history = await historyTransaction('readwrite')
  const { files, sessions, summaries, stagingSessions, stagingFiles, tx } = history
  const [staged, stagedFiles, keys, fileCount, current, count] = await Promise.all([
    stagingSessions.count(),
    stagingFiles.count(),
    files.getAllKeys(),
    files.count(),
    summaries.getAll(),
    sessions.count(),
  ])
  if (staged || stagedFiles) {
    throw new BackupError('backupUnresolvedHistory')
  }
  if (keys.length !== fileCount || (count > 0 && current.length !== count)) {
    throw new BackupError('backupMergeChanged')
  }
  await confirmHistorySelection(history)
  await tx.done
  return new Set([...keys, ...current.flatMap(({ fileIds }) => fileIds)])
}

export const previewHistoryMerge = async (allowOriginalsOnly = false): Promise<HistoryImportPreview> => {
  const { tx, stagingSessions, summaries, sessions, useStagingStores } =
    await historyTransaction('readonly')
  const [expected, count, current] = await Promise.all([
    stagingSessions.count(),
    sessions.count(),
    summaries.getAll(),
  ])
  const locals = new Map(count ? current.map((summary) => [summary.id, summary]) : [])
  const conflicts: HistoryImportPreview['conflicts'] = []
  let scanned = 0
  for (let cursor = await stagingSessions.openCursor(); cursor; cursor = await cursor.continue()) {
    scanned += 1
    const local = locals.get(cursor.primaryKey)
    if (local) {
      conflicts.push({
        local: toSessionSummary(local),
        backup: toSessionSummary(recordSummary(cursor.value)),
        revision: local.revision,
      })
    }
  }
  await tx.done
  if (scanned !== expected || (!scanned && !allowOriginalsOnly)) {
    throw new BackupError(scanned === expected ? 'backupEmptyHistory' : 'backupIncomplete')
  }
  return {
    added: scanned - conflicts.length,
    conflicts: conflicts.sort((a, b) => b.backup.updatedAt - a.backup.updatedAt),
    usingStagingStores: useStagingStores,
  }
}

const sameConversationVersion = (
  current: StoredSessionSummary,
  { local, revision }: HistoryImportPreview['conflicts'][number]
) =>
  current.revision === revision &&
  current.updatedAt === local.updatedAt &&
  current.title === local.title &&
  current.pinned === local.pinned

/** Keep the archive payload in staging and copy existing records into that same bank before switching. */
export const commitHistoryMerge = async (
  preview: HistoryImportPreview,
  useBackup: ReadonlySet<string>,
  repairs?: ReadonlyMap<string, string | null>
) => {
  if (historyVaultAvailable() && !repairs) {
    const vault = await import('./historyVault.js')
    const keep = new Set(preview.conflicts.filter(({ local }) => !useBackup.has(local.id)).map(({ local }) => local.id))
    return vault.protectStagedChange('merge', keep, (receipt) => commitMergedRecords(preview, useBackup, receipt))
  }
  return commitMergedRecords(preview, useBackup, undefined, repairs)
}
const commitMergedRecords = async (
  preview: HistoryImportPreview,
  useBackup: ReadonlySet<string>,
  receipt?: VaultReceipt,
  repairs?: ReadonlyMap<string, string | null>
) => {
  const history = await historyTransaction('readwrite', true)
  const { tx, sessions, files, summaries, stagingSessions, stagingFiles, state } = history
  const imported: StoredSessionSummary[] = []
  const replaced = new Set<string>()
  const replacedFiles = new Set<string>()
  const replacedRuns = new Set<string>()
  const importedFiles = new Set<string>()
  let kept = 0
  let originalCount: number
  let repairedOriginals = 0
  let merged: SessionSummary[]
  let keep: string[] | undefined
  try {
    if (!history.selectionConfirmed || history.useStagingStores !== preview.usingStagingStores) {
      throw new BackupError('backupMergeChanged')
    }
    originalCount = await sessions.count()
    const current = originalCount ? await summaries.getAll() : []
    if (current.length !== originalCount) {
      throw new BackupError('backupMergeChanged')
    }
    const locals = new Map(current.map((summary) => [summary.id, summary]))
    for (const [id, expectedKey] of repairs ?? []) {
      const prior = await files.get(id)
      const staged = await stagingFiles.get(id)
      if (!staged) {
        throw new BackupError('backupIncomplete')
      }
      if (!prior || ('disk' in prior && prior.disk.key === expectedKey)) {
        await files.put(staged)
        repairedOriginals++
      }
      await stagingFiles.delete(id)
    }
    const choices = new Map(preview.conflicts.map((conflict) => [conflict.local.id, conflict]))
    let scanned = 0
    for (let cursor = await stagingSessions.openCursor(); cursor; cursor = await cursor.continue()) {
      scanned += 1
      const id = cursor.primaryKey
      const current = locals.get(id)
      const choice = choices.get(id)
      if (current && (!choice || !useBackup.has(id))) {
        kept += 1
        await cursor.delete()
        continue
      }
      if (choice && (!current || !sameConversationVersion(current, choice))) {
        throw new BackupError('backupMergeChanged')
      }
      if (current) {
        replaced.add(id)
        current.fileIds.forEach((file) => replacedFiles.add(file))
        current.goalRunIds?.forEach((run) => replacedRuns.add(run))
      }
      const summary = { ...recordSummary(cursor.value), revision: receipt?.revisions.get(id) ?? createId() }
      summary.fileIds.forEach((file) => importedFiles.add(file))
      locals.set(id, summary)
      imported.push(summary)
    }
    if (scanned !== preview.added + preview.conflicts.length) {
      throw new BackupError('backupIncomplete')
    }
    merged = [...locals.values()].map(toSessionSummary)
    if (imported.length) {
      const localFiles = new Set(current.flatMap(({ fileIds }) => fileIds))
      if ([...importedFiles].some((id) => localFiles.has(id))) {
        throw new BackupError('backupMergeChanged')
      }
      const usedFiles = new Set([...locals.values()].flatMap(({ fileIds }) => fileIds))
      const incomplete = await state.get(INCOMPLETE_FILE_REFERENCES_KEY)
      const stagedFileCount = await stagingFiles.count()
      let scannedFiles = 0
      for (let cursor = await stagingFiles.openCursor(); cursor; cursor = await cursor.continue()) {
        scannedFiles += 1
        if (!importedFiles.has(cursor.primaryKey)) {
          await cursor.delete()
        }
      }
      if (scannedFiles !== stagedFileCount) {
        throw new BackupError('backupIncomplete')
      }
      let scannedSessions = 0
      for (let cursor = await sessions.openCursor(); cursor; cursor = await cursor.continue()) {
        scannedSessions += 1
        if (!replaced.has(cursor.primaryKey)) {
          await stagingSessions.add(cursor.value)
        }
      }
      const originalFileCount = await files.count()
      scannedFiles = 0
      for (let cursor = await files.openCursor(); cursor; cursor = await cursor.continue()) {
        scannedFiles += 1
        const id = cursor.primaryKey
        if (importedFiles.has(id)) {
          throw new BackupError('backupMergeChanged')
        }
        if (incomplete || !replacedFiles.has(id) || usedFiles.has(id)) {
          await stagingFiles.add(cursor.value)
        }
      }
      if (
        scannedSessions !== originalCount ||
        scannedFiles !== originalFileCount ||
        (await stagingSessions.count()) !== originalCount + imported.length - replaced.size
      ) {
        throw new BackupError('backupIncomplete')
      }
      if (originalCount === 0) {
        await summaries.clear()
      }
      for (const summary of imported) {
        await summaries.put(summary)
      }
      keep = await diskKeys(stagingFiles)
      await Promise.all([
        confirmHistorySelection(history, !history.useStagingStores),
        state.delete(CONFIRMED_EMPTY_KEY),
        sessions.clear(),
        files.clear(),
      ])
    } else {
      keep = await diskKeys(files)
      await Promise.all([stagingSessions.clear(), stagingFiles.clear()])
    }
    if (receipt) {
      await state.put({ vaultCommit: receipt.id }, VAULT_COMMIT_KEY)
    }
    await Promise.all([state.delete(INCOMPLETE_STAGING_KEY), tx.done])
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
  if (imported.length) {
    recordHistoryCheckpoint(true, merged.length)
  }
  if (keep) {
    await pruneDiskOriginals(keep).catch(reportStorageError('clean merged history originals'))
  }
  return {
    summaries: merged,
    repairedOriginals,
    imported: imported.map(toSessionSummary),
    replaced,
    replacedRuns,
    added: imported.length - replaced.size,
    kept,
    previousSessionCount: originalCount,
  }
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  logEvent('storage', 'operation.failed', { operation: action, ...diagnosticError(error) }, 'error')
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** 诊断仅取数量和体积，不读取会话正文或附件字节。 */
export const getStorageSummary = async () => {
  const view = await historyTransaction('readonly')
  const { sessions, files, summaries, stagingSessions, state, tx } = view
  const [
    sessionCount,
    fileCount,
    indexCount,
    alternateSessionCount,
    confirmedEmpty,
    interruptedImport,
    incompleteFileReferences,
  ] = await Promise.all([
    sessions.count(),
    files.count(),
    summaries.count(),
    stagingSessions.count(),
    state.get(CONFIRMED_EMPTY_KEY),
    state.get(INCOMPLETE_STAGING_KEY),
    state.get(INCOMPLETE_FILE_REFERENCES_KEY),
  ])
  let originalBytes = 0
  for (let cursor = await files.openCursor(); cursor; cursor = await cursor.continue()) {
    const value = cursor.value
    originalBytes += 'disk' in value ? value.disk.size : value.blob.size
  }
  await tx.done
  return {
    databaseVersion: view.databaseVersion,
    sessionCount,
    fileCount,
    originalBytes,
    indexCount,
    alternateSessionCount,
    useStagingStores: view.useStagingStores,
    selectionConfirmed: view.selectionConfirmed,
    selectionConflict: view.selectionConflict,
    confirmedEmpty: confirmedEmpty === true,
    interruptedImport: interruptedImport === true,
    incompleteFileReferences: incompleteFileReferences === true,
  }
}
