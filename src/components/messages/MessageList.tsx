import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  selectVersion as selectBranch,
  type MessageVersions,
} from '../../services/chat/branches.js'
import {
  clearMessageTarget,
  selectMessageVersion,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'
import { logEvent } from '../../services/diagnostics/log.js'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const HISTORY_PAGE_SIZE = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
type HistoryWindow = {
  sessionId: string
  count: number
  through?: { end: number; latest?: string }
}

export const MessageList = ({
  session,
  rounds,
  streaming,
  footer,
  onScrolledChange,
  onPlanReply,
}: {
  session: Session
  rounds?: ReadonlyMap<string, number>
  streaming: boolean
  footer?: React.ReactNode
  onPlanReply: () => void
  /** 滚动超过阈值时上报，供悬浮顶栏决定是否浮现渐隐 */
  onScrolledChange?: (scrolled: boolean) => void
}) => {
  const isMobile = useIsMobile()
  const t = useTranslate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const scrolledRef = useRef(false)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const allMessages = useMemo(() => getVisibleMessages(session), [session])
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>({
    sessionId: session.id,
    count: HISTORY_PAGE_SIZE,
  })
  const target = useChatStore((state) =>
    state.activeId === session.id ? state.targetMessageId : null
  )
  const targetIndex = target ? allMessages.findIndex((message) => message.id === target) : -1
  const latest = allMessages.at(-1)?.id
  const windowForSession = historyWindow.sessionId === session.id ? historyWindow : null
  const through =
    windowForSession?.through?.latest === latest ? windowForSession?.through : undefined
  const visibleEnd =
    targetIndex >= 0
      ? Math.min(allMessages.length, Math.max(HISTORY_PAGE_SIZE, targetIndex + 21))
      : (through?.end ?? allMessages.length)
  const visibleCount =
    targetIndex >= 0 ? HISTORY_PAGE_SIZE : (windowForSession?.count ?? HISTORY_PAGE_SIZE)
  const visibleStart = Math.max(0, visibleEnd - visibleCount)
  const showingEarlier = visibleEnd < allMessages.length
  const messages = allMessages.slice(visibleStart, visibleEnd)
  const earlierScroll = useRef<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    setHistoryWindow({ sessionId: session.id, count: HISTORY_PAGE_SIZE })
  }, [session.id])
  useLayoutEffect(() => {
    const anchor = earlierScroll.current,
      scroll = scrollRef.current
    if (anchor && scroll) {
      scroll.scrollTop = anchor.top + scroll.scrollHeight - anchor.height
      scrollTopRef.current = scroll.scrollTop
      earlierScroll.current = null
    }
  }, [visibleStart])
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      setAtBottom(true)
    }
  }, [])
  /** 点击「回到底部」：平滑滚动并恢复跟随 */
  const goToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    stickyRef.current = true
    if (showingEarlier) {
      setHistoryWindow({ sessionId: session.id, count: HISTORY_PAGE_SIZE })
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }, [session.id, showingEarlier])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useLayoutEffect(() => {
    if (!target) {
      return
    }
    const scroll = scrollRef.current
    const found =
      targetIndex >= 0 &&
      scroll?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)
    if (found && scroll) {
      stickyRef.current = false
      setHistoryWindow({
        sessionId: session.id,
        count: HISTORY_PAGE_SIZE,
        through: showingEarlier ? { end: visibleEnd, latest } : undefined,
      })
      const inset = Number.parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 0
      scroll.scrollTop +=
        found.getBoundingClientRect().top - scroll.getBoundingClientRect().top - inset
      scrollTopRef.current = scroll.scrollTop
      setAtBottom(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICKY_THRESHOLD)
    }
    clearMessageTarget(session.id, target)
  }, [session.id, target, targetIndex, latest, showingEarlier, visibleEnd])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      const current = useChatStore.getState().sessionCache[session.id]
      if (current) {
        const path = getVisibleMessages(selectBranch(current, messageId))
        const selectedIndex = path.findIndex((message) => message.id === messageId)
        if (selectedIndex >= 0) {
          setHistoryWindow({
            sessionId: session.id,
            count: Math.max(visibleCount, path.length - selectedIndex),
          })
        }
      }
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming, visibleCount]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      setAtBottom(nearBottom)
      // 顶栏渐隐：滚动离开顶部后浮现
      const scrolled = el.scrollTop > 4
      if (scrolled !== scrolledRef.current) {
        scrolledRef.current = scrolled
        onScrolledChange?.(scrolled)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 初始即在顶部（无滚动）时确保顶栏无渐隐
    onScrolledChange?.(el.scrollTop > 4)
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom, onScrolledChange])

  const latestIndex = allMessages.length - 1
  const uploadRetryId = getUploadRetryId(allMessages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div className={styles.container}>
        <div
          ref={scrollRef}
          className={styles.scroll}
          data-testid="message-scroll"
        >
          {/* 会话正文不做回弹：跟随式阅读时内容回弹会干扰输入框附近的视线 */}
          <div ref={contentRef} className={styles.column}>
            {visibleStart > 0 ? (
              <button
                type="button"
                className={styles.loadEarlier}
                onClick={() => {
                  const scroll = scrollRef.current
                  if (scroll) {
                    earlierScroll.current = { top: scroll.scrollTop, height: scroll.scrollHeight }
                  }
                  stickyRef.current = false
                  logEvent('ui', 'history.load-earlier', {
                    totalMessages: allMessages.length,
                    shownMessages: visibleCount,
                  })
                  setHistoryWindow({
                    sessionId: session.id,
                    count: visibleCount + HISTORY_PAGE_SIZE,
                    through,
                  })
                }}
              >
                {t('loadEarlierMessages', { count: visibleStart })}
              </button>
            ) : null}
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={visibleStart + index === 0}
                  isLast={visibleStart + index >= latestIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  round={rounds?.get(message.id)}
                  isLast={visibleStart + index === latestIndex}
                  streaming={streaming && visibleStart + index === latestIndex}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                  onPlanReply={onPlanReply}
                />
              )
            )}
          </div>
        </div>
        {footer}
        {messages.length > 0 && (showingEarlier || !atBottom) ? (
          <button
            type="button"
            className={styles.toBottom}
            aria-label={t(showingEarlier ? 'backToLatestMessage' : 'backToBottom')}
            onClick={goToBottom}
          >
            <IconChevronDownOutline14 />
          </button>
        ) : null}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
