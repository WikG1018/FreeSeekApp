import { Capacitor } from '@capacitor/core'
import { NativeDiagnostics } from '../diagnostics/native.js'
import { diagnosticError, logEvent } from '../diagnostics/log.js'

const key = 'freeseek:history-had-conversations'
const verifiedKey = 'freeseek:history-verified'
const legacyCountKey = 'freeseek:history-count'
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
      localStorage.setItem(legacyCountKey, String(sessionCount))
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
  let present = recorded
  let local: { sessionCount?: number; verifiedAt?: number } = {}
  try {
    const marker = localStorage.getItem(key)
    if (marker === '1' || marker === '0') {
      present = present === true || marker === '1'
    }
    const saved = JSON.parse(localStorage.getItem(verifiedKey) ?? 'null')
    if (
      Number.isSafeInteger(saved?.sessionCount) &&
      saved.sessionCount >= 0 &&
      (present === undefined || Boolean(saved.sessionCount) === present) &&
      Number.isFinite(saved.verifiedAt)
    ) {
      local = { sessionCount: saved.sessionCount, verifiedAt: saved.verifiedAt }
      present = saved.sessionCount > 0
    }
    if (present === undefined) {
      const count = Number(localStorage.getItem(legacyCountKey))
      if (Number.isSafeInteger(count) && count > 0) {
        present = true
        local = { sessionCount: count }
      }
    }
  } catch (error) {
    logEvent('storage', 'history.checkpoint-read-failed', diagnosticError(error), 'warn')
  }
  return { present: present === true, ...local }
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

function verifiedTime(checkpoint: ReturnType<typeof readLocalCheckpoint>): number {
  const { present, sessionCount, verifiedAt } = checkpoint
  if (sessionCount === undefined || !Number.isSafeInteger(sessionCount) || sessionCount < 0 ||
      present !== (sessionCount > 0) || verifiedAt === undefined || !Number.isFinite(verifiedAt)) {
    return 0
  }
  return Math.max(0, verifiedAt)
}

export const readPreviousHistory = async (): Promise<{
  present: boolean
  sessionCount?: number
  verifiedAt?: number
  timedOut?: boolean
  confirmedEmpty?: boolean
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
      const localTime = verifiedTime(local)
      const nativeTime = verifiedTime(stored)
      const useNative = nativeTime > localTime || (nativeTime === localTime && stored.present)
      const [latest, earlier] = useNative ? [stored, local] : [local, stored]
      // Only a dated, verified clear can supersede an older positive checkpoint.
      // An undated positive marker may represent a later write that has not yet been counted.
      const confirmedEmpty = latest.sessionCount === 0 && Math.max(localTime, nativeTime) > 0 &&
        (!earlier.present || (Math.min(localTime, nativeTime) > 0 && localTime !== nativeTime))
      return {
        sessionCount: latest.sessionCount,
        verifiedAt: latest.verifiedAt,
        present: !confirmedEmpty && (local.present || stored.present),
        confirmedEmpty,
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
