import logo from '../../assets/logo.png'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  acceptUsageNotice,
  hasSeenOnboarding,
  markOnboardingSeen,
  type OnboardingStep,
} from '../../services/onboarding.js'
import { Button } from '../base/Button.js'
import { IconBookOutline16, IconChevronRightOutline14, IconUploadOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './Onboarding.module.css'

export const UsageNotice = () => {
  const t = useTranslate()
  return (
    <div className={styles.notice}>
      {(
        [
          ['noticeServiceTitle', 'noticeService'],
          ['noticeDataTitle', 'noticeData'],
          ['noticeCareTitle', 'noticeCare'],
        ] as const
      ).map(([title, body]) => (
        <section key={title}>
          <h3>{t(title)}</h3>
          <p>{t(body)}</p>
        </section>
      ))}
    </div>
  )
}

export const GettingStarted = ({ open }: { open: (page: 'account' | 'data') => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.choices}>
      {(
        [
          ['account', 'guideChat', 'guideChatBody', IconBookOutline16],
          ['data', 'guideImport', 'guideImportBody', IconUploadOutline14],
        ] as const
      ).map(([page, title, body, Icon]) => (
        <button type="button" className={styles.choice} key={page} onClick={() => open(page)}>
          <span className={styles.icon} aria-hidden>
            <Icon />
          </span>
          <span className={styles.words}>
            <strong>{t(title)}</strong>
            <span>{t(body)}</span>
          </span>
          <span className={styles.arrow} aria-hidden>
            <IconChevronRightOutline14 />
          </span>
        </button>
      ))}
    </div>
  )
}

export const Onboarding = ({
  initial,
  configured,
  onDone,
}: {
  initial: OnboardingStep
  configured: boolean
  onDone: () => void
}) => {
  const t = useTranslate()
  const [step, setStep] = useState(initial)
  const finish = () => {
    markOnboardingSeen()
    onDone()
  }
  if (step === 'notice') {
    const accept = () => {
      acceptUsageNotice()
      if (configured || hasSeenOnboarding()) {
        finish()
      } else {
        setStep('guide')
      }
    }
    return (
      <Modal
        key="notice"
        centered
        className={styles.panel}
        title={
          <span className={styles.heading} tabIndex={-1} data-modal-initial-focus>
            <img src={logo} alt="" />
            {t('noticeTitle')}
          </span>
        }
        dismissible={false}
        onClose={() => {}}
        footer={
          <Button block className={styles.primary} onClick={accept}>
            {t('noticeAccept')}
          </Button>
        }
      >
        <UsageNotice />
      </Modal>
    )
  }
  return (
    <Modal
      key="guide"
      className={styles.panel}
      title={
        <span className={styles.heading} tabIndex={-1} data-modal-initial-focus>
          {t('guideQuestion')}
        </span>
      }
      centered
      onClose={finish}
      footer={
        <Button block className={styles.skip} variant="outlined" onClick={finish}>
          {t('guideSkip')}
        </Button>
      }
    >
      <GettingStarted
        open={(page) => {
          finish()
          openSettings(page, { showTutorial: true })
        }}
      />
    </Modal>
  )
}
