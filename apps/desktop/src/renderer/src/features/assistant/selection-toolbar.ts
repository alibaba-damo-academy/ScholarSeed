/**
 * A right-click on the selected text itself requests the native copy menu
 * (main/index.ts's `context-menu` handler), not a dismissal — clearing the
 * selection here would race Electron's selectionText snapshot and both
 * blank the highlight and risk copying nothing. Left-click elsewhere, or a
 * right-click outside the annotated root, still closes the draft.
 */
export function shouldClosePointerToolbar(
  button: number,
  targetInsideToolbar: boolean,
  targetInsideRoot: boolean
): boolean {
  if (targetInsideToolbar) return false
  if (button === 2 && targetInsideRoot) return false
  return true
}

export type SelectionToolbarPlacement = 'above' | 'below'

export interface SelectionToolbarPosition {
  placement: SelectionToolbarPlacement
  top: number
}

interface SelectionToolbarPositionInput {
  currentPlacement: SelectionToolbarPlacement
  devicePixelRatio: number
  rootTop: number
  selectionBottom: number
  selectionTop: number
  toolbarHeight: number
  visibleBottom: number
  visibleTop: number
}

const PLACEMENT_HYSTERESIS_PX = 4

const devicePixel = (value: number, ratio: number): number => {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  return Math.round(value * safeRatio) / safeRatio
}

export function selectionToolbarPosition({
  currentPlacement,
  devicePixelRatio,
  rootTop,
  selectionBottom,
  selectionTop,
  toolbarHeight,
  visibleBottom,
  visibleTop
}: SelectionToolbarPositionInput): SelectionToolbarPosition {
  const spaceBelow = visibleBottom - selectionBottom
  const spaceAbove = selectionTop - visibleTop
  const belowFits = spaceBelow + PLACEMENT_HYSTERESIS_PX >= toolbarHeight
  const aboveFits = spaceAbove + PLACEMENT_HYSTERESIS_PX >= toolbarHeight
  let placement = currentPlacement

  if (currentPlacement === 'below' && !belowFits && (aboveFits || spaceAbove > spaceBelow + PLACEMENT_HYSTERESIS_PX)) {
    placement = 'above'
  } else if (currentPlacement === 'above' && !aboveFits && (belowFits || spaceBelow > spaceAbove + PLACEMENT_HYSTERESIS_PX)) {
    placement = 'below'
  }

  const preferredTop = placement === 'below' ? selectionBottom : selectionTop - toolbarHeight
  const maximumTop = Math.max(visibleTop, visibleBottom - toolbarHeight)
  const viewportTop = Math.max(visibleTop, Math.min(preferredTop, maximumTop))
  const top = viewportTop - rootTop + (placement === 'above' ? toolbarHeight : 0)

  return { placement, top: devicePixel(top, devicePixelRatio) }
}
