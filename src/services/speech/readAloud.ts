import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, synthesizeMiMo, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { playTimeline, type TimelineSegment } from './timeline.js'
import { styleInstruction, effectiveVoice } from './roleTable.js'
import {
  DEFAULT_NARRATOR_VOICE,
  type MiMoPresetVoice,
  type VoiceRole,
  type VoiceSegment,
} from './roleMarkers.js'
import type { MiMoSpeechProfile } from '../api/speech.js'
import { splitSpeechText } from './speechText.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 * 角色配音时一条回复拆成多段，各用各的音色，按顺序排进同一条时间轴。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
  /** 角色配音：正在读的角色名，界面显示「正在读：林黛玉」 */
  speakingRole: string | null
}

export const useReadAloud = create<ReadAloudState>(() => ({
  messageId: null,
  status: 'idle',
  speakingRole: null,
}))

/** 段间停顿：让听感上「换人了」 */
const ROLE_GAP_SECONDS = 0.22
const DEEPSEEK_SPEECH_LIMIT = 8_000
const ROLE_SPEECH_LIMIT = 1_600
// A designed voice can return the whole waveform at once.
const ROLE_DESIGN_LIMIT = 640

let current: { controller: AbortController; context: AudioContext } | null = null

const finish = (controller: AbortController, failed = false) => {
  if (current?.controller !== controller) {
    return
  }
  void current.context.close().catch(() => {})
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle', speakingRole: null })
  if (!failed) {
    logEvent('speech', 'playback.finished', { cancelled: controller.signal.aborted })
  }
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

export const describeReadAloudError = (error: unknown): TranslationMessage => {
  if (
    error instanceof DOMException &&
    (error.name === 'NotSupportedError' || error.name === 'InvalidStateError')
  ) {
    return { key: 'ttsAudioUnavailable' }
  }
  if (error instanceof ApiError) {
    const key = error.localMessage?.key
    if (
      key === 'ttsNoAudio' ||
      key === 'ttsInvalidAudio' ||
      key === 'ttsInterrupted' ||
      key === 'ttsServiceTimeout' ||
      key === 'ttsAudioUnavailable' ||
      key === 'ttsUnavailable'
    ) {
      return { key }
    }
    if (key === 'streamIdleTimeout') {
      return { key: 'ttsServiceTimeout' }
    }
    if (error.kind === 'interrupted') {
      return { key: 'ttsInterrupted' }
    }
    if (error.status === 403) {
      return { key: 'ttsServiceDenied' }
    }
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    case 'serverBusy':
      return { key: 'ttsServiceBusy' }
    case 'network':
      return { key: 'ttsNetworkFailed' }
    default:
      return { key: 'ttsFailed' }
  }
}

/** Keep the user gesture while a role edit is being committed to local storage. */
export const prepareSpeechOutput = () => {
  let context: AudioContext
  try {
    context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') {
      throw error
    }
    context = new AudioContext()
  }
  if (context.state === 'suspended') {
    void context.resume().catch(() => {})
  }
  return context
}

const begin = (messageId: string, onError: (error: unknown) => void, prepared?: AudioContext) => {
  const controller = new AbortController()
  let context: AudioContext
  try {
    context = prepared ?? prepareSpeechOutput()
  } catch (error) {
    logEvent('speech', 'playback.init-failed', diagnosticError(error), 'error')
    onError(
      error instanceof DOMException
        ? error
        : new ApiError('protocol', { key: 'ttsAudioUnavailable' })
    )
    return null
  }
  current = { controller, context }
  useReadAloud.setState({ messageId, status: 'loading', speakingRole: null })
  return { controller, context }
}

/** 统一的失败/结束处理 */
const run = async (
  controller: AbortController,
  context: AudioContext,
  segments: TimelineSegment[],
  gapSeconds: number,
  onError: (error: unknown) => void
) => {
  try {
    await playTimeline(context, TTS_SAMPLE_RATE, segments, gapSeconds, controller.signal, () => {
      useReadAloud.setState({ status: 'loading', speakingRole: null })
    })
    if (current?.controller === controller) {
      finish(controller)
    }
  } catch (error) {
    logEvent(
      'speech',
      'playback.failed',
      diagnosticError(error),
      controller.signal.aborted ? 'info' : 'error'
    )
    if (!controller.signal.aborted) {
      // A failure can leave the next speaker's request in flight.
      controller.abort()
      finish(controller, true)
      onError(error)
    }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const parts = splitSpeechText(text, DEEPSEEK_SPEECH_LIMIT)
  if (!parts.length) {
    onError(new ApiError('protocol', { key: 'ttsUnavailable' }))
    return
  }
  const session = begin(messageId, onError)
  if (!session) {
    return
  }
  logEvent('speech', 'playback.requested')
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice } = useSettings.getState()
  let announced = false
  void run(
    session.controller,
    session.context,
    parts.map((part) => ({
      open: (signal) => synthesize(apiKey ?? '', part, ttsVoice, signal),
      onStart: () => {
        useReadAloud.setState({ status: 'playing' })
        if (!announced) {
          announced = true
          logEvent('speech', 'playback.started')
        }
      },
    })),
    0,
    onError
  )
}

export type RoleReadAloudInput = {
  messageId: string
  segments: VoiceSegment[]
  roles: ReadonlyArray<VoiceRole>
  profile: MiMoSpeechProfile
  extrasShareVoice: boolean
  extraVoice: MiMoPresetVoice
  narratorVoice?: MiMoPresetVoice
  narratorLabel?: string
}

/**
 * 角色配音朗读：一条回复按角色拆成多段，各用各的音色，按顺序排进同一条时间轴。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleRoleReadAloud = (
  input: RoleReadAloudInput,
  onError: (error: unknown) => void
) => {
  const { messageId } = input
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const byId = new Map(input.roles.map((role) => [role.id, role]))
  let announced = false
  const timeline: TimelineSegment[] = input.segments.flatMap((piece) => {
    const role = piece.roleId === null ? undefined : byId.get(piece.roleId)
    const voice = role
      ? effectiveVoice(role, {
          extrasShareVoice: input.extrasShareVoice,
          extraVoice: input.extraVoice,
        })
      : { preset: input.narratorVoice ?? DEFAULT_NARRATOR_VOICE }
    const style = styleInstruction(role, piece.tone)
    const parts = splitSpeechText(
      piece.text,
      voice.description ? ROLE_DESIGN_LIMIT : ROLE_SPEECH_LIMIT
    )
    return parts.map((text, index) => ({
      gapAfter: index === parts.length - 1 ? ROLE_GAP_SECONDS : 0,
      open: (signal) =>
        synthesizeMiMo({
          profile: input.profile,
          text,
          ...(voice.preset && { preset: voice.preset }),
          ...(voice.description && { description: voice.description }),
          style,
          signal,
        }),
      onStart: () => {
        if (!announced) {
          announced = true
          logEvent('speech', 'playback.started')
        }
        useReadAloud.setState({
          status: 'playing',
          speakingRole: role?.name ?? input.narratorLabel ?? null,
        })
      },
    }))
  })
  if (!timeline.length) {
    onError(new ApiError('protocol', { key: 'ttsUnavailable' }))
    return
  }
  const session = begin(messageId, onError)
  if (!session) {
    return
  }
  logEvent('speech', 'playback.requested', { roles: true, segments: timeline.length })
  void run(session.controller, session.context, timeline, ROLE_GAP_SECONDS, onError)
}

/**
 * 试听一个角色的声音：用固定示例读一句。
 * 编辑弹窗点「保存并试听」和面板里点 ▶ 都走这里。
 */
export const previewRoleVoice = (
  input: {
    role: VoiceRole
    text: string
    messageId: string
    profile: MiMoSpeechProfile
    extrasShareVoice: boolean
    extraVoice: MiMoPresetVoice
    context?: AudioContext
  },
  onError: (error: unknown) => void
) => {
  const { role } = input
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === input.messageId && !input.context) {
    return
  }
  const voice = effectiveVoice(role, {
    extrasShareVoice: input.extrasShareVoice,
    extraVoice: input.extraVoice,
  })
  const session = begin(input.messageId, onError, input.context)
  if (!session) {
    return
  }
  logEvent('speech', 'playback.preview', {
    preset: voice.preset,
    described: Boolean(voice.description),
  })
  void run(
    session.controller,
    session.context,
    [
      {
        open: (signal) =>
          synthesizeMiMo({
            profile: input.profile,
            text: input.text,
            ...(voice.preset && { preset: voice.preset }),
            ...(voice.description && { description: voice.description }),
            // 试听不演示语气，只演示声音本身
            style: role.nature,
            signal,
          }),
        onStart: () => useReadAloud.setState({ status: 'playing', speakingRole: role.name }),
      },
    ],
    0,
    onError
  )
}
