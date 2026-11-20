import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchProviderCatalog,
  testProviderModel,
  type ProviderCatalogModel,
} from '../../services/api/providerClient.js'
import { providerAccess, providerPreset } from '../../services/providerPresets.js'
import {
  modelsInProfile,
  modelSettingsFor,
  ProviderConfigError,
  providerModelLabel,
  saveProvider,
  validModel,
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
import { saveThirdPartySearch, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import {
  IconAddOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconLinkOutline14,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
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
import { Row, Section, SwitchRow } from './SettingsRows.js'
import { useSettingsLeave } from './useSettingsLeave.js'
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
            <strong>{access?.connectionName ?? preset.name}</strong>
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
            placeholder={preset && t(accessKeyPlaceholder, { provider: preset.name })}
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
            <Field label={t('providerMaxOutput')}>
              <input
                type="number"
                min={16}
                max={1048576}
                required
                value={form.maxOutputTokens || ''}
                onChange={(event) => update('maxOutputTokens', Number(event.target.value))}
              />
            </Field>
            <Field label={t('providerTemperature')}>
              <input
                type="number"
                min={0}
                max={2}
                step="any"
                value={form.temperature ?? ''}
                onChange={(event) =>
                  update('temperature', event.target.value ? Number(event.target.value) : null)
                }
              />
            </Field>
            {form.protocol === 'openai' && (
              <div className={styles.field}>
                <span>{t('providerTokenParameter')}</span>
                <Select
                  ariaLabel={t('providerTokenParameter')}
                  value={form.tokenParameter}
                  options={[
                    { value: 'max_tokens', label: 'max_tokens' },
                    { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                  ]}
                  onChange={(value) => update('tokenParameter', value)}
                />
              </div>
            )}
            {check(t('providerStreaming'), form.stream, (value) => update('stream', value))}
            {form.protocol === 'openai' &&
              form.stream &&
              check(t('providerStreamUsage'), form.streamUsage, (value) =>
                update('streamUsage', value)
              )}
            {check(t('providerVision'), form.vision, (value) => update('vision', value))}
            {check(t('providerPdf'), form.pdf, (value) => update('pdf', value))}
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
            <p className={styles.hint}>{t('providerCapabilitiesHint')}</p>
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
        {visible.slice(0, limit).map((model) => (
          <Row
            key={model}
            label={providerModelLabel(model, profile)}
            description={providerModelLabel(model, profile) !== model ? model : undefined}
            detail={[
              profile.vision && t('providerModelVisionBadge'),
              profile.pdf && t('providerModelPdfBadge'),
              customReasoning(profile, model) && t('providerModelReasoningBadge'),
            ]
              .filter(Boolean)
              .join(' · ')}
            prominent
            badge={profile.model === model ? t('providerDefaultModelBadge') : undefined}
            onClick={() => editModel({ id: model })}
            target="providerModel"
          />
        ))}
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
      },
    },
  }
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
      const tested = await testProviderModel({ ...candidate, model }, current.signal)
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
          summary={context ? Number(context).toLocaleString() : t('providerNotSet')}
          placeholder={t('providerContextUnset')}
          min={512}
          max={10000000}
          change={setContext}
        />
        <ModelParameter
          label={t('providerModelOutputLabel')}
          fieldLabel={t('providerMaxOutput')}
          value={output}
          summary={output ? Number(output).toLocaleString() : t('providerInheritedOutput')}
          placeholder={String(profile.maxOutputTokens)}
          min={16}
          max={1048576}
          change={setOutput}
        />
        {capability && (
          <ReasoningRow
            control={capability}
            onChange={(level) => setSettings((value) => ({ ...value, defaultReasoning: level }))}
          />
        )}
      </Section>
      <SettingsDisclosure title={t('providerModelAdvanced')} icon={<IconSettingsOutline16 />}>
        <div className={styles.fields}>
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
