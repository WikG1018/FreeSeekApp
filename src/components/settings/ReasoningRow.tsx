import { useTranslate } from '../../i18n/index.js'
import type { ReasoningControl, ReasoningLevel } from '../../services/reasoning.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { ReasoningOptions, reasoningLabels } from '../base/ReasoningOptions.js'
import styles from './ProviderSettings.module.css'

export const ReasoningRow = ({
  control,
  onChange,
  disabled,
}: {
  control: ReasoningControl
  onChange: (level: ReasoningLevel) => void
  disabled?: boolean
}) => {
  const t = useTranslate()
  const title = t('reasoningDefault')
  const panel = useOptionPanel(title, { kind: 'reasoning', align: 'end', disabled })
  return (
    <>
      <button
        type="button"
        ref={panel.anchorRef}
        className={styles.reasoningRow}
        aria-label={title}
        disabled={disabled}
        {...panel.trigger}
      >
        <span>{title}</span>
        <span>{t(reasoningLabels[control.defaultLevel])}</span>
        <IconChevronDownOutline14 />
      </button>
      {panel.render(
        <ReasoningOptions
          title={title}
          control={control}
          level={control.defaultLevel}
          choose={(level) => {
            onChange(level)
            panel.close(true)
          }}
        />
      )}
    </>
  )
}
