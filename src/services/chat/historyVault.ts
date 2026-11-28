import { create } from 'zustand'
import { blobBase64 } from '../../utils/blobBase64.js'
import { createId } from '../../utils/id.js'
import { logEvent } from '../diagnostics/log.js'
import * as db from './db.js'
import { jsonBlob } from './history/jsonBlob.js'
import { readJsonEntry } from './history/readJson.js'
import { BackupError } from './history/errors.js'
import { checkDiskOriginal, removeDiskOriginals } from './historyFiles.js'
import {
  historyVaultAvailable,
  NativeVault,
  type VaultStatus,
  type VaultOriginalEntry,
} from './historyVaultNative.js'
import { mapSessionFileIds, sessionOriginalIds } from './sessionData.js'
import type { Session } from './types.js'

export { historyVaultAvailable }
type Issue = 'space' | 'unreadable' | 'write' | 'changed' | 'busy'
type Phase = 'checking' | 'idle' | 'protecting' | 'restoring' | 'error'
type VaultState = {
  phase: Phase
  generation: number | null
  protectedSessions: number | null
  protectedOriginals: number | null
  protectedBytes: number | null
  missingOriginals: number | null
  totalSessions: number | null
  processed: number
  total: number
  lastVerifiedAt?: number
  issue?: Issue
}
export const useHistoryVault = create<VaultState>(() => ({
  phase: 'checking',
  generation: null,
  protectedSessions: null,
  protectedOriginals: null,
  missingOriginals: null,
  protectedBytes: null,
  totalSessions: null,
  processed: 0,
  total: 0,
}))
const set = useHistoryVault.setState
const chunkSize = 256 * 1024
let tail: Promise<unknown> = Promise.resolve()
let scan: Promise<boolean> | undefined
let scanVerifiesOriginals = false
let restore: Promise<RestoreResult | null> | undefined
let failureStage: string | undefined
const unsynchronized = new Set<string>()
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const result = tail.then(task, task)
  tail = result.catch(() => {})
  return result
}
const applyStatus = (state: VaultStatus) =>
  set({
    generation: state.generation,
    protectedSessions: state.sessionCount,
    protectedOriginals: state.originalCount,
    missingOriginals: state.missingOriginalCount,
    lastVerifiedAt: state.verifiedAt,
    protectedBytes: state.bytes,
  })
const failed = (error: unknown, stage: string) => {
  failureStage = stage
  const code = (error as { code?: string } | null)?.code
  const issue: Issue =
    code === 'NO_SPACE' || (error instanceof DOMException && error.name === 'QuotaExceededError')
      ? 'space'
      : code === 'UNREADABLE'
        ? 'unreadable'
        : code === 'CHANGED'
          ? 'changed'
          : code === 'BUSY'
            ? 'busy'
            : 'write'
  set({ phase: 'error', issue })
  logEvent('storage', 'history.vault-failed', { stage, reason: issue }, 'error')
}
const settledStatus = async (): Promise<VaultStatus> => {
  let state = await NativeVault.status()
  if (state.pendingId) {
    // Only an explicitly confirmed deletion/import may create a prepared batch. Its receipt is
    // written with the primary records. If the primary store disappeared, never resurrect a deletion.
    const proof = await db.vaultCommitProof()
    if (proof.id === state.pendingId || proof.emptyAfterLoss) {
      state = await NativeVault.commit({ id: state.pendingId })
    } else {
      await NativeVault.cancel({ id: state.pendingId })
      state = await NativeVault.status()
    }
  }
  applyStatus(state)
  return state
}

export const refreshHistoryVault = async () => {
  if (!historyVaultAvailable()) {
    return
  }
  try {
    await serial(settledStatus)
    const { useChatStore } = await import('./store.js')
    const primary = useChatStore.getState()
    const inspected = useHistoryVault.getState().phase === 'checking' || failureStage === 'inspect'
    if (failureStage === 'inspect') {
      failureStage = undefined
    }
    set({
      totalSessions: primary.ready && !primary.historyMissing ? primary.sessions.length : null,
      ...(inspected && !unsynchronized.size && { phase: 'idle', issue: undefined }),
    })
  } catch (error) {
    failed(error, 'inspect')
  }
}

async function* pages<T extends { id: string }>(
  generation: number,
  fetchPage: (options: {
    generation: number
    after?: string
    limit: number
  }) => Promise<{ items: T[]; next?: string }>
) {
  let after: string | undefined
  do {
    const page = await fetchPage({ generation, after, limit: 96 })
    if (!Array.isArray(page.items) || (page.next && (!page.items.length || page.next === after))) {
      throw new Error('Invalid recovery page')
    }
    yield* page.items
    after = page.next
  } while (after)
}

const writeBlob = async (id: string, blob: Blob) => {
  for (let start = 0; start < blob.size; start += chunkSize) {
    const data = await blobBase64(blob.slice(start, start + chunkSize))
    await NativeVault.append({ id, data })
  }
  await NativeVault.finishEntry({ id })
}
type Batch = {
  id: string
  generation: number
  staged: boolean
  originals: Set<string>
  knownOriginals?: Map<string, VaultOriginalEntry>
  verifyExisting?: boolean
  revisions: Map<string, string>
}
const storeSession = async (batch: Batch, sessionId: string) => {
  const saved = await db.vaultSession(sessionId, batch.staged)
  if (!saved) {
    if (batch.staged) {
      throw new Error('Staged chat unavailable')
    }
    return
  }
  const originalIds: string[] = [],
    missingIds: string[] = []
  for (const fileId of sessionOriginalIds(saved.session)) {
    if (!batch.originals.has(fileId)) {
      let file = await db.vaultOriginal(fileId, batch.staged)
      if (!batch.staged && file && 'disk' in file) {
        try {
          await checkDiskOriginal(file.disk)
        } catch (error) {
          if ((error as { code?: string } | null)?.code !== 'MISSING_ORIGINAL') {
            throw error
          }
          file = undefined
        }
      }
      if (!file) {
        if (!batch.staged && !batch.knownOriginals) {
          batch.knownOriginals = new Map()
          for await (const row of pages(batch.generation, (args) =>
            NativeVault.listOriginals(args)
          )) {
            batch.knownOriginals.set(row.id, row)
          }
        }
        const protectedFile = batch.knownOriginals?.get(fileId)
        if (!protectedFile) {
          missingIds.push(fileId)
          continue
        }
        if (batch.verifyExisting) {
          const { needsAppend } = await NativeVault.putOriginal({
            id: batch.id,
            fileId,
            size: protectedFile.size,
            type: protectedFile.type,
            sourceRevision: protectedFile.sourceRevision,
            sha256: protectedFile.sha256,
            verifyExisting: true,
          })
          if (needsAppend) {
            throw Object.assign(new Error('Original cannot be verified'), { code: 'UNREADABLE' })
          }
        }
      } else {
        const disk = 'disk' in file ? file.disk : undefined
        const source = 'blob' in file ? file.blob : file.disk
        const { needsAppend } = await NativeVault.putOriginal({
          id: batch.id,
          fileId,
          size: source.size,
          type: source.type,
          verifyExisting: batch.verifyExisting,
          ...(disk
            ? { diskKey: disk.key, sourceRevision: 'disk-' + disk.key }
            : { sourceRevision: file.revision }),
        })
        if (needsAppend) {
          if (!('blob' in file)) {
            throw new Error('Disk copy unfinished')
          }
          await writeBlob(batch.id, file.blob)
        }
      }
      batch.originals.add(fileId)
    }
    originalIds.push(fileId)
  }
  const body = jsonBlob(saved.session)
  await NativeVault.putSession({
    id: batch.id,
    sessionId,
    size: body.size,
    revision: saved.revision,
    originalIds,
    missingIds,
  })
  await writeBlob(batch.id, body)
  batch.revisions.set(sessionId, saved.revision)
}
const newBatch = async (mode: 'merge' | 'replace', staged: boolean): Promise<Batch> => {
  const { generation } = await settledStatus()
  const { id } = await NativeVault.begin({ mode, generation })
  return { id, generation, staged, originals: new Set(), revisions: new Map() }
}
const abort = (id: string) => NativeVault.cancel({ id }).catch(() => {})
const writeCurrent = (ids: readonly string[], verifyExisting = false) =>
  serial(async () => {
    const batch = await newBatch('merge', false)
    batch.verifyExisting = verifyExisting
    try {
      for (const id of ids) {
        await storeSession(batch, id)
      }
      if (!batch.revisions.size) {
        await NativeVault.cancel({ id: batch.id })
      } else {
        applyStatus(await NativeVault.commit({ id: batch.id }))
      }
      for (const id of ids) {
        unsynchronized.delete(id)
      }
    } catch (error) {
      await abort(batch.id)
      throw error
    }
  })

export const protectChangedSession = async (id: string) => {
  if (restore) {
    unsynchronized.add(id)
    return
  }
  try {
    if (!scan) {
      set({ phase: 'protecting', processed: 0, total: 1 })
    }
    await writeCurrent([id])
    const { useChatStore } = await import('./store.js')
    const main = useChatStore.getState()
    if (!scan && !restore) {
      set({
        phase: unsynchronized.size ? 'error' : 'idle',
        issue: unsynchronized.size ? (useHistoryVault.getState().issue ?? 'unreadable') : undefined,
        processed: 1,
        total: 1,
        totalSessions: main.ready ? main.sessions.length : null,
      })
    }
  } catch (error) {
    unsynchronized.add(id)
    // The primary history is committed. A failed independent copy can be retried without resending the chat.
    failed(error, 'protect-chat')
  }
}

export const protectAllHistory = (force = true): Promise<boolean> => {
  if (!historyVaultAvailable() || restore) {
    return Promise.resolve(false)
  }
  if (scan) {
    // A version-only startup pass must not satisfy a request to check the actual bytes.
    return force && !scanVerifiesOriginals ? scan.then(() => protectAllHistory(true)) : scan
  }
  scanVerifiesOriginals = force
  scan = (async () => {
    try {
      const { useChatStore } = await import('./store.js')
      const main = useChatStore.getState()
      if (!main.ready || main.historyMissing || main.importingHistory) {
        return false
      }
      const index = await db.vaultSessionIndex()
      const versions = await serial(async () => {
        const state = await settledStatus()
        const revisions = new Map<string, string>()
        if (!force) {
          for await (const row of pages(state.generation, (args) =>
            NativeVault.listSessions(args)
          )) {
            revisions.set(row.id, row.revision)
          }
        }
        return revisions
      })
      const work = index.filter(
        (row) => force || unsynchronized.has(row.id) || versions.get(row.id) !== row.revision
      )
      for (const row of work) {
        unsynchronized.add(row.id)
      }
      set({
        phase: 'protecting',
        totalSessions: index.length,
        processed: index.length - work.length,
        total: index.length,
        issue: undefined,
      })
      for (let i = 0; i < work.length; i += 16) {
        if (useChatStore.getState().importingHistory || restore) {
          if (!restore) {
            set({ phase: 'idle' })
          }
          return false
        }
        const ids = work.slice(i, i + 16).map((row) => row.id)
        try {
          await writeCurrent(ids, force)
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          if (code === 'NO_SPACE' || code === 'BUSY' || code === 'CHANGED') {
            throw error
          }
          for (const id of ids) {
            try {
              await writeCurrent([id], force)
            } catch (individual) {
              unsynchronized.add(id)
              failed(individual, 'protect-chat')
            }
          }
        }
        set({ processed: index.length - work.length + Math.min(work.length, i + 16) })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      if (unsynchronized.size) {
        set({ phase: 'error', issue: useHistoryVault.getState().issue ?? 'unreadable' })
        return false
      }
      set({ phase: 'idle', issue: undefined })
      logEvent('storage', 'history.vault-protected', {
        sessionCount: index.length,
        updatedCount: work.length,
      })
      return true
    } catch (error) {
      failed(error, 'protect-history')
      return false
    }
  })().finally(() => {
    scan = undefined
    scanVerifiesOriginals = false
  })
  return scan
}

const protectMutation = <T>(
  mode: 'merge' | 'replace',
  stage: (batch: Batch) => Promise<void>,
  apply: (receipt: db.VaultReceipt) => Promise<T>
): Promise<T> =>
  serial(async () => {
    const protectionError = (error: unknown) =>
      new BackupError(
        (error as { code?: string } | null)?.code === 'NO_SPACE'
          ? 'backupProtectionNoSpace'
          : 'backupProtectionFailed'
      )
    const batch = await newBatch(mode, true).catch((error) => {
      failed(error, 'open-change')
      throw protectionError(error)
    })
    let primaryCommitted = false
    let prepared = false
    try {
      await stage(batch)
      await NativeVault.prepare({ id: batch.id })
      prepared = true
      const result = await apply({ id: batch.id, revisions: batch.revisions })
      primaryCommitted = true
      try {
        applyStatus(await NativeVault.commit({ id: batch.id }))
        if (mode === 'replace') {
          unsynchronized.clear()
        } else {
          for (const id of batch.revisions.keys()) {
            unsynchronized.delete(id)
          }
        }
        set({
          phase: unsynchronized.size ? 'error' : 'idle',
          issue: unsynchronized.size
            ? (useHistoryVault.getState().issue ?? 'unreadable')
            : undefined,
        })
      } catch (error) {
        // Preserve the prepared transaction for reconciliation after a crash or failed final write.
        failed(error, 'commit-after-primary')
      }
      return result
    } catch (error) {
      if (!primaryCommitted) {
        await abort(batch.id)
      }
      failed(error, 'prepare-change')
      throw prepared ? error : protectionError(error)
    }
  })
export const protectDeletion = async <T>(
  sessionId: string,
  apply: (receipt: db.VaultReceipt) => Promise<T>
) => {
  const result = await protectMutation(
    'merge',
    (batch) => NativeVault.deleteSession({ id: batch.id, sessionId }),
    apply
  )
  unsynchronized.delete(sessionId)
  return result
}
export const protectStagedChange = <T>(
  mode: 'merge' | 'replace',
  keep: ReadonlySet<string> | undefined,
  apply: (receipt: db.VaultReceipt) => Promise<T>
) =>
  protectMutation(
    mode,
    async (batch) => {
      const rows = (await db.vaultSessionIndex(true)).filter((row) => !keep?.has(row.id))
      set({ phase: 'protecting', processed: 0, total: rows.length })
      for (let i = 0; i < rows.length; i++) {
        await storeSession(batch, rows[i].id)
        set({ processed: i + 1 })
      }
    },
    apply
  )

type RestoreResult = { sessions: number; originals: number; kept: number; missing: number }
async function* readBody(generation: number, sessionId: string, bytes: number) {
  let offset = 0
  while (offset < bytes) {
    const part = await NativeVault.readSession({ generation, sessionId, offset, limit: chunkSize })
    const binary = atob(part.data)
    if (
      !binary.length ||
      binary.length > chunkSize ||
      part.nextOffset !== offset + binary.length ||
      part.nextOffset > bytes ||
      part.eof !== (part.nextOffset === bytes)
    ) {
      throw new Error('Incomplete recovery record')
    }
    yield Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    offset = part.nextOffset
  }
}
export const restoreHistoryVault = ({ automatic = false } = {}): Promise<RestoreResult | null> => {
  if (!historyVaultAvailable()) {
    return Promise.resolve(null)
  }
  if (restore) {
    return restore
  }
  let recovered = false
  restore = (async () => {
    const created: string[] = []
    try {
      const state = await serial(settledStatus)
      if (!state.sessionCount) {
        if (automatic) {
          logEvent('storage', 'history.auto-restore-unavailable', { reason: 'no-backup' })
        }
        return null
      }
      set({
        phase: 'restoring',
        processed: 0,
        total: state.sessionCount + state.originalCount,
        issue: undefined,
      })
      const { mergeHistory } = await import('./store.js')
      let savedCount = 0,
        kept = 0,
        originals = 0
      const required = new Map<string, string>()
      const keptMissing = new Map<string, string | null>()
      const repairs = new Map<string, string | null>()
      const supplied = new Set<string>()
      const restored = await mergeHistory(
        (reserved) =>
          serial(async () => {
            // A queued write can advance the vault while mergeHistory waits for local writes.
            // Read one generation and keep it stable until all originals are staged.
            const state = await settledStatus()
            set({ total: state.sessionCount + state.originalCount })
            const existing = new Set((await db.vaultSessionIndex()).map((row) => row.id))
            for await (const row of pages(state.generation, (args) =>
              NativeVault.listSessions(args)
            )) {
              if (existing.has(row.id)) {
                kept++
                const current = await db.vaultSession(row.id, false)
                if (!current) {
                  throw new Error('Existing chat changed during recovery')
                }
                for (const id of sessionOriginalIds(current.session)) {
                  if (keptMissing.has(id)) {
                    continue
                  }
                  const file = await db.vaultOriginal(id, false)
                  if (!file) {
                    keptMissing.set(id, null)
                  } else if ('disk' in file) {
                    try {
                      await checkDiskOriginal(file.disk)
                    } catch {
                      keptMissing.set(id, file.disk.key)
                    }
                  }
                }
              } else {
                const session = (await readJsonEntry(
                  {
                    path: 'session.json',
                    size: row.size,
                    stream: readBody(state.generation, row.id, row.size),
                  },
                  undefined,
                  'local'
                )) as Session
                if (!session || session.id !== row.id || !Array.isArray(session.messages)) {
                  throw new Error('Invalid recovery conversation')
                }
                for (const id of sessionOriginalIds(session)) {
                  if (!required.has(id)) {
                    required.set(id, reserved.has(id) ? createId() : id)
                  }
                }
                await db.addStagingSession(mapSessionFileIds(session, (id) => required.get(id) ?? id))
                savedCount++
              }
              set({ processed: savedCount + kept })
            }
            if (savedCount + kept !== state.sessionCount) {
              throw new Error('Incomplete recovery index')
            }
            let listed = 0
            for await (const row of pages(state.generation, (args) =>
              NativeVault.listOriginals(args)
            )) {
              listed++
              const mapped = required.get(row.id)
              const destinations = new Set<string>()
              if (mapped) {
                destinations.add(mapped)
              }
              if (keptMissing.has(row.id)) {
                destinations.add(row.id)
                repairs.set(row.id, keptMissing.get(row.id) ?? null)
              }
              for (const id of destinations) {
                const key = createId()
                const disk = await NativeVault.restoreOriginal({
                  generation: state.generation,
                  fileId: row.id,
                  key,
                })
                created.push(key)
                if (disk.key !== key || disk.size !== row.size || disk.sha256 !== row.sha256) {
                  throw new Error('Incomplete recovered original')
                }
                await db.saveStagingDiskFile(id, { key, size: disk.size, type: disk.type })
              }
              if (destinations.size) {
                originals++
                supplied.add(row.id)
              }
              set({ processed: state.sessionCount + listed })
            }
            if (listed !== state.originalCount) {
              throw new Error('Incomplete original index')
            }
          }),
        async () => (savedCount || kept ? new Set<string>() : null),
        () => removeDiskOriginals(created),
        repairs,
        { onlyAfterLoss: automatic }
      )
      if (!restored) {
        set({ phase: 'idle' })
        return null
      }
      const wanted = new Set([...required.keys(), ...keptMissing.keys()])
      const result = {
        sessions: restored.added,
        originals,
        kept: kept + restored.kept,
        missing: wanted.size - supplied.size,
      }
      recovered = true
      set({ phase: 'idle', totalSessions: restored.summaries.length, issue: undefined })
      logEvent('storage', 'history.vault-restored', { ...result, automatic })
      return result
    } catch (error) {
      failed(error, automatic ? 'restore-automatic' : 'restore')
      return null
    }
  })().finally(() => {
    restore = undefined
    if (recovered) {
      void protectAllHistory(false)
    }
  })
  return restore
}
