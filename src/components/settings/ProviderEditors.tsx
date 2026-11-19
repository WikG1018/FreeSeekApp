import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchProviderCatalog,
  testProviderModel,
  type ProviderCatalogModel,
} from '../../services/api/providerClient.js'
import { providerAccess } from '../../services/providerPresets.js'
import {
  modelsInProfile,
  modelSettingsFor,
  ProviderConfigError,
  providerModelLabel,
  removeProvider,
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
import { IconEyeOffOutline16, IconEyeOutline16, IconSettingsOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { reasoningLabels } from '../base/ReasoningOptions.js'
import { showToast } from '../base/toastState.js'
import { ProviderMark, providerAccessLabel, providerErrorText } from './ProviderSettings.js'
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
}: {
  label: string
  value: string
  change: (value: string) => void
  placeholder?: string
}) => {
  const t = useTranslate()
  const [visible, setVisible] = useState(false)
  return (
    <div className={styles.keyField}>
      <Field label={label}>
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={8192}
          onChange={(event) => change(event.target.value)}
        />
      </Field>
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
  )
}

const protocolOptions: { value: ProviderProtocol; label: string; detail: string }[] = [
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
      {initial.preset && (
        <div className={styles.providerIdentity}>
          <ProviderMark id={initial.preset.id} />
          <span>
            <strong>{initial.name}</strong>
            {access && <small>{t(providerAccessLabel(access))}</small>}
          </span>
        </div>
      )}
      <fieldset className={styles.fieldGroup}>
        <legend>{t('providerInfoGroup')}</legend>
        <Field label={t('providerName')}>
          <input
            value={form.name}
            maxLength={80}
            onChange={(event) => update('name', event.target.value)}
          />
        </Field>
        <Field label={t('providerUrl')}>
          <input
            type="url"
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
            options={protocolOptions}
            value={form.protocol}
            onChange={(value) => update('protocol', value)}
          />
        </div>
        {form.url.trim().toLowerCase().startsWith('http:') && (
          <p className={styles.hint}>{t('providerHttpHint')}</p>
        )}
      </fieldset>
      <fieldset className={styles.fieldGroup}>
        <legend>{t('providerAuthGroup')}</legend>
        <KeyField
          label={t('providerKey')}
          value={form.apiKey}
          change={(value) => update('apiKey', value)}
          placeholder={access && t('providerConnectionApiKeyRequired')}
        />
        {access ? (
          <a className={styles.docsLink} href={access.docs} target="_blank" rel="noreferrer">
            {t('providerGetKey')}
          </a>
        ) : (
          <p className={styles.hint}>{t('providerKeyHint')}</p>
        )}
      </fieldset>
      <SettingsDisclosure title={t('providerParameters')} icon={<IconSettingsOutline16 />}>
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
        </div>
      </SettingsDisclosure>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!form.url.trim() || (!!access && !form.apiKey.trim())}>
        {t('providerSaveModels')}
      </Button>
      {initial.id && (
        <Button variant="dangerOutlined" onClick={() => setDeleting(true)}>
          {t('providerDelete')}
        </Button>
      )}
      {leave.dialog}
      {deleting && (
        <Modal
          centered
          title={t('providerDelete')}
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
                    removeProvider(initial.id)
                    onDeleted()
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
          {t('providerDeleteHint')}
        </Modal>
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
    <>
      <Section>
        <Row
          label={profile.name}
          icon={<ProviderMark id={profile.preset?.id} />}
          description={new URL(profile.url).host}
          onClick={editConnection}
          target="providerConnection"
        />
      </Section>
      <div className={styles.actions}>
        <Button variant="outlined" disabled={busy} onClick={() => void fetchModels()}>
          {t(busy ? 'providerFetching' : 'providerFetchModels')}
        </Button>
        <Button variant="outlined" onClick={() => editModel({ id: '' })}>
          {t('providerAddModel')}
        </Button>
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
      <Section title={t('providerModelsSection')}>
        {models.length > 8 && (
          <label className={styles.searchField}>
            <input
              type="search"
              aria-label={t('modelFilter')}
              placeholder={t('modelFilter')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setLimit(40)
              }}
            />
          </label>
        )}
        {visible.slice(0, limit).map((model) => (
          <Row
            key={model}
            label={providerModelLabel(model, profile)}
            description={model}
            value={profile.model === model ? t('reasoningDefaultMark') : undefined}
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
    </>
  )
}

const optionalInteger = (value: string) => (value.trim() ? Number(value) : undefined)
const withoutModel = <T,>(values: Record<string, T> | undefined, model: string) =>
  Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => id !== model))
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
          <small>{profile.name}</small>
        </span>
      </div>
      <fieldset className={styles.fieldGroup}>
        <Field label={t('providerModel')}>
          <input
            value={id}
            readOnly={existing}
            maxLength={200}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <Field label={t('providerDisplayName')}>
          <input
            value={settings.name ?? ''}
            maxLength={200}
            placeholder={model}
            onChange={(event) => setSettings((value) => ({ ...value, name: event.target.value }))}
          />
        </Field>
        <Field label={t('providerContextTokens')}>
          <input
            type="number"
            min={512}
            max={10000000}
            value={context}
            placeholder={t('providerContextUnset')}
            onChange={(event) => setContext(event.target.value)}
          />
        </Field>
        <Field label={t('providerMaxOutput')}>
          <input
            type="number"
            min={16}
            max={1048576}
            value={output}
            placeholder={String(profile.maxOutputTokens)}
            onChange={(event) => setOutput(event.target.value)}
          />
        </Field>
        {capability && (
          <ReasoningRow
            control={capability}
            onChange={(level) => setSettings((value) => ({ ...value, defaultReasoning: level }))}
          />
        )}
        {check(
          t('providerDefaultForConnection'),
          makeDefault,
          setMakeDefault,
          !profile.model || profile.model === selected.id
        )}
      </fieldset>
      <SettingsDisclosure title={t('reasoningParameters')} icon={<IconSettingsOutline16 />}>
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
      <div className={styles.actions}>
        <Button
          variant="outlined"
          disabled={busy || !validModel(model)}
          onClick={() => void test()}
        >
          {t(busy ? 'providerTesting' : 'providerTestModel')}
        </Button>
        <Button
          variant="outlined"
          disabled={busy || !validModel(model)}
          onClick={() => save(false)}
        >
          {t('providerSave')}
        </Button>
        <Button disabled={busy || !validModel(model)} onClick={() => save(true)}>
          {t('providerSaveUse')}
        </Button>
      </div>
      {existing && (
        <Button variant="dangerOutlined" disabled={busy} onClick={() => setDeleting(true)}>
          {t('providerRemoveModel')}
        </Button>
      )}
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
    <>
      <Section title={t('providerChatTools')}>
        <SwitchRow
          label={t('thirdPartySearchEnable')}
          checked={form.enabled}
          change={(enabled) => setForm((value) => ({ ...value, enabled }))}
        />
      </Section>
      <fieldset className={styles.fieldGroup}>
        <legend>{t('thirdPartySearchKey')}</legend>
        <Select
          ariaLabel={t('thirdPartySearchKey')}
          value={form.keySource}
          options={[
            { value: 'official', label: t('thirdPartySearchOfficialKey') },
            { value: 'separate', label: t('thirdPartySearchSeparateKey') },
          ]}
          onChange={(keySource) => setForm((value) => ({ ...value, keySource }))}
        />
        {form.keySource === 'separate' && (
          <KeyField
            label={t('providerKey')}
            value={form.apiKey}
            change={(apiKey) => setForm((value) => ({ ...value, apiKey }))}
          />
        )}
      </fieldset>
      <div className={styles.searchDisclosure}>
        <strong>{t('thirdPartySearchPricing')}</strong>
        <p className={styles.hint}>{t('thirdPartySearchPrivacy')}</p>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Button
        block
        onClick={() => {
          if (form.enabled && !(form.keySource === 'separate' ? form.apiKey.trim() : officialKey)) {
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
        {t('providerSave')}
      </Button>
      {leave.dialog}
    </>
  )
}
