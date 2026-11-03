export const IMAGE_MIN_SCALE = 0.01
export const IMAGE_MAX_SCALE = 32
export const IMAGE_ZOOM_FACTOR = 1.25
export const IMAGE_DOUBLE_ZOOM_FACTOR = 2
export const IMAGE_PERCENT = 100

export interface ImageSize {
  width: number
  height: number
}
export interface ImageViewState {
  mode: 'fit' | 'manual'
  scale: number
  x: number
  y: number
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export function imageViewState(saved?: Readonly<Record<string, unknown>>): ImageViewState {
  const scale = finite(saved?.scale, 1)
  return {
    mode: saved?.mode === 'manual' ? 'manual' : 'fit',
    scale: scale > 0 ? scale : 1,
    x: finite(saved?.x, 0),
    y: finite(saved?.y, 0),
  }
}

export function fitImage(image: ImageSize, viewport: ImageSize): ImageViewState {
  const scale =
    image.width > 0 && image.height > 0 && viewport.width > 0 && viewport.height > 0
      ? Math.min(viewport.width / image.width, viewport.height / image.height)
      : 1
  return { mode: 'fit', scale, x: 0, y: 0 }
}

/** Keep the same image point under the center of the viewport while zooming. */
export function zoomImage(view: ImageViewState, requestedScale: number): ImageViewState {
  const scale = Math.max(
    IMAGE_MIN_SCALE,
    Math.min(IMAGE_MAX_SCALE, finite(requestedScale, view.scale))
  )
  const ratio = scale / view.scale
  return { mode: 'manual', scale, x: view.x * ratio, y: view.y * ratio }
}

export function panImage(view: ImageViewState, dx: number, dy: number): ImageViewState {
  return { ...view, mode: 'manual', x: view.x + dx, y: view.y + dy }
}

export function toggleImageZoom(view: ImageViewState, fitted: ImageViewState): ImageViewState {
  if (view.scale > fitted.scale || fitted.scale >= IMAGE_MAX_SCALE) return fitted
  return zoomImage(fitted, fitted.scale * IMAGE_DOUBLE_ZOOM_FACTOR)
}
