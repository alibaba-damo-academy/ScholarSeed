import type { Nodes } from 'mdast'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const STRONG_MARKERS = ['**', '__'] as const
const STRONG_MARKER_LENGTH = STRONG_MARKERS[0].length
const SOURCE_LINE_BREAK = /[\r\n]/
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly)

export interface StrongSegment {
  text: string
  strong?: boolean
}

export function strongSegments(source: string): StrongSegment[] {
  if (!STRONG_MARKERS.some((marker) => source.includes(marker))) return [{ text: source }]
  const ranges: { start: number; end: number }[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'strong') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (
        start !== undefined &&
        end !== undefined &&
        !SOURCE_LINE_BREAK.test(source.slice(start, end))
      )
        ranges.push({ start, end })
      return
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(parser.parse(source))
  const segments: StrongSegment[] = []
  let offset = 0
  for (const range of ranges) {
    if (range.start > offset) segments.push({ text: source.slice(offset, range.start) })
    segments.push({
      text: source.slice(range.start + STRONG_MARKER_LENGTH, range.end - STRONG_MARKER_LENGTH),
      strong: true,
    })
    offset = range.end
  }
  if (offset < source.length) segments.push({ text: source.slice(offset) })
  return segments
}
