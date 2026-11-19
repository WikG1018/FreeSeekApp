import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { MessageParam } from '../api/types.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import {
  extractFileIds,
  getFileErrorCode,
  isRetryableUploadError,
  getUploadErrorInfo,
  isUnsupportedImageError,
} from '../api/errors.js'
import {
  cancelUpload,
  describeUploadError,
  uploadAttachment,
  useUploads,
  markAttachmentInvalid,
} from '../attachments.js'
import { thirdPartySearchKey, useSettings } from '../settings.js'
import { UnsupportedImageError } from '../image.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import { allSessionMessages, mapSessionMessages } from './sessionData.js'
import { sumMessageUsage, usageEntries } from './usage.js'
import { abortReason } from '../../utils/abort.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applicableSummary,
  compressionEstimateParams,
  contextLength,
  contextReplyReserve,
  contextRounds,
  describeCompressionFailure,
  estimateContextHistory,
  estimatedFileTokens,
  estimatedSystemTokens,
  estimatedTokens,
  estimatedUserTokens,
  generateContextSummary,
  isCompressionFailure,
  MAX_SUMMARY_CHARS,
  planCompression,
  type ContextRound,
  type SummaryPlan,
} from './contextCompression.js'
import { apiLimitCounts, isContextRejection } from '../api/knownErrors.js'
import { activePersona } from '../personas.js'
import {
  activeConnection,
  activeConnectionRef,
  resolveConnection,
  selectedReasoning,
  setReasoningOverride,
  useProviders,
  ProviderConfigError,
  validModel,
  type Connection,
} from '../providers.js'
import { streamProviderMessage } from '../api/providerClient.js'
import { searchContext, searchForCustomModel } from '../api/search.js'
import {
  documentTextFallback,
  inlineDocuments,
  prepareProviderMessages,
} from '../api/providerContent.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type ContextSummary,
  type FileAttachment,
  type InheritedContext,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
const DEEPSEEK_DOCUMENT_LIMIT = 20
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000
/** 图片自愈（重置重传 → 再失败仅从本轮请求省略并提示）的最大请求数 */
const IMAGE_HEAL_ATTEMPTS = 6
/** 上次打开的会话：重启 App 后恢复，避免总是回到欢迎页 */
const ACTIVE_SESSION_KEY = 'freeseek:active-session'

const readActiveSession = (): string | null => {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY)
  } catch {
    return null
  }
}

const writeActiveSession = (id: string | null) => {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_SESSION_KEY, id)
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY)
    }
  } catch {
    // 存储不可用时忽略，仅影响重启恢复
  }
}

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  targetMessageId: string | null
  /** 对话接续：待带入下一个新会话的来源上下文快照；null 表示未启用 */
  inheritFrom: InheritedContext | null
  /** 正在生成回复的会话 */
  compressing: Record<string, { percent: number }>
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  targetMessageId: null,
  inheritFrom: null,
  streaming: {},
  compressing: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  !!a.pinned === !!b.pinned

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let inheritSequence = 0
/** 用于只在 activeId 变化时写入 localStorage */
let lastActiveId: string | null = null
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 保存失败时，导出仍可从内存取回尚未落盘的原件。 */
export const loadBackupFile = async (id: string): Promise<Blob | undefined> => {
  for (const files of pendingFiles.values()) {
    const file = files.find((file) => file.id === id)
    if (file) {
      return file.blob
    }
  }
  return db.loadFile(id)
}

export const flushChatUpdates = () => {
  streamFlushes.forEach((flush) => flush())
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
export const replySystemPrompt = (prompt: string | undefined, official: boolean) =>
  prompt?.trim() ? prompt : official ? SYSTEM_PROMPT : 'You are a helpful assistant.'

const createReply = (persona: Session['persona'], sessionId: string | null): AssistantMessage => {
  const settings = useSettings.getState()
  const { selection } = useProviders.getState()
  const official = selection.providerId === 'deepseek'
  const reasoning = selectedReasoning(sessionId)
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: selection.model,
    connection: activeConnectionRef(),
    systemPrompt: replySystemPrompt(persona?.prompt, official),
    reasoning,
    thinking: !!reasoning && reasoning.level !== 'off',
    search: official
      ? settings.search
      : settings.thirdPartySearch.enabled && settings.thirdPartySearchOn,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      logEvent('storage', 'sessions.loaded', { sessionCount: summaries.length })
      if (epoch === historyEpoch) {
        // 恢复上次打开的会话；记录不存在（已删除）时回到欢迎页
        const saved = readActiveSession()
        const restore = saved && summaries.some((session) => session.id === saved) ? saved : null
        lastActiveId = restore
        set({ ready: true, sessions: sortSessions(summaries), activeId: restore })
        if (restore) {
          void ensureSessionLoaded(restore)
        }
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    inheritSequence += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
      targetMessageId: null,
      inheritFrom: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    inheritSequence += 1
    set({ activeId: null, targetMessageId: null, inheritFrom: null })
    trimSessionCache()
  }
}

/** 从指定会话继续：下一个新对话将携带其当前路径的上下文；消息快照在设置时加载 */
export const startInheritSession = (id: string) => {
  if (get().importingHistory) {
    return
  }
  const summary = get().sessions.find((session) => session.id === id)
  if (!summary) {
    return
  }
  const sequence = ++inheritSequence
  const epoch = historyEpoch
  const attach = (session: Session | undefined) => {
    if (
      !session ||
      get().importingHistory ||
      epoch !== historyEpoch ||
      sequence !== inheritSequence ||
      !get().sessions.some((item) => item.id === id)
    ) {
      return
    }
    const messages = [...(session.inherited?.messages ?? []), ...getVisibleMessages(session)]
    set({
      inheritFrom: {
        fromId: summary.id,
        fromTitle: summary.title,
        messages,
        contextSummary: currentContextSummary(session),
      },
      activeId: null,
      targetMessageId: null,
    })
    trimSessionCache()
  }
  const cached = getSession(id)
  if (cached) {
    attach(cached)
    return
  }
  void db
    .loadSession(id)
    .then((stored) => attach(stored ? normalizeSession(stored) : undefined))
    .catch(db.reportStorageError('read session for inheritance'))
}

/** 取消对话接续 */
export const cancelInherit = () => {
  inheritSequence += 1
  set({ inheritFrom: null })
}

export const selectSession = (id: string, messageId?: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    inheritSequence += 1
    touchSession(id)
    set({ activeId: id, targetMessageId: messageId ?? null, inheritFrom: null })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const clearMessageTarget = (sessionId: string, messageId: string) => {
  if (get().activeId === sessionId && get().targetMessageId === messageId) {
    set({ targetMessageId: null })
  }
}

/** 沿用会话保存队列与失败重试，置顶不改变最后聊天时间。 */
export const setSessionPinned = async (id: string, pinned: boolean): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  await ensureSessionLoaded(id)
  if (
    epoch !== historyEpoch ||
    get().importingHistory ||
    deletingSessions.has(id) ||
    !getSession(id)
  ) {
    return false
  }
  updateSession(id, (session) => ({ ...session, pinned }))
  persist(id)
  return true
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
      targetMessageId: state.activeId === id ? null : state.targetMessageId,
      inheritFrom: state.inheritFrom?.fromId === id ? null : state.inheritFrom,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const inherit = get().inheritFrom
    const persona = activePersona()
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      ...(inherit && inherit.messages.length > 0
        ? { inherited: inherit, contextSummary: inherit.contextSummary }
        : null),
      ...(persona ? { persona } : null),
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
      inheritFrom: null,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply(current.persona, targetSessionId)
  const override = useProviders.getState().reasoningOverride
  if (targetSessionId === null && override?.sessionId === null) {
    setReasoningOverride(sessionId, override.level)
  }
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, {
    history,
    question,
    inherited: current.inherited ?? null,
    persona: current.persona ?? null,
  })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply(session.persona, sessionId)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, {
    history,
    question,
    inherited: session.inherited ?? null,
    persona: session.persona ?? null,
  })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply(session.persona, sessionId)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, {
    history: path.slice(0, index),
    question,
    inherited: session.inherited ?? null,
    persona: session.persona ?? null,
  })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, {
    history: path.slice(0, -2),
    question,
    prefix: previous,
    inherited: session.inherited ?? null,
    persona: session.persona ?? null,
  })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, {
    history: path.slice(0, index - 1),
    question,
    inherited: session.inherited ?? null,
    persona: session.persona ?? null,
  })
}

type Request = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  /** 对话接续：置于请求上下文最前的继承轮次 */
  inherited?: InheritedContext | null
  /** 人设快照：prompt 覆盖默认 system 提示词 */
  persona?: { name: string; prompt: string } | null
}

const localDocumentRetry = async (
  sessionId: string,
  request: Request,
  messages: MessageParam[],
  signal: AbortSignal,
  remainingTokens: number,
  required: number
) => {
  const referenced = new Set(
    messages.flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === 'document' ? [part.source.file_id] : []))
        : []
    )
  )
  const texts = new Map<string, string>()
  const considered = new Set<string>()
  let bytes = 0
  const questions = [
    request.question,
    ...contextRounds(request.history, request.inherited).map(([user]) => user),
  ]
  for (const question of questions) {
    for (const file of question.files) {
      const id = file.serverId
      if (!id || !referenced.has(id) || considered.has(id)) {
        continue
      }
      considered.add(id)
      signal.throwIfAborted()
      try {
        const blob =
          pendingFiles.get(sessionId)?.find((item) => item.id === file.id)?.blob ??
          (await db.loadFile(file.id))
        const text = blob ? await documentTextFallback(file, blob, signal) : undefined
        if (!text) {
          continue
        }
        const added = new Blob([text]).size
        const increase = estimatedTokens(text) - estimatedFileTokens(file.size, false)
        if (bytes + added <= 4 * 1024 * 1024 && remainingTokens - increase >= 0) {
          texts.set(id, text)
          remainingTokens -= increase
          bytes += added
          if (texts.size >= required) {
            return texts
          }
        }
      } catch {
        signal.throwIfAborted()
      }
    }
  }
  return texts
}

export const currentContextSummary = (session: Session) =>
  applicableSummary(
    session.contextSummary,
    contextRounds(getVisibleMessages(session), session.inherited)
  )

type CompressionMode = 'ask' | 'compress' | 'recover' | 'send'
const markCompressing = (id: string, percent?: number) =>
  set((state) => {
    if (state.compressing[id]?.percent === percent) {
      return state
    }
    return {
      compressing:
        percent === undefined
          ? Object.fromEntries(Object.entries(state.compressing).filter(([key]) => key !== id))
          : { ...state.compressing, [id]: { percent } },
    }
  })

const compressRounds = async (
  id: string,
  connection: Connection,
  rounds: ContextRound[],
  prior: ContextSummary | undefined,
  plan: SummaryPlan,
  signal: AbortSignal
) => {
  markCompressing(id, 0)
  logEvent('chat', 'compression.started', {
    sessionId: id,
    coveredRounds: plan.start,
    targetRounds: plan.end,
  })
  try {
    const generated = await generateContextSummary(connection, rounds, prior, plan, signal, {
      checkpoint: getSession(id)?.compressionCheckpoint,
      progress: (percent) => markCompressing(id, percent),
      record: (charge, checkpoint) => {
        if (get().importingHistory || deletingSessions.has(id)) {
          return
        }
        updateSession(id, (session) => ({
          ...session,
          ...(charge ? { compressionUsage: [...(session.compressionUsage ?? []), charge] } : {}),
          ...(checkpoint ? { compressionCheckpoint: checkpoint } : {}),
        }))
        persist(id)
      },
    })
    signal.throwIfAborted()
    const historyEstimate = {
      before: plan.historyEstimate?.before ?? estimateContextHistory(rounds, prior).tokens,
      after: estimateContextHistory(rounds, generated).tokens,
    }
    if (historyEstimate.after >= historyEstimate.before) {
      updateSession(id, (session) => ({ ...session, compressionCheckpoint: undefined }))
      persist(id)
      throw new ApiError('protocol', { key: 'compressionFailedNoSavings' })
    }
    const summary = { ...generated, historyEstimate }
    updateSession(id, (session) => ({
      ...session,
      contextSummary: summary,
      compressionCheckpoint: undefined,
    }))
    persist(id)
    logEvent('chat', 'compression.completed', {
      sessionId: id,
      coveredRounds: summary.coveredRounds,
      historyTokensBefore: historyEstimate.before,
      historyTokensAfter: historyEstimate.after,
    })
    if (get().activeId === id) {
      showToast({
        key: 'compressionFinishedResult',
        params: compressionEstimateParams(historyEstimate),
      })
    }
    return summary
  } catch (error) {
    logEvent(
      'chat',
      'compression.failed',
      {
        sessionId: id,
        ...diagnosticError(error),
        failureKey: describeCompressionFailure(error).key,
        cancelled: signal.aborted,
      },
      signal.aborted ? 'info' : 'warn'
    )
    throw error
  } finally {
    markCompressing(id)
  }
}

export const compressSession = async (id: string) => {
  const session = getSession(id)
  if (!session || deletingSessions.has(id) || get().importingHistory || getStreamController(id)) {
    throw new ApiError('protocol', { key: 'compressionUnavailable' })
  }
  const connection = activeConnection(),
    rounds = contextRounds(getVisibleMessages(session), session.inherited)
  const prior = applicableSummary(session.contextSummary, rounds)
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [id]: controller } }))
  try {
    return await compressRounds(
      id,
      connection,
      rounds,
      prior,
      planCompression(rounds, prior, connection),
      controller.signal
    )
  } finally {
    set((state) => {
      return {
        streaming: Object.fromEntries(
          Object.entries(state.streaming).filter(([key]) => key !== id)
        ),
      }
    })
  }
}

export const editContextSummary = (id: string, original: ContextSummary, text: string) => {
  const session = getSession(id)
  const summary = session && currentContextSummary(session)
  if (
    !summary ||
    summary !== original ||
    !text.trim() ||
    text.length > MAX_SUMMARY_CHARS ||
    getStreamController(id) ||
    deletingSessions.has(id) ||
    get().importingHistory
  ) {
    return false
  }
  updateSession(id, (s) => ({
    ...s,
    contextSummary: { ...summary, text: text.trim(), updatedAt: Date.now() },
    compressionCheckpoint: undefined,
  }))
  persist(id)
  return true
}

export const retryContextReply = (id: string, replyId: string, mode: 'compress' | 'send') => {
  const session = getSession(id)
  if (!session || getStreamController(id) || get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const path = getVisibleMessages(session),
    index = path.findIndex((m) => m.id === replyId)
  const question = path[index - 1],
    previous = path[index]
  const local = previous?.role === 'assistant' ? previous.error?.localMessage : undefined
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.status !== 'error' ||
    (!isContextRejection(local?.key) &&
      !['compressionSuggested', 'compressionUnavailable'].includes(local?.key ?? '') &&
      !isCompressionFailure(local?.key))
  ) {
    return
  }
  const reply: AssistantMessage = {
    ...previous,
    status: 'pending',
    error: undefined,
    stopReason: undefined,
    stopDetails: undefined,
  }
  const recover =
    mode === 'compress' && (isContextRejection(local?.key) || local?.params?.recoverContext === 1)
  updateReply(id, reply)
  persist(id)
  void streamReply(
    id,
    reply,
    {
      history: path.slice(0, index - 1),
      question,
      prefix: previous.blocks.length ? previous : undefined,
      inherited: session.inherited,
      persona: session.persona,
    },
    recover ? 'recover' : mode,
    Number(local?.params?.contextLimitTokens) || undefined
  )
}

const withSummaryText = (request: Request, summary?: ContextSummary): Request => {
  if (!summary) {
    return request
  }
  // Keep the summary at user priority. The active persona remains the only system prompt.
  const note = '[Earlier conversation summary]\n' + summary.text + '\n[End of earlier summary]\n\n'
  const withNote = (q: UserMessage) => ({ ...q, content: note + q.content })
  const first = request.history[0]
  return first?.role === 'user'
    ? { ...request, history: [withNote(first), ...request.history.slice(1)] }
    : { ...request, question: withNote(request.question) }
}

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) =>
    mapSessionMessages(session, (message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    )
  )
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId && !file.serverId.startsWith('local:')) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done' && !task.serverId.startsWith('local:')) {
    return task.serverId
  }
  if (
    task?.status === 'error' &&
    ['uploadImageUnsupported', 'uploadParseFailed'].includes(task.error.key)
  ) {
    throw new ApiError('http', 'Failed to recognize the file', 400, task.error)
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(allSessionMessages(session).map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
    inherited: request.inherited
      ? { ...request.inherited, messages: request.inherited.messages.map(pick) }
      : undefined,
    persona: request.persona,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   网络、鉴权等失败阻止发送并允许重试；不可读文件仅从本次请求省略并明确提示。
 */
const prepareFiles = async (
  sessionId: string,
  request: Request,
  signal: AbortSignal,
  omitted: Map<string, FileAttachment>,
  apiKey: string
) => {
  signal.throwIfAborted()
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const uploads = Promise.allSettled(
      request.question.files.map(async (file) => {
        if (omitted.has(file.id)) {
          return
        }
        const serverId = await ensureServerId(apiKey, file)
        if (serverId) {
          serverIds.set(file.id, serverId)
        } else {
          omitted.set(file.id, file)
        }
      })
    )
    void uploads.then(() => {
      if (epoch === historyEpoch) {
        saveServerIds(sessionId, serverIds)
      }
    })
    const results = await Promise.race([uploads, aborted])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) {
      throw failed.reason
    }

    const pending = new Map<string, FileAttachment>()
    const context = [
      ...getContextRounds(request.inherited?.messages ?? []),
      ...getContextRounds(request.history),
    ]
    for (const [user] of context.toReversed()) {
      for (const file of user.files) {
        if (
          (!file.serverId || file.serverId.startsWith('local:')) &&
          !serverIds.has(file.id) &&
          !pending.has(file.id) &&
          !omitted.has(file.id)
        ) {
          pending.set(file.id, file)
        }
      }
    }
    for (const file of pending.values()) {
      signal.throwIfAborted()
      try {
        const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
        if (serverId) {
          serverIds.set(file.id, serverId)
          saveServerIds(sessionId, new Map([[file.id, serverId]]))
        } else {
          omitted.set(file.id, file)
        }
      } catch (error) {
        signal.throwIfAborted()
        if (
          error instanceof UnsupportedImageError ||
          getUploadErrorInfo(error)?.code === 'parseFailed'
        ) {
          omitted.set(file.id, file)
          logEvent(
            'chat',
            'attachment.omitted',
            { fileId: file.id, reason: 'invalid-file', ...diagnosticError(error) },
            'warn'
          )
        } else {
          // 鉴权、余额、限流与网络故障必须可恢复，不能悄悄把附件从上下文里省掉。
          throw error
        }
      }
    }

    // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
    const fresh = refreshRequest(sessionId, request)
    const filter = <T extends Message>(message: T): T =>
      message.role === 'user'
        ? { ...message, files: message.files.filter((file) => !omitted.has(file.id)) }
        : message
    return {
      ...fresh,
      history: fresh.history.map(filter),
      question: filter(fresh.question),
      inherited: fresh.inherited
        ? { ...fresh.inherited, messages: fresh.inherited.messages.map(filter) }
        : undefined,
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  for (const [user] of getContextRounds(request.inherited?.messages ?? [])) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
/** 把命中的附件 serverId 清空（下次发送前会重新上传），返回受影响的本地附件 id */
const resetAttachmentServerIds = (sessionId: string, serverIds: Set<string>): string[] => {
  const session = getSession(sessionId)
  if (!session || serverIds.size === 0) {
    return []
  }
  const localIds: string[] = []
  const updated = mapSessionMessages(session, (message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !serverIds.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return []
  }
  updateSession(sessionId, () => updated)
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return localIds
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (
  sessionId: string,
  request: Request,
  error: unknown,
  force = false
): boolean => {
  if (!force && (!(error instanceof ApiError) || !getFileErrorCode(error))) {
    return false
  }
  const mentioned = force || !(error instanceof Error) ? [] : extractFileIds(error.message)
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  return resetAttachmentServerIds(sessionId, targets).length > 0
}

/** 报错里的 messages.N.content.M 指向的具体图片 file_id；定位不了返回 null */
const blamedServerId = (error: unknown, sentMessages: MessageParam[] | null): string | null => {
  if (!(error instanceof Error) || !sentMessages) {
    return null
  }
  const match = /messages\.(\d+)\.content\.(\d+)/i.exec(error.message)
  if (!match) {
    return null
  }
  const message = sentMessages[Number(match[1])]
  const blocks = message && typeof message.content !== 'string' ? message.content : null
  const block = blocks?.[Number(match[2])]
  return block && block.type === 'image' && block.source.type === 'file'
    ? block.source.file_id
    : null
}

/**
 * 「图片不被接受」自愈：先按报错定位到具体哪张，只重置它（重传时转成 PNG）；
 * 同一张第二次被点名说明救不回来，直接从会话里移除该附件再重发。
 * 定位失败时退一次「全部重置」。返回是否需要重试。
 */
const healUnsupportedImage = (
  sessionId: string,
  request: Request,
  error: unknown,
  sentMessages: MessageParam[] | null,
  heal: { ids: Set<string>; fallback: boolean; omitted: Map<string, FileAttachment> }
): boolean => {
  const id = blamedServerId(error, sentMessages)
  if (id) {
    const session = getSession(sessionId)
    const hit = (session ? allSessionMessages(session) : [])
      .filter((message): message is UserMessage => message.role === 'user')
      .flatMap((message) => message.files)
      .find((file) => file.serverId === id)
    if (!hit) {
      return false
    }
    if (heal.ids.has(hit.id)) {
      heal.omitted.set(hit.id, hit)
      resetAttachmentServerIds(sessionId, new Set([id]))
      markAttachmentInvalid(hit.id)
      logEvent(
        'chat',
        'attachment.omitted',
        { fileId: hit.id, reason: 'server-rejected-image' },
        'warn'
      )
    } else {
      heal.ids.add(hit.id)
      resetAttachmentServerIds(sessionId, new Set([id]))
    }
    return true
  }
  if (heal.fallback) {
    return false
  }
  heal.fallback = true
  return reuploadInvalidatedFiles(sessionId, request, error, true)
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (
  sessionId: string,
  initial: AssistantMessage,
  original: Request,
  mode: CompressionMode = 'ask',
  reportedLimit?: number
) => {
  let request = original
  const rounds = contextRounds(original.history, original.inherited)
  let summary = applicableSummary(getSession(sessionId)?.contextSummary, rounds)
  let compressionAttempted = false
  let checkPressure = true
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  /** 最近一次实际发出的 messages：报错里的 messages.N.content.M 靠它定位 */
  let sentMessages: MessageParam[] | null = null
  /** 图片自愈进度：已重置过的附件 id；定位失败时是否已用过兜底 */
  const omitted = new Map<string, FileAttachment>()
  const heal = { ids: new Set<string>(), fallback: false, omitted }
  logEvent('chat', 'reply.started', {
    sessionId,
    replyId: initial.id,
    historyMessages: request.history.length,
    inheritedMessages: request.inherited?.messages.length ?? 0,
    questionFiles: request.question.files.length,
    thinking: initial.thinking,
    search: initial.search,
  })
  let usageBase = request.prefix ? initial.usage : undefined
  const usageHistory = request.prefix ? usageEntries(initial) : []
  let searchResult = initial.blocks.find(
    (block) => block.type === 'web_search_tool_result' && block.tool_use_id.startsWith('search-')
  )
  const requestStartedAt = Date.now()
  let connection: Connection | undefined
  let inlineAttempted = false
  let documentTexts: ReadonlyMap<string, string> | undefined

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = false
      let receivedContent = false
      let preparedContext: Request | undefined
      let documentCount: number | undefined
      try {
        connection ??= resolveConnection(initial.connection, initial.model)
        if (checkPressure) {
          checkPressure = false
          const recovering = mode === 'recover'
          // A rejected turn stays pending while only the earlier history is prepared for compression.
          // The model window and earlier rounds suffice here, even when attachments expand on the server.
          const pressure = recovering
            ? undefined
            : planCompression(
                rounds,
                summary,
                connection,
                {
                  ...original,
                  system: initial.systemPrompt ?? original.persona?.prompt,
                },
                reportedLimit
              )
          const plan: SummaryPlan = pressure ?? {
            start: summary?.coveredRounds ?? 0,
            end: rounds.length,
            limit: reportedLimit ?? contextLength(connection),
          }
          const canReduce = plan.end > plan.start
          if (mode === 'compress' && !canReduce) {
            throw new ApiError('protocol', { key: 'compressionUnavailable' })
          }
          const nearLimit = mode === 'ask' && pressure?.near && !pressure.currentTooLarge
          const autoCompress = nearLimit && useSettings.getState().autoCompress
          if (canReduce && nearLimit && !autoCompress) {
            const session = getSession(sessionId)
            if (session && !session.compressionPromptShown) {
              updateSession(sessionId, (item) => ({ ...item, compressionPromptShown: true }))
              if (
                !session.messages.some(
                  (item) =>
                    item.role === 'assistant' &&
                    item.error?.localMessage?.key === 'compressionSuggested'
                )
              ) {
                throw new ApiError('protocol', {
                  key: 'compressionSuggested',
                  params: plan.historyEstimate && compressionEstimateParams(plan.historyEstimate),
                })
              }
            }
          }
          if (canReduce && (recovering || mode === 'compress' || autoCompress)) {
            compressionAttempted = true
            try {
              summary = await compressRounds(
                sessionId,
                connection,
                rounds,
                summary,
                plan,
                controller.signal
              )
            } catch (error) {
              controller.signal.throwIfAborted()
              const failure = describeCompressionFailure(error)
              throw new ApiError('protocol', {
                ...failure,
                params: recovering
                  ? {
                      ...failure.params,
                      recoverContext: 1,
                      ...(reportedLimit ? { contextLimitTokens: reportedLimit } : {}),
                    }
                  : failure.params,
              })
            }
          }
          if (summary) {
            request = {
              ...original,
              inherited: undefined,
              history: rounds
                .slice(summary.coveredRounds)
                .flatMap(([user, assistant]) => [user, assistant]),
            }
          }
        }
        // File preparation and the answer request only start after the summary stream completes.
        if (
          connection.kind === 'deepseek' &&
          connection.model === 'deepseek-v4-pro' &&
          [
            request.question,
            ...getContextRounds(request.history).map(([q]) => q),
            ...getContextRounds(request.inherited?.messages ?? []).map(([q]) => q),
          ].some((q) => q.files.some((file) => file.isImage))
        ) {
          throw new ApiError('protocol', { key: 'providerProNoImages' })
        }
        preparing = connection.kind === 'deepseek'
        const rawPrepared =
          connection.kind === 'deepseek'
            ? await prepareFiles(sessionId, request, controller.signal, omitted, connection.apiKey)
            : refreshRequest(sessionId, request)
        if (!rawPrepared.question.content.trim() && rawPrepared.question.files.length === 0) {
          throw new ApiError('protocol', { key: 'replyNoReadableAttachment' })
        }
        let prepared = withSummaryText(rawPrepared, summary)
        preparedContext = prepared
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const originalMessages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          prepared.inherited?.messages
        )
        const messages = documentTexts
          ? inlineDocuments(originalMessages, documentTexts)
          : originalMessages
        sentMessages = messages
        if (connection.kind === 'deepseek') {
          documentCount = messages.reduce(
            (count, message) =>
              message.role === 'user' && Array.isArray(message.content)
                ? count + message.content.filter((part) => part.type === 'document').length
                : count,
            0
          )
        }
        if (connection.kind === 'custom' && initial.search && original.question.content.trim()) {
          if (searchResult?.type !== 'web_search_tool_result') {
            const searched = await searchForCustomModel(
              original.question.content,
              thirdPartySearchKey(useSettings.getState()),
              controller.signal
            )
            searchResult = searched.result
            reply = { ...reply, blocks: [...reply.blocks, searched.call, searched.result] }
            if (searched.billed) {
              const usage = {
                input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
                standalone_search_requests: 1,
              }
              usageBase = sumMessageUsage(usageBase, usage)
              usageHistory.push({ createdAt: Date.now(), usage, model: connection.model })
              reply = { ...reply, usage: usageBase, usageHistory: [...usageHistory] }
            }
            flush()
            persist(sessionId)
          }
          const references = searchContext(searchResult)
          prepared = {
            ...prepared,
            question: { ...prepared.question, content: prepared.question.content + references },
          }
          preparedContext = prepared
        }
        logEvent('chat', 'request.prepared', {
          sessionId,
          replyId: initial.id,
          attempt,
          messagesCount: messages.length,
          bodyBytes: new Blob([JSON.stringify(messages)]).size,
          omittedFiles: omitted.size,
          compressedRounds: summary?.coveredRounds ?? 0,
          currentFiles: prepared.question.files.length,
          historyFiles: contextRounds(prepared.history, prepared.inherited).reduce(
            (total, [question]) => total + question.files.length,
            0
          ),
        })
        const events =
          connection.kind === 'custom'
            ? streamProviderMessage(
                connection.profile,
                connection.model,
                await prepareProviderMessages(
                  connection.profile,
                  prepared,
                  controller.signal,
                  async (id) =>
                    pendingFiles.get(sessionId)?.find((file) => file.id === id)?.blob ??
                    db.loadFile(id)
                ),
                initial.systemPrompt ??
                  (request.persona?.prompt.trim()
                    ? request.persona.prompt
                    : 'You are a helpful assistant.'),
                controller.signal,
                initial.reasoning
              )
            : streamMessage(
                connection.apiKey,
                {
                  model: initial.model ?? MODEL,
                  // 人设提示词覆盖默认助手身份说明
                  system:
                    initial.systemPrompt ??
                    (request.persona?.prompt.trim() ? request.persona.prompt : SYSTEM_PROMPT),
                  messages,
                  thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
                  ...(initial.reasoning?.level === 'low' ||
                  initial.reasoning?.level === 'high' ||
                  initial.reasoning?.level === 'max'
                    ? { output_config: { effort: initial.reasoning.level } }
                    : {}),
                  safety_check: SAFETY_CHECK,
                  tools: serverTools(initial.search ?? false),
                  ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
                },
                controller.signal
              )
        const blockIndexes = new Map<number, number>()
        const usageStartedAt = Date.now()
        for await (const event of events) {
          if (event.type === 'message_start' && validModel(event.message.model)) {
            reply = { ...reply, responseModel: event.message.model }
          }
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          const usage =
            event.type === 'message_start'
              ? event.message.usage
              : event.type === 'message_delta'
                ? event.usage
                : undefined
          if (usage) {
            reply = {
              ...reply,
              usage: sumMessageUsage(usageBase, usage),
              usageHistory: [
                ...usageHistory,
                {
                  createdAt: usageStartedAt,
                  usage,
                  model: reply.responseModel ?? reply.model ?? undefined,
                },
              ],
            }
          }
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        if (connection.kind === 'custom' && titleRequests.has(controller)) {
          updateSession(sessionId, (session) =>
            session.title
              ? session
              : {
                  ...session,
                  title: (
                    request.question.content.trim() ||
                    request.question.files[0]?.name ||
                    ''
                  ).slice(0, 40),
                }
          )
        }
        break
      } catch (error) {
        logEvent(
          'chat',
          'reply.attempt.failed',
          {
            sessionId,
            replyId: initial.id,
            attempt,
            preparing,
            cancelled: controller.signal.aborted,
            ...diagnosticError(error),
          },
          controller.signal.aborted ? 'info' : 'error'
        )
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            status: error instanceof ApiError ? error.status : undefined,
            retryable: !(error instanceof UnsupportedImageError) && isRetryableUploadError(error),
          })
          break
        }
        const local = error instanceof ApiError ? error.localMessage : undefined
        if (error instanceof ApiError && local && isContextRejection(local.key) && connection) {
          const params = { ...apiLimitCounts(error.message), ...local.params }
          reportedLimit = Number(params.contextLimitTokens) || reportedLimit
          if (preparedContext) {
            const sentRounds = contextRounds(preparedContext.history, preparedContext.inherited)
            const question = preparedContext.question
            params.estimatedRequestTokens =
              estimateContextHistory(sentRounds).tokens +
              estimatedSystemTokens(initial.systemPrompt ?? '') +
              estimatedUserTokens(question) +
              (preparedContext.prefix ? estimatedTokens(getReplyText(preparedContext.prefix)) : 0) +
              contextReplyReserve(connection)
            params.requestQuestionFiles = question.files.length
          }
          if (documentCount !== undefined) {
            params.requestDocumentCount = documentCount
            if (local.key === 'replyDocumentCountLimit') {
              params.documentLimit ??= DEEPSEEK_DOCUMENT_LIMIT
            }
          }
          logEvent(
            'chat',
            'request.context.rejected',
            { sessionId, replyId: reply.id, ...params },
            'warn'
          )
          const limit = reportedLimit ?? contextLength(connection)
          if (
            !receivedContent &&
            !inlineAttempted &&
            connection.kind === 'deepseek' &&
            documentCount &&
            preparedContext &&
            sentMessages
          ) {
            inlineAttempted = true
            const allowed = Number(params.documentLimit)
            const texts = await localDocumentRetry(
              sessionId,
              preparedContext,
              sentMessages,
              controller.signal,
              (limit ?? Infinity) - Number(params.estimatedRequestTokens ?? 0),
              allowed ? Math.max(1, documentCount - allowed) : Infinity
            ).catch(() => new Map<string, string>())
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            if (texts.size && (!allowed || documentCount - texts.size <= allowed)) {
              documentTexts = texts
              logEvent('chat', 'request.documents.inlined', { sessionId, count: texts.size })
              continue
            }
          }
          if (
            !receivedContent &&
            local.key === 'replyContextTooLong' &&
            connection.kind === 'custom' &&
            limit &&
            connection.profile.maxOutputTokens >= limit
          ) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'protocol',
              message: '',
              localMessage: { key: 'replyOutputLimitInvalid', params },
            })
            break
          }
          const documentLimit = local.key !== 'replyContextTooLong'
          const currentDocs = new Set(
            preparedContext?.question.files.flatMap(({ isImage, serverId }) =>
              !isImage && serverId && !documentTexts?.has(serverId) ? [serverId] : []
            )
          ).size
          if (
            !receivedContent &&
            (!rounds.length ||
              (summary?.coveredRounds ?? 0) >= rounds.length ||
              (documentLimit && documentCount !== undefined && currentDocs >= documentCount) ||
              (local.key === 'replyDocumentCountLimit' &&
                currentDocs > Number(params.documentLimit)))
          ) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'protocol',
              message: '',
              localMessage: {
                key: documentLimit
                  ? 'replyDocumentInputLimit'
                  : summary
                    ? 'compressionStillTooLong'
                    : 'compressionInputLarge',
                params,
              },
            })
            break
          }
          if (
            !receivedContent &&
            mode !== 'send' &&
            !compressionAttempted &&
            useSettings.getState().autoCompress
          ) {
            checkPressure = true
            mode = 'recover'
            continue
          }
          local.params = params
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          connection?.kind === 'deepseek' &&
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        // 图片被判定不可用：多为导入记录里的 BMP/HEIC/损坏图。
        // 定位到具体哪张就只处理它；救不回来直接移除该附件，别让一张图卡死整个对话。
        if (
          connection?.kind === 'deepseek' &&
          attempt < IMAGE_HEAL_ATTEMPTS &&
          !receivedContent &&
          isUnsupportedImageError(error) &&
          healUnsupportedImage(sessionId, request, error, sentMessages, heal)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else if (error instanceof ProviderConfigError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: '',
            localMessage: {
              key: error.reason === 'changed' ? 'providerConfigChanged' : 'providerConfigMissing',
            },
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    if (omitted.size > 0) {
      reply = {
        ...reply,
        contextWarnings: [
          {
            key: 'contextAttachmentsSkipped',
            params: {
              count: omitted.size,
              files: [...omitted.values()]
                .slice(0, 3)
                .map((file) => file.name)
                .join('、'),
            },
          },
        ],
      }
    }
    logEvent('chat', 'reply.settled', {
      sessionId,
      replyId: initial.id,
      status: reply.status,
      stopReason: reply.stopReason,
      elapsedMs: Date.now() - requestStartedAt,
      omittedFiles: omitted.size,
      inputTokens: reply.usage?.input_tokens,
      outputTokens: reply.usage?.output_tokens,
    })
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}

/** 应用人设仅影响后续生成，已有回复及续写快照保留。 */
export const setSessionPersona = (
  sessionId: string,
  persona: { name: string; prompt: string } | null
): boolean => {
  if (get().importingHistory || getStreamController(sessionId) || !getSession(sessionId)) {
    return false
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'assistant' && message.systemPrompt === undefined
        ? {
            ...message,
            systemPrompt:
              session.persona?.prompt ||
              (!message.connection || message.connection.providerId === 'deepseek'
                ? SYSTEM_PROMPT
                : 'You are a helpful assistant.'),
          }
        : message
    ),
    persona,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  return true
}

// 会话选择变化时持久化，App 重启后恢复上次打开的会话
useChatStore.subscribe((state) => {
  if (state.activeId === lastActiveId) {
    return
  }
  lastActiveId = state.activeId
  writeActiveSession(state.activeId)
})
