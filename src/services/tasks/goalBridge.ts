import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { logEvent } from '../diagnostics/log.js'
import { abortableDelay } from '../../utils/abort.js'
import type { TaskArtifact, TaskProgress } from './tools.js'
import type { GoalInput } from './goalKernel.js'
import type { AgentTaskRun } from './runState.js'
import type { ProviderProfile } from '../providers.js'
import type { CacheCounts } from '../api/types.js'

export type GoalWire = {
  protocol: ProviderProfile['protocol']
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export type GoalSnapshot = Required<Pick<TaskProgress, 'plan' | 'steps' | 'artifacts'>> & {
  run: AgentTaskRun
  answer?: string
  blocks?: { type: 'text'; text: string }[]
  blockCount?: number
  blockOffset?: number
  activity?: { phase: 'waiting' | 'thinking' | 'tool-input' | 'writing'; updatedAt: number }
  usageEntries?: NonNullable<import('../chat/types.js').AssistantMessage['usageHistory']>
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cacheCounts?: CacheCounts | null
  }
}

type GoalBridge = {
  permission: () => Promise<{ granted: boolean }>
  start: (options: {
    id: string
    sessionId?: string
    chinese?: boolean
    input: GoalInput
    wire: Pick<GoalWire, 'url' | 'headers'>
    resume: boolean
    retryUnconfirmed?: boolean
  }) => Promise<{ started: boolean; reason?: string }>
  snapshot: (options: { id: string; offset?: number }) => Promise<{ snapshot?: GoalSnapshot }>
  pendingTool?: (options: {
    id: string
  }) => Promise<{ tool?: { id: string; name: string; args: Record<string, unknown> } }>
  control: (options: { id: string; action: 'pause' | 'end' }) => Promise<{ changed: boolean }>
  forget?: (options: { id: string } | { all: true }) => Promise<{ deleted: boolean }>
  file: (options: {
    id: string
    fileId: string
    offset: number
  }) => Promise<{ base64: string; nextOffset: number }>
}

declare global {
  interface Window {
    freeseekAgentGoals?: GoalBridge
  }
}

type GoalActivity = { sessionId: string | null }
type WorkOutcome = 'quiet' | 'completed' | 'attention'
export type LiveReplyProgress = {
  phase: 'waiting' | 'thinking' | 'attachments' | 'compressing' | 'searching' | 'reading' | 'working' | 'writing'
  step?: number
  total?: number
}
type NoticeStatus = { granted: boolean; liveProgressEnabled?: boolean; liveProgressAllowed?: boolean }

const Native = registerPlugin<
  GoalBridge & {
    activeGoal(): Promise<GoalActivity>
    addListener(
      event: 'goalActivity',
      listener: (value: GoalActivity) => void
    ): Promise<PluginListenerHandle>
    retainReply(options: {
      lease: string
      sessionId: string
      agent: boolean
      chinese: boolean
    }): Promise<{ retained: boolean; liveProgressAvailable?: boolean }>
    finishReply(options: { lease: string; outcome: WorkOutcome }): Promise<void>
    replyProgress(options: { lease: string } & Partial<LiveReplyProgress>): Promise<void>
    viewingSession(options: { sessionId: string | null }): Promise<void>
    forgetNotices(options: { sessionId: string } | { all: true }): Promise<void>
    noticeStatus(): Promise<NoticeStatus>
    noticeSettings(): Promise<NoticeStatus>
    requestNotices(): Promise<NoticeStatus>
    setLiveProgress(options: { enabled: boolean }): Promise<NoticeStatus>
    pauseForAccessChange(): Promise<void>
  }
>('AgentGoals')

export const hasAndroidBackgroundWork = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AgentGoals')

export const pauseNativeAgentForAccessChange = () => {
  if (hasAndroidBackgroundWork()) {
    void Native.pauseForAccessChange().catch(() => {})
  }
}

export const agentGoalBridge = (): GoalBridge | undefined =>
  hasAndroidBackgroundWork() ? Native : window.freeseekAgentGoals

export const useNativeGoalActivity = create<GoalActivity>(() => ({ sessionId: null }))

export const bindNativeGoalActivity = () => {
  if (!hasAndroidBackgroundWork()) {
    return
  }
  let disposed = false
  let revision = 0
  const listener = Native.addListener('goalActivity', ({ sessionId }) => {
    revision++
    if (!disposed) {
      useNativeGoalActivity.setState({ sessionId })
    }
  })
  void listener
    .then(async () => {
      const before = revision
      const value = await Native.activeGoal()
      if (!disposed && before === revision) {
        useNativeGoalActivity.setState(value)
      }
    })
    .catch(() => {})
  return () => {
    disposed = true
    void listener.then((handle) => handle.remove()).catch(() => {})
  }
}

export const retainBackgroundReply = (sessionId: string, agent: boolean, chinese: boolean) => {
  if (!hasAndroidBackgroundWork()) {
    return undefined
  }
  const lease = createId()
  const retained = Native.retainReply({ lease, sessionId, agent, chinese })
    .catch(() => ({ retained: false, liveProgressAvailable: false }))
  let released = false
  let refreshedAt = performance.now()
  let lastProgress: LiveReplyProgress | undefined
  const finish = (outcome: WorkOutcome) => {
    if (released) {
      return
    }
    released = true
    void retained
      .then(({ retained: enabled }) => {
        return enabled ? Native.finishReply({ lease, outcome }) : undefined
      })
      .catch(() => {})
  }
  const progress = () => {
    const now = performance.now()
    if (!released && now - refreshedAt >= 240_000) {
      refreshedAt = now
      void retained
        .then(({ retained: enabled }) => (enabled && !released ? Native.replyProgress({ lease }) : undefined))
        .catch(() => {})
    }
  }
  const showProgress = (next: LiveReplyProgress) => {
    if (
      released ||
      (lastProgress?.phase === next.phase && lastProgress.step === next.step && lastProgress.total === next.total)
    ) {
      return
    }
    lastProgress = next
    void retained
      .then(({ retained: enabled, liveProgressAvailable }) =>
        enabled && liveProgressAvailable && !released && lastProgress === next
          ? Native.replyProgress({ lease, ...next })
          : undefined
      )
      .catch(() => {})
  }
  return { finish, progress, showProgress }
}

export const reportViewedConversation = (sessionId: string | null) => {
  if (hasAndroidBackgroundWork()) {
    void Native.viewingSession({ sessionId }).catch(() => {})
  }
}

export const clearBackgroundNotices = async (sessionId?: string) => {
  if (hasAndroidBackgroundWork()) {
    await Native.forgetNotices(sessionId ? { sessionId } : { all: true })
  }
}

export const readTaskNotificationPermission = () => Native.noticeStatus()
export const openTaskNotificationSettings = () => Native.noticeSettings()
export const setLiveTaskProgress = (enabled: boolean) => Native.setLiveProgress({ enabled })
/** 只申请权限，不跳设置页（用于首次启动或升级后自动弹出） */
export const requestTaskNotifications = () => Native.requestNotices()

export const readGoalArtifact = async (bridge: GoalBridge, id: string, file: TaskArtifact) => {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 2 * 1024 * 1024) {
    throw new Error('invalid-agent-artifact')
  }
  const chunks: ArrayBuffer[] = []
  let offset = 0
  while (offset < file.size) {
    const part = await bridge.file({ id, fileId: file.id, offset })
    const bytes = atob(part.base64)
    if (
      bytes.length === 0 ||
      part.nextOffset !== offset + bytes.length ||
      part.nextOffset > file.size
    ) {
      throw new Error('incomplete-agent-artifact')
    }
    chunks.push(Uint8Array.from(bytes, (value) => value.charCodeAt(0)).buffer)
    offset = part.nextOffset
  }
  const blob = new Blob(chunks, { type: file.mimeType })
  if (file.sha256 && globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    if (hash !== file.sha256) {
      throw new Error('corrupt-agent-artifact')
    }
  }
  return blob
}

export const readGoalSnapshot = async (bridge: GoalBridge, id: string) => {
  let { snapshot } = await bridge.snapshot({ id })
  if (snapshot?.blockCount === undefined) {
    return { snapshot }
  }
  const blocks = [...(snapshot.blocks ?? [])]
  while (blocks.length < (snapshot.blockCount ?? 0)) {
    const { snapshot: page } = await bridge.snapshot({ id, offset: blocks.length })
    if (page?.blockOffset !== blocks.length || !page.blocks?.length) {
      throw new Error('agent-transcript-unavailable')
    }
    blocks.push(...page.blocks)
    snapshot = { ...page, blockCount: page.blockCount ?? blocks.length }
  }
  return { snapshot: { ...snapshot, blockOffset: 0, blocks } }
}

/** Watching the worker is deliberately independent of its execution. */
export const watchGoal = async (
  bridge: GoalBridge,
  id: string,
  signal: AbortSignal,
  progress: (snapshot: GoalSnapshot) => Promise<void>
) => {
  let missing = 0
  let last = ''
  let offset = 0
  while (!signal.aborted) {
    const { snapshot } = await bridge.snapshot({ id, offset })
    if (!snapshot) {
      if (++missing >= 8) {
        throw new Error('agent-checkpoint-missing')
      }
    } else {
      missing = 0
      const paged = snapshot.blockOffset !== undefined && snapshot.blockCount !== undefined
      if (paged && snapshot.blockOffset !== offset) {
        throw new Error('agent-transcript-unavailable')
      }
      const nextOffset = offset + (paged ? (snapshot.blocks?.length ?? 0) : 0)
      const remaining = paged && nextOffset < (snapshot.blockCount ?? nextOffset)
      if (remaining && nextOffset === offset) {
        throw new Error('agent-transcript-unavailable')
      }
      const key = paged
        ? JSON.stringify({ ...snapshot, blocks: undefined, blockOffset: nextOffset })
        : JSON.stringify(snapshot)
      if (key !== last) {
        await progress(
          remaining && snapshot.run.status !== 'running'
            ? { ...snapshot, run: { ...snapshot.run, status: 'running' } }
            : snapshot
        )
        last = key
      }
      offset = nextOffset
      if (remaining) {
        continue
      }
      if (snapshot.run.status !== 'running') {
        logEvent('chat', 'task.host.observed', {
          runId: id,
          status: snapshot.run.status,
          reason: snapshot.run.reason,
          resultCount: snapshot.artifacts.length,
        })
        return
      }
    }
    await abortableDelay(550, signal)
  }
}
