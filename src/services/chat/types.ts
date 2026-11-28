import type { AgentRunMode } from '../tasks/runState.js'
import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type { AgentProfile, AgentRef } from '../assistants/library.js'
import type { MemoryUse } from '../assistants/memory.js'
import type { TaskProgress } from '../tasks/tools.js'
import type { ConnectionRef } from '../providers.js'
import type { VoiceRole } from '../speech/roleMarkers.js'
import type { ReasoningChoice } from '../reasoning.js'
import type {
  ChatModel,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

/** 思考块：thinking_delta 累积，签名随 signature_delta 到达；历史轮次的思考服务端会丢弃，不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** 开始接收思考内容的时间。没有事件时间的历史块缺省。 */
  startedAt?: number
  /** 最后一次收到该段思考内容的时间。 */
  endedAt?: number
  /** 流式生成时记录最后一个思考片段的时间，收尾后移除。 */
  lastDeltaAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
export type ReplyBlock = ThinkingPart | TextPart | ServerToolBlock

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前默认模型。 */
  model: ChatModel | null
  /** 服务响应声明的模型；请求模型保持不变，供别名转发时估算费用。 */
  responseModel?: string
  /** 仅保存配置引用与修订号，不保存服务地址、密钥或请求头。 */
  connection?: ConnectionRef
  /** 续写沿用该轮的人设，即使后来更改了会话人设。 */
  systemPrompt?: string
  agent?: Pick<AgentProfile, 'id' | 'name' | 'search' | 'attachments' | 'memory'>
  memoryUse?: MemoryUse
  memoryReadFailed?: boolean
  task?: TaskProgress
  /** 当前模型正在发送工具调用参数。回复结束时清除。 */
  toolInputAt?: number
  nativeActivity?: { phase: 'waiting' | 'thinking' | 'tool-input' | 'writing'; updatedAt: number }
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  reasoning?: ReasoningChoice
  /** 请求时是否声明 deepseek_web_search；关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /** 是否允许作为续写前缀；仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列；续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 本条回复历次请求的累计用量；逐次明细见 usageHistory。 */
  usage?: MessageUsage
  /** 每次请求分别保存用量与时间，续写不覆盖已产生的费用。 */
  usageHistory?: { createdAt: number; usage: MessageUsage; model?: string }[]
  /** 本轮未能读取的附件提示；原始消息与原件仍保留。 */
  contextWarnings?: TranslationMessage[]
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: TranslationMessage
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage
export type ChatMode = 'chat' | 'agent'

/** 对话接续：新会话创建时对来源会话当前路径消息的快照 */
export type InheritedContext = {
  fromId: string
  fromTitle: string
  contextSummary?: ContextSummary
  messages: Message[]
  /** 接续时带上源会话的角色配音表快照，新会话以此为初始角色表 */
  voiceRoles?: VoiceRole[]
}

/** Zero-based history round indexes. The end is excluded. */
export type ContextRoundRange = { start: number; end: number }

export type ContextSummary = {
  text: string
  /** The user continued with recent turns while keeping the complete local history. */
  recentOnly?: boolean
  coveredRounds: number
  /** Original rounds inside the processed prefix that the summarizer declined. */
  retainedRanges?: ContextRoundRange[]
  signature: string
  updatedAt: number
  /** Estimated tokens in the retained chat history immediately before and after this compression. */
  historyEstimate?: { before: number; after: number }
}

export type CompressionCharge = {
  createdAt: number
  model: string
  connection: ConnectionRef
  usage: MessageUsage
}

/** Local continuation state for a summary that has yet to replace the active context. */
export type CompressionCheckpoint = {
  scope: string
  text: string
  offset: number
  segmentLimit: number
  outputTokens: number
  windowTokens: number
  targetRounds?: number
  /** Original rounds already reviewed in this pass. */
  retainedRanges?: ContextRoundRange[]
  /** Snapshot before a split round, so a later refusal can keep the entire round verbatim. */
  completedText?: string
  /** Legacy marker from versions that stopped at the first refusal. */
  refused?: true
}

/** Link back to the reply where this independent conversation started. */
export type ConversationBranch = { sessionId: string; messageId: string }

export type Session = {
  /** Missing in older sessions, which open as ordinary chats. */
  mode?: ChatMode
  agentRunMode?: AgentRunMode
  workspaceId?: string
  contextSummary?: ContextSummary
  compressionPromptShown?: boolean
  compressionUsage?: CompressionCharge[]
  compressionCheckpoint?: CompressionCheckpoint
  id: string
  title: string
  pinned?: boolean
  createdAt: number
  updatedAt: number
  branchFrom?: ConversationBranch
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
  /** 对话接续：请求时置于上下文最前，不在界面展示；完整本机备份保留该字段。 */
  inherited?: InheritedContext | null
  /** 创建会话时的人设快照：prompt 覆盖默认 system 提示词；null 表示默认助手身份。 */
  persona?: { name: string; prompt: string } | null
  /** 角色配音表：回答里首次出场的角色及其音色；缺省表示本会话没有角色。 */
  voiceRoles?: VoiceRole[]
  roleVoiceLive?: boolean
  agent?: AgentRef | null
  memoryPaused?: boolean
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<
  Session,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'pinned' | 'mode' | 'branchFrom'
>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  pinned: session.pinned,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.mode && { mode: session.mode }),
  ...(session.branchFrom && { branchFrom: session.branchFrom }),
})
