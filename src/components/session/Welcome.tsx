import clsx from 'clsx'
import { useState } from 'react'
import logo from '../../assets/logo.png'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { cancelInherit, useChatStore } from '../../services/chat/store.js'
import { setDefaultPersona, usePersonas } from '../../services/personas.js'
import { useSettings } from '../../services/settings.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { IconCloseFill14 } from '../base/icons.js'
import { PersonaManager } from '../personas/PersonaManager.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：品牌标识 + 问候语 + 人设选择 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const inherit = useChatStore((state) => state.inheritFrom)
  const inheritRounds = inherit ? getContextRounds(inherit.messages).length : 0
  const personas = usePersonas((state) => state.personas)
  const defaultPersonaId = usePersonas((state) => state.defaultId)
  const apiKey = useSettings((state) => state.apiKey)
  const [managerOpen, setManagerOpen] = useState(false)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.brand}>
          <img className={styles.logo} src={logo} alt="" draggable={false} />
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        </div>
        <div className={styles.personaScroll}>
          <div className={styles.personaRow} role="group" aria-label={t('personaRowLabel')}>
            {personas.map((persona) => (
              <button
                key={persona.id}
                type="button"
                className={clsx(
                  styles.personaChip,
                  persona.id === defaultPersonaId && styles.personaChipActive
                )}
                onClick={() => setDefaultPersona(persona.id)}
              >
                {persona.name}
              </button>
            ))}
            <button
              type="button"
              className={clsx(styles.personaChip, styles.personaManage)}
              onClick={() => setManagerOpen(true)}
            >
              {t('personaManage')}
            </button>
          </div>
        </div>
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
          {apiKey ? null : (
            <button
              type="button"
              className={styles.apiKeyCta}
              onClick={() => openSettings('account')}
            >
              {t('welcomeSetApiKey')}
            </button>
          )}
          <ChatInput sessionId={null} />
        </div>
      </div>
      {managerOpen ? <PersonaManager onClose={() => setManagerOpen(false)} /> : null}
    </div>
  )
}
