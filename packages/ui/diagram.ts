import type mermaid from 'mermaid'

declare global {
  interface Window {
    __scholarseedDiagram?: { default: typeof mermaid }
  }
}

export default new Proxy({} as typeof mermaid, {
  get(_target, property) {
    const library = window.__scholarseedDiagram?.default
    if (!library) throw new Error('official_ui_diagram_unavailable')
    return Reflect.get(library, property)
  },
})
