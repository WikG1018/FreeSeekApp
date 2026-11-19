import clsx from 'clsx'
import { useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconSearchOutline16,
} from './icons.js'
import { useOptionPanel } from './OptionPanel.js'
import panelStyles from './OptionPanel.module.css'
import styles from './Select.module.css'

export type SelectOption<T extends string> = {
  value: T
  label: string
  shortLabel?: string
  detail?: string
  lang?: string
}

export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  prefix,
  pill = false,
  settingRow,
  disabled = false,
  footer,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel: string
  prefix?: string
  pill?: boolean
  settingRow?: 'value' | 'detail'
  disabled?: boolean
  footer?: { label: string; onSelect: () => void }
}) => {
  const t = useTranslate()
  const valueId = useId()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(48)
  const panel = useOptionPanel(ariaLabel, {
    measureKey: query,
    kind: pill || settingRow ? 'choices' : 'field',
    align: settingRow ? 'end' : 'start',
    disabled,
  })
  const current = options.find((item) => item.value === value)
  const displayValue = current?.shortLabel ?? current?.label ?? placeholder
  const filterable = options.length > 8
  const needle = query.trim().toLocaleLowerCase()
  const filtered =
    panel.open && filterable && needle
      ? options.filter((item) => item.label.toLocaleLowerCase().includes(needle))
      : options
  const visible = panel.open ? filtered.slice(0, limit) : []
  if (!needle && current && visible.length && !visible.includes(current)) {
    visible.unshift(current)
  }
  const toggle = () => {
    setQuery('')
    setLimit(48)
    panel.trigger.onClick()
  }
  return (
    <>
      <button
        ref={panel.anchorRef}
        type="button"
        className={clsx(styles.trigger, pill && styles.pill, settingRow && styles.settingRow)}
        disabled={disabled}
        aria-label={prefix ? undefined : ariaLabel}
        aria-describedby={prefix ? undefined : valueId}
        data-setting-row={settingRow ? '' : undefined}
        {...panel.trigger}
        onClick={toggle}
        onKeyDown={(e) => {
          if (!panel.open && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {prefix && <small>{prefix}</small>}
        {settingRow && (
          <span className={styles.settingCopy}>
            <strong>{ariaLabel}</strong>
            {settingRow === 'detail' && <small id={valueId}>{displayValue}</small>}
          </span>
        )}
        {settingRow !== 'detail' && (
          <span
            id={valueId}
            className={settingRow ? styles.settingValue : undefined}
            lang={current?.lang}
          >
            {displayValue}
          </span>
        )}
        {settingRow ? (
          <IconChevronRightOutline14 />
        ) : pill ? (
          <IconChevronDownOutline14 />
        ) : (
          <span className={styles.indicator} aria-hidden>
            <IconChevronDownOutline14 />
          </span>
        )}
      </button>
      {panel.render(
        <>
          {filterable && (
            <label className={panelStyles.filter}>
              <IconSearchOutline16 />
              <input
                type="search"
                aria-label={t('optionFilter')}
                placeholder={t('optionFilter')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setLimit(48)
                }}
              />
            </label>
          )}
          <div className={panelStyles.list} role="listbox" aria-label={ariaLabel}>
            {visible.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                data-panel-item=""
                aria-selected={option.value === value}
                lang={option.lang}
                className={panelStyles.option}
                onClick={() => {
                  onChange(option.value)
                  panel.close(true)
                }}
              >
                <span className={panelStyles.copy}>
                  <span>{option.label}</span>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                {option.value === value && <IconCheckOutline16 />}
              </button>
            ))}
          </div>
          {filtered.length > limit && (
            <button
              type="button"
              data-panel-item=""
              className={panelStyles.manage}
              onClick={() => setLimit((value) => value + 48)}
            >
              {t('optionMore')}
            </button>
          )}
          {filtered.length === 0 && (
            <p role="status" className={panelStyles.empty}>
              {t('optionNoResults')}
            </p>
          )}
          {footer && (
            <button
              className={panelStyles.manage}
              type="button"
              onClick={() => {
                panel.close(true)
                footer.onSelect()
              }}
            >
              {footer.label}
              <IconChevronRightOutline14 />
            </button>
          )}
        </>
      )}
    </>
  )
}
