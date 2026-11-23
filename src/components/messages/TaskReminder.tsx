import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  cancelTaskReminder,
  readTaskReminder,
  scheduleTaskReminder,
} from '../../services/tasks/workspacePlatform.js'
import { Button } from '../base/Button.js'
import styles from '../session/Workspace.module.css'

export const TaskReminder = ({
  sessionId,
  canResume,
}: {
  sessionId: string
  canResume: boolean
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [saved, setSaved] = useState<{ at?: number; daily?: boolean }>({})
  const [expanded, setExpanded] = useState(false)
  const [at, setAt] = useState('')
  const [daily, setDaily] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TranslationKey>()
  useEffect(() => {
    let live = true
    void readTaskReminder(sessionId)
      .then((result) => {
        if (live) {
          setSaved(result)
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [sessionId])
  if (!saved.at && !canResume) {
    return null
  }
  const date = +new Date(at)
  return (
    <div className={styles.reminder}>
      {!expanded && (
        <Button variant="outlined" size="s" onClick={() => setExpanded(true)}>
          {t('agentReminderSet')}
        </Button>
      )}
      {saved.at && (
        <small>
          {t('agentReminderReady', {
            date: new Date(saved.at).toLocaleString(locale),
            frequency: t(saved.daily ? 'agentReminderDaily' : 'agentReminderOnce'),
          })}
        </small>
      )}
      {expanded && (
        <form
          className={styles.form}
          onSubmit={async (event) => {
            event.preventDefault()
            if (!Number.isFinite(date) || date <= Date.now() || busy) {
              return
            }
            setBusy(true)
            setNotice(undefined)
            try {
              const result = await scheduleTaskReminder(sessionId, date, daily, locale === 'zh-CN')
              if (result.scheduled) {
                setSaved({ at: date, daily })
                setExpanded(false)
              } else {
                setNotice(
                  result.permission === false ? 'agentReasonNotification' : 'agentReminderError'
                )
              }
            } catch {
              setNotice('agentReminderError')
            } finally {
              setBusy(false)
            }
          }}
        >
          <input
            type="datetime-local"
            className={styles.field}
            aria-label={t('agentReminderDate')}
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
          <label className={styles.reminderChoice}>
            <input
              type="checkbox"
              checked={daily}
              onChange={(event) => setDaily(event.target.checked)}
            />
            {t('agentReminderDaily')}
          </label>
          <p className={styles.note}>{t('agentReminderHelp')}</p>
          <div className={styles.changeActions}>
            <Button
              type="button"
              size="s"
              variant="outlined"
              disabled={busy}
              onClick={() => setExpanded(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              size="s"
              disabled={busy || !Number.isFinite(date) || date <= Date.now()}
            >
              {t('agentReminderSave')}
            </Button>
            {saved.at && (
              <Button
                type="button"
                size="s"
                variant="outlined"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await cancelTaskReminder(sessionId)
                    setSaved({})
                    setNotice(undefined)
                  } catch {
                    setNotice('agentReminderError')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {t('agentReminderCancel')}
              </Button>
            )}
          </div>
        </form>
      )}
      {notice && <small role="alert">{t(notice)}</small>}
    </div>
  )
}
