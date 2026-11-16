import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import type { LiteratureNote } from '../../contracts/literature'

const NOTE_SUMMARY_LIMIT = 240
const parser = unified().use(remarkParse).use(remarkGfm)

function contentText(node: Nodes): string {
  if (node.type === 'html' || node.type === 'definition') return ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if ('value' in node) return node.value
  if ('children' in node)
    return node.children
      .map(contentText)
      .join(
        node.type === 'paragraph' ||
          node.type === 'heading' ||
          node.type === 'link' ||
          node.type === 'strong' ||
          node.type === 'emphasis' ||
          node.type === 'delete'
          ? ''
          : ' '
      )
  return ''
}

export function literatureNoteSummary(note: Pick<LiteratureNote, 'title' | 'text'>): string {
  const document = parser.parse(note.text)
  const content = document.children.filter(
    (node, index) =>
      !(index === 0 && node.type === 'heading' && contentText(node).trim() === note.title.trim())
  )
  const text = content.map(contentText).join(' ').replace(/\s+/gu, ' ').trim()
  const characters = Array.from(text)
  return characters.length > NOTE_SUMMARY_LIMIT
    ? `${characters.slice(0, NOTE_SUMMARY_LIMIT).join('')}…`
    : text
}
