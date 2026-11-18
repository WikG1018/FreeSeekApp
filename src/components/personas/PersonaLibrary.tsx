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
import { Menu } from '../base/Menu.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useSettingsLeave } from '../settings/useSettingsLeave.js'
import { showToast } from '../base/toastState.js'
import {
  IconAddOutline16,
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconCopyOutline16,
  IconUploadOutline14,
  IconDownloadOutline16,
  IconSearchOutline16,
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
        <span className={styles.promptArea}>
          <textarea
            id="persona-prompt"
            className={styles.textarea}
            value={prompt}
            maxLength={100000}
            rows={1}
            placeholder={t('personaPromptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className={styles.promptMirror} aria-hidden="true">
            {prompt}
            {'\u200b'}
          </span>
        </span>
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
      <label className={styles.search}>
        <IconSearchOutline16 />
        <input
          type="search"
          aria-label={t('personaSearch')}
          placeholder={t('personaSearch')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className={styles.libraryTools}>
        <Button
          className={styles.toolButton}
          aria-label={t('personaAdd')}
          onClick={() => onEdit({ id: '', name: '', prompt: '' })}
        >
          <IconAddOutline16 />
          {t('personaNewShort')}
        </Button>
        <Button
          className={styles.toolButton}
          variant="outlined"
          aria-label={t('personaImport')}
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <IconUploadOutline14 />
          {t('personaImportShort')}
        </Button>
        <Button
          className={styles.toolButton}
          variant="outlined"
          aria-label={t('personaExport')}
          disabled={busy || !personas.some((p) => !isBuiltin(p))}
          onClick={() => void exportAll()}
        >
          <IconDownloadOutline16 />
          {t('personaExportShort')}
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
      {!visible.length && (
        <p role="status" className={styles.empty}>
          {t('personaEmptyResults')}
        </p>
      )}
      {([true, false] as const).map((builtin) => {
        const items = visible.filter((p) => isBuiltin(p) === builtin)
        if (!items.length) {
          return null
        }
        const heading = t(builtin ? 'personaBuiltinGroup' : 'personaCustomGroup')
        return (
          <section className={styles.group} key={heading} aria-label={heading}>
            <h2>{heading}</h2>
            <div className={styles.list}>
              {items.map((persona) => {
                const selected = persona.id === defaultId
                const applied = Boolean(
                  current &&
                  ((current.persona?.name === persona.name &&
                    current.persona?.prompt === persona.prompt) ||
                    (!current.persona && persona.id === 'builtin-default'))
                )
                return (
                  <div className={styles.item} key={persona.id} data-selected={selected}>
                    <button
                      type="button"
                      className={styles.itemMain}
                      aria-pressed={selected}
                      onClick={() => run(() => setDefaultPersona(persona.id))}
                    >
                      <span className={styles.itemHeader}>
                        <span className={styles.itemName}>{persona.name}</span>
                        {selected && (
                          <span className={styles.badge}>
                            <IconCheckOutline16 />
                            {t('personaDefaultBadge')}
                          </span>
                        )}
                      </span>
                      <span className={styles.itemPrompt}>
                        {persona.prompt
                          ? persona.prompt.slice(0, 240)
                          : t('personaDefaultPromptHint')}
                      </span>
                    </button>
                    <Menu
                      options={[
                        ...(activeId
                          ? [
                              {
                                key: 'apply',
                                label: t(applied ? 'providerActive' : 'personaApplyCurrent'),
                                icon: <IconCheckOutline16 />,
                                disabled: streaming || replacing || !current || applied,
                                onSelect: () => {
                                  if (
                                    setSessionPersona(
                                      activeId,
                                      persona.prompt
                                        ? { name: persona.name, prompt: persona.prompt }
                                        : null
                                    )
                                  ) {
                                    showToast({ key: 'personaApplied' })
                                  } else {
                                    showToast({ key: 'personaBusy' })
                                  }
                                },
                              },
                            ]
                          : []),
                        {
                          key: 'copy',
                          label: t('personaCopy'),
                          icon: <IconCopyOutline16 />,
                          onSelect: () =>
                            onEdit({
                              id: '',
                              name: t('personaCopyName', { name: persona.name }).slice(0, 80),
                              prompt: persona.prompt,
                            }),
                        },
                        ...(!builtin
                          ? [
                              {
                                key: 'edit',
                                label: t('personaEditAction'),
                                icon: <IconEditOutline16 />,
                                onSelect: () => onEdit(persona),
                              },
                              {
                                key: 'delete',
                                label: t('delete'),
                                icon: <IconTrashOutline16 />,
                                danger: true,
                                onSelect: () => setConfirmDelete(persona),
                              },
                            ]
                          : []),
                      ]}
                    >
                      {({ toggle, open }) => (
                        <IconButton
                          size="xl"
                          className={styles.more}
                          icon={<IconEllipsisOutline16 />}
                          aria-label={t('personaMore', { name: persona.name })}
                          aria-haspopup="menu"
                          aria-expanded={open}
                          onClick={toggle}
                        />
                      )}
                    </Menu>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
      <p className={styles.hint}>{t(activeId ? 'personaCurrentHint' : 'personaManagerHint')}</p>
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
