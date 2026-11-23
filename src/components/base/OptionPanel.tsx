import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type Align, type Side } from './anchored.js'
import { useTransientPanel } from './transientPanel.js'
import styles from './OptionPanel.module.css'

type Options = {
  side?: Side
  align?: Align
  kind?:
    | 'choices'
    | 'compact-choices'
    | 'fit-choices'
    | 'actions'
    | 'field'
    | 'details'
    | 'reasoning'
    | 'chat-mode'
    | 'progress'
    | 'artifacts'
  measureKey?: unknown
  editorRef?: RefObject<HTMLTextAreaElement>
  disabled?: boolean
  sourceRef?: MutableRefObject<HTMLButtonElement | null>
  initiallyOpen?: boolean
  onClose?: () => void
  focusFirst?: boolean
}
/** 控件旁的轻量面板。尺寸随内容，长列表在安全区内滚动。 */
export const useOptionPanel = (
  label: string,
  {
    side = 'bottom',
    align = 'start',
    kind = 'choices',
    measureKey,
    editorRef,
    disabled = false,
    sourceRef,
    initiallyOpen = false,
    onClose,
    focusFirst = true,
  }: Options = {}
) => {
  const [expanded, setOpen] = useState(initiallyOpen)
  const exiting = useRef<HTMLElement>()
  const open = expanded && !disabled
  const editing = useRef(false)
  useLayoutEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])
  const id = useId()
  const maxHeight = kind === 'actions' ? 226 : kind === 'progress' ? 308 : 354
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(
    open,
    {
      side,
      align,
      alignOffset: kind === 'details' ? 12 : 0,
      offset: kind === 'reasoning' ? 10 : 7,
      maxHeight,
      matchAnchorWidth: kind === 'field',
      pointToAnchor:
        kind === 'reasoning' ? (align === 'end' ? 'end' : 'center') : kind === 'details',
      minSpace: kind === 'reasoning' ? maxHeight : 132,
      measureKey,
    },
    sourceRef
  )
  const close = (restoreFocus = false) => {
    exiting.current?.remove()
    const element = floatingRef.current
    if (open && position && element && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Retire the visible surface, then unmount its live inputs and selection state at once.
      const snapshot = element.cloneNode(true)
      if (snapshot instanceof HTMLElement) {
        snapshot.removeAttribute('id')
        snapshot.removeAttribute('role')
        snapshot.removeAttribute('data-testid')
        snapshot.removeAttribute('aria-label')
        snapshot.removeAttribute('aria-labelledby')
        snapshot.setAttribute('aria-hidden', 'true')
        snapshot.setAttribute('inert', '')
        snapshot.dataset.closing = ''
        const style = getComputedStyle(element)
        snapshot.style.setProperty('--fs-panel-exit-transform', style.transform)
        snapshot.style.setProperty('--fs-panel-exit-opacity', style.opacity)
        for (const node of snapshot.querySelectorAll<HTMLElement>(
          '[id],[data-testid],[aria-label],[aria-labelledby],button,input,select,textarea,a,[tabindex]'
        )) {
          node.removeAttribute('id')
          node.removeAttribute('data-testid')
          node.removeAttribute('aria-label')
          node.removeAttribute('aria-labelledby')
          node.tabIndex = -1
        }
        document.body.appendChild(snapshot)
        exiting.current = snapshot
        window.setTimeout(() => snapshot.remove(), 135)
      }
    }
    setOpen(false)
    if (restoreFocus) {
      const target = editing.current && editorRef?.current ? editorRef.current : anchorRef.current
      target?.focus({ preventScroll: true })
    }
    onClose?.()
  }
  const show = () => {
    exiting.current?.remove()
    exiting.current = undefined
    setOpen(true)
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
    if (!focusFirst) {
      if (!editing.current) {
        el?.focus({ preventScroll: true })
      }
      return
    }
    const input = el?.querySelector<HTMLElement>('[data-panel-input]')
    const item =
      input ??
      el?.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ??
      el?.querySelector<HTMLElement>('[data-panel-item]:not(:disabled)')
    if (!editing.current) {
      ;(item ?? el)?.focus({ preventScroll: true })
    }
    if (!input) {
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, positioned, floatingRef, focusFirst])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = event.currentTarget
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-panel-item]:not(:disabled)')
    )
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (items.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (document.activeElement?.hasAttribute('data-panel-input')) {
        return
      }
      if (
        document.activeElement?.matches('textarea, [contenteditable]') ||
        (document.activeElement?.tagName === 'INPUT' && ['Home', 'End'].includes(event.key))
      ) {
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
          'button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),textarea:not(:disabled),summary,a[href]'
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
            data-scroll-edge=""
            data-pointer={position?.['--fs-panel-anchor-x'] ? '' : undefined}
            data-pointer-side={position?.['--fs-panel-pointer-edge']}
            data-testid="option-panel"
            onKeyDown={keyDown}
            onPointerDown={(event) => {
              if (
                editing.current &&
                document.activeElement === editorRef?.current &&
                (event.target as Element).closest('button')
              ) {
                event.preventDefault()
              }
            }}
            style={position ?? { opacity: 0, pointerEvents: 'none' }}
          >
            {children}
          </div>,
          document.body
        )
      : null
  return {
    open,
    positioned,
    show,
    close,
    anchorRef,
    render,
    trigger: {
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-haspopup': 'dialog' as const,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (
          event.button === 0 &&
          editorRef?.current &&
          document.activeElement === editorRef.current
        ) {
          event.preventDefault()
        }
      },
      onClick: () => {
        if (open) {
          close()
        } else {
          editing.current = Boolean(
            editorRef?.current && document.activeElement === editorRef.current
          )
          // Long model lists need the space of a landscape IME. Attachment actions fit beside each other.
          if (
            kind === 'choices' &&
            editing.current &&
            anchorRef.current?.closest('[data-ime-compact]') &&
            anchorRef.current.getBoundingClientRect().top < 150
          ) {
            editorRef?.current?.blur()
          }
          show()
        }
      },
    },
  }
}
