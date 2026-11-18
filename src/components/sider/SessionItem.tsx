import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
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
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { openContextSummary } from '../messages/ContextSummaryDialog.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
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
  const displayTitle = session.title || t('untitledChat')

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
    <div className={clsx(styles.item, active && styles.active)} data-session-id={session.id}>
      <button
        type="button"
        className={styles.openSession}
        data-sider-swipe-row
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        {session.pinned && (
          <span className={styles.pin} aria-label={t('sessionPinned')}>
            <IconPinOutline16 />
          </span>
        )}
        <span className={styles.title}>{displayTitle}</span>
      </button>
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
  )
})
