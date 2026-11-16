import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { unified } from 'unified'
import { prepareMarkdownSource, prepareMathSource } from './source.ts'
import { GFM_PLUGIN } from './gfm.ts'
import { remarkAnswerMath } from './math.ts'
import { remarkLiteralHtml } from './literal.ts'

const parser = unified()
  .use(remarkParse)
  .use(GFM_PLUGIN[0], GFM_PLUGIN[1])
  .use(remarkCjkFriendly)
  .use(remarkAnswerMath)
  .use(remarkLiteralHtml)

function summaryText(node: Nodes): string {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if ('value' in node) return node.value
  if ('children' in node) {
    const inline =
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      node.type === 'emphasis' ||
      node.type === 'strong' ||
      node.type === 'delete' ||
      node.type === 'link' ||
      node.type === 'linkReference' ||
      node.type === 'tableCell'
    return node.children.map(summaryText).join(inline ? '' : ' ')
  }
  return node.type === 'break' ? ' ' : ''
}

export function markdownSummary(source: string): string {
  const prepared = prepareMathSource(prepareMarkdownSource(source))
  return summaryText(parser.runSync(parser.parse(prepared), { value: prepared }))
    .replace(/\s+/g, ' ')
    .trim()
}
