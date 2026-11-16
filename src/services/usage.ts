import { create } from 'zustand'
import type { MessageUsage } from './api/types.js'
import { loadAllSessions } from './chat/db.js'

/**
 * 本地用量与费用统计：遍历会话中每条回复记录的 usage，按天聚合，
 * 并按官方刊例价（区分高峰/空闲时段）估算费用。实际账单以平台为准。
 */

/** deepseek-flash 官方刊例价（元 / 百万 tokens），高峰时段为空闲的两倍 */
export type FlashPricing = {
  /** 空闲时段：缓存命中输入 */
  offPeakHit: number
  /** 空闲时段：缓存未命中输入 */
  offPeakMiss: number
  /** 空闲时段：输出 */
  offPeakOut: number
  peakHit: number
  peakMiss: number
  peakOut: number
  /** 联网搜索（元 / 千次） */
  searchPer1k: number
}

export const DEFAULT_PRICING: FlashPricing = {
  offPeakHit: 0.02,
  offPeakMiss: 1,
  offPeakOut: 4,
  peakHit: 0.04,
  peakMiss: 2,
  peakOut: 8,
  searchPer1k: 5,
}

const PRICING_KEY = 'freeseek:pricing'

const isPricing = (value: unknown): value is FlashPricing => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const pricing = value as Record<string, unknown>
  return (
    Object.keys(DEFAULT_PRICING) as (keyof FlashPricing)[]
  ).every((key) => typeof pricing[key] === 'number' && Number.isFinite(pricing[key]))
}

const loadPricing = (): FlashPricing => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRICING_KEY) ?? 'null')
    return isPricing(parsed) ? parsed : DEFAULT_PRICING
  } catch {
    return DEFAULT_PRICING
  }
}

type PricingState = { pricing: FlashPricing }

export const usePricing = create<PricingState>(() => ({ pricing: loadPricing() }))

export const setPricing = (pricing: FlashPricing): void => {
  try {
    localStorage.setItem(PRICING_KEY, JSON.stringify(pricing))
  } catch {
    // 存储不可用时只在内存中生效
  }
  usePricing.setState({ pricing })
}

/** 当前价格是否仍是官方默认值（用量页据此显示「官方默认 / 自定义」） */
export const isDefaultPricing = (pricing: FlashPricing): boolean =>
  (Object.keys(DEFAULT_PRICING) as (keyof FlashPricing)[]).every(
    (key) => pricing[key] === DEFAULT_PRICING[key]
  )

/** 北京时间是否处于高峰时段（工作日 9-12、14-18 点）；法定节假日未计入，估算略有偏差 */
const isPeakBeijing = (timestamp: number): boolean => {
  const beijing = new Date(timestamp + 8 * 3600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export type UsageTotals = {
  requests: number
  /** 缓存命中输入 tokens */
  cacheReadTokens: number
  /** 缓存未命中输入 tokens（含缓存写入） */
  cacheMissTokens: number
  outputTokens: number
  webSearches: number
  /** 按当前价格估算的费用（元） */
  costCny: number
}

export type DayUsage = UsageTotals & { date: string }

const emptyTotals = (): UsageTotals => ({
  requests: 0,
  cacheReadTokens: 0,
  cacheMissTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  costCny: 0,
})

const addUsage = (
  totals: UsageTotals,
  usage: MessageUsage,
  peak: boolean,
  pricing: FlashPricing
) => {
  const read = usage.cache_read_input_tokens ?? 0
  const miss = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const rate = peak
    ? { hit: pricing.peakHit, miss: pricing.peakMiss, out: pricing.peakOut }
    : { hit: pricing.offPeakHit, miss: pricing.offPeakMiss, out: pricing.offPeakOut }
  totals.requests += 1
  totals.cacheReadTokens += read
  totals.cacheMissTokens += miss
  totals.outputTokens += output
  totals.webSearches += searches
  totals.costCny +=
    (read * rate.hit + miss * rate.miss + output * rate.out) / 1_000_000 +
    (searches * pricing.searchPer1k) / 1000
}

const dayKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export type SessionUsage = UsageTotals & { id: string; title: string }

export type UsageStats = {
  days: DayUsage[]
  total: UsageTotals
  /** 按会话聚合，按 token 总量降序 */
  sessions: SessionUsage[]
}

/** 单条回复的用量明细（输入拆分缓存命中/未命中） */
export type MessageUsageDetail = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  searches: number
  tokens: number
  costCny: number
}

/** 按消息时间所处时段计价，计算单条回复的费用 */
export const computeMessageUsage = (
  usage: MessageUsage,
  createdAt: number,
  pricing: FlashPricing = usePricing.getState().pricing
): MessageUsageDetail => {
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const peak = isPeakBeijing(createdAt)
  const rate = peak
    ? { hit: pricing.peakHit, miss: pricing.peakMiss, out: pricing.peakOut }
    : { hit: pricing.offPeakHit, miss: pricing.offPeakMiss, out: pricing.offPeakOut }
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    searches,
    tokens: input + cacheRead + cacheWrite + output,
    costCny:
      (cacheRead * rate.hit + (input + cacheWrite) * rate.miss + output * rate.out) /
        1_000_000 +
      (searches * pricing.searchPer1k) / 1000,
  }
}

/** 遍历本地会话聚合用量；按消息时间所在时段计价 */
export const collectUsage = async (): Promise<UsageStats> => {
  const pricing = usePricing.getState().pricing
  const days = new Map<string, UsageTotals>()
  const total = emptyTotals()
  const sessions: SessionUsage[] = []
  const allSessions = await loadAllSessions().catch(() => [])
  for (const session of allSessions) {
    const sessionTotals = emptyTotals()
    for (const message of session.messages) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const key = dayKey(message.createdAt)
      const day = days.get(key) ?? emptyTotals()
      const peak = isPeakBeijing(message.createdAt)
      addUsage(day, message.usage, peak, pricing)
      days.set(key, day)
      addUsage(total, message.usage, peak, pricing)
      addUsage(sessionTotals, message.usage, peak, pricing)
    }
    if (sessionTotals.requests > 0) {
      sessions.push({ ...sessionTotals, id: session.id, title: session.title || '' })
    }
  }
  return {
    days: [...days.entries()]
      .map(([date, totals]) => ({ date, ...totals }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    total,
    sessions: sessions.sort(
      (a, b) =>
        b.cacheReadTokens + b.cacheMissTokens + b.outputTokens -
        (a.cacheReadTokens + a.cacheMissTokens + a.outputTokens)
    ),
  }
}

/** 近 N 天（含今天）的日序列，缺失补零；用于图表 */
export const recentDays = (stats: UsageStats, count: number): DayUsage[] => {
  const byDate = new Map(stats.days.map((day) => [day.date, day]))
  const result: DayUsage[] = []
  const now = new Date()
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    const key = dayKey(date.getTime())
    result.push(byDate.get(key) ?? { date: key, ...emptyTotals() })
  }
  return result
}

export const todayKey = (): string => dayKey(Date.now())
