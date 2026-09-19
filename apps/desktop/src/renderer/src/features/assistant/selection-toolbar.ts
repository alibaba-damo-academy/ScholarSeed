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
