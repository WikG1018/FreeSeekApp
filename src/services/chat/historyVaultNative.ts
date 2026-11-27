import { Capacitor, registerPlugin } from '@capacitor/core'

export const historyVaultAvailable = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('HistoryVault')

export type VaultStatus = {
  generation: number
  sessionCount: number
  originalCount: number
  missingOriginalCount: number
  bytes: number
  verifiedAt?: number
  pendingId?: string
}
type SessionEntry = { id: string; size: number; sha256: string; revision: string }
export type VaultOriginalEntry = {
  id: string
  size: number
  sha256: string
  type: string
  sourceRevision?: string
}
type PageArgs = { generation: number; after?: string; limit: number }
type Part = { id: string }
export const NativeVault = registerPlugin<{
  status(): Promise<VaultStatus>
  begin(options: { mode: 'merge' | 'replace'; generation: number }): Promise<Part>
  putSession(
    options: Part & {
      sessionId: string
      size: number
      originalIds: string[]
      missingIds: string[]
      revision: string
    }
  ): Promise<void>
  putOriginal(
    options: Part & {
      fileId: string
      size: number
      type: string
      sourceRevision?: string
      sha256?: string
      diskKey?: string
      verifyExisting?: boolean
    }
  ): Promise<{ needsAppend: boolean }>
  append(options: Part & { data: string }): Promise<void>
  finishEntry(options: Part): Promise<void>
  deleteSession(options: Part & { sessionId: string }): Promise<void>
  prepare(options: Part): Promise<void>
  commit(options: Part): Promise<VaultStatus>
  cancel(options: Part): Promise<void>
  listSessions(options: PageArgs): Promise<{ items: SessionEntry[]; next?: string }>
  listOriginals(options: PageArgs): Promise<{ items: VaultOriginalEntry[]; next?: string }>
  readSession(options: {
    generation: number
    sessionId: string
    offset: number
    limit: number
  }): Promise<{ data: string; nextOffset: number; eof: boolean }>
  restoreOriginal(options: {
    generation: number
    fileId: string
    key: string
  }): Promise<{ key: string; size: number; type: string; sha256: string }>
}>('HistoryVault')
