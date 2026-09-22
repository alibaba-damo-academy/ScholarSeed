const VIEWPORT_MARGIN = 12
const MENU_GAP = 8
const MENU_ESTIMATED_HEIGHT = 48
const RESULT_ESTIMATED_HEIGHT = 260

export interface FloatingPosition {
  left: number
  top: number
  width: number
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
  const top = below + height <= viewport.height - VIEWPORT_MARGIN
    ? below
    : Math.max(VIEWPORT_MARGIN, point.y - height - MENU_GAP)
  return { left, top, width }
}

export const DEFAULT_SELECTION_TOOLBAR_WIDTH = 460
export const SELECTION_VIEWPORT_MARGIN = VIEWPORT_MARGIN
