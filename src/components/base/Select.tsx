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
  disabled?: boolean
  footer?: { label: string; onSelect: () => void }
}) => {
  const t = useTranslate()
  const valueId = useId()
  const [query, setQuery] = useState('')
  const panel = useOptionPanel(ariaLabel, { measureKey: query })
  const current = options.find((item) => item.value === value)
  const filterable = options.length > 8
  const filtered =
    filterable && query.trim()
      ? options.filter((item) =>
          item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
        )
      : options
  return (
    <>
      <button
        ref={panel.anchorRef}
        type="button"
        className={clsx(styles.trigger, pill && styles.pill)}
        disabled={disabled}
        aria-label={prefix ? undefined : ariaLabel}
        aria-describedby={prefix ? undefined : valueId}
        {...panel.trigger}
        onClick={() => {
          setQuery('')
          panel.trigger.onClick()
        }}
      >
        {prefix && <small>{prefix}</small>}
        <span id={valueId} lang={current?.lang}>
          {current?.label ?? placeholder}
        </span>
        <IconChevronDownOutline14 />
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
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          <div className={panelStyles.list} role="listbox" aria-label={ariaLabel}>
            {filtered.map((option) => (
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
