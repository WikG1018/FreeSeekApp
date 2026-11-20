import { registerPlugin } from '@capacitor/core'
import { diagnosticError } from './log.js'

export type NativeLogSnapshot = {
  events: unknown[]
  failedWrites: number
  readFailure?: 'size-limit' | 'unreadable'
}
export type NativeSnapshot = NativeLogSnapshot & { environment: Record<string, unknown> }
export const NativeDiagnostics = registerPlugin<{
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
  const safe = diagnosticError(error)
  const result = await NativeDiagnostics.exportStartup({
    mode: 'fallback',
    phase: 'diagnostics',
    errorName: String(safe.name),
    share,
  })
  return result.saved === true || result.launched === true
}
