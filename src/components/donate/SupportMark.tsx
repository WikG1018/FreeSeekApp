import { useSyncExternalStore } from 'react'
import styles from './SupportMark.module.css'

const subscribeVisibility = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify)
  return () => document.removeEventListener('visibilitychange', notify)
}

export const useDocumentVisible = () =>
  useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible')

export const SupportMark = ({ animated = true }: { animated?: boolean }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    className={animated ? styles.animated : undefined}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
  >
    <path
      className={styles.heart}
      d="M11 20s-7.6-4.6-7.6-9.7a4.2 4.2 0 0 1 7.6-2.4 4.2 4.2 0 0 1 7.6 2.4c0 5.1-7.6 9.7-7.6 9.7Z"
      fill="currentColor"
    />
    <path
      className={styles.glint}
      d="m19 2 .65 2.35L22 5l-2.35.65L19 8l-.65-2.35L16 5l2.35-.65L19 2Z"
      fill="currentColor"
    />
  </svg>
)
