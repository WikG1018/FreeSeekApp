import { useEffect, useRef, type PointerEvent } from 'react'

export const useLongPress = (onLongPress?: () => void) => {
  const gesture = useRef<{ id: number; x: number; y: number; timer: number }>()
  const handled = useRef(false)
  useEffect(() => () => window.clearTimeout(gesture.current?.timer), [])
  const cancel = () => {
    window.clearTimeout(gesture.current?.timer)
    gesture.current = undefined
  }
  const open = () => {
    cancel()
    if (!handled.current) {
      handled.current = true
      onLongPress?.()
    }
  }
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    cancel()
    handled.current = !event.isPrimary
    if (event.button !== 0 || handled.current) {
      return
    }
    if (event.pointerType === 'touch') {
      // A compatibility mousedown after the hold would land on the new dialog's backdrop.
      event.preventDefault()
    }
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(open, 500),
    }
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const press = gesture.current
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8
    ) {
      handled.current = true
      cancel()
    }
  }
  const consume = () => {
    const consumed = handled.current
    handled.current = false
    return consumed
  }
  return { start, move, cancel, open, consume }
}
