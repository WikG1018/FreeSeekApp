import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置页路由：一级目录与各二级页面 */
export type SettingsPageId =
  | 'home'
  | 'account'
  | 'appearance'
  | 'font'
  | 'language'
  | 'voice'
  | 'data'
  | 'about'

/** 设置页：默认打开一级目录；account 用于首次配置与 401 引导 */
export const useSettingsDialog = create(() => ({
  open: false,
  page: 'home' as SettingsPageId,
}))

export const openSettings = (page: SettingsPageId = 'home') =>
  useSettingsDialog.setState({ open: true, page })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 是否有设置页处于打开状态（Android 返回键应先关闭它，不能直接退出 App） */
export const hasSettingsOpen = () => useSettingsDialog.getState().open

/** 没有 API Key 时打开「API 服务」页，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('account')
  return false
}
