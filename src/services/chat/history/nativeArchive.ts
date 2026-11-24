import * as db from '../db.js'
import { mapSessionMessages, allSessionMessages, mapSessionFileIds, messageFiles } from '../sessionData.js'
import { getVisibleMessages, normalizeSession } from '../branches.js'
import { contextRounds, rebaseContextSummary } from '../contextCompression.js'
import { logEvent, diagnosticError } from '../../diagnostics/log.js'
import {
  discardImportedWorkspaces,
  exportWorkspaceBackup,
  getWorkspace,
  importWorkspaceSnapshot,
} from '../../tasks/workspaces.js'
import { settleReply } from '../reply.js'
import type { Session } from '../types.js'
import { usePersonas, restorePersonas, type Persona } from '../../personas.js'
import {
  DEFAULT_PRICING,
  readModelPrices,
  saveModelPrices,
  setPricing,
  usePricing,
  type FlashPricing,
  type ModelPrices,
} from '../../usage.js'
import { BackupError, fail } from './errors.js'
import { id, list, number, readNativeSession, record, string } from './nativeSchema.js'
import { MANIFEST_PATH } from './paths.js'
import type { ArchiveEntry } from './zipReader.js'
import { stageArchiveFile } from './stageArchiveFile.js'
import { writeArchive } from './zipWriter.js'
import { jsonBlob } from './jsonBlob.js'
import {
  readJsonEntry,
  assertJsonStructure,
  MAX_JSON_BYTES,
  MAX_SESSION_JSON_BYTES,
  type ImportProgress,
} from './readJson.js'

const FLAT_VERSION = 2
const SPLIT_VERSION = 3
const LARGE_SPLIT_VERSION = 4
const LEGACY_TASK_VERSION = 5
const TASK_VERSION = 6
const WORKSPACE_VERSION = 7
const PARTIAL_VERSION = 8
const MAX_SESSION_PARTS = 1024
const PART_ITEMS = 512
const MAX_SPLIT_TOKENS = 8_000_000
const sessionPath = (id: string) => `freeseek/sessions/${encodeURIComponent(id)}.json`
const sessionPartPath = (id: string, index: number) =>
  `freeseek/sessions/${encodeURIComponent(id)}/${index}.json`
const filePath = (id: string) => `freeseek/files/${encodeURIComponent(id)}.bin`
const workspacePath = (id: string) => `freeseek/workspaces/${encodeURIComponent(id)}.json`
const encodeJson = (data: unknown, maxBytes = MAX_JSON_BYTES) => {
  const tokens = assertJsonStructure(data)
  const blob = jsonBlob(data, maxBytes)
  if (!blob) {
    return fail('backupJsonTooLarge')
  }
  return { blob, tokens }
}
const json = (data: unknown) => encodeJson(data).blob
type SplitSession = { id: string; parts: number }
type PartField = 'messages' | 'inherited' | 'compressionUsage'
type ZipEntry = { name: string; blob: Blob }
type PartialBackup =
  | { kind: 'unreadable'; skippedSessions: number; missingOriginals?: number }
  | { kind: 'recovery' }
type Manifest = {
  freeseek_backup_version: number
  sessions: string[]
  splitSessions?: SplitSession[]
  files: { id: string; size: number; type: string }[]
  workspaces?: string[]
  partial?: PartialBackup
  personas: Persona[]
  defaultPersonaId: string
  pricing?: FlashPricing
  modelPrices?: ModelPrices
}
export type NativeBackupSettings = Pick<
  Manifest,
  'personas' | 'defaultPersonaId' | 'pricing' | 'modelPrices'
> & { importedWorkspaces?: string[]; workspacesBySession?: Map<string, string[]> }
export const isNativeManifest = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'freeseek_backup_version' in value

const readPartialBackup = (value: unknown): PartialBackup => {
  const partial = record(value)
  if (partial.kind === 'recovery') {
    return { kind: 'recovery' }
  }
  if (partial.kind === 'unreadable') {
    const skippedSessions = number(partial.skippedSessions)
    const missingOriginals = partial.missingOriginals === undefined ? 0 : number(partial.missingOriginals)
    if (
      Number.isSafeInteger(skippedSessions) &&
      Number.isSafeInteger(missingOriginals) &&
      (skippedSessions > 0 || missingOriginals > 0)
    ) {
      return { kind: 'unreadable', skippedSessions, ...(missingOriginals > 0 && { missingOriginals }) }
    }
  }
  return fail('backupIncomplete')
}

export const readNativeManifest = (value: unknown): Manifest => {
  const item = record(value)
  const version = item.freeseek_backup_version as number
  if (
    ![
      1,
      FLAT_VERSION,
      SPLIT_VERSION,
      LARGE_SPLIT_VERSION,
      LEGACY_TASK_VERSION,
      TASK_VERSION,
      WORKSPACE_VERSION,
      PARTIAL_VERSION,
    ].includes(version)
  ) {
    return fail(
      typeof version === 'number' && version > PARTIAL_VERSION
        ? 'backupNewerVersion'
        : 'backupInvalidVersion'
    )
  }
  const manifest: Manifest = {
    freeseek_backup_version: version,
    sessions: list(item.sessions, id),
    ...(version >= SPLIT_VERSION
      ? {
          splitSessions: list(item.splitSessions, (raw) => {
            const entry = record(raw)
            const parts = number(entry.parts)
            if (!Number.isSafeInteger(parts) || parts < 1 || parts > MAX_SESSION_PARTS) {
              fail('backupIncomplete')
            }
            return { id: id(entry.id), parts }
          }),
        }
      : {}),
    files: list(item.files, (value) => {
      const file = record(value)
      return { id: id(file.id), size: number(file.size), type: string(file.type) }
    }),
    ...((version === WORKSPACE_VERSION ||
      (version === PARTIAL_VERSION && item.workspaces !== undefined)) && {
      workspaces: list(item.workspaces, id),
    }),
    ...(version === PARTIAL_VERSION && { partial: readPartialBackup(item.partial) }),
    personas: list(item.personas, (value) => {
      const persona = record(value)
      const personaId = id(persona.id)
      if (personaId.startsWith('builtin-')) {
        return fail('backupIncomplete')
      }
      return { id: personaId, name: string(persona.name), prompt: string(persona.prompt) }
    }),
    defaultPersonaId: id(item.defaultPersonaId),
    ...(item.modelPrices === undefined ? {} : { modelPrices: readModelPrices(item.modelPrices) }),
    ...(item.pricing === undefined
      ? {}
      : {
          pricing: Object.fromEntries(
            Object.keys(DEFAULT_PRICING).map((key) => [key, number(record(item.pricing)[key])])
          ) as FlashPricing,
        }),
  }
  for (const ids of [
    manifest.sessions,
    manifest.files.map((file) => file.id),
    manifest.personas.map((persona) => persona.id),
    (manifest.splitSessions ?? []).map((entry) => entry.id),
    manifest.workspaces ?? [],
  ]) {
    if (new Set(ids).size !== ids.length) {
      fail('backupIncomplete')
    }
  }
  const sessionIds = new Set(manifest.sessions)
  if (manifest.splitSessions?.some(({ id }) => !sessionIds.has(id))) {
    fail('backupIncomplete')
  }
  return manifest
}

/** The ZIP reader consumes one bounded part at a time. Keep the full conversation in one session. */
const splitSessionEntries = (session: Session): ZipEntry[] => {
  const { inherited, compressionUsage, ...meta } = session
  const head = encodeJson({
    ...meta,
    messages: [],
    inherited: inherited ? { ...inherited, messages: [] } : inherited,
    compressionUsage: compressionUsage ? [] : undefined,
  })
  const entries = [{ name: sessionPath(session.id), blob: head.blob }]
  let size = head.blob.size,
    tokens = head.tokens
  const add = (field: PartField, items: unknown[]) => {
    let part: ReturnType<typeof encodeJson>
    try {
      part = encodeJson(
        { field, items },
        items.length === 1 ? MAX_SESSION_JSON_BYTES : MAX_JSON_BYTES
      )
    } catch (error) {
      if (
        !(error instanceof BackupError) ||
        error.key !== 'backupJsonTooLarge' ||
        items.length < 2
      ) {
        throw error
      }
      const middle = Math.floor(items.length / 2)
      add(field, items.slice(0, middle))
      add(field, items.slice(middle))
      return
    }
    size += part.blob.size
    tokens += part.tokens
    if (
      size > MAX_SESSION_JSON_BYTES ||
      tokens > MAX_SPLIT_TOKENS ||
      entries.length > MAX_SESSION_PARTS
    ) {
      fail('backupJsonTooLarge')
    }
    entries.push({ name: sessionPartPath(session.id, entries.length), blob: part.blob })
  }
  const sections: [PartField, unknown[]][] = [
    ['messages', session.messages],
    ['inherited', inherited?.messages ?? []],
    ['compressionUsage', compressionUsage ?? []],
  ]
  for (const [field, items] of sections) {
    for (let i = 0; i < items.length; i += PART_ITEMS) {
      add(field, items.slice(i, i + PART_ITEMS))
    }
  }
  if (entries.length < 2) {
    fail('backupJsonTooLarge')
  }
  return entries
}

const packSession = (original: Session) => {
  const session = mapSessionMessages(normalizeSession(original), (message) => {
    if (message.role !== 'assistant') {
      return message
    }
    const settled = ['pending', 'streaming'].includes(message.status)
      ? settleReply(message, 'stopped', Date.now())
      : message
    return settled.task?.pendingMcp
      ? { ...settled, task: { ...settled.task, pendingMcp: undefined } }
      : settled
  })
  readNativeSession(session)
  const snapshot = { ...session, compressionCheckpoint: undefined }
  try {
    return { session, entries: [{ name: sessionPath(session.id), blob: json(snapshot) }] }
  } catch (error) {
    if (!(error instanceof BackupError) || error.key !== 'backupJsonTooLarge') {
      throw error
    }
    return { session, entries: splitSessionEntries(snapshot) }
  }
}

/** 无损本机备份；不写入 API Key，原件按文件 ID 去重。 */
export const exportNativeArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  loadOriginal: (id: string) => Promise<Blob | undefined> = db.loadFile,
  getPartial?: () => PartialBackup | undefined,
  onSkipped?: (error: unknown) => void
): Promise<Blob> => {
  const entries: ZipEntry[] = []
  const files = new Map<string, Blob>()
  const workspaces = new Map<string, Blob>()
  const checkedWorkspaces = new Set<string>()
  const ids: string[] = []
  const splitSessions: SplitSession[] = []
  let version = FLAT_VERSION
  const { personas, defaultId } = usePersonas.getState()
  for await (const original of sessions) {
    let packed: ReturnType<typeof packSession>
    try {
      packed = packSession(original)
    } catch (error) {
      if (!onSkipped) {
        throw error
      }
      onSkipped(error)
      continue
    }
    const { session, entries: parts } = packed
    const messages = allSessionMessages(session)
    if (
      session.mode === 'agent' ||
      messages.some((message) => message.role === 'assistant' && message.task)
    ) {
      version = Math.max(version, TASK_VERSION)
    }
    const workspaceIds = [
      session.workspaceId,
      ...messages.flatMap((message) =>
        message.role === 'assistant' && message.task?.workspaceId ? [message.task.workspaceId] : []
      ),
    ]
    for (const workspaceId of workspaceIds) {
      if (workspaceId && !checkedWorkspaces.has(workspaceId)) {
        checkedWorkspaces.add(workspaceId)
        if (await getWorkspace(workspaceId)) {
          workspaces.set(workspaceId, await exportWorkspaceBackup(workspaceId))
        }
      }
    }
    ids.push(session.id)
    if (parts.length > 1) {
      const bytes = parts.reduce((total, { blob }) => total + blob.size, 0)
      version = Math.max(version, bytes > MAX_JSON_BYTES ? LARGE_SPLIT_VERSION : SPLIT_VERSION)
      splitSessions.push({ id: session.id, parts: parts.length - 1 })
    }
    entries.push(...parts)
    for (const message of messages) {
      for (const file of messageFiles(message)) {
        if (!files.has(file.id)) {
          const original = await loadOriginal(file.id)
          if (original) {
            files.set(file.id, original)
          }
        }
      }
    }
  }
  if (workspaces.size) {
    version = WORKSPACE_VERSION
  }
  const partial = getPartial?.()
  if (partial) {
    version = PARTIAL_VERSION
  }
  const manifest: Manifest = {
    freeseek_backup_version: version,
    sessions: ids,
    ...(version >= SPLIT_VERSION ? { splitSessions } : {}),
    files: [...files].map(([id, blob]) => ({ id, size: blob.size, type: blob.type })),
    ...(workspaces.size > 0 && { workspaces: [...workspaces.keys()] }),
    ...(partial && { partial }),
    personas: personas.filter((persona) => !persona.id.startsWith('builtin-')),
    defaultPersonaId: defaultId,
    pricing: usePricing.getState().pricing,
    modelPrices: usePricing.getState().modelPrices,
  }
  return writeArchive([
    { name: MANIFEST_PATH, blob: json(manifest) },
    ...[...workspaces].map(([id, blob]) => ({ name: workspacePath(id), blob })),
    ...entries,
    ...[...files].map(([id, blob]) => ({ name: filePath(id), blob })),
  ])
}

const restoreSplitSession = async (
  header: ArchiveEntry,
  id: string,
  parts: number,
  entries: AsyncGenerator<ArchiveEntry>,
  read: (entry: ArchiveEntry) => Promise<unknown>
) => {
  const head = record(await read(header))
  const sections = new Map<PartField, unknown[]>()
  const addSection = (field: PartField, value: unknown) => {
    if (!Array.isArray(value) || value.length !== 0) {
      return fail('backupIncomplete')
    }
    sections.set(field, value)
  }
  addSection('messages', head.messages)
  if (head.inherited) {
    addSection('inherited', record(head.inherited).messages)
  }
  if (head.compressionUsage !== undefined) {
    addSection('compressionUsage', head.compressionUsage)
  }
  let size = header.size,
    tokens = assertJsonStructure(head)
  for (let index = 1; index <= parts; index++) {
    const next = await entries.next()
    if (next.done || next.value.path !== sessionPartPath(id, index)) {
      return fail('backupIncomplete')
    }
    size += next.value.size
    if (size > MAX_SESSION_JSON_BYTES) {
      return fail('backupJsonTooLarge')
    }
    const part = record(await read(next.value))
    tokens += assertJsonStructure(part)
    if (tokens > MAX_SPLIT_TOKENS) {
      return fail('backupJsonTooLarge')
    }
    const target = sections.get(part.field as PartField)
    if (
      !target ||
      !Array.isArray(part.items) ||
      part.items.length < 1 ||
      part.items.length > PART_ITEMS
    ) {
      return fail('backupIncomplete')
    }
    target.push(...part.items)
  }
  return head
}

const remapArchivedAttachments = (session: Session, mapFileId: (id: string) => string) => {
  const mapped = mapSessionFileIds(session, mapFileId)
  if (mapped === session) {
    return session
  }
  if (session.contextSummary) {
    mapped.contextSummary = rebaseContextSummary(
      session.contextSummary,
      contextRounds(getVisibleMessages(session), session.inherited),
      contextRounds(getVisibleMessages(mapped), mapped.inherited)
    )
  }
  if (session.inherited?.contextSummary && mapped.inherited) {
    mapped.inherited.contextSummary = rebaseContextSummary(
      session.inherited.contextSummary,
      contextRounds(session.inherited.messages),
      contextRounds(mapped.inherited.messages)
    )
  }
  return mapped
}

/** 缺项或坏 CRC 均拒绝整份导入，正式数据由调用方原子提交。 */
export const importNativeEntries = async (
  entries: AsyncGenerator<ArchiveEntry>,
  manifest: Manifest,
  total: number,
  useDisk: boolean,
  mapFileId: (id: string) => string,
  onProgress?: ImportProgress
): Promise<NativeBackupSettings> => {
  const sessions = new Map(manifest.sessions.map((id) => [sessionPath(id), id]))
  const splits = new Map((manifest.splitSessions ?? []).map(({ id, parts }) => [id, parts]))
  const files = new Map(manifest.files.map((file) => [filePath(file.id), file]))
  const workspaces = new Map((manifest.workspaces ?? []).map((id) => [workspacePath(id), id]))
  const restored = new Map<string, string>()
  const workspacesBySession = new Map<string, string[]>()
  let processed = 1
  onProgress?.(processed, total)
  const onRead = (bytes: number, size: number) =>
    onProgress?.(processed, total, { bytes, total: size })
  const read = async (entry: ArchiveEntry) => {
    const value = await readJsonEntry(entry, onRead, 'session')
    onProgress?.(++processed, total)
    return value
  }
  try {
    for await (const entry of entries) {
      const sessionId = sessions.get(entry.path)
      const file = files.get(entry.path)
      const workspaceId = workspaces.get(entry.path)
      if (workspaceId !== undefined) {
        const value = await read(entry)
        const workspace = await importWorkspaceSnapshot(
          value,
          new AbortController().signal,
          workspaceId
        )
        restored.set(workspaceId, workspace.id)
        workspaces.delete(entry.path)
      } else if (sessionId !== undefined) {
        if (workspaces.size) {
          fail('backupIncomplete')
        }
        const parts = splits.get(sessionId)
        const raw = parts
          ? await restoreSplitSession(entry, sessionId, parts, entries, read)
          : await read(entry)
        const session = readNativeSession(raw)
        if (session.id !== sessionId) {
          fail('backupIncomplete')
        }
        const mapped = restored.size
          ? mapSessionMessages(session, (message) => {
              if (message.role !== 'assistant' || !message.task?.workspaceId) {
                return message
              }
              const workspaceId = restored.get(message.task.workspaceId)
              return workspaceId ? { ...message, task: { ...message.task, workspaceId } } : message
            })
          : session
        const imported = remapArchivedAttachments({
          ...mapped,
          workspaceId: session.workspaceId
            ? (restored.get(session.workspaceId) ?? session.workspaceId)
            : undefined,
        }, mapFileId)
        if (restored.size) {
          workspacesBySession.set(sessionId, [
            ...(imported.workspaceId ? [imported.workspaceId] : []),
            ...allSessionMessages(imported).flatMap((message) =>
              message.role === 'assistant' && message.task?.workspaceId ? [message.task.workspaceId] : []
            ),
          ])
        }
        await db.addStagingSession(imported)
        sessions.delete(entry.path)
      } else if (file) {
        if (entry.size !== file.size) {
          fail('backupIncomplete')
        }
        await stageArchiveFile(entry, mapFileId(file.id), file.type, onRead, useDisk)
        files.delete(entry.path)
        onProgress?.(++processed, total)
      } else {
        fail('backupIncomplete')
      }
    }
    if (sessions.size || files.size || workspaces.size) {
      fail('backupIncomplete')
    }
    return {
      personas: manifest.personas,
      defaultPersonaId: manifest.defaultPersonaId,
      pricing: manifest.pricing,
      modelPrices: manifest.modelPrices,
      ...(restored.size && { importedWorkspaces: [...restored.values()], workspacesBySession }),
    }
  } catch (error) {
    await discardImportedWorkspaces(restored.values()).catch((failure) =>
      logEvent('backup', 'import.workspace-rollback-failed', diagnosticError(failure), 'warn')
    )
    throw error
  }
}

export const restoreNativeSettings = (settings: NativeBackupSettings | undefined): void => {
  if (settings) {
    restorePersonas(settings.personas, settings.defaultPersonaId)
    if (settings.pricing) {
      setPricing(settings.pricing)
    }
    if (settings.modelPrices) {
      saveModelPrices(settings.modelPrices)
    }
  }
}
