import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { modelInputLabel } from '../../i18n/modelInputs.js'
import {
  AGENT_PROMPT_LIMIT,
  exportAssistantLibrary,
  importAssistantBackup,
  readAssistantBackup,
  refreshAssistantLibrary,
  removeAgent,
  saveAgent,
  setAutomaticMemory,
  useAssistantLibrary,
  usesAutomaticMemory,
  type AgentMemory,
  type AgentProfile,
  type MemoryNote,
} from '../../services/assistants/library.js'
import { migrateAutomaticSuggestions } from '../../services/assistants/automatic.js'
import { useChatStore } from '../../services/chat/store.js'
import { localizePersona, usePersonas } from '../../services/personas.js'
import {
  modelInputCapabilities,
  modelsInProfile,
  OFFICIAL_MODELS,
  providerModelLabel,
  useProviders,
} from '../../services/providers.js'
import { saveBackup } from '../../services/saveBackup.js'
import { setAskChatMode, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import {
  IconAddOutline16,
  IconLinkOutline14,
  IconPinOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { assistantErrorKey, openMemoryEditor } from './MemoryDialogs.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Row, Section, SwitchRow } from './SettingsRows.js'
import type { SettingsPageId } from './settingsDialogState.js'
import { useSettingsLeave } from './useSettingsLeave.js'
import styles from './AssistantSettings.module.css'

export const AssistantLibraryStatus = () => {
  const t = useTranslate()
  const failed = useAssistantLibrary((state) => state.failed)
  return (
    <div className={styles.stack} role="status">
      {t(failed ? 'assistantLibraryFailure' : 'assistantLibraryLoading')}
      {failed && (
        <Button variant="outlined" onClick={() => void refreshAssistantLibrary()}>
          {t('retry')}
        </Button>
      )}
    </div>
  )
}

export const AssistantSettingsPage = ({ open }: { open: (page: SettingsPageId) => void }) => {
  const t = useTranslate()
  const askMode = useSettings((state) => state.askChatMode)
  const { data, ready } = useAssistantLibrary()
  const toolCount = useSettings((state) => Object.values(state.agentTools).filter(Boolean).length)
  const [saving, setSaving] = useState(false)
  const [memoryError, setMemoryError] = useState<TranslationKey>()
  const [agentError, setAgentError] = useState(false)
  const reportMemoryError = (error: unknown) => setMemoryError(assistantErrorKey(error))
  if (!ready) {
    return <AssistantLibraryStatus />
  }
  const legacyMemory = data.automaticVersion !== 2 && (data.enabled || data.automatic)
  return (
    <>
      <Section title={t('assistantMemory')}>
        <SwitchRow
          label={t('assistantAutoSuggest')}
          description={t('assistantAutoSuggestHelp')}
          checked={usesAutomaticMemory(data) || (data.automaticVersion === 1 && data.automatic)}
          disabled={saving}
          change={(enabled) => {
            setMemoryError(undefined)
            setSaving(true)
            void setAutomaticMemory(enabled)
              .then(() => {
                if (enabled) {
                  void migrateAutomaticSuggestions().catch(reportMemoryError)
                }
              })
              .catch(reportMemoryError)
              .finally(() => setSaving(false))
          }}
        />
        {legacyMemory && <p className={styles.settingNote}>{t('assistantMemoryUpgrade')}</p>}
        {memoryError && (
          <p className={styles.settingError} role="alert">
            {t(memoryError)}
          </p>
        )}
        <Row
          label={t('assistantMemories')}
          value={t('assistantMemoryCount', { count: data.memories.length })}
          target="memories"
          onClick={() => open('memories')}
        />
        <Row
          label={t('assistantPendingMemories')}
          target="memorySuggestions"
          onClick={() => open('memorySuggestions')}
        />
        <Row
          label={t('assistantMemoryDetails')}
          target="memoryDetails"
          onClick={() => open('memoryDetails')}
        />
      </Section>
      {!isWindowsDesktop() && (
        <Section title="Agent">
          <SwitchRow
            label={t('assistantAskMode')}
            description={t('assistantAskModeHelp')}
            checked={askMode}
            change={(value) => setAgentError(!setAskChatMode(value))}
          />
          {agentError && (
            <p className={styles.settingError} role="alert">
              {t('assistantSaveFailed')}
            </p>
          )}
          <Row
            label={t('assistantAgents')}
            value={t('assistantAgentCount', { count: data.agents.length })}
            target="agents"
            onClick={() => open('agents')}
          />
          <Row
            label={t('assistantAgentGlobalTools')}
            value={t('assistantToolsEnabled', { count: toolCount })}
            target="agentTools"
            onClick={() => open('agentTools')}
          />
          <Row
            label={t('assistantAgentDetails')}
            target="agentDetails"
            onClick={() => open('agentDetails')}
          />
        </Section>
      )}
    </>
  )
}

export const MemoryDetailsPage = () => {
  const t = useTranslate()
  const { data, ready } = useAssistantLibrary()
  if (!ready) {
    return <AssistantLibraryStatus />
  }
  return (
    <>
      <Section title={t('assistantMemoryRecallDetails')}>
        <Row label={t('assistantPinnedMemories')} description={t('assistantMemoryPinnedHelp')} />
        <Row
          label={t('assistantMemoryRelatedTitle')}
          description={t('assistantMemoryRelatedHelp')}
        />
        <Row label={t('assistantMemoryPaused')} description={t('assistantMemoryPauseHelp')} />
      </Section>
      <Section>
        <Row
          label={t('assistantMaintenanceTitle')}
          description={t('assistantMaintenanceUsage', {
            requests: data.maintenance.requests,
            input: data.maintenance.input,
            output: data.maintenance.output,
          })}
        />
      </Section>
    </>
  )
}

type Backup = Awaited<ReturnType<typeof readAssistantBackup>>
const LibraryBackup = () => {
  const t = useTranslate()
  const picker = useRef<HTMLInputElement>(null)
  const [backup, setBackup] = useState<Backup>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey>()
  const handle = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (error) {
      setError(assistantErrorKey(error))
    } finally {
      setBusy(false)
    }
  }
  const importAll = (replace: boolean) => {
    if (!backup) {
      return
    }
    void handle(async () => {
      await importAssistantBackup(backup, replace)
      setBackup(undefined)
      showToast({ key: 'assistantBackupImported' })
    })
  }
  return (
    <SettingsDisclosure title={t('assistantBackup')}>
      <p className={styles.hint}>{t('assistantBackupHelp')}</p>
      <div className={styles.toolActions}>
        <Button variant="outlined" disabled={busy} onClick={() => picker.current?.click()}>
          {t('assistantBackupImport')}
        </Button>
        <Button
          variant="outlined"
          disabled={busy}
          onClick={() =>
            void handle(async () => {
              await saveBackup('freeseek-memory-agents.json', await exportAssistantLibrary())
            })
          }
        >
          {t('assistantBackupExport')}
        </Button>
      </div>
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            void handle(async () => setBackup(await readAssistantBackup(file)))
          }
        }}
      />
      {!backup && error && (
        <p className={styles.error + ' ' + styles.toolbarNote} role="alert">
          {t(error)}
        </p>
      )}
      {backup && (
        <Modal
          title={t('assistantBackupPreview')}
          dismissible={!busy}
          onClose={() => {
            setBackup(undefined)
            setError(undefined)
          }}
          footer={
            <div className={styles.actions}>
              <Button variant="outlined" disabled={busy} onClick={closeTopModal}>
                {t('cancel')}
              </Button>
              <Button variant="outlined" disabled={busy} onClick={() => importAll(true)}>
                {t('assistantReplaceMatches')}
              </Button>
              <Button disabled={busy} onClick={() => importAll(false)}>
                {t('assistantKeepLocal')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>
            {t('assistantMemoryCount', { count: backup.memories.length })} ·{' '}
            {t('assistantAgentCount', { count: backup.agents.length })}
          </p>
          <ul className={styles.noteList}>
            {backup.agents.map((agent) => (
              <li key={'agent-' + agent.id}>{agent.name}</li>
            ))}
            {backup.memories.map((note) => (
              <li key={note.id}>{note.text}</li>
            ))}
          </ul>
          {error && (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          )}
        </Modal>
      )}
    </SettingsDisclosure>
  )
}

export const MemoryListPage = () => {
  const t = useTranslate()
  const { ready, data } = useAssistantLibrary()
  const sessions = useChatStore((state) => state.sessions)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState(':all')
  const [limit, setLimit] = useState(48)
  const query = useDeferredValue(search).trim().normalize('NFKC').toLowerCase()
  const agentNames = useMemo(
    () => new Map(data.agents.map(({ id, name }) => [id, name])),
    [data.agents]
  )
  const titles = useMemo(
    () => new Map(sessions.map(({ id, title }) => [id, title || t('untitledChat')])),
    [sessions, t]
  )
  const formerAgent = data.memories.some(({ agentId }) => agentId && !agentNames.has(agentId))
  const visible = useMemo(
    () =>
      data.memories
        .filter(
          ({ agentId, text }) =>
            (scope === ':all' ||
              (scope === ':former'
                ? Boolean(agentId && !agentNames.has(agentId))
                : (agentId ?? '') === scope)) &&
            (!query || text.normalize('NFKC').toLowerCase().includes(query))
        )
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    [data.memories, scope, agentNames, query]
  )
  if (!ready) {
    return <AssistantLibraryStatus />
  }
  const subset = visible.slice(0, limit)
  const record = (note: MemoryNote) => {
    const sourceTitle = note.source && titles.get(note.source.sessionId)
    return (
      <button
        key={note.id}
        className={styles.record}
        type="button"
        onClick={() => openMemoryEditor(note, note)}
      >
        <span className={styles.recordText}>
          {note.pinned && (
            <span className={styles.memoryPin} aria-hidden="true">
              <IconPinOutline16 />
            </span>
          )}
          {note.text}
        </span>
        <span className={styles.recordMeta}>
          <span>
            {note.agentId
              ? (agentNames.get(note.agentId) ?? t('assistantFormerAgentMemories'))
              : t('assistantGlobal')}
          </span>
          {sourceTitle && (
            <span className={styles.recordSource}>
              <IconLinkOutline14 />
              {sourceTitle}
            </span>
          )}
          <span>{new Date(note.updatedAt).toLocaleDateString()}</span>
        </span>
      </button>
    )
  }
  const pinned = subset.filter((note) => note.pinned)
  const relevant = subset.filter((note) => !note.pinned)
  return (
    <div className={styles.stack}>
      <div className={styles.memoryTools}>
        {data.memories.length > 0 && (
          <label className={styles.memorySearch}>
            <IconSearchOutline16 />
            <input
              type="search"
              value={search}
              placeholder={t('assistantSearchMemories')}
              aria-label={t('assistantSearchMemories')}
              onChange={(event) => {
                setSearch(event.target.value)
                setLimit(48)
              }}
            />
          </label>
        )}
        <Button
          className={styles.memoryAdd}
          size="m"
          aria-label={t('assistantAddMemory')}
          onClick={() => openMemoryEditor()}
        >
          <IconAddOutline16 />
          <span>{t('assistantAddMemory')}</span>
        </Button>
      </div>
      {data.memories.length > 0 && (data.agents.length > 0 || formerAgent) && (
        <Select
          settingRow="value"
          ariaLabel={t('assistantMemoryScope')}
          value={scope}
          options={[
            { value: ':all', label: t('assistantAllScopes') },
            { value: '', label: t('assistantGlobal') },
            ...data.agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ...(formerAgent
              ? [{ value: ':former', label: t('assistantFormerAgentMemories') }]
              : []),
          ]}
          onChange={(value) => {
            setScope(value)
            setLimit(48)
          }}
        />
      )}
      {visible.length ? (
        <>
          {pinned.length > 0 && (
            <Section title={t('assistantPinnedMemories')}>{pinned.map(record)}</Section>
          )}
          {relevant.length > 0 && (
            <Section title={t('assistantRelevantMemories')}>{relevant.map(record)}</Section>
          )}
          {subset.length < visible.length && (
            <Button variant="outlined" onClick={() => setLimit(limit + 48)}>
              {t('assistantMoreMemories')}
            </Button>
          )}
        </>
      ) : (
        <p className={styles.hint} role="status">
          {t(data.memories.length ? 'assistantNoMatches' : 'assistantMemoryEmpty')}
        </p>
      )}
      <LibraryBackup />
    </div>
  )
}

export type AgentDraft = Omit<AgentProfile, 'id' | 'revision'>
export const emptyAgent = (): AgentDraft => ({
  name: '',
  prompt: '',
  model: null,
  memory: 'shared',
  search: false,
  attachments: true,
})

export const AgentListPage = ({
  edit,
}: {
  edit: (value: AgentDraft, previous?: AgentProfile) => void
}) => {
  const t = useTranslate()
  const { ready, data } = useAssistantLibrary()
  if (!ready) {
    return <AssistantLibraryStatus />
  }
  return (
    <div className={styles.stack}>
      {data.agents.length > 0 && (
        <Section>
          {data.agents.map((agent) => (
            <Row
              key={agent.id}
              label={agent.name}
              target="agentEdit"
              description={
                agent.model ? providerModelLabel(agent.model.model) : t('assistantFollowModel')
              }
              onClick={() => edit(agent, agent)}
            />
          ))}
        </Section>
      )}
      <Section title={t('assistantAgentTemplates')}>
        <Row
          label={t('assistantResearchName')}
          description={t('assistantResearchPrompt')}
          target="research"
          onClick={() =>
            edit({
              ...emptyAgent(),
              name: t('assistantResearchName'),
              prompt: t('assistantResearchPrompt'),
              search: true,
            })
          }
        />
        <Row
          label={t('assistantWritingName')}
          description={t('assistantWritingPrompt')}
          target="writing"
          onClick={() =>
            edit({
              ...emptyAgent(),
              name: t('assistantWritingName'),
              prompt: t('assistantWritingPrompt'),
            })
          }
        />
      </Section>
      <Button onClick={() => edit(emptyAgent())}>{t('assistantCreateAgent')}</Button>
    </div>
  )
}

export const AgentEditor = ({
  initial,
  previous,
  done,
}: {
  initial: AgentDraft
  previous?: AgentProfile
  done: () => void
}) => {
  const t = useTranslate()
  const [draft, setDraft] = useState(initial)
  const leave = useSettingsLeave(JSON.stringify(draft) !== JSON.stringify(initial))
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<TranslationKey>()
  const locale = useSettings((state) => state.locale)
  const personas = usePersonas((state) => state.personas)
  const state = useProviders()
  const selection = draft.model ?? state.selection
  const configured = state.profiles.find(({ id }) => id === selection.providerId)
  const profile = draft.model && configured
  const options = profile ? modelsInProfile(profile) : [...OFFICIAL_MODELS]
  const modelMissing =
    draft.model &&
    ((draft.model.providerId !== 'deepseek' && !profile) || !options.includes(draft.model.model))
  const inputs = modelInputCapabilities(selection.model, configured)
  const memoryModes: { value: AgentMemory; label: string }[] = [
    { value: 'shared', label: t('assistantShared') },
    { value: 'private', label: t('assistantPrivate') },
    { value: 'off', label: t('assistantDisabled') },
  ]
  const update = (values: Partial<AgentDraft>) => setDraft((old) => ({ ...old, ...values }))
  const finish = async (remove = false) => {
    setError(undefined)
    setBusy(true)
    try {
      if (remove && previous) {
        await removeAgent(previous)
      } else {
        await saveAgent(draft, previous)
      }
      done()
    } catch (error) {
      setError(assistantErrorKey(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.stack}>
      <Section>
        <label className={styles.field}>
          {t('assistantAgentName')}
          <input
            value={draft.name}
            maxLength={48}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          {t('assistantAgentPrompt')}
          <textarea
            className={styles.prompt}
            value={draft.prompt}
            maxLength={AGENT_PROMPT_LIMIT}
            onChange={(event) => update({ prompt: event.target.value })}
          />
        </label>
        {personas.some(({ prompt }) => prompt) && (
          <div className={styles.selector}>
            <Select
              settingRow="value"
              ariaLabel={t('assistantCopyPersona')}
              value=""
              options={personas
                .filter(({ prompt }) => prompt)
                .map((persona) => ({
                  value: persona.id,
                  label: localizePersona(persona, locale).name,
                }))}
              onChange={(id) => {
                const persona = personas.find((value) => value.id === id)
                if (persona) {
                  const { name, prompt } = localizePersona(persona, locale)
                  update({ name: draft.name || name, prompt: prompt.slice(0, AGENT_PROMPT_LIMIT) })
                }
              }}
            />
          </div>
        )}
      </Section>
      <Section>
        <div className={styles.selector}>
          <Select
            settingRow="value"
            ariaLabel={t('assistantAgentModel')}
            value={draft.model?.providerId ?? ''}
            options={[
              { value: '', label: t('assistantFollowModel') },
              { value: 'deepseek', label: 'DeepSeek' },
              ...state.profiles.map((item) => ({ value: item.id, label: item.name })),
            ]}
            onChange={(providerId) =>
              update({
                model: providerId
                  ? {
                      providerId,
                      model:
                        state.profiles.find((item) => item.id === providerId)?.model ??
                        OFFICIAL_MODELS[0],
                    }
                  : null,
              })
            }
          />
        </div>
        {draft.model && !modelMissing && (
          <div className={styles.selector}>
            <Select
              settingRow="value"
              ariaLabel={t('assistantAgentModelFixed')}
              value={draft.model.model}
              options={options.map((model) => ({
                value: model,
                label: providerModelLabel(model, profile || undefined),
              }))}
              onChange={(model) => {
                if (draft.model) {
                  update({ model: { providerId: draft.model.providerId, model } })
                }
              }}
            />
          </div>
        )}
        <Row
          label={providerModelLabel(selection.model, configured)}
          description={modelInputLabel(t, inputs)}
        />
        {modelMissing && (
          <p className={styles.error + ' ' + styles.toolbarNote} role="alert">
            {t('assistantAgentModelMissing')}
          </p>
        )}
      </Section>
      <Section title={t('assistantAgentTools')}>
        <SwitchRow
          label={t('assistantSearchPermission')}
          description={t('assistantSearchPermissionHelp')}
          checked={draft.search}
          change={(search) => update({ search })}
        />
        <SwitchRow
          label={t('assistantAttachmentPermission')}
          description={t('assistantAttachmentHelp')}
          checked={draft.attachments}
          change={(attachments) => update({ attachments })}
        />
      </Section>
      <Section>
        <div className={styles.selector}>
          <Select
            settingRow="value"
            ariaLabel={t('assistantAgentMemory')}
            value={draft.memory}
            options={memoryModes}
            onChange={(memory) => update({ memory })}
          />
        </div>
      </Section>
      <div className={styles.actions}>
        {previous && (
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
        <Button
          onClick={() => void finish()}
          disabled={busy || !draft.name.trim() || !draft.prompt.trim() || Boolean(modelMissing)}
        >
          {t('assistantSave')}
        </Button>
      </div>
      {!confirmDelete && error && (
        <p className={styles.error} role="alert">
          {t(error)}
        </p>
      )}
      {confirmDelete && (
        <Modal
          centered
          title={t('assistantDeleteAgent')}
          dismissible={!busy}
          onClose={() => setConfirmDelete(false)}
          footer={
            <div className={styles.actions}>
              <Button variant="outlined" disabled={busy} onClick={closeTopModal}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void finish(true)}>
                {t('delete')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>{t('assistantAgentDeleteHint')}</p>
          {error && (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          )}
        </Modal>
      )}
      {leave.dialog}
    </div>
  )
}
