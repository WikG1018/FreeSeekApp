import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, synthesizeMiMo, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { playTimeline, type TimelineOptions, type TimelineSegment } from './timeline.js'
import { styleInstruction, effectiveVoice } from './roleTable.js'
import {
  DEFAULT_NARRATOR_VOICE,
  type MiMoPresetVoice,
  type VoiceRole,
  type VoiceSegment,
} from './roleMarkers.js'
import type { MiMoSpeechProfile } from '../api/speech.js'
import { splitSpeechText } from './speechText.js'
import { loadRoleVoiceSample, roleVoiceDataUrl, voiceSamplePcm } from './voiceSample.js'
import { abortableDelay } from '../../utils/abort.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 * 角色配音时一条回复拆成多段，各用各的音色，按顺序排进同一条时间轴。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing' | 'paused'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
  /** 角色配音：正在读的角色名，界面显示「正在读：林黛玉」 */
  speakingRole: string | null
  roleReply: boolean
  speakingText: string | null
  failure: TranslationMessage | null
  retrying: boolean
  waitingForText: boolean
}

const idlePlayback: ReadAloudState = {
  messageId: null,
  status: 'idle',
  speakingRole: null,
  roleReply: false,
  speakingText: null,
  failure: null,
  retrying: false,
  waitingForText: false,
}
export const useReadAloud = create<ReadAloudState>(() => idlePlayback)

/** 段间停顿：让听感上「换人了」 */
const ROLE_GAP_SECONDS = 0.22
const DEEPSEEK_SPEECH_LIMIT = 8_000
const ROLE_SPEECH_LIMIT = 1_600
// A designed voice can return the whole waveform at once.
const ROLE_DESIGN_LIMIT = 640
// Voice cloning returns complete audio. Shorter phrases limit the wait and size of each response.
const ROLE_CLONE_LIMIT = 320
const canRetrySpeech = (error: unknown) => error instanceof ApiError && (
  error.kind === 'network' || error.kind === 'interrupted' || [502, 503, 504].includes(error.status ?? 0)
)

type Playback = {
  controller: AbortController
  context: AudioContext
  roleReply: boolean
  pause?: { done: Promise<void>; release: () => void; status: 'loading' | 'playing' }
  recover?: (action: 'retry' | 'skip') => void
}

let current: Playback | null = null

const finish = (controller: AbortController, failed = false) => {
  if (current?.controller !== controller) {
    return
  }
  const playback = current
  const cancelled = controller.signal.aborted
  current = null
  controller.abort()
  playback.pause?.release()
  playback.recover?.('skip')
  void playback.context.close().catch(() => {})
  useReadAloud.setState(idlePlayback)
  if (!failed) {
    logEvent('speech', 'playback.finished', { cancelled })
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
      key === 'roleVoiceSampleMissing' ||
      key === 'roleVoiceSampleTooLong' ||
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

const begin = (messageId: string, onError: (error: unknown) => void, prepared?: AudioContext, roleReply = false) => {
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
  const playback: Playback = { controller, context, roleReply }
  current = playback
  useReadAloud.setState({ ...idlePlayback, messageId, status: 'loading', roleReply })
  return playback
}

export const toggleRoleSpeechPause = (messageId: string) => {
  const playback = current
  const { status, failure } = useReadAloud.getState()
  if (!playback?.roleReply || useReadAloud.getState().messageId !== messageId || failure) {
    return
  }
  if (playback.pause) {
    const pause = playback.pause
    void playback.context.resume().then(() => {
      if (current === playback && playback.pause === pause) {
        playback.pause = undefined
        useReadAloud.setState({ status: pause.status })
        pause.release()
      }
    }).catch(() => {})
    return
  }
  if (status === 'idle' || status === 'paused') {
    return
  }
  let release = () => {}
  const done = new Promise<void>((resolve) => { release = resolve })
  playback.pause = { done, release, status }
  useReadAloud.setState({ status: 'paused' })
  void playback.context.suspend().catch(() => {
    if (current === playback && playback.pause?.done === done) {
      playback.pause = undefined
      release()
      useReadAloud.setState({ status })
    }
  })
}

export const recoverRoleSpeech = (messageId: string, action: 'retry' | 'skip') => {
  if (current && useReadAloud.getState().messageId === messageId) {
    current.recover?.(action)
  }
}

/** 统一的失败/结束处理 */
const run = async (
  playback: Playback,
  segments: TimelineSegment[],
  gapSeconds: number,
  onError: (error: unknown) => void,
  options?: TimelineOptions
) => {
  const { controller, context } = playback
  try {
    await playTimeline(context, TTS_SAMPLE_RATE, segments, gapSeconds, controller.signal, () => {
      if (!playback.pause) {
        useReadAloud.setState({ status: 'loading', speakingRole: null, speakingText: null })
      }
    }, { ...options, waitForResume: () => playback.pause?.done })
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
    session,
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

type RolePlaybackTarget = {
  messageId: string
  profile: MiMoSpeechProfile
  extrasShareVoice: boolean
  extraVoice: MiMoPresetVoice
  narratorVoice?: MiMoPresetVoice
  narratorLabel?: string
  context?: AudioContext
}

export type RoleReadAloudInput = RolePlaybackTarget & {
  segments: VoiceSegment[]
  roles: ReadonlyArray<VoiceRole>
}

const roleTimeline = (
  input: RolePlaybackTarget,
  playback: Playback,
  pieces: VoiceSegment[],
  roles: ReadonlyArray<VoiceRole>,
  offset = 0
): TimelineSegment[] => {
  const byId = new Map(roles.map((role) => [role.id, role]))
  let sequence = offset
  return pieces.flatMap((piece) => {
    const role = piece.roleId === null ? undefined : byId.get(piece.roleId)
    const voice = role
      ? effectiveVoice(role, {
          extrasShareVoice: input.extrasShareVoice,
          extraVoice: input.extraVoice,
        })
      : { preset: input.narratorVoice ?? DEFAULT_NARRATOR_VOICE }
    const style = styleInstruction(role, piece.tone)
    const sample = voice.description ? role?.voiceSample : undefined
    const sound = sample ? 'reference' : voice.description ? 'described' : 'preset'
    const speaker = role?.name ?? input.narratorLabel ?? null
    const parts = splitSpeechText(
      piece.text,
      sample ? ROLE_CLONE_LIMIT : voice.description ? ROLE_DESIGN_LIMIT : ROLE_SPEECH_LIMIT
    )
    return parts.map((text, index): TimelineSegment => {
      const part = ++sequence
      let requestedAt = 0
      let retried = false
      return {
        gapAfter: index === parts.length - 1 ? ROLE_GAP_SECONDS : 0,
        open: async (signal) => {
          requestedAt = performance.now()
          const reference = sample ? await roleVoiceDataUrl(sample, signal) : undefined
          return synthesizeMiMo({
            profile: input.profile,
            text,
            preset: voice.preset,
            description: voice.description,
            sample: reference,
            style,
            signal,
          })
        },
        onFirstAudio: () => logEvent('speech', 'playback.segment-audio', {
          replyId: input.messageId, part, sound, firstAudioMs: Math.round(performance.now() - requestedAt),
        }),
        onStart: () => {
          if (current === playback && !playback.pause) {
            useReadAloud.setState({ status: 'playing', speakingRole: speaker, speakingText: text, retrying: false })
          }
        },
        onFailure: async (error, stage, scheduled) => {
          logEvent('speech', 'playback.segment-failed', {
            replyId: input.messageId, part, sound, stage, scheduled, ...diagnosticError(error),
          }, 'warn')
          const { signal } = playback.controller
          if (current !== playback || signal.aborted) {
            return 'skip'
          }
          if (!scheduled && !retried && canRetrySpeech(error)) {
            retried = true
            useReadAloud.setState({ status: 'loading', retrying: true, speakingRole: speaker, speakingText: text })
            logEvent('speech', 'playback.segment-retry', { replyId: input.messageId, part, sound, stage }, 'warn')
            await abortableDelay(650, signal).catch(() => {})
            return signal.aborted ? 'skip' : 'retry'
          }
          return new Promise((resolve) => {
            playback.recover = (action) => {
              playback.recover = undefined
              if (current === playback) {
                useReadAloud.setState({ failure: null, speakingRole: null, speakingText: null })
                logEvent('speech', 'playback.segment-recovered', { replyId: input.messageId, part, action })
              }
              resolve(action)
            }
            useReadAloud.setState({
              status: 'loading', failure: describeReadAloudError(error), retrying: false,
              speakingRole: speaker, speakingText: text,
            })
          })
        },
      }
    })
  })
}

/** Accepts finalized speech while the reply is still being written. */
export const beginLiveRoleReadAloud = (
  input: RolePlaybackTarget,
  onError: (error: unknown) => void
) => {
  stopReadAloud()
  const playback = begin(input.messageId, onError, input.context, true)
  if (!playback) {
    return null
  }
  const timeline: TimelineSegment[] = []
  let wake: (() => void) | undefined
  let ended = false
  const end = () => {
    ended = true
    wake?.()
  }
  const signal = playback.controller.signal
  signal.addEventListener('abort', end, { once: true })
  logEvent('speech', 'playback.requested', { replyId: input.messageId, roles: true, live: true })
  void run(playback, timeline, ROLE_GAP_SECONDS, onError, {
    waitForSegment: async (index) => {
      if (!ended && !timeline[index]) {
        useReadAloud.setState({ waitingForText: true })
        await new Promise<void>((resolve) => { wake = resolve })
      }
      wake = undefined
      if (current === playback) {
        useReadAloud.setState({ waitingForText: false })
      }
      return timeline[index]
    },
  })
  return {
    signal,
    end,
    append: (pieces: VoiceSegment[], roles: ReadonlyArray<VoiceRole>) => {
      if (!ended && pieces.length) {
        timeline.push(...roleTimeline(input, playback, pieces, roles, timeline.length))
        wake?.()
      }
    },
  }
}

export const toggleRoleReadAloud = (
  input: RoleReadAloudInput,
  onError: (error: unknown) => void
): boolean => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === input.messageId || !input.segments.some(({ text }) => text.trim())) {
    return false
  }
  const session = begin(input.messageId, onError, input.context, true)
  if (!session) {
    return false
  }
  const timeline = roleTimeline(input, session, input.segments, input.roles)
  if (!timeline.length) {
    stopReadAloud()
    onError(new ApiError('protocol', { key: 'ttsUnavailable' }))
    return false
  }
  logEvent('speech', 'playback.requested', {
    replyId: input.messageId, roles: true, segments: timeline.length, regenerated: Boolean(input.context),
  })
  void run(session, timeline, ROLE_GAP_SECONDS, onError)
  return true
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
    session,
    [
      {
        open: async (signal) => {
          if (role.voiceSample && voice.description) {
            return voiceSamplePcm(await loadRoleVoiceSample(role.voiceSample))
          }
          return synthesizeMiMo({
            profile: input.profile,
            text: input.text,
            ...(voice.preset && { preset: voice.preset }),
            ...(voice.description && { description: voice.description }),
            // 试听不演示语气，只演示声音本身
            style: styleInstruction(role, ''),
            signal,
          })
        },
        onStart: () => useReadAloud.setState({ status: 'playing', speakingRole: role.name }),
      },
    ],
    0,
    onError
  )
}

export const previewRoleVoiceSample = (
  messageId: string,
  speaker: string,
  sample: Blob,
  context: AudioContext | undefined,
  onError: (error: unknown) => void
) => {
  stopReadAloud()
  const session = begin(messageId, onError, context)
  if (session) {
    void run(session, [{
      open: () => voiceSamplePcm(sample),
      onStart: () => useReadAloud.setState({ status: 'playing', speakingRole: speaker }),
    }], 0, onError)
  }
}
