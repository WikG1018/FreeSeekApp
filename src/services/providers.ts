import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { logEvent, registerLogSecret } from './diagnostics/log.js'
import { useSettings } from './settings.js'

export type ProviderProtocol = 'openai' | 'responses' | 'anthropic' | 'gemini'
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
type ProviderState = { profiles: ProviderProfile[]; selection: ModelSelection }
export type Connection =
  | { kind: 'deepseek'; model: string; apiKey: string }
  | { kind: 'custom'; model: string; profile: ProviderProfile }

const KEY = 'freeseek:providers'
export const OFFICIAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
const fallback: ModelSelection = { providerId: 'deepseek', model: 'deepseek-flash' }
const protocols: ProviderProtocol[] = ['openai', 'responses', 'anthropic', 'gemini']
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
  if (!protocols.includes(input.protocol) || (requireModel && !validModel(input.model))) {
    throw new ProviderConfigError('model')
  }
  const url = validateProviderUrl(input.url)
  if (
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 16 ||
    input.maxOutputTokens > 1048576 ||
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
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ProviderState | null
    if (!raw || !Array.isArray(raw.profiles)) {
      return { profiles: [], selection: fallback }
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
        profiles.push(validateProfile({ ...emptyProfile(), ...item }))
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
        : profiles.some((profile) => profile.id === selected.providerId))
    return { profiles, selection: valid ? selected : fallback }
  } catch {
    return { profiles: [], selection: fallback }
  }
}
export const useProviders = create<ProviderState>(load)
const commit = (next: ProviderState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    throw new ProviderConfigError('storage')
  }
  registerSecrets(next.profiles)
  useProviders.setState(next)
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
export const saveProvider = (input: ProviderProfile, activate = false): ProviderProfile => {
  const value = validateProfile(input)
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
  commit({
    profiles,
    selection: activate ? { providerId: saved.id, model: saved.model } : state.selection,
  })
  logEvent('app', 'provider.saved', { protocol: saved.protocol, count: profiles.length })
  return saved
}
export const removeProvider = (id: string) => {
  const state = useProviders.getState()
  commit({
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
      : !state.profiles.some((p) => p.id === selection.providerId))
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
    profile: { ...profile, headers: { ...profile.headers }, extraBody: { ...profile.extraBody } },
  }
}
export const activeConnection = () =>
  resolveConnection(activeConnectionRef(), useProviders.getState().selection.model)
export const hasChatConnection = () => {
  const { selection, profiles } = useProviders.getState()
  return selection.providerId === 'deepseek'
    ? Boolean(useSettings.getState().apiKey)
    : profiles.some((p) => p.id === selection.providerId)
}
export const modelLabel = (model: string) =>
  model === 'deepseek-flash'
    ? 'DeepSeek Flash'
    : model === 'deepseek-v4-pro'
      ? 'DeepSeek V4 Pro'
      : model
