import { Capacitor } from '@capacitor/core'
import { NativeDiagnostics } from '../diagnostics/native.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'

const key = 'freeseek:history-had-conversations'
const verifiedKey = 'freeseek:history-verified'
let pendingWrite = Promise.resolve()
let recorded: boolean | undefined
let recordedCount: number | undefined

const native = () => Capacitor.getPlatform() === 'android'

/** Keep a presence bit outside WebView IndexedDB. This never saves chat content or identifiers. */
export const recordHistoryCheckpoint = (present: boolean, sessionCount?: number) => {
  if (recorded === present && (sessionCount === undefined || sessionCount === recordedCount)) {
    return
  }
  recorded = present
  recordedCount = sessionCount
  try {
    localStorage.setItem(key, present ? '1' : '0')
    if (sessionCount !== undefined) {
      localStorage.setItem(verifiedKey, JSON.stringify({ sessionCount, verifiedAt: Date.now() }))
    }
  } catch (error) {
    logEvent('storage', 'history.checkpoint-write-failed', diagnosticError(error), 'warn')
  }
  if (native()) {
    pendingWrite = pendingWrite
      .then(() => NativeDiagnostics.recordHistory({ present, sessionCount }))
      .catch((error: unknown) => {
        if (recorded === present && recordedCount === sessionCount) {
          recorded = undefined
          recordedCount = undefined
        }
        logEvent(
          'storage',
          'history.native-checkpoint-write-failed',
          diagnosticError(error),
          'warn'
        )
      })
  }
}

export const readPreviousHistory = async (): Promise<{
  present: boolean
  sessionCount?: number
  verifiedAt?: number
  timedOut?: boolean
}> => {
  let present = recorded === true
  let local: { sessionCount?: number; verifiedAt?: number } = {}
  try {
    present ||= localStorage.getItem(key) === '1'
    const saved = JSON.parse(localStorage.getItem(verifiedKey) ?? 'null')
    if (
      Number.isSafeInteger(saved?.sessionCount) &&
      saved.sessionCount >= 0 &&
      Boolean(saved.sessionCount) === present &&
      Number.isFinite(saved.verifiedAt)
    ) {
      local = { sessionCount: saved.sessionCount, verifiedAt: saved.verifiedAt }
    }
  } catch (error) {
    logEvent('storage', 'history.checkpoint-read-failed', diagnosticError(error), 'warn')
  }
  if (native()) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const stored = await Promise.race([
        pendingWrite.then(() => NativeDiagnostics.checkHistory()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new Error('History checkpoint read timed out'))
          }, 4000)
        }),
      ])
      const nativeIsNewer =
        stored.sessionCount !== undefined && (stored.verifiedAt ?? 0) >= (local.verifiedAt ?? 0)
      return {
        present: present || stored.present,
        ...(nativeIsNewer
          ? { sessionCount: stored.sessionCount, verifiedAt: stored.verifiedAt }
          : local),
      }
    } catch (error) {
      logEvent('storage', 'history.native-checkpoint-read-failed', diagnosticError(error), 'warn')
      return { present, ...local, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }
  return { present, ...local }
}
