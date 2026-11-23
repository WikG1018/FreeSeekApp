import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  AssistantLibraryError,
  MEMORY_TEXT_LIMIT,
  removeMemory,
  saveMemory,
  useAssistantLibrary,
  type MemoryNote,
} from '../../services/assistants/library.js'
import {
  relatedMemories,
  suggestMemoryNotes,
  useMemoryApprovals,
} from '../../services/assistants/memory.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconLinkOutline16 } from '../base/icons.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { closeSettings } from './settingsDialogState.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { SwitchRow } from './SettingsRows.js'
import styles from './AssistantSettings.module.css'

export const assistantErrorKey = (error: unknown): TranslationKey => {
  if (!(error instanceof AssistantLibraryError)) {
    return 'assistantSaveFailed'
  }
  const keys = {
    invalid: 'assistantInvalid',
    changed: 'assistantChanged',
    duplicate: 'assistantDuplicate',
    credential: 'assistantCredential',
    limit: 'assistantLimit',
  } as const
  return keys[error.reason]
}

type Draft = Pick<MemoryNote, 'text' | 'agentId' | 'source' | 'pinned'>
const useMemoryEditor = create(() => ({ entry: null as { draft: Draft; old?: MemoryNote } | null }))
export const openMemoryEditor = (draft: Partial<Draft> = {}, old?: MemoryNote) =>
  useMemoryEditor.setState({
    entry: { draft: { text: '', pinned: false, ...draft }, old },
  })
const closeEditor = () => useMemoryEditor.setState({ entry: null })

const MemoryEditor = ({ draft, old }: { draft: Draft; old?: MemoryNote }) => {
  const t = useTranslate()
  const agents = useAssistantLibrary((state) => state.data.agents)
  const memories = useAssistantLibrary((state) => state.data.memories)
  const input = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(draft.text.slice(0, MEMORY_TEXT_LIMIT))
  const [pinned, setPinned] = useState(draft.pinned)
  const [scope, setScope] = useState(draft.agentId ?? '')
  const [error, setError] = useState<TranslationKey>()
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [previous, setPrevious] = useState(old)
  const source = draft.source ?? previous?.source
  const sourceChat = useChatStore((state) =>
    state.sessions.find((session) => session.id === source?.sessionId)
  )
  const suggestions = useMemo(
    () => (!old && draft.source ? suggestMemoryNotes(draft.text) : []),
    [draft, old]
  )
  const deferred = useDeferredValue(text)
  const related = useMemo(
    () => (previous ? [] : relatedMemories(memories, deferred, scope)),
    [previous, memories, deferred, scope]
  )
  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await saveMemory({ text, pinned, agentId: scope || undefined, source }, previous)
      closeEditor()
      showToast({ key: previous ? 'assistantMemoryUpdated' : 'assistantMemorySaved' })
    } catch (error) {
      setError(assistantErrorKey(error))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!old) {
      return
    }
    setBusy(true)
    try {
      await removeMemory(old)
      closeEditor()
    } catch (error) {
      setError(assistantErrorKey(error))
    } finally {
      setBusy(false)
    }
  }
  if (confirmDelete) {
    return (
      <Modal
        centered
        title={t('assistantDeleteMemory')}
        onClose={() => setConfirmDelete(false)}
        dismissible={!busy}
        footer={
          <div className={styles.actions}>
            <Button variant="outlined" disabled={busy} onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('delete')}
            </Button>
          </div>
        }
      >
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
      </Modal>
    )
  }
  return (
    <Modal
      title={t(previous ? 'assistantEditMemory' : 'assistantAddMemory')}
      onClose={closeEditor}
      dismissible={!busy}
      footer={
        <div className={styles.actions}>
          {old && (
            <Button
              variant="dangerOutlined"
              disabled={busy}
              onClick={() => {
                setError(undefined)
                setConfirmDelete(true)
              }}
            >
              {t('delete')}
            </Button>
          )}
          <Button variant="outlined" disabled={busy} onClick={closeTopModal}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !text.trim()} onClick={() => void save()}>
            {t('assistantSave')}
          </Button>
        </div>
      }
    >
      {suggestions.length > 0 && (
        <SettingsDisclosure
          title={t('assistantMemorySuggestions')}
          description={t('assistantMemorySuggestionHelp')}
          defaultOpen
        >
          <div className={styles.memoryChoices}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={styles.memorySuggestion}
                aria-pressed={text === suggestion}
                disabled={busy}
                onClick={() => {
                  setText(suggestion)
                  setError(undefined)
                }}
              >
                <span>{suggestion}</span>
                {text === suggestion && <IconCheckOutline16 />}
              </button>
            ))}
          </div>
        </SettingsDisclosure>
      )}
      <label className={styles.field + ' ' + styles.editorText}>
        {t('assistantMemoryText')}
        <textarea
          ref={input}
          rows={4}
          maxLength={MEMORY_TEXT_LIMIT}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <span className={styles.hint}>
          {text.length} / {MEMORY_TEXT_LIMIT}
        </span>
      </label>
      <Select
        settingRow="value"
        ariaLabel={t('assistantMemoryScope')}
        value={scope}
        options={[
          { value: '', label: t('assistantGlobal') },
          ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
          ...(scope && !agents.some(({ id }) => id === scope)
            ? [{ value: scope, label: t('assistantPrivate') }]
            : []),
        ]}
        disabled={busy}
        onChange={setScope}
      />
      <SwitchRow label={t('assistantPinned')} checked={pinned} change={setPinned} />
      {previous && !old && (
        <div className={styles.replacement} aria-live="polite">
          <p className={styles.hint}>{t('assistantMemoryReplaceTarget')}</p>
          <p className={styles.recordText}>{previous.text}</p>
          <Button
            size="s"
            variant="outlined"
            disabled={busy}
            onClick={() => {
              setPrevious(undefined)
              setPinned(draft.pinned)
              setError(undefined)
            }}
          >
            {t('assistantMemorySaveNew')}
          </Button>
        </div>
      )}
      {related.length > 0 && (
        <SettingsDisclosure
          title={t('assistantMemoryRelated')}
          description={t('assistantRelatedMemories')}
          defaultOpen
        >
          <ul className={styles.relatedMemories}>
            {related.map((note) => (
              <li key={note.id}>
                <p className={styles.recordText}>{note.text}</p>
                <Button
                  size="s"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => {
                    setPrevious(note)
                    setPinned(note.pinned)
                    setError(undefined)
                    input.current?.focus({ preventScroll: true })
                  }}
                >
                  {t('assistantUpdateMemory')}
                </Button>
              </li>
            ))}
          </ul>
        </SettingsDisclosure>
      )}
      {source && (
        <div className={styles.memorySource}>
          {sourceChat ? (
            <button
              className={styles.sourceLink}
              type="button"
              disabled={busy}
              onClick={() => {
                closeEditor()
                closeSettings()
                selectSession(source.sessionId, source.messageId)
              }}
            >
              <IconLinkOutline16 />
              <span>
                {t('assistantSource')}
                <small>{sourceChat.title || t('untitledChat')}</small>
              </span>
            </button>
          ) : (
            <p className={styles.hint}>{t('assistantMemorySourceUnavailable')}</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
    </Modal>
  )
}

export const MemoryDialogs = () => {
  const t = useTranslate()
  const editor = useMemoryEditor((state) => state.entry)
  const approval = useMemoryApprovals((state) => state.pending[0])
  return (
    <>
      {editor && <MemoryEditor key={editor.old?.id ?? 'new'} {...editor} />}
      {approval && (
        <Modal
          key={approval.id}
          title={t('assistantMemoryPermission')}
          onClose={() => approval.resolve('skip')}
          footer={
            <div className={styles.approvalActions}>
              <Button
                className={styles.approvalPrimary}
                onClick={() => approval.resolve('conversation')}
              >
                {t('assistantAllowConversation')}
              </Button>
              <Button variant="outlined" onClick={() => approval.resolve('skip')}>
                {t('assistantSkipMemory')}
              </Button>
              <Button variant="outlined" onClick={() => approval.resolve('connection')}>
                {t('assistantAllowConnection')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>
            {t('assistantMemoryRecipient', { name: approval.connectionName })}
          </p>
          <ul className={styles.noteList}>
            {approval.notes.map(({ id, text, pinned }) => (
              <li key={id}>
                <p>{text}</p>
                <span className={styles.hint}>
                  {t(pinned ? 'assistantPinnedMemories' : 'assistantRelevantMemories')}
                </span>
              </li>
            ))}
          </ul>
          {approval.nativeWebTools && (
            <p className={styles.hint}>{t('assistantNativeSearchNotice')}</p>
          )}
        </Modal>
      )}
    </>
  )
}
