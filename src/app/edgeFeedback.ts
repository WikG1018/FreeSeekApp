const EDGE = '[data-scroll-edge]'
const CONTENT = '[data-scroll-edge-content]'
const DIRECT_INPUT = 'input, textarea, select, [contenteditable], [data-preview-zoomed]'
/** 弹簧刚度与阻尼：临界阻尼附近，回归时有一点点「余韵」但不弹跳 */
const SPRING_STIFFNESS = 0.14
const SPRING_DAMPING = 0.78
/** 单帧最大位移，避免甩得太猛时跳变 */
const MAX_STEP = 48

type Drag = {
  owner: HTMLElement
  id: number
  x: number
  y: number
  last: number
  lastAt: number
  pull: number
  /** 最近一次手势的位移速度（px/ms），松手时作为弹簧初速度 */
  velocity: number
}

const ownerOf = (target: EventTarget | null) => {
  if (!(target instanceof Element) || target.closest(DIRECT_INPUT)) {
    return null
  }
  for (let item: Element | null = target; item; item = item.parentElement) {
    if (!(item instanceof HTMLElement) || item.scrollHeight <= item.clientHeight + 1) {
      continue
    }
    const style = getComputedStyle(item)
    if (!/auto|scroll|overlay/.test(style.overflowY)) {
      continue
    }
    return item.matches(EDGE) ? item : null
  }
  return null
}

const edgeAt = (node: HTMLElement, displacement: number) => {
  if (displacement > 0 && node.scrollTop <= 1) {
    return 'top'
  }
  if (displacement < 0 && node.scrollTop + node.clientHeight + 1 >= node.scrollHeight) {
    return 'bottom'
  }
  return null
}

/** Normal drags stay native. Animate only the remaining distance at a scroll edge. */
export const bindEdgeFeedback = () => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let drag: Drag | undefined
  let frame = 0
  const clear = (node: HTMLElement) => {
    delete node.dataset.edgeMotion
    node.style.removeProperty('--fs-edge-shift')
  }
  /** 松手后的弹簧收敛：用当前位移与手势速度逐帧推进，直到回到 0 */
  const settle = () => {
    cancelAnimationFrame(frame)
    const owner = drag?.owner
    const velocity = drag?.velocity ?? 0
    drag = undefined
    if (!owner?.dataset.edgeMotion) {
      return
    }
    let position = parseFloat(owner.style.getPropertyValue('--fs-edge-shift')) || 0
    // 初速度与位移同向时放大回弹的「甩感」；反向上限收紧，避免甩过头
    let speed = position * velocity > 0 ? velocity * 16 : 0
    owner.dataset.edgeMotion = 'settle'
    const step = () => {
      if (!owner.isConnected) {
        clear(owner)
        return
      }
      // 弹簧：加速度 = -k * 位移 - c * 速度
      speed += -SPRING_STIFFNESS * position - SPRING_DAMPING * speed
      position += Math.max(-MAX_STEP, Math.min(MAX_STEP, speed))
      if (Math.abs(position) < 0.35 && Math.abs(speed) < 0.35) {
        owner.style.setProperty('--fs-edge-shift', '0px')
        clear(owner)
        return
      }
      owner.style.setProperty('--fs-edge-shift', position.toFixed(2) + 'px')
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }
  const start = (event: TouchEvent) => {
    settle()
    const touch = event.touches[0]
    const owner = event.touches.length === 1 && ownerOf(event.target)
    if (
      reduced.matches ||
      !owner ||
      !touch ||
      !owner.querySelector(':scope > ' + CONTENT) ||
      document.getSelection()?.type === 'Range'
    ) {
      return
    }
    drag = {
      owner,
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      last: touch.clientY,
      lastAt: event.timeStamp,
      pull: 0,
      velocity: 0,
    }
  }
  const move = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!drag) {
      return
    }
    if (
      !touch ||
      event.touches.length !== 1 ||
      touch.identifier !== drag.id ||
      Math.abs(touch.clientX - drag.x) > Math.max(8, Math.abs(touch.clientY - drag.y)) ||
      document.getSelection()?.type === 'Range'
    ) {
      settle()
      return
    }
    const { owner, last, lastAt, pull } = drag
    const dy = touch.clientY - last
    const now = event.timeStamp
    const elapsed = Math.max(1, now - lastAt)
    drag.last = touch.clientY
    drag.lastAt = now
    // 指数滑动平均，避免单帧抖动主导初速度
    drag.velocity = drag.velocity * 0.6 + (dy / elapsed) * 0.4
    const edge = edgeAt(owner, dy)
    if (!edge && !pull) {
      return
    }
    const next = pull + dy
    drag.pull = pull === 0 || Math.sign(pull) === Math.sign(next) ? next : 0
    // 橡皮筋：拖得越多越费力，上限约 56px（原 16px 几乎看不出回弹）
    const offset = (56 * drag.pull) / (120 + Math.abs(drag.pull))
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (!owner.isConnected) {
        return
      }
      owner.dataset.edgeMotion = 'drag'
      owner.style.setProperty('--fs-edge-shift', offset.toFixed(2) + 'px')
    })
  }
  const options = { passive: true, capture: true }
  document.addEventListener('touchstart', start, options)
  document.addEventListener('touchmove', move, options)
  document.addEventListener('touchend', settle, options)
  document.addEventListener('touchcancel', settle, options)
  return () => {
    settle()
    cancelAnimationFrame(frame)
    document.removeEventListener('touchstart', start, true)
    document.removeEventListener('touchmove', move, true)
    document.removeEventListener('touchend', settle, true)
    document.removeEventListener('touchcancel', settle, true)
  }
}
