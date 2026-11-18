import { useId, useRef, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  openPayPage,
  PAY_CHANNELS,
  saveImageToGallery,
  type PayMethod,
} from '../../services/donate.js'
import { Modal } from '../base/Modal.js'
import { IconCheckOutline16, IconRightUpOutline14 } from '../base/icons.js'
import { SupportMark } from './SupportMark.js'
import styles from './DonateDialog.module.css'

const PaymentIcon = ({ method }: { method: PayMethod }) => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinejoin="round"
    strokeLinecap="round"
  >
    {method === 'wechat' ? (
      <>
        <path d="M13 15a8 8 0 0 1-5 .2L4.5 17l.7-3.1A6.2 6.2 0 0 1 3 9.5C3 5.9 6.5 3.4 10.4 3.4c4.1 0 7.4 2.5 7.4 6.1" />
        <path d="M20.1 17.9l.5 2.6-2.9-1.5a7.1 7.1 0 0 1-2 .3c-3.4 0-6.1-2.1-6.1-5s2.7-5 6.1-5 6.1 2.2 6.1 5a4.6 4.6 0 0 1-1.7 3.6Z" />
        <path d="M7.6 8.7h.1m4.3 0h.1m1.7 5.2h.1m3.6 0h.1" />
      </>
    ) : (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M3 9h18m-6 6h3" />
      </>
    )}
  </svg>
)

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
      <div className={styles.body} data-method={method}>
        <p className={styles.intro}>{t('donateIntro')}</p>
        <div
          className={styles.methods}
          role="radiogroup"
          aria-label={t('donateMethodLabel')}
          data-method={method}
        >
          {(['wechat', 'alipay'] as const).map((value) => (
            <label key={value} data-channel={value}>
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
              <span className={styles.channelFace}>
                <PaymentIcon method={value} />
                <span>{label(value)}</span>
                <span className={styles.channelCheck} aria-hidden="true">
                  {method === value && <IconCheckOutline16 />}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className={styles.qrStage}>
          <div className={styles.qrCard}>
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
          <span>{busy ? t('donateWorking') : t('donateSaveAndOpen', { app: label(method) })}</span>
          <span className={styles.payArrow} aria-hidden="true">
            <IconRightUpOutline14 />
          </span>
        </button>
      </div>
    </Modal>
  )
}
