import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { readScreenTime } from '../../services/screenTime.js'
import { diagnosticError, logEvent } from '../../services/diagnostics/log.js'
import { useSettings } from '../../services/settings.js'
import { localDayKey } from '../../utils/localDate.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { Section } from './SettingsRows.js'
import { closeSettings } from './settingsDialogState.js'
import styles from './ScreenTimePage.module.css'

const PAGE_SIZE = 10

const formatDuration = (ms: number, t: ReturnType<typeof useTranslate>) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) {
    return t('screenTimeSeconds', { seconds })
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (!hours) {
    return t('screenTimeMinutes', { minutes })
  }
  return minutes ? t('screenTimeHoursMinutes', { hours, minutes }) : t('screenTimeHours', { hours })
}

const lastSevenDates = (today: string) => {
  const anchor = new Date(today + 'T12:00:00')
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor)
    date.setDate(anchor.getDate() + index - 6)
    return { date, key: localDayKey(date.getTime()) }
  })
}

const weekDuration = (days: Record<string, number>, dates: ReturnType<typeof lastSevenDates>) =>
  dates.reduce((sum, { key }) => sum + (days[key] ?? 0), 0)

type Snapshot = Awaited<ReturnType<typeof readScreenTime>>
type Range = 'week' | 'total'

export const ScreenTimePage = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const sessions = useChatStore((state) => state.sessions)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [range, setRange] = useState<Range>('week')
  const [limit, setLimit] = useState(PAGE_SIZE)

  useEffect(() => {
    let disposed = false,
      inProgress = false,
      lastDurable: boolean | undefined
    const refresh = async (includeChats: boolean) => {
      if (inProgress || document.visibilityState !== 'visible') {
        return
      }
      inProgress = true
      try {
        const next = await readScreenTime(includeChats)
        if (includeChats || next.durable !== lastDurable) {
          logEvent(
            'usage',
            'screen-time.read',
            {
              includeChats,
              chatCount: next.chats.size,
              durable: next.durable,
            },
            next.durable ? 'info' : 'warn'
          )
        }
        lastDurable = next.durable
        if (!disposed) {
          setSnapshot((old) => ({
            ...next,
            chats: includeChats ? next.chats : (old?.chats ?? next.chats),
          }))
        }
      } catch (error) {
        if (lastDurable !== false) {
          logEvent(
            'usage',
            'screen-time.read-failed',
            { includeChats, ...diagnosticError(error) },
            'warn'
          )
        }
        lastDurable = false
      } finally {
        inProgress = false
      }
    }
    const onVisible = () => void refresh(true)
    onVisible()
    const timer = setInterval(() => void refresh(false), 5000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const today = localDayKey(Date.now())
  const dates = useMemo(() => lastSevenDates(today), [today])
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }),
    [locale]
  )
  const chatTimes = snapshot?.chats
  const ranking = useMemo(
    () =>
      sessions
        .flatMap(({ id, title }) => {
          const time = chatTimes?.get(id)
          if (!time) {
            return []
          }
          const ms = range === 'week' ? weekDuration(time.days, dates) : time.totalMs
          return ms > 0 ? [{ id, title, ms, lastUsedAt: time.lastUsedAt }] : []
        })
        .sort((a, b) => b.ms - a.ms || b.lastUsedAt - a.lastUsedAt),
    [sessions, chatTimes, range, dates]
  )

  if (!snapshot) {
    return (
      <p role="status" className={styles.hint}>
        {t('screenTimeLoading')}
      </p>
    )
  }
  const { overall } = snapshot
  const maxDay = Math.max(1, ...dates.map(({ key }) => overall.days[key] ?? 0))
  return (
    <div className={styles.page}>
      <dl className={styles.summary}>
        <div data-tone="blue">
          <dt>{t('screenTimeToday')}</dt>
          <dd data-testid="screen-time-today">{formatDuration(overall.days[today] ?? 0, t)}</dd>
        </div>
        <div data-tone="teal">
          <dt>{t('screenTimeWeek')}</dt>
          <dd data-testid="screen-time-week">
            {formatDuration(weekDuration(overall.days, dates), t)}
          </dd>
        </div>
        <div data-tone="amber">
          <dt>{t('screenTimeTotal')}</dt>
          <dd data-testid="screen-time-total">{formatDuration(overall.totalMs, t)}</dd>
        </div>
      </dl>
      <Section title={t('screenTimeDaily')}>
        <ol className={styles.trend} data-testid="screen-time-days">
          {dates.map(({ date, key }) => {
            const ms = overall.days[key] ?? 0
            return (
              <li key={key} className={styles.day} data-today={key === today || undefined}>
                <time dateTime={key}>
                  {key === today ? t('usageToday') : dateFormat.format(date)}
                </time>
                <span className={styles.track} aria-hidden="true">
                  <span className={styles.fill} style={{ width: `${(ms / maxDay) * 100}%` }} />
                </span>
                <span>{formatDuration(ms, t)}</span>
              </li>
            )
          })}
        </ol>
      </Section>
      <Section title={t('screenTimeRanking')}>
        <div className={styles.ranges} role="group" aria-label={t('screenTimeRange')}>
          {(['week', 'total'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => {
                setRange(option)
                setLimit(PAGE_SIZE)
              }}
            >
              {t(option === 'week' ? 'screenTimeWeek' : 'screenTimeTotal')}
            </button>
          ))}
        </div>
        {ranking.length ? (
          <ol className={styles.ranking} data-testid="screen-time-ranking">
            {ranking.slice(0, limit).map((chat, index) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className={styles.rankRow}
                  data-place={index < 3 ? index + 1 : undefined}
                  onClick={() => {
                    selectSession(chat.id)
                    closeMobileSider()
                    closeSettings()
                  }}
                >
                  <span className={styles.rankContent}>
                    <span className={styles.rank} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className={styles.chatCopy}>
                      <strong>{chat.title || t('untitledChat')}</strong>
                      <small>
                        {t('screenTimeLastUsed', { date: dateFormat.format(chat.lastUsedAt) })}
                      </small>
                    </span>
                    <span className={styles.chatTime}>{formatDuration(chat.ms, t)}</span>
                    <IconChevronRightOutline14 />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>{t('screenTimeEmpty')}</p>
        )}
        {ranking.length > limit && (
          <button
            type="button"
            className={styles.more}
            onClick={() => setLimit((value) => value + PAGE_SIZE)}
          >
            {t('screenTimeMoreChats')}
          </button>
        )}
      </Section>
      <p className={styles.hint}>{t('screenTimeHint')}</p>
      {!snapshot.durable && (
        <p className={styles.hint} role="status">
          {t('screenTimeStorage')}
        </p>
      )}
    </div>
  )
}
