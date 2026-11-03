import type { Element, ElementContent, Root } from 'hast'
import type { Root as MarkdownRoot, Parent } from 'mdast'
import type { Plugin } from 'unified'
import { CITATION_MARKER } from './citations.ts'

export const TABLE_COPY = 'data-table-copy'
export const TABLE_NUMERIC = 'data-table-numeric'
export const TABLE_INVALID = 'data-table-invalid'
const NUMBER = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?$/
const MISSING = new Set(['', '—', '–', '-', 'N/A'])

export const remarkTabulation: Plugin<[], MarkdownRoot> = () => (root, file) => {
  const source = String(file)
  const visit = (parent: Parent): void => {
    for (const node of parent.children) {
      if (node.type === 'paragraph' && node.position) {
        const original = source.slice(node.position.start.offset, node.position.end.offset)
        const lines = original.split(/\r?\n/)
        if (
          lines[0]?.includes('|') &&
          lines[1]?.includes('|') &&
          /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[1])
        ) {
          node.data = {
            ...node.data,
            hName: 'div',
            hProperties: { [TABLE_INVALID]: original },
            hChildren: [],
          }
          continue
        }
      }
      if ('children' in node) visit(node as Parent)
    }
  }
  visit(root)
}

function text(node: ElementContent, excludeCitations = false): string {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return ''
  if (excludeCitations && node.properties[CITATION_MARKER]) return ''
  if (node.tagName === 'br') return '\n'
  return node.children.map((child) => text(child, excludeCitations)).join('')
}

function tsv(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function rehypeTabulation() {
  return (root: Root): void => {
    const visit = (parent: Root | Element): void => {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        if (node.tagName !== 'table') {
          visit(node)
          continue
        }
        const rows: Element[][] = []
        const collect = (container: Element): void => {
          for (const child of container.children) {
            if (child.type !== 'element') continue
            if (child.tagName === 'tr')
              rows.push(
                child.children.filter(
                  (cell): cell is Element =>
                    cell.type === 'element' && (cell.tagName === 'td' || cell.tagName === 'th')
                )
              )
            else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) collect(child)
          }
        }
        collect(node)
        node.properties[TABLE_COPY] = rows
          .map((row) => row.map((cell) => tsv(text(cell))).join('\t'))
          .join('\n')
        for (let column = 0; column < (rows[0]?.length ?? 0); column++) {
          const values = rows
            .slice(1)
            .map((row) => (row[column] ? text(row[column], true).trim() : ''))
            .filter((value) => !MISSING.has(value))
          if (!values.length || !values.every((value) => NUMBER.test(value))) continue
          for (const row of rows) if (row[column]) row[column].properties[TABLE_NUMERIC] = true
        }
      }
    }
    visit(root)
  }
}
