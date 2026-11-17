import clsx from 'clsx'
import { useDeferredValue, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addPersona,
  exportPersonas,
  importPersonas,
  isBuiltin,
  PersonaError,
  removePersona,
  setDefaultPersona,
  updatePersona,
  usePersonas,
  type Persona,
} from '../../services/personas.js'
import { setSessionPersona, useChatStore } from '../../services/chat/store.js'
import { saveBackup } from '../../services/saveBackup.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useSettingsLeave } from '../settings/useSettingsLeave.js'
import { showToast } from '../base/toastState.js'
import {
  IconAddOutline16,
  IconCheckOutline16,
  IconEditOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import styles from './PersonaManager.module.css'

const report = (error: unknown) =>
  showToast({
    key:
      error instanceof PersonaError && error.reason === 'invalid'
        ? 'personaInvalid'
        : 'personaSaveFailed',
    type: 'error',
  })
export const PersonaEditor = ({ persona, onDone }: { persona: Persona; onDone: () => void }) => {
  const t = useTranslate(),
    [name, setName] = useState(persona.name),
    [prompt, setPrompt] = useState(persona.prompt)
  const dirty = name !== persona.name || prompt !== persona.prompt
  const leave = useSettingsLeave(dirty)
  const cancel = () => leave.request(onDone)
  const save = () => {
    try {
      if (persona.id) {
        updatePersona(persona.id, name, prompt)
      } else {
        addPersona(name, prompt)
      }
      onDone()
    } catch (error) {
      report(error)
    }
  }
  return (
    <div className={styles.editor}>
      <label className={styles.field} htmlFor="persona-name">
        <span className={styles.fieldLabel}>{t('personaNameLabel')}</span>
        <input
          id="persona-name"
          className={styles.input}
          value={name}
          maxLength={80}
          autoFocus
          placeholder={t('personaNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={styles.field} htmlFor="persona-prompt">
        <span className={styles.fieldLabel}>{t('personaPromptLabel')}</span>
        <textarea
          id="persona-prompt"
          className={styles.textarea}
          value={prompt}
          maxLength={100000}
          rows={9}
          placeholder={t('personaPromptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <p className={styles.hint}>
        {t('personaLimits')} · {prompt.length.toLocaleString()}
      </p>
      <div className={styles.editorActions}>
        <Button variant="outlined" onClick={cancel}>
          {t('cancel')}
        </Button>
        <Button disabled={!name.trim()} onClick={save}>
          {t('personaSave')}
        </Button>
      </div>
      {leave.dialog}
    </div>
  )
}

export const PersonaLibrary = ({ onEdit }: { onEdit: (persona: Persona) => void }) => {
  const t = useTranslate(),
    { personas, defaultId } = usePersonas()
  const [confirmDelete, setConfirmDelete] = useState<Persona | null>(null)
  const [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false)
  const query = useDeferredValue(search.trim().toLocaleLowerCase()),
    picker = useRef<HTMLInputElement>(null),
    importing = useRef(false)
  const activeId = useChatStore((state) => state.activeId),
    replacing = useChatStore((state) => state.importingHistory)
  const streaming = useChatStore((state) => (activeId ? Boolean(state.streaming[activeId]) : false))
  const current = useChatStore((state) => (activeId ? state.sessionCache[activeId] : undefined))
  const visible = personas.filter(
    (p) =>
      !query ||
      p.name.toLocaleLowerCase().includes(query) ||
      p.prompt.toLocaleLowerCase().includes(query)
  )
  const run = (action: () => void) => {
    try {
      action()
    } catch (error) {
      report(error)
    }
  }
  const exportAll = async () => {
    const pack = exportPersonas()
    if (!pack) {
      showToast({ key: 'personaExportEmpty' })
      return
    }
    setBusy(true)
    try {
      await saveBackup(pack.name, pack.blob)
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.library}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('personaSearch')}</span>
        <input
          type="search"
          className={styles.input}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className={styles.libraryTools}>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => onEdit({ id: '', name: '', prompt: '' })}
        >
          <span className={styles.addIcon}>
            <IconAddOutline16 />
          </span>
          {t('personaAdd')}
        </button>

        <Button variant="outlined" size="s" disabled={busy} onClick={() => picker.current?.click()}>
          {t('personaImport')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={busy || !personas.some((persona) => !isBuiltin(persona))}
          onClick={() => void exportAll()}
        >
          {t('personaExport')}
        </Button>
      </div>
      <input
        ref={picker}
        type="file"
        accept=".json,.txt,.md,.markdown"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file || importing.current) {
            return
          }
          importing.current = true
          setBusy(true)
          void importPersonas(file)
            .then((count) => showToast({ key: 'personaImported', params: { count } }))
            .catch(report)
            .finally(() => {
              importing.current = false
              setBusy(false)
            })
        }}
      />
      <p className={styles.hint}>{t('personaImportHint')}</p>
      {activeId ? (
        <p className={styles.hint}>{t('personaCurrentHint')}</p>
      ) : (
        <p className={styles.hint}>{t('personaManagerHint')}</p>
      )}
      <div className={styles.list}>
        {!visible.length ? <p className={styles.hint}>{t('personaEmptyResults')}</p> : null}
        {visible.map((persona) => {
          const selected = persona.id === defaultId,
            builtin = isBuiltin(persona)
          const applied = Boolean(
            current &&
            ((current.persona?.name === persona.name &&
              current.persona?.prompt === persona.prompt) ||
              (!current.persona && persona.id === 'builtin-default'))
          )
          return (
            <div key={persona.id} className={clsx(styles.item, selected && styles.itemActive)}>
              <button
                type="button"
                className={styles.itemMain}
                aria-pressed={selected}
                onClick={() => run(() => setDefaultPersona(persona.id))}
              >
                <span className={styles.itemHeader}>
                  <span className={styles.itemName}>{persona.name}</span>
                  {selected ? (
                    <span className={styles.badgeActive}>
                      <IconCheckOutline16 />
                      {t('personaDefaultBadge')}
                    </span>
                  ) : null}
                  {builtin ? (
                    <span className={styles.badge}>{t('personaBuiltinBadge')}</span>
                  ) : null}
                </span>
                <span className={styles.itemPrompt}>
                  {persona.prompt ? persona.prompt.slice(0, 240) : t('personaDefaultPromptHint')}
                </span>
              </button>
              <div className={styles.libraryActions}>
                <button
                  type="button"
                  onClick={() =>
                    onEdit({
                      id: '',
                      name: t('personaCopyName', { name: persona.name }).slice(0, 80),
                      prompt: persona.prompt,
                    })
                  }
                >
                  {t('personaCopy')}
                </button>
                {activeId ? (
                  <button
                    type="button"
                    disabled={streaming || replacing || !current || applied}
                    onClick={() => {
                      if (
                        setSessionPersona(
                          activeId,
                          persona.prompt ? { name: persona.name, prompt: persona.prompt } : null
                        )
                      ) {
                        showToast({ key: 'personaApplied' })
                      } else {
                        showToast({ key: 'personaBusy' })
                      }
                    }}
                  >
                    {t(applied ? 'providerActive' : 'personaApplyCurrent')}
                  </button>
                ) : null}
                {!builtin ? (
                  <>
                    <button
                      type="button"
                      aria-label={t('personaEditAction')}
                      onClick={() => onEdit(persona)}
                    >
                      <IconEditOutline16 />
                    </button>
                    <button
                      type="button"
                      aria-label={t('delete')}
                      onClick={() => setConfirmDelete(persona)}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {confirmDelete ? (
        <Modal
          title={t('personaDeleteConfirm')}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setConfirmDelete(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  run(() => {
                    removePersona(confirmDelete.id)
                    setConfirmDelete(null)
                  })
                }
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <p>{confirmDelete.name}</p>
        </Modal>
      ) : null}
    </div>
  )
}
