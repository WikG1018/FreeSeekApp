import clsx from 'clsx'
import { memo, useId, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  IconDownloadOutline16,
  IconEditOutline16,
  IconBookOutline16,
  IconEllipsisOutline16,
  IconLinkOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import {
  renameSession,
  selectSession,
  setSessionPinned,
  startInheritSession,
  useChatStore,
} from '../../services/chat/store.js'
import { BackupError, saveHistoryBackup } from '../../services/chat/backup.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { useNativeGoalActivity } from '../../services/tasks/goalBridge.js'
import { openContextSummary } from '../messages/ContextSummaryDialog.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import { ConversationIcon } from './ConversationIcon.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [backupReport, setBackupReport] = useState<Awaited<ReturnType<typeof saveHistoryBackup>>>()
  const [backupError, setBackupError] = useState<TranslationKey>()
  const displayTitle = session.title || t('untitledChat')
  const kindId = useId()
  const mode = session.mode ?? 'chat'
  const kind = t(mode === 'agent' ? 'siderAgentType' : 'siderChatType')
  const running = useChatStore((state) => Object.hasOwn(state.streaming, session.id))
  const nativeRunning = useNativeGoalActivity((state) => state.sessionId === session.id)
  const compressing = useChatStore((state) => Object.hasOwn(state.compressing, session.id))
  const activity = compressing
    ? 'siderCompressRunning'
    : running || nativeRunning
      ? mode === 'agent'
        ? 'siderAgentRunning'
        : 'siderReplyRunning'
      : undefined

  const backup = async () => {
    setBackingUp(true)
    setBackupReport(undefined)
    setBackupError(undefined)
    try {
      setBackupReport(await saveHistoryBackup(session.id))
    } catch (error) {
      setBackupError(error instanceof BackupError ? error.key : 'historyExportWriteFailed')
    } finally {
      setBackingUp(false)
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <div
        className={clsx(styles.item, active && styles.active)}
        data-session-id={session.id}
        data-session-mode={mode}
        data-session-activity={activity}
      >
        <button
          type="button"
          className={styles.openSession}
          data-sider-swipe-row
          aria-current={active ? 'page' : undefined}
          aria-describedby={kindId}
          onClick={() => {
            selectSession(session.id)
            closeMobileSider()
          }}
        >
          <span className={styles.kind} title={kind} aria-hidden>
            <ConversationIcon mode={mode} />
          </span>
          <span className={styles.copy}>
            <span className={styles.title}>{displayTitle}</span>
          </span>
          {activity && (
            <span className={styles.activity} aria-hidden="true">
              <span className={styles.activityDot} />
              {t(activity)}
            </span>
          )}
          {session.pinned && (
            <span className={styles.pin} aria-hidden>
              <IconPinOutline16 />
            </span>
          )}
        </button>
        <span id={kindId} className={styles.accessibleKind}>
          {kind}
          {activity && ' · ' + t(activity)}
          {session.pinned && ' · ' + t('sessionPinned')}
        </span>
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'pin',
                label: t(session.pinned ? 'sessionUnpin' : 'sessionPin'),
                icon: <IconPinOutline16 />,
                onSelect: () =>
                  void setSessionPinned(session.id, !session.pinned).then((updated) => {
                    if (!updated) {
                      showToast({ key: 'sessionPinFailed', type: 'error' })
                    }
                  }),
              },
              {
                key: 'continue',
                label: t('sessionItemMenuContinueOption'),
                icon: <IconLinkOutline16 />,
                onSelect: () => {
                  startInheritSession(session.id)
                  closeMobileSider()
                },
              },
              {
                key: 'compress',
                label: t('compressTitle'),
                icon: <IconBookOutline16 />,
                onSelect: () => {
                  selectSession(session.id)
                  closeMobileSider()
                  openContextSummary(session.id)
                },
              },
              {
                key: 'backup',
                label: t('sessionItemMenuBackupOption'),
                icon: <IconDownloadOutline16 />,
                disabled: backingUp,
                onSelect: () => void backup(),
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle, open }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      </div>
      {backupError ? (
        <div className={clsx(styles.backupStatus, styles.backupError)} role="alert">
          {t('historyExportFailed', { message: t(backupError) })}
        </div>
      ) : (
        (backingUp || backupReport) && (
          <div className={styles.backupStatus} role="status">
            {backingUp
              ? t('sessionRecoveryPreparing')
              : t(
                  backupReport?.destination === 'document'
                    ? 'historyExportSaved'
                    : 'historyExportDownloadStarted'
                )}
            {!!backupReport?.missingOriginals && (
              <div>
                {t('historyExportMissingOriginals', { count: backupReport.missingOriginals })}
              </div>
            )}
          </div>
        )
      )}
    </>
  )
})
