import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import {
  protectAllHistory,
  refreshHistoryVault,
  useHistoryVault,
} from '../../services/chat/historyVault.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import {
  hasHistoryVaultCopy,
  historyVaultIssueMessage,
  HistoryVaultRestore,
  type HistoryVaultResult,
} from '../session/HistoryVaultRecovery.js'
import styles from '../session/HistoryVault.module.css'
import { Row, Section } from './SettingsRows.js'

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
  useEffect(() => {
    void refreshHistoryVault()
  }, [])

  const busy = vault.phase === 'checking' || vault.phase === 'protecting' || vault.phase === 'restoring'
  const { totalSessions, protectedSessions, protectedOriginals, missingOriginals, protectedBytes } = vault
  const canCompare =
    totalSessions !== null && totalSessions > 0 &&
    protectedSessions !== null && protectedSessions <= totalSessions
  const canProtect = ready && totalSessions !== null && totalSessions > 0
  const canRestore = ready && hasHistoryVaultCopy(vault)

  return (
    <Section title={t('historyVaultTitle')}>
      <div className={styles.summary}>
        <p className={styles.note}>{t('historyVaultLocal')}</p>
        <div role="status">
          {canCompare ? (
            <p className={styles.note}>
              {t('historyVaultProtectedSessions', { count: protectedSessions, total: totalSessions })}
            </p>
          ) : (
            <>
              {totalSessions !== null && (
                <p className={styles.note}>{t('historyVaultCurrentSessions', { count: totalSessions })}</p>
              )}
              {protectedSessions !== null && (
                <p className={styles.note}>{t('historyVaultStoredSessions', { count: protectedSessions })}</p>
              )}
            </>
          )}
          {protectedOriginals !== null && (
            <p className={styles.note}>{t('historyVaultOriginals', { count: protectedOriginals })}</p>
          )}
          {missingOriginals !== null && missingOriginals > 0 && (
            <p className={styles.note}>{t('historyVaultMissingOriginals', { count: missingOriginals })}</p>
          )}
          {protectedBytes !== null && (
            <p className={styles.note}>{t('historyVaultSize', { size: formatSize(protectedBytes) })}</p>
          )}
          {vault.phase === 'checking' && <p className={styles.note}>{t('historyVaultChecking')}</p>}
          {vault.phase === 'protecting' && (
            <p className={styles.note}>
              {vault.total > 0
                ? t('historyVaultProtectProgress', { processed: vault.processed, total: vault.total })
                : t('historyVaultProtecting')}
            </p>
          )}
          {vault.phase === 'restoring' && !canRestore && (
            <p className={styles.note}>{t('historyVaultRestoring')}</p>
          )}
        </div>
        {vault.phase === 'error' && (
          <p className={styles.error} role="alert">{t(historyVaultIssueMessage(vault.issue))}</p>
        )}
      </div>
      {!busy && canProtect && (
        <Row
          icon={<IconRefreshOutline16 />}
          label={t(vault.phase === 'error' ? 'historyVaultRetryProtection' : 'historyVaultProtect')}
          disabled={disabled}
          onClick={() => void protectAllHistory()}
        />
      )}
      {!busy && !canProtect && vault.phase === 'error' && (
        <Row
          icon={<IconRefreshOutline16 />}
          label={t('historyVaultRetryCheck')}
          disabled={disabled}
          onClick={() => void refreshHistoryVault()}
        />
      )}
      {canRestore && (
        <div className={styles.settingsRecovery}>
          <HistoryVaultRestore disabled={disabled || busy} onResult={onResult} showAvailability={false} />
          <p className={styles.mergeNote}>{t('historyVaultMerge')}</p>
        </div>
      )}
    </Section>
  )
}
