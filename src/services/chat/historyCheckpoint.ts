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

/** 只读 localStorage 里的检查点：同步、不碰原生，用于每次启动做「数量骤降」对比。 */
export const readLocalCheckpoint = (): {
  present: boolean
  sessionCount?: number
  verifiedAt?: number
} => {
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
  return { present, ...local }
}

/** 只在原生桥读取时生效的超时：超时按「读不到」处理，不能当成「历史确实没了」。 */
export const historyCheckpointTimeoutMs = { value: 4000 }

/**
 * 测试用接缝：在浏览器里模拟「原生桥很慢/挂住」的情形。
 * 生产环境永远走 NativeDiagnostics.checkHistory()。
 */
export const historyCheckpointReader: {
  read?: () => Promise<{ present: boolean; sessionCount?: number; verifiedAt?: number }>
} = {}

export const readPreviousHistory = async (): Promise<{
  present: boolean
  sessionCount?: number
  verifiedAt?: number
  timedOut?: boolean
}> => {
  const local = readLocalCheckpoint()
  if (native()) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const stored = await Promise.race([
        pendingWrite.then(() =>
          historyCheckpointReader.read
            ? historyCheckpointReader.read()
            : NativeDiagnostics.checkHistory()
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new Error('History checkpoint read timed out'))
          }, historyCheckpointTimeoutMs.value)
        }),
      ])
      const nativeIsNewer =
        stored.sessionCount !== undefined && (stored.verifiedAt ?? 0) >= (local.verifiedAt ?? 0)
      return {
        present: local.present || stored.present,
        ...(nativeIsNewer
          ? { sessionCount: stored.sessionCount, verifiedAt: stored.verifiedAt }
          : local),
      }
    } catch (error) {
      logEvent('storage', 'history.native-checkpoint-read-failed', diagnosticError(error), 'warn')
      return { ...local, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }
  return local
}
