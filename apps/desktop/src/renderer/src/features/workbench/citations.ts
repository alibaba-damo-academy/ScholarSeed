import { linkAttr, linkSchema } from '@milkdown/kit/preset/commonmark'
import { editorViewCtx } from '@milkdown/kit/core'
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip'
import type { Ctx } from '@milkdown/kit/ctx'
import { $remark } from '@milkdown/kit/utils'

import { DOCUMENT_LINK_ATTRIBUTE } from './links.ts'

interface CitationMarkdownNode {
  type: string
  value?: string
  depth?: number
  url?: string
  children?: CitationMarkdownNode[]
}

const NUMERIC_REFERENCE = /^\[(\d+)\](?:\s|$)/u
const NUMERIC_CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/gu
const REFERENCE_HEADING = /^(?:参考文献|references|bibliography)$/iu

function markdownText(node: CitationMarkdownNode): string {
  return node.value ?? node.children?.map(markdownText).join('') ?? ''
}

function projectCitationText(
  value: string,
  references: Set<string>
): CitationMarkdownNode[] | null {
  const projected: CitationMarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(NUMERIC_CITATION)) {
    const numbers = match[1].split(/\s*,\s*/u)
    if (!numbers.every((number) => references.has(number))) continue
    if (match.index > cursor) projected.push({ type: 'text', value: value.slice(cursor, match.index) })
    if (numbers.length === 1) {
      projected.push({
        type: 'link',
        url: `#ref-${numbers[0]}`,
        children: [{ type: 'text', value: match[0] }],
      })
    } else {
      projected.push({ type: 'text', value: '[' })
      const parts = match[1].split(/(\s*,\s*)/u)
      for (const part of parts) {
        projected.push(
          /^\d+$/u.test(part)
            ? { type: 'link', url: `#ref-${part}`, children: [{ type: 'text', value: part }] }
            : { type: 'text', value: part }
        )
      }
      projected.push({ type: 'text', value: ']' })
    }
    cursor = match.index + match[0].length
  }
  if (!projected.length) return null
  if (cursor < value.length) projected.push({ type: 'text', value: value.slice(cursor) })
  return projected
}

function projectCitationNodes(
  node: CitationMarkdownNode,
  references: Set<string>
): void {
  if (!node.children || ['link', 'linkReference', 'inlineCode', 'code', 'html'].includes(node.type))
    return
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text')
      return projectCitationText(child.value ?? '', references) ?? [child]
    projectCitationNodes(child, references)
    return [child]
  })
}

export function projectNumericCitations(tree: CitationMarkdownNode): void {
  const blocks = tree.children
  if (!blocks) return
  const headingIndex = blocks.findIndex(
    (block) => block.type === 'heading' && REFERENCE_HEADING.test(markdownText(block).trim())
  )
  if (headingIndex < 0) return
  const headingDepth = blocks[headingIndex].depth ?? 6
  const references = new Set<string>()
  for (let index = headingIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type === 'heading' && (block.depth ?? 6) <= headingDepth) break
    const first = block.type === 'paragraph' ? block.children?.[0] : null
    const reference = first?.type === 'text' ? NUMERIC_REFERENCE.exec(first.value ?? '') : null
    if (!reference || references.has(reference[1])) continue
    references.add(reference[1])
  }
  if (!references.size) return
  for (const block of blocks.slice(0, headingIndex)) projectCitationNodes(block, references)
}

export const numericCitationPlugin = $remark(
  'workbenchNumericCitations',
  () => () => (tree) => projectNumericCitations(tree)
)

export function configureCitationLinks(ctx: Ctx): void {
  ctx.update(linkAttr.key, (previous) => (mark) => {
    const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : ''
    return {
      ...previous(mark),
      [DOCUMENT_LINK_ATTRIBUTE]: href,
      contenteditable: 'false',
      tabindex: 0,
    }
  })
}

export function editDocumentLink(ctx: Ctx): void {
  const view = ctx.get(editorViewCtx)
  const { selection } = view.state
  const parent = selection.$from.parent
  const offset = selection.$from.parentOffset
  const children = Array.from({ length: parent.childCount }, (_, index) => parent.child(index))
  const after = parent.childAfter(offset)
  const before = parent.childBefore(offset)
  const type = linkSchema.type(ctx)
  const afterMark = after.node && type.isInSet(after.node.marks)
  const mark = afterMark || (before.node && type.isInSet(before.node.marks))
  const selected = afterMark ? after.index : before.index
  if (!mark) {
    ctx.get(linkTooltipAPI.key).addLink(selection.from, selection.to)
    return
  }
  let first = selected
  let last = selected
  while (first > 0 && mark.isInSet(children[first - 1].marks)) first -= 1
  while (last + 1 < children.length && mark.isInSet(children[last + 1].marks)) last += 1
  const from =
    selection.$from.start() +
    children.slice(0, first).reduce((total, node) => total + node.nodeSize, 0)
  const to =
    from + children.slice(first, last + 1).reduce((total, node) => total + node.nodeSize, 0)
  ctx.get(linkTooltipAPI.key).editLink(mark, from, to)
}
