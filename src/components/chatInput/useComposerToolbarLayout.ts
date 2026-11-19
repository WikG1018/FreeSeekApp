import { useLayoutEffect, useRef, type RefObject } from 'react'

type ControlFrame = {
  element: HTMLElement
  layoutWidth: number
  text: string | null
}
type ToolbarFrame = { width: number; compact?: string; controls: Map<string, ControlFrame> }

const controls = (row: HTMLElement) =>
  new Map(
    Array.from(row.querySelectorAll<HTMLElement>('[data-toolbar-control]')).map((element) => [
      element.dataset.toolbarControl ?? '',
      { element, layoutWidth: element.offsetWidth, text: element.textContent },
    ])
  )

/** Work from the rendered labels so translations, font sizes and names all share the same budget. */
export const useComposerToolbarLayout = (ref: RefObject<HTMLDivElement>, contentKey: string) => {
  const last = useRef<ToolbarFrame>()
  const animations = useRef<Animation[]>([])
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) {
      return
    }
    let widthMotion: Animation | undefined
    const cancel = () => {
      for (const animation of animations.current) {
        animation.cancel()
      }
      animations.current = []
      widthMotion = undefined
    }
    const measure = (motion: boolean) => {
      cancel()
      const label = row.querySelector<HTMLElement>('[data-model-label]')
      const needsSpace = () =>
        row.scrollWidth > row.clientWidth || (!!label && label.scrollWidth > label.clientWidth)
      row.dataset.compact = 'full'
      if (needsSpace()) {
        row.dataset.compact = 'effort'
      }
      if (needsSpace()) {
        row.dataset.compact = 'both'
      }
      if (row.scrollWidth > row.clientWidth) {
        row.dataset.compact = 'tight'
      }
      const frame = {
        width: row.clientWidth,
        compact: row.dataset.compact,
        controls: controls(row),
      }
      const previous = last.current
      last.current = frame
      if (
        !motion ||
        !previous ||
        previous.width !== frame.width ||
        typeof row.animate !== 'function' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return
      }
      const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      const model = frame.controls.get('model')
      const oldModel = previous.controls.get('model')
      const sameTools =
        frame.compact === previous.compact &&
        frame.controls.size === previous.controls.size &&
        [...frame.controls].every(
          ([id, item]) =>
            id === 'model' || item.layoutWidth === previous.controls.get(id)?.layoutWidth
        )
      // The flex row owns the space during the transition. Moving each button independently
      // could make the new hit targets overlap when a width or label changed at the same time.
      if (
        sameTools &&
        model &&
        oldModel &&
        Math.abs(oldModel.layoutWidth - model.layoutWidth) > 1
      ) {
        widthMotion = model.element.animate(
          [{ width: oldModel.layoutWidth + 'px' }, { width: model.layoutWidth + 'px' }],
          { duration: 180, easing }
        )
        animations.current.push(widthMotion)
      }
      for (const [id, item] of frame.controls) {
        const before = previous.controls.get(id)
        if (!before || (before.text === item.text && frame.compact === previous.compact)) {
          continue
        }
        const label = item.element.querySelector<HTMLElement>('[data-model-label]') ?? item.element
        animations.current.push(
          label.animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 145, easing })
        )
      }
    }
    measure(true)
    const observer = new ResizeObserver(() => {
      const previous = last.current
      const modelMoving = widthMotion?.pending || widthMotion?.playState === 'running'
      if (
        previous?.width !== row.clientWidth ||
        [...(previous?.controls ?? [])].some(
          ([id, item]) =>
            !(id === 'model' && modelMoving) && item.element.offsetWidth !== item.layoutWidth
        )
      ) {
        measure(false)
      }
    })
    observer.observe(row)
    for (const element of row.querySelectorAll('[data-toolbar-control]')) {
      observer.observe(element)
    }
    let active = true
    if (document.fonts?.status === 'loading') {
      void document.fonts.ready.then(() => {
        if (active) {
          measure(false)
        }
      })
    }
    return () => {
      active = false
      observer.disconnect()
      cancel()
    }
  }, [ref, contentKey])
}
