import { openDB, type DBSchema } from 'idb'
import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { logEvent } from '../diagnostics/log.js'
import {
  patchProject,
  validateProject,
  validProjectPath,
  workspaceLimits,
  type SourceProject,
} from './projectFiles.js'

export type Workspace = {
  id: string
  name: string
  fileCount: number
  createdAt: number
  updatedAt: number
  revision: number
  source?: { repository: string; revision: string }
}

export type WorkspaceChange = {
  path: string
  before: string | null
  after: string | null
}

type ChangeKind = 'patch' | 'import' | 'restore'
export type WorkspaceRevision = {
  workspaceId: string
  revision: number
  createdAt: number
  kind: ChangeKind
  changes: WorkspaceChange[]
  operation?: string
}

export type WorkspaceRevisionSummary = Pick<
  WorkspaceRevision,
  'workspaceId' | 'revision' | 'createdAt' | 'kind'
> & { fileCount: number }

const summarizeRevision = ({
  workspaceId,
  revision,
  createdAt,
  kind,
  changes,
}: WorkspaceRevision): WorkspaceRevisionSummary => ({
  workspaceId,
  revision,
  createdAt,
  kind,
  fileCount: changes.length,
})

type WorkspaceFile = { workspaceId: string; path: string; text: string }
interface WorkspaceDb extends DBSchema {
  workspaces: { key: string; value: Workspace }
  files: {
    key: [string, string]
    value: WorkspaceFile
    indexes: { workspace: string }
  }
  revisions: { key: [string, number]; value: WorkspaceRevision }
  revisionSummaries: { key: [string, number]; value: WorkspaceRevisionSummary }
}

const database = () =>
  openDB<WorkspaceDb>('freeseek-workspaces', 2, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion === 0) {
        db.createObjectStore('workspaces', { keyPath: 'id' })
        db.createObjectStore('files', { keyPath: ['workspaceId', 'path'] }).createIndex(
          'workspace',
          'workspaceId'
        )
        db.createObjectStore('revisions', { keyPath: ['workspaceId', 'revision'] })
      }
      const summaries = db.createObjectStore('revisionSummaries', {
        keyPath: ['workspaceId', 'revision'],
      })
      if (oldVersion === 1) {
        void (async () => {
          try {
            const revisions = tx.objectStore('revisions')
            for (
              let cursor = await revisions.openCursor();
              cursor;
              cursor = await cursor.continue()
            ) {
              await summaries.add(summarizeRevision(cursor.value))
            }
          } catch {
            tx.abort()
          }
        })()
      }
    },
    blocking(_current, _blocked, event) {
      const db = event.target as IDBDatabase
      db.close()
      connection = undefined
    },
    terminated() {
      connection = undefined
    },
  })
let connection: ReturnType<typeof database> | undefined
const open = () =>
  (connection ??= database().catch((error: unknown) => {
    connection = undefined
    throw error
  }))

export const useWorkspaces = create<{ items: Workspace[] }>(() => ({ items: [] }))
const byTime = (left: Workspace, right: Workspace) => right.updatedAt - left.updatedAt
const receive = (workspace: Workspace) =>
  useWorkspaces.setState(({ items }) => ({
    items: [...items.filter(({ id }) => id !== workspace.id), workspace].sort(byTime),
  }))

export const refreshWorkspaces = async () => {
  const items = (await (await open()).getAll('workspaces')).sort(byTime)
  useWorkspaces.setState({ items })
  return items
}

export const getWorkspace = async (id: string) => (await open()).get('workspaces', id)
const projectFiles = (files: WorkspaceFile[]): SourceProject =>
  files.map(({ path, text }) => ({ path, text }))

export const readWorkspace = async (id: string, only?: string) => {
  const tx = (await open()).transaction(['workspaces', 'files'])
  const [workspace, files] = await Promise.all([
    tx.objectStore('workspaces').get(id),
    only
      ? tx
          .objectStore('files')
          .get([id, only])
          .then((found) => (found ? [found] : []))
      : tx.objectStore('files').index('workspace').getAll(id),
  ])
  await tx.done
  return workspace && { workspace, files: projectFiles(files) }
}

const revisionRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Infinity])

export const workspaceRevisions = async (id: string, limit = 40) => {
  const db = await open()
  const tx = db.transaction('revisionSummaries')
  const revisions: WorkspaceRevisionSummary[] = []
  let cursor = await tx.store.openCursor(revisionRange(id), 'prev')
  while (cursor && revisions.length < limit) {
    revisions.push(cursor.value)
    cursor = await cursor.continue()
  }
  await tx.done
  return revisions
}

export const getWorkspaceRevision = async (id: string, revision: number) =>
  (await open()).get('revisions', [id, revision])

const insertWorkspace = async (
  workspace: Workspace,
  files: SourceProject,
  revisions: WorkspaceRevision[],
  signal?: AbortSignal
) => {
  const db = await open()
  signal?.throwIfAborted()
  const tx = db.transaction(['workspaces', 'files', 'revisions', 'revisionSummaries'], 'readwrite')
  await Promise.all([
    tx.objectStore('workspaces').add(workspace),
    ...files.map((file) => tx.objectStore('files').add({ ...file, workspaceId: workspace.id })),
    ...revisions.flatMap((entry) => {
      const revision = { ...entry, workspaceId: workspace.id }
      return [
        tx.objectStore('revisions').add(revision),
        tx.objectStore('revisionSummaries').add(summarizeRevision(revision)),
      ]
    }),
    tx.done,
  ])
  receive(workspace)
  logEvent('storage', 'workspace.created', { fileCount: workspace.fileCount })
  return workspace
}

export const createWorkspace = async (
  name: string,
  files: SourceProject = [],
  source?: Workspace['source'],
  signal?: AbortSignal
) => {
  validateProject(files, workspaceLimits)
  const now = Date.now()
  return insertWorkspace(
    {
      id: createId(),
      name: name.trim().slice(0, 80) || 'Project',
      fileCount: files.length,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      source,
    },
    files,
    [],
    signal
  )
}

export class WorkspaceConflict extends Error {
  constructor() {
    super('The project changed. Read the latest files and try again.')
    this.name = 'WorkspaceConflict'
  }
}

const differences = (current: SourceProject, next: SourceProject): WorkspaceChange[] => {
  const after = new Map(next.map(({ path, text }) => [path, text]))
  const changes: WorkspaceChange[] = []
  for (const { path, text } of current) {
    const value = after.get(path) ?? null
    if (value !== text) {
      changes.push({ path, before: text, after: value })
    }
    after.delete(path)
  }
  for (const [path, text] of after) {
    changes.push({ path, before: null, after: text })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

const changeWorkspace = async (
  id: string,
  expected: number,
  kind: ChangeKind,
  transform: (files: SourceProject) => SourceProject,
  signal?: AbortSignal,
  operation?: string
) => {
  const db = await open()
  signal?.throwIfAborted()
  const tx = db.transaction(['workspaces', 'files', 'revisions', 'revisionSummaries'], 'readwrite')
  const workspaces = tx.objectStore('workspaces')
  const files = tx.objectStore('files')
  const revisions = tx.objectStore('revisions')
  const workspace = await workspaces.get(id)
  if (!workspace) {
    throw new Error('The linked project is missing on this device.')
  }
  if (operation && (await revisions.get([id, workspace.revision]))?.operation === operation) {
    await tx.done
    return workspace
  }
  if (workspace.revision !== expected) {
    throw new WorkspaceConflict()
  }
  const current = projectFiles(await files.index('workspace').getAll(id))
  const next = validateProject(transform(current), workspaceLimits)
  signal?.throwIfAborted()
  const changes = differences(current, next)
  if (!changes.length) {
    await tx.done
    return workspace
  }
  const updated: Workspace = {
    ...workspace,
    revision: expected + 1,
    updatedAt: Date.now(),
    fileCount: next.length,
  }
  const record: WorkspaceRevision = {
    workspaceId: id,
    revision: updated.revision,
    createdAt: updated.updatedAt,
    kind,
    changes,
    operation,
  }
  await Promise.all([
    workspaces.put(updated),
    revisions.add(record),
    tx.objectStore('revisionSummaries').add(summarizeRevision(record)),
    ...changes.map(({ path, after }) =>
      after === null ? files.delete([id, path]) : files.put({ workspaceId: id, path, text: after })
    ),
    tx.done,
  ])
  receive(updated)
  logEvent('storage', 'workspace.updated', {
    fileCount: updated.fileCount,
    count: changes.length,
    versionCode: updated.revision,
  })
  return updated
}

export const applyWorkspacePatch = (
  id: string,
  expected: number,
  patch: string,
  signal: AbortSignal,
  operation?: string
) =>
  changeWorkspace(
    id,
    expected,
    'patch',
    (files) => patchProject(files, patch, workspaceLimits),
    signal,
    operation
  )

export const replaceWorkspaceFiles = (
  id: string,
  expected: number,
  files: SourceProject,
  signal: AbortSignal
) => changeWorkspace(id, expected, 'import', () => files, signal)

export const undoWorkspaceRevision = (
  id: string,
  expected: number,
  revision: WorkspaceRevision
) => {
  if (revision.workspaceId !== id) {
    return Promise.reject(new WorkspaceConflict())
  }
  return changeWorkspace(id, expected, 'restore', (files) => {
    const current = new Map(files.map(({ path, text }) => [path, text]))
    for (const { path, before, after } of revision.changes) {
      if ((current.get(path) ?? null) !== after) {
        throw new WorkspaceConflict()
      }
      if (before === null) {
        current.delete(path)
      } else {
        current.set(path, before)
      }
    }
    return [...current].map(([path, text]) => ({ path, text }))
  })
}

const backupLimit = 64 * 1024 * 1024

export class WorkspaceBackupLimit extends Error {
  constructor() {
    super('Project backup exceeds the supported size.')
    this.name = 'WorkspaceBackupLimit'
  }
}

export const exportWorkspaceBackup = async (id: string) => {
  const tx = (await open()).transaction(['workspaces', 'files', 'revisions'])
  const [workspace, files] = await Promise.all([
    tx.objectStore('workspaces').get(id),
    tx.objectStore('files').index('workspace').getAll(id),
  ])
  if (!workspace) {
    throw new Error('Project missing')
  }
  const header = JSON.stringify({
    kind: 'freeseek-project',
    version: 1,
    workspace,
    files: projectFiles(files),
  })
  const parts = [new Blob([header.slice(0, -1), ',"revisions":['])]
  let size = parts[0].size + 2
  const history = tx.objectStore('revisions')
  for (
    let cursor = await history.openCursor(revisionRange(id));
    cursor;
    cursor = await cursor.continue()
  ) {
    const part = new Blob([parts.length > 1 ? ',' : '', JSON.stringify(cursor.value)])
    size += part.size
    if (size > backupLimit) {
      throw new WorkspaceBackupLimit()
    }
    parts.push(part)
  }
  await tx.done
  return new Blob([...parts, ']}'], { type: 'application/json' })
}

export const importWorkspaceBackup = async (blob: Blob, signal: AbortSignal) => {
  if (blob.size > backupLimit) {
    throw new WorkspaceBackupLimit()
  }
  return importWorkspaceSnapshot(JSON.parse(await blob.text()), signal)
}

export const importWorkspaceSnapshot = async (
  snapshot: unknown,
  signal: AbortSignal,
  expected?: string
) => {
  const data = snapshot as {
    kind?: unknown
    version?: unknown
    workspace: Workspace
    files: SourceProject
    revisions: WorkspaceRevision[]
  }
  signal.throwIfAborted()
  const { workspace, files, revisions } = data
  if (
    data.kind !== 'freeseek-project' ||
    data.version !== 1 ||
    !workspace ||
    typeof workspace.id !== 'string' ||
    (expected !== undefined && expected !== workspace.id) ||
    !/^[a-z0-9-]{1,64}$/i.test(workspace.id) ||
    typeof workspace.name !== 'string' ||
    !workspace.name.trim() ||
    workspace.name.length > 80 ||
    !Array.isArray(files) ||
    !files.every((file) => typeof file?.path === 'string' && typeof file.text === 'string') ||
    !Array.isArray(revisions) ||
    revisions.length !== workspace.revision
  ) {
    throw new Error('Invalid project backup')
  }
  validateProject(files, workspaceLimits)
  const state = new Map(files.map(({ path, text }) => [path, text]))
  const chain: WorkspaceRevision[] = []
  for (let index = revisions.length - 1; index >= 0; index--) {
    const item = revisions[index]
    if (
      item?.revision !== index + 1 ||
      !Number.isFinite(item.createdAt) ||
      !['patch', 'import', 'restore'].includes(item.kind) ||
      !Array.isArray(item.changes) ||
      item.changes.length > workspaceLimits.files * 2
    ) {
      throw new Error('Invalid project revision')
    }
    const seen = new Set<string>()
    for (const change of item.changes) {
      if (
        typeof change?.path !== 'string' ||
        !validProjectPath(change.path) ||
        seen.has(change.path) ||
        change.before === change.after ||
        (change.before !== null && typeof change.before !== 'string') ||
        (change.after !== null && typeof change.after !== 'string') ||
        (state.get(change.path) ?? null) !== change.after
      ) {
        throw new Error('Invalid project revision')
      }
      seen.add(change.path)
      if (change.before === null) {
        state.delete(change.path)
      } else {
        state.set(change.path, change.before)
      }
    }
    validateProject(
      [...state].map(([path, text]) => ({ path, text })),
      workspaceLimits
    )
    chain.push({
      workspaceId: workspace.id,
      revision: item.revision,
      createdAt: item.createdAt,
      kind: item.kind,
      changes: item.changes.map(({ path, before, after }) => ({ path, before, after })),
    })
    signal.throwIfAborted()
  }
  const saved = await getWorkspace(workspace.id)
  const id = saved ? createId() : workspace.id
  return insertWorkspace(
    {
      id,
      name: workspace.name,
      fileCount: files.length,
      createdAt: Number.isFinite(workspace.createdAt) ? workspace.createdAt : Date.now(),
      updatedAt: Date.now(),
      revision: revisions.length,
      ...(workspace.source &&
        typeof workspace.source.repository === 'string' &&
        /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(workspace.source.repository) &&
        /^[a-f0-9]{40}$/i.test(workspace.source.revision) && {
          source: { repository: workspace.source.repository, revision: workspace.source.revision },
        }),
    },
    files.map(({ path, text }) => ({ path, text })),
    chain.reverse(),
    signal
  )
}

/** Roll back copies created by the current history import. Existing projects are never replaced. */
export const discardImportedWorkspaces = async (ids: Iterable<string>) => {
  const imported = [...ids]
  if (!imported.length) {
    return
  }
  const tx = (await open()).transaction(
    ['workspaces', 'files', 'revisions', 'revisionSummaries'],
    'readwrite'
  )
  const files = tx.objectStore('files')
  for (const id of imported) {
    const keys = await files.index('workspace').getAllKeys(id)
    await Promise.all([
      tx.objectStore('workspaces').delete(id),
      tx.objectStore('revisions').delete(revisionRange(id)),
      tx.objectStore('revisionSummaries').delete(revisionRange(id)),
      ...keys.map((key) => files.delete(key)),
    ])
  }
  await tx.done
  const removed = new Set(imported)
  useWorkspaces.setState(({ items }) => ({ items: items.filter(({ id }) => !removed.has(id)) }))
}
