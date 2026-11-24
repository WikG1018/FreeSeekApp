/**
 * 录音并编码为 ASR 接受的 WAV（单声道、16-bit PCM、16kHz）。
 *
 * Prefer 16 kHz, with a WAV resampling fallback for devices that require their native rate.
 */
export const SAMPLE_RATE = 16000
/** ASR 单次时长上限 120 秒 */
export const MAX_SECONDS = 120

const BUFFER_SIZE = 4096

export type Recording = {
  /** 停止录音并返回 WAV；没有采到声音时返回 null */
  stop: () => Promise<Blob | null>
  /** 放弃录音，释放麦克风 */
  cancel: () => void
  /** 频谱分析节点，只读；采样率与录音一致 */
  analyser: AnalyserNode
}

/** 开始录音；到达时长上限时调用 onLimit，由调用方决定何时 stop */
export const startRecording = async ({
  authorize,
  onLimit,
  onInterrupted,
  signal,
}: {
  authorize: () => Promise<boolean>
  onLimit: () => void
  onInterrupted: () => void
  signal: AbortSignal
}): Promise<Recording> => {
  let stream: MediaStream | undefined
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }
    released = true
    signal.removeEventListener('abort', release)
    if (processor) {
      processor.onaudioprocess = null
    }
    // 初始化可能只完成了一部分；单个节点断开失败也不能阻止麦克风释放。
    for (const node of [processor, analyser, source]) {
      try {
        node?.disconnect()
      } catch {
        // 继续释放其余资源。
      }
    }
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', onInterrupted)
      track.stop()
    }
    void context?.close().catch(() => {})
  }

  try {
    signal.throwIfAborted()
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Microphone unavailable', 'NotSupportedError')
    }
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE })
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') {
        throw error
      }
      context = new AudioContext()
    }
    // Unlock the audio graph during the user gesture, before a system permission prompt.
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }
    signal.addEventListener('abort', release, { once: true })
    if (!(await authorize())) {
      throw new DOMException('Microphone permission denied', 'NotAllowedError')
    }
    signal.throwIfAborted()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    if (released || signal.aborted || document.visibilityState === 'hidden') {
      stream.getTracks().forEach((track) => track.stop())
      throw new DOMException('Recording cancelled', 'AbortError')
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', onInterrupted)
    }
    const inputRate = context.sampleRate
    const maxSamples = inputRate * MAX_SECONDS
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    // 频谱分析用：串在录音链路中间（原样透传），WebKit 不会处理未连到输出的分析节点
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    const chunks: Float32Array[] = []
    let length = 0
    let limited = false
    let hasSound = false
    processor.onaudioprocess = (event) => {
      if (limited) {
        return
      }
      const samples = event.inputBuffer.getChannelData(0).subarray(0, maxSamples - length)
      hasSound ||= samples.some((sample) => Math.abs(sample) > 0.00001)
      chunks.push(new Float32Array(samples))
      length += samples.length
      if (length >= maxSamples) {
        limited = true
        onLimit()
      }
    }
    source.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 只有连到输出才会持续回调；输出缓冲保持静音
    processor.connect(context.destination)
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }

    return {
      stop: async () => {
        release()
        return !hasSound || !length ? null : encodeWav(chunks, length, inputRate)
      },
      cancel: release,
      analyser,
    }
  } catch (error) {
    release()
    throw error
  }
}

const encodeWav = (chunks: Float32Array[], length: number, inputRate: number) => {
  const rate = inputRate < SAMPLE_RATE ? 8000 : SAMPLE_RATE
  const samples = Math.floor((length * rate) / inputRate)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  let phase = 0
  let sum = 0
  let count = 0
  for (const chunk of chunks) {
    for (const value of chunk) {
      phase += rate
      sum += value
      count++
      if (phase >= inputRate && offset < buffer.byteLength) {
        const sample = Math.max(-1, Math.min(1, sum / count))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
        phase -= inputRate
        sum = 0
        count = 0
      }
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
