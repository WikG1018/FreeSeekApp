import { useId, useRef, useEffect, useLayoutEffect, useState } from 'react'
import { App as NativeApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useTranslate } from '../../i18n/index.js'
import {
  openPayPage,
  PAY_CHANNELS,
  saveImageToGallery,
  type PayMethod,
} from '../../services/donate.js'
import { closeTopModal, Modal } from '../base/Modal.js'
import { IconCheckOutline16, IconRightUpOutline14 } from '../base/icons.js'
import { SupportMark, useDocumentVisible } from './SupportMark.js'
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

export const DonateDialog = ({
  onClose,
  onFullscreenChange,
}: {
  onClose: () => void
  onFullscreenChange: (fullscreen: boolean) => void
}) => {
  const t = useTranslate()
  const group = useId()
  const [method, setMethod] = useState<PayMethod>('wechat')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ saved: boolean; opened: boolean } | null>(null)
  const [returned, setReturned] = useState(false)
  const running = useRef(false)
  const active = useRef(true)
  const handoff = useRef<{ left: boolean; expiresAt: number } | null>(null)
  const thanksTitle = useRef<HTMLSpanElement>(null)
  const documentVisible = useDocumentVisible()
  const thanks = returned && done?.opened === true

  useEffect(() => {
    active.current = true
    const onAppState = (foreground: boolean) => {
      const attempt = handoff.current
      if (!attempt || !active.current) {
        return
      }
      if (!foreground && !attempt.left) {
        if (Date.now() <= attempt.expiresAt) {
          attempt.left = true
        } else {
          handoff.current = null
        }
      }
      if (foreground && attempt.left) {
        handoff.current = null
        setReturned(true)
      }
    }
    const onVisibility = () => onAppState(document.visibilityState === 'visible')
    const watchVisibility = () => {
      if (active.current) {
        document.addEventListener('visibilitychange', onVisibility)
      }
    }
    const subscription = Capacitor.isNativePlatform()
      ? NativeApp.addListener('appStateChange', ({ isActive }) => onAppState(isActive))
      : null
    if (subscription) {
      void subscription.catch(watchVisibility)
    } else {
      watchVisibility()
    }
    return () => {
      active.current = false
      handoff.current = null
      document.removeEventListener('visibilitychange', onVisibility)
      void subscription?.then((listener) => listener.remove()).catch(() => {})
    }
  }, [])
  useLayoutEffect(() => {
    onFullscreenChange(thanks)
    if (thanks) {
      thanksTitle.current?.focus({ preventScroll: true })
    }
  }, [thanks, onFullscreenChange])
  const channel = PAY_CHANNELS[method]
  const label = (value: PayMethod) => t(value === 'wechat' ? 'donateWechat' : 'donateAlipay')
  const pay = async () => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setDone(null)
    setReturned(false)
    handoff.current = null
    let saved = false,
      opened = false
    try {
      saved = await saveImageToGallery(channel.qr, 'freeseek-donate-' + method)
      if (active.current) {
        // A gallery permission dialog may interrupt saving. Only watch for departure after saving.
        handoff.current = { left: false, expiresAt: Date.now() + 10000 }
        opened = await openPayPage(method)
      }
    } catch {
      // Report the two operations independently if the system cannot open the payment app.
    } finally {
      running.current = false
      if (!opened) {
        handoff.current = null
      }
      if (active.current) {
        setDone({ saved, opened })
        setBusy(false)
      }
    }
  }

  return (
    <Modal
      title={
        thanks ? (
          <span className={styles.thanksHeading}>
            <span className={styles.thanksArt} aria-hidden="true">
              <span className={styles.thanksHeart}>
                <SupportMark animated={false} />
              </span>
            </span>
            <span ref={thanksTitle} tabIndex={-1} className={styles.thanksTitle}>
              {t('donateThanksTitle')}
            </span>
          </span>
        ) : (
          <span className={styles.heading}>
            <span className={styles.mark}>
              <SupportMark animated={documentVisible} />
            </span>
            {t('donateTitle')}
          </span>
        )
      }
      closable={!thanks}
      onDismissStart={() => {
        active.current = false
        handoff.current = null
      }}
      onClose={onClose}
      className={thanks ? styles.thanks : styles.sheet}
      mainClassName={thanks ? styles.thanksMain : undefined}
      footer={
        !thanks && (
          <button type="button" className={styles.pay} disabled={busy} onClick={() => void pay()}>
            <span>
              {busy ? t('donateWorking') : t('donateSaveAndOpen', { app: label(method) })}
            </span>
            <span className={styles.payArrow} aria-hidden="true">
              <IconRightUpOutline14 />
            </span>
          </button>
        )
      }
    >
      {thanks ? (
        <div className={styles.thanksMessage}>
          <p>{t('donateThanksBody')}</p>
          <button type="button" className={styles.thanksBack} onClick={() => closeTopModal()}>
            {t('donateThanksBack')}
          </button>
        </div>
      ) : (
        <div className={styles.body}>
          <p className={styles.intro}>{t('donateIntro')}</p>
          <div className={styles.methods} role="radiogroup" aria-label={t('donateMethodLabel')}>
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
                    setReturned(false)
                    handoff.current = null
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
          <div className={styles.note}>
            <p>{t('donateScanHint')}</p>
            <p>{t('donateFeedback')}</p>
          </div>
          {done && (
            <div className={styles.status} role="status">
              <span>{t(done.saved ? 'donateStepSaved' : 'donateStepSaveFailed')}</span>
              <span>
                {t(done.opened ? 'donateStepOpened' : 'donateStepOpenFailed', {
                  app: label(method),
                })}
              </span>
              {!done.opened && <span>{t('donateStepNext', { app: label(method) })}</span>}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
