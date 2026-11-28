import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import {
  protectAllHistory,
  refreshHistoryVault,
  useHistoryVault,
} from '../../services/chat/historyVault.js'
import { IconFileOutline16, IconRefreshOutline16 } from '../base/icons.js'
import {
  hasHistoryVaultCopy,
  historyVaultIssueMessage,
  useHistoryVaultRestore,
  type HistoryVaultResult,
} from '../session/HistoryVaultRecovery.js'
import { Row, Section } from './SettingsRows.js'
import styles from './HistoryVaultSettings.module.css'

export const HistoryVaultSettings = ({
  disabled,
  ready,
  onResult,
}: {
  disabled: boolean
  ready: boolean
  onResult: (result: HistoryVaultResult) => void
}) => {
  const t = useTranslate()
  const vault = useHistoryVault()
  const { working, failed: restoreFailed, restore, clearFailure } = useHistoryVaultRestore(onResult)
  const [check, setCheck] = useState<'protect' | 'status' | null>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    void refreshHistoryVault()
  }, [])

  const { totalSessions, protectedSessions, protectedOriginals, missingOriginals, protectedBytes } =
    vault
  const hasCopy = hasHistoryVaultCopy(vault)
  const isChecking = vault.phase === 'checking' || check === 'status'
  const isProtecting = vault.phase === 'protecting' || check === 'protect'
  const isRestoring = vault.phase === 'restoring' || working
  const busy = isChecking || isProtecting || isRestoring
  const canCompare =
    totalSessions !== null &&
    totalSessions > 0 &&
    protectedSessions !== null &&
    protectedSessions <= totalSessions
  const canProtect = ready && totalSessions !== null && totalSessions > 0
  const canRestore = hasCopy
  const checkFailed = vault.phase === 'error' && !restoreFailed
  const showCheck = canProtect || checkFailed || check !== null
  const checkBusy = isChecking || isProtecting
  const status = canCompare
    ? t('historyVaultProtectedSessions', { count: protectedSessions, total: totalSessions })
    : protectedSessions !== null && protectedSessions > 0
      ? t('historyVaultStoredSessions', { count: protectedSessions })
      : protectedSessions === 0 && !isChecking && !checkFailed
        ? t('historyVaultEmpty')
        : undefined

  const metrics = [
    !canCompare && totalSessions !== null && (hasCopy || totalSessions > 0)
      ? [t('historyVaultCurrentSessions'), String(totalSessions)]
      : null,
    hasCopy && protectedOriginals !== null
      ? [t('historyVaultOriginalCount'), String(protectedOriginals)]
      : null,
    hasCopy && protectedBytes !== null ? [t('historyVaultSize'), formatSize(protectedBytes)] : null,
  ].filter((item) => item !== null)

  const protectProgress =
    vault.phase === 'protecting' && vault.total > 0
      ? t('historyVaultProtectProgress', { processed: vault.processed, total: vault.total })
      : t('historyVaultProtecting')
  const restoreProgress =
    vault.phase === 'restoring' && vault.total > 0
      ? t('historyVaultRestoreProgress', { processed: vault.processed, total: vault.total })
      : t('historyVaultRestoring')
  const checkLabel = canProtect
    ? t(checkFailed ? 'historyVaultRetryProtection' : 'historyVaultProtect')
    : t('historyVaultRetryCheck')
  const checkHint = isProtecting
    ? protectProgress
    : isChecking
      ? t('historyVaultChecking')
      : checked && !checkFailed
        ? t('historyVaultUpdated')
        : canProtect
          ? t('historyVaultProtectHelp')
          : undefined
  const runCheck = async () => {
    setCheck(canProtect ? 'protect' : 'status')
    setChecked(false)
    clearFailure()
    try {
      if (canProtect) {
        setChecked(await protectAllHistory())
      } else {
        await refreshHistoryVault()
      }
    } finally {
      setCheck(null)
    }
  }

  return (
    <>
      <Section title={t('historyVaultOverview')}>
        <div className={styles.summary}>
          <div className={styles.intro}>
            {status && (
              <p className={styles.status} role="status">
                {status}
              </p>
            )}
            <p className={styles.note}>{t('historyVaultLocal')}</p>
          </div>
          {metrics.length > 0 && (
            <dl className={styles.metrics}>
              {metrics.map(([label, value]) => (
                <div className={styles.metric} key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {missingOriginals !== null && missingOriginals > 0 && (
            <p className={styles.note}>
              {t('historyVaultMissingOriginals', { count: missingOriginals })}
            </p>
          )}
          {isChecking && !showCheck && (
            <p className={styles.note} role="status">
              {t('historyVaultChecking')}
            </p>
          )}
          {isProtecting && !showCheck && (
            <p className={styles.note} role="status">
              {protectProgress}
            </p>
          )}
          {isRestoring && !canRestore && (
            <p className={styles.note} role="status">
              {restoreProgress}
            </p>
          )}
          {checkFailed && !busy && (
            <p className={styles.error} role="alert">
              {t(historyVaultIssueMessage(vault.issue))}
            </p>
          )}
        </div>
      </Section>
      {(showCheck || canRestore || restoreFailed) && (
        <Section title={t('historyVaultActions')}>
          {showCheck && (
            <Row
              icon={<IconRefreshOutline16 />}
              label={checkLabel}
              description={checkHint}
              busy={checkBusy}
              disabled={disabled || busy}
              onClick={() => void runCheck()}
            />
          )}
          {canRestore && (
            <Row
              icon={<IconFileOutline16 />}
              label={t('historyVaultRestore')}
              description={isRestoring ? restoreProgress : t('historyVaultMerge')}
              busy={isRestoring}
              disabled={disabled || busy}
              onClick={() => {
                setChecked(false)
                void restore()
              }}
            />
          )}
          {restoreFailed && !isRestoring && (
            <p className={styles.restoreError} role="alert">
              {t('historyVaultRestoreFailed')} {t(historyVaultIssueMessage(vault.issue))}
            </p>
          )}
        </Section>
      )}
      <Section title={t('historyVaultHow')}>
        <div className={styles.summary}>
          <p className={styles.note}>{t('historyVaultAutomaticHelp')}</p>
          {canRestore && <p className={styles.note}>{t('historyVaultManualHelp')}</p>}
          <p className={styles.note}>{t('historyVaultDeletionHelp')}</p>
        </div>
      </Section>
    </>
  )
}
