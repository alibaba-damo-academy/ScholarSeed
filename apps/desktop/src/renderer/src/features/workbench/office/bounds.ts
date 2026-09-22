export interface OfficeBounds {
  left: number
  top: number
  width: number
  height: number
}

const OFFICE_WORKBENCH_VIEWPORT_SELECTOR = '.vds-workbench-pane'
const OPTIONAL_OFFICE_VIEWPORT_SELECTORS = [
  '.vds-document-view-body',
  '.vds-dock-leaf'
] as const

function intersectBounds(current: OfficeBounds, clip: DOMRectReadOnly): OfficeBounds | null {
  const left = Math.max(current.left, clip.left)
  const top = Math.max(current.top, clip.top)
  const right = Math.min(current.left + current.width, clip.right)
  const bottom = Math.min(current.top + current.height, clip.bottom)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}

export function visibleOfficeBounds(anchor: HTMLElement): OfficeBounds | null {
  let bounds: OfficeBounds | null = anchor.getBoundingClientRect()
  const workbench = anchor.closest<HTMLElement>(OFFICE_WORKBENCH_VIEWPORT_SELECTOR)
  if (!workbench) return null
  for (const selector of OPTIONAL_OFFICE_VIEWPORT_SELECTORS) {
    const viewport = anchor.closest<HTMLElement>(selector)
    if (viewport) bounds = intersectBounds(bounds, viewport.getBoundingClientRect())
    if (!bounds) return null
  }
  return intersectBounds(bounds, workbench.getBoundingClientRect())
}

export const OFFICE_VIEWPORT_SELECTORS = [
  ...OPTIONAL_OFFICE_VIEWPORT_SELECTORS,
  OFFICE_WORKBENCH_VIEWPORT_SELECTOR
] as const
