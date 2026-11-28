import { createId } from '../../utils/id.js'
import type { VoiceRole } from '../speech/roleMarkers.js'
import { sessionRoles } from '../speech/roleTable.js'
import { getVisibleMessages } from './branches.js'
import { applicableSummary, contextRounds, rebaseContextSummary } from './contextCompression.js'
import type {
  AssistantMessage,
  ContextSummary,
  InheritedContext,
  Message,
  Session,
} from './types.js'

export const canBranchFromReply = (message: AssistantMessage) => message.status === 'done'

const copyVisibleHistory = (history: Message[], copiedIds: Map<string, string>): Message[] => {
  const ids = history.map(() => createId())
  return history.map((message, index) => {
    copiedIds.set(message.id, ids[index])
    const links = {
      id: ids[index],
      parentId: ids[index - 1] ?? null,
      selectedChildId: ids[index + 1],
    }
    if (message.role === 'user') {
      return { ...message, ...links }
    }
    const { task } = message
    return {
      ...message,
      ...links,
      usage: undefined,
      usageHistory: undefined,
      nativeActivity: undefined,
      toolInputAt: undefined,
      task: task
        ? {
            plan: task.plan,
            steps: task.steps.map((step) =>
              step.status === 'working' ? { ...step, status: 'stopped' as const } : step
            ),
            artifacts: task.artifacts,
            warning: task.warning,
          }
        : undefined,
    }
  })
}

const copySummary = (
  summary: ContextSummary | undefined,
  before: ReturnType<typeof contextRounds>,
  after: ReturnType<typeof contextRounds>
) => applicableSummary(rebaseContextSummary(summary, before, after), after)

const copyVoiceRoles = (roles: VoiceRole[] | undefined, copiedIds: ReadonlyMap<string, string>) =>
  roles?.map((role) => ({
    ...role,
    aliases: [...role.aliases],
    ...(role.introducedBy && { introducedBy: copiedIds.get(role.introducedBy) ?? role.introducedBy }),
  }))

const copyInheritedHistory = (
  source: InheritedContext | null | undefined,
  copiedIds: Map<string, string>
) => {
  if (!source) {
    return source
  }
  const messages = copyVisibleHistory(source.messages, copiedIds)
  return {
    ...source,
    messages,
    voiceRoles: copyVoiceRoles(source.voiceRoles, copiedIds),
    contextSummary: source.contextSummary
      ? copySummary(source.contextSummary, contextRounds(source.messages), contextRounds(messages))
      : undefined,
  }
}

export const createBranchSnapshot = (source: Session, messageId: string): Session | undefined => {
  const visible = getVisibleMessages(source)
  const target = visible.findIndex((message) => message.id === messageId)
  const reply = visible[target]
  if (reply?.role !== 'assistant' || !canBranchFromReply(reply)) {
    return
  }
  const history = visible.slice(0, target + 1)
  const copiedIds = new Map<string, string>()
  const inherited = copyInheritedHistory(source.inherited, copiedIds)
  const messages = copyVisibleHistory(history, copiedIds)
  const now = Date.now()
  const branch: Session = {
    id: createId(),
    title: source.title,
    createdAt: now,
    updatedAt: now,
    branchFrom: { sessionId: source.id, messageId },
    messages,
    rootMessageId: messages[0].id,
    inherited,
    persona: source.persona,
    mode: source.mode,
    agent: source.agent,
    agentRunMode: source.agentRunMode,
    memoryPaused: source.memoryPaused,
    voiceRoles: source.voiceRoles && copyVoiceRoles(sessionRoles(source, history), copiedIds),
    roleVoiceLive: source.roleVoiceLive,
  }
  if (source.contextSummary) {
    const before = contextRounds(history, source.inherited)
    const after = contextRounds(messages, inherited)
    branch.contextSummary = copySummary(source.contextSummary, before, after)
  }
  return branch
}
