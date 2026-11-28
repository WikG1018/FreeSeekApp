import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
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
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ReplyBranchDialog } from './ReplyBranchDialog.js'
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
const HISTORY_WINDOW_LIMIT = HISTORY_PAGE_SIZE * 3
const HISTORY_PAGE_DISTANCE = 180
const HISTORY_SCROLL_IDLE_MS = 120
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
  scrollToTopRef,
}: {
  session: Session
  rounds?: ReadonlyMap<string, number>
  streaming: boolean
  footer?: React.ReactNode
  onPlanReply: () => void
  scrollToTopRef?: Ref<() => void>
  /** 滚动超过阈值时上报，供悬浮顶栏决定是否浮现渐隐 */
  onScrolledChange?: (scrolled: boolean) => void
}) => {
  const isMobile = useIsMobile()
  const t = useTranslate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const readingTurn = useRef<{ replyId: string; questionId: string; follow: boolean; space: number } | null>(null)
  const previousPosition = useRef<{ sessionId: string; end?: string; activeReply?: string }>()
  const scrollTopRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const [branchTarget, setBranchTarget] = useState<{ sessionId: string; messageId: string } | null>(null)
  const requestBranch = useCallback((messageId: string) => {
    setBranchTarget({ sessionId: session.id, messageId })
  }, [session.id])
  const closeBranch = useCallback(() => setBranchTarget(null), [])
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
  const visibleCount = targetIndex >= 0 || (windowForSession?.through && !through)
    ? HISTORY_PAGE_SIZE
    : (windowForSession?.count ?? HISTORY_PAGE_SIZE)
  const visibleStart = Math.max(0, visibleEnd - visibleCount)
  const showingEarlier = visibleEnd < allMessages.length
  const messages = allMessages.slice(visibleStart, visibleEnd)
  const pagingScroll = useRef<{
    sessionId: string
    messageId?: string
    offset: number
    scrollTop: number
  } | null>(null)
  const jumpAfterPaging = useRef(false)
  useLayoutEffect(() => {
    setHistoryWindow({ sessionId: session.id, count: HISTORY_PAGE_SIZE })
  }, [session.id])
  useLayoutEffect(() => {
    const anchor = pagingScroll.current,
      scroll = scrollRef.current
    if (jumpAfterPaging.current && scroll) {
      jumpAfterPaging.current = false
      scroll.scrollTop = 0
      scrollTopRef.current = 0
    } else if (anchor && scroll && anchor.sessionId === session.id) {
      const message = anchor.messageId && scroll.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchor.messageId)}"]`
      )
      scroll.scrollTop = message ? message.offsetTop - anchor.offset : anchor.scrollTop
      scrollTopRef.current = scroll.scrollTop
    }
    pagingScroll.current = null
  }, [session.id, visibleStart, visibleEnd])
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
  const lastReply = allMessages.at(-1)
  const activeReply =
    streaming && lastReply?.role === 'assistant' &&
    (lastReply.status === 'pending' || lastReply.status === 'streaming')
      ? lastReply.id
      : undefined
  const turnQuestionId = activeReply
    ? allMessages.findLast((message) => message.role === 'user')?.id
    : undefined

  const releaseTurn = useCallback(() => {
    readingTurn.current = null
    scrollRef.current?.removeAttribute('data-reading-turn')
    contentRef.current?.style.removeProperty('--reply-reading-space')
  }, [])
  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }
    const content = contentRef.current
    const turn = readingTurn.current
    const question = turn && scroll.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(turn.questionId)}"]`
    )
    const reply = turn && scroll.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(turn.replyId)}"]`
    )
    if (turn && content && question && reply) {
      scroll.setAttribute('data-reading-turn', '')
      const inset = Number.parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 0
      // 短回复先把本轮提问放在顶栏下方。offsetTop 使用布局坐标，不受字体缩放和入场动画影响。
      const questionStart = Math.max(0, question.offsetTop - inset)
      const naturalHeight = content.offsetHeight - turn.space
      const space = Math.max(0, questionStart + scroll.clientHeight - naturalHeight)
      if (space !== turn.space) {
        content.style.setProperty('--reply-reading-space', `${space}px`)
        turn.space = space
      }
      if (turn.follow) {
        // 正文增长时最多跟到回答开头，后续内容向下延伸。
        const replyStart = Math.max(0, reply.offsetTop - inset)
        const latest = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
        scroll.scrollTop = Math.min(latest, replyStart)
        scrollTopRef.current = scroll.scrollTop
        setAtBottom(latest - scroll.scrollTop < STICKY_THRESHOLD)
        return
      }
    }
    if (stickyRef.current) {
      scroll.scrollTop = scroll.scrollHeight
      scrollTopRef.current = scroll.scrollTop
      setAtBottom(true)
    }
  }, [])
  const goToTop = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || allMessages.length === 0) {
      return
    }
    releaseTurn()
    stickyRef.current = false
    if (visibleStart > 0) {
      setAtBottom(false)
      // 跳到第一批消息，长历史可以向后分批加载。
      jumpAfterPaging.current = true
      pagingScroll.current = null
      setHistoryWindow({
        sessionId: session.id,
        count: HISTORY_PAGE_SIZE,
        through: { end: HISTORY_PAGE_SIZE, latest },
      })
      return
    }
    setAtBottom(
      !showingEarlier && scroll.scrollHeight - scroll.clientHeight < STICKY_THRESHOLD
    )
    const smooth =
      scroll.scrollTop < scroll.clientHeight * 2 &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroll.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
  }, [allMessages.length, latest, releaseTurn, session.id, showingEarlier, visibleStart])
  useImperativeHandle(scrollToTopRef, () => goToTop, [goToTop])

  /** 点击「回到底部」：平滑滚动并恢复跟随 */
  const goToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    releaseTurn()
    stickyRef.current = true
    if (showingEarlier) {
      setHistoryWindow({ sessionId: session.id, count: HISTORY_PAGE_SIZE })
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }, [releaseTurn, session.id, showingEarlier])

  const pageHistory = useCallback((direction: 'earlier' | 'later') => {
    const scroll = scrollRef.current
    if (!scroll || pagingScroll.current) {
      return
    }
    let start = visibleStart
    let end = visibleEnd
    // Drop the far end of the loaded range only after three full pages are visible.
    if (direction === 'earlier') {
      start = Math.max(0, start - HISTORY_PAGE_SIZE)
      end = Math.min(end, start + HISTORY_WINDOW_LIMIT)
    } else {
      end = Math.min(allMessages.length, end + HISTORY_PAGE_SIZE)
      start = Math.max(start, end - HISTORY_WINDOW_LIMIT)
    }
    if (start === visibleStart && end === visibleEnd) {
      return
    }
    const viewportTop = scroll.getBoundingClientRect().top
    const inset = Number.parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 0
    const anchor = Array.from(scroll.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((message) => message.getBoundingClientRect().bottom > viewportTop + inset)
    pagingScroll.current = {
      sessionId: session.id,
      messageId: anchor?.dataset.messageId,
      offset: (anchor?.offsetTop ?? 0) - scroll.scrollTop,
      scrollTop: scroll.scrollTop,
    }
    releaseTurn()
    stickyRef.current = false
    logEvent('ui', direction === 'earlier' ? 'history.load-earlier' : 'history.load-later', {
      totalMessages: allMessages.length,
      shownMessages: end - start,
    })
    setHistoryWindow({
      sessionId: session.id,
      count: end - start,
      through: through || end < allMessages.length ? { end, latest } : undefined,
    })
  }, [allMessages.length, latest, releaseTurn, session.id, through, visibleStart, visibleEnd])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(syncScroll)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, syncScroll])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const previous = previousPosition.current
    previousPosition.current = { sessionId: session.id, end: lastMessageId, activeReply }
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
        scrollTopRef.current = scroll.scrollTop
      }
      restoreScrollRef.current = null
      return
    }
    if (targetIndex >= 0) {
      return
    }
    const changedSession = previous?.sessionId !== session.id
    if (activeReply && turnQuestionId && !showingEarlier &&
      (changedSession || previous.activeReply !== activeReply)) {
      releaseTurn()
      readingTurn.current = { replyId: activeReply, questionId: turnQuestionId, follow: true, space: 0 }
      stickyRef.current = false
      syncScroll()
    } else if (!through && (changedSession || previous.end !== lastMessageId)) {
      releaseTurn()
      stickyRef.current = true
      syncScroll()
    }
  }, [session.id, lastMessageId, activeReply, turnQuestionId, showingEarlier, through,
    targetIndex, releaseTurn, syncScroll])

  useLayoutEffect(() => {
    if (!target) {
      return
    }
    const scroll = scrollRef.current
    const found =
      targetIndex >= 0 &&
      scroll?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)
    if (found && scroll) {
      releaseTurn()
      stickyRef.current = false
      setHistoryWindow({
        sessionId: session.id,
        count: HISTORY_PAGE_SIZE,
        through: showingEarlier ? { end: visibleEnd, latest } : undefined,
      })
      const inset = Number.parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 0
      scroll.scrollTop = found.offsetTop - inset
      scrollTopRef.current = scroll.scrollTop
      setAtBottom(
        !showingEarlier && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICKY_THRESHOLD
      )
    } else {
      logEvent('ui', 'history.target-unavailable', { sessionId: session.id })
      showToast({ key: 'messageTargetUnavailable', type: 'error' })
    }
    clearMessageTarget(session.id, target)
  }, [session.id, target, targetIndex, latest, showingEarlier, visibleEnd, releaseTurn])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      releaseTurn()
      stickyRef.current = false
      closeSearchPanel()
      stopReadAloud()
      const current = useChatStore.getState().sessionCache[session.id]
      if (current) {
        const path = getVisibleMessages(selectBranch(current, messageId))
        const selectedIndex = path.findIndex((message) => message.id === messageId)
        if (selectedIndex >= 0) {
          const end = Math.min(path.length, Math.max(HISTORY_PAGE_SIZE, selectedIndex + 21))
          setHistoryWindow({
            sessionId: session.id,
            count: visibleCount,
            through: end < path.length ? { end, latest: path.at(-1)?.id } : undefined,
          })
        }
      }
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming, visibleCount, releaseTurn]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current || readingTurn.current?.follow) {
      syncScroll()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    let touching = false
    let nextPage: 'earlier' | 'later' | null = null
    let pageTimer: number | undefined
    const schedulePage = () => {
      clearTimeout(pageTimer)
      if (touching || !nextPage) {
        return
      }
      // Legacy WebView can apply an old scroll offset while a fling is still moving.
      // Shift the loaded range only once that motion has settled.
      pageTimer = window.setTimeout(() => {
        const direction = nextPage
        nextPage = null
        if (direction === 'later' && showingEarlier &&
          el.scrollHeight - el.clientHeight - el.scrollTop <= HISTORY_PAGE_DISTANCE) {
          pageHistory(direction)
        } else if (direction === 'earlier' && visibleStart > 0 && el.scrollTop <= HISTORY_PAGE_DISTANCE) {
          pageHistory(direction)
        }
      }, HISTORY_SCROLL_IDLE_MS)
    }
    const onTouchStart = () => {
      touching = true
      clearTimeout(pageTimer)
    }
    const onTouchEnd = () => {
      touching = false
      schedulePage()
    }
    const onScroll = () => {
      const latest = Math.max(0, el.scrollHeight - el.clientHeight)
      // 折叠思考或键盘改变高度时，浏览器可能自动限制 scrollTop。
      const previousTop = Math.min(scrollTopRef.current, latest)
      const moved = Math.abs(el.scrollTop - previousTop) > 1
      if (readingTurn.current?.follow && moved) {
        readingTurn.current.follow = false
      }
      const nearBottom = !showingEarlier && latest - el.scrollTop < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom && !readingTurn.current?.follow && (moved || stickyRef.current)) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      setAtBottom(nearBottom)
      if (moved) {
        if (showingEarlier && el.scrollTop > previousTop &&
          latest - el.scrollTop <= HISTORY_PAGE_DISTANCE) {
          nextPage = 'later'
        } else if (through && visibleStart > 0 && el.scrollTop < previousTop &&
          el.scrollTop <= HISTORY_PAGE_DISTANCE) {
          nextPage = 'earlier'
        } else {
          nextPage = null
        }
        schedulePage()
      }
      // 顶栏渐隐：滚动离开顶部后浮现
      const scrolled = el.scrollTop > 4
      if (scrolled !== scrolledRef.current) {
        scrolledRef.current = scrolled
        onScrolledChange?.(scrolled)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // 初始即在顶部（无滚动）时确保顶栏无渐隐
    onScrolledChange?.(el.scrollTop > 4)
    return () => {
      clearTimeout(pageTimer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [isMobile, syncScroll, onScrolledChange, showingEarlier, pageHistory, through, visibleStart])

  const latestIndex = allMessages.length - 1
  const uploadRetryId = getUploadRetryId(allMessages, streaming)
  return (
    <ScrollToBottomContext.Provider value={syncScroll}>
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
                onClick={() => pageHistory('earlier')}
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
                  onBranchReply={requestBranch}
                />
              )
            )}
            {showingEarlier && (
              <button
                type="button"
                className={styles.loadLater}
                onClick={() => pageHistory('later')}
              >
                {t('loadLaterMessages', { count: allMessages.length - visibleEnd })}
              </button>
            )}
          </div>
        </div>
        {footer}
        {branchTarget && <ReplyBranchDialog {...branchTarget} onClose={closeBranch} />}
        {messages.length > 0 && (showingEarlier || !atBottom) ? (
          <button
            type="button"
            className={styles.toBottom}
            data-history-latest={showingEarlier || undefined}
            aria-label={t(showingEarlier ? 'backToLatestMessage' : 'backToBottom')}
            title={t(showingEarlier ? 'backToLatestMessage' : 'backToBottom')}
            onClick={goToBottom}
          >
            <IconChevronDownOutline14 />
            {showingEarlier && <span aria-hidden="true">{t('backToLatestShort')}</span>}
          </button>
        ) : null}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
