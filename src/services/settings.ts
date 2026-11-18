import { create } from 'zustand'
import { logEvent, registerLogSecret } from './diagnostics/log.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 正文与控件缩放；允许 0.85–1.25 之间任意微调 */
  fontScale: number
  /** 对话内显示 Token 用量与估算费用。 */
  showUsage: boolean
  showModelSwitcher: boolean
}

const KEYS = {
  apiKey: 'freeseek:api-key',
  locale: 'freeseek:locale',
  location: 'freeseek:location',
  themePreference: 'freeseek:theme-preference',
  ttsVoice: 'freeseek:tts-voice',
  thinking: 'freeseek:thinking',
  search: 'freeseek:search',
  siderCollapsed: 'freeseek:sider-collapsed',
  fontScale: 'freeseek:font-scale',
  showUsage: 'freeseek:show-usage',
  showModelSwitcher: 'freeseek:show-model-switcher',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    logEvent(
      'storage',
      'settings.read.failed',
      { errorName: error instanceof Error ? error.name : 'Error' },
      'warn'
    )
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
      { errorName: error instanceof Error ? error.name : 'Error' },
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

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  showUsage: read(KEYS.showUsage) !== 'false',
  showModelSwitcher: read(KEYS.showModelSwitcher) === 'true',
  fontScale: (() => {
    const value = Number(read(KEYS.fontScale))
    return Number.isFinite(value) && value >= 0.85 && value <= 1.25 ? value : 1
  })(),
}))

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
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setFontScale = (fontScale: number) => {
  logEvent('ui', 'font-scale.changed', { scale: fontScale })
  const value = Math.min(1.25, Math.max(0.85, Number(fontScale.toFixed(2))))
  write(KEYS.fontScale, String(value))
  useSettings.setState({ fontScale: value })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setShowUsage = (showUsage: boolean) => {
  write(KEYS.showUsage, String(showUsage))
  useSettings.setState({ showUsage })
  logEvent('ui', 'usage-display.changed', { enabled: showUsage })
}

export const setShowModelSwitcher = (showModelSwitcher: boolean) => {
  write(KEYS.showModelSwitcher, String(showModelSwitcher))
  useSettings.setState({ showModelSwitcher })
}
