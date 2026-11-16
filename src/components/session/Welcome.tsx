import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { cancelInherit, useChatStore } from '../../services/chat/store.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { IconCloseFill14 } from '../base/icons.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const inherit = useChatStore((state) => state.inheritFrom)
  const inheritRounds = inherit ? getContextRounds(inherit.messages).length : 0
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {inherit ? (
          <div className={styles.inheritChip}>
            <span className={styles.inheritText}>
              {t('inheritContextChip', {
                title: inherit.fromTitle || t('untitledChat'),
                rounds: inheritRounds,
              })}
            </span>
            <button
              type="button"
              className={styles.inheritRemove}
              aria-label={t('inheritContextRemove')}
              onClick={cancelInherit}
            >
              <IconCloseFill14 />
            </button>
          </div>
        ) : null}
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
