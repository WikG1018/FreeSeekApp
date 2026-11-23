import { Capacitor } from '@capacitor/core'

/**
 * 网页版/PWA 的系统返回。
 *
 * 原生壳有自己的返回键事件；网页版「返回」就是浏览器的历史后退，若没有可后退的
 * 应用内层级，Android 会直接把 PWA 关掉回到桌面。这里压一条守卫历史记录，把
 * 后退先交给应用内的层级处理（设置页、弹窗、搜索、侧边栏、会话→欢迎页），
 * 都关完了再按一次才真的离开。
 */
const handlers: Array<() => boolean> = []
let armed = false
let installed = false

const pushGuard = () => {
  if (armed) {
    return
  }
  history.pushState({ freeseekBackGuard: true }, '')
  armed = true
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
  window.addEventListener('popstate', () => {
    if (!armed) {
      return
    }
    armed = false
    for (let index = handlers.length - 1; index >= 0; index--) {
      if (handlers[index]()) {
        pushGuard()
        return
      }
    }
    // 已在最外层：提示再按一次退出，下一次后退交给系统关闭 PWA。
    onEmpty()
  })
}
