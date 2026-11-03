import { sourceLeaf } from '../../components/markdown/source.ts'

/** Resolve whitespace-only visual/source differences without guessing an occurrence. */
export function whitespaceSelection(
  source: string,
  selected: string
): { start: number; end: number } | null {
  const offsets: number[] = []
  let compact = ''
  for (let index = 0; index < source.length; index++) {
    if (/\s/u.test(source[index])) continue
    offsets.push(index)
    compact += source[index]
  }
  const needle = selected.replace(/\s/gu, '')
  if (!needle) return null
  const start = compact.indexOf(needle)
  if (start < 0 || compact.indexOf(needle, start + 1) >= 0) return null
  return { start: offsets[start], end: offsets[start + needle.length - 1] + 1 }
}

export interface MarkdownSyntaxNode {
  type: string
  value?: unknown
  children?: MarkdownSyntaxNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

type SourceLeafKind = Parameters<typeof sourceLeaf>[4]

/** Syntax leaves whose rendered characters have a character-exact source decoder. */
const TEXT_LEAF_KIND = 'text'
const EXACT_LEAF_KINDS: Readonly<Record<string, SourceLeafKind>> = {
  text: TEXT_LEAF_KIND,
  inlineCode: 'inline-code',
  code: 'fenced-code',
}
const FENCED_CODE_KIND: SourceLeafKind = 'fenced-code'
const FENCED_CODE_TERMINATOR = '\n'
const WHITESPACE = /\s/u

interface MappedLeaf {
  value: string
  start: number
  end: number
  boundaries: Array<number | null> | null
  leadingControls: MarkdownSourceSegment[]
  trailingControls: MarkdownSourceSegment[]
}

function leafBoundaries(
  source: string,
  node: MarkdownSyntaxNode,
  value: string,
  start: number,
  end: number
): Array<number | null> | null {
  const kind = EXACT_LEAF_KINDS[node.type]
  if (!kind) return null
  // Fenced code content keeps its final line break in the source decoder's display model.
  const fenced = kind === FENCED_CODE_KIND
  const expected = fenced && value ? value + FENCED_CODE_TERMINATOR : value
  const leaf = sourceLeaf(source, expected, start, end, kind)
  return leaf ? leaf.boundaries.slice(0, value.length + 1) : null
}

function uncoveredSegments(
  start: number,
  end: number,
  covered: MarkdownSourceSegment[]
): MarkdownSourceSegment[] {
  const segments: MarkdownSourceSegment[] = []
  let cursor = start
  for (const segment of [...covered].sort((left, right) => left.start - right.start)) {
    if (segment.end <= cursor || segment.start >= end) continue
    if (segment.start > cursor) segments.push({ start: cursor, end: Math.min(segment.start, end) })
    cursor = Math.max(cursor, Math.min(segment.end, end))
  }
  if (cursor < end) segments.push({ start: cursor, end })
  return segments.filter((segment) => segment.start < segment.end)
}

function syntaxLeaves(source: string, tree: MarkdownSyntaxNode): MappedLeaf[] {
  const leaves: MappedLeaf[] = []
  const visit = (node: MarkdownSyntaxNode, ancestorControls: MarkdownSourceSegment[]): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    const positioned = start !== undefined && end !== undefined
    if (typeof node.value === 'string' && positioned) {
      const boundaries = leafBoundaries(source, node, node.value, start, end)
      const numericBoundaries =
        boundaries?.filter((boundary): boundary is number => boundary !== null) ?? []
      const contentStart = numericBoundaries[0] ?? start
      const contentEnd = numericBoundaries.at(-1) ?? end
      const controls = [
        ...ancestorControls,
        ...uncoveredSegments(start, end, [{ start: contentStart, end: contentEnd }]),
      ]
      leaves.push({
        value: node.value,
        start,
        end,
        boundaries,
        leadingControls: controls.filter((segment) => segment.end <= contentStart),
        trailingControls: controls.filter((segment) => segment.start >= contentEnd),
      })
      return
    }
    const children = node.children ?? []
    const firstChildStart = children[0]?.position?.start.offset
    const lastChildEnd = children.at(-1)?.position?.end.offset
    const boundaryControls =
      positioned && firstChildStart !== undefined && lastChildEnd !== undefined
        ? [
            { start, end: firstChildStart },
            { start: lastChildEnd, end },
          ].filter((segment) => segment.start < segment.end)
        : []
    const controls = [...ancestorControls, ...boundaryControls]
    children.forEach((child) => visit(child, controls))
  }
  // The document root is not markup of its first or last block.
  tree.children?.forEach((child) => visit(child, []))
  return leaves
}

interface LeafPoint {
  leaf: MappedLeaf
  index: number
}

export interface MarkdownSourceSegment {
  start: number
  end: number
}

export interface MarkdownSourceRange {
  start: number
  end: number
  segments: MarkdownSourceSegment[]
  text: string
}

/** Align rendered characters with syntax leaf values, tolerating renderer-only whitespace. */
function renderedPoints(leaves: MappedLeaf[], rendered: string): Array<LeafPoint | null> | null {
  const points: Array<LeafPoint | null> = []
  let leafIndex = 0
  let valueIndex = 0
  for (const character of rendered.split('')) {
    const whitespace = WHITESPACE.test(character)
    let point: LeafPoint | null = null
    while (leafIndex < leaves.length) {
      const leaf = leaves[leafIndex]
      let probe = valueIndex
      while (
        probe < leaf.value.length &&
        leaf.value[probe] !== character &&
        WHITESPACE.test(leaf.value[probe])
      )
        probe++
      if (probe < leaf.value.length && leaf.value[probe] === character) {
        point = { leaf, index: probe }
        valueIndex = probe + 1
        break
      }
      if (probe >= leaf.value.length) {
        leafIndex++
        valueIndex = 0
        continue
      }
      // Hard breaks and similar renderer-only separators have no source leaf value.
      if (whitespace) break
      // Syntax the renderer stores as attributes (for example removed HTML) never reaches the text stream.
      if (valueIndex === 0) {
        leafIndex++
        continue
      }
      return null
    }
    if (!point && !whitespace) return null
    points.push(point)
  }
  return points
}

function selectedLeadingBoundary(point: LeafPoint): number | null {
  const boundaries = point.leaf.boundaries
  if (!boundaries) return point.index === 0 ? point.leaf.start : null
  for (let index = point.index; index >= 0; index--) {
    const boundary = boundaries[index]
    if (boundary !== null) return boundary
  }
  return null
}

function selectedTrailingBoundary(point: LeafPoint): number | null {
  const boundaries = point.leaf.boundaries
  if (!boundaries) return point.index === point.leaf.value.length - 1 ? point.leaf.end : null
  for (let index = point.index + 1; index < boundaries.length; index++) {
    const boundary = boundaries[index]
    if (boundary !== null) return boundary
  }
  return null
}

function coalescedSegments(
  positions: Array<{ start: number; end: number }>
): MarkdownSourceSegment[] {
  const segments: MarkdownSourceSegment[] = []
  for (const position of positions) {
    const previous = segments.at(-1)
    if (previous?.end === position.start) previous.end = position.end
    else segments.push({ ...position })
  }
  return segments
}

function joinedSource(source: string, segments: MarkdownSourceSegment[]): string {
  return segments.map((segment) => source.slice(segment.start, segment.end)).join('')
}

function completedSegments(
  first: LeafPoint,
  last: LeafPoint,
  selectedStart: number,
  selectedEnd: number
): MarkdownSourceSegment[] {
  return coalescedSegments(
    [
      ...first.leaf.leadingControls.filter((segment) => segment.end <= selectedStart),
      { start: selectedStart, end: selectedEnd },
      ...last.leaf.trailingControls.filter((segment) => segment.start >= selectedEnd),
    ].sort((left, right) => left.start - right.start)
  )
}

/**
 * Map a rendered-text interval to its exact Markdown source range.
 *
 * `rendered` is the rendered document text from its beginning through the selection end;
 * `from`/`to` are UTF-16 offsets into it. Control markers are completed around the selected
 * content without including unselected rendered text.
 */
export function markdownSourceRange(
  source: string,
  tree: MarkdownSyntaxNode,
  rendered: string,
  from: number,
  to: number
): MarkdownSourceRange | null {
  if (from < 0 || to > rendered.length || from >= to) return null
  const points = renderedPoints(syntaxLeaves(source, tree), rendered)
  if (!points) return null
  const selected = points.slice(from, to)
  const first = selected.find((point) => point !== null)
  const last = [...selected].reverse().find((point) => point !== null)
  if (!first || !last) return null
  const selectedStart = selectedLeadingBoundary(first)
  const selectedEnd = selectedTrailingBoundary(last)
  if (selectedStart === null || selectedEnd === null || selectedStart >= selectedEnd) return null
  const segments = completedSegments(first, last, selectedStart, selectedEnd)
  if (!segments?.length) return null
  return {
    start: segments[0].start,
    end: segments.at(-1)?.end ?? segments[0].end,
    segments,
    text: joinedSource(source, segments),
  }
}
