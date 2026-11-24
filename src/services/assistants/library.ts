import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'
import { useProviders, validModel, type ModelSelection } from '../providers.js'
import { thirdPartySearchKey, useSettings } from '../settings.js'
import { automaticPreference, type AutoPreference } from './automaticRules.js'

export const MEMORY_TEXT_LIMIT = 400
export const AGENT_PROMPT_LIMIT = 6000
const MEMORY_LIMIT = 600
const ACTIVITY_LIMIT = 120
const AGENT_LIMIT = 64
const BACKUP_LIMIT = 4 * 1024 * 1024

export type AgentRef = { id: string; name: string }
export type AgentMemory = 'shared' | 'private' | 'off'
export type AgentProfile = AgentRef & {
  revision: string
  prompt: string
  model: ModelSelection | null
  search: boolean
  attachments: boolean
  memory: AgentMemory
}
export type MemoryNote = {
  id: string
  revision: string
  text: string
  agentId?: string
  pinned: boolean
  source?: { sessionId: string; messageId: string }
  updatedAt: number
  topic?: string
  observedAt?: number
}
export type MemoryGrant = { connection: string; name: string; sessionId?: string }
export type MemorySuggestion = {
  id: string
  text: string
  agentId?: string
  source: NonNullable<MemoryNote['source']>
  round: number
  original?: Pick<MemoryNote, 'id' | 'revision' | 'text'>
}
export type MemoryOrigin = {
  source: NonNullable<MemoryNote['source']>
  round: number
  agentId?: string
  observedAt: number
  legacyId?: string
}
export type MemoryActivity = {
  id: string
  current: MemoryNote
  prior?: MemoryNote
  round: number
  undone?: boolean
}
export type MemoryMaintenance = {
  requests: number
  input: number
  output: number
  lastAt?: number
  recent?: string[]
}
type Library = {
  enabled: boolean
  automatic: boolean
  automaticVersion?: 1 | 2
  memories: MemoryNote[]
  suggestions: MemorySuggestion[]
  activity: MemoryActivity[]
  forgotten: { key: string; observedAt: number }[]
  maintenance: MemoryMaintenance
  agents: AgentProfile[]
  grants: MemoryGrant[]
}
type Backup = Pick<Library, 'memories' | 'agents'>

interface AssistantDB extends DBSchema {
  state: { key: 'library'; value: Library }
}

const empty: Library = {
  enabled: false,
  automatic: false,
  memories: [],
  suggestions: [],
  activity: [],
  forgotten: [],
  maintenance: { requests: 0, input: 0, output: 0 },
  agents: [],
  grants: [],
}
const withDefaults = (stored: Library | undefined): Library =>
  stored
    ? {
        ...empty,
        ...stored,
        enabled: stored.enabled === true,
        automatic:
          (stored.automaticVersion === 1 || stored.automaticVersion === 2) &&
          stored.automatic === true,
      }
    : empty
export const useAssistantLibrary = create(() => ({
  data: empty,
  ready: false,
  failed: false,
}))

let database: Promise<IDBPDatabase<AssistantDB>> | undefined
let updates: BroadcastChannel | undefined
const open = () =>
  (database ??= openDB<AssistantDB>('freeseek-assistants', 1, {
    upgrade: (db) => db.createObjectStore('state'),
    blocking: () => {
      void database?.then(
        (db) => db.close(),
        () => {}
      )
      database = undefined
    },
  }).catch((error: unknown) => {
    database = undefined
    throw error
  }))

export const readAssistantLibrary = async (): Promise<Library> => {
  const data = withDefaults(await (await open()).get('state', 'library'))
  useAssistantLibrary.setState({ data, ready: true, failed: false })
  return data
}

export const refreshAssistantLibrary = async () => {
  try {
    await readAssistantLibrary()
    if (!updates && typeof BroadcastChannel === 'function') {
      updates = new BroadcastChannel('freeseek-assistants')
      updates.onmessage = () => void refreshAssistantLibrary()
    }
  } catch (error) {
    useAssistantLibrary.setState({ failed: true })
    logEvent('storage', 'assistant-library.read-failed', diagnosticError(error), 'warn')
  }
}

const change = async (update: (current: Library) => Library) => {
  const db = await open()
  const tx = db.transaction('state', 'readwrite')
  const current = withDefaults(await tx.store.get('library'))
  const next = update(current)
  if (next === current) {
    await tx.done
    return
  }
  await tx.store.put(next, 'library')
  await tx.done
  useAssistantLibrary.setState({ data: next, ready: true, failed: false })
  updates?.postMessage('updated')
}

export class AssistantLibraryError extends Error {
  constructor(readonly reason: 'invalid' | 'duplicate' | 'changed' | 'limit' | 'credential') {
    super(reason)
    this.name = 'AssistantLibraryError'
  }
}

export const containsCredential = (text: string) => {
  if (
    /\b(?:sk[-_]|gh[pousr]_|github_pat_)[a-z0-9_-]{16,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[a-z0-9._~+/-]{16,}/i.test(
      text
    )
  ) {
    return true
  }
  const settings = useSettings.getState()
  const keys = [
    settings.apiKey,
    thirdPartySearchKey(settings),
    ...useProviders.getState().profiles.flatMap((profile) => [
      profile.apiKey,
      ...Object.entries(profile.headers)
        .filter(([name]) => /authorization|key|token|secret/i.test(name))
        .map(([, value]) => value),
    ]),
  ]
  return keys.some((key) => key && key.length >= 8 && text.includes(key))
}

const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const normalized = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const memoryKey = (note: Pick<MemoryNote, 'agentId' | 'text'>) =>
  (note.agentId ?? '') + '\0' + normalized(note.text)

const textField = (value: unknown, limit: number) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > limit) {
    throw new AssistantLibraryError('invalid')
  }
  if (containsCredential(text)) {
    throw new AssistantLibraryError('credential')
  }
  return text
}

const readAgent = (value: unknown): AgentProfile => {
  const input = object(value)
  const model = object(input.model)
  if (
    !identity(input.id) ||
    !identity(input.revision) ||
    (input.model !== null && (!identity(model.providerId) || !validModel(model.model))) ||
    typeof input.search !== 'boolean' ||
    typeof input.attachments !== 'boolean' ||
    (input.memory !== 'shared' && input.memory !== 'private' && input.memory !== 'off')
  ) {
    throw new AssistantLibraryError('invalid')
  }
  return {
    id: input.id,
    revision: input.revision,
    name: textField(input.name, 48),
    prompt: textField(input.prompt, AGENT_PROMPT_LIMIT),
    model:
      input.model === null
        ? null
        : { providerId: model.providerId as string, model: model.model as string },
    search: input.search,
    attachments: input.attachments,
    memory: input.memory,
  }
}

const readMemory = (value: unknown): MemoryNote => {
  const input = object(value)
  const source = object(input.source)
  if (
    !identity(input.id) ||
    !identity(input.revision) ||
    (input.agentId !== undefined && !identity(input.agentId)) ||
    typeof input.pinned !== 'boolean' ||
    typeof input.updatedAt !== 'number' ||
    !Number.isFinite(input.updatedAt)
  ) {
    throw new AssistantLibraryError('invalid')
  }
  return {
    id: input.id,
    revision: input.revision,
    text: textField(input.text, MEMORY_TEXT_LIMIT),
    agentId: input.agentId,
    pinned: input.pinned,
    ...(identity(source.sessionId) && identity(source.messageId)
      ? { source: { sessionId: source.sessionId, messageId: source.messageId } }
      : {}),
    updatedAt: input.updatedAt,
    ...(typeof input.topic === 'string' && input.topic.length <= 100 ? { topic: input.topic } : {}),
    ...(typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)
      ? { observedAt: input.observedAt }
      : {}),
  }
}

const replaceEntry = <T extends { id: string; revision: string }>(
  current: T[],
  item: T,
  revision: string | undefined,
  limit: number
) => {
  const previous = current.find((entry) => entry.id === item.id)
  if (previous?.revision !== revision) {
    throw new AssistantLibraryError('changed')
  }
  if (!previous && current.length >= limit) {
    throw new AssistantLibraryError('limit')
  }
  return [item, ...current.filter((entry) => entry.id !== item.id)]
}

export const saveAgent = async (
  input: Omit<AgentProfile, 'id' | 'revision'>,
  previous?: AgentProfile
) => {
  const item = readAgent({ ...input, id: previous?.id ?? createId(), revision: createId() })
  await change((current) => ({
    ...current,
    agents: replaceEntry(current.agents, item, previous?.revision, AGENT_LIMIT),
  }))
  logEvent('settings', 'assistant.agent-saved', {
    editing: Boolean(previous),
    pinsModel: Boolean(item.model),
  })
  return item
}

export const saveMemory = async (
  input: Pick<MemoryNote, 'text' | 'agentId' | 'pinned' | 'source'>,
  previous?: MemoryNote
) => {
  const item = readMemory({
    ...input,
    id: previous?.id ?? createId(),
    revision: createId(),
    updatedAt: Date.now(),
    topic: automaticPreference(input.text, true)?.topic,
  })
  await change((current) => {
    const key = memoryKey(item)
    if (current.memories.some((note) => note.id !== item.id && memoryKey(note) === key)) {
      throw new AssistantLibraryError('duplicate')
    }
    return {
      ...current,
      memories: replaceEntry(current.memories, item, previous?.revision, MEMORY_LIMIT),
    }
  })
  logEvent('settings', 'assistant.memory-saved', {
    editing: Boolean(previous),
    scoped: Boolean(item.agentId),
  })
  return item
}

export const removeAgent = (item: AgentProfile) =>
  change((current) => {
    if (current.agents.find(({ id }) => id === item.id)?.revision !== item.revision) {
      throw new AssistantLibraryError('changed')
    }
    return {
      ...current,
      agents: current.agents.filter(({ id }) => id !== item.id),
      suggestions: current.suggestions.filter(({ agentId }) => agentId !== item.id),
    }
  })
export const removeMemory = (item: MemoryNote) =>
  change((current) => {
    if (current.memories.find(({ id }) => id === item.id)?.revision !== item.revision) {
      throw new AssistantLibraryError('changed')
    }
    return {
      ...current,
      memories: current.memories.filter(({ id }) => id !== item.id),
      activity: current.activity.filter(({ current: note }) => note.id !== item.id),
      forgotten: [{ key: memoryKey(item), observedAt: Date.now() }, ...current.forgotten].slice(
        0,
        MEMORY_LIMIT
      ),
    }
  })
export const setMemoryEnabled = (enabled: boolean) => change((current) => ({ ...current, enabled }))
export const setAutomaticMemory = async (automatic: boolean) => {
  await change((current) => ({ ...current, enabled: automatic, automatic, automaticVersion: 2 }))
  logEvent('settings', 'assistant.automatic-memory-changed', { enabled: automatic })
}

export const saveAutomaticMemory = async (
  preference: AutoPreference,
  origin: MemoryOrigin,
  allowed: () => boolean,
  revisions?: ReadonlyMap<string, string>
) => {
  let operation: 'added' | 'updated' | undefined
  await change((library) => {
    if (
      !allowed() ||
      !library.automatic ||
      (origin.agentId && !library.agents.some(({ id }) => id === origin.agentId))
    ) {
      return library
    }
    const key = memoryKey({ text: preference.text, agentId: origin.agentId })
    if (
      library.memories.some((note) => memoryKey(note) === key) ||
      library.forgotten.some((item) => item.key === key && item.observedAt >= origin.observedAt)
    ) {
      return origin.legacyId
        ? {
            ...library,
            suggestions: library.suggestions.filter(({ id }) => id !== origin.legacyId),
          }
        : library
    }
    const matching = library.memories.filter((note) => {
      if (note.agentId !== origin.agentId) {
        return false
      }
      const topic = note.topic ?? automaticPreference(note.text, true)?.topic
      return (
        !!topic && (preference.relative ? topic.startsWith('format:') : topic === preference.topic)
      )
    })
    const sameChat = matching.filter((note) => note.source?.sessionId === origin.source.sessionId)
    const applicable = preference.relative && sameChat.length > 0 ? sameChat : matching
    if (applicable.length > 1 || (preference.relative && applicable.length !== 1)) {
      return library
    }
    const prior = applicable[0]
    if (
      prior &&
      ((prior.observedAt ?? prior.updatedAt) > origin.observedAt ||
        (revisions && revisions.get(prior.id) !== prior.revision))
    ) {
      return library
    }
    if (!prior && library.memories.length >= MEMORY_LIMIT) {
      return library
    }
    const text =
      preference.relative && prior && preference.format
        ? prior.text.replace(
            /(?:Markdown|Word|DOCX|PDF|Excel|XLSX|CSV|PPTX?|JSON|TXT)\s*(?:格式|版)?$/iu,
            preference.format
          )
        : preference.text
    const current = readMemory({
      id: prior?.id ?? createId(),
      revision: createId(),
      text,
      agentId: origin.agentId,
      pinned: prior?.pinned ?? false,
      source: origin.source,
      topic:
        preference.topic ?? prior?.topic ?? (prior && automaticPreference(prior.text, true)?.topic),
      updatedAt: Date.now(),
      observedAt: origin.observedAt,
    })
    const normalizedCurrent = memoryKey(current)
    if (
      library.memories.some((note) => memoryKey(note) === normalizedCurrent) ||
      library.forgotten.some(
        (item) => item.key === normalizedCurrent && item.observedAt >= origin.observedAt
      )
    ) {
      return library
    }
    operation = prior ? 'updated' : 'added'
    return {
      ...library,
      memories: replaceEntry(library.memories, current, prior?.revision, MEMORY_LIMIT),
      suggestions: library.suggestions.filter(({ id }) => id !== origin.legacyId),
      activity: [
        { id: createId(), current, prior, round: origin.round },
        ...library.activity,
      ].slice(0, ACTIVITY_LIMIT),
    }
  })
  if (operation) {
    logEvent('storage', 'assistant.automatic-memory-written', {
      operation,
      scoped: !!origin.agentId,
    })
  }
}

export const undoAutomaticMemory = (id: string) =>
  change((library) => {
    const event = library.activity.find((item) => item.id === id)
    if (
      !event ||
      event.undone ||
      library.memories.find((note) => note.id === event.current.id)?.revision !==
        event.current.revision
    ) {
      throw new AssistantLibraryError('changed')
    }
    const remaining = library.memories.filter((note) => note.id !== event.current.id)
    const prior = event.prior
    if (prior && remaining.some((note) => memoryKey(note) === memoryKey(prior))) {
      throw new AssistantLibraryError('duplicate')
    }
    return {
      ...library,
      memories: prior ? [{ ...prior, revision: createId() }, ...remaining] : remaining,
      activity: library.activity.map((item) => (item.id === id ? { ...item, undone: true } : item)),
      forgotten: [
        { key: memoryKey(event.current), observedAt: Date.now() },
        ...library.forgotten,
      ].slice(0, MEMORY_LIMIT),
    }
  })

export const recordMemoryMaintenance = (input: number, output: number) =>
  change((library) => ({
    ...library,
    maintenance: {
      ...library.maintenance,
      input: library.maintenance.input + input,
      output: library.maintenance.output + output,
    },
  }))

export const claimMemoryMaintenance = async (id: string, allowed: (state: Library) => boolean) => {
  let claimed = false
  await change((state) => {
    if (
      !state.enabled ||
      !state.automatic ||
      !allowed(state) ||
      Date.now() - (state.maintenance.lastAt ?? 0) < 60_000 ||
      state.maintenance.recent?.includes(id)
    ) {
      return state
    }
    claimed = true
    return {
      ...state,
      maintenance: {
        ...state.maintenance,
        requests: state.maintenance.requests + 1,
        lastAt: Date.now(),
        recent: [id, ...(state.maintenance.recent ?? [])].slice(0, 120),
      },
    }
  })
  return claimed
}

export const allowsMemory = (grant: MemoryGrant, connection: string, sessionId: string) =>
  grant.connection === connection && (!grant.sessionId || grant.sessionId === sessionId)
export const usesAutomaticMemory = (library: Library) =>
  library.automaticVersion === 2 && library.enabled && library.automatic

export const canSendMemory = (library: Library, connection: string, sessionId: string) =>
  library.enabled &&
  (usesAutomaticMemory(library) ||
    library.grants.some((grant) => allowsMemory(grant, connection, sessionId)))

export const allowMemory = (grant: MemoryGrant) =>
  change((current) => {
    if (!current.enabled) {
      return current
    }
    const { sessionId, connection } = grant
    const existing = current.grants.filter(
      (item) => item.connection !== connection || (sessionId && item.sessionId !== sessionId)
    )
    if (sessionId && existing.some((item) => allowsMemory(item, connection, sessionId))) {
      return current
    }
    return { ...current, grants: [...existing, grant] }
  })
export const revokeMemory = (connection: string, scope?: { sessionId?: string }) =>
  change((current) => ({
    ...current,
    grants: current.grants.filter(
      (item) => item.connection !== connection || (scope && item.sessionId !== scope.sessionId)
    ),
  }))

export const cleanSessionMemory = (sessionId: string, deleteNotes: boolean) =>
  change((current) => {
    const grants = current.grants.filter((grant) => grant.sessionId !== sessionId)
    const suggestions = current.suggestions.filter((item) => item.source.sessionId !== sessionId)
    const memories = current.memories.flatMap((note) => {
      if (note.source?.sessionId !== sessionId) {
        return [note]
      }
      return deleteNotes ? [] : [{ ...note, source: undefined }]
    })
    const activity = current.activity.filter(
      (event) =>
        event.current.source?.sessionId !== sessionId &&
        event.prior?.source?.sessionId !== sessionId
    )
    const changed =
      grants.length !== current.grants.length ||
      suggestions.length !== current.suggestions.length ||
      activity.length !== current.activity.length ||
      memories.length !== current.memories.length ||
      memories.some((note, index) => note !== current.memories[index])
    return changed ? { ...current, grants, memories, suggestions, activity } : current
  })

export const cleanReplacedHistoryMemory = (
  restored: ReadonlySet<string>,
  replaced?: ReadonlySet<string>
) =>
  change((current) => {
    const grants = current.grants.filter(
      ({ sessionId }) => !sessionId || (replaced && !replaced.has(sessionId))
    )
    const suggestions = current.suggestions.filter((item) => restored.has(item.source.sessionId))
    const memories = current.memories.map((note) =>
      note.source && !restored.has(note.source.sessionId) ? { ...note, source: undefined } : note
    )
    const activity = current.activity.filter(
      (event) =>
        (!event.current.source || restored.has(event.current.source.sessionId)) &&
        (!event.prior?.source || restored.has(event.prior.source.sessionId))
    )
    return grants.length !== current.grants.length ||
      suggestions.length !== current.suggestions.length ||
      activity.length !== current.activity.length ||
      memories.some((note, index) => note !== current.memories[index])
      ? { ...current, grants, memories, suggestions, activity }
      : current
  })

export const exportAssistantLibrary = async () => {
  const { memories, agents } = await readAssistantLibrary()
  return new Blob(
    [JSON.stringify({ format: 'freeseek-assistants', version: 1, memories, agents }, null, 2)],
    {
      type: 'application/json',
    }
  )
}

export const readAssistantBackup = async (file: File): Promise<Backup> => {
  if (file.size > BACKUP_LIMIT) {
    throw new AssistantLibraryError('limit')
  }
  let input: Record<string, unknown>
  try {
    input = object(JSON.parse(await file.text()))
  } catch {
    throw new AssistantLibraryError('invalid')
  }
  if (
    input.format !== 'freeseek-assistants' ||
    input.version !== 1 ||
    !Array.isArray(input.memories) ||
    !Array.isArray(input.agents)
  ) {
    throw new AssistantLibraryError('invalid')
  }
  if (input.memories.length > MEMORY_LIMIT || input.agents.length > AGENT_LIMIT) {
    throw new AssistantLibraryError('limit')
  }
  const memories = input.memories.map(readMemory)
  const agents = input.agents.map(readAgent)
  if (
    new Set(memories.map(({ id }) => id)).size !== memories.length ||
    new Set(agents.map(({ id }) => id)).size !== agents.length
  ) {
    throw new AssistantLibraryError('invalid')
  }
  return { memories, agents }
}

export const importAssistantBackup = async (backup: Backup, replace: boolean) => {
  await change((current) => {
    const merge = <T extends { id: string; revision: string }>(local: T[], imported: T[]) => {
      const merged = new Map(local.map((item) => [item.id, item]))
      for (const item of imported) {
        if (!merged.has(item.id)) {
          merged.set(item.id, item)
        } else if (replace) {
          merged.set(item.id, { ...item, revision: createId() })
        }
      }
      return [...merged.values()]
    }
    const mergedMemories = merge(current.memories, backup.memories)
    const localIds = new Set(current.memories.map(({ id }) => id))
    const memoryKeys = new Set(mergedMemories.filter(({ id }) => localIds.has(id)).map(memoryKey))
    const memories = mergedMemories.filter((note) => {
      if (localIds.has(note.id)) {
        return true
      }
      const key = memoryKey(note)
      if (memoryKeys.has(key)) {
        return false
      }
      memoryKeys.add(key)
      return true
    })
    const agents = merge(current.agents, backup.agents)
    if (memories.length > MEMORY_LIMIT || agents.length > AGENT_LIMIT) {
      throw new AssistantLibraryError('limit')
    }
    return { ...current, memories, agents }
  })
  logEvent('settings', 'assistant.backup-imported', {
    hadMemories: backup.memories.length > 0,
    hadAgents: backup.agents.length > 0,
  })
}
