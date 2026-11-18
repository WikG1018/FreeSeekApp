import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'
import { useTransientPanel } from './transientPanel.js'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  const returnFocus = () => {
    close()
    anchorRef.current?.querySelector('button')?.focus({ preventScroll: true })
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true, onEscape: returnFocus })
  useTransientPanel(open, (restore) => (restore ? returnFocus() : close()))
  useEffect(() => {
    if (open) {
      floatingRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true })
    }
  }, [open, floatingRef])

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  returnFocus()
                  return
                }
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
                )
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                const offsets: Record<string, number> = {
                  ArrowDown: (index + 1) % items.length,
                  ArrowUp: (index + items.length - 1) % items.length,
                  Home: 0,
                  End: items.length - 1,
                }
                if (event.key in offsets) {
                  event.preventDefault()
                  items[offsets[event.key]]?.focus()
                }
                if (event.key === 'Tab') {
                  returnFocus()
                }
              }}
            >
              {options.map((option) => (
                <button
                  type="button"
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    setOpen(false)
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
