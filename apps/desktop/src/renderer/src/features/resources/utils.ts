export const SUGGESTION_VIEWPORT_MARGIN = 12
export const SOURCE_PREVIEW_LINES = 3

export function sourceNeedsDisclosure(height: number, lineHeight: number): boolean {
  return height > lineHeight * SOURCE_PREVIEW_LINES
}

export function suggestionPosition(
  position: { left: number; top: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  return {
    left: Math.max(SUGGESTION_VIEWPORT_MARGIN, Math.min(position.left, viewport.width - size.width - SUGGESTION_VIEWPORT_MARGIN)),
    top: Math.max(SUGGESTION_VIEWPORT_MARGIN, Math.min(position.top, viewport.height - size.height - SUGGESTION_VIEWPORT_MARGIN))
  }
}
