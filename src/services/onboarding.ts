const GUIDE_KEY = 'freeseek:onboarded'
const NOTICE_KEY = 'freeseek:notice-version'
const NOTICE_VERSION = '1'
const volatile = new Map<string, string>()

const stored = (key: string) => {
  try {
    return volatile.get(key) ?? localStorage.getItem(key)
  } catch {
    return volatile.get(key)
  }
}

const remember = (key: string, value: string) => {
  volatile.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // The current launch still remembers the reader's choice.
  }
}

export const hasSeenOnboarding = () => stored(GUIDE_KEY) === '1'
export const markOnboardingSeen = () => remember(GUIDE_KEY, '1')
export const acceptUsageNotice = () => remember(NOTICE_KEY, NOTICE_VERSION)
export type OnboardingStep = 'notice' | 'guide'
export const initialOnboardingStep = (configured: boolean): OnboardingStep | null => {
  if (
    process.env.NODE_ENV === 'development' &&
    new URLSearchParams(window.location.search).has('e2e')
  ) {
    return null
  }
  if (stored(NOTICE_KEY) !== NOTICE_VERSION) {
    return 'notice'
  }
  return configured || hasSeenOnboarding() ? null : 'guide'
}
