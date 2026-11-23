import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { beginDiagnosticOperation, diagnosticError } from '../../services/diagnostics/log.js'
import {
  collectUsage,
  formatCacheHitRate,
  totalCacheCounts,
  recentDays,
  todayKey,
  usePricing,
  type UsageStats,
} from '../../services/usage.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useSettings } from '../../services/settings.js'
import styles from './UsagePanel.module.css'

const formatTokens = (value: number) => value.toLocaleString()

const formatCost = (value: number) =>
  value >= 1 || value === 0 ? `¥${value.toFixed(2)}` : `¥${value.toFixed(4)}`

/** 紧凑金额：面板里的大数字用 */
/** 千分位紧凑：42,319 → 42.3k */
const compactTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value)

type Stats = UsageStats

/** 统计内容：设置页与抽屉弹窗共用；价格编辑统一收进「价格设置」二级页 */
export const UsageContent = ({
  onOpenPricing,
  onOpenModels,
}: {
  onOpenPricing?: () => void
  onOpenModels?: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const pricing = usePricing()
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const finish = beginDiagnosticOperation('usage', 'totals.read')
    setLoading(true)
    setFailed(false)
    void collectUsage(controller.signal)
      .then((result) => {
        finish(controller.signal.aborted ? 'cancelled' : 'completed', {
          dayCount: result.days.length,
          requestCount: result.total.requests,
        })
        if (!controller.signal.aborted) {
          setStats(result)
          setLoading(false)
        }
      })
      .catch((error) => {
        finish(controller.signal.aborted ? 'cancelled' : 'failed', diagnosticError(error))
        if (!controller.signal.aborted) {
          setFailed(true)
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [pricing, retry])

  const days = stats ? recentDays(stats, 14) : []
  const maxCost = Math.max(0.000001, ...days.map((day) => day.costCny))
  const today = stats?.days.find((day) => day.date === todayKey())
  const modelLink = onOpenModels ? (
    <button
      type="button"
      className={styles.ledgerAction}
      data-settings-target="usageModels"
      onClick={onOpenModels}
    >
      <span className={styles.pricingRowLabel}>{t('usageModelsTitle')}</span>
      <IconChevronRightOutline14 />
    </button>
  ) : null

  const pricingLink = onOpenPricing ? (
    <button
      type="button"
      className={styles.ledgerAction}
      data-settings-target="usagePricing"
      onClick={onOpenPricing}
    >
      <span className={styles.pricingRowLabel}>{t('usagePricingTitle')}</span>
      <IconChevronRightOutline14 />
    </button>
  ) : null
  if (failed) {
    return (
      <div className={styles.content}>
        <div role="alert" className={styles.empty}>
          {t('usageLoadError')}{' '}
          <Button variant="outlined" onClick={() => setRetry((v) => v + 1)}>
            {t('retry')}
          </Button>
        </div>
        <div className={styles.emptyActions}>
          {modelLink}
          {pricingLink}
        </div>
      </div>
    )
  }
  if (loading) {
    return (
      <div className={styles.content}>
        <div className={styles.loading}>{t('sessionLoading')}</div>
      </div>
    )
  }
  if (!stats || stats.total.requests === 0) {
    return (
      <div className={styles.content}>
        <p className={styles.empty}>{t('usageEmpty')}</p>
        <div className={styles.emptyActions}>
          {modelLink}
          {pricingLink}
        </div>
      </div>
    )
  }

  const inputTokens = stats.total.cacheReadTokens + stats.total.cacheMissTokens
  const hitRate = formatCacheHitRate(totalCacheCounts(stats.total), locale)

  return (
    <div className={styles.content}>
      <div className={styles.hero}>
        <div className={styles.heroTop}>
          <span className={styles.heroLabel}>{t('usageTotalCost')}</span>
          {pricingLink}
        </div>
        <div className={styles.ledgerTotals}>
          <div className={styles.heroValue}>
            {stats.total.unpricedRequests === stats.total.requests
              ? '—'
              : formatCost(stats.total.costCny)}
          </div>
          <div className={styles.heroToday}>
            <span>{t('usageToday')}</span>
            <strong>
              {today?.requests && today.requests === today.unpricedRequests
                ? '—'
                : formatCost(today?.costCny ?? 0)}
            </strong>
          </div>
        </div>
        {stats.total.unpricedRequests > 0 ? (
          <p className={styles.sectionHint}>
            {t('usagePartialCost', { count: stats.total.unpricedRequests })}
          </p>
        ) : null}
        <div className={styles.heroMeta}>
          <span>
            {t('usageRequests')} {formatTokens(stats.total.requests)}
          </span>

          <span className={styles.heroDot} />
          <span>
            {t('usageWebSearches')} {formatTokens(stats.total.webSearches)}
          </span>
        </div>
      </div>

      {/* 两项明细 */}
      <div className={styles.tiles}>
        <div className={styles.tile}>
          <div className={styles.tileLabel}>{t('usageInputTokens')}</div>
          <div className={styles.tileValue}>{compactTokens(inputTokens)}</div>
          <div className={styles.tileRate} title={t('usageCacheRateHelp')}>
            {t('usageCacheHitRate')} <strong>{hitRate}</strong>
          </div>
          <div className={styles.tileSub}>
            {t('usageCacheHit')} {compactTokens(stats.total.cacheReadTokens)} ·{' '}
            {t('usageCacheMiss')} {compactTokens(stats.total.cacheMissTokens)}
          </div>
        </div>
        <div className={styles.tile}>
          <div className={styles.tileLabel}>{t('usageOutputTokens')}</div>
          <div className={styles.tileValue}>{compactTokens(stats.total.outputTokens)}</div>
          <div className={styles.tileSub}>
            {t('usageToday')} {formatTokens(today?.requests ?? 0)} {t('usageRequests')}
          </div>
        </div>
      </div>

      {/* 近 14 天柱状图 */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('usageLast14Days')}</span>
          <span className={styles.sectionHint}>
            {t('usageToday')} {formatCost(today?.costCny ?? 0)}
          </span>
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
                style={{ height: `${Math.max(3, (day.costCny / maxCost) * 100)}%` }}
              />
              <div className={styles.chartLabel}>{day.date.slice(8)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 会话排行 */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('usageBySession')}</span>
          {modelLink}
        </div>
        <div className={styles.sessionList}>
          {stats.sessions.slice(0, 5).map((item, index) => (
            <div key={item.id} className={styles.sessionRow}>
              <span className={styles.rank}>{index + 1}</span>
              <span className={styles.sessionTitle}>{item.title || t('untitledChat')}</span>
              <span className={styles.sessionMeta}>
                {compactTokens(item.cacheReadTokens + item.cacheMissTokens + item.outputTokens)} tok
                <span className={styles.sessionCost}>
                  {item.unpricedRequests === item.requests ? '—' : formatCost(item.costCny)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 抽屉里的用量弹窗：价格设置跳到设置页的二级页面，不在弹窗里堆表单 */
export const UsagePanel = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal title={t('usageTitle')} onClose={onClose} className={styles.dialog}>
      <UsageContent
        onOpenModels={() => {
          onClose()
          openSettings('usageModels')
        }}
        onOpenPricing={() => {
          onClose()
          openSettings('usagePricing')
        }}
      />
    </Modal>
  )
}
