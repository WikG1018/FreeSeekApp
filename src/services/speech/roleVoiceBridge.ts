import { useSettings, type RoleVoiceSettings } from '../settings.js'
import type { AssistantMessage, Session } from '../chat/types.js'
import { roleVoicePrompt } from './roleVoicePrompt.js'
import { applyParsedRoles, sessionRoles } from './roleTable.js'
import { hasRoleMarkers, parseRoleMarkers } from './roleMarkers.js'
import { logEvent } from '../diagnostics/log.js'

/**
 * 把角色配音接到聊天链路上的胶水：什么时候注入提示词、回答结束后怎么更新角色表。
 * 纯逻辑在 roleTable / roleVoicePrompt / roleMarkers，这里只负责读设置和会话。
 */

/** 角色配音只对聊天模式生效；Agent 任务不参与 */
export const roleVoiceActive = (roleVoice: Pick<RoleVoiceSettings, 'enabled'>, agent: AssistantMessage['agent'] | undefined) =>
  roleVoice.enabled && !agent

/** 系统提示词里要追加的角色配音段：规则 + 已定角色。未开启或 Agent 模式时为空串 */
export const roleVoicePromptFor = (session: Session | undefined, agent: AssistantMessage['agent'] | undefined, locale: string): string => {
  const { roleVoice } = useSettings.getState()
  if (session?.mode === 'agent' || !roleVoiceActive(roleVoice, agent)) {
    return ''
  }
  const roles = sessionRoles(session ?? {})
  return '\n\n' + roleVoicePrompt(locale, roles, roleVoice)
}

const visibleText = (reply: Pick<AssistantMessage, 'blocks'>): string =>
  (reply.blocks ?? [])
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join('')

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
  const text = visibleText(reply)
  // 用结构判断而不是认某个字符：模型会用 ⟧、「」、甚至不写括号
  if (!hasRoleMarkers(text)) {
    return session
  }
  const parsed = parseRoleMarkers(text, sessionRoles(session), {
    narratorVoice: roleVoice.narratorVoice,
    extraVoice: roleVoice.extraVoice,
    // 用户选了「主角默认音色：预置」时，模型硬写的描述不进慢的那个模型
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
  const next = applyParsedRoles(session.voiceRoles ?? sessionRoles(session), parsed)
  logEvent('speech', 'roles.updated', {
    added: parsed.newRoles.length,
    aliases: parsed.aliasAdditions.length,
    promotions: parsed.promotions.length,
    total: next.length,
  })
  return { ...session, voiceRoles: next }
}
