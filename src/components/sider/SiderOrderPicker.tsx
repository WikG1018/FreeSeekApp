import { useId } from 'react'
import type { SiderOrder } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import panelStyles from '../base/OptionPanel.module.css'
import styles from './Sider.module.css'

export const SiderOrderPicker = ({
  order,
  onChange,
}: {
  order: SiderOrder
  onChange: (value: SiderOrder) => void
}) => {
  const t = useTranslate()
  const label = t('siderSortLabel')
  const valueId = useId()
  const panel = useOptionPanel(label, { align: 'end', kind: 'compact-choices' })
  const options = [
    { value: 'recent', label: t('siderSortRecent') },
    { value: 'type', label: t('siderSortType') },
  ] as const
  return (
    <>
      <button
        ref={panel.anchorRef}
        type="button"
        className={styles.sortButton}
        aria-label={label}
        aria-describedby={valueId}
        title={label}
        {...panel.trigger}
        onKeyDown={(event) => {
          if (!panel.open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            panel.trigger.onClick()
          }
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M3 4h10M3 8h7M3 12h4" />
        </svg>
        <span id={valueId}>{t(order === 'recent' ? 'siderSortRecent' : 'siderSortTypeShort')}</span>
        <span className={styles.sortChevron} aria-hidden>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {panel.render(
        <div role="listbox" aria-label={label} className={panelStyles.list}>
          {options.map((option) => (
            <button
              key={option.value}
              className={panelStyles.option}
              type="button"
              role="option"
              aria-selected={option.value === order}
              data-panel-item=""
              onClick={() => {
                onChange(option.value)
                panel.close(true)
              }}
            >
              <span className={panelStyles.copy}>{option.label}</span>
              {option.value === order && <IconCheckOutline16 />}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
