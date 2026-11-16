import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  collectUsage,
  DEFAULT_PRICING,
  recentDays,
  setPricing,
  todayKey,
  usePricing,
  type FlashPricing,
  type UsageStats,
} from '../../services/usage.js'
import { Modal } from '../base/Modal.js'
import styles from './UsagePanel.module.css'

const formatTokens = (value: number) => value.toLocaleString()

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 1 ? `¥${value.toFixed(2)}` : `¥${value.toFixed(4)}`

const numberField = (
  label: string,
  value: number,
  onChange: (value: number) => void,
  keyPrefix: string
) => (
  <label key={`${keyPrefix}-${label}`} className={styles.priceField}>
    <span className={styles.priceFieldLabel}>{label}</span>
    <input
      className={styles.priceInput}
      type="number"
      min={0}
      step={0.01}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </label>
)

/** 用量与费用统计：按天聚合本地会话的 token 用量，并按可编辑的刊例价估算费用 */
export const UsagePanel = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const pricing = usePricing((state) => state.pricing)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<FlashPricing>(pricing)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    collectUsage()
      .then((result) => {
        if (alive) {
          setStats(result)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [pricing])

  const days = stats ? recentDays(stats, 14) : []
  const maxCost = Math.max(0.000001, ...days.map((day) => day.costCny))
  const today = stats?.days.find((day) => day.date === todayKey())

  const update = (patch: Partial<FlashPricing>) => {
    setSaved(false)
    setDraft((previous) => ({ ...previous, ...patch }))
  }

  return (
    <Modal title={t('usageTitle')} closable onClose={onClose} className={styles.dialog}>
      {loading ? (
        <div className={styles.loading}>{t('sessionLoading')}</div>
      ) : !stats || stats.total.requests === 0 ? (
        <div className={styles.empty}>{t('usageEmpty')}</div>
      ) : (
        <div className={styles.content}>
          <div className={styles.cardGrid}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>{t('usageTotalCost')}</div>
              <div className={styles.cardValue}>{formatCost(stats.total.costCny)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>{t('usageRequests')}</div>
              <div className={styles.cardValue}>{formatTokens(stats.total.requests)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>{t('usageInputTokens')}</div>
              <div className={styles.cardValue}>
                {formatTokens(stats.total.cacheReadTokens + stats.total.cacheMissTokens)}
              </div>
              <div className={styles.cardSub}>
                {t('usageCacheHit')} {formatTokens(stats.total.cacheReadTokens)} ·{' '}
                {t('usageCacheMiss')} {formatTokens(stats.total.cacheMissTokens)}
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>{t('usageOutputTokens')}</div>
              <div className={styles.cardValue}>{formatTokens(stats.total.outputTokens)}</div>
              <div className={styles.cardSub}>
                {t('usageWebSearches')} {formatTokens(stats.total.webSearches)}
              </div>
            </div>
          </div>

          <div className={styles.sectionTitle}>
            {t('usageToday')}：{formatCost(today?.costCny ?? 0)} · {t('usageRequests')}{' '}
            {formatTokens(today?.requests ?? 0)}
          </div>

          <div className={styles.chart} aria-label={t('usageLast14Days')}>
            {days.map((day) => (
              <div
                key={day.date}
                className={styles.chartBarWrap}
                title={`${day.date} · ${formatCost(day.costCny)} · ${formatTokens(day.requests)} ${t('usageRequests')}`}
              >
                <div
                  className={styles.chartBar}
                  style={{ height: `${Math.max(2, (day.costCny / maxCost) * 100)}%` }}
                />
                <div className={styles.chartLabel}>{day.date.slice(8)}</div>
              </div>
            ))}
          </div>
          <div className={styles.chartCaption}>{t('usageLast14Days')}</div>

          <div className={styles.sectionTitle}>{t('usagePricingSection')}</div>
          <div className={styles.priceGroup}>
            <div className={styles.priceGroupTitle}>{t('usagePricingOffPeak')}</div>
            <div className={styles.priceRow}>
              {numberField(t('usagePricingHit'), draft.offPeakHit, (v) => update({ offPeakHit: v }), 'off')}
              {numberField(t('usagePricingMiss'), draft.offPeakMiss, (v) => update({ offPeakMiss: v }), 'off')}
              {numberField(t('usagePricingOut'), draft.offPeakOut, (v) => update({ offPeakOut: v }), 'off')}
            </div>
          </div>
          <div className={styles.priceGroup}>
            <div className={styles.priceGroupTitle}>{t('usagePricingPeak')}</div>
            <div className={styles.priceRow}>
              {numberField(t('usagePricingHit'), draft.peakHit, (v) => update({ peakHit: v }), 'peak')}
              {numberField(t('usagePricingMiss'), draft.peakMiss, (v) => update({ peakMiss: v }), 'peak')}
              {numberField(t('usagePricingOut'), draft.peakOut, (v) => update({ peakOut: v }), 'peak')}
            </div>
          </div>
          <div className={styles.priceGroup}>
            <div className={styles.priceRow}>
              {numberField(t('usagePricingSearch'), draft.searchPer1k, (v) => update({ searchPer1k: v }), 'search')}
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  setPricing(draft)
                  setSaved(true)
                }}
              >
                {saved ? t('usageSaved') : t('usageSave')}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  setSaved(false)
                  setDraft(DEFAULT_PRICING)
                }}
              >
                {t('usagePricingReset')}
              </button>
            </div>
          </div>
          <div className={styles.hint}>{t('usagePricingHint')}</div>
        </div>
      )}
    </Modal>
  )
}
