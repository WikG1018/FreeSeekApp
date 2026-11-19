import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { logEvent, registerLogSecret } from './diagnostics/log.js'
import { useSettings } from './settings.js'
import { providerAccess } from './providerPresets.js'
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
export type ProviderModelSettings = {
  name?: string
  maxOutputTokens?: number
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
  maxOutputTokens: number
  temperature: number | null
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
  stream: boolean
  streamUsage: boolean
  vision: boolean
  pdf: boolean
  headers: Record<string, string>
  extraBody: Record<string, unknown>
}
export type ModelSelection = { providerId: string; model: string }
export type ConnectionRef = { providerId: string; revision?: string }
type ProviderState = {
  profiles: ProviderProfile[]
  selection: ModelSelection
  officialDefaults: Partial<Record<string, ReasoningLevel>>
}
type RuntimeState = ProviderState & {
  reasoningOverride: { sessionId: string | null; level: ReasoningLevel } | null
}
export type Connection =
  | { kind: 'deepseek'; model: string; apiKey: string }
  | { kind: 'custom'; model: string; profile: ProviderProfile }

const KEY = 'freeseek:providers'
export const OFFICIAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
const fallback: ModelSelection = { providerId: 'deepseek', model: 'deepseek-flash' }
const protocols: ProviderProtocol[] = ['openai', 'responses', 'anthropic', 'gemini']
const validOutputBudget = (value: number) =>
  Number.isSafeInteger(value) && value >= 16 && value <= 1048576
export class ProviderConfigError extends Error {
  constructor(readonly reason: 'url' | 'model' | 'parameters' | 'storage' | 'missing' | 'changed') {
    super(`Provider configuration: ${reason}`)
    this.name = 'ProviderConfigError'
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
    const url = new URL(value.trim())
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
  maxOutputTokens: 4096,
  temperature: null,
  vision: false,
  pdf: false,
  tokenParameter: 'max_tokens',
  stream: true,
  streamUsage: true,
  headers: {},
  extraBody: {},
})
export const validateProfile = (input: ProviderProfile, requireModel = true): ProviderProfile => {
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
      Object.keys(input.modelSettings).length > 5000 ||
      Object.entries(input.modelSettings).some(
        ([model, item]) =>
          !validModel(model) ||
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          (item.name !== undefined && !validModel(item.name)) ||
          (item.maxOutputTokens !== undefined && !validOutputBudget(item.maxOutputTokens)) ||
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
  if (
    !validOutputBudget(input.maxOutputTokens) ||
    (input.temperature !== null &&
      (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
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
  return {
    ...input,
    url,
    apiKey: input.apiKey.trim(),
    model: input.model.trim(),
    name: input.name.trim().slice(0, 80) || new URL(url).hostname,
    preset: providerAccess(input.preset?.id, input.preset?.access) ? input.preset : undefined,
    modelListUrl: input.modelListUrl.trim() ? validateProviderUrl(input.modelListUrl) : '',
    models: [...new Set(input.models.filter(validModel).map((model) => model.trim()))].slice(
      0,
      5000
    ),
    headers,
    extraBody: JSON.parse(JSON.stringify(input.extraBody)) as Record<string, unknown>,
    vision: input.vision === true,
    pdf: input.pdf === true,
    stream: input.stream !== false,
    streamUsage: input.streamUsage !== false,
    tokenParameter:
      input.tokenParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
  }
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
const requestConfig = ({
  url,
  apiKey,
  protocol,
  maxOutputTokens,
  temperature,
  vision,
  pdf,
  headers,
  extraBody,
  tokenParameter,
  stream,
  streamUsage,
}: ProviderProfile) =>
  JSON.stringify({
    url,
    apiKey,
    protocol,
    maxOutputTokens,
    temperature,
    vision,
    pdf,
    headers,
    extraBody,
    tokenParameter,
    stream,
    streamUsage,
  })
export const saveProvider = (
  input: ProviderProfile,
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
  logEvent('app', 'provider.saved', { protocol: saved.protocol, count: profiles.length })
  return saved
}
export const removeProvider = (id: string) => {
  const state = useProviders.getState()
  commit({
    ...state,
    profiles: state.profiles.filter((p) => p.id !== id),
    selection: state.selection.providerId === id ? fallback : state.selection,
  })
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
  logEvent('app', 'model.selected', { custom: selection.providerId !== 'deepseek' })
}
export const activeConnectionRef = (): ConnectionRef => {
  const { selection, profiles } = useProviders.getState()
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
      maxOutputTokens: providerOutputBudget(profile, model ?? profile.model),
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

export const modelsInProfile = (profile: ProviderProfile) => [
  ...new Set([profile.model, ...profile.models].filter(validModel)),
]

export const modelSettingsFor = (profile: ProviderProfile | undefined, model: string) =>
  profile && Object.hasOwn(profile.modelSettings ?? {}, model)
    ? profile.modelSettings?.[model]
    : undefined

export const providerModelLabel = (model: string, profile?: ProviderProfile) =>
  modelSettingsFor(profile, model)?.name ?? (profile ? model : modelLabel(model))

export const providerOutputBudget = (profile: ProviderProfile, model: string) =>
  modelSettingsFor(profile, model)?.maxOutputTokens ?? profile.maxOutputTokens

export const setOfficialReasoningDefault = (model: string, level: ReasoningLevel) => {
  if (
    !(OFFICIAL_MODELS as readonly string[]).includes(model) ||
    !officialReasoning().levels.includes(level)
  ) {
    return
  }
  const state = useProviders.getState()
  commit({ ...state, officialDefaults: { ...state.officialDefaults, [model]: level } })
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

export const selectedReasoning = (sessionId: string | null): ReasoningChoice | undefined => {
  const state = useProviders.getState()
  const capability = activeReasoning(state, useSettings.getState())
  if (!capability) {
    return undefined
  }
  const override = state.reasoningOverride
  return {
    adapter: capability.adapter,
    level:
      override?.sessionId === sessionId && capability.levels.includes(override.level)
        ? override.level
        : capability.defaultLevel,
  }
}

export const setReasoningOverride = (sessionId: string | null, level: ReasoningLevel) =>
  useProviders.setState({ reasoningOverride: { sessionId, level } })
