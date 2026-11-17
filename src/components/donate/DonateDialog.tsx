import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { openPayApp, saveImageToGallery, type PayApp } from '../../services/donate.js'
import donateQr from '../../assets/donate-qr.png'
import { IconCheckOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './DonateDialog.module.css'

/**
 * 打赏开发者：选支付方式 → 存收款码到相册 → 自动拉起对应 App。
 *
 * 说明：个人收款码没有「带金额跳转」的官方能力（那是商户接口），
 * 所以这里做能做的最大化：一键存图 + 一键跳 App，用户回 App 里从相册选码付款。
 * 二维码是普通静态资源——替换 src/assets/donate-qr.png 即可换成自己的收款码。
 */
export const DonateDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [method, setMethod] = useState<PayApp>('alipay')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ saved: boolean; opened: boolean } | null>(null)

  const pay = async () => {
    setBusy(true)
    try {
      // 先存相册：拉 App 会切走前台，返回后再想存图就来不及了
      const saved = await saveImageToGallery(donateQr, `freeseek-donate-${method}`)
      const opened = await openPayApp(method)
      setDone({ saved, opened })
      if (saved && opened) {
        showToast({ key: 'donateReady' })
      } else if (saved) {
        showToast({ key: 'donateSavedOnly' })
      } else if (opened) {
        showToast({ key: 'donateOpenedOnly' })
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

        <img className={styles.donateQr} src={donateQr} alt={t('donateTitle')} draggable={false} />

        <div className={styles.methodRow} role="radiogroup" aria-label={t('donateMethodLabel')}>
          {(['alipay', 'wechat'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={method === value}
              className={method === value ? styles.methodActive : styles.method}
              onClick={() => setMethod(value)}
            >
              {value === 'alipay' ? '支付宝' : '微信'}
              {method === value ? (
                <span className={styles.methodCheck}>
                  <IconCheckOutline16 />
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <button type="button" className={styles.payButton} disabled={busy} onClick={() => void pay()}>
          {busy ? t('donateWorking') : t('donateSaveAndOpen', { app: method === 'alipay' ? '支付宝' : '微信' })}
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
