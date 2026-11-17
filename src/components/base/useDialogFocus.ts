import { useEffect, useRef, type RefObject } from 'react'

const SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 全屏设置的焦点进入、Tab 循环和关闭后的焦点恢复。 */
export const useDialogFocus = (ref: RefObject<HTMLElement>, isTop: () => boolean = () => true) => {
  const isTopRef = useRef(isTop)
  isTopRef.current = isTop
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = ref.current
    if (!root) {
      return
    }
    const focusables = () =>
      [...root.querySelectorAll<HTMLElement>(SELECTOR)].filter(
        (element) => element.getClientRects().length > 0
      )
    ;(root.querySelector<HTMLElement>('[data-dialog-initial]') ?? focusables()[0] ?? root).focus({
      preventScroll: true,
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopRef.current()) {
        return
      }
      const items = focusables()
      const first = items[0],
        last = items.at(-1)
      const active = document.activeElement
      if (!first || !last) {
        event.preventDefault()
        root.focus()
        return
      }
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.setTimeout(() => {
        if (previous?.isConnected) {
          previous.focus({ preventScroll: true })
        }
      }, 0)
    }
  }, [ref])
}
