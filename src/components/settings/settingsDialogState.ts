import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { useAccount } from '../../services/account.js'

/** 设置页路由：一级目录与各二级页面 */
export type SettingsPageId =
  | 'home'
  | 'account'
  | 'appearance'
  | 'font'
  | 'language'
  | 'voice'
  | 'data'
  | 'usage'
  | 'usagePricing'
  | 'about'

/**
 * 设置页状态：open 控制挂载，closing 播放退出动画后再真正卸载。
 * 默认打开一级目录；account 用于首次配置与 401 引导。
 */
export const useSettingsDialog = create(() => ({
  open: false,
  closing: false,
  page: 'home' as SettingsPageId,
}))

export const openSettings = (page: SettingsPageId = 'home') =>
  useSettingsDialog.setState({ open: true, closing: false, page })

/** 关闭：先进入 closing 相位（播放退出动画），由 SettingsRoot 在动画结束后真正卸载 */
export const closeSettings = () => {
  const { open, closing } = useSettingsDialog.getState()
  if (!open || closing) {
    return
  }
  useSettingsDialog.setState({ closing: true })
}

/** 退出动画结束：真正卸载。重复调用安全。 */
export const finishCloseSettings = () => {
  const { closing } = useSettingsDialog.getState()
  if (closing) {
    useSettingsDialog.setState({ open: false, closing: false })
  }
}

/** 是否有设置页处于打开状态（Android 返回键应先关闭它，不能直接退出 App） */
export const hasSettingsOpen = () => useSettingsDialog.getState().open

/** 没有 API Key 时打开「API 服务」页，返回是否已有 Key */
export const ensureApiKey = () => {
  const account = useAccount.getState()
  if (account.mode === 'account' && account.token) {
    return true
  }
  if (account.mode === 'key' && useSettings.getState().apiKey) {
    return true
  }
  openSettings('account')
  return false
}
