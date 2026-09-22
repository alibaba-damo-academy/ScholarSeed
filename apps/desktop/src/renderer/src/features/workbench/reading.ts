import type { EditorView } from '@milkdown/kit/prose/view'
import { EditorView as CodeEditorView } from '@codemirror/view'

const VIEWPORT_INSET = 1
const CODE_EDITOR_SELECTOR = '.cm-editor'

interface ReadingAnchor {
  position: number
  offset: number
  code?: CodeEditorView
}

export function preserveMarkdownReadingPosition(scroller: HTMLElement, view: EditorView): () => void {
  let width = scroller.clientWidth
  let anchor: ReadingAnchor | null = null

  const capture = (): void => {
    if (!scroller.clientHeight || !width || scroller.clientWidth !== width) return
    if (!scroller.scrollTop) {
      anchor = null
      return
    }
    const viewport = scroller.getBoundingClientRect()
    const content = view.dom.getBoundingClientRect()
    const top = Math.max(viewport.top, content.top) + VIEWPORT_INSET
    for (const element of view.dom.querySelectorAll<HTMLElement>(CODE_EDITOR_SELECTOR)) {
      const bounds = element.getBoundingClientRect()
      if (bounds.top > top || bounds.bottom <= top) continue
      const code = CodeEditorView.findFromDOM(element)
      if (!code) continue
      const position = code.posAtCoords({ x: code.contentDOM.getBoundingClientRect().left + VIEWPORT_INSET, y: top })
      const coordinates = position === null ? null : code.coordsAtPos(position)
      if (position !== null && coordinates) {
        anchor = { position, offset: coordinates.top - viewport.top, code }
        return
      }
    }
    const position = view.posAtCoords({
      left: Math.max(viewport.left, content.left) + VIEWPORT_INSET,
      top
    })?.pos
    anchor = position === undefined ? null : {
      position,
      offset: view.coordsAtPos(position).top - viewport.top
    }
  }

  const resize = (): void => {
    const nextWidth = scroller.clientWidth
    if (!nextWidth || !scroller.clientHeight || nextWidth === width) return
    width = nextWidth
    if (anchor) {
      const viewport = scroller.getBoundingClientRect()
      const coordinates = anchor.code
        ? anchor.code.dom.isConnected && anchor.position <= anchor.code.state.doc.length
          ? anchor.code.coordsAtPos(anchor.position)
          : null
        : anchor.position <= view.state.doc.content.size ? view.coordsAtPos(anchor.position) : null
      if (coordinates) scroller.scrollTop += coordinates.top - viewport.top - anchor.offset
    }
    capture()
  }

  const observer = new ResizeObserver(resize)
  const mutations = new MutationObserver(capture)
  observer.observe(scroller)
  mutations.observe(view.dom, { childList: true, characterData: true, subtree: true })
  scroller.addEventListener('scroll', capture, { passive: true })
  capture()

  return () => {
    observer.disconnect()
    mutations.disconnect()
    scroller.removeEventListener('scroll', capture)
  }
}
