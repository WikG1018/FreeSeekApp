import { createContext, useContext, useLayoutEffect, useState, type MutableRefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'

type Action = () => void
type Leave = (action: Action) => void
export const SettingsLeaveContext = createContext<MutableRefObject<Leave | null> | null>(null)

/** 使用同一个确认处理返回、目录切换和编辑器内切换配置。 */
export const useSettingsLeave = (dirty: boolean) => {
  const t = useTranslate()
  const guard = useContext(SettingsLeaveContext)
  const [pending, setPending] = useState<Action | null>(null)
  const request = (action: Action) => {
    if (dirty) {
      setPending(() => action)
    } else {
      action()
    }
  }
  useLayoutEffect(() => {
    if (!guard || !dirty) {
      return
    }
    const confirm: Leave = (action) => setPending(() => action)
    guard.current = confirm
    return () => {
      if (guard.current === confirm) {
        guard.current = null
      }
    }
  }, [guard, dirty])
  const dialog = pending && (
    <Modal
      centered
      title={t('settingsDiscardTitle')}
      onClose={() => setPending(null)}
      footer={
        <>
          <Button variant="outlined" onClick={() => setPending(null)}>
            {t('settingsKeepEditing')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setPending(null)
              pending()
            }}
          >
            {t('settingsDiscard')}
          </Button>
        </>
      }
    />
  )
  return { request, dialog }
}
