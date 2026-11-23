import { create } from 'zustand'
import { diagnosticError, logEvent, registerLogSecret } from './diagnostics/log.js'
import type { TtsVoice } from './api/speech.js'
import { defaultAgentTools, type AgentTool, type AgentToolPolicy } from './tasks/policy.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'
export type StartupPagePreference = 'last-chat' | 'new-chat'
export type ComposerEnter = 'send' | 'newline'
export type SiderOrder = 'recent' | 'type'
export type ThirdPartySearch = {
  enabled: boolean
  keySource: 'official' | 'separate'
  apiKey: string
}

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  startupPage: StartupPagePreference
  composerEnter: ComposerEnter
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  hasLegacyThinking: boolean
  search: boolean
  siderCollapsed: boolean
  siderOrder: SiderOrder
  /** 正文与控件缩放；允许 0.85–1.25 之间任意微调 */
  fontScale: number
  useSystemFont: boolean
  /** 对话内显示 Token 用量与估算费用。 */
  showUsage: boolean
  autoCompress: boolean
  showModelSwitcher: boolean
  showReasoningPicker: boolean
  askChatMode: boolean
  agentTools: AgentToolPolicy
  thirdPartySearch: ThirdPartySearch
  thirdPartySearchOn: boolean
  proSearchOn: boolean
}

const KEYS = {
  apiKey: 'freeseek:api-key',
  locale: 'freeseek:locale',
  location: 'freeseek:location',
  themePreference: 'freeseek:theme-preference',
  startupPage: 'freeseek:startup-page',
  composerEnter: 'freeseek:composer-enter',
  ttsVoice: 'freeseek:tts-voice',
  thinking: 'freeseek:thinking',
  search: 'freeseek:search',
  siderCollapsed: 'freeseek:sider-collapsed',
  siderOrder: 'freeseek:sider-order',
  fontScale: 'freeseek:font-scale',
  useSystemFont: 'freeseek:use-system-font',
  showUsage: 'freeseek:show-usage',
  autoCompress: 'freeseek:auto-compress',
  showModelSwitcher: 'freeseek:show-model-switcher',
  showReasoningPicker: 'freeseek:show-reasoning-picker',
  askChatMode: 'freeseek:ask-chat-mode',
  agentTools: 'freeseek:agent-tools',
  thirdPartySearch: 'freeseek:third-party-search',
  thirdPartySearchOn: 'freeseek:third-party-search-on',
  proSearchOn: 'freeseek:pro-search-on',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    logEvent('storage', 'settings.read.failed', { setting: key, ...diagnosticError(error) }, 'warn')
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    return true
  } catch (error) {
    logEvent(
      'storage',
      'settings.write.failed',
      { setting: key, ...diagnosticError(error) },
      'error'
    )
    return false
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')
const initialThirdPartySearch = (): ThirdPartySearch => {
  try {
    const value = JSON.parse(read(KEYS.thirdPartySearch) ?? 'null')
    if (value && typeof value.apiKey === 'string' && value.apiKey.length <= 8192) {
      registerLogSecret(value.apiKey)
      return {
        enabled: value.enabled === true,
        keySource: value.keySource === 'separate' ? 'separate' : 'official',
        apiKey: value.apiKey,
      }
    }
  } catch {
    /* Invalid local preferences are treated as unconfigured. */
  }
  return { enabled: false, keySource: 'official', apiKey: '' }
}

/** iPhone / iPad（含 iPadOS 的桌面 UA）。中文字体包约 14 MB，这些设备默认不下载。 */
const isAppleMobile = (): boolean => {
  try {
    const ua = navigator.userAgent || ''
    return (
      /iPhone|iPad|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  } catch {
    return false
  }
}

/** 未保存过时：iPhone/iPad 默认系统字体，其余平台保持 MiSans；用户手动选过则以选择为准。 */
const initialUseSystemFont = (): boolean => {
  const saved = read(KEYS.useSystemFont)
  return saved === null ? isAppleMobile() : saved === 'true'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  startupPage: read(KEYS.startupPage) === 'new-chat' ? 'new-chat' : 'last-chat',
  composerEnter: read(KEYS.composerEnter) === 'newline' ? 'newline' : 'send',
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  hasLegacyThinking: read(KEYS.thinking) !== null,
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  siderOrder: read(KEYS.siderOrder) === 'type' ? 'type' : 'recent',
  autoCompress: read(KEYS.autoCompress) === 'true',
  showUsage: read(KEYS.showUsage) !== 'false',
  showModelSwitcher: read(KEYS.showModelSwitcher) === 'true',
  showReasoningPicker: read(KEYS.showReasoningPicker) === 'true',
  askChatMode: read(KEYS.askChatMode) === 'true',
  agentTools: (() => {
    try {
      const stored: unknown = JSON.parse(read(KEYS.agentTools) ?? '{}')
      const selected = { ...defaultAgentTools }
      for (const key of Object.keys(selected) as AgentTool[]) {
        const value =
          stored && typeof stored === 'object'
            ? (stored as Record<string, unknown>)[key]
            : undefined
        if (typeof value === 'boolean') {
          selected[key] = value
        }
      }
      return selected
    } catch {
      return { ...defaultAgentTools }
    }
  })(),
  thirdPartySearch: initialThirdPartySearch(),
  thirdPartySearchOn: read(KEYS.thirdPartySearchOn) === 'true',
  proSearchOn: read(KEYS.proSearchOn) === 'true',
  useSystemFont: initialUseSystemFont(),
  fontScale: (() => {
    const value = Number(read(KEYS.fontScale))
    return Number.isFinite(value) && value >= 0.85 && value <= 1.25 ? value : 1
  })(),
}))

// Only record values from this explicit list of non-sensitive preferences.
useSettings.subscribe((current, previous) => {
  const fields = [
    'locale',
    'themePreference',
    'startupPage',
    'composerEnter',
    'ttsVoice',
    'thinking',
    'search',
    'proSearchOn',
    'thirdPartySearchOn',
    'fontScale',
    'useSystemFont',
    'showUsage',
    'showModelSwitcher',
    'showReasoningPicker',
    'askChatMode',
    'autoCompress',
    'siderCollapsed',
    'siderOrder',
  ] as const
  const changes: Record<string, unknown> = Object.fromEntries(
    fields
      .filter((field) => current[field] !== previous[field])
      .map((field) => [field, current[field]])
  )
  if (current.location !== previous.location) {
    changes.locationConfigured = Boolean(current.location)
  }
  if (current.thirdPartySearch !== previous.thirdPartySearch) {
    changes.independentSearchEnabled = current.thirdPartySearch.enabled
    changes.searchKeySource = current.thirdPartySearch.keySource
    changes.separateSearchKeyConfigured = Boolean(current.thirdPartySearch.apiKey)
  }
  if (Object.keys(changes).length) {
    logEvent('settings', 'preferences.changed', changes)
  }
})

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setStartupPage = (startupPage: StartupPagePreference): boolean => {
  if (!write(KEYS.startupPage, startupPage)) {
    return false
  }
  useSettings.setState({ startupPage })
  return true
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null, { requirePersistence = false } = {}) => {
  registerLogSecret(apiKey)
  const saved = write(KEYS.apiKey, apiKey)
  if (saved || !requirePersistence) {
    logEvent('app', 'api-key.changed', { configured: Boolean(apiKey) })
    useSettings.setState({ apiKey })
  }
  return saved
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking, hasLegacyThinking: true })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const thirdPartySearchKey = ({ apiKey, thirdPartySearch }: Settings) =>
  thirdPartySearch.enabled
    ? thirdPartySearch.keySource === 'official'
      ? apiKey
      : thirdPartySearch.apiKey
    : null

export const saveThirdPartySearch = (value: ThirdPartySearch) => {
  const thirdPartySearch = { ...value, apiKey: value.apiKey.trim() }
  if (
    thirdPartySearch.apiKey.length > 8192 ||
    !write(KEYS.thirdPartySearch, JSON.stringify(thirdPartySearch))
  ) {
    return false
  }
  registerLogSecret(thirdPartySearch.apiKey)
  useSettings.setState({ thirdPartySearch })
  if (!thirdPartySearch.enabled) {
    setThirdPartySearchOn(false)
    setProSearchOn(false)
  }
  return true
}

export const setThirdPartySearchOn = (thirdPartySearchOn: boolean) => {
  write(KEYS.thirdPartySearchOn, String(thirdPartySearchOn))
  useSettings.setState({ thirdPartySearchOn })
}

export const setProSearchOn = (proSearchOn: boolean) => {
  write(KEYS.proSearchOn, String(proSearchOn))
  useSettings.setState({ proSearchOn })
}

export const setFontScale = (fontScale: number) => {
  logEvent('ui', 'font-scale.changed', { scale: fontScale })
  const value = Math.min(1.25, Math.max(0.85, Number(fontScale.toFixed(2))))
  write(KEYS.fontScale, String(value))
  useSettings.setState({ fontScale: value })
}

export const setUseSystemFont = (enabled: boolean) => {
  if (!write(KEYS.useSystemFont, String(enabled))) {
    return false
  }
  document.documentElement.toggleAttribute('data-fs-system-font', enabled)
  useSettings.setState({ useSystemFont: enabled })
  return true
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setSiderOrder = (siderOrder: SiderOrder) => {
  write(KEYS.siderOrder, siderOrder)
  useSettings.setState({ siderOrder })
}

export const setAgentTool = (name: AgentTool, enabled: boolean) => {
  const agentTools = { ...useSettings.getState().agentTools, [name]: enabled }
  if (!write(KEYS.agentTools, JSON.stringify(agentTools))) {
    return false
  }
  useSettings.setState({ agentTools })
  logEvent('settings', 'assistant.tool-changed', { tool: name, enabled })
  return true
}

export const setShowUsage = (showUsage: boolean) => {
  write(KEYS.showUsage, String(showUsage))
  useSettings.setState({ showUsage })
  logEvent('ui', 'usage-display.changed', { enabled: showUsage })
}

export const setAskChatMode = (askChatMode: boolean) => {
  if (!write(KEYS.askChatMode, String(askChatMode))) {
    return false
  }
  useSettings.setState({ askChatMode })
  return true
}

export const setComposerEnter = (composerEnter: ComposerEnter) => {
  if (!write(KEYS.composerEnter, composerEnter)) {
    return false
  }
  useSettings.setState({ composerEnter })
  return true
}

export const setShowModelSwitcher = (showModelSwitcher: boolean) => {
  write(KEYS.showModelSwitcher, String(showModelSwitcher))
  useSettings.setState({ showModelSwitcher })
}

export const setShowReasoningPicker = (showReasoningPicker: boolean) => {
  write(KEYS.showReasoningPicker, String(showReasoningPicker))
  useSettings.setState({ showReasoningPicker })
}

export const setAutoCompress = (autoCompress: boolean) => {
  write(KEYS.autoCompress, String(autoCompress))
  useSettings.setState({ autoCompress })
}
