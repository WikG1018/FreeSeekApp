import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { hasOpenModal } from '../base/Modal.js'
import { hasSettingsOpen } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { Sider } from './Sider.js'
import styles from './Sider.module.css'

/** 外壳保持挂载以便动画可中断；关闭后释放列表和弹窗状态。 */
export const MobileSider = () => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  const dragging = useMobileSider((state) => state.dragging)
  const [mounted, setMounted] = useState(false)
  const drawer = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (open || dragging) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(timer)
  }, [open, dragging])
  useEffect(() => {
    if (!open || !mounted) {
      return
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = drawer.current
    element?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (hasSettingsOpen() || hasOpenModal() || document.querySelector('[role="menu"]')) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileSider()
      }
      if (event.key === 'Tab') {
        const items = [
          ...(drawer.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,[tabindex="0"]'
          ) ?? []),
        ].filter((node) => node.offsetParent !== null)
        const first = items[0],
          last = items.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !drawer.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !drawer.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      if (!hasSettingsOpen() && !hasOpenModal()) {
        if (previous?.isConnected && !element?.contains(previous)) {
          previous.focus({ preventScroll: true })
        } else {
          document
            .querySelector<HTMLElement>('[aria-controls="mobile-sider"]')
            ?.focus({ preventScroll: true })
        }
      }
    }
  }, [open, mounted])
  return (
    <>
      <div
        className={styles.drawerMask}
        onClick={closeMobileSider}
        aria-hidden="true"
        data-testid="sider-mask"
      />
      <div
        ref={drawer}
        id="mobile-sider"
        className={styles.drawer}
        data-testid="mobile-sider"
        role="dialog"
        tabIndex={-1}
        aria-modal={open || undefined}
        aria-label={t('sidebarTitle')}
        aria-hidden={!open}
      >
        {mounted && <Sider mobile />}
      </div>
    </>
  )
}
