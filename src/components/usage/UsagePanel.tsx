import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  collectUsage,
  isDefaultPricing,
  recentDays,
  todayKey,
  usePricing,
  type UsageStats,
} from '../../services/usage.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './UsagePanel.module.css'

const formatTokens = (value: number) => value.toLocaleString()

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 1 ? `¥${value.toFixed(2)}` : `¥${value.toFixed(4)}`

/** 紧凑金额：面板里的大数字用 */
const compactCost = (value: number) => formatCost(value)

/** 千分位紧凑：42,319 → 42.3k */
const compactTokens = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)

type Stats = UsageStats

/** 统计内容：设置页与抽屉弹窗共用；价格编辑统一收进「价格设置」二级页 */
export const UsageContent = ({ onOpenPricing }: { onOpenPricing?: () => void }) => {
  const t = useTranslate()
  const pricing = usePricing((state) => state.pricing)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

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

  if (loading) {
    return <div className={styles.loading}>{t('sessionLoading')}</div>
  }
  if (!stats || stats.total.requests === 0) {
    return <div className={styles.empty}>{t('usageEmpty')}</div>
  }

  const inputTokens = stats.total.cacheReadTokens + stats.total.cacheMissTokens
  const hitRate = inputTokens > 0 ? Math.round((stats.total.cacheReadTokens / inputTokens) * 100) : 0

  return (
    <div className={styles.content}>
      {/* 主数字：总花费 + 今天 */}
      <div className={styles.hero}>
        <div className={styles.heroTop}>
          <span className={styles.heroLabel}>{t('usageTotalCost')}</span>
          <span className={styles.heroToday}>
            {t('usageToday')} {compactCost(today?.costCny ?? 0)}
          </span>
        </div>
        <div className={styles.heroValue}>{stats.total.unpricedRequests === stats.total.requests ? '—' : compactCost(stats.total.costCny)}</div>
        {stats.total.unpricedRequests > 0 ? <p className={styles.sectionHint}>{t('usagePartialCost', { count: stats.total.unpricedRequests })}</p> : null}
        <div className={styles.heroMeta}>
          <span>{t('usageRequests')} {formatTokens(stats.total.requests)}</span>
          <span className={styles.heroDot} />
          <span>{t('usageCacheHit')} {hitRate}%</span>
          <span className={styles.heroDot} />
          <span>{t('usageWebSearches')} {formatTokens(stats.total.webSearches)}</span>
        </div>
      </div>

      {/* 两项明细 */}
      <div className={styles.tiles}>
        <div className={styles.tile}>
          <div className={styles.tileLabel}>{t('usageInputTokens')}</div>
          <div className={styles.tileValue}>{compactTokens(inputTokens)}</div>
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
        </div>
        <div className={styles.sessionList}>
          {stats.sessions.slice(0, 5).map((item, index) => (
            <div key={item.id} className={styles.sessionRow}>
              <span className={styles.rank}>{index + 1}</span>
              <span className={styles.sessionTitle}>{item.title || t('untitledChat')}</span>
              <span className={styles.sessionMeta}>
                {compactTokens(item.cacheReadTokens + item.cacheMissTokens + item.outputTokens)} tok
                <span className={styles.sessionCost}>{item.unpricedRequests === item.requests ? '—' : formatCost(item.costCny)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {onOpenPricing ? (
        <button type="button" className={styles.pricingRow} onClick={onOpenPricing}>
          <span className={styles.pricingRowLabel}>{t('usagePricingTitle')}</span>
          <span className={styles.pricingRowValue}>
            {isDefaultPricing(pricing) ? t('usagePricingDefault') : t('usagePricingCustom')}
          </span>
          <IconChevronRightOutline14 />
        </button>
      ) : null}
    </div>
  )
}

/** 抽屉里的用量弹窗：价格设置跳到设置页的二级页面，不在弹窗里堆表单 */
export const UsagePanel = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal title={t('usageTitle')} closable onClose={onClose} className={styles.dialog}>
      <UsageContent
        onOpenPricing={() => {
          onClose()
          openSettings('usagePricing')
        }}
      />
    </Modal>
  )
}
