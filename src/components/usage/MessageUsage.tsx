import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { computeReplyUsage, usePricing } from '../../services/usage.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import styles from './MessageUsage.module.css'

const formatNumber = (value: number) => value.toLocaleString()

/** 收进工具栏的紧凑写法：一万以上用 k，避免一行放不下 */
const compactNumber = (value: number) =>
  value >= 10000 ? `${(value / 1000).toFixed(1)}k` : formatNumber(value)

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 0.01 ? `¥${value.toFixed(3)}` : `¥${value.toFixed(4)}`

/**
 * 单条回复的 token 用量与费用：与引用、操作按钮同处一行。
 * 摘要只留「总量 + 费用」，输入/缓存/输出的拆分放在展开后的明细里。
 */
export const MessageUsage = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const pricing = usePricing((state) => state.pricing)
  const [expanded, setExpanded] = useState(false)
  const showUsage = useSettings((state) => state.showUsage)
  if (!showUsage || !message.usage) {
    return null
  }
  const detail = computeReplyUsage(message, pricing)
  const input = detail.input + detail.cacheRead + detail.cacheWrite
  const total = input + detail.output
  const cost = formatCost(detail.costCny)
  const full = t('usageMessageInline', {
    input: formatNumber(input),
    output: formatNumber(detail.output),
    cost,
  })
  return (
    <div className={styles.container}>
      <button
        type="button"
        className={clsx(styles.summary, expanded && styles.summaryOpen)}
        aria-expanded={expanded}
        title={full}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.summaryText}>
          {t('usageMessageCompact', { tokens: compactNumber(total), cost })}
        </span>
        <span className={clsx(styles.chevron, expanded && styles.chevronOpen)}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {expanded ? (
        <div className={styles.details}>
          <div className={styles.grid}>
            <div className={styles.cell}>
              <span className={styles.cellLabel}>{t('usageCacheHit')}</span>
              <span className={styles.cellValue}>{formatNumber(detail.cacheRead)}</span>
            </div>
            <div className={styles.cell}>
              <span className={styles.cellLabel}>{t('usageCacheMiss')}</span>
              <span className={styles.cellValue}>
                {formatNumber(detail.input + detail.cacheWrite)}
              </span>
            </div>
            <div className={styles.cell}>
              <span className={styles.cellLabel}>{t('usageOutputTokens')}</span>
              <span className={styles.cellValue}>{formatNumber(detail.output)}</span>
            </div>
            <div className={styles.cell}>
              <span className={styles.cellLabel}>{t('usageTotalCost')}</span>
              <span className={styles.cellValue}>{cost}</span>
            </div>
          </div>
          <div className={styles.meta}>
            {message.model ?? 'deepseek-flash'}
            {detail.searches > 0 ? ` · ${t('usageWebSearches')} ${detail.searches}` : ''}
            {' · '}
            {new Date(message.createdAt).toLocaleString()}
          </div>
        </div>
      ) : null}
    </div>
  )
}
