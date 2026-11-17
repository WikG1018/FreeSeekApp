import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { PersonaLibrary } from './PersonaLibrary.js'
import styles from './PersonaManager.module.css'
export { PersonaLibrary } from './PersonaLibrary.js'

export const PersonaManager = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('personaManagerTitle')}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <PersonaLibrary />
    </Modal>
  )
}
