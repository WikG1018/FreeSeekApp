import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { DEFAULT_PRICING, setPricing, usePricing, type FlashPricing } from '../../services/usage.js'
import { showToast } from '../base/toastState.js'
import styles from './PricingForm.module.css'

type PriceKey = keyof FlashPricing

/** 单价行：左侧名称，右侧输入框 + 单位，失焦或回车即生效 */
const PriceRow = ({
  label,
  value,
  unit,
  onCommit,
}: {
  label: string
  value: number
  unit: string
  onCommit: (value: number) => void
}) => {
  const [draft, setDraft] = useState(String(value))
  // 外部改变价格（恢复默认、其他页面编辑）时同步输入框
  useEffect(() => setDraft(String(value)), [value])

  const commit = () => {
    const next = Number(draft)
    if (!draft.trim() || !Number.isFinite(next) || next < 0) {
      setDraft(String(value))
      return
    }
    if (next !== value) {
      onCommit(next)
    }
    setDraft(String(next))
  }

  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.control}>
        <input
          className={styles.input}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.01}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
        />
        <span className={styles.unit}>{unit}</span>
      </span>
    </label>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className={styles.group}>
    <div className={styles.groupTitle}>{title}</div>
    <div className={styles.card}>{children}</div>
  </section>
)

/**
 * 价格设置：独立页面（设置 → 用量 → 价格设置）。
 * 改一项即保存，不再堆一排「保存价格 / 恢复默认」按钮。
 */
export const PricingForm = () => {
  const t = useTranslate()
  const pricing = usePricing((state) => state.pricing)

  const update = (key: PriceKey, value: number) => {
    setPricing({ ...usePricing.getState().pricing, [key]: value })
    showToast({ key: 'usageSaved' })
  }

  const unit = t('usagePricingUnit')
  return (
    <>
      <Group title={t('usagePricingOffPeak')}>
        <PriceRow
          label={t('usagePricingHit')}
          unit={unit}
          value={pricing.offPeakHit}
          onCommit={(value) => update('offPeakHit', value)}
        />
        <PriceRow
          label={t('usagePricingMiss')}
          unit={unit}
          value={pricing.offPeakMiss}
          onCommit={(value) => update('offPeakMiss', value)}
        />
        <PriceRow
          label={t('usagePricingOut')}
          unit={unit}
          value={pricing.offPeakOut}
          onCommit={(value) => update('offPeakOut', value)}
        />
      </Group>
      <Group title={t('usagePricingPeak')}>
        <PriceRow
          label={t('usagePricingHit')}
          unit={unit}
          value={pricing.peakHit}
          onCommit={(value) => update('peakHit', value)}
        />
        <PriceRow
          label={t('usagePricingMiss')}
          unit={unit}
          value={pricing.peakMiss}
          onCommit={(value) => update('peakMiss', value)}
        />
        <PriceRow
          label={t('usagePricingOut')}
          unit={unit}
          value={pricing.peakOut}
          onCommit={(value) => update('peakOut', value)}
        />
      </Group>
      <Group title={t('usagePricingSearchSection')}>
        <p className={styles.policy}>{t('usagePricingSearchPolicy')}</p>
        <PriceRow
          label={t('usagePricingSearch')}
          unit={t('usagePricingSearchUnit')}
          value={pricing.searchPer1k}
          onCommit={(value) => update('searchPer1k', value)}
        />
      </Group>
      <button
        type="button"
        className={styles.reset}
        onClick={() => {
          setPricing(DEFAULT_PRICING)
          showToast({ key: 'usagePricingResetDone' })
        }}
      >
        {t('usagePricingReset')}
      </button>
      <div className={styles.hint}>{t('usagePricingHint')}</div>
    </>
  )
}
