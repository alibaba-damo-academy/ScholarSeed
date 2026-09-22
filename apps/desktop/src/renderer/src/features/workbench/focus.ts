export const DOCUMENT_SELECTION_INTERACTION_ATTRIBUTE = 'data-document-selection-interaction'
const DOCUMENT_SELECTION_INTERACTION_SELECTOR = `[${DOCUMENT_SELECTION_INTERACTION_ATTRIBUTE}]`
const OPEN_SELECTION_CONTROLLER_SELECTOR = '[aria-controls][aria-expanded="true"]'
const SECONDARY_POINTER_BUTTON = 2

export const documentSelectionInteractionProps = {
  [DOCUMENT_SELECTION_INTERACTION_ATTRIBUTE]: ''
} as const

function selectionInteractionRegions(): HTMLElement[] {
  const regions = [...document.querySelectorAll<HTMLElement>(DOCUMENT_SELECTION_INTERACTION_SELECTOR)]
  for (const region of regions) {
    for (const controller of region.querySelectorAll<HTMLElement>(OPEN_SELECTION_CONTROLLER_SELECTOR)) {
      for (const id of (controller.getAttribute('aria-controls') ?? '').split(/\s+/)) {
        const controlled = document.getElementById(id)
        if (controlled && !regions.includes(controlled)) regions.push(controlled)
      }
    }
  }
  return regions
}

export function retainsDocumentSelection(host: Node | null, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  if (host?.contains(target)) return true
  return selectionInteractionRegions().some((region) => region.contains(target))
}

export function preserveTextSelectionForContextMenu(
  event: Pick<PointerEvent, 'button' | 'clientX' | 'clientY' | 'preventDefault'>,
  selection: Selection | null = window.getSelection()
): boolean {
  if (
    event.button !== SECONDARY_POINTER_BUTTON ||
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  ) {
    return false
  }
  if (selection.toString().trim().length === 0) return false
  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const rectangles = selection.getRangeAt(rangeIndex).getClientRects()
    for (let rectangleIndex = 0; rectangleIndex < rectangles.length; rectangleIndex += 1) {
      const rectangle = rectangles[rectangleIndex]
      if (
        event.clientX >= rectangle.left
        && event.clientX <= rectangle.right
        && event.clientY >= rectangle.top
        && event.clientY <= rectangle.bottom
      ) {
        event.preventDefault()
        return true
      }
    }
  }
  return false
}
