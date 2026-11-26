import { useSettings, type RoleVoiceSettings } from '../settings.js'
import type { AssistantMessage, Message, Session } from '../chat/types.js'
import { roleVoicePrompt } from './roleVoicePrompt.js'
import { applyParsedRoles, sessionRoles, storedSessionRoles } from './roleTable.js'
import { hasRoleMarkers, MAX_ROLES, parseRoleMarkers } from './roleMarkers.js'
import { logEvent } from '../diagnostics/log.js'
import { beginLiveRoleReadAloud, stopReadAloud } from './readAloud.js'
import { readyRoleSpeech } from './roleSpeech.js'
import type { MiMoSpeechProfile } from '../api/speech.js'
import type { VoiceRole } from './roleMarkers.js'

/**
 * 把角色配音接到聊天链路上的胶水：什么时候注入提示词、回答结束后怎么更新角色表。
 * 纯逻辑在 roleTable / roleVoicePrompt / roleMarkers，这里只负责读设置和会话。
 */

/** 角色配音只对聊天模式生效；Agent 任务不参与 */
export const roleVoiceActive = (roleVoice: Pick<RoleVoiceSettings, 'enabled'>, agent: AssistantMessage['agent'] | undefined) =>
  roleVoice.enabled && !agent

/** 系统提示词里要追加的角色配音段：规则 + 已定角色。未开启或 Agent 模式时为空串 */
export const roleVoicePromptFor = (
  session: Session | undefined,
  agent: AssistantMessage['agent'] | undefined,
  locale: string,
  history: readonly Message[]
): string => {
  const { roleVoice } = useSettings.getState()
  if (session?.mode === 'agent' || !roleVoiceActive(roleVoice, agent)) {
    return ''
  }
  const roles = sessionRoles(session, history)
  return '\n\n' + roleVoicePrompt(locale, roles, roleVoice)
}

export const roleVoiceReplyText = (reply: Pick<AssistantMessage, 'blocks'>): string =>
  (reply.blocks ?? [])
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join('')

/** Capture the cast and service for this version. Later deltas may introduce new speakers. */
export const streamRoleVoice = (
  reply: AssistantMessage,
  roles: VoiceRole[],
  preferences: RoleVoiceSettings,
  profile: MiMoSpeechProfile,
  narratorLabel: string,
  onError: (error: unknown) => void,
  resume = false
) => {
  const audio = beginLiveRoleReadAloud({
    messageId: reply.id,
    profile,
    narratorLabel,
    narratorVoice: preferences.narratorVoice,
    extraVoice: preferences.extraVoice,
    extrasShareVoice: preferences.extrasShareVoice,
  }, onError)
  if (!audio) {
    return null
  }
  let previous = resume ? roleVoiceReplyText(reply) : ''
  let cursor = previous.length
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: AssistantMessage | undefined
  let closed = false
  const cast = new Map<string, VoiceRole>()
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!pending || audio.signal.aborted || closed) {
      return
    }
    const message = pending
    pending = undefined
    const terminal = message.status !== 'streaming' && message.status !== 'pending'
    const text = roleVoiceReplyText(message)
    if (
      message.stopReason === 'refusal' || message.status === 'stopped' ||
      !text.startsWith(previous.slice(0, cursor))
    ) {
      logEvent('speech', 'playback.reply-ended', { replyId: reply.id, stopReason: message.stopReason, status: message.status })
      stopReadAloud()
      return
    }
    if (text !== previous || terminal) {
      const parsed = parseRoleMarkers(text, roles, {
        includeNarration: true,
        speechOnly: true,
        narrateUnmarked: true,
        narratorVoice: preferences.narratorVoice,
        extraVoice: preferences.extraVoice,
        allowDescription: preferences.leadVoice === 'description',
        now: reply.createdAt,
      })
      const result = readyRoleSpeech(parsed.segments, cursor, message.status === 'done')
      cursor = result.cursor
      previous = text
      if (result.segments.length) {
        const active = applyParsedRoles(roles, parsed)
        const speaking = new Set(result.segments.map(({ roleId }) => roleId))
        for (const role of active) {
          if (speaking.has(role.id) && !cast.has(role.id)) {
            cast.set(role.id, role)
          }
        }
        audio.append(result.segments, [...cast.values()])
      }
    }
    if (terminal) {
      closed = true
      audio.end()
    }
  }
  audio.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return {
    signal: audio.signal,
    update: (message: AssistantMessage) => {
      if (message.id !== reply.id || audio.signal.aborted || closed) {
        return
      }
      pending = message
      if (message.status !== 'streaming' && message.status !== 'pending') {
        flush()
      } else if (!timer) {
        timer = setTimeout(flush, 65)
      }
    },
  }
}

/**
 * 回答结束后，把这条回答里首次出场的角色、补充的别名、升级的重要性、后补的音色和性格写回会话。
 * 没有任何变更时返回原会话，调用方据此跳过写入。
 * 只处理成功结束的回答：中途停止或失败回答里的半截声明不该成为角色。
 */
export const withReplyRoles = (
  session: Session,
  reply: AssistantMessage,
  roleVoice: RoleVoiceSettings
): Session => {
  if (session.mode === 'agent' || !roleVoiceActive(roleVoice, reply.agent) || reply.status !== 'done') {
    return session
  }
  const text = roleVoiceReplyText(reply)
  // 用结构判断而不是认某个字符：模型会用 ⟧、「」、甚至不写括号
  if (!hasRoleMarkers(text)) {
    return session
  }
  const active = sessionRoles(session)
  const stored = storedSessionRoles(session)
  const parsed = parseRoleMarkers(text, active, {
    narratorVoice: roleVoice.narratorVoice,
    extraVoice: roleVoice.extraVoice,
    // 用户选了「主配角音色：预置」时，模型硬写的描述不进慢的那个模型
    allowDescription: roleVoice.leadVoice === 'description',
    now: reply.createdAt,
  })
  if (
    !parsed.newRoles.length &&
    !parsed.aliasAdditions.length &&
    !parsed.promotions.length &&
    !parsed.updates.length
  ) {
    return session
  }
  parsed.newRoles = parsed.newRoles.map((role) => ({ ...role, introducedBy: reply.id }))
  const next = applyParsedRoles(active, parsed, MAX_ROLES - (stored.length - active.length))
  const changed = new Map(next.map((role) => [role.id, role]))
  const voiceRoles = stored.map((role) => {
    const value = changed.get(role.id) ?? role
    changed.delete(role.id)
    return value
  }).concat([...changed.values()])
  logEvent('speech', 'roles.updated', {
    replyId: reply.id,
    added: parsed.newRoles.length,
    aliases: parsed.aliasAdditions.length,
    promotions: parsed.promotions.length,
    voiceGendersAssigned: parsed.newRoles.filter((role) => role.voiceGender).length,
    voiceGendersRecovered: parsed.updates.filter(({ patch }) => patch.voiceGender).length,
    total: voiceRoles.length,
  })
  return { ...session, voiceRoles }
}
