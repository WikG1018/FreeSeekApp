import { useId, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  setFontScale,
  setAutoCompress,
  setLocale,
  setShowModelSwitcher,
  setShowReasoningPicker,
  setShowUsage,
  setStartupPage,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Section, SwitchRow } from './SettingsRows.js'
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
  const { themePreference, fontScale, locale } = useSettings()
  const name = useId()
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
      <Section title={t('settingsFontSize')}>
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

export const ChatPreferencesPage = () => {
  const t = useTranslate(),
    name = useId()
  const startupPage = useSettings((s) => s.startupPage)
  const [startupSaveFailed, setStartupSaveFailed] = useState(false)
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
    </>
  )
}
