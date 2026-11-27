import { create } from 'zustand'
import { localDayKey as dayKey } from '../utils/localDate.js'
import type { CacheCounts, MessageUsage } from './api/types.js'
import { addCacheCounts, recordedCache } from './api/providerUsage.js'
import { visitStoredSessions } from './chat/db.js'
import type { AssistantMessage, Session } from './chat/types.js'
import { usageEntries } from './chat/usage.js'
import { THIRD_PARTY_SEARCH_RATE } from './api/search.js'

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

/** https://api-docs.deepseek.com/zh-cn/quick_start/pricing/，2026-11-26 核对。 */
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
const flashAliases = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']
const pricedModels = [...flashAliases, 'deepseek-v4-pro']
export const modelPriceKey = (providerId: string, model: string) =>
  JSON.stringify([providerId, model])
export const proPriceKey = modelPriceKey('deepseek', 'deepseek-v4-pro')

const messagePricing = (
  message: PricedModel,
  state: PricingState,
  model = message.responseModel ?? message.model
): FlashPricing | undefined => {
  const providerId = message.connection?.providerId
  if (providerId && providerId !== 'deepseek') {
    return (
      (model ? state.modelPrices[modelPriceKey(providerId, model)] : undefined) ??
      (message.model ? state.modelPrices[modelPriceKey(providerId, message.model)] : undefined)
    )
  }
  if (model === 'deepseek-v4-pro') {
    return state.modelPrices[proPriceKey] ?? PRO_PRICING
  }
  return model && flashAliases.includes(model) ? state.pricing : undefined
}

export const hasKnownPricing = (message: PricedModel, model?: string) =>
  Boolean(messagePricing(message, usePricing.getState(), model))

const PRICING_KEY = 'freeseek:pricing'
const MODEL_PRICING_KEY = 'freeseek:model-prices'

const isPricing = (value: unknown): value is FlashPricing => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const pricing = value as Record<string, unknown>
  return (Object.keys(DEFAULT_PRICING) as (keyof FlashPricing)[]).every(
    (key) => typeof pricing[key] === 'number' && Number.isFinite(pricing[key]) && pricing[key] >= 0
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

export type ModelPrices = Record<string, FlashPricing>
type PricingState = { pricing: FlashPricing; modelPrices: ModelPrices }
export const readModelPrices = (value: unknown): ModelPrices => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 400)
      .filter(([key, pricing]) => key.startsWith('["') && key.length <= 1024 && isPricing(pricing))
  )
}
const loadModelPrices = () => {
  try {
    return readModelPrices(JSON.parse(localStorage.getItem(MODEL_PRICING_KEY) ?? '{}'))
  } catch {
    return {}
  }
}
export const usePricing = create<PricingState>(() => ({
  pricing: loadPricing(),
  modelPrices: loadModelPrices(),
}))

export const saveModelPrices = (modelPrices: ModelPrices) => {
  try {
    localStorage.setItem(MODEL_PRICING_KEY, JSON.stringify(modelPrices))
    usePricing.setState({ modelPrices })
    return true
  } catch {
    return false
  }
}

export const savePrice = (key: string, pricing?: FlashPricing): boolean => {
  if (key === 'flash' && pricing) {
    try {
      localStorage.setItem(PRICING_KEY, JSON.stringify(pricing))
      usePricing.setState({ pricing })
      return true
    } catch {
      return false
    }
  }
  const modelPrices = usePricing.getState().modelPrices
  return saveModelPrices(
    pricing
      ? { ...modelPrices, [key]: pricing }
      : Object.fromEntries(Object.entries(modelPrices).filter(([id]) => id !== key))
  )
}

export const setPricing = (pricing: FlashPricing): void => {
  try {
    localStorage.setItem(PRICING_KEY, JSON.stringify(pricing))
  } catch {
    // 存储不可用时只在内存中生效
  }
  usePricing.setState({ pricing })
}

// Inclusive MMDD ranges from the State Council's published holiday schedules.
const beijingHolidays: Record<number, [start: number, end: number][]> = {
  // https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  2026: [
    [101, 103],
    [215, 223],
    [404, 406],
    [501, 505],
    [619, 621],
    [925, 927],
    [1001, 1007],
  ],
  // https://www.gov.cn/zhengce/content/202611/content_7085101.htm
  2027: [
    [101, 103],
    [205, 213],
    [403, 405],
    [501, 505],
    [609, 609],
    [915, 915],
    [1001, 1007],
  ],
}

/** 按北京时间估算周一至周五的高峰时段，已公布的节假日按全天空闲计价。 */
const isPeakBeijing = (timestamp: number): boolean => {
  const beijing = new Date(timestamp + 8 * 3600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  if (!((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))) {
    return false
  }
  const monthDay = (beijing.getUTCMonth() + 1) * 100 + beijing.getUTCDate()
  return !beijingHolidays[beijing.getUTCFullYear()]?.some(
    ([start, end]) => monthDay >= start && monthDay <= end
  )
}

export type UsageTotals = {
  unpricedRequests: number
  requests: number
  /** 缓存命中输入 tokens */
  cacheReadTokens: number
  /** 缓存未命中输入 tokens（含缓存写入） */
  cacheMissTokens: number
  measuredCacheHits: number
  measuredCacheInput: number
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
  measuredCacheHits: 0,
  measuredCacheInput: 0,
  outputTokens: 0,
  webSearches: 0,
  costCny: 0,
})

const addUsage = (
  totals: UsageTotals,
  detail: MessageUsageDetail,
  priced: boolean,
  cache: CacheCounts | null
) => {
  totals.requests += 1
  if (!priced) {
    totals.unpricedRequests += 1
  }
  totals.cacheReadTokens += detail.cacheRead
  totals.cacheMissTokens += detail.input + detail.cacheWrite
  totals.measuredCacheHits += cache?.hit ?? 0
  totals.measuredCacheInput += cache?.input ?? 0
  totals.outputTokens += detail.output
  totals.webSearches += detail.searches
  totals.costCny += detail.costCny
}

export type SessionUsage = UsageTotals & { id: string; title: string }

export type UsageStats = {
  days: DayUsage[]
  total: UsageTotals
  /** 按会话聚合，按 token 总量降序 */
  sessions: SessionUsage[]
}

export const hasUsageEstimate = (
  usage: Pick<UsageTotals, 'requests' | 'unpricedRequests' | 'costCny'>
) => usage.requests > usage.unpricedRequests || usage.costCny > 0

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
  const modelSearches = toolCalls(usage)
  const standaloneSearches = usage.standalone_search_requests ?? 0
  const toolCost =
    createdAt >= TOOL_BILLING_START && createdAt < TOOL_BILLING_END
      ? (modelSearches * pricing.searchPer1k) / 1000
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
    searches: modelSearches + standaloneSearches,
    tokens: input + cacheRead + cacheWrite + output,
    costCny:
      (cacheRead * rate.hit + (input + cacheWrite) * rate.miss + output * rate.out) / 1_000_000 +
      toolCost +
      standaloneSearches * THIRD_PARTY_SEARCH_RATE,
  }
}

type UsageEntry = { createdAt: number; usage: MessageUsage; model?: string }

const estimateEntry = (message: PricedModel, entry: UsageEntry, pricing: PricingState) => {
  const rate = messagePricing(message, pricing, entry.model)
  const detail = computeMessageUsage(entry.usage, entry.createdAt, rate ?? UNPRICED)
  // An older record can include both billable searches and model usage with no token price.
  const priced = Boolean(rate || (detail.tokens === 0 && entry.usage.standalone_search_requests))
  return { detail, priced }
}

const entryCache = (message: PricedModel, { usage, model }: UsageEntry) =>
  recordedCache(
    usage,
    message.connection
      ? message.connection.providerId === 'deepseek'
      : model !== undefined && pricedModels.includes(model)
  )

export const replyCacheCounts = (message: AssistantMessage) =>
  usageEntries(message).reduce<CacheCounts | null>(
    (total, entry) => addCacheCounts(total, entryCache(message, entry)),
    null
  )

export const totalCacheCounts = (value: UsageTotals): CacheCounts => ({
  hit: value.measuredCacheHits,
  input: value.measuredCacheInput,
})

export const formatCacheHitRate = (counts: CacheCounts | null, locale: string) =>
  counts && counts.input > 0
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
        Math.max(0, Math.min(1, counts.hit / counts.input))
      )
    : '—'

const visitUsageEntries = (
  session: Session,
  visit: (message: PricedModel, entry: UsageEntry) => void
) => {
  // Inherited messages are snapshots. Their original requests belong to the source chat.
  for (const message of session.messages) {
    if (message.role === 'assistant') {
      for (const entry of usageEntries(message)) {
        visit(message, entry)
      }
    }
  }
  for (const charge of session.compressionUsage ?? []) {
    visit(charge, charge)
  }
}

/** Estimate all recorded requests from this chat, including other branches and compression. */
export const summarizeSessionUsage = (session: Session, pricing = usePricing.getState()) => {
  const total = emptyTotals()
  visitUsageEntries(session, (message, entry) => {
    const { detail, priced } = estimateEntry(message, entry, pricing)
    addUsage(total, detail, priced, entryCache(message, entry))
  })
  return total
}

/** 遍历本地会话聚合用量；按消息时间所在时段计价 */
export const collectUsage = async (signal?: AbortSignal): Promise<UsageStats> => {
  const pricing = usePricing.getState()
  const days = new Map<string, UsageTotals>()
  const total = emptyTotals()
  const sessions: SessionUsage[] = []
  await visitStoredSessions((session) => {
    const sessionTotals = emptyTotals()
    visitUsageEntries(session, (message, entry) => {
      const key = dayKey(entry.createdAt),
        day = days.get(key) ?? emptyTotals()
      const { detail, priced } = estimateEntry(message, entry, pricing)
      const cache = entryCache(message, entry)
      addUsage(day, detail, priced, cache)
      days.set(key, day)
      addUsage(total, detail, priced, cache)
      addUsage(sessionTotals, detail, priced, cache)
    })
    if (sessionTotals.requests > 0) {
      sessions.push({ ...sessionTotals, id: session.id, title: session.title || '' })
    }
  }, signal)
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

export type ModelUsage = {
  key: string
  providerId: string | null
  model: string | null
  days: DayUsage[]
}

/** Read one request at a time, grouped by the saved connection and that request's model. */
export const collectModelUsage = async (signal?: AbortSignal): Promise<ModelUsage[]> => {
  const pricing = usePricing.getState()
  const groups = new Map<
    string,
    { providerId: string | null; model: string | null; days: Map<string, UsageTotals> }
  >()
  await visitStoredSessions(
    (session) =>
      visitUsageEntries(session, (message, entry) => {
        const recorded = entry.model ?? null
        const providerId =
          message.connection?.providerId ??
          (recorded && pricedModels.includes(recorded) ? 'deepseek' : null)
        const model =
          providerId === 'deepseek' && recorded && flashAliases.includes(recorded)
            ? 'deepseek-flash'
            : recorded
        const key = JSON.stringify([providerId, model])
        let group = groups.get(key)
        if (!group) {
          group = { providerId, model, days: new Map() }
          groups.set(key, group)
        }
        const date = dayKey(entry.createdAt)
        const day = group.days.get(date) ?? emptyTotals()
        const { detail, priced } = estimateEntry(message, entry, pricing)
        addUsage(day, detail, priced, entryCache(message, entry))
        group.days.set(date, day)
      }),
    signal
  )
  return [...groups].map(([key, group]) => ({
    key,
    providerId: group.providerId,
    model: group.model,
    days: [...group.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, ...totals })),
  }))
}

export const usageTokenCount = (value: UsageTotals) =>
  value.cacheReadTokens + value.cacheMissTokens + value.outputTokens

export const sumUsage = (items: UsageTotals[]) => {
  const total = emptyTotals()
  const fields = Object.keys(total) as (keyof UsageTotals)[]
  for (const item of items) {
    for (const field of fields) {
      total[field] += item[field]
    }
  }
  return total
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

type ReplyUsage = MessageUsageDetail & Pick<UsageTotals, 'requests' | 'unpricedRequests'>

/** 单条回复汇总历次续写，分别按各次请求的时段计费。 */
export const computeReplyUsage = (
  message: AssistantMessage,
  pricing: FlashPricing = usePricing.getState().pricing
): ReplyUsage => {
  const total: MessageUsageDetail = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    searches: 0,
    tokens: 0,
    costCny: 0,
  }
  const state = { ...usePricing.getState(), pricing }
  const entries = usageEntries(message)
  let unpricedRequests = 0
  for (const entry of entries) {
    const { detail, priced } = estimateEntry(message, entry, state)
    if (!priced) {
      unpricedRequests += 1
    }
    for (const key of Object.keys(total) as (keyof MessageUsageDetail)[]) {
      total[key] += detail[key]
    }
  }
  return { ...total, requests: entries.length, unpricedRequests }
}
