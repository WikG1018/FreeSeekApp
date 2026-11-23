import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useAssistantLibrary } from '../../services/assistants/library.js'
import {
  IconChevronRightOutline14,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import {
  setSiderCollapsed,
  setSiderOrder,
  useSettings,
  type SiderOrder,
} from '../../services/settings.js'
import { groupSessions, orderSessions } from '../../services/chat/sessionGroups.js'
import { initChat, newChat, removeSession, useChatStore } from '../../services/chat/store.js'
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
import { SiderOrderPicker } from './SiderOrderPicker.js'
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
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const historyMissing = useChatStore((state) => state.historyMissing)
  const activeId = useChatStore((state) => state.activeId)
  const order = useSettings((state) => state.siderOrder)
  // 排序里的「按类型」依赖 Agent 会话：只有开关开启、或历史里已存在 Agent 会话时才有意义
  const askChatMode = useSettings((state) => state.askChatMode)
  const hasAgentSessions = useChatStore((state) =>
    state.sessions.some((session) => session.mode === 'agent')
  )
  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const keyword = query.trim()
  const composing = useRef(false)
  const search = useSessionSearch(sessions, keyword)
  const listRef = useRef<HTMLDivElement>(null)
  const rowPositions = useRef<Map<string, number> | null>(null)
  const [visibleCount, setVisibleCount] = useState(80)
  useLayoutEffect(() => {
    setVisibleCount(80)
    if (listRef.current) {
      listRef.current.scrollTop = 0
    }
  }, [keyword, order])
  const ordered = useMemo(() => orderSessions(search.sessions, order), [search.sessions, order])
  const groups = useMemo(
    () => groupSessions(ordered.slice(0, visibleCount), now, t, order),
    [ordered, visibleCount, now, t, order]
  )
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const update = () => {
      list.dataset.fadeMore = String(list.scrollHeight - list.scrollTop - list.clientHeight > 3)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(list)
    if (list.firstElementChild) {
      observer.observe(list.firstElementChild)
    }
    list.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', update)
    }
  }, [groups])
  const changeOrder = (next: SiderOrder) => {
    if (next === order) {
      return
    }
    const list = listRef.current
    if (list && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const bounds = list.getBoundingClientRect()
      const before = new Map<string, number>()
      for (const row of list.querySelectorAll<HTMLElement>('[data-session-id]')) {
        const rect = row.getBoundingClientRect()
        const id = row.dataset.sessionId
        if (id && rect.bottom > bounds.top && rect.top < bounds.bottom) {
          before.set(id, rect.top)
        }
      }
      rowPositions.current = before
    }
    setSiderOrder(next)
  }
  useLayoutEffect(() => {
    const before = rowPositions.current
    rowPositions.current = null
    if (!before?.size) {
      return
    }
    for (const row of listRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? []) {
      const previousTop = before.get(row.dataset.sessionId ?? '')
      if (previousTop !== undefined && typeof row.animate === 'function') {
        const distance = previousTop - row.getBoundingClientRect().top
        if (Math.abs(distance) >= 1 && Math.abs(distance) <= 120) {
          row.animate([{ transform: 'translateY(' + distance + 'px)' }, { transform: 'none' }], {
            duration: 175,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          })
        }
      }
    }
  }, [order])
  const showMore = () => setVisibleCount((count) => Math.min(count + 80, ordered.length))
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteLinkedMemory, setDeleteLinkedMemory] = useState(false)
  const hasLinkedMemory = useAssistantLibrary(({ data }) =>
    Boolean(deleting && data.memories.some((note) => note.source?.sessionId === deleting.id))
  )
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
      <div className={styles.quickActions} data-testid="sider-quick-actions">
        <label className={styles.searchBox}>
          <span className={styles.searchIcon} aria-hidden="true">
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.searchInput}
            type="search"
            aria-label={t('siderSearchPlaceholder')}
            placeholder={t('siderSearchShort')}
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
        </label>
        <button
          type="button"
          className={styles.newChat}
          aria-label={t('newChat')}
          title={t('newChat')}
          data-chat-mode-anchor
          onClick={(event) => {
            newChat(event.currentTarget)
            if (!useChatStore.getState().chatModePrompt) {
              closeMobileSider()
            }
          }}
        >
          <span className={styles.newChatIcon} aria-hidden="true">
            <NewChatIcon />
          </span>
          <span>{t('siderNewChat')}</span>
        </button>
      </div>
      {ready && sessions.length > 0 && (askChatMode || hasAgentSessions) && (
        <div className={styles.historyToolbar}>
          <SiderOrderPicker order={order} onChange={changeOrder} />
        </div>
      )}
      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={styles.list}
          data-testid="sider-list"
          data-scroll-edge=""
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
          <div data-scroll-edge-content="">
            {!ready && (
              <div className={styles.historyStatus} role="status">
                <p>
                  {t(
                    initError
                      ? historyMissing
                        ? 'historyPreviouslySaved'
                        : 'sessionListLoadFailed'
                      : 'sessionLoading'
                  )}
                </p>
                {initError && (
                  <Button variant="outlined" size="m" onClick={() => void initChat()}>
                    {t('retry')}
                  </Button>
                )}
              </div>
            )}
            {ready && groups.length === 0 && !search.searching && !search.failed && (
              <p className={styles.emptyList} role="status">
                {t(keyword ? 'siderEmptySearch' : 'siderEmptyHistory')}
              </p>
            )}
            {groups.map((group) => (
              <section key={group.key} className={styles.section} data-session-group={group.key}>
                <h3 className={styles.sectionHeader}>{group.label}</h3>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    match={search.matches?.get(session.id)}
                    onDelete={() => {
                      setDeleteLinkedMemory(false)
                      setDeleting(session)
                    }}
                  />
                ))}
              </section>
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
                    if (
                      await removeSession(deleting.id, {
                        deleteLinkedMemory: hasLinkedMemory && deleteLinkedMemory,
                      })
                    ) {
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
          {hasLinkedMemory && (
            <label className={styles.deleteMemory}>
              <input
                type="checkbox"
                checked={deleteLinkedMemory}
                disabled={deletePending}
                onChange={(event) => setDeleteLinkedMemory(event.currentTarget.checked)}
              />
              <span>{t('assistantDeleteLinkedMemory')}</span>
            </label>
          )}
        </Modal>
      ) : null}
    </div>
  )
}
