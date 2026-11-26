import { create } from 'zustand'
import { hasChatConnection } from '../../services/providers.js'
import { logEvent } from '../../services/diagnostics/log.js'

/** 设置页路由：一级目录与各二级页面 */
export type SettingsPageId =
  | 'home'
  | 'account'
  | 'providers'
  | 'providerCatalog'
  | 'providerAccess'
  | 'providerConnection'
  | 'providerModels'
  | 'providerModel'
  | 'providerSearch'
  | 'providerSpeech'
  | 'chat'
  | 'chatSpeech'
  | 'personas'
  | 'personaEdit'
  | 'assistantSettings'
  | 'memories'
  | 'memoryDetails'
  | 'memorySuggestions'
  | 'agents'
  | 'agentDetails'
  | 'agentTools'
  | 'agentExtensions'
  | 'agentEdit'
  | 'appearance'
  | 'data'
  | 'usage'
  | 'usagePricing'
  | 'usageModels'
  | 'usageModel'
  | 'screenTime'
  | 'about'
  | 'aboutInfo'
  | 'easterEggs'
  | 'disclaimer'
  | 'guide'

/** 设置目录中各页面所属的上一级。 */
export const parentSettingsPage = (page: SettingsPageId): SettingsPageId => {
  if (page === 'agentExtensions') {
    return 'agentTools'
  }
  if (page === 'personaEdit') {
    return 'personas'
  }
  if (
    page === 'memories' ||
    page === 'agents' ||
    page === 'memoryDetails' ||
    page === 'memorySuggestions' ||
    page === 'agentDetails' ||
    page === 'agentTools'
  ) {
    return 'assistantSettings'
  }
  if (page === 'agentEdit') {
    return 'agents'
  }
  if (page === 'providers') {
    return 'account'
  }
  if (page === 'chatSpeech') {
    return 'chat'
  }
  if (page === 'providerCatalog' || page === 'providerModels' || page === 'providerSearch' || page === 'providerSpeech') {
    return 'providers'
  }
  if (page === 'providerAccess' || page === 'providerConnection') {
    return 'providerCatalog'
  }
  if (page === 'providerModel') {
    return 'providerModels'
  }
  if (page === 'usageModel') {
    return 'usageModels'
  }
  if (page === 'usagePricing' || page === 'usageModels') {
    return 'usage'
  }
  if (page === 'aboutInfo' || page === 'easterEggs' || page === 'disclaimer' || page === 'guide') {
    return 'about'
  }
  return 'home'
}

/**
 * 设置页状态：open 控制挂载，closing 播放退出动画后再真正卸载。
 * 默认打开一级目录；account 用于首次配置与 401 引导。
 */
export const useSettingsDialog = create(() => ({
  open: false,
  closing: false,
  page: 'home' as SettingsPageId,
  showTutorial: false,
  backToConversation: false,
}))

useSettingsDialog.subscribe((current, previous) => {
  if (current.open && !current.closing && (!previous.open || current.page !== previous.page)) {
    logEvent('settings', 'page.opened', { page: current.page })
  } else if (current.closing && !previous.closing) {
    logEvent('settings', 'page.closed', { page: current.page })
  }
})

export const openSettings = (
  page: SettingsPageId = 'home',
  { showTutorial = false, backToConversation = false } = {}
) => useSettingsDialog.setState({ open: true, closing: false, page, showTutorial, backToConversation })

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
  if (hasChatConnection()) {
    return true
  }
  openSettings('account')
  return false
}
