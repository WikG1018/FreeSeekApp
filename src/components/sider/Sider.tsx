import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconChevronRightOutline14,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings, useSettingsDialog } from '../settings/settingsDialogState.js'
import { SupportMark, useDocumentVisible } from '../donate/SupportMark.js'
import { SidebarUpdate } from '../update/Update.js'
import { closeMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { useSessionSearch } from './useSessionSearch.js'
import styles from './Sider.module.css'

/** 展开的会话侧边栏，移动端放在由手势和系统返回控制的抽屉里。 */
export const Sider = ({
  mobile = false,
  donationOpen,
  onDonate,
}: {
  mobile?: boolean
  donationOpen: boolean
  onDonate: () => void
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const keyword = query.trim()
  const composing = useRef(false)
  const search = useSessionSearch(sessions, keyword)
  const listRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(80)
  useLayoutEffect(() => {
    setVisibleCount(80)
    if (listRef.current) {
      listRef.current.scrollTop = 0
    }
  }, [keyword])
  const ordered = useMemo(
    () => [
      ...search.sessions.filter((session) => session.pinned),
      ...search.sessions.filter((session) => !session.pinned),
    ],
    [search.sessions]
  )
  const groups = useMemo(
    () => groupSessions(ordered.slice(0, visibleCount), now, t),
    [ordered, visibleCount, now, t]
  )
  const showMore = () => setVisibleCount((count) => Math.min(count + 80, ordered.length))
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const settingsOpen = useSettingsDialog((state) => state.open)
  const documentVisible = useDocumentVisible()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <header className={styles.top} data-testid="sider-header">
        {!mobile && (
          <IconButton
            size="m"
            hitArea
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => setSiderCollapsed(true)}
          />
        )}
        <div className={styles.appName}>{t('appName')}</div>
        <SidebarUpdate />
      </header>
      <div className={styles.searchBox}>
        <span className={styles.searchIcon} aria-hidden="true">
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.searchInput}
          type="search"
          aria-label={t('siderSearchPlaceholder')}
          placeholder={t('siderSearchPlaceholder')}
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(event) => {
            composing.current = false
            setQuery(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing) {
              event.currentTarget.blur()
            }
          }}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={styles.list}
          data-testid="sider-list"
          onScroll={(event) => {
            const node = event.currentTarget
            if (
              node.scrollHeight - node.scrollTop - node.clientHeight < 200 &&
              visibleCount < ordered.length
            ) {
              showMore()
            }
          }}
        >
          {groups.length === 0 && !search.searching && !search.failed && (
            <p className={styles.emptyList} role="status">
              {t(keyword ? 'siderEmptySearch' : 'siderEmptyHistory')}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  match={search.matches?.get(session.id)}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
          {visibleCount < ordered.length && (
            <button type="button" className={styles.showMore} onClick={showMore}>
              {t('sessionShowMore')}
            </button>
          )}
          {(search.searching || search.failed) && (
            <p className={styles.emptyList} role="status">
              {t(search.searching ? 'siderSearching' : 'siderSearchFailed')}
            </p>
          )}
        </div>
      </div>
      <div className={styles.bottom} data-testid="sider-footer">
        <button
          type="button"
          className={clsx(styles.settings, styles.support)}
          data-support-motion={
            documentVisible && !donationOpen && !settingsOpen && !deleting ? '' : undefined
          }
          onClick={onDonate}
          aria-label={t('donateTitle')}
        >
          <span className={clsx(styles.settingsIcon, styles.donateHeart)}>
            <SupportMark />
          </span>
          <span className={styles.settingsLabel} aria-hidden="true">
            <span>{t('donateTitle')}</span>
            <span>{t('donateSmallTip')}</span>
            <span>{t('donateSupport')}</span>
          </span>
          <span aria-hidden className={styles.supportArrow}>
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={clsx(styles.settings, styles.settingsOnly)}
          aria-label={t('settings')}
          title={t('settings')}
          onClick={() => openSettings()}
        >
          <span className={styles.settingsIcon} aria-hidden="true">
            <IconSettingsOutline16 />
          </span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}
