import { useLayoutEffect, useRef } from 'react'

type Dismiss = (restoreFocus: boolean) => void
let active: Dismiss | null = null

export const hasTransientPanel = () => active !== null
export const closeTransientPanel = () => {
  if (!active) {
    return false
  }
  active(true)
  return true
}

/** 非全屏选项优先接收系统返回，一次只允许打开一个。 */
export const useTransientPanel = (open: boolean, dismiss: Dismiss) => {
  const current = useRef(dismiss)
  current.current = dismiss
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    active?.(false)
    const close: Dismiss = (restore) => current.current(restore)
    active = close
    return () => {
      if (active === close) {
        active = null
      }
    }
  }, [open])
}
