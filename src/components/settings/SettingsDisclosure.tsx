import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '../base/icons.js'
import styles from './SettingsDisclosure.module.css'

/** A compact in-page disclosure; its controls retain drafts and are disabled while collapsed. */
export const SettingsDisclosure = ({
  title,
  icon,
  open,
  defaultOpen = false,
  onToggle,
  guide = false,
  testId,
  children,
}: {
  title: string
  icon: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onToggle?: () => void
  guide?: boolean
  testId?: string
  children: ReactNode
}) => {
  const [local, setLocal] = useState(defaultOpen)
  const expanded = open ?? local
  const id = useId()
  const shelf = useRef<HTMLDivElement>(null)
  const animation = useRef<Animation | null>(null)
  const previous = useRef(expanded)
  useLayoutEffect(() => {
    const element = shelf.current
    if (!element) {
      return
    }
    const start = element.getBoundingClientRect().height
    animation.current?.cancel()
    animation.current = null
    const changed = previous.current !== expanded
    previous.current = expanded
    element.hidden = !expanded
    if (!changed || !element.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    element.hidden = false
    const end = expanded ? element.scrollHeight : 0
    const effect = element.animate([{ height: start + 'px' }, { height: end + 'px' }], {
      duration: expanded ? 180 : 145,
      easing: 'cubic-bezier(.2,.72,.25,1)',
      fill: 'both',
    })
    animation.current = effect
    effect.onfinish = () => {
      if (animation.current === effect) {
        element.hidden = !expanded
        animation.current = null
        effect.cancel()
      }
    }
  }, [expanded])
  useEffect(() => () => animation.current?.cancel(), [])
  return (
    <section
      data-testid={testId}
      className={styles.disclosure}
      data-guide={guide}
      data-open={expanded}
    >
      <h2>
        <button
          type="button"
          className={styles.trigger}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => (onToggle ? onToggle() : setLocal((v) => !v))}
        >
          <span aria-hidden="true" className={styles.symbol}>
            {icon}
          </span>
          <span>{title}</span>
          <span className={styles.arrow} aria-hidden="true">
            <IconChevronDownOutline14 />
          </span>
        </button>
      </h2>
      <div id={id} ref={shelf} className={styles.shelf} aria-hidden={!expanded}>
        <fieldset className={styles.body} disabled={!expanded}>
          {children}
        </fieldset>
      </div>
    </section>
  )
}
