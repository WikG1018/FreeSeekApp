import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { modelLabel, useProviders } from '../../services/providers.js'
import { localizePersona, usePersonas } from '../../services/personas.js'
import {
  IconBrowseOutline16,
  IconBookOutline16,
  IconClockOutline16,
  IconDataOutline16,
  IconFileOutline16,
  IconInfoOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUserOutline16,
} from '../base/icons.js'
import { Row, Section } from './SettingsRows.js'
import { parentSettingsPage, type SettingsPageId } from './settingsDialogState.js'

export const pageTitles: Record<SettingsPageId, TranslationKey> = {
  home: 'settings',
  account: 'settingsApiService',
  providers: 'providerAdvanced',
  providerCatalog: 'providerCatalog',
  providerAccess: 'providerChooseAccess',
  providerConnection: 'providerConnection',
  providerModels: 'providerManageModels',
  providerModel: 'providerModelSettings',
  providerSearch: 'thirdPartySearchTitle',
  providerSpeech: 'providerSpeechTitle',
  chat: 'settingsChatPreferences',
  chatSpeech: 'providerSpeechTitle',
  personas: 'personaManagerTitle',
  personaEdit: 'settingsEditPersona',
  assistantSettings: isWindowsDesktop() ? 'assistantMemory' : 'assistantSettings',
  memories: 'assistantMemories',
  memoryDetails: 'assistantMemoryDetails',
  memorySuggestions: 'assistantPendingMemories',
  agents: 'assistantAgents',
  agentDetails: 'assistantAgentDetails',
  agentTools: 'assistantAgentGlobalTools',
  agentExtensions: 'projectExtensions',
  agentEdit: 'assistantAgentEdit',
  appearance: 'settingsAppearanceLanguage',
  usage: 'usageTitle',
  usagePricing: 'usagePricingTitle',
  usageModels: 'usageModelsTitle',
  usageModel: 'usageModelTitle',
  screenTime: 'screenTimeTitle',
  data: 'settingsDataManage',
  about: 'settingsAboutApp',
  aboutInfo: 'settingsPrivacyLicenses',
  easterEggs: 'milestoneEasterEggs',
  disclaimer: 'disclaimerTitle',
  guide: 'guideTitle',
}
const groups = [
  {
    title: 'settingsChatGroup',
    items: [
      ['account', IconBrowseOutline16],
      ['chat', IconSettingsOutline16],
      ['personas', IconUserOutline16],
      ['assistantSettings', IconBookOutline16],
    ],
  },
  {
    title: 'settingsSectionApp',
    items: [
      ['appearance', IconLightOutline16],
      ['usage', IconDataOutline16],
      ['screenTime', IconClockOutline16],
      ['data', IconFileOutline16],
      ['about', IconInfoOutline16],
    ],
  },
] as const

export const SettingsDirectory = ({
  open,
  active,
  rail = false,
}: {
  open: (page: SettingsPageId) => void
  active: SettingsPageId
  rail?: boolean
}) => {
  const t = useTranslate()
  const apiKey = useSettings((s) => s.apiKey),
    theme = useSettings((s) => s.themePreference)
  const selection = useProviders((s) => s.selection)
  const locale = useSettings((s) => s.locale)
  const persona = usePersonas((s) => s.personas.find((p) => p.id === s.defaultId))
  const count = useChatStore((s) => s.sessions.length)
  const values: Partial<Record<SettingsPageId, string>> = {
    account:
      selection.providerId === 'deepseek' && !apiKey
        ? t('settingsApiKeyMissing')
        : modelLabel(selection.model),
    personas: persona ? localizePersona(persona, locale).name : undefined,
    appearance: t(
      theme === 'system' ? 'themeSystem' : theme === 'dark' ? 'themeDark' : 'themeLight'
    ),
    data: t('settingsSessionsCount', { count }),
    about:
      document.querySelector('meta[name="application-version"]')?.getAttribute('content') ??
      undefined,
  }
  return (
    <nav aria-label={t('settings')} data-testid={rail ? 'settings-rail' : 'settings-directory'}>
      {groups.map((group) => (
        <Section key={group.title} title={t(group.title)}>
          {group.items.map(([id, Icon]) => (
            <Row
              key={id}
              label={t(pageTitles[id])}
              icon={<Icon />}
              value={rail ? undefined : values[id]}
              onClick={() => open(id)}
              target={id}
              current={
                rail &&
                (active === id ||
                  parentSettingsPage(active) === id ||
                  (id === 'assistantSettings' && active === 'agentEdit') ||
                  (id === 'usage' && active === 'usageModel') ||
                  (id === 'account' && active.startsWith('provider')))
              }
            />
          ))}
        </Section>
      ))}
    </nav>
  )
}
