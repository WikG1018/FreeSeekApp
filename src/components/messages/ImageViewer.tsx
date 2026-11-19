import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { useModalStack } from '../base/Modal.js'
import { useDialogFocus } from '../base/useDialogFocus.js'
import {
  boundedView,
  fitImage,
  FITTED_VIEW,
  IMAGE_UNCROPPED,
  thumbnailFrame,
  viewTransform,
  zoomAround,
  type ImageFit,
  type ImageView,
  type Point,
} from './imageViewerGeometry.js'
import { closeImageViewer, type PreviewImage } from './imageViewerState.js'
import styles from './ImageViewer.module.css'

const ENTER = { duration: 265, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
const EXIT = { duration: 215, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' } as const
const REST_FRAME = { opacity: 1, clipPath: IMAGE_UNCROPPED, transform: viewTransform(FITTED_VIEW) }
const movedBy = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const point = (event: { clientX: number; clientY: number }): Point => ({
  x: event.clientX,
  y: event.clientY,
})

// One contact pans. A second contact rebases the same gesture on their midpoint and span.
const contactFrame = (points: Map<number, Point>) => {
  const [a, b] = points.values()
  return b
    ? { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: Math.max(1, movedBy(a, b)) }
    : { center: a, span: 0 }
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const ImageViewer = memo(function ImageViewer({ image }: { image: PreviewImage }) {
  const t = useTranslate()
  const dialog = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLButtonElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const shade = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState(false)
  const interaction = useRef({
    view: FITTED_VIEW,
    fit: null as ImageFit | null,
    frame: 0,
    motion: [] as Animation[],
    closing: false,
    points: new Map<number, Point>(),
    baseline: null as (ReturnType<typeof contactFrame> & { view: ImageView }) | null,
    moved: false,
  })
  const state = interaction.current

  const cancelMotion = useCallback(() => {
    const motion = interaction.current.motion
    for (const animation of motion) {
      animation.cancel()
    }
    motion.length = 0
  }, [])

  const paint = useCallback(() => {
    const state = interaction.current
    state.frame = 0
    if (picture.current && stage.current) {
      picture.current.style.transform = viewTransform(state.view)
      stage.current.toggleAttribute('data-zoomed', state.view.scale > 1)
    }
  }, [])

  const moveTo = useCallback(
    (view: ImageView) => {
      const state = interaction.current
      if (state.fit && !state.closing) {
        state.view = boundedView(view, state.fit)
        if (!state.frame) {
          state.frame = requestAnimationFrame(paint)
        }
      }
    },
    [paint]
  )

  const close = () => {
    if (state.closing) {
      return
    }
    state.closing = true
    const img = picture.current
    if (!state.fit || !img?.animate || !shade.current || !closeButton.current || reduceMotion()) {
      closeImageViewer()
      return
    }

    // Use the current pixels when closing during entry or just after a zoom gesture.
    const current = getComputedStyle(img)
    const from = {
      transform: current.transform,
      clipPath: current.clipPath,
      opacity: current.opacity,
    }
    const shadeOpacity = getComputedStyle(shade.current).opacity
    const buttonOpacity = getComputedStyle(closeButton.current).opacity
    cancelMotion()
    cancelAnimationFrame(state.frame)
    const target = !failed && thumbnailFrame(image.thumbnail, state.fit)
    const animation = img.animate(
      [from, target || { ...from, transform: `${from.transform} scale(0.97)`, opacity: 0 }],
      EXIT
    )
    animation.onfinish = closeImageViewer
    state.motion = [
      animation,
      shade.current.animate([{ opacity: shadeOpacity }, { opacity: 0 }], EXIT),
      closeButton.current.animate([{ opacity: buttonOpacity }, { opacity: 0 }], {
        ...EXIT,
        duration: 125,
      }),
    ]
  }

  const isTop = useModalStack(close)
  useDialogFocus(dialog, isTop)

  useLayoutEffect(() => {
    const state = interaction.current
    const touchArea = stage.current
    const img = picture.current
    const backdrop = shade.current
    const control = closeButton.current
    if (!touchArea || !img || !backdrop || !control) {
      return
    }

    const measure = () => {
      const area = touchArea.getBoundingClientRect()
      const previous = state.fit
      if (
        state.closing ||
        !area.width ||
        !area.height ||
        (previous &&
          previous.area.width === area.width &&
          previous.area.height === area.height &&
          previous.area.left === area.left &&
          previous.area.top === area.top)
      ) {
        return
      }

      const fit = fitImage(area, image)
      state.fit = fit
      const { width, height } = fit
      img.style.width = `${width}px`
      img.style.height = `${height}px`
      img.style.left = `${(area.width - width) / 2}px`
      img.style.top = `${(area.height - height) / 2}px`
      if (previous) {
        cancelMotion()
        state.view = boundedView(
          {
            scale: state.view.scale,
            x: (state.view.x * width) / previous.width,
            y: (state.view.y * height) / previous.height,
          },
          fit
        )
        state.points.clear()
        state.baseline = null
        state.moved = true
        touchArea.removeAttribute('data-dragging')
      }
      cancelAnimationFrame(state.frame)
      paint()
      if (!previous && img.animate && !reduceMotion()) {
        const from = thumbnailFrame(image.thumbnail, fit) ?? {
          ...REST_FRAME,
          opacity: 0,
          transform: viewTransform({ ...FITTED_VIEW, scale: 0.98 }),
        }
        state.motion = [
          img.animate([from, REST_FRAME], ENTER),
          backdrop.animate([{ opacity: 0 }, { opacity: 1 }], ENTER),
          control.animate([{ opacity: 0 }, { opacity: 1 }], {
            ...ENTER,
            delay: 45,
            duration: 180,
            fill: 'backwards',
          }),
        ]
      }
    }

    image.thumbnail.setAttribute('data-image-viewer-source', '')
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(touchArea)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (state.fit && !state.closing && img.naturalWidth) {
        cancelMotion()
        const at = point(event)
        const delta = Math.min(120, Math.max(-120, event.deltaY * (event.deltaMode ? 16 : 1)))
        moveTo(
          zoomAround(state.view, state.fit, at, at, state.view.scale * Math.exp(-delta * 0.005))
        )
      }
    }
    touchArea.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(state.frame)
      cancelMotion()
      touchArea.removeEventListener('wheel', wheel)
      image.thumbnail.removeAttribute('data-image-viewer-source')
    }
  }, [cancelMotion, image, moveTo, paint])

  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (state.closing || event.button !== 0 || state.points.size >= 2) {
      return
    }
    if (!state.points.size) {
      state.moved = false
    }
    state.points.set(event.pointerId, point(event))
    state.baseline = { ...contactFrame(state.points), view: state.view }
    state.moved ||= state.points.size === 2
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.currentTarget.setAttribute('data-dragging', '')
  }

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const { fit, baseline, points } = state
    if (state.closing || failed || !fit || !baseline || !points.has(event.pointerId)) {
      return
    }
    points.set(event.pointerId, point(event))
    const next = contactFrame(points)
    state.moved ||= movedBy(baseline.center, next.center) > 6
    if (state.moved) {
      cancelMotion()
      const scale = baseline.span
        ? (baseline.view.scale * next.span) / baseline.span
        : baseline.view.scale
      moveTo(zoomAround(baseline.view, fit, baseline.center, next.center, scale))
    }
  }

  const end = (event: PointerEvent<HTMLButtonElement>) => {
    if (!state.points.delete(event.pointerId)) {
      return
    }
    state.moved ||= event.type !== 'pointerup'
    state.baseline = state.points.size ? { ...contactFrame(state.points), view: state.view } : null
    if (!state.points.size) {
      event.currentTarget.removeAttribute('data-dragging')
    }
  }

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const { view, fit } = state
    if (!fit || state.closing || failed) {
      return
    }
    let next: ImageView
    switch (event.key) {
      case '+':
      case '=':
      case '-':
        next = zoomAround(
          view,
          fit,
          fit.center,
          fit.center,
          view.scale * (event.key === '-' ? 0.8 : 1.25)
        )
        break
      case '0':
        next = FITTED_VIEW
        break
      case 'ArrowLeft':
        next = { ...view, x: view.x + 56 }
        break
      case 'ArrowRight':
        next = { ...view, x: view.x - 56 }
        break
      case 'ArrowUp':
        next = { ...view, y: view.y + 56 }
        break
      case 'ArrowDown':
        next = { ...view, y: view.y - 56 }
        break
      default:
        return
    }
    event.preventDefault()
    cancelMotion()
    moveTo(next)
  }

  return createPortal(
    <div
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      ref={dialog}
      onKeyDown={key}
    >
      <div ref={shade} className={styles.shade} />
      <button
        type="button"
        className={styles.stage}
        ref={stage}
        aria-label={t('messageImageClose')}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onClick={(event) => {
          if (event.detail === 0 || !state.moved) {
            close()
          }
        }}
      >
        <img
          ref={picture}
          className={styles.picture}
          src={image.src}
          alt={image.name}
          draggable={false}
          onError={() => setFailed(true)}
        />
      </button>
      {failed && (
        <p className={styles.error} role="status">
          {t('messageImageUnavailable')}
        </p>
      )}
      <button
        type="button"
        className={styles.close}
        ref={closeButton}
        aria-label={t('close')}
        data-dialog-initial
        onClick={close}
      >
        <IconCloseOutline16 />
      </button>
    </div>,
    document.body
  )
})
