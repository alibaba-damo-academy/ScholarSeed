const EDGE = 28
const MAX_SPEED = 12
const DRAG_DISTANCE = 4

/** Keep a native text drag attached to its original anchor while the reader scrolls. */
export function textDrag(root: HTMLElement, clear: () => void, publish: () => void): () => void {
  let dragging = false
  let frame = 0
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let moved = false
  let anchor: { node: Node; offset: number } | null = null
  const extend = (node: Node, offset: number): void => {
    if (anchor && root.contains(anchor.node) && root.contains(node)) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, node, offset)
  }
  const tick = (): void => {
    frame = 0
    if (!dragging) return
    const bounds = root.getBoundingClientRect()
    const delta = y > bounds.bottom - EDGE ? Math.min(MAX_SPEED, (y - bounds.bottom + EDGE) / 2)
      : y < bounds.top + EDGE ? -Math.min(MAX_SPEED, (bounds.top + EDGE - y) / 2) : 0
    if (!delta) return
    const before = root.scrollTop
    root.scrollTop += delta
    if (root.scrollTop !== before) {
      const caret = document.caretRangeFromPoint(Math.max(bounds.left + 1, Math.min(bounds.right - 1, x)), Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y)))
      const selection = window.getSelection()
      if (caret && root.contains(caret.startContainer) && selection?.anchorNode && root.contains(selection.anchorNode)) {
        extend(caret.startContainer, caret.startOffset)
      }
    }
    frame = requestAnimationFrame(tick)
  }
  const down = (event: MouseEvent): void => {
    if (event.button !== 0) return
    dragging = true; x = startX = event.clientX; y = startY = event.clientY; moved = false
    const caret = document.caretRangeFromPoint(x, y)
    const selection = window.getSelection()
    anchor = event.shiftKey && selection?.anchorNode && root.contains(selection.anchorNode)
      ? { node: selection.anchorNode, offset: selection.anchorOffset }
      : caret && root.contains(caret.startContainer) ? { node: caret.startContainer, offset: caret.startOffset } : null
    clear()
  }
  const move = (event: MouseEvent): void => {
    if (!dragging) return
    x = event.clientX; y = event.clientY
    moved ||= Math.hypot(x - startX, y - startY) > DRAG_DISTANCE
    if (!frame) frame = requestAnimationFrame(tick)
  }
  const up = (): void => {
    if (!dragging) return
    dragging = false; cancelAnimationFrame(frame); frame = 0
    const selection = window.getSelection()
    if (moved && selection?.focusNode) extend(selection.focusNode, selection.focusOffset)
    publish(); anchor = null
  }
  root.addEventListener('mousedown', down)
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  window.addEventListener('blur', up)
  return () => {
    dragging = false; cancelAnimationFrame(frame)
    root.removeEventListener('mousedown', down)
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    window.removeEventListener('blur', up)
  }
}
