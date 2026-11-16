import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置页的分组：账户（API Key）/ 应用（语言、外观、语音、位置）/ 数据 / 关于 */
export type SettingsSection = 'account' | 'app' | 'data' | 'about'

/** 设置页：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时滚动到的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'app' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并定位到「账户」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('account')
  return false
}
