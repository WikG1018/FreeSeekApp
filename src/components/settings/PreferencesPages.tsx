import { useEffect, useId, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import {
  hasAndroidBackgroundWork,
  openTaskNotificationSettings,
  readTaskNotificationPermission,
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
import { roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { useProviders } from '../../services/providers.js'
import { openSettings } from './settingsDialogState.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Row, Section, SwitchRow } from './SettingsRows.js'
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
  const [granted, setGranted] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void readTaskNotificationPermission()
        .then(({ granted }) => {
          if (active) {
            setGranted(granted)
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
          setError(false)
          try {
            setGranted((await openTaskNotificationSettings()).granted)
          } catch {
            setError(true)
          } finally {
            setBusy(false)
          }
        }}
      />
      {error && (
        <p className={styles.paragraph} role="alert">
          {t('settingsBackgroundOpenError')}
        </p>
      )}
    </Section>
  )
}

export const ChatPreferencesPage = () => {
  const t = useTranslate(),
    name = useId()
  const startupPage = useSettings((s) => s.startupPage)
  const [startupSaveFailed, setStartupSaveFailed] = useState(false)
  const composerEnter = useSettings((s) => s.composerEnter)
  const [composerSaveFailed, setComposerSaveFailed] = useState(false)
  const showModelSwitcher = useSettings((s) => s.showModelSwitcher),
    showReasoningPicker = useSettings((s) => s.showReasoningPicker),
    autoCompress = useSettings((s) => s.autoCompress),
    showUsage = useSettings((s) => s.showUsage),
    voice = useSettings((s) => s.ttsVoice)
  return (
    <>
      <Section>
        <Select
          ariaLabel={t('settingsStartupPage')}
          settingRow="value"
          compactMenu
          value={startupPage}
          options={[
            { value: 'last-chat', label: t('settingsStartupLastChat') },
            { value: 'new-chat', label: t('settingsStartupNewChat') },
          ]}
          onChange={(page) => setStartupSaveFailed(!setStartupPage(page))}
        />
        {startupSaveFailed && (
          <p className={`${styles.paragraph} ${styles.errorNote}`} role="alert">
            {t('settingsStartupSaveFailed')}
          </p>
        )}
      </Section>
      <Section title={t('settingsChatInput')}>
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
      {hasAndroidBackgroundWork() && <BackgroundNotifications />}
      <Section title={t('longChats')}>
        <SwitchRow label={t('autoCompress')} checked={autoCompress} change={setAutoCompress} />
        <p className={styles.paragraph}>{t('autoCompressHint')}</p>
      </Section>
      <Section title={t('settingsTtsVoice')}>
        <div role="radiogroup" aria-label={t('settingsTtsVoice')}>
          <Choice
            name={name}
            label={t('settingsTtsVoiceStella')}
            checked={voice === 'stella'}
            change={() => setTtsVoice('stella')}
          />
          <Choice
            name={name}
            label={t('settingsTtsVoiceTide')}
            checked={voice === 'tide'}
            change={() => setTtsVoice('tide')}
          />
        </div>
      </Section>
      <RoleVoiceSettings />
    </>
  )
}

/** 角色配音：开关 + 朗读模型 + 主角/旁白/路人音色。只在开关打开时展开下面几项。 */
const RoleVoiceSettings = () => {
  const t = useTranslate()
  const roleVoice = useSettings((s) => s.roleVoice)
  const english = useSettings((s) => s.locale === 'en-US')
  const profiles = useProviders((s) => s.profiles)
  const [saveFailed, setSaveFailed] = useState(false)
  const save = (patch: Parameters<typeof setRoleVoice>[0]) => setSaveFailed(!setRoleVoice(patch))
  const profile = roleVoiceProfile(profiles, roleVoice)
  // 菜单里显示「名字 · 听感」，行内右值只显示名字（shortLabel），保持单行
  const voiceOptions = MIMO_PRESET_VOICES.map((voice) => ({
    value: voice.id,
    label: t('settingsRoleVoicePresetOption', { name: voice.id, kind: english ? voice.enLabel : voice.label }),
    shortLabel: voice.id,
  }))
  return (
    <Section>
      <SwitchRow
        label={t('settingsRoleVoice')}
        description={t('settingsRoleVoiceHint')}
        checked={roleVoice.enabled}
        change={(enabled) => save({ enabled })}
      />
      {saveFailed && (
        <p className={`${styles.paragraph} ${styles.errorNote}`} role="alert">
          {t('settingsRoleVoiceSaveFailed')}
        </p>
      )}
      {roleVoice.enabled && (
        <>
          <Row
            label={t('settingsRoleVoiceModel')}
            target="providerSpeech"
            description={profile
              ? roleVoice.source === 'custom' ? t('providerSpeechCustom') : t('settingsRoleVoiceModelReuse')
              : t('settingsRoleVoiceModelMissing')}
            detail={profile && roleVoice.source === 'follow' ? profile.name : undefined}
            onClick={() => openSettings('providerSpeech')}
          />
          <Select
            ariaLabel={t('settingsRoleVoiceLead')}
            settingRow="value"
            compactMenu
            value={roleVoice.leadVoice}
            options={[
              { value: 'preset', label: t('settingsRoleVoiceLeadPreset') },
              { value: 'description', label: t('settingsRoleVoiceLeadDescription') },
            ]}
            onChange={(leadVoice) => save({ leadVoice })}
          />
          {roleVoice.leadVoice === 'description' && (
            <p className={styles.paragraph}>{t('settingsRoleVoiceLeadHint')}</p>
          )}
          <Select
            ariaLabel={t('settingsRoleVoiceNarrator')}
            settingRow="value"
            compactMenu
            value={roleVoice.narratorVoice}
            options={voiceOptions}
            onChange={(value) => save({ narratorVoice: value as typeof roleVoice.narratorVoice })}
          />
          <SwitchRow
            label={t('settingsRoleVoiceShare')}
            description={t('settingsRoleVoiceShareHint')}
            checked={roleVoice.extrasShareVoice}
            change={(extrasShareVoice) => save({ extrasShareVoice })}
          />
          {roleVoice.extrasShareVoice && (
            <Select
              ariaLabel={t('settingsRoleVoiceExtra')}
              settingRow="value"
              compactMenu
              value={roleVoice.extraVoice}
              options={voiceOptions}
              onChange={(extraVoice) => save({ extraVoice })}
            />
          )}
        </>
      )}
    </Section>
  )
}
