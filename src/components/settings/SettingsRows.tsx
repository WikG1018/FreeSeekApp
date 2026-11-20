import clsx from 'clsx'
import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import styles from './Settings.module.css'

export const Section = ({
  title,
  action,
  children,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
}) => (
  <section className={styles.section}>
    {title &&
      (action ? (
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {action}
        </div>
      ) : (
        <h2 className={styles.sectionTitle}>{title}</h2>
      ))}
    <div className={styles.card}>{children}</div>
  </section>
)

export const TutorialSteps = ({ steps }: { steps: readonly TranslationKey[] }) => {
  const t = useTranslate()
  return (
    <ol className={styles.tutorialSteps}>
      {steps.map((step, index) => (
        <li className={styles.tutorialStep} key={step}>
          <span className={styles.tutorialBadge} aria-hidden>
            {index + 1}
          </span>
          <span>{t(step)}</span>
        </li>
      ))}
    </ol>
  )
}

type RowProps = {
  label: string
  icon?: ReactNode
  value?: string
  description?: string
  detail?: string
  badge?: string
  prominent?: boolean
  className?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  onLongPress?: () => void
  target?: string
  current?: boolean
}

const useRowLongPress = (onLongPress?: () => void) => {
  const gesture = useRef<{ id: number; x: number; y: number; timer: number }>()
  const handled = useRef(false)
  useEffect(() => () => window.clearTimeout(gesture.current?.timer), [])
  const cancel = () => {
    window.clearTimeout(gesture.current?.timer)
    gesture.current = undefined
  }
  const open = () => {
    cancel()
    if (!handled.current) {
      handled.current = true
      onLongPress?.()
    }
  }
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    cancel()
    handled.current = !event.isPrimary
    if (event.button !== 0 || handled.current) {
      return
    }
    if (event.pointerType === 'touch') {
      // A compatibility mousedown after the hold would land on the new dialog's backdrop.
      event.preventDefault()
    }
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(open, 500),
    }
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const press = gesture.current
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8
    ) {
      handled.current = true
      cancel()
    }
  }
  const consume = () => {
    const consumed = handled.current
    handled.current = false
    return consumed
  }
  return { start, move, cancel, open, consume }
}

export const Row = ({
  label,
  icon,
  value,
  description,
  detail,
  badge,
  prominent,
  className,
  danger,
  disabled,
  onClick,
  onLongPress,
  target,
  current,
}: RowProps) => {
  const descriptionId = useId()
  const detailId = useId()
  const press = useRowLongPress(onLongPress)
  const body = (
    <>
      {icon && (
        <span className={styles.rowIcon} aria-hidden>
          {icon}
        </span>
      )}
      <span className={styles.rowCopy}>
        {badge ? (
          <span className={styles.rowHeadline}>
            <span className={clsx(styles.rowLabel, prominent && styles.rowStrong)}>{label}</span>
            <span className={styles.rowBadge}>{badge}</span>
          </span>
        ) : (
          <span
            className={clsx(
              styles.rowLabel,
              danger && styles.rowDanger,
              prominent && styles.rowStrong
            )}
          >
            {label}
          </span>
        )}
        {description && (
          <span className={styles.rowDescription} id={descriptionId}>
            {description}
          </span>
        )}
        {detail && (
          <span className={styles.rowDescription} id={detailId}>
            {detail}
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
      className={clsx(styles.row, styles.rowInteractive, className)}
      disabled={disabled}
      aria-label={description || detail || badge ? label : undefined}
      aria-describedby={
        [description && descriptionId, detail && detailId].filter(Boolean).join(' ') || undefined
      }
      data-settings-target={target}
      aria-current={current ? 'page' : undefined}
      onPointerDown={onLongPress ? press.start : undefined}
      onPointerMove={onLongPress ? press.move : undefined}
      onPointerUp={onLongPress ? press.cancel : undefined}
      onPointerCancel={onLongPress ? press.cancel : undefined}
      onPointerLeave={onLongPress ? press.cancel : undefined}
      onContextMenu={
        onLongPress
          ? (event) => {
              event.preventDefault()
              press.open()
            }
          : undefined
      }
      onClick={
        onLongPress
          ? (event) => {
              if (!press.consume() || event.detail === 0) {
                onClick()
              }
            }
          : onClick
      }
    >
      {body}
    </button>
  ) : (
    <div className={clsx(styles.row, className)}>{body}</div>
  )
}

export const SwitchRow = ({
  label,
  checked,
  change,
  description,
}: {
  label: string
  checked: boolean
  change: (enabled: boolean) => void
  description?: string
}) => {
  const descriptionId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={description ? label : undefined}
      aria-describedby={description ? descriptionId : undefined}
      className={clsx(styles.row, styles.rowInteractive, styles.usageToggle)}
      onClick={() => change(!checked)}
    >
      {description ? (
        <span className={styles.rowCopy}>
          <span className={styles.rowStrong}>{label}</span>
          <span className={styles.rowDescription} id={descriptionId}>
            {description}
          </span>
        </span>
      ) : (
        <span className={styles.rowLabel}>{label}</span>
      )}
      <span className={styles.toggleTrack} aria-hidden>
        <span className={styles.toggleThumb} />
      </span>
    </button>
  )
}
