import { useState } from 'react'
import logo from '../../assets/logo.png'
import { useTranslate } from '../../i18n/index.js'
import { markOnboardingSeen } from '../../services/onboarding.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './Onboarding.module.css'

/**
 * 首次使用引导：三步说明，主按钮直接跳到「API 服务」页绑 Key。
 * 只出现一次；点「先看看」或成功保存 Key 后不再出现。
 */
export const Onboarding = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate()
  const [closing, setClosing] = useState(false)

  const finish = () => {
    if (closing) {
      return
    }
    setClosing(true)
    markOnboardingSeen()
    onDone()
  }

  const bindKey = () => {
    markOnboardingSeen()
    onDone()
    openSettings('account')
  }

  return (
    <Modal title={t('onboardingTitle')} centered onClose={finish} footer={null}>
      <div className={styles.body}>
        <img className={styles.logo} src={logo} alt="" draggable={false} />
        <p className={styles.lead}>{t('onboardingLead')}</p>

        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepIndex}>1</span>
            <span className={styles.stepText}>
              <span className={styles.stepTitle}>{t('onboardingStep1Title')}</span>
              <span className={styles.stepBody}>{t('onboardingStep1Body')}</span>
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepIndex}>2</span>
            <span className={styles.stepText}>
              <span className={styles.stepTitle}>{t('onboardingStep2Title')}</span>
              <span className={styles.stepBody}>{t('onboardingStep2Body')}</span>
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepIndex}>3</span>
            <span className={styles.stepText}>
              <span className={styles.stepTitle}>{t('onboardingStep3Title')}</span>
              <span className={styles.stepBody}>{t('onboardingStep3Body')}</span>
            </span>
          </li>
        </ol>

        <button type="button" className={styles.primary} onClick={bindKey}>
          {t('onboardingBindKey')}
          <span className={styles.arrow}>
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button type="button" className={styles.ghost} onClick={finish}>
          {t('onboardingSkip')}
        </button>
        <p className={styles.footnote}>{t('onboardingFootnote')}</p>
      </div>
    </Modal>
  )
}
