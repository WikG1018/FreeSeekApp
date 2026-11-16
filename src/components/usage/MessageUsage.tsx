import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { computeMessageUsage } from '../../services/usage.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { IconChevronDownOutline14, IconDataOutline16 } from '../base/icons.js'
import styles from './MessageUsage.module.css'

const formatNumber = (value: number) => value.toLocaleString()

const formatCost = (value: number) =>
  value === 0 ? '—' : value >= 0.01 ? `¥${value.toFixed(3)}` : `¥${value.toFixed(4)}`

/** 单条回复的 token 用量与费用：默认一行摘要，展开看输入/缓存/输出明细 */
export const MessageUsage = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  if (!message.usage) {
    return null
  }
  const detail = computeMessageUsage(message.usage, message.createdAt)
  const input = detail.input + detail.cacheRead + detail.cacheWrite
  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.icon}>
          <IconDataOutline16 />
        </span>
        <span className={styles.summaryText}>
          {t('usageMessageInline', {
            input: formatNumber(input),
            output: formatNumber(detail.output),
            cost: formatCost(detail.costCny),
          })}
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
              <span className={styles.cellValue}>{formatCost(detail.costCny)}</span>
            </div>
          </div>
          <div className={styles.meta}>
            {message.model ?? 'deepseek-flash'}
            {detail.searches > 0
              ? ` · ${t('usageWebSearches')} ${detail.searches}`
              : ''}
            {' · '}
            {new Date(message.createdAt).toLocaleString()}
          </div>
        </div>
      ) : null}
    </div>
  )
}
