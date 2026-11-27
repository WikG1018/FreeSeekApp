import { useEffect, useId, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import {
  hasAndroidBackgroundWork,
  openTaskNotificationSettings,
  readTaskNotificationPermission,
  setLiveTaskProgress,
} from '../../services/tasks/goalBridge.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  setFontScale,
  setAutoCompress,
  setComposerEnter,
  setLocale,
  setShowModelSwitcher,
  setShowReasoningPicker,
  setShowUsage,
  setStartupPage,
  setThemePreference,
  setTtsVoice,
  setUseSystemFont,
  setRoleVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { MIMO_PRESET_VOICES } from '../../services/speech/roleMarkers.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { useProviders } from '../../services/providers.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Row, Section, SwitchRow } from './SettingsRows.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import styles from './Settings.module.css'

const themeChoices: { value: ThemePreference; label: TranslationKey }[] = [
  { value: 'system', label: 'themeSystem' },
  { value: 'light', label: 'themeLight' },
  { value: 'dark', label: 'themeDark' },
]
const fontChoices: { value: number; label: TranslationKey }[] = [
  { value: 0.9, label: 'fontSmall' },
  { value: 1, label: 'fontDefault' },
  { value: 1.1, label: 'fontLarge' },
  { value: 1.2, label: 'fontExtraLarge' },
]

export const AppearancePage = () => {
  const t = useTranslate()
  const { themePreference, fontScale, locale, useSystemFont } = useSettings()
  const [fontSaveFailed, setFontSaveFailed] = useState(false)
  const name = useId()
  // iPhone / iPad 默认系统字体；用户切回 MiSans 时提示一下流量代价。
  const appleMobile =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return (
    <>
      <Section title={t('avatarMenuSettingsDialogThemeItemLabel')}>
        <div
          className={styles.themeChoices}
          role="radiogroup"
          aria-label={t('avatarMenuSettingsDialogThemeItemLabel')}
        >
          {themeChoices.map((option) => (
            <label
              key={option.value}
              className={styles.themeChoice}
              data-selected={themePreference === option.value}
            >
              <input
                type="radio"
                name={name + '-theme'}
                checked={themePreference === option.value}
                onChange={() => setThemePreference(option.value)}
              />
              <span className={styles.themeSwatch} data-theme={option.value} aria-hidden>
                <i />
                <i />
              </span>
              <span>{t(option.label)}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title={t('settingsFont')}>
        <Select
          ariaLabel={t('settingsFontFamily')}
          settingRow="value"
          value={useSystemFont ? 'system' : 'misans'}
          options={[
            { value: 'misans', label: t('settingsFontMiSans') },
            { value: 'system', label: t('settingsFontSystem') },
          ]}
          onChange={(font) => setFontSaveFailed(!setUseSystemFont(font === 'system'))}
        />
        {fontSaveFailed && (
          <p className={styles.errorNote} role="alert">
            {t('settingsFontSaveFailed')}
          </p>
        )}
        {appleMobile && !useSystemFont && (
          <p className={styles.paragraph}>{t('settingsFontAppleDefault')}</p>
        )}
        <div className={styles.fontPreview}>{t('settingsFontPreview')}</div>
        <div className={styles.segments} role="radiogroup" aria-label={t('settingsFontSize')}>
          {fontChoices.map((option) => (
            <label key={option.value} data-selected={Math.abs(fontScale - option.value) < 0.001}>
              <input
                type="radio"
                name={name + '-font'}
                checked={Math.abs(fontScale - option.value) < 0.001}
                onChange={() => setFontScale(option.value)}
              />
              {t(option.label)}
            </label>
          ))}
        </div>
      </Section>
      <Section title={t('settingsLocalePreference')}>
        <div role="radiogroup" aria-label={t('settingsLocalePreference')}>
          <Choice
            label={t('settingsLocaleZhCN')}
            name={name + '-lang'}
            checked={locale === 'zh-CN'}
            change={() => setLocale('zh-CN')}
          />
          <Choice
            label={t('settingsLocaleEnUS')}
            name={name + '-lang'}
            checked={locale === 'en-US'}
            change={() => setLocale('en-US')}
          />
        </div>
      </Section>
    </>
  )
}

const Choice = ({
  label,
  name,
  checked,
  change,
}: {
  label: string
  name: string
  checked: boolean
  change: () => void
}) => (
  <label className={styles.choiceRow} data-selected={checked}>
    <input type="radio" name={name} checked={checked} onChange={change} />
    <span>{label}</span>
    <span className={styles.choiceCheck} aria-hidden>
      {checked && <IconCheckOutline16 />}
    </span>
  </label>
)

const BackgroundNotifications = () => {
  const t = useTranslate()
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readTaskNotificationPermission>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey>()
  useEffect(() => {
    let active = true
    const refresh = () => {
      void readTaskNotificationPermission()
        .then((current) => {
          if (active) {
            setStatus(current)
          }
        })
        .catch(() => {})
    }
    refresh()
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        refresh()
      }
    })
    return () => {
      active = false
      void listener.then((handle) => handle.remove()).catch(() => {})
    }
  }, [])
  const granted = status?.granted
  const liveProgress = status?.liveProgressEnabled
  const saveLiveProgress = async (enabled: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await setLiveTaskProgress(enabled))
    } catch {
      setError('settingsLiveProgressSaveError')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={t('settingsBackgroundSection')}>
      <Row
        label={t('settingsBackgroundNotifications')}
        description={t('settingsBackgroundNotificationsHelp')}
        value={
          granted === undefined
            ? undefined
            : t(granted ? 'settingsBackgroundAllowed' : 'settingsBackgroundDenied')
        }
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(undefined)
          try {
            setStatus(await openTaskNotificationSettings())
          } catch {
            setError('settingsBackgroundOpenError')
          } finally {
            setBusy(false)
          }
        }}
      />
      {liveProgress !== undefined && (
        <SwitchRow
          label={t('settingsLiveProgress')}
          description={t(liveProgress && status?.liveProgressAllowed === false
            ? 'settingsLiveProgressPermission' : 'settingsLiveProgressHelp')}
          checked={liveProgress}
          disabled={busy}
          change={saveLiveProgress}
        />
      )}
      {error && (
        <p className={`${styles.paragraph} ${styles.errorNote}`} role="alert">
          {t(error)}
        </p>
      )}
    </Section>
  )
}

export const ChatPreferencesPage = ({ openSpeech }: { openSpeech: () => void }) => {
  const t = useTranslate()
  const startupPage = useSettings((s) => s.startupPage)
  const [startupSaveFailed, setStartupSaveFailed] = useState(false)
  const composerEnter = useSettings((s) => s.composerEnter)
  const [composerSaveFailed, setComposerSaveFailed] = useState(false)
  const showModelSwitcher = useSettings((s) => s.showModelSwitcher),
    showReasoningPicker = useSettings((s) => s.showReasoningPicker),
    autoCompress = useSettings((s) => s.autoCompress),
    showUsage = useSettings((s) => s.showUsage)
  return (
    <>
      <Section title={t('settingsStartupAndInput')}>
        <Select
          ariaLabel={t('settingsStartupPage')}
          settingRow="value"
          compactMenu
          value={startupPage}
          options={[
            { value: 'last-chat', label: t('settingsStartupLastChat') },
            { value: 'new-chat', label: t('settingsStartupNewChat') },
          ]}
          onChange={(page) => void setStartupPage(page).then((saved) => setStartupSaveFailed(!saved))}
        />
        {startupSaveFailed && (
          <p className={`${styles.paragraph} ${styles.errorNote}`} role="alert">
            {t('settingsStartupSaveFailed')}
          </p>
        )}
        <Select
          ariaLabel={t('settingsComposerEnter')}
          settingRow="value"
          compactMenu
          value={composerEnter}
          options={[
            { value: 'send', label: t('settingsComposerSend') },
            { value: 'newline', label: t('settingsComposerNewline') },
          ]}
          onChange={(value) => setComposerSaveFailed(!setComposerEnter(value))}
        />
        {composerSaveFailed && (
          <p className={`${styles.paragraph} ${styles.errorNote}`} role="alert">
            {t('settingsComposerSaveFailed')}
          </p>
        )}
      </Section>
      <Section title={t('settingsChatDisplay')}>
        <SwitchRow
          label={t('providerShowSwitcher')}
          checked={showModelSwitcher}
          change={setShowModelSwitcher}
        />
        {showModelSwitcher && (
          <SwitchRow
            label={t('showReasoningPicker')}
            checked={showReasoningPicker}
            change={setShowReasoningPicker}
          />
        )}
        <SwitchRow label={t('settingsShowUsage')} checked={showUsage} change={setShowUsage} />
      </Section>
      <ReadAloudPreferences openSpeech={openSpeech} />
      <Section title={t('longChats')}>
        <SwitchRow label={t('autoCompress')} checked={autoCompress} change={setAutoCompress} />
        <div className={styles.rowNote}>{t('autoCompressHint')}</div>
      </Section>
      {hasAndroidBackgroundWork() && <BackgroundNotifications />}
    </>
  )
}

const ReadAloudPreferences = ({ openSpeech }: { openSpeech: () => void }) => {
  const t = useTranslate()
  const roleVoice = useSettings((s) => s.roleVoice)
  const english = useSettings((s) => s.locale === 'en-US')
  const voice = useSettings((s) => s.ttsVoice)
  const hasDeepSeekKey = useSettings((s) => Boolean(s.apiKey?.trim()))
  const profiles = useProviders((s) => s.profiles)
  const [failed, setFailed] = useState<'mode' | 'plain' | 'roles'>()
  const saveRole = (patch: Parameters<typeof setRoleVoice>[0]) => {
    setFailed(setRoleVoice(patch) ? undefined : 'roles')
  }
  const mode = roleVoice.enabled ? 'characters' : 'plain'
  const profile = roleVoice.enabled ? roleVoiceProfile(profiles, roleVoice) : null
  const voiceOptions = MIMO_PRESET_VOICES.map((voice) => ({
    value: voice.id,
    label: t('settingsRoleVoicePresetOption', { name: voice.id, kind: english ? voice.enLabel : voice.label }),
    shortLabel: voice.id,
  }))
  const plainVoice = (
    <>
      <Select
        ariaLabel={t(roleVoice.enabled ? 'settingsFallbackReadVoice' : 'settingsTtsVoice')}
        settingRow="value"
        compactMenu
        value={voice}
        options={[
          { value: 'stella', label: t('settingsTtsVoiceStella') },
          { value: 'tide', label: t('settingsTtsVoiceTide') },
        ]}
        onChange={(next) => setFailed(setTtsVoice(next) ? undefined : 'plain')}
      />
      {failed === 'plain' ? (
        <div className={`${styles.rowNote} ${styles.errorNote}`} role="alert">
          {t('settingsReadAloudSaveFailed')}
        </div>
      ) : roleVoice.enabled || !hasDeepSeekKey ? (
        <div className={styles.rowNote}>
          {t(roleVoice.enabled ? 'settingsFallbackReadVoiceHint' : 'settingsPlainReadAloudNeedKey')}
        </div>
      ) : null}
    </>
  )
  return (
    <Section title={t('settingsReadAloud')}>
      <Select
        ariaLabel={t('settingsReadAloudMode')}
        settingRow="value"
        compactMenu
        showSelectedDetail={false}
        value={mode}
        options={[
          { value: 'plain', label: t('settingsPlainReadAloud'), detail: t('settingsPlainReadAloudHint') },
          { value: 'characters', label: t('settingsRoleVoice'), detail: t('settingsRoleVoiceHint') },
        ]}
        onChange={(next) => {
          if (next === mode) {
            return
          }
          if (setRoleVoice({ enabled: next === 'characters' })) {
            stopReadAloud()
            setFailed(undefined)
          } else {
            setFailed('mode')
          }
        }}
      />
      {failed === 'mode' && (
        <div className={`${styles.rowNote} ${styles.errorNote}`} role="alert">
          {t('settingsReadAloudSaveFailed')}
        </div>
      )}
      {roleVoice.enabled ? (
        <>
          <Row
            label={t('providerSpeechTitle')}
            className={styles.readAloudService}
            target="chatSpeech"
            value={profile
              ? roleVoice.source === 'custom' ? t('providerSpeechCustom') : profile.name
              : t('settingsSpeechNeedsSetup')}
            description={!profile && hasDeepSeekKey ? t('settingsSpeechFallbackActive') : undefined}
            onClick={openSpeech}
          />
          <SettingsDisclosure title={t('settingsRoleVoiceDefaults')} settingRow>
            <Select
              ariaLabel={t('settingsRoleVoiceNarrator')}
              settingRow="value"
              compactMenu
              value={roleVoice.narratorVoice}
              options={voiceOptions}
              onChange={(narratorVoice) => saveRole({ narratorVoice })}
            />
            <div className={styles.rowNote}>{t('settingsRoleVoiceNarratorHint')}</div>
            <Select
              ariaLabel={t('settingsRoleVoiceLead')}
              settingRow="value"
              compactMenu
              showSelectedDetail={false}
              value={roleVoice.leadVoice}
              options={[
                {
                  value: 'description',
                  label: t('settingsLeadVoiceDescribed'),
                  detail: t('settingsLeadVoiceDescribedHint'),
                },
                {
                  value: 'preset',
                  label: t('settingsLeadVoicePreset'),
                  detail: t('settingsLeadVoicePresetHint'),
                },
              ]}
              onChange={(leadVoice) => saveRole({ leadVoice })}
            />
            <SwitchRow
              label={t('settingsRoleVoiceShare')}
              checked={roleVoice.extrasShareVoice}
              change={(extrasShareVoice) => saveRole({ extrasShareVoice })}
            />
            {roleVoice.extrasShareVoice && (
              <>
                <Select
                  ariaLabel={t('settingsRoleVoiceExtra')}
                  settingRow="value"
                  compactMenu
                  value={roleVoice.extraVoice}
                  options={voiceOptions}
                  onChange={(extraVoice) => saveRole({ extraVoice })}
                />
                <div className={styles.rowNote}>{t('settingsRoleVoiceShareHint')}</div>
              </>
            )}
            {failed === 'roles' && (
              <div className={`${styles.rowNote} ${styles.errorNote}`} role="alert">
                {t('settingsReadAloudSaveFailed')}
              </div>
            )}
            {hasDeepSeekKey && plainVoice}
          </SettingsDisclosure>
        </>
      ) : plainVoice}
    </Section>
  )
}
