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
import {
  IconAddOutline16,
  IconCheckOutline16,
  IconEditOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
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
      <label className={styles.field} htmlFor="persona-name">
        <span className={styles.fieldLabel}>{t('personaNameLabel')}</span>
        <input
          id="persona-name"
          className={styles.input}
          value={name}
          placeholder={t('personaNamePlaceholder')}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={styles.field} htmlFor="persona-prompt">
        <span className={styles.fieldLabel}>{t('personaPromptLabel')}</span>
        <textarea
          id="persona-prompt"
          className={styles.textarea}
          value={prompt}
          placeholder={t('personaPromptPlaceholder')}
          rows={9}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className={styles.editorActions}>
        <button type="button" className={styles.ghostButton} onClick={onDone}>
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

/** 人设库管理：顶部是显眼的新建入口，下面是人设卡片列表 */
export const PersonaManager = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const personas = usePersonas((state) => state.personas)
  const defaultId = usePersonas((state) => state.defaultId)
  const [editing, setEditing] = useState<Editing>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  return (
    <Modal
      title={editing ? (editing === 'new' ? t('personaAdd') : t('personaEditAction')) : t('personaManagerTitle')}
      closable
      onClose={editing ? () => setEditing(null) : onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      {editing !== null ? (
        <PersonaEditor persona={editing} onDone={() => setEditing(null)} />
      ) : (
        <>
          <button type="button" className={styles.addButton} onClick={() => setEditing('new')}>
            <span className={styles.addIcon}>
              <IconAddOutline16 />
            </span>
            {t('personaAdd')}
          </button>
          <p className={styles.hint}>{t('personaManagerHint')}</p>

          <div className={styles.list}>
            {personas.map((persona) => {
              const selected = persona.id === defaultId
              const builtin = isBuiltin(persona)
              return (
                <div
                  key={persona.id}
                  className={clsx(styles.item, selected && styles.itemActive)}
                >
                  <button
                    type="button"
                    className={styles.itemMain}
                    aria-pressed={selected}
                    onClick={() => setDefaultPersona(persona.id)}
                  >
                    <span className={styles.itemHeader}>
                      <span className={styles.itemName}>{persona.name}</span>
                      {selected ? (
                        <span className={styles.badgeActive}>
                          <IconCheckOutline16 />
                          {t('personaDefaultBadge')}
                        </span>
                      ) : null}
                      {builtin ? <span className={styles.badge}>{t('personaBuiltinBadge')}</span> : null}
                    </span>
                    <span className={styles.itemPrompt}>
                      {persona.prompt || t('personaDefaultPromptHint')}
                    </span>
                  </button>
                  {builtin ? null : (
                    <div className={styles.itemActions}>
                      <button
                        type="button"
                        className={styles.iconAction}
                        aria-label={t('personaEditAction')}
                        onClick={() => setEditing(persona)}
                      >
                        <IconEditOutline16 />
                      </button>
                      <button
                        type="button"
                        className={clsx(
                          styles.iconAction,
                          confirmDelete === persona.id && styles.iconActionDanger
                        )}
                        aria-label={
                          confirmDelete === persona.id ? t('personaDeleteConfirm') : t('delete')
                        }
                        onClick={() => {
                          if (confirmDelete === persona.id) {
                            removePersona(persona.id)
                            setConfirmDelete(null)
                          } else {
                            setConfirmDelete(persona.id)
                          }
                        }}
                      >
                        {confirmDelete === persona.id ? (
                          <span className={styles.deleteConfirmText}>{t('personaDeleteConfirm')}</span>
                        ) : (
                          <IconTrashOutline16 />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
