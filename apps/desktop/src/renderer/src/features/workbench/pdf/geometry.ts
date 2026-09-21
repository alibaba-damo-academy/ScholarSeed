export interface Rectangle { left: number; top: number; right: number; bottom: number }
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface TextMatch { start: number; end: number }
export type PdfFitMode = 'page' | 'width' | 'custom'
export const MIN_SCALE = 0.1
export const MAX_SCALE = 5
export const SCALE_STEP = 0.25
export const PAGE_GUTTER = 32
export const THUMBNAIL_WIDTH = 112
const CITATION_LINE_GAP = 2
const SAME_LINE_OVERLAP = 0.8
const SAME_LINE_CENTER_OFFSET = 0.5
const LINE_FRAGMENT_GAP = 0.5
const CJK_SHAPE_MARKER = '中'
const CJK_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2fff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
  [0x30000, 0x323af]
]

interface MarkGeometry {
  created_at: number
  id: string
  quads: readonly number[][]
  style: string
}

export interface ProjectedMark<T extends MarkGeometry> {
  mark: T
  quads: number[][]
}

function sameTextLine(left: readonly number[], right: readonly number[]): boolean {
  const overlap = Math.min(left[3], right[3]) - Math.max(left[1], right[1])
  const height = Math.min(left[3] - left[1], right[3] - right[1])
  const centerOffset = Math.abs((left[1] + left[3] - right[1] - right[3]) / 2)
  return overlap >= SAME_LINE_OVERLAP * height && centerOffset <= SAME_LINE_CENTER_OFFSET * height
}

function subtractLineCoverage(quad: readonly number[], covered: readonly number[]): number[][] {
  if (!sameTextLine(quad, covered)) return [[...quad]]
  const overlapLeft = Math.max(quad[0], covered[0])
  const overlapRight = Math.min(quad[2], covered[2])
  if (overlapRight <= overlapLeft) return [[...quad]]
  const visible: number[][] = []
  if (quad[0] < overlapLeft) visible.push([quad[0], quad[1], overlapLeft, quad[3]])
  if (overlapRight < quad[2]) visible.push([overlapRight, quad[1], quad[2], quad[3]])
  return visible
}

/** Preserve selection structure while tolerating incompatible CJK ToUnicode maps. */
export function pdfSelectionShape(text: string): string {
  return Array.from(text, character => {
    const point = character.codePointAt(0)!
    return CJK_CODE_POINT_RANGES.some(([first, last]) => point >= first && point <= last)
      ? CJK_SHAPE_MARKER
      : character
  }).join('')
}

/** Consecutive text rectangles in one column form a navigable evidence region. */
export function citationRegions(quads: readonly number[][]): number[][][] {
  const regions: number[][][] = []
  for (const quad of quads) {
    const region = regions.at(-1)
    const previous = region?.at(-1)
    const adjacent = previous && Math.min(previous[2], quad[2]) > Math.max(previous[0], quad[0])
      && Math.abs(quad[1] - previous[3]) <= CITATION_LINE_GAP * Math.max(previous[3] - previous[1], quad[3] - quad[1])
    if (region && adjacent) region.push(quad)
    else regions.push([quad])
  }
  return regions
}

export function enclosingRectangle(rectangles: readonly Rectangle[]): Rectangle | undefined {
  if (!rectangles.length) return undefined
  return {
    left: Math.min(...rectangles.map(rect => rect.left)), top: Math.min(...rectangles.map(rect => rect.top)),
    right: Math.max(...rectangles.map(rect => rect.right)), bottom: Math.max(...rectangles.map(rect => rect.bottom))
  }
}

export function nearestRectangle(rectangles: readonly Rectangle[], point: Point): Rectangle | undefined {
  let nearest: Rectangle | undefined
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const rectangle of rectangles) {
    if (![rectangle.left, rectangle.top, rectangle.right, rectangle.bottom].every(Number.isFinite)
      || rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top) continue
    const horizontal = point.x < rectangle.left
      ? rectangle.left - point.x
      : point.x > rectangle.right
        ? point.x - rectangle.right
        : 0
    const vertical = point.y < rectangle.top
      ? rectangle.top - point.y
      : point.y > rectangle.bottom
        ? point.y - rectangle.bottom
        : 0
    const distance = horizontal * horizontal + vertical * vertical
    if (distance < nearestDistance) {
      nearest = rectangle
      nearestDistance = distance
    }
  }
  return nearest
}

export function pageNumber(value: string | number, total: number): number {
  const number = Number(value)
  return Math.min(Math.max(1, Number.isFinite(number) ? Math.trunc(number) : 1), Math.max(1, total))
}
export function pageInSelectionSpan(page: number, anchor: number, focus: number): boolean {
  return page >= Math.min(anchor, focus) && page <= Math.max(anchor, focus)
}
export function fittedScale(mode: 'page' | 'width', page: Size, viewport: Size): number {
  const width = viewport.width / page.width
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, mode === 'width' ? width : Math.min(width, viewport.height / page.height)))
}
export function nextFitMode(mode: PdfFitMode): Exclude<PdfFitMode, 'custom'> {
  return mode === 'width' ? 'page' : 'width'
}
export function percentScale(value: string, fallback: number): number {
  const percent = Number(value.trim().replace(/%$/, '').trim())
  if (!Number.isFinite(percent)) return fallback
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, percent / 100))
}
export function matchText(text: string, query: string): TextMatch[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  return Array.from(text.matchAll(new RegExp(pattern, 'giu')), match => ({ start: match.index!, end: match.index! + match[0].length }))
}
export function clipQuads(rects: Rectangle[], bounds: Rectangle): number[][] {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  if (width <= 0 || height <= 0) return []
  return rects.flatMap(rect => {
    const left = Math.max(rect.left, bounds.left)
    const right = Math.min(rect.right, bounds.right)
    const top = Math.max(rect.top, bounds.top)
    const bottom = Math.min(rect.bottom, bounds.bottom)
    return right > left && bottom > top ? [[(left - bounds.left) / width, (top - bounds.top) / height, (right - bounds.left) / width, (bottom - bounds.top) / height]] : []
  })
}

/** Union overlapping fragments of a single mark, without filling column gaps. */
export function normalizeQuads(quads: readonly number[][]): number[][] {
  const result: number[][] = []
  for (const quad of quads) {
    if (!quad.every(Number.isFinite) || quad[2] <= quad[0] || quad[3] <= quad[1]) continue
    let merged = [...quad]
    for (let index = 0; index < result.length;) {
      const previous = result[index]
      const gap = Math.max(previous[0], merged[0]) - Math.min(previous[2], merged[2])
      const height = Math.min(previous[3] - previous[1], merged[3] - merged[1])
      if (sameTextLine(previous, merged) && gap <= LINE_FRAGMENT_GAP * height) {
        merged = [Math.min(previous[0], merged[0]), Math.min(previous[1], merged[1]), Math.max(previous[2], merged[2]), Math.max(previous[3], merged[3])]
        result.splice(index, 1)
        index = 0
      } else index++
    }
    result.push(merged)
  }
  return result.sort((left, right) => left[1] - right[1] || left[0] - right[0])
}

/** Newer marks own same-style overlap while every persisted mark remains unchanged. */
export function projectVisibleMarks<T extends MarkGeometry>(marks: readonly T[]): Array<ProjectedMark<T>> {
  const coveredByStyle = new Map<string, number[][]>()
  const ordered = [...marks].sort((left, right) =>
    right.created_at - left.created_at || right.id.localeCompare(left.id)
  )
  const projected: Array<ProjectedMark<T>> = []
  for (const mark of ordered) {
    const normalized = normalizeQuads(mark.quads)
    const covered = coveredByStyle.get(mark.style) ?? []
    const visible = normalized.flatMap(quad =>
      covered.reduce<number[][]>((fragments, cover) =>
        fragments.flatMap(fragment => subtractLineCoverage(fragment, cover)), [quad]
      )
    )
    if (visible.length) projected.push({ mark, quads: visible })
    coveredByStyle.set(mark.style, [...covered, ...normalized])
  }
  return projected
}

/** Read only selected glyph ranges: Range.getClientRects also includes enclosing spans. */
export function selectionRectangles(range: Range, layer: HTMLElement): Rectangle[] {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  const rectangles: Rectangle[] = []
  let node = walker.nextNode()
  while (node) {
    if (range.intersectsNode(node) && node.textContent?.length) {
      const part = document.createRange()
      part.selectNodeContents(node)
      if (range.startContainer === node) part.setStart(node, range.startOffset)
      if (range.endContainer === node) part.setEnd(node, range.endOffset)
      rectangles.push(...Array.from(part.getClientRects()))
    }
    node = walker.nextNode()
  }
  return rectangles
}

export function selectionPageText(selectionText: string, clippedText: string, withinPage: boolean): string {
  return (withinPage ? selectionText : clippedText).trim()
}

export function mostVisiblePage(pages: readonly { page: number; top: number; bottom: number }[], viewport: { top: number; bottom: number }): number | undefined {
  let selected: number | undefined
  let largest = 0
  for (const page of pages) {
    const visible = Math.max(0, Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top))
    if (visible > largest) { largest = visible; selected = page.page }
  }
  return selected
}
