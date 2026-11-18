import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
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
import { openSettings } from '../settings/settingsDialogState.js'
import { SupportMark } from '../donate/SupportMark.js'
import { DonateDialog } from '../donate/DonateDialog.js'
import { SidebarUpdate } from '../update/Update.js'
import { closeMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(80)
  useEffect(() => setVisibleCount(80), [query])
  const filteredSessions = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return keyword
      ? sessions.filter((session) => (session.title || '').toLowerCase().includes(keyword))
      : sessions
  }, [sessions, query])
  const ordered = useMemo(
    () => [
      ...filteredSessions.filter((session) => session.pinned),
      ...filteredSessions.filter((session) => !session.pinned),
    ],
    [filteredSessions]
  )
  const groups = useMemo(
    () => groupSessions(ordered.slice(0, visibleCount), now, t),
    [ordered, visibleCount, now, t]
  )
  const showMore = () => setVisibleCount((count) => Math.min(count + 80, ordered.length))
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [donateOpen, setDonateOpen] = useState(false)

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
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          hitArea
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      {mobile ? (
        <div className={styles.searchBox}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.searchInput}
            type="search"
            aria-label={t('siderSearchPlaceholder')}
            placeholder={t('siderSearchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
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
      <SidebarUpdate />
      <div className={styles.listWrap}>
        <div
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
          {groups.length === 0 && (
            <p className={styles.emptyList} role="status">
              {t(query.trim() ? 'siderEmptySearch' : 'siderEmptyHistory')}
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
        </div>
      </div>
      <div className={styles.bottom} data-testid="sider-footer">
        <button type="button" className={styles.settings} onClick={() => openSettings()}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
        <button
          type="button"
          className={clsx(styles.settings, styles.support)}
          onClick={() => setDonateOpen(true)}
          aria-label={t('donateTitle')}
        >
          <span className={clsx(styles.settingsIcon, styles.donateHeart)}>
            <SupportMark />
          </span>
          <span className={styles.settingsLabel}>{t('donateTitle')}</span>
          <span aria-hidden className={styles.supportArrow}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </div>
      {donateOpen ? <DonateDialog onClose={() => setDonateOpen(false)} /> : null}
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
