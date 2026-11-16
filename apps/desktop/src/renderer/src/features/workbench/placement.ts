const VIEWPORT_MARGIN = 12
const MENU_GAP = 8
const MENU_ESTIMATED_HEIGHT = 48
const RESULT_ESTIMATED_HEIGHT = 260

export interface FloatingPosition {
  left: number
  top: number
  width: number
}

export interface SelectionBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export function selectionSurfaceBoundary(
  bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  margin = VIEWPORT_MARGIN
): SelectionBounds {
  const horizontal = Math.min(margin, Math.max(0, bounds.right - bounds.left) / 2)
  const vertical = Math.min(margin, Math.max(0, bounds.bottom - bounds.top) / 2)
  return {
    left: bounds.left + horizontal,
    right: bounds.right - horizontal,
    top: bounds.top + vertical,
    bottom: bounds.bottom - vertical,
  }
}

export function constrainSelectionSurface(
  surface: FloatingPosition & { height: number },
  boundary: SelectionBounds
): FloatingPosition & { height: number } {
  const width = Math.min(surface.width, Math.max(0, boundary.right - boundary.left))
  const height = Math.min(surface.height, Math.max(0, boundary.bottom - boundary.top))
  return {
    left: Math.max(boundary.left, Math.min(surface.left, boundary.right - width)),
    top: Math.max(boundary.top, Math.min(surface.top, boundary.bottom - height)),
    width,
    height,
  }
}

export function selectionSurfacePosition(
  bounds: SelectionBounds,
  size: { width: number; height: number },
  viewport = { width: window.innerWidth, height: window.innerHeight },
  { allowOverlap = false, boundary }: { allowOverlap?: boolean; boundary?: SelectionBounds } = {}
): FloatingPosition & { height: number } {
  const region =
    boundary ??
    selectionSurfaceBoundary({ left: 0, top: 0, right: viewport.width, bottom: viewport.height })
  const width = Math.min(size.width, Math.max(0, region.right - region.left))
  const below = Math.max(0, region.bottom - bounds.bottom - MENU_GAP)
  const above = Math.max(0, bounds.top - MENU_GAP - region.top)
  const useBelow = below >= size.height || below >= above
  const available = useBelow ? below : above
  const height = Math.min(
    size.height,
    allowOverlap ? size.height : Math.max(MENU_ESTIMATED_HEIGHT, available),
    Math.max(0, region.bottom - region.top)
  )
  return constrainSelectionSurface(
    {
      left: (bounds.left + bounds.right - width) / 2,
      top: useBelow ? bounds.bottom + MENU_GAP : bounds.top - MENU_GAP - height,
      width,
      height,
    },
    region
  )
}

export function selectionActionPosition(
  point: { x: number; y: number },
  expanded: boolean,
  measuredWidth: number,
  viewport = { width: window.innerWidth, height: window.innerHeight }
): FloatingPosition {
  const height = expanded ? RESULT_ESTIMATED_HEIGHT : MENU_ESTIMATED_HEIGHT
  const width = Math.min(measuredWidth, Math.max(0, viewport.width - VIEWPORT_MARGIN * 2))
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, point.x - width / 2),
    Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN)
  )
  const below = point.y + MENU_GAP
  const top =
    below + height <= viewport.height - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, point.y - height - MENU_GAP)
  return { left, top, width }
}

export const DEFAULT_SELECTION_TOOLBAR_WIDTH = 460
export const SELECTION_VIEWPORT_MARGIN = VIEWPORT_MARGIN
