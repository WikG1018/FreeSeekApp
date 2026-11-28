import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { branchConversation, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ReplyBranchDialog.module.css'

export const ReplyBranchDialog = ({
  sessionId,
  messageId,
  onClose,
}: {
  sessionId: string
  messageId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const description = useId()
  const sourceActive = useChatStore((state) => state.activeId === sessionId)
  const [state, setState] = useState<'ready' | 'saving' | 'failed'>('ready')
  const actionInProgress = useRef(false)
  const saving = state === 'saving'

  useEffect(() => {
    if (!sourceActive && !actionInProgress.current) {
      onClose()
    }
  }, [onClose, sourceActive])

  const confirm = async (close: () => void) => {
    if (actionInProgress.current || !sourceActive) {
      return
    }
    actionInProgress.current = true
    setState('saving')
    const result = await branchConversation(sessionId, messageId)
    if (!result) {
      actionInProgress.current = false
      if (useChatStore.getState().activeId === sessionId) {
        setState('failed')
      } else {
        onClose()
      }
      return
    }
    if (result.missingOriginals > 0) {
      showToast({ key: 'branchMissingOriginals', params: { count: result.missingOriginals } })
    } else if (!result.opened) {
      showToast({ key: 'branchCreated' })
    }
    close()
  }

  return (
    <Modal
      title={t('branchConfirmTitle')}
      ariaDescribedBy={description}
      centered
      motion="fade"
      dismissible={!saving}
      onDismissStart={() => {
        actionInProgress.current = true
      }}
      onClose={onClose}
      footer={(close) => (
        <>
          <Button
            variant="outlined"
            disabled={saving}
            onClick={() => {
              if (!actionInProgress.current) {
                close()
              }
            }}
          >
            {t('cancel')}
          </Button>
          <Button
            className={styles.confirm}
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={() => void confirm(close)}
          >
            <span aria-hidden={saving}>{t('branchConfirmAction')}</span>
            <span aria-hidden={!saving}>{t('branchSaving')}</span>
          </Button>
        </>
      )}
    >
      <div id={description}>
        <div>{t('branchConfirmCarryOver')}</div>
        <div>{t('branchConfirmSeparate')}</div>
      </div>
      {state === 'failed' && (
        <p className={styles.error} role="alert">
          {t('branchCreateFailed')}
        </p>
      )}
    </Modal>
  )
}
