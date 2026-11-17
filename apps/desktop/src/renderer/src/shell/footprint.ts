import type { PortalBounds } from '../../../portal'

const SHADOW_BLUR_PAINT_RATIO = 1.5

export function portalFootprint(
  document: Document,
  regions: readonly HTMLElement[],
  observe?: (element: HTMLElement) => void
): PortalBounds | null {
  const window = document.defaultView
  if (!window) return null
  const candidates = new Set<HTMLElement>()
  for (const region of regions) {
    candidates.add(region)
    for (const element of region.querySelectorAll<HTMLElement>(
      '.vds-ai-head, [data-testid="floating-conversation-surface"]'
    ))
      candidates.add(element)
  }
  for (const element of document.body.children) {
    if (
      element instanceof window.HTMLElement &&
      !element.hasAttribute('data-native-conversation-anchor')
    )
      candidates.add(element)
  }
  let left = window.innerWidth
  let top = window.innerHeight
  let right = 0
  let bottom = 0
  for (const element of candidates) {
    observe?.(element)
    if (!element.isConnected || !element.checkVisibility({ visibilityProperty: true })) continue
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) continue
    const style = window.getComputedStyle(element)
    let inset = ['none', 'hidden'].includes(style.outlineStyle)
      ? 0
      : Math.max(Number.parseFloat(style.outlineWidth) || 0, 0)
    const shadow = style.boxShadow.replace(/rgba?\([^)]*\)/g, '')
    for (const layer of shadow.split(',')) {
      const dimensions = layer.match(/-?\d*\.?\d+px/g)?.map(Number.parseFloat)
      if (!dimensions || dimensions.length < 3) continue
      const [offsetX, offsetY, blur, spread = 0] = dimensions
      inset = Math.max(
        inset,
        Math.abs(offsetX) + blur * SHADOW_BLUR_PAINT_RATIO + spread,
        Math.abs(offsetY) + blur * SHADOW_BLUR_PAINT_RATIO + spread
      )
    }
    left = Math.min(left, rect.left - inset)
    top = Math.min(top, rect.top - inset)
    right = Math.max(right, rect.right + inset)
    bottom = Math.max(bottom, rect.bottom + inset)
  }
  left = Math.max(0, Math.floor(left))
  top = Math.max(0, Math.floor(top))
  right = Math.min(window.innerWidth, Math.ceil(right))
  bottom = Math.min(window.innerHeight, Math.ceil(bottom))
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null
}
