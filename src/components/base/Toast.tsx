import clsx from 'clsx'
import type { CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  const t = useTranslate()
  const { id, message, duration } = useToast()
  if (!message) {
    return null
  }
  // 到时前 180ms 开始渐隐（与 toastState 的卸载计时对齐）
  const exitDelay = Math.max(0, duration - 180)
  const exitStyle = { '--toast-exit-delay': `${exitDelay}ms` } as CSSProperties
  if (typeof message === 'string') {
    return (
      <div key={id} className={styles.toast} role="status" style={exitStyle}>
        {message}
      </div>
    )
  }
  const error = message.type === 'error'
  return (
    <div
      key={id}
      className={clsx(styles.toast, error && styles.error)}
      role="status"
      style={exitStyle}
    >
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      <span className={styles.content}>
        {t(message.key, message.params)}
        {message.link ? (
          <a className={styles.link} href={message.link.href} target="_blank" rel="noreferrer">
            {t(message.link.key)}
          </a>
        ) : null}
      </span>
    </div>
  )
}
