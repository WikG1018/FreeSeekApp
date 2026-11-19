import { type TranslationKey, useTranslate } from '../../i18n/index.js'
import type { ReasoningControl, ReasoningLevel } from '../../services/reasoning.js'
import { IconCheckOutline16 } from './icons.js'
import styles from './OptionPanel.module.css'

export const reasoningLabels: Record<ReasoningLevel, TranslationKey> = {
  off: 'reasoningLevelOff',
  on: 'reasoningLevelOn',
  minimal: 'reasoningLevelMinimal',
  low: 'reasoningLevelLow',
  medium: 'reasoningLevelMedium',
  high: 'reasoningLevelHigh',
  xhigh: 'reasoningLevelXhigh',
  max: 'reasoningLevelMax',
}

export const ReasoningOptions = ({
  title,
  control,
  level,
  choose,
  showDefault = false,
}: {
  title: string
  control: ReasoningControl
  level: ReasoningLevel
  choose: (level: ReasoningLevel) => void
  showDefault?: boolean
}) => {
  const t = useTranslate()
  return (
    <>
      <div className={styles.reasoningHeading}>{title}</div>
      <div className={styles.list} role="listbox" aria-label={title}>
        {control.levels.map((value) => (
          <button
            key={value}
            type="button"
            role="option"
            data-panel-item=""
            aria-selected={value === level}
            className={styles.option}
            onClick={() => choose(value)}
          >
            <span className={styles.copy}>{t(reasoningLabels[value])}</span>
            {showDefault && value === control.defaultLevel && (
              <span className={styles.reasoningDefault}>{t('reasoningDefaultMark')}</span>
            )}
            {value === level && <IconCheckOutline16 />}
          </button>
        ))}
      </div>
    </>
  )
}
