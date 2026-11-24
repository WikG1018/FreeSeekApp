import { ApiError, API_ORIGIN, request } from './client.js'
import { postMultipart } from './multipart.js'
import { providerFetch } from './providerTransport.js'
import { readServerSentEvents } from './sse.js'
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
    throw new ApiError('protocol', 'Invalid ASR response')
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
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
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
const MIMO_CHAT_COMPLETIONS = '/chat/completions'

export type MiMoSpeechRequest = {
  profile: ProviderProfile
  text: string
  /** 预置音色；和 description 二选一 */
  preset?: MiMoPresetVoice
  /** 一段话描述的音色；和 preset 二选一 */
  description?: string
  /** 风格指令：性格底色 + 本段语气 */
  style: string
  signal: AbortSignal
}

const mimoHeaders = (profile: ProviderProfile): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  }
  // 与聊天同一套鉴权：同一个 MiMo 配置能聊天就能朗读，用户不用再配一遍
  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`
  }
  for (const [key, value] of Object.entries(profile.headers ?? {})) {
    headers[key] = value
  }
  return headers
}

/** 走 SSE 取出 base64 的 pcm16 分片，拼成字节流；和 DeepSeek TTS 一样是 24kHz / 16-bit / 单声道 */
const mimoAudioStream = async (response: Response, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
  if (!response.ok) {
    // 把服务端的说明带出来，方便区分「音色 ID 写错」「额度」这类错误
    const detail = await response.text().catch(() => '')
    throw new ApiError('http', `MiMo TTS ${response.status}: ${detail.slice(0, 300)}`, response.status)
  }
  if (!response.body) {
    throw new ApiError('protocol', 'MiMo TTS returned no body')
  }
  const events = readServerSentEvents(response.body, signal)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let sawAudio = false
        for await (const event of events) {
          signal.throwIfAborted()
          if (event.data === '[DONE]') {
            break
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(event.data)
          } catch {
            continue
          }
          const chunk = parsed as { choices?: Array<{ delta?: { audio?: { data?: string } } }> }
          const data = chunk.choices?.[0]?.delta?.audio?.data
          if (typeof data === 'string' && data.length) {
            sawAudio = true
            controller.enqueue(base64ToBytes(data))
          }
        }
        if (!sawAudio) {
          throw new ApiError('protocol', 'MiMo TTS stream contained no audio')
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      void response.body?.cancel().catch(() => {})
    },
  })
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
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
  const url = `${profile.url.replace(/\/+$/, '')}${MIMO_CHAT_COMPLETIONS}`
  const described = description?.trim()
  const useDesign = !preset && Boolean(described)
  const body = useDesign
    ? {
        model: MIMO_TTS_DESIGN_MODEL,
        messages: [
          { role: 'user', content: [described, style].filter(Boolean).join('。') },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'pcm16' },
        stream: true,
      }
    : {
        model: MIMO_TTS_MODEL,
        messages: [
          // user 消息可选：风格指令，不会出现在语音里
          ...(style.trim() ? [{ role: 'user', content: style.trim() }] : []),
          { role: 'assistant', content: text },
        ],
        audio: { format: 'pcm16', voice: preset ?? 'mimo_default' },
        stream: true,
      }
  const response = await providerFetch(
    url,
    { method: 'POST', headers: mimoHeaders(profile), body: JSON.stringify(body), signal },
    undefined,
    false
  )
  return mimoAudioStream(response, signal)
}
