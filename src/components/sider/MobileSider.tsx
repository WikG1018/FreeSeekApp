import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { hasTransientPanel } from '../base/transientPanel.js'
import { hasOpenModal } from '../base/Modal.js'
import { hasSettingsOpen } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { Sider } from './Sider.js'
import styles from './Sider.module.css'

/** 关闭后保留正在查看的搜索结果，返回侧边栏时可以继续浏览。 */
export const MobileSider = ({
  donationOpen,
  onDonate,
}: {
  donationOpen: boolean
  onDonate: () => void
}) => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  const dragging = useMobileSider((state) => state.dragging)
  const [mounted, setMounted] = useState(false)
  const [retainSearch, setRetainSearch] = useState(false)
  const drawer = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (open || dragging) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(timer)
  }, [open, dragging])
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = drawer.current
    element?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        hasSettingsOpen() ||
        hasOpenModal() ||
        hasTransientPanel()
      ) {
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
      const focused = document.activeElement
      if (focused instanceof HTMLElement && element?.contains(focused)) {
        focused.blur()
      }
      if (!hasSettingsOpen() && !hasOpenModal()) {
        // 触摸打开抽屉时，原焦点可能仍在聊天输入框。回到抽屉按钮，避免键盘重新弹出。
        const trigger =
          previous?.isConnected &&
          previous.matches('button, a[href]') &&
          !element?.contains(previous)
            ? previous
            : document.querySelector<HTMLElement>('[aria-controls="mobile-sider"]')
        trigger?.focus({ preventScroll: true })
      }
    }
  }, [open])
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
        {(mounted || retainSearch) && (
          <Sider mobile donationOpen={donationOpen} onDonate={onDonate} onSearchActive={setRetainSearch} />
        )}
      </div>
    </>
  )
}
