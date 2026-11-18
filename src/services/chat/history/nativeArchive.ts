import * as db from '../db.js'
import { mapSessionMessages, allSessionMessages } from '../sessionData.js'
import { normalizeSession } from '../branches.js'
import { settleReply } from '../reply.js'
import type { Session } from '../types.js'
import { usePersonas, restorePersonas, type Persona } from '../../personas.js'
import { DEFAULT_PRICING, setPricing, usePricing, type FlashPricing } from '../../usage.js'
import { fail } from './errors.js'
import { id, list, number, readNativeSession, record, string } from './nativeSchema.js'
import { MANIFEST_PATH } from './paths.js'
import { readEntry, type ArchiveEntry } from './zipReader.js'
import { writeArchive } from './zipWriter.js'
import {
  readJsonEntry,
  assertJsonStructure,
  MAX_JSON_BYTES,
  type ImportProgress,
} from './readJson.js'

const VERSION = 2
const sessionPath = (id: string) => `freeseek/sessions/${encodeURIComponent(id)}.json`
const filePath = (id: string) => `freeseek/files/${encodeURIComponent(id)}.bin`
const json = (data: unknown) => {
  assertJsonStructure(data)
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  if (blob.size > MAX_JSON_BYTES) {
    fail('backupJsonTooLarge')
  }
  return blob
}
type Manifest = {
  freeseek_backup_version: number
  sessions: string[]
  files: { id: string; size: number; type: string }[]
  personas: Persona[]
  defaultPersonaId: string
  pricing?: FlashPricing
}
export type NativeBackupSettings = Pick<Manifest, 'personas' | 'defaultPersonaId' | 'pricing'>
export const isNativeManifest = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'freeseek_backup_version' in value

export const readNativeManifest = (value: unknown): Manifest => {
  const item = record(value)
  if (![1, VERSION].includes(item.freeseek_backup_version as number)) {
    return fail(
      typeof item.freeseek_backup_version === 'number' && item.freeseek_backup_version > VERSION
        ? 'backupNewerVersion'
        : 'backupInvalidVersion'
    )
  }
  const manifest: Manifest = {
    freeseek_backup_version: VERSION,
    sessions: list(item.sessions, id),
    files: list(item.files, (value) => {
      const file = record(value)
      return { id: id(file.id), size: number(file.size), type: string(file.type) }
    }),
    personas: list(item.personas, (value) => {
      const persona = record(value)
      const personaId = id(persona.id)
      if (personaId.startsWith('builtin-')) {
        return fail('backupIncomplete')
      }
      return { id: personaId, name: string(persona.name), prompt: string(persona.prompt) }
    }),
    defaultPersonaId: id(item.defaultPersonaId),
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
  ]) {
    if (new Set(ids).size !== ids.length) {
      fail('backupIncomplete')
    }
  }
  return manifest
}

/** 无损本机备份；不写入 API Key，原件按文件 ID 去重。 */
export const exportNativeArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  loadOriginal: (id: string) => Promise<Blob | undefined> = db.loadFile
): Promise<Blob> => {
  const entries: { name: string; blob: Blob }[] = []
  const files = new Map<string, Blob>()
  const ids: string[] = []
  const { personas, defaultId } = usePersonas.getState()
  for await (const original of sessions) {
    const session = mapSessionMessages(normalizeSession(original), (message) =>
      message.role === 'assistant' && ['pending', 'streaming'].includes(message.status)
        ? settleReply(message, 'stopped', Date.now())
        : message
    )
    readNativeSession(session)
    ids.push(session.id)
    const sessionBlob = json({ ...session, compressionCheckpoint: undefined })
    entries.push({ name: sessionPath(session.id), blob: sessionBlob })
    for (const message of allSessionMessages(session)) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (!files.has(file.id)) {
            const original = await loadOriginal(file.id)
            if (original) {
              files.set(file.id, original)
            }
          }
        }
      }
    }
  }
  const manifest: Manifest = {
    freeseek_backup_version: VERSION,
    sessions: ids,
    files: [...files].map(([id, blob]) => ({ id, size: blob.size, type: blob.type })),
    personas: personas.filter((persona) => !persona.id.startsWith('builtin-')),
    defaultPersonaId: defaultId,
    pricing: usePricing.getState().pricing,
  }
  return writeArchive([
    { name: MANIFEST_PATH, blob: json(manifest) },
    ...entries,
    ...[...files].map(([id, blob]) => ({ name: filePath(id), blob })),
  ])
}

/** 缺项或坏 CRC 均拒绝整份导入，正式数据由调用方原子提交。 */
export const importNativeEntries = async (
  entries: AsyncGenerator<ArchiveEntry>,
  manifest: Manifest,
  total: number,
  onProgress?: ImportProgress
): Promise<NativeBackupSettings> => {
  const sessions = new Map(manifest.sessions.map((id) => [sessionPath(id), id]))
  const files = new Map(manifest.files.map((file) => [filePath(file.id), file]))
  let processed = 1
  onProgress?.(processed, total)
  for await (const entry of entries) {
    const sessionId = sessions.get(entry.path)
    const file = files.get(entry.path)
    if (sessionId !== undefined) {
      const raw = await readJsonEntry(entry, (bytes, size) =>
        onProgress?.(processed, total, { bytes, total: size })
      )
      const session = readNativeSession(raw)
      if (session.id !== sessionId) {
        fail('backupIncomplete')
      }
      await db.addStagingSession(session)
      sessions.delete(entry.path)
    } else if (file) {
      if (entry.size !== file.size) {
        fail('backupIncomplete')
      }
      const blob = await readEntry(entry)
      await db.saveStagingFiles([{ id: file.id, blob: new Blob([blob], { type: file.type }) }])
      files.delete(entry.path)
    } else {
      fail('backupIncomplete')
    }
    onProgress?.(++processed, total)
  }
  if (sessions.size || files.size) {
    fail('backupIncomplete')
  }
  return {
    personas: manifest.personas,
    defaultPersonaId: manifest.defaultPersonaId,
    pricing: manifest.pricing,
  }
}

export const restoreNativeSettings = (settings: NativeBackupSettings | undefined): void => {
  if (settings) {
    restorePersonas(settings.personas, settings.defaultPersonaId)
    if (settings.pricing) {
      setPricing(settings.pricing)
    }
  }
}
