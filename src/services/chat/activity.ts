import type { TranslationKey } from '../../i18n/index.js'
import type { LiveReplyProgress } from '../tasks/goalBridge.js'
import type { AssistantMessage } from './types.js'
import type { ReplyView } from './view.js'

export const replyActivityPhase = (message: AssistantMessage, view?: ReplyView): TranslationKey => {
  const tool = message.task?.steps.find((step) => step.status === 'working')
  if (tool) {
    if (tool.detail === 'waiting-approval') {
      return 'agentWaitingToolApproval'
    }
    if (tool.kind === 'search') {
      return 'replyActivitySearch'
    }
    if (tool.kind === 'read') {
      return 'replyActivityAttachment'
    }
    if (['web', 'browser', 'github'].includes(tool.kind)) {
      return 'replyActivityReading'
    }
    return 'replyActivityTool'
  }
  if (message.task && message.status === 'pending') {
    return 'agentConnectingModel'
  }
  if (message.nativeActivity) {
    return {
      waiting: 'replyActivityWaiting',
      thinking: 'agentThinkingActive',
      'tool-input': 'replyActivityPreparingTool',
      writing: 'replyActivityAnswer',
    }[message.nativeActivity.phase] as TranslationKey
  }
  if (message.toolInputAt !== undefined) {
    return 'replyActivityPreparingTool'
  }
  const recentTool = message.task?.steps.at(-1)
  if (recentTool?.blockIndex === message.blocks.length) {
    return 'replyActivityWaiting'
  }
  const last = message.blocks.at(-1)
  if (
    last?.type === 'thinking' &&
    last.endedAt === undefined &&
    (last.startedAt !== undefined || last.thinking)
  ) {
    return 'agentThinkingActive'
  }
  const step = view?.steps.at(-1)
  if (step?.type === 'search' && step.status === 'wip') {
    return 'replyActivitySearch'
  }
  if (
    (step?.type === 'read_link' && step.links.some(({ status }) => status === 'wip')) ||
    (step?.type === 'open' && step.pages.some(({ status }) => status === 'wip'))
  ) {
    return 'replyActivityReading'
  }
  if (!view && last?.type === 'server_tool_use') {
    return last.input.action === 'search' ? 'replyActivitySearch' : 'replyActivityReading'
  }
  return last?.type === 'text' && last.text && !last.isTemplate
    ? 'replyActivityAnswer'
    : 'replyActivityWaiting'
}

const livePhase: Partial<Record<TranslationKey, LiveReplyProgress['phase']>> = {
  agentThinkingActive: 'thinking',
  replyActivityAttachment: 'attachments',
  replyActivitySearch: 'searching',
  replyActivityReading: 'reading',
  replyActivityPreparingTool: 'working',
  replyActivityTool: 'working',
  replyActivityAnswer: 'writing',
}

export const liveReplyActivity = (message: AssistantMessage): LiveReplyProgress => {
  const phase = livePhase[replyActivityPhase(message)] ?? 'waiting'
  const plan = message.task?.plan ?? []
  const working = plan.findIndex((step) => step.status === 'working')
  return working < 0 ? { phase } : { phase, step: working + 1, total: plan.length }
}
