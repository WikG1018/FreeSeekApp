import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  openPayPage,
  PAY_CHANNELS,
  saveImageToGallery,
  type PayMethod,
} from '../../services/donate.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './DonateDialog.module.css'

/**
 * 打赏开发者：选支付方式 → 存收款码到相册 → 直接唤起对应 App 的收款页。
 * 收款码已从带外框的宣传图里裁出，只留二维码本身（含必需的白边静区）。
 */
export const DonateDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [method, setMethod] = useState<PayMethod>('wechat')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ saved: boolean; opened: boolean } | null>(null)
  const channel = PAY_CHANNELS[method]

  const pay = async () => {
    setBusy(true)
    try {
      // 先存相册：拉起 App 会切走前台，回来再存就来不及了
      const saved = await saveImageToGallery(channel.qr, `freeseek-donate-${method}`)
      const opened = await openPayPage(method)
      setDone({ saved, opened })
      if (opened) {
        showToast({ key: 'donateOpenedTips' })
      } else if (saved) {
        showToast({ key: 'donateSavedOnly' })
      } else {
        showToast({ key: 'donateFallbackHint' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('donateTitle')} centered closable onClose={onClose}>
      <div className={styles.donate}>
        <p className={styles.donateIntro}>{t('donateIntro')}</p>

        <img
          className={styles.donateQr}
          src={channel.qr}
          alt={`${t('donateTitle')} ${channel.label}`}
          draggable={false}
        />

        <div className={styles.methodRow} role="radiogroup" aria-label={t('donateMethodLabel')}>
          {(['wechat', 'alipay'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={method === value}
              className={method === value ? styles.methodActive : styles.method}
              onClick={() => {
                setMethod(value)
                setDone(null)
              }}
            >
              {PAY_CHANNELS[value].label}
              {method === value ? (
                <span className={styles.methodCheck}>
                  <IconCheckOutline16 />
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <button type="button" className={styles.payButton} disabled={busy} onClick={() => void pay()}>
          {busy
            ? t('donateWorking')
            : t('donateSaveAndOpen', { app: channel.label })}
        </button>

        {done ? (
          <ul className={styles.stepList}>
            <li className={done.saved ? styles.stepOk : styles.stepPending}>
              {done.saved ? t('donateStepSaved') : t('donateStepSaveFailed')}
            </li>
            <li className={done.opened ? styles.stepOk : styles.stepPending}>
              {done.opened ? t('donateStepOpened') : t('donateStepOpenFailed')}
            </li>
            <li className={styles.stepNext}>{t('donateStepNext')}</li>
          </ul>
        ) : (
          <p className={styles.donateHint}>{t('donateScanHint')}</p>
        )}
      </div>
    </Modal>
  )
}
