import type { ProviderProfile } from '../providers.js'
import type { CacheCounts, MessageUsage } from './types.js'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const hasCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown) => (hasCount(value) ? value : 0)

export const addCacheCounts = (left: CacheCounts | null, right: CacheCounts | null) =>
  left && right ? { hit: left.hit + right.hit, input: left.input + right.input } : (left ?? right)

export const recordedCache = (usage: MessageUsage, legacyReported = false): CacheCounts | null => {
  if (usage.cache_counts !== undefined) {
    const measured = usage.cache_counts
    return measured &&
      hasCount(measured.hit) &&
      hasCount(measured.input) &&
      measured.hit <= measured.input
      ? measured
      : null
  }
  const hit = count(usage.cache_read_input_tokens)
  const written = count(usage.cache_creation_input_tokens)
  return legacyReported || hit || written
    ? { hit, input: hit + written + count(usage.input_tokens) }
    : null
}

export const normalizeProviderUsage = (
  raw: unknown,
  protocol: ProviderProfile['protocol']
): MessageUsage => {
  const usage = record(raw)
  if (protocol === 'anthropic') {
    const input = count(usage.input_tokens)
    const written = count(usage.cache_creation_input_tokens)
    const hit = count(usage.cache_read_input_tokens)
    return {
      input_tokens: input,
      cache_creation_input_tokens: written,
      cache_read_input_tokens: hit,
      output_tokens: count(usage.output_tokens),
      cache_counts:
        hasCount(usage.input_tokens) &&
        (hasCount(usage.cache_read_input_tokens) || hasCount(usage.cache_creation_input_tokens))
          ? { hit, input: input + written + hit }
          : null,
    }
  }
  const gemini = protocol === 'gemini'
  const hitCount = gemini
    ? usage.cachedContentTokenCount
    : (usage.prompt_cache_hit_tokens ??
      record(usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens)
  const miss = gemini ? undefined : usage.prompt_cache_miss_tokens
  const overall = gemini ? usage.promptTokenCount : (usage.prompt_tokens ?? usage.input_tokens)
  const paired = hasCount(hitCount) && hasCount(miss)
  const measured = paired || (hasCount(hitCount) && hasCount(overall))
  const input = paired ? hitCount + miss : count(overall)
  const hit = Math.min(input, count(hitCount))
  return {
    input_tokens: input - hit,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: hit,
    output_tokens: gemini
      ? count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount)
      : count(usage.completion_tokens ?? usage.output_tokens),
    cache_counts: measured ? { hit, input } : null,
  }
}
