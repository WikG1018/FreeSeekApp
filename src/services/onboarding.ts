const GUIDE_KEY = 'freeseek:onboarded'
const NOTICE_KEY = 'freeseek:notice-version'
const NOTICE_VERSION = '1'
const ROLE_VOICE_INTRO_KEY = 'freeseek:role-voice-intro-seen'
const volatile = new Map<string, string>()

const stored = (key: string) => {
  try {
    return volatile.get(key) ?? localStorage.getItem(key)
  } catch {
    return volatile.get(key)
  }
}

const remember = (key: string, value: string, event: string) => {
  volatile.set(key, value)
  try {
    localStorage.setItem(key, value)
    logEvent('app', event, { persisted: true })
  } catch (error) {
    // The current launch still remembers the reader's choice.
    logEvent('app', event, { persisted: false, ...diagnosticError(error) }, 'warn')
  }
}

export const hasSeenOnboarding = () => stored(GUIDE_KEY) === '1'
export const markOnboardingSeen = () => remember(GUIDE_KEY, '1', 'onboarding.guide-seen')
export const acceptUsageNotice = () =>
  remember(NOTICE_KEY, NOTICE_VERSION, 'onboarding.notice-accepted')
export const initialRoleVoiceIntro = (configured: boolean) => {
  if (stored(ROLE_VOICE_INTRO_KEY) === '1') {
    return null
  }
  return configured || stored(NOTICE_KEY) !== null || hasSeenOnboarding()
    ? 'pending'
    : 'fresh-install'
}

export const markRoleVoiceIntroHandled = (reason: 'shown' | 'fresh-install') => {
  if (stored(ROLE_VOICE_INTRO_KEY) === '1') {
    return false
  }
  remember(ROLE_VOICE_INTRO_KEY, '1', 'onboarding.role-voice-intro.' + reason)
  return true
}

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
import { diagnosticError, logEvent } from './diagnostics/log.js'
