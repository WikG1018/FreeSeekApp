import clsx from 'clsx'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { newChat } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { computeReplyUsage, hasKnownPricing, usePricing } from '../../services/usage.js'
import { useSettings } from '../../services/settings.js'
import { IconNewChatOutline20 } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话内所有已记录回复的 token 总量（输入含缓存 + 输出） */
const sessionTokens = (session: Session): number =>
  getVisibleMessages(session).reduce((total, message) => {
    if (message.role !== 'assistant' || !message.usage) {
      return total
    }
    return (
      total +
      (message.usage.input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0) +
      (message.usage.cache_creation_input_tokens ?? 0) +
      (message.usage.output_tokens ?? 0)
    )
  }, 0)

const formatTokens = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 0.01 ? `¥${value.toFixed(2)}` : `¥${value.toFixed(4)}`

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const showUsage = useSettings((state) => state.showUsage)
  const title = session.title || t('untitledChat')
  const tokens = useMemo(() => sessionTokens(session), [session])
  const pricing = usePricing((state) => state.pricing)
  const cost = useMemo(
    () =>
      getVisibleMessages(session).reduce((total, message) => {
        if (message.role !== 'assistant' || !message.usage) {
          return total
        }
        return total + computeReplyUsage(message, pricing).costCny
      }, 0),
    [session, pricing]
  )
  const viewRef = useRef<HTMLDivElement>(null),
    dockRef = useRef<HTMLDivElement>(null),
    headerRef = useRef<HTMLDivElement>(null)
  // 遮罩和末尾留白随输入框真实高度变化，长草稿、附件和字体缩放不会盖住最后一条消息。
  useLayoutEffect(() => {
    const view = viewRef.current,
      dock = dockRef.current,
      header = headerRef.current
    if (!view || !dock || !header) {
      return
    }
    const measure = () => {
      const height = view.clientHeight,
        top = header.offsetHeight,
        bottom = dock.offsetHeight,
        compact = height < 260
      view.style.setProperty('--composer-height', `${bottom}px`)
      view.style.setProperty('--composer-inset', `${bottom + (compact ? 8 : 40)}px`)
      view.style.setProperty('--message-list-top-inset', `${top ? top + 16 : 8}px`)
      view.style.setProperty(
        '--message-fade-top',
        `${Math.min(top ? top + 28 : 0, Math.max(0, height - bottom - 32))}px`
      )
      view.style.setProperty(
        '--message-fade-bottom',
        `${Math.min(bottom + 28, Math.max(0, height - top - 24))}px`
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    observer.observe(dock)
    observer.observe(header)
    return () => observer.disconnect()
  }, [isMobile, session.id])
  const priced = getVisibleMessages(session).every(
    (message) => message.role !== 'assistant' || hasKnownPricing(message)
  )
  return (
    <div ref={viewRef} className={styles.view} data-testid="chat-view">
      {isMobile ? (
        <MobileHeader title={title} headerRef={headerRef} />
      ) : (
        <div ref={headerRef} className={styles.header} data-testid="chat-header">
          <div className={clsx(styles.headerPill, siderCollapsed && styles.withCollapsedSider)}>
            <div className={styles.title}>{title}</div>
            {showUsage && tokens > 0 ? (
              <span className={styles.usage} title={t('usageTokensTitle')}>
                {formatTokens(tokens)} tok{priced ? ` · ${formatCost(cost)}` : ''}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.headerAction}
            aria-label={t('newChat')}
            onClick={newChat}
          >
            <IconNewChatOutline20 />
          </button>
        </div>
      )}
      <MessageList session={session} streaming={streaming} />
      <div ref={dockRef} className={styles.dock} data-testid="chat-dock">
        <div className={styles.dockInner}>
          <ChatInput sessionId={session.id} />
        </div>
      </div>
    </div>
  )
}
