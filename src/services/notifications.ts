import { hasAndroidBackgroundWork, requestTaskNotifications } from './tasks/goalBridge.js'

/**
 * 通知权限引导：整个安装周期只申请一次。
 *
 * 背景：早期版本没有通知功能，这些用户升级上来时系统不会自动补弹
 * POST_NOTIFICATIONS（Android 13+ 的运行时权限），需要这里补一次。
 * 但只需要一次——之后不管更新多少个版本都不再打扰，
 * 用户想开可以随时到「设置 → 对话偏好」手动打开。
 *
 * 用一次性标记而不是版本号：按版本记录会导致每次更新都弹一次，
 * 对已经明确拒绝过的用户是骚扰。
 */
const PROMPTED_KEY = 'freeseek:notification-prompted'

const read = (): string | null => {
  try {
    return localStorage.getItem(PROMPTED_KEY)
  } catch {
    return null
  }
}

const write = (): void => {
  try {
    localStorage.setItem(PROMPTED_KEY, '1')
  } catch {
    // 存储不可用时最多多弹一次，不影响主流程
  }
}

/**
 * 启动后调用：只要还没问过，就向系统发起一次通知权限申请。
 * 返回是否真的发起了申请（便于调试与测试）。
 */
export const ensureNotificationPermission = async (): Promise<boolean> => {
  if (!hasAndroidBackgroundWork() || read() === '1') {
    return false
  }
  try {
    // 先落标记：权限弹窗可能停留很久，期间重复触发会造成并发请求
    write()
    await requestTaskNotifications()
    return true
  } catch {
    // 申请失败不阻塞启动；用户仍可到设置里手动开启
    return false
  }
}
