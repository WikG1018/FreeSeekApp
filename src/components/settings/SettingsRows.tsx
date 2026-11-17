import clsx from 'clsx'
import { useId, type ReactNode } from 'react'
import { IconChevronRightOutline14 } from '../base/icons.js'
import styles from './Settings.module.css'

export const Section = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section className={styles.section}>
    {title && <h2 className={styles.sectionTitle}>{title}</h2>}
    <div className={styles.card}>{children}</div>
  </section>
)

type RowProps = {
  label: string
  icon?: ReactNode
  value?: string
  description?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  target?: string
  current?: boolean
}

export const Row = ({
  label,
  icon,
  value,
  description,
  danger,
  disabled,
  onClick,
  target,
  current,
}: RowProps) => {
  const descriptionId = useId()
  const body = (
    <>
      {icon && (
        <span className={styles.rowIcon} aria-hidden>
          {icon}
        </span>
      )}
      <span className={styles.rowCopy}>
        <span className={clsx(styles.rowLabel, danger && styles.rowDanger)}>{label}</span>
        {description && (
          <span className={styles.rowDescription} id={descriptionId}>
            {description}
          </span>
        )}
      </span>
      {value && <span className={styles.rowValue}>{value}</span>}
      {target && onClick && (
        <span className={styles.rowChevron} aria-hidden>
          <IconChevronRightOutline14 />
        </span>
      )}
    </>
  )
  return onClick ? (
    <button
      type="button"
      className={clsx(styles.row, styles.rowInteractive)}
      disabled={disabled}
      aria-label={description ? label : undefined}
      aria-describedby={description ? descriptionId : undefined}
      data-settings-target={target}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={styles.row}>{body}</div>
  )
}

export const SwitchRow = ({
  label,
  checked,
  change,
}: {
  label: string
  checked: boolean
  change: (enabled: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={clsx(styles.row, styles.rowInteractive, styles.usageToggle)}
    onClick={() => change(!checked)}
  >
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.toggleTrack} aria-hidden>
      <span className={styles.toggleThumb} />
    </span>
  </button>
)
