import clsx from 'clsx'
import { useCallback, useMemo, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { newChat } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
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
  const title = session.title || t('untitledChat')
  const tokens = useMemo(() => sessionTokens(session), [session])
  // 滚动后才浮现顶栏渐隐（dsh-Go：静止时是一整块干净页面）
  const [scrolled, setScrolled] = useState(false)
  const onScrolledChange = useCallback((value: boolean) => setScrolled(value), [])
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} scrolled={scrolled} />
      ) : (
        <div className={clsx(styles.header, scrolled && styles.headerScrolled)}>
          <div className={clsx(styles.headerPill, siderCollapsed && styles.withCollapsedSider)}>
            <div className={styles.title}>{title}</div>
            {tokens > 0 ? (
              <span className={styles.usage} title={t('usageTokensTitle')}>
                {formatTokens(tokens)} tokens
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
      <MessageList
        session={session}
        streaming={streaming}
        onScrolledChange={onScrolledChange}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
