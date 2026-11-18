import { useId, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type Align, type Side } from './anchored.js'
import { useTransientPanel } from './transientPanel.js'
import styles from './OptionPanel.module.css'

type Options = { side?: Side; align?: Align; kind?: 'choices' | 'actions'; measureKey?: unknown }
/** 控件旁的轻量面板。尺寸随内容，长列表在安全区内滚动。 */
export const useOptionPanel = (
  label: string,
  { side = 'bottom', align = 'start', kind = 'choices', measureKey }: Options = {}
) => {
  const [open, setOpen] = useState(false)
  const id = useId()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side,
    align,
    offset: 7,
    maxHeight: kind === 'choices' ? 354 : 226,
    minSpace: 132,
    measureKey,
  })
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) {
      anchorRef.current?.focus({ preventScroll: true })
    }
  }
  useTransientPanel(open, close)
  useDismiss(open, [anchorRef, floatingRef], () => close(), {
    captureEscape: true,
    onEscape: () => close(true),
  })
  const positioned = position !== null
  useLayoutEffect(() => {
    if (!open || !positioned) {
      return
    }
    const el = floatingRef.current
    const item =
      el?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      el?.querySelector<HTMLElement>('[data-panel-item]')
    ;(item ?? el)?.focus({ preventScroll: true })
    item?.scrollIntoView({ block: 'nearest' })
  }, [open, positioned, floatingRef])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = event.currentTarget
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-panel-item]:not(:disabled)')
    )
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (items.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (document.activeElement?.tagName === 'INPUT' && ['Home', 'End'].includes(event.key)) {
        return
      }
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (current + 1) % items.length
              : current < 0
                ? items.length - 1
                : (current + items.length - 1) % items.length
      event.preventDefault()
      items[next].focus()
      return
    }
    if (event.key === 'Tab') {
      const all = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]),input:not(:disabled)'
        )
      )
      if (
        !all.length ||
        (!event.shiftKey && document.activeElement === all.at(-1)) ||
        (event.shiftKey && document.activeElement === all[0])
      ) {
        close(true)
      }
    }
  }
  const render = (children: ReactNode) =>
    open
      ? createPortal(
          <div
            ref={floatingRef}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={styles.panel}
            data-kind={kind}
            data-testid="option-panel"
            onKeyDown={keyDown}
            style={position ?? { visibility: 'hidden' }}
          >
            {children}
          </div>,
          document.body
        )
      : null
  return {
    open,
    close,
    anchorRef,
    render,
    trigger: {
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-haspopup': 'dialog' as const,
      onClick: () => setOpen((value) => !value),
    },
  }
}
