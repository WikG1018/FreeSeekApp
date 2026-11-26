import {
  DEFAULT_EXTRA_VOICE,
  MAX_ROLE_ALIASES,
  MAX_ROLES,
  NARRATOR_NAME,
  type MiMoPresetVoice,
  type ParsedReply,
  type RoleImportance,
  type VoiceRole,
  createRoleLookup,
  isNarratorRole,
  presetForGender,
  presetVoiceGender,
  roleNameKey,
  voiceGenderLabel,
} from './roleMarkers.js'
import { getVisibleMessages } from '../chat/branches.js'
import type { Message, Session } from '../chat/types.js'

/**
 * 会话角色表的纯操作：合并、应用一次回答的解析结果、排序、格式化成提示词。
 * 不碰存储；调用方拿到新数组后自己写回会话。
 */

const RANK: Record<RoleImportance, number> = { lead: 0, supporting: 1, extra: 2 }

export const storedSessionRoles = (session?: Session): VoiceRole[] =>
  session?.voiceRoles ?? session?.inherited?.voiceRoles ?? []

/** Keep the cast local to the selected path, with explicit user edits shared across versions. */
export const sessionRoles = (session?: Session, path?: readonly Message[]): VoiceRole[] => {
  const roles = storedSessionRoles(session)
  if (!session?.messages?.length || !roles.length) {
    return roles
  }
  const selected = (path ?? getVisibleMessages(session)).filter((message) => message.role === 'assistant')
  const selectedIds = new Set(selected.map(({ id }) => id))
  const selectedTimes = new Set(selected.map(({ createdAt }) => createdAt))
  const replies = session.messages.filter((message) => message.role === 'assistant')
  const replyIds = new Set(replies.map(({ id }) => id))
  const replyTimes = new Set(replies.map(({ createdAt }) => createdAt))
  const manualNames = new Set(
    roles.filter((role) => role.source === 'user').flatMap((role) => [role.name, ...role.aliases].map(roleNameKey))
  )
  return roles.filter((role) => {
    if (role.source === 'user') {
      return true
    }
    if (manualNames.has(roleNameKey(role.name))) {
      return false
    }
    if (role.introducedBy) {
      return selectedIds.has(role.introducedBy) || !replyIds.has(role.introducedBy)
    }
    const legacyGenerated = role.id.startsWith(`role-${role.createdAt}-`)
    return !legacyGenerated || !replyTimes.has(role.createdAt) || selectedTimes.has(role.createdAt)
  })
}

/**
 * 把一次回答的解析结果应用到角色表，返回新数组（入参不变）。
 * 没有任何变更时返回原引用，避免无意义的会话写入。
 */
export const applyParsedRoles = (roles: VoiceRole[], parsed: ParsedReply, limit = MAX_ROLES): VoiceRole[] => {
  const next = [...roles.map((role) => ({ ...role }))]
  const remaining = Math.max(0, limit - next.length)
  next.push(...parsed.newRoles.slice(0, remaining).map((role) => ({ ...role, aliases: [...role.aliases] })))
  for (const { roleId, aliases } of parsed.aliasAdditions) {
    const role = next.find((item) => item.id === roleId)
    if (role) {
      role.aliases = [...new Set([...role.aliases, ...aliases])].slice(0, MAX_ROLE_ALIASES)
    }
  }
  for (const { roleId, to } of parsed.promotions) {
    const role = next.find((item) => item.id === roleId)
    if (role?.source === 'model' && RANK[to] < RANK[role.importance]) {
      role.importance = to
      // 路人升级后不再受「路人共用音色」约束，给它一个自己的预置音色
      if (role.preset === undefined && !role.description) {
        role.preset = presetForGender(DEFAULT_EXTRA_VOICE, role.voiceGender)
      }
    }
  }
  // 模型后补的完整声明：补齐早先按裸名字猜出来的角色
  for (const { roleId, patch } of parsed.updates ?? []) {
    const role = next.find((item) => item.id === roleId)
    if (!role || role.source === 'user') {
      continue
    }
    Object.assign(role, patch)
  }
  return next
}

/** 接续新对话时的初始角色表：源会话自身 + 它继承来的，按 id 去重，自身优先 */
export const mergeInheritedRoles = (session: Session): VoiceRole[] => {
  const own = sessionRoles(session)
  const inherited = session.inherited?.voiceRoles ?? []
  if (!inherited.length) {
    return own
  }
  const seen = new Set(own.map((role) => role.id))
  return [...own, ...inherited.filter((role) => !seen.has(role.id))].slice(0, MAX_ROLES)
}

/** 面板顺序：主角 → 次要 → 路人；同级按首次出场 */
export const sortRoles = (roles: ReadonlyArray<VoiceRole>): VoiceRole[] =>
  [...roles].sort((a, b) => RANK[a.importance] - RANK[b.importance] || a.createdAt - b.createdAt)

/** 自动分配的路人按声线共用音色，用户手动选择的音色优先。 */
export const effectiveVoice = (
  role: VoiceRole,
  options: { extrasShareVoice: boolean; extraVoice: MiMoPresetVoice }
): Pick<VoiceRole, 'preset' | 'description'> => {
  if (role.importance === 'extra' && options.extrasShareVoice && role.source === 'model' && !isNarratorRole(role)) {
    return { preset: presetForGender(options.extraVoice, role.voiceGender ?? presetVoiceGender(role.preset)) }
  }
  return role.preset
    ? { preset: presetForGender(role.preset, role.voiceGender) }
    : { description: role.description ?? '' }
}

/**
 * 格式化成系统提示词里的「已定角色」段。
 * 路人不逐个列（一部长篇几十个会把提示词撑大），合并成一行。
 */
export const formatRolesForPrompt = (
  roles: ReadonlyArray<VoiceRole>,
  options: { extrasShareVoice: boolean; extraVoice: MiMoPresetVoice }
): string => {
  const named = roles.filter((role) => role.importance !== 'extra')
  const extras = roles.filter((role) => role.importance === 'extra')
  if (!named.length && !extras.length) {
    return ''
  }
  const importanceWord: Record<RoleImportance, string> = {
    lead: '主角',
    supporting: '次要',
    extra: '路人',
  }
  const lines = named.map((role) => {
    const aliases = role.aliases.length ? `（别名：${role.aliases.join('、')}）` : ''
    const nature = role.nature.trim() ? `｜性格：${role.nature.trim()}` : ''
    const gender = role.voiceGender ? `｜声线：${voiceGenderLabel(role.voiceGender)}` : ''
    const voice = effectiveVoice(role, options)
    const label = voice.preset ?? (voice.description?.trim() || options.extraVoice)
    const locked = role.source === 'user' ? '｜用户设定，不可更改' : ''
    return `- ${role.name}${aliases}${gender}｜音色：${label}${nature}｜重要性：${importanceWord[role.importance]}${locked}`
  })
  if (extras.length) {
    const voice = options.extrasShareVoice
      ? `按声线共用音色，未指定时用 ${options.extraVoice}`
      : '各用自己的预置音色'
    lines.push(`- 其他角色 ${extras.length} 人｜${voice}`)
    // 模型需要知道这些名字属于路人，才不会把他们当新角色重新设计
    const names = extras.slice(0, 60).map((role) =>
      [role.name, ...role.aliases].join('/') + (role.voiceGender ? `（${voiceGenderLabel(role.voiceGender)}）` : '')
    )
    lines.push(`  （${names.join('、')}${extras.length > 60 ? '…' : ''}）`)
  }
  return lines.join('\n')
}

/** 朗读某段时给 MiMo 的风格指令：性格底色 + 本段语气 */
export const styleInstruction = (role: VoiceRole | undefined, tone: string): string => {
  const nature = role?.nature.trim()
  const keepVoice = role?.description && !role.preset && role.voiceGender
    ? `保持${voiceGenderLabel(role.voiceGender)}`
    : ''
  return [keepVoice, nature, tone].filter(Boolean).join('。')
}

/** 面板里显示用的角色数：不含折叠的路人 */
export const visibleRoleCount = (roles: ReadonlyArray<VoiceRole>) =>
  roles.filter((role) => role.importance !== 'extra').length

export const findRoleByName = (roles: ReadonlyArray<VoiceRole>) => createRoleLookup(roles)

export { NARRATOR_NAME }
