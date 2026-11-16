import type { Root } from 'mdast'
import { visibleMarkdownText } from './source.ts'

interface LiteralNode {
  type: string
  children?: LiteralNode[]
  value?: string
}

export function remarkLiteralHtml(): (tree: Root) => void {
  const preserve = (node: LiteralNode): void => {
    if (node.type === 'html') {
      node.type = 'text'
      node.value = visibleMarkdownText(node.value ?? '')
    }
    node.children?.forEach(preserve)
  }
  return preserve
}
