import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  refreshHistoryVault,
  restoreHistoryVault,
  useHistoryVault,
} from '../../services/chat/historyVault.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './HistoryVault.module.css'

export type HistoryVaultResult = NonNullable<Awaited<ReturnType<typeof restoreHistoryVault>>>

const issueMessages = {
  space: 'historyVaultSpace',
  unreadable: 'historyVaultUnreadable',
  write: 'historyVaultWrite',
  changed: 'historyVaultChanged',
  busy: 'historyVaultBusy',
} as const

export const historyVaultIssueMessage = (issue?: keyof typeof issueMessages) =>
  issue ? issueMessages[issue] : 'historyVaultUnavailable'

export const hasHistoryVaultCopy = ({
  generation,
  protectedSessions,
}: Pick<ReturnType<typeof useHistoryVault.getState>, 'generation' | 'protectedSessions'>) =>
  generation !== null && generation > 0 && protectedSessions !== null && protectedSessions > 0

export const HistoryVaultRestore = ({
  disabled,
  onResult,
  showAvailability = true,
  visible = true,
}: {
  disabled: boolean
  onResult: (result: HistoryVaultResult) => void
  showAvailability?: boolean
  visible?: boolean
}) => {
  const t = useTranslate()
  const vault = useHistoryVault()
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (visible && showAvailability) {
      void refreshHistoryVault()
    }
  }, [showAvailability, visible])

  const running = working || vault.phase === 'restoring'
  const recoverable = hasHistoryVaultCopy(vault)
  if (!visible) {
    return null
  }
  if (!recoverable && !running && !failed) {
    return showAvailability && vault.phase === 'checking'
      ? <span role="status">{t('historyVaultChecking')}</span>
      : null
  }

  const restore = async () => {
    setWorking(true)
    setFailed(false)
    try {
      const result = await restoreHistoryVault()
      if (result && (result.sessions > 0 || result.originals > 0 || result.kept > 0)) {
        onResult(result)
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className={styles.recovery}>
      {showAvailability && recoverable && vault.protectedSessions !== null && !running && (
        <div>
          <p className={styles.note}>{t('historyVaultCanRestore', { count: vault.protectedSessions })}</p>
          {vault.protectedOriginals !== null && (
            <p className={styles.note}>{t('historyVaultOriginals', { count: vault.protectedOriginals })}</p>
          )}
        </div>
      )}
      {recoverable && (
        <Button
          size="m"
          variant={showAvailability ? 'primary' : 'outlined'}
          disabled={disabled || running || vault.phase === 'checking' || vault.phase === 'protecting'}
          aria-busy={running}
          onClick={() => void restore()}
        >
          {t('historyVaultRestore')}
        </Button>
      )}
      {running && (
        <p className={styles.note} role="status">
          {vault.total > 0
            ? t('historyVaultRestoreProgress', { processed: vault.processed, total: vault.total })
            : t('historyVaultRestoring')}
        </p>
      )}
      {failed && (
        <p className={styles.error} role="alert">
          {t('historyVaultRestoreFailed')} {t(historyVaultIssueMessage(vault.issue))}
        </p>
      )}
    </div>
  )
}

export const HistoryVaultOutcome = ({
  result,
  close,
}: {
  result: HistoryVaultResult
  close: () => void
}) => {
  const t = useTranslate()
  const restored = result.sessions > 0 || result.originals > 0
  const title = !restored
    ? 'historyVaultKept'
    : result.missing > 0 ? 'historyVaultRestoredPartial' : 'historyVaultRestored'
  return (
    <Modal
      centered
      title={t(title)}
      onClose={close}
      footer={<Button onClick={close}>{t('close')}</Button>}
    >
      <div className={styles.outcome}>
        {result.sessions > 0 && <p>{t('historyVaultRestoredSessions', { count: result.sessions })}</p>}
        {result.originals > 0 && <p>{t('historyVaultRestoredOriginals', { count: result.originals })}</p>}
        {result.kept > 0 && <p>{t('historyVaultKeptSessions', { count: result.kept })}</p>}
        {result.missing > 0 && <p>{t('historyVaultRestoreMissing', { count: result.missing })}</p>}
      </div>
    </Modal>
  )
}
