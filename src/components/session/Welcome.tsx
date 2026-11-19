import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { cancelInherit, useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { IconCloseFill14 } from '../base/icons.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { MobileHeader } from './MobileHeader.js'
import { PersonaPicker } from './PersonaPicker.js'
import { WelcomeWhales } from './WelcomeWhales.js'
import styles from './Welcome.module.css'
import { useProviders } from '../../services/providers.js'

/** 新对话：品牌标识 + 问候语 + 人设选择（收起为一行，点开选项栏）+ 输入框 */
export const Welcome = ({ motionActive }: { motionActive: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const inherit = useChatStore((state) => state.inheritFrom)
  const inheritRounds = inherit ? getContextRounds(inherit.messages).length : 0
  const apiKey = useSettings((state) => state.apiKey)
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.brand}>
          <WelcomeWhales active={motionActive} />
          {apiKey || custom ? null : (
            <button
              type="button"
              className={styles.apiKeyCta}
              onClick={() => openSettings('account')}
            >
              {t('welcomeSetApiKey')}
            </button>
          )}
        </div>
        <PersonaPicker />
        {inherit ? (
          <div className={styles.inheritCard}>
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
        <div className={styles.inputArea}>
          <ChatInput sessionId={null} />
        </div>
      </div>
    </div>
  )
}
