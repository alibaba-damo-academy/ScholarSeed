export interface Rectangle {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Point {
  x: number
  y: number
}
export interface Size {
  width: number
  height: number
}

export function commentPinPosition(
  point: readonly [number, number],
  page: Size,
  size: number,
  text: readonly Rectangle[]
): Point {
  const clampX = (value: number): number => Math.max(0, Math.min(page.width - size, value))
  const clampY = (value: number): number => Math.max(0, Math.min(page.height - size, value))
  const origin = { x: clampX(point[0] * page.width), y: clampY(point[1] * page.height) }
  const candidates = [
    origin,
    ...text.flatMap((rect) => [
      { x: clampX(rect.right), y: origin.y },
      { x: clampX(rect.left - size), y: origin.y },
      { x: origin.x, y: clampY(rect.bottom) },
      { x: origin.x, y: clampY(rect.top - size) },
    ]),
  ]
  const clear = candidates.filter(
    (candidate) =>
      !text.some(
        (rect) =>
          candidate.x < rect.right &&
          candidate.x + size > rect.left &&
          candidate.y < rect.bottom &&
          candidate.y + size > rect.top
      )
  )
  clear.sort(
    (left, right) =>
      Math.hypot(left.x - origin.x, left.y - origin.y) -
      Math.hypot(right.x - origin.x, right.y - origin.y)
  )
  return clear[0] ?? { x: page.width, y: origin.y }
}
export interface TextMatch {
  start: number
  end: number
}

export function commentRailPositions(
  anchors: readonly number[],
  height: number,
  size: number
): Point[] {
  const positions: Point[] = []
  let column = 0
  let bottom = 0
  for (const entry of anchors
    .map((anchor, index) => ({ anchor, index }))
    .sort((left, right) => left.anchor - right.anchor)) {
    const preferred = Math.max(0, Math.min(height - size, entry.anchor))
    let top = Math.max(bottom, preferred)
    if (top + size > height) {
      column += 1
      top = preferred
    }
    positions[entry.index] = { x: column * size, y: top }
    bottom = top + size
  }
  return positions
}

export function commentLayout({
  anchors,
  points,
  page,
  size,
  gap,
  text,
}: {
  anchors: readonly number[]
  points: readonly (readonly [number, number])[]
  page: Size
  size: number
  gap: number
  text: readonly Rectangle[]
}): { textPins: Point[]; pointPins: Point[]; railWidth: number } {
  const pointPins = points.map((point) => commentPinPosition(point, page, size, text))
  const outsidePoints = pointPins.flatMap((point, index) =>
    point.x >= page.width ? [{ index, anchor: point.y }] : []
  )
  const rail = commentRailPositions(
    [...anchors, ...outsidePoints.map(({ anchor }) => anchor)],
    page.height,
    size
  )
  const positions = rail.map((point) => ({ x: page.width + gap + point.x, y: point.y }))
  outsidePoints.forEach(({ index }, ordinal) => {
    pointPins[index] = positions[anchors.length + ordinal]
  })
  return {
    textPins: positions.slice(0, anchors.length),
    pointPins,
    railWidth: rail.length ? Math.max(...rail.map((point) => point.x)) + size + gap * 2 : 0,
  }
}
export type PdfFitMode = 'page' | 'width' | 'custom'
export const MIN_SCALE = 0.1
export const MAX_SCALE = 5
export const SCALE_STEP = 0.25
export const PAGE_GUTTER = 32
export const PDF_WIDE_TRANSLATION_MIN_WIDTH = 1400
export const PDF_WIDE_TRANSLATION_GUTTER = 40 * 2
export const THUMBNAIL_WIDTH = 120
export const THUMBNAIL_HEIGHT = 160
export const PDF_TRANSLATION_WIDTH_STATE_KEY = 'translationWidthRatio'
export const PDF_TRANSLATION_MIN_RATIO = 1 / 4
export const PDF_TRANSLATION_MAX_RATIO = 2
const PDF_TRANSLATION_DEFAULT_RATIO = 2 / 3
const PDF_TRANSLATION_RESIZE_PASSES = 32
const CITATION_LINE_GAP = 2
const SAME_LINE_OVERLAP = 0.8
const SAME_LINE_CENTER_OFFSET = 0.5
const MAX_NEIGHBOR_LINE_OVERLAP = 0.25
const LINE_FRAGMENT_GAP = 0.5
const CJK_SHAPE_MARKER = '中'
const PDF_DISCRETIONARY_HYPHEN = '\u0002'
const CJK_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2fff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
  [0x30000, 0x323af],
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
  return Array.from(text, (character) => {
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
    const adjacent =
      previous &&
      Math.min(previous[2], quad[2]) > Math.max(previous[0], quad[0]) &&
      Math.abs(quad[1] - previous[3]) <=
        CITATION_LINE_GAP * Math.max(previous[3] - previous[1], quad[3] - quad[1])
    if (region && adjacent) region.push(quad)
    else regions.push([quad])
  }
  return regions
}

export function enclosingRectangle(rectangles: readonly Rectangle[]): Rectangle | undefined {
  if (!rectangles.length) return undefined
  return {
    left: Math.min(...rectangles.map((rect) => rect.left)),
    top: Math.min(...rectangles.map((rect) => rect.top)),
    right: Math.max(...rectangles.map((rect) => rect.right)),
    bottom: Math.max(...rectangles.map((rect) => rect.bottom)),
  }
}

export function nearestRectangle(
  rectangles: readonly Rectangle[],
  point: Point
): Rectangle | undefined {
  let nearest: Rectangle | undefined
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const rectangle of rectangles) {
    if (
      ![rectangle.left, rectangle.top, rectangle.right, rectangle.bottom].every(Number.isFinite) ||
      rectangle.right <= rectangle.left ||
      rectangle.bottom <= rectangle.top
    )
      continue
    const horizontal =
      point.x < rectangle.left
        ? rectangle.left - point.x
        : point.x > rectangle.right
          ? point.x - rectangle.right
          : 0
    const vertical =
      point.y < rectangle.top
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
  return Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, mode === 'width' ? width : Math.min(width, viewport.height / page.height))
  )
}
export function nextFitMode(mode: PdfFitMode): Exclude<PdfFitMode, 'custom'> {
  return mode === 'width' ? 'page' : 'width'
}

export function translationWidthRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(PDF_TRANSLATION_MIN_RATIO, Math.min(PDF_TRANSLATION_MAX_RATIO, value))
    : PDF_TRANSLATION_DEFAULT_RATIO
}

export function translationSpreadSize(page: Size, ratio: number): Size {
  return { width: page.width * (1 + ratio), height: page.height }
}

export interface PdfTranslationResize {
  page: Size
  viewport: Size
  mode: PdfFitMode
  ratio: number
  scale: number
}

export function resizePdfTranslation(
  initial: PdfTranslationResize,
  offset: number
): { ratio: number; scale: number } {
  const { page, viewport, mode, ratio, scale } = initial
  if (!Number.isFinite(offset) || offset === 0) return { ratio, scale }
  if (mode === 'custom') {
    const totalScale = scale * (1 + ratio)
    const minRatio = Math.max(PDF_TRANSLATION_MIN_RATIO, totalScale / MAX_SCALE - 1)
    const maxRatio = Math.min(PDF_TRANSLATION_MAX_RATIO, totalScale / MIN_SCALE - 1)
    const sourceWidth = Math.max(page.width * MIN_SCALE, page.width * scale + offset)
    const nextRatio = Math.max(
      minRatio,
      Math.min(maxRatio, (page.width * totalScale) / sourceWidth - 1)
    )
    return { ratio: nextRatio, scale: totalScale / (1 + nextRatio) }
  }
  const target = (page.width * scale * (1 - ratio)) / 2 + offset
  let lower = PDF_TRANSLATION_MIN_RATIO
  let upper = PDF_TRANSLATION_MAX_RATIO
  for (let pass = 0; pass < PDF_TRANSLATION_RESIZE_PASSES; pass += 1) {
    const candidate = (lower + upper) / 2
    const candidateScale = fittedScale(mode, translationSpreadSize(page, candidate), viewport)
    const divider = (page.width * candidateScale * (1 - candidate)) / 2
    if (divider > target) lower = candidate
    else upper = candidate
  }
  const nextRatio = (lower + upper) / 2
  return {
    ratio: nextRatio,
    scale: fittedScale(mode, translationSpreadSize(page, nextRatio), viewport),
  }
}
export function percentScale(value: string, fallback: number): number {
  const percent = Number(value.trim().replace(/%$/, '').trim())
  if (!Number.isFinite(percent)) return fallback
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, percent / 100))
}
export function matchText(text: string, query: string): TextMatch[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  return Array.from(text.matchAll(new RegExp(pattern, 'giu')), (match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }))
}
function readingText(text: string): { value: string; offsets: number[] } {
  let value = ''
  const offsets: number[] = []
  for (let position = 0; position < text.length; position++) {
    const character = text[position]
    if (/\s/u.test(character)) continue
    const folded = character === PDF_DISCRETIONARY_HYPHEN ? '-' : character.toLowerCase()
    value += folded
    for (let unit = 0; unit < folded.length; unit++) offsets.push(position)
  }
  return { value, offsets }
}
export function matchReadingText(text: string, query: string): TextMatch[] {
  const source = readingText(text)
  const needle = readingText(query).value
  if (!needle) return []
  const matches: TextMatch[] = []
  let position = source.value.indexOf(needle)
  while (position !== -1) {
    matches.push({
      start: source.offsets[position],
      end: source.offsets[position + needle.length - 1] + 1,
    })
    position = source.value.indexOf(needle, position + needle.length)
  }
  return matches
}

export function searchQuads(
  host: HTMLElement,
  query: string,
  matcher = matchText
): { quad: number[]; ordinal: number }[] {
  const parts: { node: Text; start: number; end: number }[] = []
  let text = ''
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length
      text += node.textContent ?? ''
      parts.push({ node: node as Text, start, end: text.length })
    } else if ((node as Element).tagName === 'BR') text += '\n'
    node = walker.nextNode()
  }
  return matcher(text, query).flatMap((match, ordinal) => {
    const first = parts.find((part) => part.end > match.start)
    const last = parts.find((part) => part.end >= match.end)
    if (!first || !last) return []
    const range = document.createRange()
    range.setStart(first.node, Math.max(0, match.start - first.start))
    range.setEnd(last.node, Math.min(last.node.length, match.end - last.start))
    return clipQuads(Array.from(range.getClientRects()), host.getBoundingClientRect()).map(
      (quad) => ({ quad, ordinal })
    )
  })
}
export function clipQuads(rects: Rectangle[], bounds: Rectangle): number[][] {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  if (width <= 0 || height <= 0) return []
  return rects.flatMap((rect) => {
    const left = Math.max(rect.left, bounds.left)
    const right = Math.min(rect.right, bounds.right)
    const top = Math.max(rect.top, bounds.top)
    const bottom = Math.min(rect.bottom, bounds.bottom)
    return right > left && bottom > top
      ? [
          [
            (left - bounds.left) / width,
            (top - bounds.top) / height,
            (right - bounds.left) / width,
            (bottom - bounds.top) / height,
          ],
        ]
      : []
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
        merged = [
          Math.min(previous[0], merged[0]),
          Math.min(previous[1], merged[1]),
          Math.max(previous[2], merged[2]),
          Math.max(previous[3], merged[3]),
        ]
        result.splice(index, 1)
        index = 0
      } else index++
    }
    result.push(merged)
  }
  return result.sort((left, right) => left[1] - right[1] || left[0] - right[0])
}

function separateOverlappingLines(quads: number[][]): void {
  const ordered = [...quads].sort((left, right) => left[1] - right[1])
  for (let index = 0; index < ordered.length; index += 1) {
    const upper = ordered[index]
    for (let next = index + 1; next < ordered.length; next += 1) {
      const lower = ordered[next]
      if (lower[1] >= upper[3]) break
      if (
        Math.min(upper[2], lower[2]) <= Math.max(upper[0], lower[0]) ||
        sameTextLine(upper, lower)
      )
        continue
      const overlap = upper[3] - lower[1]
      const shorterHeight = Math.min(upper[3] - upper[1], lower[3] - lower[1])
      if (overlap >= MAX_NEIGHBOR_LINE_OVERLAP * shorterHeight) continue
      const boundary = (upper[3] + lower[1]) / 2
      if (boundary <= upper[1] || boundary >= lower[3]) continue
      upper[3] = boundary
      lower[1] = boundary
    }
  }
}

export function normalizeHighlightQuads(quads: readonly number[][]): number[][] {
  const normalized = normalizeQuads(quads)
  separateOverlappingLines(normalized)
  return normalized
}

/** Newer marks own same-style overlap while every persisted mark remains unchanged. */
export function projectVisibleMarks<T extends MarkGeometry>(
  marks: readonly T[]
): Array<ProjectedMark<T>> {
  const coveredByStyle = new Map<string, number[][]>()
  const ordered = [...marks].sort(
    (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id)
  )
  const projected: Array<ProjectedMark<T>> = []
  for (const mark of ordered) {
    const normalized =
      mark.style === 'highlight' ? normalizeHighlightQuads(mark.quads) : normalizeQuads(mark.quads)
    const covered = coveredByStyle.get(mark.style) ?? []
    const visible = normalized.flatMap((quad) =>
      covered.reduce<number[][]>(
        (fragments, cover) =>
          fragments.flatMap((fragment) => subtractLineCoverage(fragment, cover)),
        [quad]
      )
    )
    if (visible.length) projected.push({ mark, quads: visible })
    coveredByStyle.set(mark.style, [...covered, ...normalized])
  }
  separateOverlappingLines(
    projected.filter(({ mark }) => mark.style === 'highlight').flatMap(({ quads }) => quads)
  )
  return projected
}

function selectedTextOffsets(range: Range, node: Text): [number, number] | undefined {
  let start = 0
  let end = node.length
  while (start < end && range.comparePoint(node, start) < 0) start++
  while (end > start && range.comparePoint(node, end) > 0) end--
  return end > start ? [start, end] : undefined
}

function textOffsetBoundaries(text: string, start: number, end: number): number[] {
  const boundaries = [start]
  let offset = start
  for (const character of Array.from(text.slice(start, end))) {
    offset += character.length
    boundaries.push(offset)
  }
  return boundaries
}

/** Read only selected glyph ranges: Range.getClientRects also includes enclosing spans. */
export function selectionRectangles(range: Range, layer: HTMLElement): Rectangle[] {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  const rectangles: Rectangle[] = []
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text && range.intersectsNode(node) && node.textContent?.length) {
      const offsets = selectedTextOffsets(range, node)
      if (offsets) {
        const boundaries = textOffsetBoundaries(node.textContent, offsets[0], offsets[1])
        for (let index = 0; index < boundaries.length - 1; index += 1) {
          const part = document.createRange()
          part.setStart(node, boundaries[index])
          part.setEnd(node, boundaries[index + 1])
          rectangles.push(...Array.from(part.getClientRects()))
        }
      }
    }
    node = walker.nextNode()
  }
  return rectangles
}

export function selectionPageText(
  selectionText: string,
  clippedText: string,
  withinPage: boolean
): string {
  return (withinPage ? selectionText : clippedText).trim()
}

export function mostVisiblePage(
  pages: readonly { page: number; top: number; bottom: number }[],
  viewport: { top: number; bottom: number }
): number | undefined {
  let selected: number | undefined
  let largest = 0
  for (const page of pages) {
    const visible = Math.max(
      0,
      Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top)
    )
    if (visible > largest) {
      largest = visible
      selected = page.page
    }
  }
  return selected
}
