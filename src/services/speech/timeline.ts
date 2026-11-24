import { ApiError } from '../api/client.js'
import { logEvent } from '../diagnostics/log.js'
import { abortableDelay } from '../../utils/abort.js'

/**
 * PCM 时间轴播放器：把多段裸 PCM 流按顺序排进同一个 AudioContext 的时间轴。
 *
 * 所有段共用一条时间轴（nextTime），段与段之间自然衔接；段间可加停顿。
 * 段的请求是顺序的：上一段读完才开始请求下一段，但播放是流水线的——
 * 上一段还在放，下一段的音频已经排进时间轴。
 * 任何一段失败整条停止；signal 中止也整条停止。
 */

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1
/** 播放队列最多领先 5 秒；不将长篇合成音频全部展开进内存。 */
const BUFFER_AHEAD_SECONDS = 5
/** 等一段数据到达的最长时间；超时视为连接已死 */
const IDLE_TIMEOUT_MS = 120_000

export type TimelineSegment = {
  /** 请求这段的音频流；轮到它时才发起 */
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>
  /** Called when this segment reaches the audio playhead. */
  onStart?: () => void
  gapAfter?: number
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
export const pcm16ToFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000
  }
  return samples
}

export const playTimeline = async (
  context: AudioContext,
  sampleRate: number,
  segments: TimelineSegment[],
  gapSeconds: number,
  signal: AbortSignal,
  onBuffering?: () => void
): Promise<void> => {
  let nextTime = 0
  let started = false
  let pendingSources = 0
  let allScheduled = false
  const starts = new Set<ReturnType<typeof setTimeout>>()
  let notifyDrained: (() => void) | null = null
  const drained = new Promise<void>((resolve) => {
    notifyDrained = resolve
  })
  const checkDrained = () => {
    if (allScheduled && pendingSources === 0) {
      notifyDrained?.()
    }
  }

  if (context.state !== 'running') {
    const resumed = await Promise.race([
      context.resume().then(() => true),
      abortableDelay(2_000, signal).then(() => false),
    ])
    if (!resumed) {
      throw new ApiError('network', { key: 'ttsAudioUnavailable' })
    }
  }
  if (context.state !== 'running') {
    throw new ApiError('network', { key: 'ttsAudioUnavailable' })
  }

  /** 已提前发起的下一段请求 */
  let prefetched: { promise: Promise<ReadableStream<Uint8Array>> } | null = null

  try {
    for (const [index, segment] of segments.entries()) {
      signal.throwIfAborted()
      let rest = new Uint8Array(0)
      let scheduled = false
      // 上一段的请求在播放时就已经发出，这里直接接上；没有预取才现请求
      const stream = prefetched ? await prefetched.promise : await segment.open(signal)
      prefetched = null
      const upcoming = segments[index + 1]
      const reader = stream.getReader()
      const onCancel = () => void reader.cancel().catch(() => {})
      signal.addEventListener('abort', onCancel, { once: true })
      let timedOut = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const clearWatchdog = () => {
        clearTimeout(watchdog)
        watchdog = undefined
      }
      const armWatchdog = () => {
        clearWatchdog()
        watchdog = setTimeout(() => {
          timedOut = true
          logEvent('speech', 'playback.timeout', {}, 'error')
          onCancel()
        }, IDLE_TIMEOUT_MS)
      }
      try {
        if (signal.aborted) {
          onCancel()
          signal.throwIfAborted()
        }
        armWatchdog()
        for (;;) {
          const { done, value } = await reader.read()
          clearWatchdog()
          signal.throwIfAborted()
          if (timedOut) {
            throw new ApiError('network', { key: 'ttsServiceTimeout' })
          }
          if (done) {
            if (!scheduled) {
              throw new ApiError('protocol', { key: 'ttsNoAudio' })
            }
            if (rest.length) {
              throw new ApiError('protocol', { key: 'ttsInterrupted' })
            }
            break
          }
          const bytes = new Uint8Array(rest.length + value.length)
          bytes.set(rest)
          bytes.set(value, rest.length)
          const samples = pcm16ToFloat32(bytes)
          rest = bytes.slice(samples.length * 2)
          if (samples.length === 0) {
            armWatchdog()
            continue
          }
          for (let offset = 0; offset < samples.length; offset += sampleRate) {
            // 排程领先太多就等一等，避免把整段音频都展开进内存
            while (nextTime - context.currentTime > BUFFER_AHEAD_SECONDS) {
              if (context.state !== 'running') {
                throw new ApiError('network', { key: 'ttsAudioUnavailable' })
              }
              await abortableDelay(100, signal)
            }
            signal.throwIfAborted()
            const chunk = samples.subarray(offset, offset + sampleRate)
            const buffer = context.createBuffer(1, chunk.length, sampleRate)
            buffer.copyToChannel(chunk, 0)
            const source = context.createBufferSource()
            const starting = !scheduled || pendingSources === 0
            pendingSources += 1
            source.onended = () => {
              source.disconnect()
              source.buffer = null
              pendingSources -= 1
              if (!pendingSources && !allScheduled && !signal.aborted) {
                onBuffering?.()
              }
              checkDrained()
            }
            source.buffer = buffer
            source.connect(context.destination)
            // 网络慢于播放时从当前时间续上，不补播过去的时间
            nextTime = Math.max(nextTime, context.currentTime + (started ? 0 : START_DELAY))
            source.start(nextTime)
            if (starting && segment.onStart) {
              const timer = setTimeout(
                () => {
                  starts.delete(timer)
                  if (!signal.aborted && context.state === 'running') {
                    segment.onStart?.()
                  }
                },
                Math.max(0, (nextTime - context.currentTime) * 1_000)
              )
              starts.add(timer)
            }
            nextTime += buffer.duration
            started = true
            if (!scheduled && upcoming) {
              const promise = upcoming.open(signal)
              void promise.catch(() => {})
              prefetched = { promise }
            }
            scheduled = true
          }
          armWatchdog()
        }
      } finally {
        clearWatchdog()
        signal.removeEventListener('abort', onCancel)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      // 段间停顿：听感上「换人了」
      if (upcoming) {
        nextTime += segment.gapAfter ?? gapSeconds
      }
    }

    allScheduled = true
    checkDrained()
    if (pendingSources > 0) {
      const handleAbort = () => notifyDrained?.()
      signal.addEventListener('abort', handleAbort, { once: true })
      try {
        signal.throwIfAborted()
        const elapsed = new AbortController()
        try {
          await Promise.race([
            drained,
            abortableDelay(
              Math.max(0, nextTime - context.currentTime) * 1000 + 4_000,
              elapsed.signal
            ).then(() => {
              throw new ApiError('network', { key: 'ttsAudioUnavailable' })
            }),
          ])
        } finally {
          elapsed.abort()
        }
        signal.throwIfAborted()
      } finally {
        signal.removeEventListener('abort', handleAbort)
      }
    }
  } finally {
    for (const timer of starts) {
      clearTimeout(timer)
    }
    const unclaimed = prefetched?.promise
    if (unclaimed) {
      void unclaimed.then((stream) => stream.cancel()).catch(() => {})
    }
  }
}
