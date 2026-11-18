import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ApiError } from '../../services/api/errorTypes.js'
import { fetchProviderModels, testProviderModel } from '../../services/api/providerClient.js'
import {
  emptyProfile,
  modelLabel,
  OFFICIAL_MODELS,
  ProviderConfigError,
  removeProvider,
  saveProvider,
  selectModel,
  useProviders,
  type ProviderProfile,
  type ProviderProtocol,
} from '../../services/providers.js'
import { Select } from '../base/Select.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import styles from './ProviderSettings.module.css'
import { useSettingsLeave } from './useSettingsLeave.js'

const configErrors: Record<ProviderConfigError['reason'], TranslationKey> = {
  url: 'providerErrorUrl',
  model: 'providerErrorModel',
  parameters: 'providerErrorParameters',
  storage: 'providerErrorStorage',
  missing: 'providerConfigMissing',
  changed: 'providerConfigChanged',
}
const errorMessage = (error: unknown, t: ReturnType<typeof useTranslate>) =>
  error instanceof ProviderConfigError
    ? t(configErrors[error.reason])
    : error instanceof ApiError && error.localMessage
      ? t(error.localMessage.key, error.localMessage.params)
      : t('providerNetworkError')

export const ConnectionSelector = ({
  disabled = false,
  layout = 'picker',
}: {
  disabled?: boolean
  layout?: 'settings' | 'picker'
}) => {
  const t = useTranslate(),
    { profiles, selection } = useProviders()
  const [error, setError] = useState('')
  const groupId = useId()
  const profile = profiles.find((p) => p.id === selection.providerId)
  const models = profile
    ? [...new Set([profile.model, selection.model, ...profile.models])]
    : [...OFFICIAL_MODELS]
  const choose = (providerId: string, model: string) => {
    try {
      selectModel({ providerId, model })
      setError('')
    } catch (error) {
      setError(errorMessage(error, t))
    }
  }
  return (
    <div className={styles.fields}>
      {(layout === 'picker' || profiles.length > 0) && (
        <div className={styles.field}>
          <span>{t('providerSelectService')}</span>
          <Select
            ariaLabel={t('providerSelectService')}
            value={selection.providerId}
            disabled={disabled}
            options={[
              { value: 'deepseek', label: t('providerOfficial') },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(id) =>
              choose(
                id,
                id === 'deepseek'
                  ? 'deepseek-flash'
                  : (profiles.find((p) => p.id === id)?.model ?? '')
              )
            }
          />
        </div>
      )}
      {layout === 'settings' && !profile ? (
        <div
          role="radiogroup"
          aria-label={t('providerDefaultModel')}
          className={styles.modelChoices}
        >
          {OFFICIAL_MODELS.map((model) => (
            <label key={model} data-selected={selection.model === model}>
              <input
                type="radio"
                name={groupId}
                disabled={disabled}
                checked={selection.model === model}
                onChange={() => choose('deepseek', model)}
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
      ) : (
        <div className={styles.field}>
          <span>{t('providerModel')}</span>
          <Select
            ariaLabel={t('providerModel')}
            value={selection.model}
            disabled={disabled}
            options={models.map((model) => ({ value: model, label: modelLabel(model) }))}
            onChange={(model) => choose(selection.providerId, model)}
          />
        </div>
      )}
      <p className={styles.hint}>
        {layout === 'settings' && !profile
          ? t('settingsApiBillingValue')
          : t(profile ? 'providerCustomHint' : 'providerOfficialHint')}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export const ModelPicker = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate(),
    selection = useProviders((state) => state.selection)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={styles.modelTrigger}
        disabled={disabled}
        aria-label={t('providerSwitch')}
        aria-haspopup="dialog"
        title={selection.model}
        onClick={() => setOpen(true)}
      >
        <span>{modelLabel(selection.model)}</span>
        <IconChevronDownOutline14 />
      </button>
      {open ? (
        <Modal
          title={t('providerSwitch')}
          closable
          onClose={() => setOpen(false)}
          footer={<Button onClick={() => setOpen(false)}>{t('confirm')}</Button>}
        >
          <ConnectionSelector disabled={disabled} />
        </Modal>
      ) : null}
    </>
  )
}

export const ProviderSettingsPage = () => {
  const t = useTranslate(),
    { profiles, selection } = useProviders()
  const [form, setForm] = useState<ProviderProfile>(
    () => profiles.find((p) => p.id === selection.providerId) ?? profiles[0] ?? emptyProfile()
  )
  const [headers, setHeaders] = useState(() => JSON.stringify(form.headers, null, 2))
  const [body, setBody] = useState(() => JSON.stringify(form.extraBody, null, 2))
  const saved = useRef({ profile: JSON.stringify(form), headers, body })
  const dirty =
    JSON.stringify(form) !== saved.current.profile ||
    headers !== saved.current.headers ||
    body !== saved.current.body
  const leave = useSettingsLeave(dirty)
  const [showKey, setShowKey] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState('')
  const [busy, setBusy] = useState<'models' | 'test' | null>(null),
    [deleting, setDeleting] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const edit = (profile: ProviderProfile) => {
    saved.current = {
      profile: JSON.stringify(profile),
      headers: JSON.stringify(profile.headers, null, 2),
      body: JSON.stringify(profile.extraBody, null, 2),
    }
    controller.current?.abort()
    setBusy(null)
    setForm(profile)
    setHeaders(JSON.stringify(profile.headers, null, 2))
    setBody(JSON.stringify(profile.extraBody, null, 2))
    setError('')
    setResult('')
    setShowKey(false)
  }
  const patch = (value: Partial<ProviderProfile>) => {
    setForm((previous) => ({ ...previous, ...value }))
    setError('')
    setResult('')
  }
  const current = () => {
    try {
      return {
        ...form,
        headers: JSON.parse(headers || '{}') as Record<string, string>,
        extraBody: JSON.parse(body || '{}') as Record<string, unknown>,
      }
    } catch {
      throw new ProviderConfigError('parameters')
    }
  }
  const save = (activate: boolean) => {
    try {
      edit(saveProvider(current(), activate))
      showToast({ key: 'providerSaved' })
    } catch (error) {
      setError(errorMessage(error, t))
    }
  }
  const run = async (action: 'models' | 'test') => {
    if (controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setBusy(action)
    setError('')
    setResult('')
    try {
      const snapshot = current()
      if (action === 'models') {
        const models = await fetchProviderModels(snapshot, active.signal)
        if (!active.signal.aborted) {
          setForm((previous) => ({ ...previous, models }))
          setResult(t('providerModelsCount', { count: models.length }))
        }
      } else {
        const response = await testProviderModel(snapshot, active.signal)
        if (!active.signal.aborted) {
          setResult(`${t('providerTestSuccess', { ms: response.elapsedMs })}\n${response.text}`)
        }
      }
    } catch (error) {
      if (!active.signal.aborted) {
        setError(errorMessage(error, t))
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(null)
      }
    }
  }
  return (
    <div className={styles.page}>
      {profiles.length > 0 && (
        <div className={styles.savedHeader}>
          <span>{t('providerProfile')}</span>
          <Button
            variant="outlined"
            size="s"
            disabled={Boolean(busy)}
            onClick={() => leave.request(() => edit(emptyProfile()))}
          >
            {t('providerNew')}
          </Button>
        </div>
      )}
      {profiles.length ? (
        <div className={styles.profileList}>
          {profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              disabled={Boolean(busy)}
              aria-pressed={form.id === profile.id}
              onClick={() => leave.request(() => edit(profile))}
            >
              <span>{profile.name}</span>
              {selection.providerId === profile.id ? <small>{t('providerActive')}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {leave.dialog}
      <fieldset className={styles.fieldGroup} disabled={Boolean(busy)}>
        <legend>{t('providerConnectionGroup')}</legend>
        <label className={styles.field}>
          <span>{t('providerName')}</span>
          <input
            aria-label={t('providerName')}
            maxLength={80}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <div className={styles.field}>
          <span>{t('providerProtocol')}</span>
          <Select<ProviderProtocol>
            ariaLabel={t('providerProtocol')}
            value={form.protocol}
            disabled={Boolean(busy)}
            options={[
              { value: 'openai', label: 'OpenAI Chat Completions' },
              { value: 'responses', label: 'OpenAI Responses' },
              { value: 'anthropic', label: 'Anthropic Messages' },
              { value: 'gemini', label: 'Google Gemini' },
            ]}
            onChange={(protocol) => patch({ protocol, models: [] })}
          />
        </div>
        <label className={styles.field}>
          <span>{t('providerUrl')}</span>
          <input
            aria-label={t('providerUrl')}
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            value={form.url}
            onChange={(e) => patch({ url: e.target.value, models: [] })}
          />
        </label>
        <p className={styles.hint}>{t('providerUrlHint')}</p>
        {form.url.trim().startsWith('http:') ? (
          <p className={styles.hint}>{t('providerHttpHint')}</p>
        ) : null}
        <label className={styles.field}>
          <span>{t('providerKey')}</span>
          <input
            aria-label={t('providerKey')}
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={form.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </label>
        <div className={styles.keyHint}>
          <span>{t('providerKeyHint')}</span>
          <button type="button" onClick={() => setShowKey(!showKey)}>
            {t(showKey ? 'settingsApiKeyHide' : 'settingsApiKeyShow')}
          </button>
        </div>
      </fieldset>
      <fieldset className={styles.fieldGroup} disabled={Boolean(busy)}>
        <legend>{t('providerModelGroup')}</legend>
        <label className={styles.field}>
          <span>{t('providerModel')}</span>
          <input
            aria-label={t('providerModel')}
            autoCapitalize="none"
            spellCheck={false}
            value={form.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </label>
        {form.models.length ? (
          <Select
            ariaLabel={t('providerChooseFetched')}
            placeholder={t('providerChooseFetched')}
            value={form.model}
            disabled={Boolean(busy)}
            options={form.models.map((model) => ({ value: model, label: model }))}
            onChange={(model) => patch({ model })}
          />
        ) : null}
        <div className={styles.actions}>
          <Button variant="outlined" disabled={!form.url.trim()} onClick={() => void run('models')}>
            {t('providerFetchModels')}
          </Button>
          <Button
            variant="outlined"
            disabled={!form.url.trim() || !form.model.trim()}
            onClick={() => void run('test')}
          >
            {t('providerTestModel')}
          </Button>
        </div>
        <p className={styles.hint}>{t('providerTestHint')}</p>
      </fieldset>
      {busy && (
        <div className={styles.feedback} role="status">
          <span>{t(busy === 'test' ? 'providerTesting' : 'providerFetching')}</span>
          <Button variant="outlined" onClick={() => controller.current?.abort()}>
            {t('cancel')}
          </Button>
        </div>
      )}
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
      <fieldset className={styles.fields} disabled={Boolean(busy)}>
        <details className={styles.advanced}>
          <summary>{t('providerParameters')}</summary>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>{t('providerMaxOutput')}</span>
              <input
                aria-label={t('providerMaxOutput')}
                type="number"
                min={16}
                max={1048576}
                value={form.maxOutputTokens}
                onChange={(e) => patch({ maxOutputTokens: Number(e.target.value) })}
              />
            </label>
            <label className={styles.field}>
              <span>{t('providerTemperature')}</span>
              <input
                aria-label={t('providerTemperature')}
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature ?? ''}
                onChange={(e) =>
                  patch({ temperature: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
            {form.protocol === 'openai' ? (
              <div className={styles.field}>
                <span>{t('providerTokenParameter')}</span>
                <Select<ProviderProfile['tokenParameter']>
                  ariaLabel={t('providerTokenParameter')}
                  value={form.tokenParameter}
                  disabled={Boolean(busy)}
                  options={[
                    { value: 'max_tokens', label: 'max_tokens' },
                    { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                  ]}
                  onChange={(tokenParameter) => patch({ tokenParameter })}
                />
              </div>
            ) : null}
            {(['stream', 'streamUsage', 'vision', 'pdf'] as const).map((key, index) => (
              <label key={key} className={styles.check}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => patch({ [key]: e.target.checked })}
                />
                <span>
                  {t(
                    (
                      [
                        'providerStreaming',
                        'providerStreamUsage',
                        'providerVision',
                        'providerPdf',
                      ] as const
                    )[index]
                  )}
                </span>
              </label>
            ))}
            <p className={styles.hint}>{t('providerCapabilitiesHint')}</p>
            <label className={styles.field}>
              <span>{t('providerModelsUrl')}</span>
              <input
                type="url"
                value={form.modelListUrl}
                onChange={(e) => patch({ modelListUrl: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>{t('providerHeaders')}</span>
              <textarea
                rows={3}
                autoCapitalize="none"
                spellCheck={false}
                value={headers}
                onChange={(e) => {
                  setHeaders(e.target.value)
                  setError('')
                }}
              />
            </label>
            <label className={styles.field}>
              <span>{t('providerExtraBody')}</span>
              <textarea
                rows={4}
                autoCapitalize="none"
                spellCheck={false}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value)
                  setError('')
                }}
              />
            </label>
            <p className={styles.hint}>{t('providerExtraHint')}</p>
          </div>
        </details>
      </fieldset>
      <div className={styles.actions}>
        <Button disabled={Boolean(busy)} variant="outlined" onClick={() => save(false)}>
          {t('providerSave')}
        </Button>
        <Button disabled={Boolean(busy)} onClick={() => save(true)}>
          {t('providerSaveUse')}
        </Button>
      </div>
      <p className={styles.hint}>{t('providerPrivacy')}</p>
      {form.id ? (
        <Button variant="dangerOutlined" disabled={Boolean(busy)} onClick={() => setDeleting(true)}>
          {t('providerDelete')}
        </Button>
      ) : null}
      {deleting ? (
        <Modal
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
                    removeProvider(form.id)
                    edit(emptyProfile())
                    setDeleting(false)
                  } catch (error) {
                    setError(errorMessage(error, t))
                    setDeleting(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <p>{t('providerDeleteHint')}</p>
        </Modal>
      ) : null}
    </div>
  )
}
