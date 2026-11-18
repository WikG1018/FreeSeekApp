import { create } from 'zustand'
import type { MessageUsage } from './api/types.js'
import { loadAllSessions } from './chat/db.js'
import type { AssistantMessage } from './chat/types.js'
import { usageEntries } from './chat/usage.js'

// DeepSeek billed model-triggered tools from Nov 1 until Nov 18 at 12:00 Beijing time.
const TOOL_BILLING_START = Date.UTC(2026, 9, 31, 16)
const TOOL_BILLING_END = Date.UTC(2026, 10, 18, 4)

/** 服务端返回成功次数；旧归档缺少该字段时沿用历史计数。 */
const toolCalls = (usage: MessageUsage) => {
  const tools = usage.server_tool_use
  return (
    (tools?.tool_search ?? tools?.web_search_requests ?? 0) +
    (tools?.tool_fetch ?? 0) +
    (tools?.tool_image_search ?? 0)
  )
}

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
  /** 历史对话联网工具单价（元 / 千次）。 */
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

/** https://api-docs.deepseek.com/zh-cn/quick_start/pricing/，2026-11-17 核对。 */
export const PRO_PRICING: FlashPricing = {
  offPeakHit: 0.15,
  offPeakMiss: 4.5,
  offPeakOut: 13.5,
  peakHit: 0.3,
  peakMiss: 9,
  peakOut: 27,
  searchPer1k: 5,
}
const UNPRICED: FlashPricing = {
  offPeakHit: 0,
  offPeakMiss: 0,
  offPeakOut: 0,
  peakHit: 0,
  peakMiss: 0,
  peakOut: 0,
  searchPer1k: 0,
}
type PricedModel = Pick<AssistantMessage, 'model' | 'responseModel' | 'connection'>
const pricedModels = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
]
export const hasKnownPricing = (
  message: PricedModel,
  model = message.responseModel ?? message.model
) =>
  (!message.connection || message.connection.providerId === 'deepseek') &&
  (!model || pricedModels.includes(model))
const messagePricing = (
  message: PricedModel,
  flash: FlashPricing,
  model = message.responseModel ?? message.model
) =>
  !hasKnownPricing(message, model) ? UNPRICED : model === 'deepseek-v4-pro' ? PRO_PRICING : flash

const PRICING_KEY = 'freeseek:pricing'

const isPricing = (value: unknown): value is FlashPricing => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const pricing = value as Record<string, unknown>
  return (Object.keys(DEFAULT_PRICING) as (keyof FlashPricing)[]).every(
    (key) => typeof pricing[key] === 'number' && Number.isFinite(pricing[key])
  )
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
  unpricedRequests: number
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
  unpricedRequests: 0,
  requests: 0,
  cacheReadTokens: 0,
  cacheMissTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  costCny: 0,
})

const addUsage = (totals: UsageTotals, detail: MessageUsageDetail, priced: boolean) => {
  totals.requests += 1
  if (!priced) {
    totals.unpricedRequests += 1
  }
  totals.cacheReadTokens += detail.cacheRead
  totals.cacheMissTokens += detail.input + detail.cacheWrite
  totals.outputTokens += detail.output
  totals.webSearches += detail.searches
  totals.costCny += detail.costCny
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
  const searches = toolCalls(usage)
  const toolCost =
    createdAt >= TOOL_BILLING_START && createdAt < TOOL_BILLING_END
      ? (searches * pricing.searchPer1k) / 1000
      : 0
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
      (cacheRead * rate.hit + (input + cacheWrite) * rate.miss + output * rate.out) / 1_000_000 +
      toolCost,
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
    const addEntry = (
      message: PricedModel,
      entry: { createdAt: number; usage: MessageUsage; model?: string }
    ) => {
      const effectivePricing = messagePricing(message, pricing, entry.model),
        priced = hasKnownPricing(message, entry.model)
      const key = dayKey(entry.createdAt),
        day = days.get(key) ?? emptyTotals()
      const detail = computeMessageUsage(entry.usage, entry.createdAt, effectivePricing)
      addUsage(day, detail, priced)
      days.set(key, day)
      addUsage(total, detail, priced)
      addUsage(sessionTotals, detail, priced)
    }
    for (const message of session.messages) {
      if (message.role === 'assistant' && message.usage) {
        for (const entry of usageEntries(message)) {
          addEntry(message, entry)
        }
      }
    }
    for (const charge of session.compressionUsage ?? []) {
      addEntry(charge, charge)
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
        b.cacheReadTokens +
        b.cacheMissTokens +
        b.outputTokens -
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

/** 单条回复汇总历次续写，分别按各次请求的时段计费。 */
export const computeReplyUsage = (
  message: AssistantMessage,
  pricing: FlashPricing = usePricing.getState().pricing
): MessageUsageDetail => {
  const total: MessageUsageDetail = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    searches: 0,
    tokens: 0,
    costCny: 0,
  }
  for (const entry of usageEntries(message)) {
    const detail = computeMessageUsage(
      entry.usage,
      entry.createdAt,
      messagePricing(message, pricing, entry.model)
    )
    for (const key of Object.keys(total) as (keyof MessageUsageDetail)[]) {
      total[key] += detail[key]
    }
  }
  return total
}
