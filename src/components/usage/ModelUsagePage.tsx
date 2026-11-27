import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { beginDiagnosticOperation, diagnosticError } from '../../services/diagnostics/log.js'
import { providerModelLabel, useProviders, type ProviderProfile } from '../../services/providers.js'
import { useSettings } from '../../services/settings.js'
import {
  collectModelUsage,
  formatCacheHitRate,
  hasUsageEstimate as hasEstimate,
  totalCacheCounts,
  sumUsage,
  usageTokenCount,
  usePricing,
  type DayUsage,
  type ModelUsage,
  type UsageTotals,
} from '../../services/usage.js'
import { localDayKey } from '../../utils/localDate.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { ProviderMark } from '../settings/ProviderSettings.js'
import { Section } from '../settings/SettingsRows.js'
import styles from './ModelUsagePage.module.css'

const periodLabels = {
  today: 'usageToday',
  week: 'screenTimeWeek',
  month: 'usageModelMonth',
  all: 'usageModelAll',
} as const satisfies Record<string, TranslationKey>
type Period = keyof typeof periodLabels
const lengths = { today: 1, week: 7, month: 30 }
const PAGE_SIZE = 24

export type ModelUsageFilters = { period: Period; provider: string; limit: number }
export const initialModelUsageFilters: ModelUsageFilters = {
  period: 'week',
  provider: 'all',
  limit: PAGE_SIZE,
}

type LoadState = { rows: ModelUsage[] | null; failed: boolean }

export const useModelUsage = (active: boolean) => {
  const pricing = usePricing()
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<LoadState>({ rows: null, failed: false })
  useEffect(() => {
    if (!active) {
      return
    }
    const controller = new AbortController()
    const finish = beginDiagnosticOperation('usage', 'models.read')
    setState({ rows: null, failed: false })
    void collectModelUsage(controller.signal)
      .then((rows) => {
        finish(controller.signal.aborted ? 'cancelled' : 'completed', { modelCount: rows.length })
        if (!controller.signal.aborted) {
          setState({ rows, failed: false })
        }
      })
      .catch((error) => {
        finish(controller.signal.aborted ? 'cancelled' : 'failed', diagnosticError(error))
        if (!controller.signal.aborted) {
          setState({ rows: null, failed: true })
        }
      })
    return () => controller.abort()
  }, [active, pricing, retry])
  return { ...state, retry: () => setRetry((value) => value + 1) }
}

type Translator = ReturnType<typeof useTranslate>
type Source = ReturnType<typeof useModelUsage>
const providerKey = (id: string | null) => JSON.stringify(id)
const withinPeriod = (days: DayUsage[], period: Period) => {
  if (period === 'all') {
    return days
  }
  const day = new Date()
  const end = localDayKey(day.getTime())
  day.setDate(day.getDate() - (lengths[period] - 1))
  const start = localDayKey(day.getTime())
  return days.filter((item) => item.date >= start && item.date <= end)
}
const formatCost = (amount: number) => '¥' + amount.toFixed(amount > 0 && amount < 1 ? 4 : 2)
const shortCount = (number: number) => {
  if (number >= 1_000_000_000) {
    return `${Number((number / 1_000_000_000).toFixed(2))}B`
  }
  if (number >= 1_000_000) {
    return `${Number((number / 1_000_000).toFixed(2))}M`
  }
  return number >= 1000 ? `${Number((number / 1000).toFixed(1))}k` : String(number)
}

const connectionName = (
  providerId: string | null,
  profile: ProviderProfile | undefined,
  t: Translator
) =>
  providerId === 'deepseek'
    ? t('providerOfficial')
    : (profile?.name ??
      (providerId
        ? t('usageModelOldConnection', { id: providerId.slice(0, 6) })
        : t('usageModelUnknownConnection')))

const getIdentity = (row: ModelUsage, profiles: ProviderProfile[], t: Translator) => {
  const profile = profiles.find((item) => item.id === row.providerId)
  return {
    provider: connectionName(row.providerId, profile, t),
    name: row.model ? providerModelLabel(row.model, profile) : t('usageModelUnknown'),
    icon: row.providerId === 'deepseek' ? 'deepseek' : profile?.preset?.id,
  }
}

const Feedback = ({ source }: { source: Source }) => {
  const t = useTranslate()
  return source.failed ? (
    <div className={styles.feedback} role="alert">
      <p>{t('usageLoadError')}</p>
      <Button variant="outlined" onClick={source.retry}>
        {t('retry')}
      </Button>
    </div>
  ) : (
    <p className={styles.feedback} role="status">
      {t('usageModelLoading')}
    </p>
  )
}

const Overview = ({ totals }: { totals: UsageTotals }) => {
  const t = useTranslate()
  const tokens = usageTokenCount(totals)
  return (
    <>
      <dl className={styles.overview} data-testid="model-usage-overview">
        <div>
          <dt>{t('usageModelTotalTokens')}</dt>
          <dd title={tokens.toLocaleString()}>{shortCount(tokens)}</dd>
        </div>
        <div>
          <dt>{t('usageRequests')}</dt>
          <dd title={totals.requests.toLocaleString()}>{shortCount(totals.requests)}</dd>
        </div>
        <div>
          <dt>{t('usageModelEstimatedCost')}</dt>
          <dd data-unpriced={!hasEstimate(totals) || undefined}>
            {hasEstimate(totals) ? formatCost(totals.costCny) : t('usageModelNoPrice')}
          </dd>
        </div>
      </dl>
      {totals.unpricedRequests > 0 && (
        <p className={styles.note}>
          {t('usageModelPartialCost', { count: totals.unpricedRequests })}
        </p>
      )}
    </>
  )
}

export const ModelUsagePage = ({
  source,
  filters,
  change,
  selected,
  openModel,
}: {
  source: Source
  filters: ModelUsageFilters
  change: (filters: ModelUsageFilters) => void
  selected: string | null
  openModel: (key: string) => void
}) => {
  const t = useTranslate()
  const profiles = useProviders((state) => state.profiles)
  if (!source.rows) {
    return <Feedback source={source} />
  }
  const providers = [...new Set(source.rows.map((row) => row.providerId))]
  const options = [
    { value: 'all', label: t('usageModelAllProviders') },
    ...providers.map((id) => ({
      value: providerKey(id),
      label: connectionName(
        id,
        profiles.find((item) => item.id === id),
        t
      ),
    })),
  ]
  const provider = options.some((option) => option.value === filters.provider)
    ? filters.provider
    : 'all'
  const rows = source.rows
    .flatMap((row) => {
      if (provider !== 'all' && provider !== providerKey(row.providerId)) {
        return []
      }
      const totals = sumUsage(withinPeriod(row.days, filters.period))
      return totals.requests ? [{ row, totals, tokens: usageTokenCount(totals) }] : []
    })
    .sort((a, b) => b.tokens - a.tokens || b.totals.requests - a.totals.requests)
  const overall = sumUsage(rows.map(({ totals }) => totals))
  const max = Math.max(1, rows[0]?.tokens ?? 0)
  return (
    <div className={styles.page}>
      <div className={styles.periods} role="group" aria-label={t('usageModelPeriod')}>
        {(Object.keys(periodLabels) as Period[]).map((period) => (
          <button
            key={period}
            type="button"
            aria-pressed={filters.period === period}
            onClick={() => change({ ...filters, period, limit: PAGE_SIZE })}
          >
            {t(periodLabels[period])}
          </button>
        ))}
      </div>
      <div className={styles.providerFilter}>
        <span aria-hidden="true">{t('usageModelProvider')}</span>
        <Select
          ariaLabel={t('usageModelProvider')}
          value={provider}
          options={options}
          onChange={(provider) => change({ ...filters, provider, limit: PAGE_SIZE })}
        />
      </div>
      {rows.length ? (
        <>
          <Overview totals={overall} />
          <Section title={t('usageModelRanking')}>
            <div data-testid="model-usage-ranking">
              {rows.slice(0, filters.limit).map(({ row, totals, tokens }, index) => {
                const identity = getIdentity(row, profiles, t)
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={styles.modelRow}
                    data-tone={index === 1 ? 'teal' : index === 2 ? 'amber' : undefined}
                    data-settings-target={selected === row.key ? 'usageModel' : undefined}
                    onClick={() => openModel(row.key)}
                  >
                    <span className={styles.rowGrid}>
                      <span className={styles.mark}>
                        <ProviderMark id={identity.icon} />
                      </span>
                      <span className={styles.modelIdentity}>
                        <strong>{identity.name}</strong>
                        <small>{identity.provider}</small>
                      </span>
                      <span className={styles.tokenCount}>{shortCount(tokens)} tok</span>
                      <IconChevronRightOutline14 />
                    </span>
                    <span className={styles.rowMeta}>
                      {t('usageModelRequestCount', { count: totals.requests.toLocaleString() })}
                      <span aria-hidden="true">·</span>
                      {hasEstimate(totals) ? (
                        formatCost(totals.costCny)
                      ) : (
                        <small>{t('usageModelNoPrice')}</small>
                      )}
                    </span>
                    <span className={styles.track} aria-hidden="true">
                      <span style={{ width: `${(tokens / max) * 100}%` }} />
                    </span>
                  </button>
                )
              })}
            </div>
            {rows.length > filters.limit && (
              <Button
                block
                variant="outlined"
                className={styles.more}
                onClick={() => change({ ...filters, limit: filters.limit + PAGE_SIZE })}
              >
                {t('modelShowMore')}
              </Button>
            )}
          </Section>
        </>
      ) : (
        <p className={styles.feedback}>{t('usageModelEmpty')}</p>
      )}
    </div>
  )
}

const DAY_MS = 86_400_000
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS
const trendPoints = (days: DayUsage[], period: Period) => {
  const today = dayNumber(localDayKey(Date.now()))
  const from =
    period === 'all'
      ? dayNumber(days[0]?.date ?? localDayKey(Date.now()))
      : today - lengths[period] + 1
  const to = period === 'all' ? dayNumber(days.at(-1)?.date ?? localDayKey(Date.now())) : today
  const span = Math.max(1, Math.ceil((to - from + 1) / 7))
  const buckets = Array.from({ length: Math.ceil((to - from + 1) / span) }, (_, index) => ({
    start: (from + index * span) * DAY_MS,
    end: Math.min(to, from + (index + 1) * span - 1) * DAY_MS,
    days: [] as DayUsage[],
  }))
  for (const day of days) {
    buckets[Math.floor((dayNumber(day.date) - from) / span)]?.days.push(day)
  }
  return buckets.map(({ start, end, days: group }) => ({ start, end, ...sumUsage(group) }))
}

export const ModelUsageDetail = ({
  source,
  modelKey,
  period,
}: {
  source: Source
  modelKey: string | null
  period: Period
}) => {
  const t = useTranslate()
  const profiles = useProviders((state) => state.profiles)
  const locale = useSettings((state) => state.locale)
  const [active, select] = useState<number>()
  if (!source.rows) {
    return <Feedback source={source} />
  }
  const row = source.rows.find((item) => item.key === modelKey)
  if (!row) {
    return <p className={styles.feedback}>{t('usageModelEmpty')}</p>
  }
  const data = withinPeriod(row.days, period)
  const identity = getIdentity(row, profiles, t)
  const total = sumUsage(data)
  const tokens = usageTokenCount(total)
  const points = trendPoints(data, period)
  const max = Math.max(1, ...points.map(usageTokenCount))
  const point = points.find((item) => item.start === active) ?? points.at(-1)
  const dateFormat = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const label = ({ start, end }: { start: number; end: number }) =>
    start === end
      ? dateFormat.format(start)
      : `${dateFormat.format(start)} – ${dateFormat.format(end)}`
  const components = [
    ['usageCacheHit', total.cacheReadTokens, 'blue'],
    ['usageModelInputMiss', total.cacheMissTokens, 'teal'],
    ['usageOutputTokens', total.outputTokens, 'violet'],
  ] as const
  return (
    <div className={styles.page}>
      <div className={styles.identity}>
        <span className={styles.mark}>
          <ProviderMark id={identity.icon} />
        </span>
        <div>
          <h2>{identity.name}</h2>
          <p>
            {identity.provider} · {t(periodLabels[period])}
          </p>
        </div>
      </div>
      <Overview totals={total} />
      <Section title={t('usageModelComposition')}>
        <div className={styles.breakdown}>
          <div className={styles.stack} aria-hidden="true">
            {components.map(([key, value, color]) => (
              <span
                key={key}
                data-fill={color}
                style={{ width: `${(value / Math.max(1, tokens)) * 100}%` }}
              />
            ))}
          </div>
          <dl>
            <div title={t('usageCacheRateHelp')}>
              <dt>{t('usageCacheHitRate')}</dt>
              <dd>{formatCacheHitRate(totalCacheCounts(total), locale)}</dd>
            </div>
            {components.map(([key, value, color]) => (
              <div key={key}>
                <dt>
                  <span data-fill={color} aria-hidden="true" />
                  {t(key)}
                </dt>
                <dd>{value.toLocaleString(locale)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
      <Section title={t('usageModelTrend')}>
        <div className={styles.trend}>
          <div className={styles.chart} role="group" aria-label={t('usageModelTrend')}>
            {points.map((item) => (
              <button
                key={item.start}
                type="button"
                aria-pressed={point === item}
                aria-label={t('usageModelTrendPoint', {
                  date: label(item),
                  tokens: usageTokenCount(item).toLocaleString(locale),
                  requests: item.requests.toLocaleString(locale),
                })}
                onClick={() => select(item.start)}
              >
                <span className={styles.chartTrack} aria-hidden="true">
                  <span style={{ height: `${(usageTokenCount(item) / max) * 100}%` }} />
                </span>
                <span>{dateFormat.format(item.end)}</span>
              </button>
            ))}
          </div>
          {point && (
            <p data-testid="model-usage-trend-value">
              {t('usageModelTrendPoint', {
                date: label(point),
                tokens: usageTokenCount(point).toLocaleString(locale),
                requests: point.requests.toLocaleString(locale),
              })}
            </p>
          )}
        </div>
      </Section>
    </div>
  )
}
