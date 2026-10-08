import { linkAttr, linkSchema } from '@milkdown/kit/preset/commonmark'
import { editorViewCtx } from '@milkdown/kit/core'
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip'
import type { Ctx } from '@milkdown/kit/ctx'

import { DOCUMENT_LINK_ATTRIBUTE } from './links.ts'

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
