import type { CSSProperties } from 'react'

export type MenuPosition =
  | { kind: 'point'; x: number; y: number }
  | { bottom: number; kind: 'anchor'; left: number; right: number; top: number; width: number }

const MENU_OFFSET = 8
const MENU_VIEWPORT_PADDING = 8

export function menuPositionStyle(
  position: MenuPosition,
  contentRect: { width: number; height: number },
  viewport: { width: number; height: number },
  side: 'bottom' | 'left' | 'right' = 'bottom',
  align: 'center' | 'end' | 'start' = 'start'
): CSSProperties {
  const viewportWidth = viewport.width
  const viewportHeight = viewport.height
  const maxLeft = Math.max(MENU_VIEWPORT_PADDING, viewportWidth - contentRect.width - MENU_VIEWPORT_PADDING)
  const rawLeft = position.kind === 'anchor'
    ? align === 'end'
      ? position.right - contentRect.width
      : align === 'center'
        ? position.left + (position.width - contentRect.width) / 2
        : position.left
    : position.x
  const left = Math.min(Math.max(rawLeft, MENU_VIEWPORT_PADDING), maxLeft)

  if (position.kind === 'point') {
    const maxTop = Math.max(MENU_VIEWPORT_PADDING, viewportHeight - contentRect.height - MENU_VIEWPORT_PADDING)
    return { left, position: 'fixed', top: Math.min(Math.max(position.y, MENU_VIEWPORT_PADDING), maxTop) }
  }

  if (side === 'right' || side === 'left') {
    const rightLeft = position.right + MENU_OFFSET
    const leftLeft = position.left - contentRect.width - MENU_OFFSET
    const fitsRight = rightLeft + contentRect.width <= viewportWidth - MENU_VIEWPORT_PADDING
    const fitsLeft = leftLeft >= MENU_VIEWPORT_PADDING
    // 首选方位放得下(或两侧都放不下时保持首选)就贴首选侧, 否则翻到另一侧。
    const submenuLeft = side === 'right'
      ? (fitsRight || !fitsLeft ? rightLeft : leftLeft)
      : (fitsLeft || !fitsRight ? leftLeft : rightLeft)
    const maxTop = Math.max(MENU_VIEWPORT_PADDING, viewportHeight - contentRect.height - MENU_VIEWPORT_PADDING)
    return {
      left: Math.min(Math.max(submenuLeft, MENU_VIEWPORT_PADDING), maxLeft),
      position: 'fixed',
      top: Math.min(Math.max(position.top, MENU_VIEWPORT_PADDING), maxTop)
    }
  }

  const belowTop = position.bottom + MENU_OFFSET
  const aboveTop = position.top - contentRect.height - MENU_OFFSET
  const fitsBelow = belowTop + contentRect.height <= viewportHeight - MENU_VIEWPORT_PADDING
  const fitsAbove = aboveTop >= MENU_VIEWPORT_PADDING
  const top = fitsBelow || !fitsAbove ? belowTop : aboveTop
  return { left, position: 'fixed', top: Math.min(Math.max(MENU_VIEWPORT_PADDING, top), Math.max(MENU_VIEWPORT_PADDING, viewportHeight - contentRect.height - MENU_VIEWPORT_PADDING)) }
}
