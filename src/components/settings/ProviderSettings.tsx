import { useId, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ApiError } from '../../services/api/errorTypes.js'
import {
  PROVIDER_PRESETS,
  providerAccess,
  type ProviderAccess,
  type ProviderPreset,
} from '../../services/providerPresets.js'
import {
  activeReasoning,
  emptyProfile,
  modelLabel,
  modelsInProfile,
  OFFICIAL_MODELS,
  ProviderConfigError,
  providerModelLabel,
  selectModel,
  setOfficialReasoningDefault,
  useProviders,
  type ProviderProfile,
} from '../../services/providers.js'
import { useSettings } from '../../services/settings.js'
import {
  IconAddOutline16,
  IconBrowseOutline16,
  IconChevronLeftOutline16,
  IconInfoOutline16,
  IconLinkOutline14,
  IconSearchOutline16,
  IconSettingsOutline16,
} from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Button } from '../base/Button.js'
import { ReasoningRow } from './ReasoningRow.js'
import { Row, Section } from './SettingsRows.js'
import styles from './ProviderSettings.module.css'
import mimoIcon from '../../assets/providers/xiaomimimo.png'
import zhipuIcon from '../../assets/providers/zhipu.png'
import kimiIcon from '../../assets/providers/kimi.png'
import arkIcon from '../../assets/providers/volcengine.png'
import qwenIcon from '../../assets/providers/qwen.png'
import minimaxIcon from '../../assets/providers/minimax.png'
import siliconIcon from '../../assets/providers/siliconcloud.png'
import geminiIcon from '../../assets/providers/gemini.png'
import openaiIcon from '../../assets/providers/openai.png'
import claudeIcon from '../../assets/providers/claude.png'
import openrouterIcon from '../../assets/providers/openrouter.png'
import opencodeIcon from '../../assets/providers/opencode.png'
import deepseekIcon from '../../assets/providers/deepseek.png'

const icons: Record<string, string> = {
  xiaomimimo: mimoIcon,
  zhipu: zhipuIcon,
  kimi: kimiIcon,
  volcengine: arkIcon,
  qwen: qwenIcon,
  minimax: minimaxIcon,
  siliconcloud: siliconIcon,
  gemini: geminiIcon,
  openai: openaiIcon,
  claude: claudeIcon,
  openrouter: openrouterIcon,
  opencode: opencodeIcon,
  'opencode-go': opencodeIcon,
  deepseek: deepseekIcon,
}
export const providerPresetDescriptions: Record<string, TranslationKey | undefined> = {
  zhipu: 'providerCatalogZhipu',
  kimi: 'providerCatalogKimi',
  volcengine: 'providerCatalogArk',
  qwen: 'providerCatalogQwen',
  siliconcloud: 'providerCatalogMultiModel',
  gemini: 'providerCatalogGemini',
  openai: 'providerCatalogOpenAI',
  claude: 'providerCatalogClaude',
  openrouter: 'providerCatalogMultiModel',
  opencode: 'providerCatalogOpenCodeZen',
  'opencode-go': 'providerCatalogOpenCodeGo',
}
export const ProviderMark = ({ id }: { id?: string }) => {
  const src = id && icons[id]
  return src ? <img className={styles.mark} src={src} alt="" /> : <IconBrowseOutline16 />
}
export const providerErrorText = (error: unknown, t: ReturnType<typeof useTranslate>) => {
  const config: Record<ProviderConfigError['reason'], TranslationKey> = {
    url: 'providerErrorUrl',
    model: 'providerErrorModel',
    parameters: 'providerErrorParameters',
    storage: 'providerErrorStorage',
    missing: 'providerConfigMissing',
    changed: 'providerConfigChanged',
  }
  return error instanceof ProviderConfigError
    ? t(config[error.reason])
    : error instanceof ApiError && error.localMessage
      ? t(error.localMessage.key, error.localMessage.params)
      : t('providerNetworkError')
}

export const ConnectionSelector = () => {
  const t = useTranslate()
  const state = useProviders()
  const settings = useSettings()
  const { profiles, selection } = state
  const profile = profiles.find((item) => item.id === selection.providerId)
  const usable = profiles.filter((item) => item.model)
  const models = profile ? [...new Set([selection.model, ...modelsInProfile(profile)])] : []
  const control = activeReasoning(state, settings)
  const groupId = useId()
  const [error, setError] = useState('')
  const change = (action: () => void) => {
    try {
      action()
      setError('')
    } catch (reason) {
      setError(providerErrorText(reason, t))
    }
  }
  return (
    <div className={styles.connectionRows}>
      {usable.length > 0 && (
        <Select
          ariaLabel={t('providerSelectService')}
          settingRow="value"
          value={selection.providerId}
          options={[
            { value: 'deepseek', label: t('providerOfficial') },
            ...usable.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onChange={(id) =>
            change(() =>
              selectModel({
                providerId: id,
                model: usable.find((item) => item.id === id)?.model ?? OFFICIAL_MODELS[0],
              })
            )
          }
        />
      )}
      {profile ? (
        <Select
          ariaLabel={t('providerModel')}
          settingRow="value"
          value={selection.model}
          options={models.map((model) => ({
            value: model,
            label: providerModelLabel(model, profile),
          }))}
          onChange={(model) => change(() => selectModel({ providerId: profile.id, model }))}
        />
      ) : (
        <div
          className={styles.modelChoices}
          role="radiogroup"
          aria-label={t('providerDefaultModel')}
        >
          {OFFICIAL_MODELS.map((model) => (
            <label key={model} data-selected={selection.model === model}>
              <input
                type="radio"
                name={groupId}
                checked={selection.model === model}
                onChange={() => change(() => selectModel({ providerId: 'deepseek', model }))}
              />
              <span>
                <b>{modelLabel(model)}</b>
                <small>
                  {t(
                    model === 'deepseek-flash' ? 'providerFlashCapability' : 'providerProCapability'
                  )}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      {!profile && control && (
        <ReasoningRow
          control={control}
          onChange={(level) => change(() => setOfficialReasoningDefault(selection.model, level))}
        />
      )}
      {error && (
        <p className={styles.error + ' ' + styles.insetHint} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const ProviderSettingsPage = ({
  add,
  edit,
  search,
  onOfficial,
}: {
  add: () => void
  edit: (id: string) => void
  search: () => void
  onOfficial: () => void
}) => {
  const t = useTranslate()
  const { profiles, selection } = useProviders()
  const configured = useSettings((s) => s.thirdPartySearch.enabled)
  const officialConfigured = useSettings((s) => Boolean(s.apiKey))
  return (
    <>
      <Section
        title={t('providerConnections')}
        action={
          <button
            type="button"
            className={styles.textAction}
            data-settings-target="providerCatalog"
            onClick={add}
          >
            <IconAddOutline16 />
            {t('providerAddConnection')}
          </button>
        }
      >
        {!profiles.length && <p className={styles.insetHint}>{t('providerCustomEmpty')}</p>}
        {profiles.map((profile) => {
          const count = t('providerModelsN', { count: modelsInProfile(profile).length })
          return (
            <Row
              key={profile.id}
              label={profile.name}
              className={styles.providerRow}
              description={new URL(profile.url).host}
              detail={
                profile.model
                  ? t('providerDefaultNamed', {
                      model: providerModelLabel(profile.model, profile),
                    }) +
                    ' · ' +
                    count
                  : count
              }
              icon={<ProviderMark id={profile.preset?.id} />}
              prominent
              badge={profile.id === selection.providerId ? t('providerActive') : undefined}
              onClick={() => edit(profile.id)}
              target="providerModels"
            />
          )
        })}
      </Section>
      <Section title={t('providerChatTools')}>
        <Row
          label={t('thirdPartySearchTitle')}
          className={styles.providerRow}
          description={configured ? t('providerSearchConfigured') : 'DeepSeek Search'}
          icon={<ProviderMark id="deepseek" />}
          prominent
          onClick={search}
          target="providerSearch"
        />
      </Section>
      <aside
        className={styles.advancedNotice}
        aria-label={t('advancedNoticeTitle')}
        data-testid="advanced-provider-notice"
      >
        <span className={styles.noticeIcon} aria-hidden>
          <IconInfoOutline16 />
        </span>
        <div>
          <h2>{t('advancedNoticeTitle')}</h2>
          <p>{t(officialConfigured ? 'advancedNoticeConfigured' : 'advancedNoticeUnconfigured')}</p>
          <button type="button" onClick={onOfficial}>
            <IconChevronLeftOutline16 />
            {t('advancedReturnOfficial')}
          </button>
        </div>
      </aside>
    </>
  )
}

export const ProviderCatalogPage = ({
  choose,
  manual,
}: {
  choose: (preset: ProviderPreset) => void
  manual: () => void
}) => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<ProviderPreset['region']>('domestic')
  const needle = query.trim().toLocaleLowerCase()
  const describe = (preset: ProviderPreset) => {
    const description = providerPresetDescriptions[preset.id]
    if (preset.access.length > 1) {
      return t('providerAccessApi') + ' · ' + t('providerAccessTokenPlan')
    }
    return description ? t(description) : new URL(preset.access[0].url).hostname
  }
  const options = PROVIDER_PRESETS.filter((item) =>
    needle
      ? [item.name, item.id, describe(item)].some((value) =>
          value.toLocaleLowerCase().includes(needle)
        )
      : item.region === region
  )
  return (
    <div className={styles.catalog}>
      <label className={styles.searchField}>
        <IconSearchOutline16 />
        <input
          type="search"
          aria-label={t('providerSearchVendors')}
          placeholder={t('providerSearchVendors')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {!needle && (
        <div className={styles.regions} role="group" aria-label={t('providerCatalog')}>
          {(['domestic', 'international'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={region === value}
              onClick={() => setRegion(value)}
            >
              {t(value === 'domestic' ? 'providerDomestic' : 'providerInternational')}
            </button>
          ))}
        </div>
      )}
      {options.length > 0 ? (
        <Section>
          {options.map((item) => (
            <Row
              key={item.id}
              label={item.name}
              className={styles.providerRow}
              icon={<ProviderMark id={item.id} />}
              prominent
              description={describe(item)}
              onClick={() => choose(item)}
              target={item.access.length > 1 ? 'providerAccess' : 'providerConnection'}
            />
          ))}
        </Section>
      ) : (
        <p className={styles.hint} role="status">
          {t('optionNoResults')}
        </p>
      )}
      <Section>
        <Row
          label={t('providerManualConfig')}
          className={styles.providerRow}
          icon={
            <span className={styles.iconTile}>
              <IconSettingsOutline16 />
            </span>
          }
          prominent
          onClick={manual}
          target="providerConnection"
        />
      </Section>
    </div>
  )
}

export const providerAccessLabel = (access: ProviderAccess) =>
  access.id === 'tokenPlan' ? 'providerAccessTokenPlan' : 'providerAccessApi'

export const newProviderConnection = (
  preset: ProviderPreset,
  access: ProviderAccess
): ProviderProfile => ({
  ...emptyProfile(),
  preset: { id: preset.id, access: access.id },
  url: access.url,
  protocol: access.protocol,
  name:
    preset.name + (preset.access.length > 1 && access.id === 'tokenPlan' ? ' · Token Plan' : ''),
  streamUsage: access.streamUsage ?? false,
  tokenParameter: access.completionTokens ? 'max_completion_tokens' : 'max_tokens',
})

export const ProviderAccessPage = ({
  preset,
  choose,
}: {
  preset: ProviderPreset
  choose: (access: ProviderAccess) => void
}) => {
  const t = useTranslate()
  const groupId = useId()
  const [id, setId] = useState(preset.access[0].id)
  const selected = providerAccess(preset.id, id) ?? preset.access[0]
  return (
    <div className={styles.page}>
      <div className={styles.providerIdentity}>
        <ProviderMark id={preset.id} />
        <span>
          <strong>{preset.name}</strong>
          <small>{t('providerAccessHint')}</small>
        </span>
      </div>
      <div
        className={styles.accessOptions}
        role="radiogroup"
        aria-label={t('providerChooseAccess')}
      >
        {preset.access.map((access) => (
          <label key={access.id} data-selected={id === access.id}>
            <input
              type="radio"
              name={groupId}
              checked={id === access.id}
              onChange={() => setId(access.id)}
            />
            <span>
              <strong>{t(providerAccessLabel(access))}</strong>
              <small>
                {t(access.id === 'tokenPlan' ? 'providerAccessPlanKey' : 'providerAccessApiKey')}
              </small>
              <small>{access.url}</small>
            </span>
          </label>
        ))}
      </div>
      <a className={styles.docsLink} href={selected.docs} target="_blank" rel="noreferrer">
        <IconLinkOutline14 />
        {t('providerAccessDocs')}
      </a>
      <div className={styles.footer} data-provider-actions="">
        <Button variant="primary" onClick={() => choose(selected)}>
          {t('providerContinue')}
        </Button>
      </div>
    </div>
  )
}
