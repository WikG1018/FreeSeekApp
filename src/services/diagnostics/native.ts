import { registerPlugin } from '@capacitor/core'
import type { DiagnosticEvent } from './log.js'

export type RetainedClientSnapshot = {
  events: unknown[]
  limit: number
  historyReserve: number
  issueReserve: number
  readState: 'empty' | 'available' | 'size-limit' | 'unreadable'
  failedWrites: number
  evicted: number
  expired: number
  rejected: number
}

export type NativeLogSnapshot = {
  events: unknown[]
  failedWrites: number
  readFailure?: 'size-limit' | 'unreadable'
  retainedClient?: RetainedClientSnapshot
  historyCheckpoint?: { present: boolean; sessionCount?: number; verifiedAt?: number }
}
export type NativeSnapshot = NativeLogSnapshot & { environment: Record<string, unknown> }
export const NativeDiagnostics = registerPlugin<{
  checkHistory: () => Promise<{ present: boolean; sessionCount?: number; verifiedAt?: number }>
  recordHistory: (options: { present: boolean; sessionCount?: number }) => Promise<void>
  retainClientEvents: (options: { events: DiagnosticEvent[] }) => Promise<void>
  snapshot: () => Promise<NativeSnapshot>
  readEvents: () => Promise<NativeLogSnapshot>
  exportStartup: (options: {
    mode: 'fallback'
    phase: 'diagnostics'
    errorName: string
    share?: boolean
  }) => Promise<{ saved?: boolean; cancelled?: boolean; launched?: boolean }>
}>('Diagnostics')

/** JS 归档生成失败时由原生保存最小诊断，仍排除原始错误消息与会话数据。 */
export const saveNativeDiagnostics = async (error: unknown, share = false): Promise<boolean> => {
  const { diagnosticError } = await import('./log.js')
  const safe = diagnosticError(error)
  const result = await NativeDiagnostics.exportStartup({
    mode: 'fallback',
    phase: 'diagnostics',
    errorName: String(safe.name),
    share,
  })
  return result.saved === true || result.launched === true
}
