import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import type { SiderOrder } from '../settings.js'
import type { SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** Sessions arrive newest first. Sort before slicing the visible history batch. */
export const orderSessions = (sessions: readonly SessionSummary[], order: SiderOrder) => {
  const pinned: SessionSummary[] = []
  const first: SessionSummary[] = []
  const agents: SessionSummary[] = []
  for (const session of sessions) {
    if (session.pinned) {
      pinned.push(session)
    } else if (order === 'type' && session.mode === 'agent') {
      agents.push(session)
    } else {
      first.push(session)
    }
  }
  return [...pinned, ...first, ...agents]
}

/** 分组：今天 / 昨天 / 7 天内 / 30 天内 / 按月 */
export const groupSessions = (
  sessions: SessionSummary[],
  now: number,
  t = translate,
  order: SiderOrder = 'recent'
) => {
  const groups: { key: string; label: string; sessions: SessionSummary[] }[] = []
  const pinned = sessions.filter((session) => session.pinned)
  if (pinned.length) {
    groups.push({ key: 'pinned', label: t('sessionPinned'), sessions: pinned })
  }
  if (order === 'type') {
    const remaining = sessions.filter((session) => !session.pinned)
    const chats = remaining.filter((session) => session.mode !== 'agent')
    const agents = remaining.filter((session) => session.mode === 'agent')
    if (chats.length) {
      groups.push({ key: 'chat', label: t('siderChatType'), sessions: chats })
    }
    if (agents.length) {
      groups.push({ key: 'agent', label: t('siderAgentType'), sessions: agents })
    }
    return groups
  }
  for (const session of sessions) {
    if (session.pinned) {
      continue
    }
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = key ?? monthKey(session.updatedAt) ?? ''
    const last = groups.at(-1)
    if (last?.key === groupKey) {
      last.sessions.push(session)
    } else {
      groups.push({ key: groupKey, label: key ? t(key) : groupKey, sessions: [session] })
    }
  }
  return groups
}
