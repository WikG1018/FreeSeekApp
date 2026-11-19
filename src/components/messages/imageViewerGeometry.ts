import type { PreviewImage } from './imageViewerState.js'

export type Point = { x: number; y: number }
export type ImageView = Point & { scale: number }
export type ImageFit = { area: DOMRect; width: number; height: number; center: Point }
export const FITTED_VIEW: ImageView = { x: 0, y: 0, scale: 1 }
export const MAX_IMAGE_ZOOM = 5
export const IMAGE_UNCROPPED = 'inset(0px round 0px)'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const fitImage = (area: DOMRect, image: PreviewImage): ImageFit => {
  const scale = Math.min(area.width / image.width, area.height / image.height)
  return {
    area,
    width: image.width * scale,
    height: image.height * scale,
    center: { x: area.left + area.width / 2, y: area.top + area.height / 2 },
  }
}

export const boundedView = (view: ImageView, fit: ImageFit): ImageView => {
  const x = Math.max(0, (fit.width * view.scale - fit.area.width) / 2)
  const y = Math.max(0, (fit.height * view.scale - fit.area.height) / 2)
  return { scale: view.scale, x: clamp(view.x, -x, x), y: clamp(view.y, -y, y) }
}

export const zoomAround = (
  view: ImageView,
  fit: ImageFit,
  start: Point,
  end: Point,
  scale: number
): ImageView => {
  const next = clamp(scale, 1, MAX_IMAGE_ZOOM)
  const ratio = next / view.scale
  return {
    scale: next,
    x: end.x - fit.center.x - (start.x - fit.center.x - view.x) * ratio,
    y: end.y - fit.center.y - (start.y - fit.center.y - view.y) * ratio,
  }
}

export const viewTransform = ({ scale, x, y }: ImageView) =>
  `translate3d(${x}px, ${y}px, 0) scale(${scale})`

const fitsInside = (image: DOMRect, bounds: DOMRect) =>
  image.left >= bounds.left - 1 &&
  image.top >= bounds.top - 1 &&
  image.right <= bounds.right + 1 &&
  image.bottom <= bounds.bottom + 1

export const thumbnailFrame = (thumbnail: HTMLButtonElement, fit: ImageFit): Keyframe | null => {
  const rect = thumbnail.querySelector('img')?.getBoundingClientRect()
  const scrollArea = thumbnail.closest('[data-testid="message-scroll"]')?.getBoundingClientRect()
  if (
    !rect?.width ||
    !rect.height ||
    !fitsInside(rect, fit.area) ||
    (scrollArea && !fitsInside(rect, scrollArea))
  ) {
    return null
  }
  // Cover the original square crop using the same aspect ratio as the full image.
  const scale = Math.max(rect.width / fit.width, rect.height / fit.height)
  const x = Math.max(0, (fit.width - rect.width / scale) / 2)
  const y = Math.max(0, (fit.height - rect.height / scale) / 2)
  const style = getComputedStyle(thumbnail)
  const radius =
    Math.max(0, parseFloat(style.borderTopLeftRadius) - parseFloat(style.borderTopWidth)) / scale
  return {
    opacity: 1,
    clipPath: `inset(${y}px ${x}px round ${radius}px)`,
    transform: viewTransform({
      scale,
      x: rect.left + rect.width / 2 - fit.center.x,
      y: rect.top + rect.height / 2 - fit.center.y,
    }),
  }
}
