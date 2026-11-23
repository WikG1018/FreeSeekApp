import type { SearchOutput } from '../api/searchTool.js'
import type { TaskWebError } from './publicWeb.js'

export type TaskSourceKind = 'web' | 'github' | 'browser' | 'attachment'

export type TaskEvidence = {
  sourceId: string
  kind: TaskSourceKind
  title: string
  url?: string
  revision?: string
  path?: string
  retrievedAt?: number
  downloadedBytes?: number
  availableChars?: number
  deliveredChars?: number
  characterRange?: { start: number; end: number }
  excerpt?: string
  range?: { start: number; end: number; unit: 'characters' | 'lines' }
  partial: boolean
  sourceTruncated?: boolean
  nextOffset?: number
  nextCursor?: string
}

export type TaskReadReason =
  | TaskWebError
  | 'read-budget'
  | 'invalid-arguments'
  | 'empty-range'
  | 'unverified-revision'
  | 'attachment-missing'
  | 'attachment-unreadable'
  | 'source-truncated'
  | 'project-patch-rejected'
  | 'project-archive-invalid'
  | 'project-workspace-missing'
  | 'project-outdated'
  | 'project-script-error'
  | 'project-timeout'
  | 'project-runtime-unavailable'
  | 'model-invalid'
  | 'artifact-save-failed'
  | 'external-denied'
  | 'external-failed'

export type TaskReadResult = SearchOutput & {
  assertions?: number
  source?: string
  failure?: TaskWebError
  reason?: TaskReadReason
  retryAt?: number
  evidence?: TaskEvidence
  output?: string
}

/** Persisted sources contain inert text and validated identifiers, never browser HTML. */
export type TaskCachedSource = {
  key: string
  evidence: TaskEvidence
  text: string
  links: string[]
  nextCursor?: string
}

export type TaskCachedBrowserPage = {
  url: string
  title: string
  text: string
  links: { label: string; url: string }[]
  headings: string[]
  sourceTruncated: boolean
  bytes?: number
  retrievedAt?: number
  requestedUrl?: string
  mode: 'static' | 'rendered'
  renderNotice?: 'rendering-unavailable' | 'rendering-timeout'
}

export type TaskReadCheckpoint = {
  version: 1
  web?: {
    pins: Array<[string, string]>
    sources: TaskCachedSource[]
    retryAt?: number
  }
  browser?: {
    pages: TaskCachedBrowserPage[]
    currentUrl?: string
    currentIndex?: number
    offset: number
  }
}

export const MAX_WEB_CHECKPOINT_BYTES = 512 * 1024
export const MAX_BROWSER_CHECKPOINT_BYTES = 256 * 1024
export const MAX_SOURCE_CHARS = 1024 * 1024

export const sourceIdFor = (kind: TaskSourceKind, key: string) => kind + ':' + key

export const utf8Size = (value: string) => new TextEncoder().encode(value).byteLength

export const fitCheckpointEntries = <T>(
  newestFirst: Iterable<T>,
  bytes: number,
  count: number
): T[] => {
  const retained: T[] = []
  for (const item of newestFirst) {
    if (retained.length >= count) {
      break
    }
    const cost = utf8Size(JSON.stringify(item)) + 1
    if (cost <= bytes) {
      retained.push(item)
      bytes -= cost
    }
  }
  return retained
}
