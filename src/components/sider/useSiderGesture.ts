import { useEffect, type RefObject } from 'react'
import { hasOpenModal } from '../base/Modal.js'
import { hasSettingsOpen } from '../settings/settingsDialogState.js'
import { useMobileSider } from './mobileSiderState.js'

/** 中部单指横滑；方向锁定前不拦截滚动、长按选择、输入或横向代码/表格操作。 */
export const useSiderGesture = (frameRef: RefObject<HTMLDivElement>, enabled: boolean) => {
  useEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    let gesture:
      | {
          id: number
          x: number
          y: number
          lastX: number
          time: number
          lastTime: number
          velocity: number
          width: number
          open: boolean
          dragging: boolean
          progress: number
        }
      | undefined
    let suppressClickUntil = 0
    const finish = (cancelled: boolean) => {
      const current = gesture
      gesture = undefined
      if (!current?.dragging) {
        return
      }
      const distance = current.lastX - current.x
      const flick =
        performance.now() - current.lastTime < 100 &&
        Math.abs(current.velocity) > 0.5 &&
        Math.abs(distance) > 24
      const open = cancelled
        ? current.open
        : flick
          ? current.velocity > 0
          : current.open
            ? current.progress > 0.7
            : current.progress > 0.3
      frame.toggleAttribute('data-sider-open', open)
      frame.removeAttribute('data-sider-dragging')
      frame.style.removeProperty('--sider-progress')
      useMobileSider.setState({ open, dragging: false })
      suppressClickUntil = performance.now() + 350
    }
    const start = (event: TouchEvent) => {
      suppressClickUntil = 0
      if (
        event.touches.length !== 1 ||
        hasSettingsOpen() ||
        hasOpenModal() ||
        document.querySelector('[role="menu"]')
      ) {
        return
      }
      if (
        document.activeElement?.matches('input,textarea,[contenteditable="true"]') ||
        !window.getSelection()?.isCollapsed
      ) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (
        !target ||
        (!target.closest('[data-sider-swipe-row]') &&
          target.closest(
            'button,a,input,textarea,select,video,audio,[contenteditable="true"],[role="slider"],[role="menu"]'
          ))
      ) {
        return
      }
      for (
        let element: Element | null = target;
        element && element !== frame;
        element = element.parentElement
      ) {
        if (
          element.scrollWidth > element.clientWidth + 2 &&
          /auto|scroll/.test(getComputedStyle(element).overflowX)
        ) {
          return
        }
      }
      const touch = event.touches[0],
        open = useMobileSider.getState().open
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        lastX: touch.clientX,
        time: performance.now(),
        lastTime: performance.now(),
        velocity: 0,
        width:
          frame.querySelector('[data-testid="mobile-sider"]')?.getBoundingClientRect().width ||
          Math.min(frame.clientWidth * 0.86, 360),
        open,
        dragging: false,
        progress: open ? 1 : 0,
      }
    }
    const move = (event: TouchEvent) => {
      if (!gesture) {
        return
      }
      if (event.touches.length !== 1) {
        finish(true)
        return
      }
      const touch = event.touches[0]
      if (touch.identifier !== gesture.id) {
        finish(true)
        return
      }
      const dx = touch.clientX - gesture.x,
        dy = touch.clientY - gesture.y,
        now = performance.now()
      if (!gesture.dragging) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          gesture = undefined
          return
        }
        if (Math.abs(dx) < 12) {
          return
        }
        if (
          Math.abs(dx) < Math.abs(dy) * 1.4 ||
          now - gesture.time > 450 ||
          (gesture.open ? dx > 0 : dx < 0)
        ) {
          gesture = undefined
          return
        }
        if (!event.cancelable) {
          gesture = undefined
          return
        }
        gesture.dragging = true
        frame.setAttribute('data-sider-dragging', '')
        useMobileSider.setState({ dragging: true })
      }
      event.preventDefault()
      gesture.velocity = (touch.clientX - gesture.lastX) / Math.max(1, now - gesture.lastTime)
      gesture.lastX = touch.clientX
      gesture.lastTime = now
      gesture.progress = Math.max(0, Math.min(1, (gesture.open ? 1 : 0) + dx / gesture.width))
      frame.style.setProperty('--sider-progress', String(gesture.progress))
    }
    const end = () => finish(false)
    const cancel = () => finish(true)
    const click = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    frame.addEventListener('touchstart', start, { passive: true })
    frame.addEventListener('touchmove', move, { passive: false })
    frame.addEventListener('touchend', end)
    frame.addEventListener('touchcancel', cancel)
    frame.addEventListener('click', click, true)
    window.addEventListener('resize', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      frame.removeEventListener('touchstart', start)
      frame.removeEventListener('touchmove', move)
      frame.removeEventListener('touchend', end)
      frame.removeEventListener('touchcancel', cancel)
      frame.removeEventListener('click', click, true)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [frameRef, enabled])
}
