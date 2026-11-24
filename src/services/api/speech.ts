import { ApiError, API_ORIGIN, request } from './client.js'
import { postMultipart } from './multipart.js'
import { fetchProviderResponse, providerEndpoint, readApiJson } from './providerClient.js'
import { readServerSentEvents, StreamIdleTimeoutError, StreamReadError } from './sse.js'
import type { ProviderProfile } from '../providers.js'
import type { MiMoPresetVoice } from '../speech/roleMarkers.js'

/**
 * 语音接口：
 * - ASR：POST /v1/tools/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）
 * 鉴权都用 Authorization: Bearer。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const body = await postMultipart(`${TOOLS_BASE_URL}/asr`, {
    operation: 'asr',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', { key: 'voiceInputInvalidResponse' })
  }
  return body.text
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await request(`${TOOLS_BASE_URL}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || /(?:json|text\/|audio\/wav)/i.test(contentType)) {
    void response.body?.cancel().catch(() => {})
    throw new ApiError('protocol', { key: 'ttsNoAudio' })
  }
  return response.body
}

/* ---------- 小米 MiMo-V2.5 TTS（角色配音） ---------- */

/**
 * MiMo 的请求天然把「音色」和「怎么演」分开：
 *   audio.voice           预置音色 ID（9 个之一）        —— 固定
 *   messages[user]        自然语言风格指令                —— 性格底色 + 本段语气
 *   messages[assistant]   要读的台词
 * 用描述设计音色时换模型 mimo-v2.5-tts-voicedesign，描述放进 user 消息。
 * 预置音色支持真流式（边收边播）；描述音色只会在整段合成完后一次返回。
 */
export const MIMO_TTS_MODEL = 'mimo-v2.5-tts'
export const MIMO_TTS_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const MAX_MIMO_AUDIO_PAYLOAD = 8 * 1024 * 1024
export type MiMoSpeechProfile = ProviderProfile & {
  speechModel?: string
  speechDesignModel?: string
}

export type MiMoSpeechRequest = {
  profile: MiMoSpeechProfile
  text: string
  /** 预置音色；和 description 二选一 */
  preset?: MiMoPresetVoice
  /** 一段话描述的音色；和 preset 二选一 */
  description?: string
  /** 风格指令：性格底色 + 本段语气 */
  style: string
  signal: AbortSignal
}

const base64ToBytes = (base64: string): Uint8Array => {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new ApiError('protocol', { key: 'ttsInvalidAudio' })
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

type AudioResult = {
  error?: unknown
  choices?: Array<{
    delta?: { audio?: { data?: string } }
    message?: { audio?: { data?: string } }
    finish_reason?: string | null
  }>
}

const audioResult = (value: unknown) => {
  const result = value as AudioResult | null
  const choice = result?.choices?.[0]
  if (result?.error || (choice?.finish_reason && choice.finish_reason !== 'stop')) {
    throw new ApiError('protocol', { key: 'ttsInterrupted' })
  }
  const data = choice?.delta?.audio?.data ?? choice?.message?.audio?.data
  return {
    bytes: typeof data === 'string' && data ? base64ToBytes(data) : undefined,
    stopped: choice?.finish_reason === 'stop',
  }
}

/** Some compatible endpoints return the whole waveform as JSON, including with stream enabled. */
async function* readMiMoAudio(response: Response, signal: AbortSignal) {
  if (/\/json\b/i.test(response.headers.get('content-type') ?? '')) {
    const { bytes } = audioResult(await readApiJson(response, signal, MAX_MIMO_AUDIO_PAYLOAD))
    if (!bytes?.length) {
      throw new ApiError('protocol', { key: 'ttsNoAudio' })
    }
    yield bytes
    return
  }
  if (!response.body) {
    throw new ApiError('protocol', { key: 'ttsNoAudio' })
  }
  let receivedAudio = false
  let done = false
  for await (const event of readServerSentEvents(
    response.body,
    signal,
    undefined,
    MAX_MIMO_AUDIO_PAYLOAD
  )) {
    if (event.data === '[DONE]') {
      done = true
      break
    }
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      throw new ApiError('protocol', { key: 'ttsInvalidAudio' })
    }
    const { bytes, stopped } = audioResult(data)
    if (bytes?.length) {
      receivedAudio = true
      yield bytes
    }
    if (stopped) {
      done = true
      break
    }
  }
  if (!receivedAudio || !done) {
    throw new ApiError('protocol', { key: receivedAudio ? 'ttsInterrupted' : 'ttsNoAudio' })
  }
}

/** 用 MiMo 合成一段台词；返回裸 pcm16 流 */
export const synthesizeMiMo = async ({
  profile,
  text,
  preset,
  description,
  style,
  signal,
}: MiMoSpeechRequest): Promise<ReadableStream<Uint8Array>> => {
  const described = description?.trim()
  const useDesign = !preset && Boolean(described)
  const selected = profile.speechModel?.trim()
  const presetModel = selected && selected !== MIMO_TTS_DESIGN_MODEL ? selected : MIMO_TTS_MODEL
  const designModel =
    profile.speechDesignModel === undefined && selected !== MIMO_TTS_MODEL
      ? selected || MIMO_TTS_DESIGN_MODEL
      : profile.speechDesignModel?.trim() || MIMO_TTS_DESIGN_MODEL
  const body = useDesign
    ? {
        model: designModel,
        messages: [
          { role: 'user', content: [described, style].filter(Boolean).join('。') },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'pcm16' },
        stream: true,
      }
    : {
        model: presetModel,
        messages: [
          // user 消息可选：风格指令，不会出现在语音里
          ...(style.trim() ? [{ role: 'user', content: style.trim() }] : []),
          { role: 'assistant', content: text },
        ],
        audio: { format: 'pcm16', voice: preset ?? 'mimo_default' },
        stream: true,
      }
  const connection = { ...profile, protocol: 'openai' as const }
  const url = providerEndpoint(connection, 'chat', body.model)
  const { response, dispose } = await fetchProviderResponse(connection, url, body, signal)
  const audio = readMiMoAudio(response, signal)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await audio.next()
        if (!next.done) {
          controller.enqueue(next.value)
          return
        }
        dispose()
        controller.close()
      } catch (error) {
        dispose()
        controller.error(
          error instanceof StreamIdleTimeoutError
            ? new ApiError('network', { key: 'ttsServiceTimeout' })
            : error instanceof StreamReadError
              ? new ApiError('interrupted', { key: 'ttsInterrupted' })
              : error
        )
      }
    },
    cancel() {
      dispose()
      void audio.return(undefined).catch(() => {})
    },
  })
}
