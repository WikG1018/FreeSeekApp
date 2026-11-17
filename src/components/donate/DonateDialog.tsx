import { useTranslate } from '../../i18n/index.js'
import donateQr from '../../assets/donate-qr.png'
import { Modal } from '../base/Modal.js'
import styles from './DonateDialog.module.css'

/**
 * 打赏开发者：收款二维码弹窗。
 * 二维码是普通静态资源——替换 src/assets/donate-qr.png 即可换成自己的收款码。
 */
export const DonateDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal title={t('donateTitle')} centered closable onClose={onClose}>
      <div className={styles.donate}>
        <p className={styles.donateIntro}>{t('donateIntro')}</p>
        <img className={styles.donateQr} src={donateQr} alt={t('donateTitle')} draggable={false} />
        <p className={styles.donateHint}>{t('donateScanHint')}</p>
      </div>
    </Modal>
  )
}
