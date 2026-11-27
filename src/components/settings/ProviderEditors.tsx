import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchProviderCatalog,
  testProviderModel,
  type ProviderCatalogModel,
} from '../../services/api/providerClient.js'
import {
  isMiMoHost,
  isOfficialMiMoV26,
  MIMO_API_BASE_URL,
  MIMO_TOKEN_PLAN_BASE_URL,
  presetConnectionName,
  presetName,
  providerAccess,
  providerPreset,
} from '../../services/providerPresets.js'
import {
  modelsInProfile,
  modelSettingsFor,
  ProviderConfigError,
  providerModelContextWindow,
  providerModelLabel,
  providerModelOutputLimit,
  providerModelParameters,
  saveProvider,
  validModel,
  validateProviderUrl,
  type ProviderModelSettings,
  type ProviderProfile,
  type ProviderProtocol,
} from '../../services/providers.js'
import {
  adapterSupports,
  customReasoning,
  reasoningLevelsFor,
  REASONING_ADAPTERS,
} from '../../services/reasoning.js'
import { saveThirdPartySearch, setRoleVoice, useSettings } from '../../services/settings.js'
import { useProviders } from '../../services/providers.js'
import { MIMO_TTS_MODEL, MIMO_TTS_DESIGN_MODEL } from '../../services/api/speech.js'
import { describeReadAloudError, previewRoleVoice, stopReadAloud, useReadAloud } from '../../services/speech/readAloud.js'
import { reusableVoiceProfiles, roleVoiceProfile } from '../../services/speech/roleVoiceProfile.js'
import { openExternal } from '../../utils/openExternal.js'
import { Button } from '../base/Button.js'
import {
  IconAddOutline16,
  IconBookOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconLinkOutline14,
  IconPlayMediaOutline16,
  IconRefreshOutline16,
  IconRightUpOutline14,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconStopFill16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import panelStyles from '../base/OptionPanel.module.css'
import { Select, type SelectOption } from '../base/Select.js'
import { reasoningLabels } from '../base/ReasoningOptions.js'
import { showToast } from '../base/toastState.js'
import {
  ProviderMark,
  providerAccessLabel,
  providerErrorText,
  providerPresetDescriptions,
  RemoveProviderDialog,
} from './ProviderSettings.js'
import { ReasoningRow } from './ReasoningRow.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Row, Section, SwitchRow, TutorialSteps } from './SettingsRows.js'
import { useSettingsLeave } from './useSettingsLeave.js'
import settingsStyles from './Settings.module.css'
import styles from './ProviderSettings.module.css'

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className={styles.field}>
    <span>{label}</span>
    {children}
  </label>
)

const KeyField = ({
  label,
  value,
  change,
  placeholder,
  helpHref,
}: {
  label: string
  value: string
  change: (value: string) => void
  placeholder?: string
  helpHref?: string
}) => {
  const t = useTranslate()
  const id = useId()
  const [visible, setVisible] = useState(false)
  return (
    <div className={styles.field}>
      <div className={styles.fieldHeading}>
        <label htmlFor={id}>{label}</label>
        {helpHref && (
          <a className={styles.textAction} href={helpHref} target="_blank" rel="noreferrer">
            <IconLinkOutline14 />
            {t('providerGetKey')}
          </a>
        )}
      </div>
      <div className={styles.keyField}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={8192}
          onChange={(event) => change(event.target.value)}
        />
        <button
          type="button"
          className={styles.eyeButton}
          aria-label={t(visible ? 'settingsApiKeyHide' : 'settingsApiKeyShow')}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
        </button>
      </div>
    </div>
  )
}

const protocolOptions: SelectOption<ProviderProtocol>[] = [
  { value: 'openai', label: 'OpenAI Chat Completions', detail: '/chat/completions' },
  { value: 'responses', label: 'OpenAI Responses', detail: '/responses' },
  { value: 'anthropic', label: 'Anthropic Messages', detail: '/messages' },
  { value: 'gemini', label: 'Gemini GenerateContent', detail: ':generateContent' },
]
const check = (
  text: string,
  checked: boolean,
  change: (value: boolean) => void,
  disabled = false
) => (
  <label className={styles.check}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => change(event.target.checked)}
    />
    {text}
  </label>
)

export const ProviderConnectionPage = ({
  initial,
  onSaved,
  onDeleted,
}: {
  initial: ProviderProfile
  onSaved: (id: string) => void
  onDeleted: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [form, setForm] = useState(initial)
  const [headerText, setHeaderText] = useState(() => JSON.stringify(initial.headers, null, 2))
  const [bodyText, setBodyText] = useState(() => JSON.stringify(initial.extraBody, null, 2))
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const leave = useSettingsLeave(
    JSON.stringify(form) !== JSON.stringify(initial) ||
      headerText !== JSON.stringify(initial.headers, null, 2) ||
      bodyText !== JSON.stringify(initial.extraBody, null, 2)
  )
  const update = <T extends keyof ProviderProfile>(key: T, value: ProviderProfile[T]) =>
    setForm((previous) => ({ ...previous, [key]: value }))
  const access = providerAccess(initial.preset?.id, initial.preset?.access)
  const preset = providerPreset(initial.preset?.id)
  const usePresetUrl = access && form.url.trim().replace(/\/+$/, '') === access.url
  const presetDescription =
    preset && preset.access.length === 1 && usePresetUrl
      ? providerPresetDescriptions[preset.id]
      : undefined
  const isMiMoChinaPlan = preset?.id === 'xiaomimimo' && usePresetUrl && access.id === 'tokenPlan'
  const accessKeyLabel =
    access?.id === 'go'
      ? 'providerOpenCodeGoKey'
      : access && access.id !== 'api'
        ? 'providerPlanKey'
        : 'providerKey'
  const accessKeyPlaceholder =
    access?.id === 'go'
      ? 'providerPasteOpenCodeGoKey'
      : access?.id === 'codingPlan'
        ? 'providerPasteCodingPlanKey'
        : access?.id === 'tokenPlan'
          ? 'providerPastePlanKey'
          : 'providerPasteApiKey'
  const save = () => {
    try {
      let headers: ProviderProfile['headers'], extraBody: ProviderProfile['extraBody']
      try {
        headers = JSON.parse(headerText.trim() || '{}')
        extraBody = JSON.parse(bodyText.trim() || '{}')
      } catch {
        throw new ProviderConfigError('parameters')
      }
      const saved = saveProvider({ ...form, headers, extraBody })
      showToast({ key: 'providerSaved' })
      onSaved(saved.id)
    } catch (reason) {
      setError(providerErrorText(reason, t))
    }
  }
  return (
    <form
      className={styles.page}
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      {preset && (
        <div className={styles.providerIdentity}>
          <ProviderMark id={preset.id} />
          <span>
            <strong>
              {access ? presetConnectionName(preset, access, locale) : presetName(preset, locale)}
            </strong>
            {access && (
              <small>
                {t(presetDescription ?? providerAccessLabel(access, preset.id))}
                {isMiMoChinaPlan && ' · ' + t('providerAccessChina')}
              </small>
            )}
          </span>
        </div>
      )}
      <Section title={t('providerInfoGroup')}>
        <div className={styles.formFields}>
          <Field label={t('providerName')}>
            <input
              value={form.name}
              maxLength={80}
              onChange={(event) => update('name', event.target.value)}
            />
          </Field>
          <Field label={t('providerUrl')}>
            <input
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://"
              value={form.url}
              maxLength={4096}
              required
              onChange={(event) => update('url', event.target.value)}
            />
          </Field>
          <div className={styles.field}>
            <span>{t('providerProtocol')}</span>
            <Select
              ariaLabel={t('providerProtocol')}
              options={protocolOptions.map((option) =>
                option.value === 'openai'
                  ? { ...option, shortLabel: t('providerOpenAiCompatible') }
                  : option
              )}
              value={form.protocol}
              onChange={(value) => update('protocol', value)}
            />
          </div>
          {form.url.trim().toLowerCase().startsWith('http:') && (
            <p className={styles.hint}>{t('providerHttpHint')}</p>
          )}
        </div>
      </Section>
      <Section title={t('providerAuthGroup')}>
        <div className={styles.formFields}>
          <KeyField
            label={t(accessKeyLabel)}
            value={form.apiKey}
            change={(value) => update('apiKey', value)}
            placeholder={
              preset && t(accessKeyPlaceholder, { provider: presetName(preset, locale) })
            }
            helpHref={access?.docs}
          />
          {!access && <p className={styles.hint}>{t('providerKeyHint')}</p>}
        </div>
      </Section>
      <div className={styles.moreOptions}>
        <h2 className={styles.groupHeading}>{t('providerMore')}</h2>
        <SettingsDisclosure
          title={t('providerConnectionAdvanced')}
          description={t('providerConnectionAdvancedHint')}
        >
          <div className={styles.fields}>
            <Field label={t('providerModelsUrl')}>
              <input
                type="url"
                inputMode="url"
                spellCheck={false}
                value={form.modelListUrl}
                onChange={(event) => update('modelListUrl', event.target.value)}
              />
            </Field>
            <Field label={t('providerHeaders')}>
              <textarea
                rows={3}
                value={headerText}
                onChange={(event) => setHeaderText(event.target.value)}
              />
            </Field>
            <Field label={t('providerExtraBody')}>
              <textarea
                rows={4}
                value={bodyText}
                onChange={(event) => setBodyText(event.target.value)}
              />
            </Field>
            <p className={styles.hint}>{t('providerExtraHint')}</p>
            {initial.id && (
              <Row label={t('providerDelete')} danger onClick={() => setDeleting(true)} />
            )}
          </div>
        </SettingsDisclosure>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.footer} data-provider-actions="">
        <Button type="submit" disabled={!form.url.trim() || (!!access && !form.apiKey.trim())}>
          {t('providerSaveModels')}
        </Button>
      </div>
      {leave.dialog}
      {deleting && (
        <RemoveProviderDialog
          profile={initial}
          onClose={() => setDeleting(false)}
          onRemoved={onDeleted}
        />
      )}
    </form>
  )
}

export const ProviderModelsPage = ({
  profile,
  catalog,
  setCatalog,
  editConnection,
  editModel,
}: {
  profile: ProviderProfile
  catalog: ProviderCatalogModel[]
  setCatalog: (models: ProviderCatalogModel[]) => void
  editConnection: () => void
  editModel: (model: ProviderCatalogModel) => void
}) => {
  const t = useTranslate()
  const controller = useRef<AbortController>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(40)
  useEffect(() => () => controller.current?.abort(), [])
  const models = modelsInProfile(profile)
  const needle = query.trim().toLocaleLowerCase()
  const visible = models.filter((model) =>
    (providerModelLabel(model, profile) + ' ' + model).toLocaleLowerCase().includes(needle)
  )
  const available = catalog.filter((item) => !models.includes(item.id))
  const fetchModels = async () => {
    const current = new AbortController()
    controller.current?.abort()
    controller.current = current
    setBusy(true)
    setError('')
    try {
      const next = await fetchProviderCatalog(profile, current.signal)
      if (!current.signal.aborted) {
        setCatalog(next)
      }
    } catch (reason) {
      if (!current.signal.aborted) {
        setError(providerErrorText(reason, t))
      }
    } finally {
      if (controller.current === current && !current.signal.aborted) {
        setBusy(false)
      }
    }
  }
  return (
    <div className={styles.management}>
      <Section>
        <div className={styles.connectionSummary}>
          <div className={styles.providerIdentity}>
            <ProviderMark id={profile.preset?.id} />
            <span>
              <strong>{profile.name}</strong>
              <small>{new URL(profile.url).host}</small>
            </span>
          </div>
          <button
            type="button"
            data-settings-target="providerConnection"
            className={styles.textAction}
            onClick={editConnection}
          >
            {t('providerConnection')}
            <IconChevronRightOutline14 />
          </button>
        </div>
      </Section>
      <div className={styles.modelToolbar}>
        {models.length > 0 && (
          <label className={styles.searchField}>
            <IconSearchOutline16 />
            <input
              type="search"
              aria-label={t('providerModelsSearch')}
              placeholder={t('providerModelsSearch')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setLimit(40)
              }}
            />
          </label>
        )}
        <div className={styles.modelTools}>
          <Button
            variant="outlined"
            className={styles.fetchButton}
            disabled={busy}
            onClick={() => void fetchModels()}
          >
            <IconRefreshOutline16 />
            {t(busy ? 'providerFetching' : 'providerFetchModels')}
          </Button>
          <Button variant="outlined" onClick={() => editModel({ id: '' })}>
            <IconAddOutline16 />
            {t('providerAddModel')}
          </Button>
        </div>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {catalog.length > 0 && (
        <div className={styles.fields}>
          <p className={styles.hint}>{t('providerModelsCount', { count: catalog.length })}</p>
          {available.length > 0 && (
            <Select
              ariaLabel={t('providerChooseFetched')}
              value=""
              placeholder={t('providerChooseFetched')}
              options={available.map((item) => ({ value: item.id, label: item.id }))}
              onChange={(id) => {
                const match = available.find((item) => item.id === id)
                if (match) {
                  editModel(match)
                }
              }}
            />
          )}
        </div>
      )}
      <Section title={t('providerModelsSection', { count: models.length })}>
        {visible.slice(0, limit).map((model) => {
          const parameters = providerModelParameters(profile, model)
          return (
            <Row
              key={model}
              label={providerModelLabel(model, profile)}
              description={providerModelLabel(model, profile) !== model ? model : undefined}
              detail={[
                parameters.vision && t('providerModelVisionBadge'),
                parameters.pdf && t('providerModelPdfBadge'),
                customReasoning(profile, model) && t('providerModelReasoningBadge'),
              ]
                .filter(Boolean)
                .join(' · ')}
              prominent
              badge={profile.model === model ? t('providerDefaultModelBadge') : undefined}
              onClick={() => editModel(catalog.find(({ id }) => id === model) ?? { id: model })}
              target="providerModel"
            />
          )
        })}
        {visible.length > limit && (
          <Row label={t('modelShowMore')} onClick={() => setLimit((value) => value + 40)} />
        )}
        {!visible.length && (
          <p className={styles.insetHint}>
            {t(models.length ? 'modelNoMatches' : 'providerNoModels')}
          </p>
        )}
      </Section>
    </div>
  )
}

const optionalInteger = (value: string) => (value.trim() ? Number(value) : undefined)
const withoutModel = <T,>(values: Record<string, T> | undefined, model: string) =>
  Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => id !== model))

const ModelParameter = ({
  label,
  fieldLabel = label,
  value,
  summary,
  change,
  placeholder,
  min,
  max,
}: {
  label: string
  fieldLabel?: string
  value: string
  summary: string
  change: (value: string) => void
  placeholder?: string
  min?: number
  max?: number
}) => {
  const t = useTranslate()
  const [draft, setDraft] = useState(value)
  const valueId = useId()
  const panel = useOptionPanel(label, { kind: 'field', align: 'end' })
  return (
    <>
      <button
        type="button"
        ref={panel.anchorRef}
        className={styles.parameterRow}
        aria-label={label}
        aria-describedby={valueId}
        {...panel.trigger}
        onClick={() => {
          if (!panel.open) {
            setDraft(value)
          }
          panel.trigger.onClick()
        }}
      >
        <span>{label}</span>
        <span id={valueId} className={styles.parameterValue} title={summary}>
          {summary}
        </span>
        <IconChevronRightOutline14 />
      </button>
      {panel.render(
        <form
          className={styles.parameterEditor}
          onSubmit={(event) => {
            event.preventDefault()
            change(draft)
            panel.close(true)
          }}
        >
          <Field label={fieldLabel}>
            <input
              data-panel-input=""
              type={min === undefined ? 'text' : 'number'}
              min={min}
              max={max}
              maxLength={min === undefined ? 200 : undefined}
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <div className={styles.editorButtons}>
            <Button size="s" variant="outlined" onClick={() => panel.close(true)}>
              {t('cancel')}
            </Button>
            <Button size="s" type="submit" data-panel-item="">
              {t('confirm')}
            </Button>
          </div>
        </form>
      )}
    </>
  )
}
export const ProviderModelPage = ({
  profile,
  selected,
  onDone,
}: {
  profile: ProviderProfile
  selected: ProviderCatalogModel
  onDone: () => void
}) => {
  const t = useTranslate()
  const existing = modelsInProfile(profile).includes(selected.id)
  const initialOptions = modelSettingsFor(profile, selected.id) ?? {}
  const initialContext = profile.contextWindows?.[selected.id] ?? selected.contextWindow
  const [id, setId] = useState(selected.id)
  const [settings, setSettings] = useState<ProviderModelSettings>(initialOptions)
  const [context, setContext] = useState(initialContext === undefined ? '' : String(initialContext))
  const [output, setOutput] = useState(initialOptions.maxOutputTokens?.toString() ?? '')
  const [makeDefault, setMakeDefault] = useState(!profile.model || profile.model === selected.id)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const request = useRef<AbortController>()
  useEffect(() => () => request.current?.abort(), [])
  const update = <K extends keyof ProviderModelSettings>(key: K, value: ProviderModelSettings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }))
  const leave = useSettingsLeave(
    id !== selected.id ||
      JSON.stringify(settings) !== JSON.stringify(initialOptions) ||
      context !== (initialContext?.toString() ?? '') ||
      output !== (initialOptions.maxOutputTokens?.toString() ?? '') ||
      makeDefault !== (!profile.model || profile.model === selected.id)
  )
  const model = id.trim()
  const contextLimit = optionalInteger(context)
  const contextWindows =
    contextLimit === undefined
      ? withoutModel(profile.contextWindows, model)
      : { ...profile.contextWindows, [model]: contextLimit }
  const candidate = {
    ...profile,
    contextWindows,
    models: [...new Set([...modelsInProfile(profile), model])],
    modelSettings: {
      ...profile.modelSettings,
      [model]: {
        ...settings,
        name: settings.name?.trim() || undefined,
        maxOutputTokens: optionalInteger(output),
        advertisedOutputLimit: model === selected.id
          ? selected.outputLimit ?? settings.advertisedOutputLimit
          : undefined,
      },
    },
  }
  const parameters = providerModelParameters(candidate, model)
  const defaultContext = providerModelContextWindow({ ...candidate, contextWindows: undefined }, model)
  const outputLimit = providerModelOutputLimit(candidate, model)
  const mimoSampling = profile.protocol === 'openai' && isOfficialMiMoV26(profile.url, model)
  const capability = validModel(model) ? customReasoning(candidate, model) : undefined
  const saveDisabled = busy || !validModel(model)
  const saveMenu = useOptionPanel(t('providerMoreSaveActions'), {
    kind: 'actions',
    align: 'end',
    side: 'top',
    disabled: saveDisabled,
  })
  const adapter = settings.reasoningAdapter
  const levels = adapter && adapter !== 'none' ? reasoningLevelsFor(adapter) : []
  const selectedLevels = settings.reasoningLevels ?? levels
  const save = (activate: boolean) => {
    setError('')
    if (mimoSampling && settings.temperature !== null && settings.temperature !== undefined && settings.temperature > 1.5) {
      setError(t('providerMiMoTemperatureRange'))
      return
    }
    if (!existing && modelsInProfile(profile).includes(model)) {
      setError(t('providerModelExists'))
      return
    }
    try {
      if (!validModel(model)) {
        throw new ProviderConfigError('model')
      }
      saveProvider(
        { ...candidate, model: makeDefault || !profile.model ? model : profile.model },
        activate ? model : false
      )
      showToast({ key: 'providerSaved' })
      onDone()
    } catch (reason) {
      setError(providerErrorText(reason, t))
    }
  }
  const test = async () => {
    const current = new AbortController()
    request.current?.abort()
    request.current = current
    setBusy(true)
    setError('')
    setResult('')
    try {
      const profile = { ...candidate, model }
      const tested = await testProviderModel(profile, current.signal)
      if (!current.signal.aborted) {
        setResult(t('providerTestSuccess', { ms: tested.elapsedMs }) + '\n' + tested.text)
      }
    } catch (reason) {
      if (!current.signal.aborted) {
        setError(providerErrorText(reason, t))
      }
    } finally {
      if (request.current === current && !current.signal.aborted) {
        setBusy(false)
      }
    }
  }
  return (
    <div className={styles.page}>
      <div className={styles.providerIdentity}>
        <ProviderMark id={profile.preset?.id} />
        <span>
          <strong>{settings.name?.trim() || selected.id || t('providerAddFetched')}</strong>
          <small>
            {profile.name}
            {selected.id ? ' · ' + selected.id : ''}
          </small>
        </span>
      </div>
      <Section title={t('providerModelParameters')}>
        {!existing && (
          <div className={styles.formFields}>
            <Field label={t('providerModel')}>
              <input
                value={id}
                maxLength={200}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setId(event.target.value)}
              />
            </Field>
          </div>
        )}
        <ModelParameter
          label={t('providerDisplayName')}
          value={settings.name ?? ''}
          placeholder={model}
          summary={settings.name?.trim() || model || t('providerNotSet')}
          change={(name) => setSettings((value) => ({ ...value, name }))}
        />
        <ModelParameter
          label={t('providerModelContextLabel')}
          fieldLabel={t('providerContextTokens')}
          value={context}
          summary={context ? Number(context).toLocaleString()
            : defaultContext ? t('providerDefaultTokens', { tokens: defaultContext.toLocaleString() })
              : t('providerNotSet')}
          placeholder={defaultContext ? String(defaultContext) : t('providerContextUnset')}
          min={512}
          max={10000000}
          change={setContext}
        />
        <ModelParameter
          label={t('providerModelOutputLabel')}
          fieldLabel={t('providerMaxOutput')}
          value={output}
          summary={
            output
              ? Number(output).toLocaleString()
              : t('providerDefaultTokens', { tokens: parameters.maxOutputTokens.toLocaleString() })
          }
          placeholder={String(parameters.maxOutputTokens)}
          min={16}
          max={outputLimit ?? 1048576}
          change={setOutput}
        />
        {capability && (
          <ReasoningRow
            control={capability}
            onChange={(level) => setSettings((value) => ({ ...value, defaultReasoning: level }))}
          />
        )}
      </Section>
      <Section title={t('providerModelInputs')}>
        <SwitchRow
          label={t('providerVision')}
          checked={parameters.vision}
          change={(enabled) => update('vision', enabled)}
        />
        <SwitchRow
          label={t('providerPdf')}
          checked={parameters.pdf}
          change={(enabled) => update('pdf', enabled)}
        />
        <p className={styles.insetHint}>{t('providerCapabilitiesHint')}</p>
      </Section>
      <SettingsDisclosure title={t('providerModelAdvanced')} icon={<IconSettingsOutline16 />}>
        <div className={styles.fields}>
          <Field label={t('providerTemperature')}>
            <input
              type="number"
              min={0}
              max={mimoSampling ? 1.5 : 2}
              step="any"
              value={settings.temperature ?? ''}
              onChange={(event) =>
                update('temperature', event.target.value ? Number(event.target.value) : undefined)
              }
            />
          </Field>
          {mimoSampling && <p className={styles.hint}>{t('providerMiMoSamplingHint')}</p>}
          {profile.protocol === 'openai' && (
            <div className={styles.field}>
              <span>{t('providerTokenParameter')}</span>
              <Select
                ariaLabel={t('providerTokenParameter')}
                value={parameters.tokenParameter}
                options={[
                  { value: 'max_tokens', label: 'max_tokens' },
                  { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                ]}
                onChange={(value) => update('tokenParameter', value)}
              />
            </div>
          )}
          {check(t('providerStreaming'), parameters.stream, (value) => update('stream', value))}
          {profile.protocol === 'openai' &&
            parameters.stream &&
            check(t('providerStreamUsage'), parameters.streamUsage, (value) =>
              update('streamUsage', value)
            )}
          <div className={styles.field}>
            <span>{t('reasoningAdapter')}</span>
            <Select
              ariaLabel={t('reasoningAdapter')}
              value={adapter ?? 'auto'}
              options={[
                { value: 'auto', label: t('reasoningAuto') },
                { value: 'none', label: t('reasoningNone') },
                ...REASONING_ADAPTERS.filter((item) => adapterSupports(item, profile.protocol)).map(
                  (value) => ({
                    value,
                    label: {
                      deepseek: 'DeepSeek effort',
                      thinking: 'thinking.type',
                      openai: 'OpenAI reasoning effort',
                      gemini: 'Gemini thinkingLevel',
                      anthropic: 'Anthropic adaptive thinking',
                      qwen: 'Qwen enable_thinking',
                      openrouter: 'OpenRouter reasoning.effort',
                      ark: 'Ark reasoning_effort',
                      minimax: 'MiniMax reasoning_effort',
                    }[value],
                  })
                ),
              ]}
              onChange={(next) =>
                setSettings((value) => ({
                  ...value,
                  reasoningAdapter: next === 'auto' ? undefined : next,
                  reasoningLevels: undefined,
                  defaultReasoning: undefined,
                }))
              }
            />
          </div>
          {levels.length > 0 ? (
            <div>
              <p className={styles.hint}>{t('reasoningLevelsHint')}</p>
              <div className={styles.levelChecks}>
                {levels.map((level) => (
                  <div key={level}>
                    {check(
                      t(reasoningLabels[level]),
                      selectedLevels.includes(level),
                      (enabled) => {
                        setSettings((value) => ({
                          ...value,
                          reasoningLevels: levels.filter((item) =>
                            item === level ? enabled : selectedLevels.includes(item)
                          ),
                        }))
                      },
                      selectedLevels.length === 1 && selectedLevels.includes(level)
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            !capability && <p className={styles.hint}>{t('reasoningUnsupported')}</p>
          )}
          {!!profile.model &&
            profile.model !== selected.id &&
            check(t('providerDefaultForConnection'), makeDefault, setMakeDefault)}
          {existing && (
            <Row
              label={t('providerRemoveModel')}
              danger
              disabled={busy}
              onClick={() => setDeleting(true)}
            />
          )}
        </div>
      </SettingsDisclosure>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className={styles.result} role="status">
          {result}
        </p>
      )}
      <div className={styles.footer} data-provider-actions="">
        <Button variant="outlined" disabled={saveDisabled} onClick={() => void test()}>
          {t(busy ? 'providerTesting' : 'providerTestModel')}
        </Button>
        <div className={styles.saveGroup} data-disabled={saveDisabled || undefined}>
          <Button disabled={saveDisabled} onClick={() => save(false)}>
            {t('providerSaveShort')}
          </Button>
          <button
            type="button"
            className={styles.saveCaret}
            ref={saveMenu.anchorRef}
            aria-label={t('providerMoreSaveActions')}
            disabled={saveDisabled}
            {...saveMenu.trigger}
          >
            <IconChevronDownOutline14 />
          </button>
        </div>
        {saveMenu.render(
          <button
            type="button"
            className={panelStyles.option}
            data-panel-item=""
            onClick={() => {
              saveMenu.close()
              save(true)
            }}
          >
            {t('providerSaveUse')}
          </button>
        )}
      </div>
      {leave.dialog}
      {deleting && (
        <Modal
          centered
          title={t('providerRemoveModel')}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDeleting(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  try {
                    const models = modelsInProfile(profile).filter((item) => item !== model)
                    saveProvider({
                      ...profile,
                      model: profile.model === model ? (models[0] ?? '') : profile.model,
                      models,
                      modelSettings: withoutModel(profile.modelSettings, model),
                      contextWindows: withoutModel(profile.contextWindows, model),
                    })
                    onDone()
                  } catch (reason) {
                    setError(providerErrorText(reason, t))
                    setDeleting(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('providerRemoveModelConfirm')}
        </Modal>
      )}
    </div>
  )
}

export const ProviderSearchPage = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate()
  const initial = useSettings((state) => state.thirdPartySearch)
  const officialKey = useSettings((state) => state.apiKey)
  const [form, setForm] = useState(initial)
  const [error, setError] = useState('')
  const leave = useSettingsLeave(JSON.stringify(form) !== JSON.stringify(initial))
  return (
    <div className={styles.page}>
      <Section title={t('providerSearchThirdParty')}>
        <SwitchRow
          label={t('thirdPartySearchEnable')}
          description={t('providerSearchEnableHint')}
          checked={form.enabled}
          change={(enabled) => setForm((value) => ({ ...value, enabled }))}
        />
      </Section>
      <Section title={t('providerSearchGroup')}>
        <Row
          label="DeepSeek Search"
          description={t('providerSearchBackend')}
          className={styles.providerRow}
          icon={<ProviderMark id="deepseek" />}
          prominent
        />
        <Select
          ariaLabel={t('thirdPartySearchKey')}
          settingRow="detail"
          value={form.keySource}
          options={[
            { value: 'official', label: t('thirdPartySearchOfficialKey') },
            { value: 'separate', label: t('thirdPartySearchSeparateKey') },
          ]}
          onChange={(keySource) => setForm((value) => ({ ...value, keySource }))}
        />
        {form.keySource === 'separate' && (
          <div className={styles.formFields}>
            <KeyField
              label={t('providerKey')}
              value={form.apiKey}
              change={(apiKey) => setForm((value) => ({ ...value, apiKey }))}
            />
          </div>
        )}
      </Section>
      <Section title={t('providerSearchBilling')}>
        <div className={styles.searchDisclosure}>
          <div className={styles.searchPrice}>
            <span>Search API</span>
            <strong>{t('providerSearchPrice')}</strong>
          </div>
          <p className={styles.hint}>{t('thirdPartySearchPrivacy')}</p>
        </div>
      </Section>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.footer} data-provider-actions="">
        <Button
          block
          onClick={() => {
            if (
              form.enabled &&
              !(form.keySource === 'separate' ? form.apiKey.trim() : officialKey)
            ) {
              setError(t('thirdPartySearchMissingKey'))
              return
            }
            if (!saveThirdPartySearch(form)) {
              setError(t('providerErrorStorage'))
              return
            }
            showToast({ key: 'providerSaved' })
            onDone()
          }}
        >
          {t('providerSearchSave')}
        </Button>
      </div>
      {leave.dialog}
    </div>
  )
}

const SPEECH_SETUP_STEPS = [
  'providerSpeechGuideReuse',
  'providerSpeechGuideKey',
  'providerSpeechGuideModels',
  'providerSpeechGuideListen',
] as const
const MIMO_KEYS_PAGE = 'https://platform.xiaomimimo.com/#/console/api-keys'
const MIMO_PLAN_KEYS_PAGE = 'https://platform.xiaomimimo.com/#/console/plan-manage'
const SPEECH_ACCESS_URLS = {
  api: MIMO_API_BASE_URL,
  tokenPlan: MIMO_TOKEN_PLAN_BASE_URL,
  custom: '',
} as const
type SpeechAccess = keyof typeof SPEECH_ACCESS_URLS

const speechEndpoint = (address: string) => {
  try {
    return new URL(validateProviderUrl(address))
  } catch {
    return undefined
  }
}

const speechAccessFromUrl = (url: URL | undefined): SpeechAccess => {
  if (url?.protocol === 'https:' && isMiMoHost(url.hostname)) {
    return url.hostname === 'api.xiaomimimo.com' ? 'api' : 'tokenPlan'
  }
  return 'custom'
}

const SpeechSetupGuide = ({ defaultOpen }: { defaultOpen: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const voiceDocs = `https://mimo.mi.com/docs/${locale}/quick-start/usage-guide/audio/speech-synthesis-v2.5`
  const planDocs = `https://mimo.mi.com/docs/${locale}/tokenplan/Token%20Plan/subscription`
  return (
    <SettingsDisclosure
      guide
      title={t('providerSpeechGuideTitle')}
      icon={<IconBookOutline16 />}
      defaultOpen={defaultOpen}
    >
      <TutorialSteps steps={SPEECH_SETUP_STEPS} />
      <div className={settingsStyles.tutorialActions}>
        <button
          className={settingsStyles.tutorialButton}
          type="button"
          onClick={() => void openExternal(MIMO_KEYS_PAGE)}
        >
          {t('providerSpeechGuideOpenKeys')}
          <IconRightUpOutline14 />
        </button>
        <button
          className={settingsStyles.tutorialButton}
          type="button"
          onClick={() => void openExternal(voiceDocs)}
        >
          {t('providerSpeechGuideOpenDocs')}
          <IconRightUpOutline14 />
        </button>
        <button
          className={settingsStyles.tutorialButton}
          type="button"
          onClick={() => void openExternal(planDocs)}
        >
          {t('providerSpeechGuidePlanTerms')}
          <IconRightUpOutline14 />
        </button>
      </div>
      <p className={settingsStyles.tutorialHint}>{t('providerSpeechGuideMatchKey')}</p>
    </SettingsDisclosure>
  )
}

const SPEECH_PREVIEWS = {
  preset: 'speech-settings-preview-preset',
  description: 'speech-settings-preview-description',
} as const
type SpeechPreview = keyof typeof SPEECH_PREVIEWS

/** The connection page manages service settings. Voices are configured in chat preferences. */
export const ProviderSpeechPage = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate()
  const settings = useSettings((state) => state.roleVoice)
  const profiles = useProviders((state) => state.profiles)
  const initial = {
    source: settings.source,
    providerId: settings.providerId,
    custom: {
      ...settings.custom,
      designModel: settings.custom.designModel ?? (
        settings.custom.model === MIMO_TTS_MODEL ? '' : settings.custom.model
      ),
    },
  }
  const [form, setForm] = useState(initial)
  const [keyOrigin, setKeyOrigin] = useState(() => speechEndpoint(initial.custom.url)?.origin)
  const [error, setError] = useState<{ text: string; preview?: SpeechPreview }>()
  const previewing = useReadAloud((state) => state.messageId)
  const loadingAudio = useReadAloud((state) => state.status === 'loading')
  const leave = useSettingsLeave(JSON.stringify(form) !== JSON.stringify(initial))
  const available = reusableVoiceProfiles(profiles)
  const endpoint = speechEndpoint(form.custom.url)
  const keyFromAnotherAddress = Boolean(keyOrigin && keyOrigin !== endpoint?.origin && form.custom.apiKey)
  const key = keyFromAnotherAddress ? '' : form.custom.apiKey
  const profile = roleVoiceProfile(profiles, { ...form, custom: { ...form.custom, apiKey: key } })
  const speechAccess = speechAccessFromUrl(endpoint)
  const canSave = form.source === 'follow'
    ? Boolean(profile)
    : Boolean(form.custom.url.trim() && key.trim())
  const previewStatus = t(loadingAudio ? 'ttsPreparing' : 'providerSpeechStopPreview')

  const stopPreview = () => {
    const id = useReadAloud.getState().messageId
    if (id === SPEECH_PREVIEWS.preset || id === SPEECH_PREVIEWS.description) {
      stopReadAloud()
    }
  }
  useEffect(() => stopPreview, [])

  const patch = (next: Partial<typeof form>) => {
    stopPreview()
    setError(undefined)
    if (!keyOrigin && next.custom?.apiKey.trim()) {
      setKeyOrigin(speechEndpoint(next.custom.url)?.origin)
    }
    setForm((current) => ({ ...current, ...next }))
  }
  const patchCustom = (field: keyof typeof form.custom, value: string) => {
    if (field === 'apiKey') {
      setKeyOrigin(endpoint?.origin)
    }
    patch({ custom: { ...form.custom, [field]: value } })
  }

  const selectSource = (source: typeof form.source) => {
    patch({
      source,
      custom: source === 'custom' && !form.custom.url.trim()
        ? { ...form.custom, url: MIMO_API_BASE_URL }
        : form.custom,
    })
  }

  const save = () => {
    const url = form.custom.url.trim()
    if (form.source === 'custom') {
      if (!url || !key.trim()) {
        setError({ text: t('providerSpeechMissingCustom') })
        return
      }
      try {
        validateProviderUrl(url)
      } catch {
        setError({ text: t('providerErrorUrl') })
        return
      }
      if ([form.custom.model, form.custom.designModel].some((model) => model.trim() && !validModel(model.trim()))) {
        setError({ text: t('providerSpeechInvalidModel') })
        return
      }
    }
    if (!setRoleVoice({ ...form, custom: {
      url,
      apiKey: key.trim(),
      model: form.custom.model.trim(),
      designModel: form.custom.designModel.trim(),
    } })) {
      setError({ text: t('providerErrorStorage') })
      return
    }
    showToast({ key: 'providerSaved' })
    onDone()
  }

  const audition = (voice: SpeechPreview) => {
    if (!profile) {
      return
    }
    const described = voice === 'description'
    setError(undefined)
    previewRoleVoice({
      role: {
        id: SPEECH_PREVIEWS[voice],
        name: t(described ? 'providerSpeechPreviewCharacter' : 'roleVoiceNarrator'),
        ...(described
          ? { description: t('providerSpeechPreviewDescription') }
          : { preset: settings.narratorVoice }),
        aliases: [],
        nature: '',
        importance: described ? 'lead' : 'supporting',
        source: 'user',
        createdAt: 0,
      },
      text: t(described ? 'providerSpeechPreviewLine' : 'providerSpeechPreviewText'),
      messageId: SPEECH_PREVIEWS[voice],
      profile,
      extrasShareVoice: false,
      extraVoice: settings.extraVoice,
    }, (failure) => {
      const message = describeReadAloudError(failure)
      setError({ text: t(message.key, message.params), preview: voice })
    })
  }

  return (
    <div className={styles.page}>
      <SpeechSetupGuide defaultOpen={!profile} />
      <Section>
        <Select
          ariaLabel={t('providerSpeechSource')}
          settingRow="value"
          compactMenu
          showSelectedDetail={false}
          value={form.source}
          options={[
            { value: 'follow', label: t('providerSpeechFollow'), detail: t('providerSpeechFollowHint') },
            { value: 'custom', label: t('providerSpeechCustom'), detail: t('providerSpeechCustomHint') },
          ]}
          onChange={selectSource}
        />
        {form.source === 'follow' ? (
          <>
            {available.length > 0 && (
              <Select
                ariaLabel={t('providerSpeechConnection')}
                settingRow="value"
                compactMenu
                value={form.providerId ?? ''}
                options={[
                  { value: '', label: t('providerSpeechAutomatic') },
                  ...available.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
                onChange={(providerId) => patch({ providerId: providerId || null })}
              />
            )}
            {!profile && (
              <p className={`${styles.hint} ${settingsStyles.rowNote}`}>{t('providerSpeechNeedMiMo')}</p>
            )}
          </>
        ) : (
          <>
            <Select
              ariaLabel={t('providerSpeechAccess')}
              settingRow="value"
              compactMenu
              showSelectedDetail={false}
              value={speechAccess}
              options={[
                { value: 'api', label: t('providerAccessApi'), detail: t('providerSpeechAccessApiHint') },
                { value: 'tokenPlan', label: t('providerAccessTokenPlan'), detail: t('providerSpeechAccessPlanHint') },
                { value: 'custom', label: t('providerSpeechAccessCustom') },
              ]}
              onChange={(access) => {
                if (access !== speechAccess) {
                  patchCustom('url', SPEECH_ACCESS_URLS[access])
                }
              }}
            />
            <div className={styles.formFields}>
              <Field label={t('providerSpeechUrl')}>
                <input type="url" autoCapitalize="none" autoComplete="off" spellCheck={false}
                  value={form.custom.url} placeholder="https://example.com/v1"
                  onChange={(event) => patchCustom('url', event.target.value)} />
              </Field>
              <KeyField
                label={t('providerKey')}
                value={key}
                change={(apiKey) => patchCustom('apiKey', apiKey)}
                helpHref={speechAccess === 'tokenPlan' ? MIMO_PLAN_KEYS_PAGE : undefined}
              />
              {keyFromAnotherAddress && (
                <p className={styles.hint}>{t('providerSpeechKeyForAddress')}</p>
              )}
              <Field label={t('providerSpeechPresetModel')}>
                <input autoCapitalize="none" autoComplete="off" spellCheck={false}
                  value={form.custom.model} placeholder={MIMO_TTS_MODEL}
                  onChange={(event) => patchCustom('model', event.target.value)} />
              </Field>
              <Field label={t('providerSpeechDesignModel')}>
                <input autoCapitalize="none" autoComplete="off" spellCheck={false}
                  value={form.custom.designModel} placeholder={MIMO_TTS_DESIGN_MODEL}
                  onChange={(event) => patchCustom('designModel', event.target.value)} />
              </Field>
              <p className={styles.hint}>{t('providerSpeechCustomNote')}</p>
            </div>
          </>
        )}
      </Section>
      {profile && (
        <Section title={t('providerSpeechAudition')}>
          <Row
            label={t('providerSpeechPreviewNarrator')}
            icon={previewing === SPEECH_PREVIEWS.preset ? <IconStopFill16 /> : <IconPlayMediaOutline16 />}
            value={previewing === SPEECH_PREVIEWS.preset ? previewStatus : t('settingsLeadVoicePreset')}
            onClick={() => audition('preset')}
          />
          {error?.preview === 'preset' && (
            <p className={`${styles.error} ${styles.insetHint}`} role="alert">{error.text}</p>
          )}
          <Row
            label={t('providerSpeechPreviewLead')}
            icon={previewing === SPEECH_PREVIEWS.description ? <IconStopFill16 /> : <IconPlayMediaOutline16 />}
            value={previewing === SPEECH_PREVIEWS.description ? previewStatus : t('settingsLeadVoiceDescribed')}
            onClick={() => audition('description')}
          />
          {error?.preview === 'description' && (
            <p className={`${styles.error} ${styles.insetHint}`} role="alert">{error.text}</p>
          )}
        </Section>
      )}
      {error && !error.preview && <p className={styles.error} role="alert">{error.text}</p>}
      <div className={styles.footer} data-provider-actions="">
        <Button block disabled={!canSave} onClick={save}>{t('providerSpeechSave')}</Button>
      </div>
      {leave.dialog}
    </div>
  )
}
