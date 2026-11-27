import { ApiError } from '../api/client.js'
import { logEvent } from '../diagnostics/log.js'
import { abortableDelay } from '../../utils/abort.js'

/**
 * PCM 时间轴播放器：把多段裸 PCM 流按顺序排进同一个 AudioContext 的时间轴。
 *
 * 所有段共用一条时间轴（nextTime），段与段之间自然衔接；段间可加停顿。
 * 当前段开始排程后预取下一段，所有音频按台词顺序播放。
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
  onFirstAudio?: () => void
  gapAfter?: number
  onFailure?: (error: unknown, stage: 'request' | 'audio', scheduled: boolean) => Promise<'retry' | 'skip'>
}

export type TimelineOptions = {
  waitForSegment?: (index: number) => Promise<TimelineSegment | undefined>
  waitForResume?: () => Promise<void> | undefined
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
  onBuffering?: () => void,
  options: TimelineOptions = {}
): Promise<void> => {
  let nextTime = 0
  let started = false
  let pendingSources = 0
  let allScheduled = false
  const starts = new Set<ReturnType<typeof setTimeout>>()
  let notifyDrained: (() => void) | null = null
  const checkDrained = () => {
    if (pendingSources === 0) {
      notifyDrained?.()
    }
  }
  const waitForDrain = async () => {
    if (!pendingSources) {
      return
    }
    const drained = new Promise<void>((resolve) => { notifyDrained = resolve })
    try {
      let remaining = Math.max(0, nextTime - context.currentTime) * 1_000 + 4_000
      while (pendingSources) {
        await options.waitForResume?.()
        signal.throwIfAborted()
        const tickStarted = performance.now()
        const tick = new AbortController()
        const abort = () => tick.abort()
        signal.addEventListener('abort', abort, { once: true })
        try {
          await Promise.race([drained, abortableDelay(200, tick.signal)])
        } finally {
          tick.abort()
          signal.removeEventListener('abort', abort)
        }
        if (!options.waitForResume?.()) {
          remaining -= performance.now() - tickStarted
        }
        if (remaining <= 0 && pendingSources) {
          throw new ApiError('network', { key: 'ttsAudioUnavailable' })
        }
      }
    } finally {
      notifyDrained = null
    }
  }

  await options.waitForResume?.()
  if (context.state !== 'running') {
    const resumed = await Promise.race([
      context.resume().then(() => true),
      abortableDelay(2_000, signal).then(() => false),
    ])
    if (!resumed) {
      throw new ApiError('network', { key: 'ttsAudioUnavailable' })
    }
  }
  await options.waitForResume?.()
  if (context.state !== 'running') {
    throw new ApiError('network', { key: 'ttsAudioUnavailable' })
  }

  /** 已提前发起的下一段请求 */
  let prefetched: { index: number; promise: Promise<ReadableStream<Uint8Array>> } | null = null
  let gap = 0

  try {
    for (let index = 0; ; ) {
      signal.throwIfAborted()
      const segment = segments[index] ?? await options.waitForSegment?.(index)
      if (!segment) {
        break
      }
      await options.waitForResume?.()
      signal.throwIfAborted()
      let rest = new Uint8Array(0)
      let scheduled = false
      let stage: 'request' | 'audio' | 'output' = 'request'
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const onCancel = () => void reader?.cancel().catch(() => {})
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
        const queued = prefetched?.index === index ? prefetched : undefined
        if (queued) {
          prefetched = null
        }
        const stream = await (queued?.promise ?? segment.open(signal))
        reader = stream.getReader()
        signal.throwIfAborted()
        stage = 'audio'
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
          if (!scheduled) {
            segment.onFirstAudio?.()
          }
          stage = 'output'
          for (let offset = 0; offset < samples.length; offset += sampleRate) {
            await options.waitForResume?.()
            // 排程领先太多就等一等，避免把整段音频都展开进内存
            while (nextTime - context.currentTime > BUFFER_AHEAD_SECONDS) {
              await options.waitForResume?.()
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
            if (!scheduled) {
              nextTime += gap
              gap = 0
            }
            nextTime = Math.max(nextTime, context.currentTime + (started ? 0 : START_DELAY))
            source.start(nextTime)
            if (starting && segment.onStart) {
              const time = nextTime
              const scheduleStart = () => {
                if (signal.aborted) {
                  return
                }
                const timer = setTimeout(() => {
                  starts.delete(timer)
                  const paused = options.waitForResume?.()
                  if (paused) {
                    void paused.then(scheduleStart)
                  } else if (!signal.aborted && context.state === 'running') {
                    // A pause and resume may both happen before this timer fires.
                    if (time - context.currentTime > 0.008) {
                      scheduleStart()
                    } else {
                      segment.onStart?.()
                    }
                  }
                }, Math.max(0, (time - context.currentTime) * 1_000))
                starts.add(timer)
              }
              scheduleStart()
            }
            nextTime += buffer.duration
            started = true
            const upcoming = segments[index + 1]
            if (!prefetched && upcoming) {
              const promise = upcoming.open(signal)
              void promise.catch(() => {})
              prefetched = { index: index + 1, promise }
            }
            scheduled = true
          }
          stage = 'audio'
          armWatchdog()
        }
      } catch (error) {
        if (signal.aborted || stage === 'output' || !segment.onFailure) {
          throw error
        }
        clearWatchdog()
        onCancel()
        await waitForDrain()
        await options.waitForResume?.()
        signal.throwIfAborted()
        const action = await segment.onFailure(error, stage, scheduled)
        signal.throwIfAborted()
        if (action === 'retry') {
          continue
        }
      } finally {
        clearWatchdog()
        signal.removeEventListener('abort', onCancel)
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      if (scheduled) {
        gap = segment.gapAfter ?? gapSeconds
      }
      index++
    }

    allScheduled = true
    await waitForDrain()
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
