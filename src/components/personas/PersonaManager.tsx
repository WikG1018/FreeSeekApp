import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addPersona,
  isBuiltin,
  removePersona,
  setDefaultPersona,
  updatePersona,
  usePersonas,
  type Persona,
} from '../../services/personas.js'
import { Modal } from '../base/Modal.js'
import styles from './PersonaManager.module.css'

/** 编辑中的条目：'new' 表示新建，null 表示显示列表 */
type Editing = Persona | 'new' | null

const PersonaEditor = ({ persona, onDone }: { persona: 'new' | Persona; onDone: () => void }) => {
  const t = useTranslate()
  const existing = persona === 'new' ? null : persona
  const [name, setName] = useState(existing?.name ?? '')
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const valid = name.trim() !== ''
  const save = () => {
    if (!valid) {
      return
    }
    if (existing) {
      updatePersona(existing.id, name, prompt)
    } else {
      addPersona(name, prompt)
    }
    onDone()
  }
  return (
    <div className={styles.editor}>
      <label className={styles.fieldLabel} htmlFor="persona-name">
        {t('personaNameLabel')}
      </label>
      <input
        id="persona-name"
        className={styles.input}
        value={name}
        placeholder={t('personaNamePlaceholder')}
        onChange={(event) => setName(event.target.value)}
      />
      <label className={styles.fieldLabel} htmlFor="persona-prompt">
        {t('personaPromptLabel')}
      </label>
      <textarea
        id="persona-prompt"
        className={styles.textarea}
        value={prompt}
        placeholder={t('personaPromptPlaceholder')}
        rows={8}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className={styles.editorActions}>
        <button type="button" className={styles.secondaryButton} onClick={onDone}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!valid}
          onClick={save}
        >
          {t('personaSave')}
        </button>
      </div>
    </div>
  )
}

/** 人设库管理：查看、新建、编辑、删除与设置默认 */
export const PersonaManager = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const personas = usePersonas((state) => state.personas)
  const defaultId = usePersonas((state) => state.defaultId)
  const [editing, setEditing] = useState<Editing>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  return (
    <Modal title={t('personaManagerTitle')} closable onClose={onClose} className={styles.dialog}>
      {editing !== null ? (
        <PersonaEditor persona={editing} onDone={() => setEditing(null)} />
      ) : (
        <div className={styles.list}>
          <div className={styles.hint}>{t('personaManagerHint')}</div>
          {personas.map((persona) => (
            <div
              key={persona.id}
              className={clsx(styles.item, persona.id === defaultId && styles.itemActive)}
            >
              <div className={styles.itemMain}>
                <div className={styles.itemName}>
                  {persona.name}
                  {persona.id === defaultId ? (
                    <span className={styles.badge}>{t('personaDefaultBadge')}</span>
                  ) : null}
                </div>
                <div className={styles.itemPrompt}>
                  {persona.prompt || t('personaDefaultPromptHint')}
                </div>
              </div>
              <div className={styles.itemActions}>
                {persona.id !== defaultId ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => setDefaultPersona(persona.id)}
                  >
                    {t('personaSetDefault')}
                  </button>
                ) : null}
                {!isBuiltin(persona) ? (
                  <>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setEditing(persona)}
                    >
                      {t('personaEditAction')}
                    </button>
                    <button
                      type="button"
                      className={clsx(styles.secondaryButton, styles.dangerButton)}
                      onClick={() => {
                        if (confirmDelete === persona.id) {
                          removePersona(persona.id)
                          setConfirmDelete(null)
                        } else {
                          setConfirmDelete(persona.id)
                        }
                      }}
                    >
                      {confirmDelete === persona.id ? t('personaDeleteConfirm') : t('delete')}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
          <button
            type="button"
            className={clsx(styles.secondaryButton, styles.addButton)}
            onClick={() => setEditing('new')}
          >
            {t('personaAdd')}
          </button>
        </div>
      )}
    </Modal>
  )
}
