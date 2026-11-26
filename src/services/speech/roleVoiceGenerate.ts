import { ApiError, streamMessage } from '../api/client.js'
import type { MessageStreamEvent, StopReason } from '../api/types.js'
import { streamProviderMessage } from '../api/providerClient.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { activeConnection, providerOutputBudget, ProviderConfigError } from '../providers.js'
import { customReasoning, disabledReasoning } from '../reasoning.js'
import { useSettings } from '../settings.js'
import { createId } from '../../utils/id.js'
import { voiceGenderFromDescription, voiceGenderLabel, type VoiceRole } from './roleMarkers.js'

const PROMPT =
  '为角色写一两句中文音色描述。描述年龄感、音高、声音质感、语速或口音。' +
  '沿用已知的声线和角色设定，声线不明时用中性措辞，不凭名字判断男女。' +
  '只输出描述本身，不加标题、引号或解释。'

const PROMPT_EN =
  'Write one or two short English sentences about a character’s voice for speech synthesis. ' +
  'Describe age, pitch, texture, pace, or accent. Keep any established voice gender. ' +
  'Use neutral wording if it is unspecified. Do not infer gender from a name. ' +
  'Return the description alone, without quotes or a heading.'

const clean = (text: string) =>
  text
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1')
    .replace(/^(?:音色描述|音色|voice description|voice)\s*[:：]\s*/i, '')
    .replace(/^["「『“]|["」』”]$/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .slice(0, 200)

const collect = async (events: AsyncIterable<MessageStreamEvent>, signal: AbortSignal) => {
  let text = ''
  let stopReason: StopReason | undefined
  let hasReasoning = false
  for await (const event of events) {
    signal.throwIfAborted()
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      text += event.content_block.text
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        text += event.delta.text
      } else if (event.delta.type === 'thinking_delta') {
        hasReasoning = true
      }
    } else if (event.type === 'message_delta') {
      stopReason = event.delta.stop_reason ?? stopReason
    }
    if (text.length > 2000) {
      break
    }
  }
  signal.throwIfAborted()
  return { description: clean(text), stopReason, hasReasoning }
}

type VoiceDescriptionInput = Pick<
  VoiceRole, 'name' | 'nature' | 'aliases' | 'importance' | 'voiceGender' | 'description'
>

export const regenerateVoiceDescription = async (
  role: VoiceDescriptionInput,
  signal: AbortSignal
): Promise<string> => {
  signal.throwIfAborted()
  const english = useSettings.getState().locale === 'en-US'
  const prompt = english ? PROMPT_EN : PROMPT
  const gender = role.voiceGender ?? voiceGenderFromDescription(role.description ?? '')
  const importance = { lead: '主角', supporting: '次要', extra: '路人' }
  const ask = (english ? [
    `Character: ${role.name}`,
    role.aliases.length && `Aliases: ${role.aliases.join(', ')}`,
    role.nature.trim() && `Personality: ${role.nature.trim()}`,
    `Importance: ${role.importance}`,
    gender && `Required voice gender: ${gender}`,
    role.description?.trim() && `Current description: ${role.description.trim()}`,
    'Suggest a different voice description that fits the character.',
  ] : [
    `角色：${role.name}`,
    role.aliases.length && `别名：${role.aliases.join('、')}`,
    role.nature.trim() && `性格：${role.nature.trim()}`,
    `重要性：${importance[role.importance]}`,
    gender && `必须沿用的声线：${voiceGenderLabel(gender)}`,
    role.description?.trim() && `当前描述：${role.description.trim()}`,
    '为这个角色换一种合适的音色描述。',
  ]).filter(Boolean).join('\n')

  const operationId = createId()
  const started = performance.now()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 60_000)
  let requestId: string | undefined

  try {
    const connection = activeConnection()
    if (connection.kind === 'deepseek' && !connection.apiKey.trim()) {
      throw new ApiError('protocol', { key: 'roleVoiceRewriteNeedsModel' })
    }
    const budget = connection.kind === 'custom'
      ? providerOutputBudget(connection.profile, connection.model)
      : 2048
    let reasoning = connection.kind === 'custom'
      ? disabledReasoning(customReasoning(connection.profile, connection.model))
      : undefined
    const protocol = connection.kind === 'custom' ? connection.profile.protocol : 'deepseek'
    let outputTokens = Math.min(budget, 1024)

    for (let attempt = 1; ; attempt += 1) {
      requestId = createId()
      logEvent('speech', 'rewrite.started', {
        operationId, requestId, protocol, attempt, requestedOutputTokens: outputTokens,
      })
      try {
        const events = connection.kind === 'deepseek'
          ? streamMessage(connection.apiKey, {
              model: connection.model,
              max_tokens: outputTokens,
              system: prompt,
              thinking: { type: 'disabled' },
              safety_check: { level: 'high' },
              messages: [{ role: 'user', content: ask }],
            }, controller.signal, requestId)
          : streamProviderMessage(
              connection.profile,
              connection.model,
              [{ role: 'user', content: [{ type: 'text', text: ask }] }],
              prompt,
              controller.signal,
              reasoning,
              { maxOutputTokens: outputTokens, managedTools: true, requestId }
            )
        const { description, stopReason, hasReasoning } = await collect(events, controller.signal)
        const exhausted = stopReason === 'max_tokens'
        const retryBudget = Math.min(budget, 2048)
        if (attempt === 1 && retryBudget > outputTokens && (exhausted || (!description && hasReasoning))) {
          logEvent('speech', 'rewrite.retry', {
            operationId, requestId, stopReason, hasReasoning, reason: 'output-budget',
          }, 'warn')
          outputTokens = retryBudget
          continue
        }
        if (exhausted || !description || stopReason === 'refusal') {
          const key = exhausted ? 'roleVoiceRewriteTruncated'
            : stopReason === 'refusal' ? 'roleVoiceRewriteRefused' : 'roleVoiceRewriteEmpty'
          logEvent('speech', 'rewrite.incomplete', {
            operationId, requestId, stopReason, hasReasoning,
          }, 'warn')
          throw new ApiError('protocol', { key })
        }
        const receivedGender = voiceGenderFromDescription(description)
        if (gender && receivedGender && receivedGender !== gender) {
          throw new ApiError('protocol', { key: 'roleVoiceDescriptionGenderMismatch' })
        }
        logEvent('speech', 'rewrite.completed', {
          operationId, requestId, stopReason, hasReasoning, elapsedMs: Math.round(performance.now() - started),
        })
        return description
      } catch (error) {
        if (
          !controller.signal.aborted && attempt === 1 && reasoning &&
          error instanceof ApiError && (error.status === 400 || error.status === 422)
        ) {
          logEvent('speech', 'rewrite.retry', {
            operationId, requestId, reason: 'reasoning-parameters', ...diagnosticError(error),
          }, 'warn')
          reasoning = undefined
          outputTokens = Math.min(budget, 2048)
          continue
        }
        throw error
      }
    }
  } catch (error) {
    if (signal.aborted) {
      logEvent('speech', 'rewrite.cancelled', { operationId, requestId })
      throw error
    }
    const failure = timedOut
      ? new ApiError('network', { key: 'roleVoiceRewriteTimedOut' })
      : error instanceof ProviderConfigError
        ? new ApiError('protocol', { key: 'roleVoiceRewriteNeedsModel' })
        : error
    logEvent('speech', 'rewrite.failed', {
      operationId, requestId, elapsedMs: Math.round(performance.now() - started), ...diagnosticError(failure),
    }, 'warn')
    throw failure
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}
