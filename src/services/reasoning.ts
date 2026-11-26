import type { ProviderProfile, ProviderProtocol } from './providers.js'
import { isMiMoHost } from './providerPresets.js'

export const REASONING_LEVELS = [
  'off',
  'on',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]
export const REASONING_ADAPTERS = [
  'deepseek',
  'thinking',
  'openai',
  'gemini',
  'anthropic',
  'qwen',
  'openrouter',
  'ark',
  'minimax',
] as const
export type ReasoningAdapter = (typeof REASONING_ADAPTERS)[number]
export type ReasoningChoice = { adapter: ReasoningAdapter; level: ReasoningLevel }
export type ReasoningControl = {
  adapter: ReasoningAdapter
  levels: readonly ReasoningLevel[]
  defaultLevel: ReasoningLevel
}

export const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  (REASONING_LEVELS as readonly unknown[]).includes(value)
export const isReasoningAdapter = (value: unknown): value is ReasoningAdapter =>
  (REASONING_ADAPTERS as readonly unknown[]).includes(value)

export const adapterSupports = (adapter: ReasoningAdapter, protocol: ProviderProtocol) => {
  if (adapter === 'deepseek') {
    return protocol !== 'gemini'
  }
  if (adapter === 'openai') {
    return protocol === 'openai' || protocol === 'responses'
  }
  if (adapter === 'gemini') {
    return protocol === 'gemini'
  }
  if (adapter === 'anthropic') {
    return protocol === 'anthropic'
  }
  return protocol === 'openai'
}
const adapterLevels: Record<ReasoningAdapter, readonly ReasoningLevel[]> = {
  deepseek: ['off', 'low', 'high', 'max'],
  thinking: ['off', 'on'],
  openai: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  gemini: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  anthropic: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  qwen: ['off', 'on'],
  openrouter: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  ark: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  minimax: ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'],
}
export const reasoningLevelsFor = (adapter: ReasoningAdapter) => adapterLevels[adapter]

const control = (
  adapter: ReasoningAdapter,
  defaultLevel: ReasoningLevel,
  levels = adapterLevels[adapter]
): ReasoningControl => ({ adapter, levels, defaultLevel })
export const officialReasoning = (value?: ReasoningLevel): ReasoningControl =>
  control('deepseek', value && adapterLevels.deepseek.includes(value) ? value : 'high')

const infer = (model: string, profile: ProviderProfile): ReasoningControl | undefined => {
  const id = model.toLowerCase().replace(/^models\//, '')
  const host = new URL(profile.url).hostname
  if (host === 'api.deepseek.com' && /^deepseek-(?:flash|v4(?:\.1)?-(?:pro|flash))$/.test(id)) {
    return officialReasoning()
  }
  if (profile.protocol === 'gemini') {
    if (
      /^gemini-3\.(?:6-flash|5-flash-lite|1-flash-lite)(?:$|-)/.test(id) ||
      id === 'gemini-3-flash-preview'
    ) {
      return control(
        'gemini',
        id.includes('lite') ? 'minimal' : id === 'gemini-3-flash-preview' ? 'high' : 'medium',
        ['minimal', 'low', 'medium', 'high']
      )
    }
    if (/^gemini-(?:3\.8-flash|4-carbon|4-argon|3\.1-pro-preview)(?:$|-)/.test(id)) {
      return control('gemini', 'medium', ['low', 'medium', 'high'])
    }
    if (id === 'gemini-4-hydrogen') {
      return control('gemini', 'high', ['low', 'medium', 'high', 'xhigh'])
    }
  }
  if (
    isMiMoHost(host) &&
    /^mimo-v2\.(?:5(?:-pro)?|6-(?:flash|pro(?:-ultraspeed)?))$/.test(id)
  ) {
    return control('thinking', 'on')
  }
  if (host === 'open.bigmodel.cn' && /^glm-(?:4\.[567]|5(?:\.[123])?)(?:$|-)/.test(id)) {
    return control('thinking', 'on')
  }
  if (/^api\.moonshot\.(?:cn|ai)$/.test(host) && /^kimi-k2\.[56]$/.test(id)) {
    return control('thinking', 'on')
  }
  if (host === 'api.openai.com' && /^gpt-5\.[124](?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) {
    return control(
      'openai',
      'off',
      id.startsWith('gpt-5.1')
        ? ['off', 'low', 'medium', 'high']
        : ['off', 'low', 'medium', 'high', 'xhigh']
    )
  }
  if (host === 'api.anthropic.com' && /^claude-(?:sonnet-4-6|opus-4-[678])(?:$|-)/.test(id)) {
    return control(
      'anthropic',
      'high',
      id.includes('4-6')
        ? ['off', 'low', 'medium', 'high', 'max']
        : ['off', 'low', 'medium', 'high', 'xhigh', 'max']
    )
  }
  if (/^api\.(?:minimax\.cn|minimaxi\.com|minimax\.io)$/.test(host)) {
    if (id === 'minimax-m3.1-flash') {
      return control('minimax', 'max', ['low', 'medium', 'high', 'xhigh', 'max'])
    }
    if (id === 'minimax-m3') {
      return control('minimax', 'on', ['off', 'on'])
    }
  }
  return undefined
}

export const customReasoning = (
  profile: ProviderProfile,
  model: string
): ReasoningControl | undefined => {
  const options = Object.hasOwn(profile.modelSettings ?? {}, model)
    ? profile.modelSettings?.[model]
    : undefined
  if (options?.reasoningAdapter === 'none') {
    return undefined
  }
  const inferred = infer(model, profile)
  const adapter = options?.reasoningAdapter ?? inferred?.adapter
  if (!adapter || !adapterSupports(adapter, profile.protocol)) {
    return undefined
  }
  const available = options?.reasoningLevels?.filter((level) =>
    adapterLevels[adapter].includes(level)
  )
  const levels = available?.length
    ? available
    : inferred?.adapter === adapter
      ? inferred.levels
      : adapterLevels[adapter]
  const preferred = options?.defaultReasoning ?? inferred?.defaultLevel
  return control(
    adapter,
    preferred && levels.includes(preferred)
      ? preferred
      : levels.includes('high')
        ? 'high'
        : levels[0],
    levels
  )
}

export const disabledReasoning = (
  capability: ReasoningControl | undefined
): ReasoningChoice | undefined =>
  capability?.levels.includes('off') ? { adapter: capability.adapter, level: 'off' } : undefined

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Merge only the fields the selected model's documented adapter owns. */
export const applyReasoning = (
  payload: Record<string, unknown>,
  protocol: ProviderProtocol,
  choice?: ReasoningChoice
) => {
  if (!choice || !adapterSupports(choice.adapter, protocol)) {
    return payload
  }
  const { adapter, level } = choice
  const off = level === 'off'
  const thinking = { type: off ? 'disabled' : 'enabled' }
  const effort = off ? 'none' : level
  if (adapter === 'gemini') {
    const generationConfig = object(payload.generationConfig)
    return {
      ...payload,
      generationConfig: {
        ...generationConfig,
        thinkingConfig: { thinkingLevel: level.toUpperCase() },
      },
    }
  }
  if (adapter === 'deepseek' && protocol === 'anthropic') {
    const outputConfig = { ...object(payload.output_config) }
    if (off) {
      delete outputConfig.effort
    }
    return { ...payload, thinking, output_config: off ? outputConfig : { ...outputConfig, effort } }
  }
  if (adapter === 'anthropic') {
    return {
      ...payload,
      thinking: { type: off ? 'disabled' : 'adaptive' },
      output_config: { ...object(payload.output_config), effort: off ? 'high' : effort },
    }
  }
  if (adapter === 'openrouter' || protocol === 'responses') {
    return { ...payload, reasoning: { ...object(payload.reasoning), effort } }
  }
  if (adapter === 'qwen') {
    return { ...payload, enable_thinking: !off }
  }
  if (adapter === 'thinking') {
    return { ...payload, thinking }
  }
  if (adapter === 'minimax') {
    return {
      ...payload,
      reasoning_split: true,
      thinking: { type: off ? 'disabled' : 'adaptive' },
      reasoning_effort: off || level === 'on' ? undefined : effort,
    }
  }
  if (adapter === 'openai') {
    return { ...payload, reasoning_effort: effort }
  }
  const result = { ...payload, thinking, reasoning_effort: off ? undefined : effort }
  return result
}
