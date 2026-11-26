import { Capacitor } from '@capacitor/core'
import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { openExternal } from '../../utils/openExternal.js'
import { Button } from '../base/Button.js'
import { IconRightUpOutline14 } from '../base/icons.js'
import { closeTopModal, Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './RoleVoiceIntro.module.css'

const sample = [
  ['roleVoiceNarrator', 'roleVoiceIntroNarration'],
  ['roleVoiceIntroLin', 'roleVoiceIntroLinLine'],
  ['roleVoiceIntroChuan', 'roleVoiceIntroChuanLine'],
] as const

export const RoleVoiceIntro = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const configure = useRef(false)
  const pricingUrl =
    locale === 'zh-CN'
      ? 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go'
      : 'https://mimo.mi.com/docs/price'

  return (
    <Modal
      centered
      className={styles.panel}
      title={
        <h2 className={styles.heading} tabIndex={-1} data-modal-initial-focus>
          {t('roleVoiceIntroTitle')}
        </h2>
      }
      onClose={() => {
        onDone()
        if (configure.current) {
          openSettings('chatSpeech')
        }
      }}
      footer={
        <div className={styles.actions}>
          <Button className={styles.action} variant="outlined" onClick={closeTopModal}>
            {t('roleVoiceIntroDone')}
          </Button>
          <Button
            className={styles.action}
            onClick={() => {
              configure.current = true
              closeTopModal()
            }}
          >
            {t('roleVoiceIntroSettings')}
          </Button>
        </div>
      }
    >
      <p className={styles.lead}>{t('roleVoiceIntroBody')}</p>
      <dl className={styles.dialogue}>
        {sample.map(([name, line]) => (
          <div className={styles.line} key={name}>
            <dt>
              <span className={styles.voice} aria-hidden>
                <span />
                <span />
                <span />
              </span>
              {t(name)}
            </dt>
            <dd>{t(line)}</dd>
          </div>
        ))}
      </dl>
      <h3 className={styles.free}>{t('roleVoiceIntroFree')}</h3>
      <p className={styles.setup}>{t('roleVoiceIntroSetup')}</p>
      <a
        className={styles.pricing}
        href={pricingUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (Capacitor.isNativePlatform()) {
            event.preventDefault()
            void openExternal(pricingUrl).catch(() => window.open(pricingUrl, '_blank', 'noopener'))
          }
        }}
      >
        {t('roleVoiceIntroPricing')}
        <IconRightUpOutline14 />
      </a>
    </Modal>
  )
}
