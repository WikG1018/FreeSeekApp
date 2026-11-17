import clsx from 'clsx'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层，原生返回键同理 */
const openModals: { close: () => void }[] = []

/** 是否有弹窗打开（Android 返回键优先关闭弹窗） */
export const hasOpenModal = (): boolean => openModals.length > 0

/** 关闭最上层弹窗，返回是否有关闭操作 */
export const closeTopModal = (): boolean => {
  const top = openModals.at(-1)
  if (!top) {
    return false
  }
  top.close()
  return true
}

/** 退出动画时长：与 sheetOut/dialogOut 的 CSS 时长一致；reduced-motion 下动画瞬时完成 */
const EXIT_MS = 200

/**
 * 遮罩 + 居中卡片（移动端为底部 Sheet），Esc / 点遮罩关闭。
 * 关闭先播放退出动画再卸载：内部 closing 状态接管 Esc、遮罩、关闭按钮与返回键路径；
 * 父组件按条件直接卸载（如确认按钮）则瞬时消失，不影响功能。
 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  dismissible = true,
  centered = false,
  className,
  mainClassName,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  /** 阻止处理中的弹窗被遮罩、Esc 或系统返回键提前收起。 */
  dismissible?: boolean
  /** 居中弹窗：危险确认等场景在移动端也保持居中对话框，而不是底部 Sheet */
  centered?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const [closing, setClosing] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closingRef = useRef(false)

  /** 播放退出动画后真正卸载；重复调用只生效一次 */
  const requestCloseRef = useRef(() => {})
  requestCloseRef.current = () => {
    if (!dismissible || closingRef.current) {
      return
    }
    closingRef.current = true
    setClosing(true)
    window.setTimeout(() => onCloseRef.current(), EXIT_MS)
  }

  /** 打开前的焦点，关闭后还回去；键盘与读屏用户不会丢掉位置 */
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 焦点移进弹窗：优先第一个可交互元素，否则弹窗本身
    const focusFirst = () => {
      const root = contentRef.current
      if (!root) {
        return
      }
      const target = root.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      ;(target ?? root).focus({ preventScroll: true })
    }
    focusFirst()
    return () => {
      const previous = previousFocusRef.current
      previousFocusRef.current = null
      // 等卸载完成再还焦点，避免元素已被移除
      window.setTimeout(() => previous?.focus?.({ preventScroll: true }), 0)
    }
  }, [])

  useEffect(() => {
    const entry = { close: () => requestCloseRef.current() }
    openModals.push(entry)
    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals.at(-1) !== entry) {
        return
      }
      if (event.key === 'Escape') {
        requestCloseRef.current()
        return
      }
      // Tab 焦点陷阱：只在最上层弹窗内循环
      if (event.key === 'Tab') {
        const root = contentRef.current
        if (!root) {
          return
        }
        const focusables = [
          ...root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ),
        ].filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (focusables.length === 0) {
          event.preventDefault()
          root.focus({ preventScroll: true })
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (event.shiftKey && (active === first || !root.contains(active))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || !root.contains(active))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(entry), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const requestClose = () => requestCloseRef.current()

  return createPortal(
    <div
      className={clsx(
        styles.overlay,
        centered && styles.overlayCentered,
        closing && styles.overlayClosing
      )}
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        className={clsx(
          styles.content,
          centered && styles.centered,
          closing && styles.contentClosing,
          className
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={contentRef}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              hitArea
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={requestClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
