import { create } from 'zustand'
import { logEvent } from '../../services/diagnostics/log.js'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
export const useMobileSider = create(() => ({ open: false, dragging: false }))

useMobileSider.subscribe((current, previous) => {
  if (current.open !== previous.open) {
    logEvent('ui', current.open ? 'sidebar.opened' : 'sidebar.closed', {
      gesture: previous.dragging,
    })
  }
})

export const openMobileSider = () => useMobileSider.setState({ open: true })

export const closeMobileSider = () => useMobileSider.setState({ open: false })
