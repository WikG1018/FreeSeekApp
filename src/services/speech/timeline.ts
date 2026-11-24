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
  /** 这段第一块音频排进时间轴时回调（用来更新「正在读：谁」） */
  onStart?: () => void
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
  signal: AbortSignal
): Promise<void> => {
  let nextTime = 0
  let started = false
  let pendingSources = 0
  let rest = new Uint8Array(0)
  let allScheduled = false
  let notifyDrained: (() => void) | null = null
  const drained = new Promise<void>((resolve) => {
    notifyDrained = resolve
  })
  const checkDrained = () => {
    if (allScheduled && pendingSources === 0) {
      notifyDrained?.()
    }
  }

  if (context.state === 'suspended') {
    await context.resume()
  }

  /** 已提前发起的下一段请求 */
  let prefetched: { promise: Promise<ReadableStream<Uint8Array>> } | null = null

  for (const [index, segment] of segments.entries()) {
    signal.throwIfAborted()
    segment.onStart?.()
    // 上一段的请求在播放时就已经发出，这里直接接上；没有预取才现请求
    const stream = prefetched ? await prefetched.promise : await segment.open(signal)
    prefetched = null
    // 立刻把下一段的请求发出去：否则每段开头都要等它合成完，听起来是一段一停
    const upcoming = segments[index + 1]
    if (upcoming) {
      const promise = upcoming.open(signal)
      // 先挂一个空处理，避免预取失败时出现未处理的拒绝；真正 await 时仍会抛出
      promise.catch(() => {})
      prefetched = { promise }
    }
    const reader = stream.getReader()
    const onCancel = () => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', onCancel, { once: true })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const clearWatchdog = () => {
      clearTimeout(watchdog)
      watchdog = undefined
    }
    const armWatchdog = () => {
      clearWatchdog()
      watchdog = setTimeout(() => {
        logEvent('speech', 'playback.timeout', {}, 'error')
        // 直接取消读取并抛错；signal 不动，由调用方按「失败」而不是「用户中止」处理
        void reader.cancel(new ApiError('network', 'TTS idle timeout')).catch(() => {})
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
        if (done) {
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
            if (context.state === 'suspended') {
              throw new ApiError('network', 'Audio playback suspended')
            }
            await abortableDelay(100, signal)
          }
          signal.throwIfAborted()
          const chunk = samples.subarray(offset, offset + sampleRate)
          const buffer = context.createBuffer(1, chunk.length, sampleRate)
          buffer.copyToChannel(chunk, 0)
          const source = context.createBufferSource()
          pendingSources += 1
          source.onended = () => {
            source.disconnect()
            source.buffer = null
            pendingSources -= 1
            checkDrained()
          }
          source.buffer = buffer
          source.connect(context.destination)
          // 网络慢于播放时从当前时间续上，不补播过去的时间
          nextTime = Math.max(nextTime, context.currentTime + (started ? 0 : START_DELAY))
          source.start(nextTime)
          nextTime += buffer.duration
          started = true
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
    if (index < segments.length - 1 && gapSeconds > 0) {
      nextTime += gapSeconds
    }
  }

  allScheduled = true
  checkDrained()
  if (pendingSources > 0) {
    await drained
  }
}
