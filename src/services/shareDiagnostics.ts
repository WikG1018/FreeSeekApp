import { Capacitor } from '@capacitor/core'
import { saveBackup } from './saveBackup.js'
import { shareAndroidFile } from './androidShare.js'
import { beginDiagnosticOperation, diagnosticError, logEvent } from './diagnostics/log.js'

/** 返回面板是否已打开，不将打开分享面板误称为已发送给他人。 */
export const shareDiagnostics = async (
  name: string,
  blob: Blob
): Promise<'shared' | 'saved' | false> => {
  if (Capacitor.getPlatform() === 'android') {
    return (await shareAndroidFile(name, blob, false)) ? 'shared' : false
  }
  const finish = beginDiagnosticOperation('diagnostics', 'share', {
    bytes: blob.size,
    native: false,
  })
  let stage = 'web-share'
  try {
    const file = new File([blob], name, { type: 'application/zip' })
    try {
      if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'FreeSeek' })
        finish('completed', { stage })
        return 'shared'
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        finish('cancelled', { stage })
        return false
      }
      logEvent('diagnostics', 'share.browser-fallback', diagnosticError(error), 'warn')
    }
    stage = 'browser-download'
    const saved = await saveBackup(name, blob, 'diagnostics')
    finish(saved ? 'completed' : 'cancelled', { stage })
    return saved ? 'saved' : false
  } catch (error) {
    finish('failed', { stage, ...diagnosticError(error) })
    throw error
  }
}
