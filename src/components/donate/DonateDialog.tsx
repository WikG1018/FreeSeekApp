import { useId, useRef, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  openPayPage,
  PAY_CHANNELS,
  saveImageToGallery,
  type PayMethod,
} from '../../services/donate.js'
import { Modal } from '../base/Modal.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { SupportMark } from './SupportMark.js'
import styles from './DonateDialog.module.css'

export const DonateDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const group = useId()
  const [method, setMethod] = useState<PayMethod>('wechat')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ saved: boolean; opened: boolean } | null>(null)
  const running = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const channel = PAY_CHANNELS[method]
  const label = (value: PayMethod) => t(value === 'wechat' ? 'donateWechat' : 'donateAlipay')
  const pay = async () => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setDone(null)
    let saved = false,
      opened = false
    try {
      saved = await saveImageToGallery(channel.qr, 'freeseek-donate-' + method)
      if (active.current) {
        opened = await openPayPage(method)
      }
    } catch {
      // Report the two operations independently if the system cannot open the payment app.
    } finally {
      running.current = false
      if (active.current) {
        setDone({ saved, opened })
        setBusy(false)
      }
    }
  }
  return (
    <Modal
      title={
        <span className={styles.heading}>
          <span className={styles.mark}>
            <SupportMark />
          </span>
          {t('donateTitle')}
        </span>
      }
      closable
      onDismissStart={() => {
        active.current = false
      }}
      onClose={onClose}
      className={styles.sheet}
    >
      <div className={styles.body}>
        <p className={styles.intro}>{t('donateIntro')}</p>
        <div
          className={styles.methods}
          role="radiogroup"
          aria-label={t('donateMethodLabel')}
          data-method={method}
        >
          {(['wechat', 'alipay'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={group}
                checked={method === value}
                disabled={busy}
                onChange={() => {
                  setMethod(value)
                  setDone(null)
                }}
              />
              <span>
                {method === value && <IconCheckOutline16 />}
                {label(value)}
              </span>
            </label>
          ))}
        </div>
        <div className={styles.qrStage}>
          <img
            key={method}
            width={640}
            height={640}
            className={styles.qr}
            src={channel.qr}
            alt={t('donateQrAlt', { app: label(method) })}
            draggable={false}
          />
        </div>
        {done ? (
          <div className={styles.status} role="status">
            <span>{t(done.saved ? 'donateStepSaved' : 'donateStepSaveFailed')}</span>
            <span>{t(done.opened ? 'donateStepOpened' : 'donateStepOpenFailed')}</span>
            {done.saved && !done.opened && <span>{t('donateStepNext')}</span>}
          </div>
        ) : (
          <p className={styles.hint}>{t('donateScanHint')}</p>
        )}
        <button type="button" className={styles.pay} disabled={busy} onClick={() => void pay()}>
          {busy ? t('donateWorking') : t('donateSaveAndOpen', { app: label(method) })}
        </button>
      </div>
    </Modal>
  )
}
