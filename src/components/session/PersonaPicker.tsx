import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setDefaultPersona, usePersonas } from '../../services/personas.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './PersonaPicker.module.css'
import { showToast } from '../base/toastState.js'

/**
 * 人设选择：默认只显示当前人设的一行按钮，点击弹出选项栏（不再把人设平铺在首页）。
 * 选项栏用 Modal，移动端自动变成底部 Sheet。
 */
export const PersonaPicker = () => {
  const t = useTranslate()
  const personas = usePersonas((state) => state.personas)
  const defaultId = usePersonas((state) => state.defaultId)
  const [open, setOpen] = useState(false)
  const current = personas.find((persona) => persona.id === defaultId) ?? personas[0]

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className={styles.triggerLabel}>{t('personaRowLabel')}</span>
        <span className={styles.triggerValue}>{current?.name ?? t('personaDefaultName')}</span>
        <span className={styles.triggerChevron}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open ? (
        <Modal
          title={t('personaPickerTitle')}
          closable
          onClose={() => setOpen(false)}
          mainClassName={styles.sheetMain}
        >
          <div className={styles.list} role="radiogroup" aria-label={t('personaPickerTitle')}>
            {personas.map((persona) => {
              const selected = persona.id === defaultId
              return (
                <button
                  key={persona.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={clsx(styles.option, selected && styles.optionActive)}
                  onClick={() => {
                    try {
                      setDefaultPersona(persona.id)
                      setOpen(false)
                    } catch {
                      showToast({ key: 'personaSaveFailed', type: 'error' })
                    }
                  }}
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{persona.name}</span>
                    {persona.prompt ? (
                      <span className={styles.optionHint}>{persona.prompt.slice(0, 40)}…</span>
                    ) : (
                      <span className={styles.optionHint}>{t('personaDefaultHint')}</span>
                    )}
                  </span>
                  {selected ? (
                    <span className={styles.optionCheck}>
                      <IconCheckOutline16 />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className={styles.manage}
            onClick={() => {
              setOpen(false)
              openSettings('personas')
            }}
          >
            {t('personaManage')}
          </button>
        </Modal>
      ) : null}
    </>
  )
}
