import { Capacitor } from '@capacitor/core'
import { logEvent } from '../services/diagnostics/log.js'

/**
 * 网页版/PWA 的系统返回。
 *
 * 原生壳有自己的返回键事件；网页版「返回」就是浏览器的历史后退。独立窗口（添加到主屏幕）
 * 里，只要浏览器自己判断「没有可后退的记录」，就会直接关掉应用回桌面——这一步发生在
 * JavaScript 之前，任何脚本都拦不住。
 *
 * 实测（Android 17 Chrome）：按下返回到 popstate 真正触发之间有 22–650ms 的空档，这段时间
 * 页面停在守卫记录上。若只留一条守卫，空档里再按一下，浏览器看到的就是「前面没有记录」，
 * 直接退出。所以守卫要留两条：当前这条，加上前面一条。空档里多按的那一下落在前面那条
 * 守卫上，仍是文档内遍历，popstate 照常触发，再补回两条。
 *
 * 历史长度因此保持恒定：每次补回都从「少了一条」的位置压一条，不会越压越长。
 */
type GuardState = { freeseekBackGuard: true; depth: number }
const GUARD_DEPTH = 2
const EXIT_WINDOW_MS = 2000
const handlers: Array<() => boolean> = []
let installed = false
let lastEmpty = 0
// 确认退出后置位：离开过程中的 popstate 不再补守卫，否则会把自己拉回来。
let exiting = false

const guardDepth = () => {
  const state = history.state as Partial<GuardState> | null
  return state?.freeseekBackGuard && typeof state.depth === 'number' ? state.depth : 0
}

/** 把守卫补到 GUARD_DEPTH 条：不足就压，超过（旧版本留下的）就改写当前这条的深度。 */
const rearm = () => {
  if (exiting) {
    return
  }
  let depth = guardDepth()
  if (depth === 0) {
    depth = 1
    history.pushState({ freeseekBackGuard: true, depth } satisfies GuardState, '')
  } else if (depth > GUARD_DEPTH) {
    history.replaceState({ freeseekBackGuard: true, depth: GUARD_DEPTH } satisfies GuardState, '')
    depth = GUARD_DEPTH
  }
  while (depth < GUARD_DEPTH) {
    depth += 1
    history.pushState({ freeseekBackGuard: true, depth } satisfies GuardState, '')
  }
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

/**
 * 到达最外层（所有层级都已关完）时怎么办。
 * - exit：第一次提示，2 秒内再按一次才真的离开。适合有返回键的环境（Android、桌面浏览器）。
 * - stay：什么都不做，只补回守卫。
 */
export type WebBackOutermost = 'exit' | 'stay'

/**
 * guards=false 时完全不碰历史记录（iOS 主屏幕 PWA 用）。
 *
 * iOS 没有返回键，左边缘右滑是 Safari 的历史后退。iOS 在滑动过程中会画出目标历史记录的
 * 快照，而 pushState 压出来的守卫记录从来没有真正渲染过，画出来就是整片白屏——实测
 * 「从设置右滑返回」会白一下再恢复。既然没有按键需要拦，就不要制造可后退的历史记录：
 * 手势无事可做，白屏也就不存在。层级改用设置页的 ‹ 和弹窗的 × 关闭。
 */
export const installWebBack = (
  onEmpty: () => void,
  outermost: WebBackOutermost = 'exit',
  guards = true
) => {
  if (installed || Capacitor.isNativePlatform()) {
    return
  }
  installed = true
  if (!guards) {
    return
  }
  rearm()
  // 从缓存恢复或被系统挂起后重新可见时，补回守卫。
  const repair = () => {
    if (document.visibilityState === 'visible') {
      rearm()
    }
  }
  window.addEventListener('pageshow', repair)
  document.addEventListener('visibilitychange', repair)
  window.addEventListener('popstate', () => {
    if (exiting) {
      return
    }
    // 必须同步补回：下一次按键可能马上就来，不能等下一个任务。
    rearm()
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
    // 已在最外层。
    if (outermost === 'stay') {
      logEvent('app', 'web-back', { handled: -1, outermost: 'stay' })
      return
    }
    // 第一次提示，2 秒内再按一次才真的离开。
    const now = Date.now()
    if (now - lastEmpty < EXIT_WINDOW_MS) {
      logEvent('app', 'web-back', { handled: -1, exit: true })
      lastEmpty = 0
      exiting = true
      // 跨过全部守卫和文档根记录离开；只跨守卫会停在根上而不是退出。
      history.go(-(GUARD_DEPTH + 1))
      return
    }
    lastEmpty = now
    logEvent('app', 'web-back', { handled: -1, exit: false })
    onEmpty()
  })
}
