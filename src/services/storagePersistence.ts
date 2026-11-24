import { diagnosticError, logEvent } from './diagnostics/log.js'

/**
 * 申请持久化存储。
 *
 * 手机系统在空间紧张时会清理 WebView 的站点数据，IndexedDB 连同聊天记录一起没；
 * 声明为持久化存储后浏览器会尽量保留（Android WebView 不一定支持，所以结果要记日志）。
 * 只请求一次，不打扰用户；被拒绝也不影响使用。
 */
let requested = false

export const requestPersistentStorage = async (): Promise<void> => {
  if (requested) {
    return
  }
  requested = true
  try {
    const storage = navigator.storage
    if (typeof storage?.persist !== 'function') {
      logEvent('storage', 'persist.unsupported', {})
      return
    }
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      logEvent('storage', 'persist.granted', { already: true })
      return
    }
    const granted = await storage.persist()
    logEvent('storage', granted ? 'persist.granted' : 'persist.denied', {}, granted ? 'info' : 'warn')
  } catch (error) {
    logEvent('storage', 'persist.failed', diagnosticError(error), 'warn')
  }
}
