import { ApiError, streamMessage } from '../api/client.js'
import type { MessageStreamEvent } from '../api/types.js'
import { streamProviderMessage } from '../api/providerClient.js'
import { activeConnection } from '../providers.js'
import { customReasoning, disabledReasoning } from '../reasoning.js'
import { useSettings } from '../settings.js'
import type { VoiceRole } from './roleMarkers.js'

/**
 * 让模型重写一个角色的音色。
 *
 * 只改「声音」这一半；语气仍然由正文里的标注决定。用户点了「重写」之后
 * 结果仍然可以手动编辑，所以这里只求给一个好起点。
 */

const PROMPT =
  '你在为一个朗读功能设定角色声音。只输出一句到两句中文的音色描述，' +
  '说清性别、年龄感、音色质感、语速或口音中真正有辨识度的部分。' +
  '不要写情绪或语气（那由正文决定），不要用引号，不要解释，不要列举。' +
  '不要出现「音色」「描述」这类词。只输出描述本身。'

const PROMPT_EN =
  'Write one or two short English sentences that describe a character’s voice for speech synthesis. ' +
  'Use distinctive traits such as apparent age, pitch, texture, pace, or accent. ' +
  'Leave emotion and delivery to the scene. Return the description alone, without quotation marks.'

const clean = (text: string) =>
  text
    .trim()
    .replace(/^["「『]|["」』]$/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .slice(0, 200)

/** 从流事件里拼出正文；思考块不计入 */
const collect = async (
  events: AsyncIterable<MessageStreamEvent>,
  signal: AbortSignal
): Promise<string> => {
  let text = ''
  for await (const event of events) {
    signal.throwIfAborted()
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      text += event.content_block.text
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
    if (text.length > 2000) {
      break
    }
  }
  return text
}

export const regenerateVoiceDescription = async (
  role: Pick<VoiceRole, 'name' | 'nature' | 'aliases' | 'importance'>,
  signal: AbortSignal
): Promise<string> => {
  const connection = activeConnection()
  const prompt = useSettings.getState().locale === 'en-US' ? PROMPT_EN : PROMPT
  const ask = [
    `角色：${role.name}${role.aliases.length ? `（别名：${role.aliases.join('、')}）` : ''}`,
    role.nature.trim() ? `性格：${role.nature.trim()}` : '',
    role.importance === 'lead' ? '重要性：主角' : role.importance === 'supporting' ? '重要性：次要' : '重要性：路人',
    '请给出这个角色的音色描述。',
  ]
    .filter(Boolean)
    .join('\n')

  let raw: string
  try {
    if (connection.kind === 'deepseek') {
      raw = await collect(
        streamMessage(
          connection.apiKey,
          {
            model: connection.model,
            max_tokens: 200,
            system: prompt,
            thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: ask }],
          },
          signal
        ),
        signal
      )
    } else {
      raw = await collect(
        streamProviderMessage(
          connection.profile,
          connection.model,
          [{ role: 'user', content: [{ type: 'text', text: ask }] }],
          prompt,
          signal,
          disabledReasoning(customReasoning(connection.profile, connection.model)),
          { maxOutputTokens: 200, managedTools: true }
        ),
        signal
      )
    }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw error instanceof ApiError ? error : new ApiError('network', String(error))
  }
  const description = clean(raw)
  if (!description) {
    throw new ApiError('protocol', 'The model returned an empty voice description')
  }
  return description
}
