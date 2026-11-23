import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { createId } from '../../utils/id.js'
import { commitSha, githubRepo } from './githubRead.js'
import { publicWebUrl, readPublicWeb } from './publicWeb.js'
import {
  openProjectArchive,
  ProjectSourceError,
  workspaceLimits,
  type SourceProject,
} from './projectFiles.js'
import { createWorkspace } from './workspaces.js'

const Native = registerPlugin<{
  pickFolder(options: {
    id: string
  }): Promise<{ path?: string; name?: string; cancelled?: boolean }>
  githubArchive(options: {
    id: string
    repository: string
    revision: string
  }): Promise<{ path: string }>
  discard(options: { id: string }): Promise<void>
  captureReader(options: {
    id: string
    left: number
    top: number
    width: number
    height: number
    ratio: number
  }): Promise<{ path: string }>
  scheduleReminder(options: {
    sessionId: string
    at: number
    daily: boolean
    chinese: boolean
  }): Promise<{ scheduled: boolean; permission?: boolean }>
  getReminder(options: { sessionId: string }): Promise<{ at?: number; daily?: boolean }>
  cancelReminder(options: { sessionId: string }): Promise<void>
  cancelAllReminders(): Promise<void>
  reminderTarget(): Promise<{ sessionId?: string }>
  addListener(
    event: 'reminder',
    listener: (result: { sessionId?: string }) => void
  ): Promise<PluginListenerHandle>
  cancel(options: { id: string }): Promise<void>
  preview(options: {
    id: string
    entry: string
    files: SourceProject
    label: string
    back: string
    dark: boolean
    loading: string
    failed: string
  }): Promise<void>
}>('WorkspaceFiles')

export const workspaceDeviceFiles = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('WorkspaceFiles')

type Progress = (done: number, total: number) => void
const importStage = async (
  start: (id: string) => Promise<{ path?: string; name?: string; cancelled?: boolean }>,
  signal: AbortSignal,
  progress: Progress,
  stripRoot = false
) => {
  signal.throwIfAborted()
  const id = createId()
  const cancel = () => {
    void Native.cancel({ id }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await start(id)
    signal.throwIfAborted()
    if (result.cancelled) {
      return undefined
    }
    if (!result.path) {
      throw new Error('Workspace staging did not produce a file')
    }
    const response = await fetch(Capacitor.convertFileSrc(result.path), { signal })
    if (!response.ok) {
      throw new Error('Unable to read staged project')
    }
    const files = await openProjectArchive(
      await response.blob(),
      signal,
      workspaceLimits,
      progress,
      stripRoot
    )
    return { files, name: result.name }
  } catch (error) {
    if ((error as { code?: string })?.code === 'WORKSPACE_LIMIT') {
      throw new ProjectSourceError('limits', 'The folder exceeds the project limits.')
    }
    if ((error as { code?: string })?.code === 'WORKSPACE_PATH') {
      throw new ProjectSourceError('paths', 'A folder name is not supported.')
    }
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    await Native.discard({ id }).catch(() => {})
  }
}

export const importWorkspaceFolder = async (
  fallbackName: string,
  signal: AbortSignal,
  progress: Progress
) => {
  const result = await importStage((id) => Native.pickFolder({ id }), signal, progress)
  return (
    result && createWorkspace(result.name?.trim() || fallbackName, result.files, undefined, signal)
  )
}

export const importGithubWorkspace = async (
  input: string,
  ref: string,
  signal: AbortSignal,
  progress: Progress
) => {
  const url = publicWebUrl(input.trim())
  const repo = url && githubRepo(url)
  if (!repo || ref.length > 110 || !workspaceDeviceFiles()) {
    throw new Error('Choose a public GitHub repository')
  }
  const revisionLookup = new URL(
    'https://api.github.com/repos/' +
      repo.namespace +
      '/commits/' +
      encodeURIComponent(ref.trim() || 'HEAD')
  )
  const pin = await readPublicWeb(revisionLookup, false, signal, 10_000, { sameOrigin: true })
  if ('error' in pin || pin.truncated) {
    throw new Error('Could not resolve the repository revision')
  }
  const revision = (JSON.parse(pin.text) as { sha?: unknown }).sha
  if (!commitSha(revision)) {
    throw new Error('GitHub did not return a commit hash')
  }
  const staged = await importStage(
    (id) => Native.githubArchive({ id, repository: repo.namespace, revision }),
    signal,
    progress,
    true
  )
  if (!staged?.files.length) {
    throw new Error('No source files were imported')
  }
  return createWorkspace(
    repo.namespace.split('/')[1],
    staged.files,
    {
      repository: repo.namespace,
      revision,
    },
    signal
  )
}

export const openWorkspacePreview = (
  files: SourceProject,
  entry: string,
  display: { label: string; back: string; dark: boolean; loading: string; failed: string }
) => Native.preview({ id: createId(), files, entry, ...display })

export const captureReader = async (area: DOMRect) => {
  const id = createId()
  try {
    const { path } = await Native.captureReader({
      id,
      left: area.left,
      top: area.top,
      width: area.width,
      height: area.height,
      ratio: devicePixelRatio,
    })
    const response = await fetch(Capacitor.convertFileSrc(path))
    if (!response.ok) {
      throw new Error('Reading image unavailable')
    }
    return new Blob([await response.blob()], { type: 'image/png' })
  } finally {
    await Native.discard({ id }).catch(() => {})
  }
}

export const scheduleTaskReminder = (
  sessionId: string,
  at: number,
  daily: boolean,
  chinese: boolean
) => Native.scheduleReminder({ sessionId, at, daily, chinese })
export const readTaskReminder = (sessionId: string) => Native.getReminder({ sessionId })
export const cancelTaskReminder = (sessionId: string) => Native.cancelReminder({ sessionId })
export const cancelAllTaskReminders = () => Native.cancelAllReminders()
export const reminderTarget = () => Native.reminderTarget()
export const onReminderTarget = (listener: (result: { sessionId?: string }) => void) =>
  Native.addListener('reminder', listener)
