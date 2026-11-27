import { useState } from 'react'
import { Button } from '../components/base/Button.js'
import { IconWarningOutline16 } from '../components/base/icons.js'
import { showToast } from '../components/base/toastState.js'
import { useTranslate, type TranslationMessage } from '../i18n/index.js'
import { keepConflictingChats, retrySaveSessions, useChatStore } from '../services/chat/store.js'
import { saveBackup } from '../services/saveBackup.js'
import styles from './App.module.css'

export const ChatSaveNotice = () => {
  const t = useTranslate()
  const failures = useChatStore((state) => state.sessionSaveErrors)
  const importing = useChatStore((state) => state.importingHistory)
  const conflictIsStreaming = useChatStore((state) =>
    Object.keys(state.streaming).some((id) => state.sessionSaveErrors[id] === 'conflict')
  )
  const [busy, setBusy] = useState<'retry' | 'backup'>()
  const [feedback, setFeedback] = useState<TranslationMessage>()
  const reasons = Object.values(failures)
  const conflict = reasons.includes('conflict')
  if (!reasons.length) {
    return null
  }

  const retry = async () => {
    setBusy('retry')
    setFeedback(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const saved = conflict
        ? await keepConflictingChats()
        : await Promise.race([
            retrySaveSessions(),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 10_000)
            }),
          ])
      if (typeof saved === 'number') {
        showToast(
          saved
            ? { key: 'sessionConflictPartial', params: { count: saved } }
            : { key: 'sessionConflictSaved' }
        )
      } else if (saved) {
        showToast({ key: 'sessionSaveRetried' })
      } else {
        setFeedback({ key: saved === null ? 'sessionSaveWaiting' : 'sessionSaveStillFailed' })
      }
    } catch {
      setFeedback({ key: 'sessionSaveStillFailed' })
    } finally {
      clearTimeout(timer)
      setBusy(undefined)
    }
  }

  const backup = async () => {
    setBusy('backup')
    setFeedback(undefined)
    try {
      const { exportRecoveryHistory } = await import('../services/chat/backup.js')
      const archive = await exportRecoveryHistory()
      if (archive && (await saveBackup(archive.name, archive.blob))) {
        setFeedback(
          archive.missing
            ? { key: 'sessionRecoveryPartial', params: { count: archive.missing } }
            : { key: 'sessionRecoverySaved' }
        )
      }
    } catch {
      setFeedback({ key: 'sessionRecoveryFailed' })
    } finally {
      setBusy(undefined)
    }
  }

  const reason = conflict
    ? 'sessionSaveConflict'
    : reasons.includes('space')
      ? 'sessionSaveNoSpace'
      : reasons.includes('connection')
        ? 'sessionSaveConnection'
        : 'sessionSaveHelp'
  return (
    <section
      className={styles.saveError}
      data-testid="chat-save-warning"
      aria-label={t('sessionSaveFailed')}
    >
      <div className={styles.saveErrorContent} role="status">
        <strong>
          <IconWarningOutline16 />
          {t('sessionSaveFailed')}
        </strong>
        <p>{t(reason)}</p>
        {feedback && <p>{t(feedback.key, feedback.params)}</p>}
      </div>
      <div className={styles.saveErrorActions}>
        <Button
          variant="outlined"
          size="s"
          disabled={importing || !!busy || conflictIsStreaming}
          onClick={() => void retry()}
        >
          {t(
            busy === 'retry'
              ? 'sessionSaveRetrying'
              : conflict
                ? 'sessionKeepBoth'
                : 'sessionSaveRetry'
          )}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={importing || !!busy}
          onClick={() => void backup()}
        >
          {t(busy === 'backup' ? 'sessionRecoveryPreparing' : 'sessionRecoverySave')}
        </Button>
      </div>
    </section>
  )
}
