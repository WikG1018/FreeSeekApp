/**
 * 首次使用引导：没绑 Key 且没看过引导时弹出一次。
 * 只要用户成功保存过 Key 或主动跳过，就不再打扰。
 */
const KEY = 'freeseek:onboarded'

export const hasSeenOnboarding = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export const markOnboardingSeen = (): void => {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // 存储不可用时本次会话内不再重复弹（由调用方控制状态）
  }
}

/** 自动化测试带 ?e2e=1，跳过引导（否则会挡住既有回归用例） */
const isAutomation = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).has('e2e')
  } catch {
    return false
  }
}

/** 是否应展示首启引导：没看过引导、且还没配置 Key */
export const shouldShowOnboarding = (apiKey: string | null): boolean =>
  !isAutomation() && !hasSeenOnboarding() && !apiKey
