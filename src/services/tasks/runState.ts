import type { FileAttachment, Message } from '../chat/types.js'

/**
 * Durable user-facing execution state. Model transcripts and credentials do not belong here.
 */
export type AgentRunMode = 'task' | 'plan' | 'goal'
export type AgentRunStatus =
  | 'planning'
  | 'awaiting-review'
  | 'awaiting-input'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'partial'
  | 'completed'
  | 'stopped'
  | 'failed'

export type AgentStopReason =
  | 'budget-time'
  | 'budget-requests'
  | 'context-limit'
  | 'output-limit'
  | 'tools-unavailable'
  | 'provider-error'
  | 'source-failed'
  | 'waiting-browser'
  | 'waiting-foreground'
  | 'criteria-unmet'
  | 'no-progress'
  | 'interrupted'
  | 'storage'
  | 'host-unavailable'
  | 'checkpoint-missing'
  | 'host-busy'
  | 'request-unconfirmed'
  | 'tool-unconfirmed'
  | 'provider-rate-limit'
  | 'provider-timeout'
  | 'connection-changed'
  | 'notification-permission'
  | 'system-timeout'
  | 'user'

export type AgentBudgetMinutes = 5 | 15 | 30

export const goalBudgets = {
  5: 12,
  15: 40,
  30: 80,
} as const

export type AgentGoalDraft = {
  criteria: string[]
  minutes: AgentBudgetMinutes
}

export type AgentTaskRun = {
  id: string
  mode: AgentRunMode
  status: AgentRunStatus
  revision: number
  approvedRevision?: number
  question?: string
  reason?: AgentStopReason
  criteria: string[]
  /** Criteria marked complete by the runtime after checking the referenced evidence or artifact. */
  met: number[]
  budgetMinutes: AgentBudgetMinutes
  budgetRequests: number
  /** Cumulative limit across automatic rounds and user-directed resumes. */
  requestLimit?: number
  segmentRequests: number
  totalRequests: number
  startedAt: number
  elapsedMs: number
  elapsedBeforeResume?: number
  retryAt?: number
  foregroundTool?: { id: string; name: string }
  requestInFlight?: boolean
  background?: boolean
  toolMask?: number
}

export type AgentResumeOptions = {
  retryUnconfirmed?: boolean
  addRequests?: boolean
  useCurrentConnection?: boolean
}

export const taskRequestLimit = (run: AgentTaskRun) =>
  run.requestLimit ?? Math.max(0, run.totalRequests - run.segmentRequests) + run.budgetRequests

export const resumeLimit = (run: AgentTaskRun, options?: AgentResumeOptions) =>
  taskRequestLimit(run) + (options?.addRequests ? run.budgetRequests : 0)

export const isAgentRunMode = (value: unknown): value is AgentRunMode =>
  value === 'task' || value === 'plan' || value === 'goal'

export const isAgentBudgetMinutes = (value: unknown): value is AgentBudgetMinutes =>
  value === 5 || value === 15 || value === 30

export const defaultAgentGoal = (): AgentGoalDraft => ({ criteria: [], minutes: 15 })

export const beginAgentRun = (
  id: string,
  mode: AgentRunMode,
  goal: AgentGoalDraft = defaultAgentGoal(),
  now = Date.now()
): AgentTaskRun => ({
  id,
  mode,
  status: mode === 'plan' ? 'planning' : 'running',
  revision: mode === 'plan' ? 1 : 0,
  criteria: mode === 'goal' ? goal.criteria : [],
  met: [],
  budgetMinutes: goal.minutes,
  budgetRequests: goalBudgets[goal.minutes],
  requestLimit: goalBudgets[goal.minutes],
  segmentRequests: 0,
  totalRequests: 0,
  startedAt: now,
  elapsedMs: 0,
})

export const canResumeAgentRun = (run: AgentTaskRun) =>
  run.status === 'paused' ||
  run.status === 'blocked' ||
  run.status === 'partial' ||
  run.status === 'failed'
export const resumesInForeground = (reason: AgentStopReason | undefined) =>
  reason === 'waiting-browser' ||
  reason === 'waiting-foreground' ||
  reason === 'checkpoint-missing' ||
  reason === 'host-busy' ||
  reason === 'host-unavailable' ||
  reason === 'notification-permission'
export const isPlanWaitingForUser = (
  run: AgentTaskRun | undefined
): run is AgentTaskRun & { status: 'awaiting-review' | 'awaiting-input' } =>
  run?.mode === 'plan' && (run.status === 'awaiting-review' || run.status === 'awaiting-input')

export const planConversation = (history: readonly Message[]) => {
  const last = history.at(-1)
  const waiting = last?.role === 'assistant' ? last.task?.run : undefined
  if (!isPlanWaitingForUser(waiting)) {
    return undefined
  }
  const files = new Map<string, FileAttachment>()
  let request = ''
  let draft: string[] | undefined
  // Stay on this branch and carry only the files from the current, unresolved planning exchange.
  for (let index = history.length - 1; index >= 1; index -= 2) {
    const reply = history[index]
    const input = history[index - 1]
    if (
      input.role !== 'user' ||
      reply.role !== 'assistant' ||
      !isPlanWaitingForUser(reply.task?.run)
    ) {
      break
    }
    request = input.content
    if (!draft && reply.task?.run?.status === 'awaiting-review') {
      draft = reply.task.plan.map(({ label }) => label)
    }
    for (const file of input.files) {
      if (files.size < 16 && !files.has(file.id)) {
        files.set(file.id, file)
      }
    }
  }
  return {
    revision: waiting.revision + (waiting.status === 'awaiting-review' ? 1 : 0),
    request,
    draft,
    question: waiting.question,
    files: [...files.values()],
  }
}
