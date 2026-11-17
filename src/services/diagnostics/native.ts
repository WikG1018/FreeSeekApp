import { registerPlugin } from '@capacitor/core'
import { diagnosticError } from './log.js'

export type NativeSnapshot = {
  events: unknown[]
  environment: Record<string, unknown>
  failedWrites: number
}
export const NativeDiagnostics = registerPlugin<{
  snapshot: () => Promise<NativeSnapshot>
  exportStartup: (options: {
    mode: 'fallback'
    phase: 'diagnostics'
    errorName: string
  }) => Promise<{ saved?: boolean; cancelled?: boolean }>
}>('Diagnostics')

/** JS 归档生成失败时由原生保存最小诊断，仍排除原始错误消息与会话数据。 */
export const saveNativeDiagnostics = async (error: unknown): Promise<boolean> => {
  const safe = diagnosticError(error)
  const result = await NativeDiagnostics.exportStartup({
    mode: 'fallback',
    phase: 'diagnostics',
    errorName: String(safe.name),
  })
  return result.saved === true
}
