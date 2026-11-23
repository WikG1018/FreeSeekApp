import { Capacitor } from '@capacitor/core'
import { logEvent } from '../services/diagnostics/log.js'

/**
 * 网页版/PWA 的系统返回。
 *
 * 原生壳有自己的返回键事件；网页版「返回」就是浏览器的历史后退，若没有可后退的
 * 应用内层级，Android 会直接把 PWA 关掉回到桌面。
 *
 * 做法：应用存活期间始终保留一条守卫记录——每次后退事件进来都先补一条新的守卫，
 * 再交给应用内的层级（设置页、弹窗、面板、搜索、侧边栏、会话→欢迎页）。这样任何
 * 一次意外消费都不会让下一次后退直接退出；只有在最外层连续两次后退（2 秒内）才
 * 主动离开。
 */
const handlers: Array<() => boolean> = []
const EXIT_WINDOW_MS = 2000
let installed = false
let lastEmpty = 0

const pushGuard = () => {
  // 当前这条历史记录已经是我们的守卫时不再重复压栈。
  if ((history.state as { freeseekBackGuard?: boolean } | null)?.freeseekBackGuard) {
    return
  }
  history.pushState({ freeseekBackGuard: true }, '')
}

/** 注册一个返回处理层级；后注册的先处理（设置页在应用之后挂载）。 */
export const registerWebBack = (handler: () => boolean) => {
  handlers.push(handler)
  return () => {
    const index = handlers.indexOf(handler)
    if (index >= 0) {
      handlers.splice(index, 1)
    }
  }
}

export const installWebBack = (onEmpty: () => void) => {
  if (installed || Capacitor.isNativePlatform()) {
    return
  }
  installed = true
  pushGuard()
  // 从缓存恢复或被系统挂起后重新可见时，补回守卫。
  const repair = () => {
    if (document.visibilityState === 'visible') {
      pushGuard()
    }
  }
  window.addEventListener('pageshow', repair)
  document.addEventListener('visibilitychange', repair)
  window.addEventListener('popstate', () => {
    // 先补守卫：即使这一条是被前面某次操作意外消费的，也不会直接退出。
    pushGuard()
    for (let index = handlers.length - 1; index >= 0; index--) {
      let handled = false
      try {
        handled = handlers[index]()
      } catch {
        handled = false
      }
      if (handled) {
        lastEmpty = 0
        logEvent('app', 'web-back', { handled: index })
        return
      }
    }
    // 已在最外层：第一次提示，2 秒内再按一次才真的离开。
    const now = Date.now()
    if (now - lastEmpty < EXIT_WINDOW_MS) {
      logEvent('app', 'web-back', { handled: -1, exit: true })
      lastEmpty = 0
      history.go(-2)
      return
    }
    lastEmpty = now
    logEvent('app', 'web-back', { handled: -1, exit: false })
    onEmpty()
  })
}
