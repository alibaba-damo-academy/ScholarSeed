import { htmlSchema } from '@milkdown/kit/preset/commonmark'
import { $remark } from '@milkdown/kit/utils'

const ANCHOR_ATTRIBUTE = '(?:id|name)'
const EMPTY_ANCHOR = /^<a\s+(?:id|name)\s*=\s*(["'])([^\s"'<>`=&\p{Cc}]+)\1\s*>\s*<\/a\s*>\s*$/iu
const ANCHOR_CLOSE = /^<\/a\s*>$/iu

interface AnchorSyntaxNode {
  type: string
  value?: string
  children?: AnchorSyntaxNode[]
}

export function markdownAnchorDom(value: string): [string, Record<string, string>] | null {
  if (!EMPTY_ANCHOR.test(value)) return null
  return ['span', { 'data-type': 'html', 'data-value': value, contenteditable: 'false' }]
}

export function mergeMarkdownAnchors(tree: AnchorSyntaxNode): void {
  if (!tree.children) return
  const children = tree.children
  for (let index = 0; index < children.length; index += 1) {
    const opening = children[index]
    if (opening.type === 'html' && opening.value) {
      let closingIndex = index + 1
      const whitespace = children[closingIndex]
      if (whitespace?.type === 'text' && /^\s*$/u.test(whitespace.value ?? '')) closingIndex += 1
      const closing = children[closingIndex]
      if (closing?.type === 'html' && ANCHOR_CLOSE.test(closing.value ?? '')) {
        const value = children
          .slice(index, closingIndex + 1)
          .map((node) => node.value ?? '')
          .join('')
        if (markdownAnchorDom(value)) {
          children.splice(index, closingIndex - index + 1, { ...opening, value })
        }
      }
    }
    mergeMarkdownAnchors(children[index])
  }
}

export const anchorCompatibilityPlugin = $remark(
  'workbenchAnchorCompatibility',
  () => () => (tree) => mergeMarkdownAnchors(tree)
)

export const anchorHtmlSchema = htmlSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx)
  return {
    ...base,
    toDOM: (node) => markdownAnchorDom(String(node.attrs.value)) ?? base.toDOM!(node),
  }
})

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function normalizeMarkdownTargetText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\\([\\`*{}[\]()#+.!_>-])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function markdownFragmentTarget(
  source: string,
  href: string
): { fragment: string; text: string } | null {
  if (!href.startsWith('#') || href.length === 1) return null
  let fragment: string
  try {
    fragment = decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
  const quoted = `(["'])${escapePattern(fragment)}\\1`
  const anchor = new RegExp(`<a\\s+[^>]*${ANCHOR_ATTRIBUTE}\\s*=\\s*${quoted}[^>]*>\\s*</a>`, 'iu')
  const match = anchor.exec(source)
  if (!match) {
    const numeric = /^ref-(\d+)$/u.exec(fragment)
    if (!numeric) return null
    const lines = source.split(/\r?\n/u)
    let headingDepth = 0
    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line)
      if (heading) {
        if (/^(?:参考文献|references|bibliography)$/iu.test(heading[2].trim())) {
          headingDepth = heading[1].length
          continue
        }
        if (headingDepth && heading[1].length <= headingDepth) break
      }
      if (!headingDepth) continue
      const reference = /^\[(\d+)\](?:\s|$)/u.exec(line)
      if (reference?.[1] === numeric[1]) {
        const text = normalizeMarkdownTargetText(line)
        return text ? { fragment, text } : null
      }
    }
    return null
  }
  const lines = source.slice(match.index + match[0].length).split(/\r?\n/u)
  const target = lines.map((line) => normalizeMarkdownTargetText(line)).find(Boolean)
  return target ? { fragment, text: target } : null
}

export function matchesMarkdownTarget(rendered: string, target: string): boolean {
  const text = normalizeMarkdownTargetText(rendered)
  const targetText = normalizeMarkdownTargetText(target)
  return (
    text.length > 0 && targetText.length > 0 && (text === targetText || text.startsWith(targetText))
  )
}
