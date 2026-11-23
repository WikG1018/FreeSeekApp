import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { logEvent, registerLogSecret } from './diagnostics/log.js'
import { useSettings } from './settings.js'
import { providerAccess, providerPreset } from './providerPresets.js'
import {
  customReasoning,
  isReasoningAdapter,
  isReasoningLevel,
  officialReasoning,
  type ReasoningChoice,
  type ReasoningLevel,
  type ReasoningAdapter,
} from './reasoning.js'

export type ProviderProtocol = 'openai' | 'responses' | 'anthropic' | 'gemini'
export type ProviderModelParameters = {
  maxOutputTokens: number
  temperature: number | null
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
  stream: boolean
  streamUsage: boolean
  vision: boolean
  pdf: boolean
}
export type ProviderModelSettings = Partial<ProviderModelParameters> & {
  name?: string
  reasoningAdapter?: ReasoningAdapter | 'none'
  reasoningLevels?: ReasoningLevel[]
  defaultReasoning?: ReasoningLevel
}
export type ProviderProfile = {
  id: string
  revision: string
  name: string
  url: string
  apiKey: string
  protocol: ProviderProtocol
  model: string
  models: string[]
  modelListUrl: string
  contextWindows?: Record<string, number>
  modelSettings?: Record<string, ProviderModelSettings>
  preset?: { id: string; access: string }
  headers: Record<string, string>
  extraBody: Record<string, unknown>
}
type ProviderProfileInput = ProviderProfile & Partial<ProviderModelParameters>
export type ModelSelection = { providerId: string; model: string }
export type ConnectionRef = { providerId: string; revision?: string }
type ProviderState = {
  profiles: ProviderProfile[]
  selection: ModelSelection
  officialDefaults: Partial<Record<string, ReasoningLevel>>
}
type RuntimeState = ProviderState & {
  reasoningOverride: {
    sessionId: string | null
    level: ReasoningLevel
    selection: ModelSelection
  } | null
}
export type Connection =
  | { kind: 'deepseek'; model: string; apiKey: string }
  | { kind: 'custom'; model: string; profile: ProviderProfile }

const KEY = 'freeseek:providers'
export const OFFICIAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
const fallback: ModelSelection = { providerId: 'deepseek', model: 'deepseek-flash' }
const protocols: ProviderProtocol[] = ['openai', 'responses', 'anthropic', 'gemini']
const MODEL_LIMIT = 5000
// A legacy connection can have both a full catalog and settings for other saved model IDs.
const MODEL_SETTINGS_LIMIT = MODEL_LIMIT * 2 + 1
const tokenParameters = ['max_tokens', 'max_completion_tokens'] as const
const booleanParameters = ['vision', 'pdf', 'stream', 'streamUsage'] as const
const validOutputBudget = (value: number) =>
  Number.isSafeInteger(value) && value >= 16 && value <= 1048576
const validTemperature = (value: number | null) =>
  value === null || (Number.isFinite(value) && value >= 0 && value <= 2)
export class ProviderConfigError extends Error {
  constructor(readonly reason: 'url' | 'model' | 'parameters' | 'storage' | 'missing' | 'changed') {
    super(`Provider configuration: ${reason}`)
    this.name = 'ProviderConfigError'
    logEvent('settings', 'provider.configuration-rejected', { reason }, 'warn')
  }
}
export const validModel = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 200 &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32)

/** 地址只用于用户指定的服务，不把 URL、查询参数或密钥写进日志/聊天备份。 */
export const validateProviderUrl = (value: string): string => {
  try {
    const address = value.trim()
    // OpenCode documentation and copied settings often omit the scheme.
    const url = new URL(
      /^opencode\.ai\/(?:zen|inference)(?:[/?]|$)/i.test(address) ? `https://${address}` : address
    )
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      value.length > 4096
    ) {
      throw new Error('invalid')
    }
    return url.toString()
  } catch {
    throw new ProviderConfigError('url')
  }
}
export const emptyProfile = (): ProviderProfile => ({
  id: '',
  revision: '',
  name: '',
  url: '',
  apiKey: '',
  protocol: 'openai',
  model: '',
  models: [],
  modelListUrl: '',
  headers: {},
  extraBody: {},
})
export const modelsInProfile = (profile: ProviderProfile) => [
  ...new Set([profile.model, ...profile.models].filter(validModel)),
]

export const modelSettingsFor = (profile: ProviderProfile | undefined, model: string) =>
  profile && Object.hasOwn(profile.modelSettings ?? {}, model)
    ? profile.modelSettings?.[model]
    : undefined

const defaultModelParameters = (profile: ProviderProfile): ProviderModelParameters => {
  const access = providerAccess(profile.preset?.id, profile.preset?.access)
  return {
    maxOutputTokens: 4096,
    temperature: null,
    tokenParameter: access?.completionTokens ? 'max_completion_tokens' : 'max_tokens',
    stream: true,
    streamUsage: access ? (access.streamUsage ?? false) : true,
    vision: false,
    pdf: false,
  }
}

export const providerModelParameters = (
  profile: ProviderProfile,
  model: string
): ProviderModelParameters => {
  const defaults = defaultModelParameters(profile)
  const options = modelSettingsFor(profile, model)
  return {
    maxOutputTokens: options?.maxOutputTokens ?? defaults.maxOutputTokens,
    temperature: options?.temperature ?? defaults.temperature,
    tokenParameter: options?.tokenParameter ?? defaults.tokenParameter,
    stream: options?.stream ?? defaults.stream,
    streamUsage: options?.streamUsage ?? defaults.streamUsage,
    vision: options?.vision ?? defaults.vision,
    pdf: options?.pdf ?? defaults.pdf,
  }
}

const migrateModelParameters = (
  profile: ProviderProfile,
  legacy: Partial<ProviderModelParameters>
): ProviderProfile => {
  const defaults = defaultModelParameters(profile)
  const overridden = Object.entries(legacy).filter(
    ([key, value]) =>
      value !== undefined && value !== defaults[key as keyof ProviderModelParameters]
  )
  if (!overridden.length) {
    return profile
  }
  const inherited = Object.fromEntries(overridden)
  const models = [
    ...new Set([...modelsInProfile(profile), ...Object.keys(profile.modelSettings ?? {})]),
  ]
  return {
    ...profile,
    modelSettings: Object.fromEntries(
      models.slice(0, MODEL_SETTINGS_LIMIT).map((model) => [
        model,
        {
          ...inherited,
          ...Object.fromEntries(
            Object.entries(modelSettingsFor(profile, model) ?? {}).filter(
              ([, value]) => value !== undefined
            )
          ),
        },
      ])
    ),
  }
}

export const validateProfile = (
  input: ProviderProfileInput,
  requireModel = true
): ProviderProfile => {
  if (
    !protocols.includes(input.protocol) ||
    typeof input.model !== 'string' ||
    ((requireModel || input.model.trim()) && !validModel(input.model))
  ) {
    throw new ProviderConfigError('model')
  }
  if (
    input.contextWindows !== undefined &&
    (!input.contextWindows ||
      typeof input.contextWindows !== 'object' ||
      Array.isArray(input.contextWindows) ||
      Object.entries(input.contextWindows).some(
        ([model, size]) =>
          !validModel(model) || !Number.isSafeInteger(size) || size < 512 || size > 10000000
      ))
  ) {
    throw new ProviderConfigError('parameters')
  }
  if (
    input.modelSettings !== undefined &&
    (!input.modelSettings ||
      typeof input.modelSettings !== 'object' ||
      Array.isArray(input.modelSettings) ||
      Object.keys(input.modelSettings).length > MODEL_SETTINGS_LIMIT ||
      Object.entries(input.modelSettings).some(
        ([model, item]) =>
          !validModel(model) ||
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          (item.name !== undefined && !validModel(item.name)) ||
          (item.maxOutputTokens !== undefined && !validOutputBudget(item.maxOutputTokens)) ||
          (item.temperature !== undefined && !validTemperature(item.temperature)) ||
          (item.tokenParameter !== undefined && !tokenParameters.includes(item.tokenParameter)) ||
          booleanParameters.some(
            (key) => item[key] !== undefined && typeof item[key] !== 'boolean'
          ) ||
          (item.reasoningAdapter !== undefined &&
            item.reasoningAdapter !== 'none' &&
            !isReasoningAdapter(item.reasoningAdapter)) ||
          (item.reasoningLevels !== undefined &&
            (!Array.isArray(item.reasoningLevels) ||
              item.reasoningLevels.length > 8 ||
              !item.reasoningLevels.every(isReasoningLevel))) ||
          (item.defaultReasoning !== undefined && !isReasoningLevel(item.defaultReasoning))
      ))
  ) {
    throw new ProviderConfigError('parameters')
  }
  const url = validateProviderUrl(input.url)
  const {
    maxOutputTokens,
    temperature,
    tokenParameter,
    stream,
    streamUsage,
    vision,
    pdf,
    ...connection
  } = input
  if (
    (maxOutputTokens !== undefined && !validOutputBudget(maxOutputTokens)) ||
    (temperature !== undefined && !validTemperature(temperature))
  ) {
    throw new ProviderConfigError('parameters')
  }
  if (
    !input.headers ||
    Array.isArray(input.headers) ||
    !input.extraBody ||
    Array.isArray(input.extraBody) ||
    typeof input.headers !== 'object' ||
    typeof input.extraBody !== 'object' ||
    JSON.stringify(input.extraBody).length > 16384 ||
    JSON.stringify(input.headers).length > 8192 ||
    input.apiKey.length > 8192
  ) {
    throw new ProviderConfigError('parameters')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
      typeof value !== 'string' ||
      /[\r\n]/.test(value) ||
      /^(host|content-length|connection|transfer-encoding|cookie|origin)$/i.test(name)
    ) {
      throw new ProviderConfigError('parameters')
    }
    headers[name] = value
  }
  const preset = providerPreset(input.preset?.id)
  const access = providerAccess(input.preset?.id, input.preset?.access)
  const profile = {
    ...connection,
    url,
    apiKey: input.apiKey.trim(),
    model: input.model.trim(),
    name: input.name.trim().slice(0, 80) || new URL(url).hostname,
    preset: preset && access ? { id: preset.id, access: access.id } : undefined,
    modelListUrl: input.modelListUrl.trim() ? validateProviderUrl(input.modelListUrl) : '',
    models: [...new Set(input.models.filter(validModel).map((model) => model.trim()))].slice(
      0,
      MODEL_LIMIT
    ),
    headers,
    extraBody: JSON.parse(JSON.stringify(input.extraBody)) as Record<string, unknown>,
  }
  return migrateModelParameters(profile, {
    maxOutputTokens,
    temperature,
    vision: vision === undefined ? undefined : vision === true,
    pdf: pdf === undefined ? undefined : pdf === true,
    stream: stream === undefined ? undefined : stream !== false,
    streamUsage: streamUsage === undefined ? undefined : streamUsage !== false,
    tokenParameter:
      tokenParameter === undefined
        ? undefined
        : tokenParameter === 'max_completion_tokens'
          ? 'max_completion_tokens'
          : 'max_tokens',
  })
}
const registerSecrets = (profiles: ProviderProfile[]) => {
  for (const profile of profiles) {
    registerLogSecret(profile.apiKey)
    for (const value of Object.values(profile.headers)) {
      registerLogSecret(value)
    }
  }
}
const load = (): ProviderState => {
  const empty = { profiles: [], selection: fallback, officialDefaults: {} }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ProviderState | null
    if (!raw || !Array.isArray(raw.profiles)) {
      return empty
    }
    const profiles: ProviderProfile[] = []
    for (const item of raw.profiles.slice(0, 20)) {
      try {
        if (
          typeof item.id !== 'string' ||
          !/^custom-[\w-]+$/.test(item.id) ||
          typeof item.revision !== 'string' ||
          profiles.some((p) => p.id === item.id)
        ) {
          continue
        }
        profiles.push(validateProfile({ ...emptyProfile(), ...item }, false))
      } catch {
        /* 一份损坏的配置不阻止应用启动。 */
      }
    }
    registerSecrets(profiles)
    const selected = raw.selection
    const valid =
      selected &&
      validModel(selected.model) &&
      (selected.providerId === 'deepseek'
        ? (OFFICIAL_MODELS as readonly string[]).includes(selected.model)
        : profiles.some(
            (profile) => profile.id === selected.providerId && validModel(profile.model)
          ))
    const officialDefaults = Object.fromEntries(
      OFFICIAL_MODELS.flatMap((model) => {
        const level = raw.officialDefaults?.[model]
        return level && officialReasoning().levels.includes(level) ? [[model, level]] : []
      })
    )
    return { profiles, selection: valid ? selected : fallback, officialDefaults }
  } catch {
    return empty
  }
}
export const useProviders = create<RuntimeState>(() => ({ ...load(), reasoningOverride: null }))
const commit = ({ profiles, selection, officialDefaults }: ProviderState) => {
  const previous = useProviders.getState().selection
  try {
    localStorage.setItem(KEY, JSON.stringify({ profiles, selection, officialDefaults }))
  } catch {
    throw new ProviderConfigError('storage')
  }
  registerSecrets(profiles)
  useProviders.setState({
    profiles,
    selection,
    officialDefaults,
    ...(previous.providerId !== selection.providerId || previous.model !== selection.model
      ? { reasoningOverride: null }
      : {}),
  })
}
const requestConfig = ({ url, apiKey, protocol, headers, extraBody }: ProviderProfile) =>
  JSON.stringify({
    url,
    apiKey,
    protocol,
    headers,
    extraBody,
  })
export const saveProvider = (
  input: ProviderProfileInput,
  activate: boolean | string = false
): ProviderProfile => {
  const value = validateProfile(input, Boolean(activate))
  const state = useProviders.getState(),
    previous = state.profiles.find((p) => p.id === value.id)
  if (!previous && state.profiles.length >= 20) {
    throw new ProviderConfigError('parameters')
  }
  const saved = {
    ...value,
    id: previous?.id ?? `custom-${createId()}`,
    revision:
      previous && requestConfig(previous) === requestConfig(value) ? previous.revision : createId(),
  }
  const profiles = previous
    ? state.profiles.map((p) => (p.id === previous.id ? saved : p))
    : [...state.profiles, saved]
  const current = state.selection
  const activatedModel = typeof activate === 'string' ? activate : saved.model
  if (activate && !modelsInProfile(saved).includes(activatedModel)) {
    throw new ProviderConfigError('model')
  }
  const removedActiveModel =
    current.providerId === saved.id &&
    previous &&
    [previous.model, ...previous.models].includes(current.model) &&
    ![saved.model, ...saved.models].includes(current.model)
  commit({
    ...state,
    profiles,
    selection:
      activate || removedActiveModel
        ? activatedModel
          ? { providerId: saved.id, model: activatedModel }
          : fallback
        : current,
  })
  const parameters = providerModelParameters(saved, activatedModel)
  logEvent('settings', 'provider.saved', {
    protocol: saved.protocol,
    connectionCount: profiles.length,
    modelCount: modelsInProfile(saved).length,
    created: !previous,
    activated: Boolean(activate),
    streaming: parameters.stream,
    streamUsage: parameters.streamUsage,
    outputTokens: parameters.maxOutputTokens,
  })
  return saved
}
export const removeProvider = (id: string) => {
  const state = useProviders.getState()
  commit({
    ...state,
    profiles: state.profiles.filter((p) => p.id !== id),
    selection: state.selection.providerId === id ? fallback : state.selection,
  })
  logEvent('settings', 'provider.removed', { active: state.selection.providerId === id })
}
export const selectModel = (selection: ModelSelection) => {
  const state = useProviders.getState()
  if (
    !validModel(selection.model) ||
    (selection.providerId === 'deepseek'
      ? !(OFFICIAL_MODELS as readonly string[]).includes(selection.model)
      : !state.profiles.some((p) => p.id === selection.providerId && validModel(p.model)))
  ) {
    throw new ProviderConfigError('model')
  }
  commit({ ...state, selection })
  logEvent('settings', 'model.selected', {
    custom: selection.providerId !== 'deepseek',
    officialModel: selection.providerId === 'deepseek' ? selection.model : undefined,
    protocol: state.profiles.find((profile) => profile.id === selection.providerId)?.protocol,
  })
}
export const activeConnectionRef = (
  selection = useProviders.getState().selection
): ConnectionRef => {
  const { profiles } = useProviders.getState()
  return {
    providerId: selection.providerId,
    ...(selection.providerId === 'deepseek'
      ? {}
      : { revision: profiles.find((p) => p.id === selection.providerId)?.revision }),
  }
}
export const resolveConnection = (
  ref: ConnectionRef | undefined,
  model: string | null
): Connection => {
  if (!ref || ref.providerId === 'deepseek') {
    const selected = model ?? 'deepseek-flash'
    if (!(OFFICIAL_MODELS as readonly string[]).includes(selected)) {
      throw new ProviderConfigError('missing')
    }
    return { kind: 'deepseek', model: selected, apiKey: useSettings.getState().apiKey ?? '' }
  }
  const profile = useProviders.getState().profiles.find((p) => p.id === ref.providerId)
  if (!profile) {
    throw new ProviderConfigError('missing')
  }
  if (ref.revision && ref.revision !== profile.revision) {
    throw new ProviderConfigError('changed')
  }
  return {
    kind: 'custom',
    model: model ?? profile.model,
    profile: {
      ...profile,
      headers: { ...profile.headers },
      extraBody: { ...profile.extraBody },
    },
  }
}
export const activeConnection = () =>
  resolveConnection(activeConnectionRef(), useProviders.getState().selection.model)
export const hasChatConnection = () => {
  const { selection, profiles } = useProviders.getState()
  return selection.providerId === 'deepseek'
    ? Boolean(useSettings.getState().apiKey)
    : profiles.some((p) => p.id === selection.providerId && validModel(p.model))
}
export const modelLabel = (model: string) =>
  model === 'deepseek-flash'
    ? 'DeepSeek Flash'
    : model === 'deepseek-v4-pro'
      ? 'DeepSeek V4 Pro'
      : model

export const providerModelLabel = (model: string, profile?: ProviderProfile) =>
  modelSettingsFor(profile, model)?.name ?? (profile ? model : modelLabel(model))

export const modelInputCapabilities = (model: string, profile?: ProviderProfile) => {
  if (profile) {
    const { vision, pdf } = providerModelParameters(profile, model)
    return { vision, pdf }
  }
  const acceptsRichInputs = model === 'deepseek-flash'
  return { vision: acceptsRichInputs, pdf: acceptsRichInputs }
}

export const providerOutputBudget = (profile: ProviderProfile, model: string) =>
  providerModelParameters(profile, model).maxOutputTokens

export const setOfficialReasoningDefault = (model: string, level: ReasoningLevel) => {
  if (
    !(OFFICIAL_MODELS as readonly string[]).includes(model) ||
    !officialReasoning().levels.includes(level)
  ) {
    return
  }
  const state = useProviders.getState()
  commit({ ...state, officialDefaults: { ...state.officialDefaults, [model]: level } })
  logEvent('settings', 'reasoning.default-changed', { officialModel: model, level })
  if (state.selection.providerId === 'deepseek' && state.selection.model === model) {
    useProviders.setState({ reasoningOverride: null })
  }
}

export const activeReasoning = (
  state: RuntimeState,
  settings: { thinking: boolean; hasLegacyThinking: boolean }
) =>
  state.selection.providerId === 'deepseek'
    ? officialReasoning(
        state.officialDefaults[state.selection.model] ??
          (settings.hasLegacyThinking ? (settings.thinking ? 'high' : 'off') : undefined)
      )
    : (() => {
        const profile = state.profiles.find((item) => item.id === state.selection.providerId)
        return profile && customReasoning(profile, state.selection.model)
      })()

export const selectedReasoning = (
  sessionId: string | null,
  selection = useProviders.getState().selection
): ReasoningChoice | undefined => {
  const state = useProviders.getState()
  const capability = activeReasoning({ ...state, selection }, useSettings.getState())
  if (!capability) {
    return undefined
  }
  const override = state.reasoningOverride
  return {
    adapter: capability.adapter,
    level:
      override?.selection.providerId === selection.providerId &&
      override.selection.model === selection.model &&
      override.sessionId === sessionId &&
      capability.levels.includes(override.level)
        ? override.level
        : capability.defaultLevel,
  }
}

export const setReasoningOverride = (
  sessionId: string | null,
  level: ReasoningLevel,
  selection = useProviders.getState().selection
) => {
  useProviders.setState({ reasoningOverride: { sessionId, level, selection } })
  logEvent('settings', 'reasoning.session-changed', { sessionId, level })
}
