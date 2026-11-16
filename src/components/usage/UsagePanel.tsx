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

/** 统计内容：设置页与抽屉弹窗共用；价格编辑统一收进「价格设置」二级页 */
export const UsageContent = ({ onOpenPricing }: { onOpenPricing?: () => void }) => {
  const t = useTranslate()
  const pricing = usePricing((state) => state.pricing)
  const [stats, setStats] = useState<UsageStats | null>(null)
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
  return (
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

      <div className={styles.sectionTitle}>{t('usageBySession')}</div>
      <div className={styles.sessionList}>
        {stats.sessions.slice(0, 5).map((item) => (
          <div key={item.id} className={styles.sessionRow}>
            <span className={styles.sessionTitle}>{item.title || t('untitledChat')}</span>
            <span className={styles.sessionMeta}>
              {formatTokens(item.cacheReadTokens + item.cacheMissTokens + item.outputTokens)} tok ·{' '}
              {formatCost(item.costCny)}
            </span>
          </div>
        ))}
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
