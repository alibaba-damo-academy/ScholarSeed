import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import type { PdfVisualRegion, PdfVisualRegionKind } from './analysis.ts'

export type Bounds = [number, number, number, number]
export interface RegionText {
  quad: Bounds
  text: string
  size: number
}
const POLICY = {
  backgroundArea: 0.85,
  minimumWidth: 0.08,
  minimumHeight: 12,
  graphicsGap: 8,
  labelFontGap: 3,
  lineOverlap: 0.45,
  wordGap: 4,
  proseWords: 6,
  captionGap: 48,
  formulaOperators: 2,
  formulaProseWords: 4,
  formulaBand: 1.5,
  equationBand: 0.8,
  proseCjkCharacters: 12,
  formulaWidth: 0.12,
  tableRows: 3,
  rowAlignment: 3,
  rowHeight: 24,
  pageRuleWidth: 0.75,
  ruleThickness: 1,
  glyphGap: 36,
  captionLineGap: 1.5,
  minimumRowHeight: 2,
  tableRules: 3,
  tableColumns: 2,
  tableCellGap: 1.5,
  tableColumnGap: 3,
  shortFormulaCenter: 0.08,
  formulaWhitespace: 1.5,
  formulaIdentifiers: 2,
} as const
const CAPTION = /^\s*(fig(?:ure)?s?\.?|tables?|图|表)\s*(?:[A-Z]?\d+|[IVX]+)(?:\b|[.:：、])/i
const EQUATION_NUMBER = /^\s*\(\d+(?:[.-]\d+)*\)\s*$/
const RELATION = /[=<>≤≥≈≠∈∼∝→⇒⇔]/u
const LARGE_OPERATOR = /[∑∏∫√]/u
const OPERATOR = /[=+−\-*/^_|<>≤≥≈≠∑∏∫√∞∂∇]/gu
const PROSE_WORD = /[A-Za-z]{3,}/g
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const LIST_ITEM = /^\s*(?:[●•▪◦‣]|[-–]\s|\(?\d+[.)]\s)/u
const MATH_WORD =
  /^(?:var|cov|exp|log|ln|sin|cos|tan|sec|csc|cot|lim|max|min|sup|inf|det|tr|arg|abs|erf)$/i
const FLOW_ARROW = /[→⇒⇔]/u
const NON_MATH_TEXT = /\b(?:where|which|when|because|instead|const|let|return)\b|[;{}]/i
const TABLE_CAPTION = /^(?:tables?|表)/i
const validBounds = (quad: Bounds): boolean =>
  quad.every(Number.isFinite) && quad[0] <= quad[2] && quad[1] <= quad[3]
const mathematical = (value: string, numbered = false): boolean => {
  if (LIST_ITEM.test(value) || NON_MATH_TEXT.test(value) || value.match(CJK_CHARACTER)?.length)
    return false
  const identifiers = new Set(
    (value.match(PROSE_WORD) ?? []).filter(
      (word) => !MATH_WORD.test(word) && word !== word.toUpperCase()
    )
  )
  return numbered || identifiers.size <= POLICY.formulaIdentifiers
}
const union = (left: Bounds, right: Bounds): Bounds => [
  Math.min(left[0], right[0]),
  Math.min(left[1], right[1]),
  Math.max(left[2], right[2]),
  Math.max(left[3], right[3]),
]
const area = (quad: Bounds): number => (quad[2] - quad[0]) * (quad[3] - quad[1])
const gap = (left: Bounds, right: Bounds): [number, number] => [
  Math.max(0, left[0] - right[2], right[0] - left[2]),
  Math.max(0, left[1] - right[3], right[1] - left[3]),
]
const inside = (inner: Bounds, outer: Bounds): boolean =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
const intersects = (left: Bounds, right: Bounds): boolean =>
  left[0] < right[2] && right[0] < left[2] && left[1] < right[3] && right[1] < left[3]
const prose = (line: RegionText): boolean =>
  (line.text.match(PROSE_WORD)?.length ?? 0) >= POLICY.proseWords ||
  (line.text.match(CJK_CHARACTER)?.length ?? 0) >= POLICY.proseCjkCharacters

type Matrix = number[]
const IDENTITY = [1, 0, 0, 1, 0, 0]
function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

export function paintedGraphics(
  operations: { fnArray: number[]; argsArray: unknown[][] },
  images: ArrayLike<number> | null,
  view: { width: number; height: number; transform: number[] },
  codes: {
    save: number
    restore: number
    transform: number
    constructPath: number
    paintFormXObjectBegin: number
    paintFormXObjectEnd: number
    beginGroup: number
    endGroup: number
    setLineWidth: number
    stroke: number
    closeStroke: number
    fill: number
    eoFill: number
    fillStroke: number
    eoFillStroke: number
    closeFillStroke: number
    closeEOFillStroke: number
    clip: number
    eoClip: number
    beginMarkedContent: number
    beginMarkedContentProps: number
    endMarkedContent: number
  }
): Bounds[] {
  const output: Bounds[] = []
  let matrix = IDENTITY
  let clip: Bounds = [0, 0, 1, 1]
  let lineWidth = 1
  let pendingClip = false
  const marked: boolean[] = []
  const stack: { matrix: Matrix; clip: Bounds; lineWidth: number }[] = []
  const strokes = new Set([
    codes.stroke,
    codes.closeStroke,
    codes.fillStroke,
    codes.eoFillStroke,
    codes.closeFillStroke,
    codes.closeEOFillStroke,
  ])
  const paints = new Set([...strokes, codes.fill, codes.eoFill])
  const project = (bounds: ArrayLike<number>, outset = 0): Bounds => {
    const transform = multiply(view.transform, matrix)
    const points = [bounds[0] - outset, bounds[2] + outset].flatMap((horizontal) =>
      [bounds[1] - outset, bounds[3] + outset].map((vertical) => [
        transform[0] * horizontal + transform[2] * vertical + transform[4],
        transform[1] * horizontal + transform[3] * vertical + transform[5],
      ])
    )
    return [
      Math.max(clip[0], Math.min(...points.map((point) => point[0])) / view.width),
      Math.max(clip[1], Math.min(...points.map((point) => point[1])) / view.height),
      Math.min(clip[2], Math.max(...points.map((point) => point[0])) / view.width),
      Math.min(clip[3], Math.max(...points.map((point) => point[1])) / view.height),
    ]
  }
  for (let index = 0; index < operations.fnArray.length; index++) {
    const operation = operations.fnArray[index]
    const args = operations.argsArray[index]
    if (
      operation === codes.save ||
      operation === codes.paintFormXObjectBegin ||
      operation === codes.beginGroup
    ) {
      stack.push({ matrix, clip, lineWidth })
      const transform =
        operation === codes.paintFormXObjectBegin
          ? args[0]
          : operation === codes.beginGroup
            ? (args[0] as { matrix?: Matrix }).matrix
            : null
      if (Array.isArray(transform)) matrix = multiply(matrix, transform)
      const bounds =
        operation === codes.paintFormXObjectBegin
          ? args[1]
          : operation === codes.beginGroup
            ? (args[0] as { bbox?: Bounds }).bbox
            : null
      if (bounds) clip = project(bounds as Bounds)
    } else if (
      operation === codes.restore ||
      operation === codes.paintFormXObjectEnd ||
      operation === codes.endGroup
    ) {
      const previous = stack.pop()
      if (previous) ({ matrix, clip, lineWidth } = previous)
    } else if (operation === codes.transform) matrix = multiply(matrix, args as Matrix)
    else if (operation === codes.setLineWidth) lineWidth = Number(args[0])
    else if (operation === codes.clip || operation === codes.eoClip) pendingClip = true
    else if (operation === codes.beginMarkedContent || operation === codes.beginMarkedContentProps)
      marked.push(args[0] === 'OC')
    else if (operation === codes.endMarkedContent) marked.pop()
    else if (operation === codes.constructPath) {
      const bounds = args[2] as ArrayLike<number> | null
      if (!bounds || bounds.length !== 4) continue
      const paint = Number(args[0])
      const quad = project(bounds, strokes.has(paint) ? lineWidth / 2 : 0)
      if (
        paints.has(paint) &&
        !marked.includes(true) &&
        quad.every(Number.isFinite) &&
        quad[0] <= quad[2] &&
        quad[1] <= quad[3]
      )
        output.push(quad)
      if (pendingClip) {
        clip = project(bounds)
        pendingClip = false
      }
    }
  }
  for (let index = 0; images && index + 5 < images.length; index += 6) {
    const horizontal = [
      images[index],
      images[index + 2],
      images[index + 4],
      images[index + 2] + images[index + 4] - images[index],
    ]
    const vertical = [
      images[index + 1],
      images[index + 3],
      images[index + 5],
      images[index + 3] + images[index + 5] - images[index + 1],
    ]
    output.push([
      Math.min(...horizontal),
      Math.min(...vertical),
      Math.max(...horizontal),
      Math.max(...vertical),
    ])
  }
  return output
}

export function pdfRegionText(
  content: TextContent,
  view: {
    scale: number
    convertToViewportPoint(x: number, y: number): number[]
  }
): RegionText[] {
  if (!content.items.length) return []
  const [originX, originY] = view.convertToViewportPoint(0, 0)
  const [unitX, unitY] = view.convertToViewportPoint(1, 0)
  const unitScale = Math.hypot(unitX - originX, unitY - originY)
  return content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return []
    const [baseX, baseY] = view.convertToViewportPoint(item.transform[4], item.transform[5])
    const [axisX, axisY] = view.convertToViewportPoint(
      item.transform[4] + item.transform[0],
      item.transform[5] + item.transform[1]
    )
    const [upX, upY] = view.convertToViewportPoint(
      item.transform[4] + item.transform[2],
      item.transform[5] + item.transform[3]
    )
    const vertical = content.styles[item.fontName]?.vertical === true
    const angle = Math.atan2(axisY - baseY, axisX - baseX) + (vertical ? Math.PI / 2 : 0)
    const size = Math.hypot(upX - baseX, upY - baseY)
    const font = content.styles[item.fontName]
    const ascent = Number.isFinite(font?.ascent)
      ? font.ascent!
      : Number.isFinite(font?.descent)
        ? 1 + font.descent!
        : 1
    const width = (vertical ? item.height : item.width) * unitScale
    const along = [Math.cos(angle) * width, Math.sin(angle) * width]
    const up = [Math.sin(angle) * size, -Math.cos(angle) * size]
    const points = [0, 1].flatMap((end) =>
      [ascent, ascent - 1].map((height) => [
        baseX + end * along[0] + height * up[0],
        baseY + end * along[1] + height * up[1],
      ])
    )
    const quad: Bounds = [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ]
    if (!validBounds(quad) || !Number.isFinite(size) || size <= 0) return []
    return [
      {
        text: item.str,
        size,
        quad,
      },
    ]
  })
}

export function regionLines(items: readonly RegionText[]): RegionText[] {
  const lines: RegionText[] = []
  for (const item of [...items].sort(
    (left, right) => left.quad[1] - right.quad[1] || left.quad[0] - right.quad[0]
  )) {
    const line = [...lines].reverse().find((candidate) => {
      const [horizontal] = gap(candidate.quad, item.quad)
      const overlap =
        Math.min(candidate.quad[3], item.quad[3]) - Math.max(candidate.quad[1], item.quad[1])
      return (
        overlap >= Math.min(item.size, candidate.size) * POLICY.lineOverlap &&
        horizontal <= Math.max(item.size, candidate.size) * POLICY.wordGap
      )
    })
    if (line) {
      line.text =
        item.quad[0] < line.quad[0] ? `${item.text} ${line.text}` : `${line.text} ${item.text}`
      line.quad = union(line.quad, item.quad)
      line.size = Math.max(line.size, item.size)
    } else lines.push({ ...item, quad: [...item.quad] })
  }
  return lines
}

interface Candidate {
  quad: Bounds
  kind: PdfVisualRegionKind
  bounded?: boolean
}

function ruledTables(
  primitives: Bounds[],
  text: readonly RegionText[],
  captions: RegionText[],
  scale: number
): Candidate[] {
  const rules = primitives.filter((quad) => quad[3] - quad[1] <= POLICY.ruleThickness * scale)
  const tables: Candidate[] = []
  for (const caption of captions.filter((line) => TABLE_CAPTION.test(line.text.trim()))) {
    const top = rules
      .filter(
        (rule) =>
          rule[1] >= caption.quad[3] &&
          rule[1] - caption.quad[3] <= POLICY.captionGap * scale &&
          Math.abs(rule[0] - caption.quad[0]) <= caption.size
      )
      .sort((left, right) => left[1] - right[1])[0]
    if (!top) continue
    const nextCaption = captions
      .filter((line) => line.quad[1] > caption.quad[3])
      .sort((left, right) => left.quad[1] - right.quad[1])[0]
    const aligned = rules
      .filter(
        (rule) =>
          rule[1] >= top[1] &&
          (!nextCaption || rule[3] < nextCaption.quad[1]) &&
          Math.abs(rule[0] - top[0]) <= POLICY.rowAlignment * scale &&
          Math.abs(rule[2] - top[2]) <= POLICY.rowAlignment * scale
      )
      .sort((left, right) => left[1] - right[1])
    if (aligned.length < POLICY.tableRules || aligned[1][1] - top[3] > POLICY.rowHeight * scale * 2)
      continue
    const quad = aligned.reduce(union)
    const body = text.filter((item) => inside(item.quad, quad) && item.quad[1] >= aligned[1][3])
    const rows: RegionText[][] = []
    for (const item of [...body].sort(
      (left, right) => left.quad[1] - right.quad[1] || left.quad[0] - right.quad[0]
    )) {
      const row = rows.find(
        (items) =>
          Math.min(items[0].quad[3], item.quad[3]) - Math.max(items[0].quad[1], item.quad[1]) >=
          Math.min(items[0].size, item.size) * POLICY.lineOverlap
      )
      if (row) row.push(item)
      else rows.push([item])
    }
    const cells = rows
      .map((row) => {
        const result: Bounds[] = []
        for (const item of row.sort((left, right) => left.quad[0] - right.quad[0])) {
          const previous = result.at(-1)
          if (previous && gap(previous, item.quad)[0] <= item.size * POLICY.tableCellGap)
            result[result.length - 1] = union(previous, item.quad)
          else result.push(item.quad)
        }
        return result
      })
      .filter((row) => row.length >= POLICY.tableColumns)
    if (cells.length < POLICY.tableRows) continue
    const anchors: number[] = []
    for (const cell of cells.flat()) {
      const alignedRows = cells.filter((row) =>
        row.some(
          (other) =>
            Math.abs(other[0] - cell[0]) <= POLICY.rowAlignment * scale ||
            Math.abs(other[2] - cell[2]) <= POLICY.rowAlignment * scale
        )
      )
      if (
        alignedRows.length >= POLICY.tableRows &&
        !anchors.some(
          (anchor) => Math.abs(anchor - cell[0]) <= caption.size * POLICY.tableColumnGap
        )
      )
        anchors.push(cell[0])
    }
    if (
      anchors.length < POLICY.tableColumns ||
      primitives.some(
        (primitive) =>
          intersects(primitive, quad) &&
          primitive[3] - primitive[1] > POLICY.ruleThickness * scale &&
          !inside(primitive, quad)
      )
    )
      continue
    tables.push({ quad, kind: 'table', bounded: true })
  }
  return tables
}

export function groupPdfRegions(
  page: number,
  width: number,
  height: number,
  graphics: readonly Bounds[],
  text: readonly RegionText[],
  scale = 1
): PdfVisualRegion[] {
  text = text.filter(
    (item) => validBounds(item.quad) && Number.isFinite(item.size) && item.size > 0
  )
  graphics = graphics.filter(validBounds)
  const lines = regionLines(text)
  const captions = lines.filter((line) => CAPTION.test(line.text))
  const captionBounds = captions.map((caption) => {
    let bounds = caption.quad
    for (const line of lines) {
      if (line === caption || line.quad[1] < caption.quad[1]) continue
      const [horizontal, vertical] = gap(bounds, line.quad)
      if (
        horizontal === 0 &&
        vertical <= caption.size * POLICY.captionLineGap &&
        line.quad[0] >= caption.quad[0] - caption.size &&
        line.quad[2] <= caption.quad[2] + caption.size
      )
        bounds = union(bounds, line.quad)
    }
    return bounds
  })
  const primitives = graphics.map(
    (normalized) =>
      [
        normalized[0] * width,
        normalized[1] * height,
        normalized[2] * width,
        normalized[3] * height,
      ] as Bounds
  )
  const tables = ruledTables(primitives, text, captions, scale)
  const pageRules = primitives.filter(
    (quad) =>
      quad[2] - quad[0] >= width * POLICY.pageRuleWidth &&
      quad[3] - quad[1] <= POLICY.ruleThickness * scale
  )
  const blockers = [...lines.filter(prose).map((line) => line.quad), ...captionBounds, ...pageRules]
  const crosses = (left: Bounds, right: Bounds): boolean => {
    const envelope = union(left, right)
    return blockers.some(
      (bounds) =>
        !intersects(bounds, left) &&
        !intersects(bounds, right) &&
        bounds[0] < envelope[2] &&
        bounds[2] > envelope[0] &&
        bounds[1] <= envelope[3] &&
        bounds[3] >= envelope[1]
    )
  }
  const components: Bounds[] = []
  for (const primitive of primitives) {
    let candidate: Bounds = primitive
    if (tables.some((table) => inside(primitive, table.quad))) continue
    if (area(candidate) >= width * height * POLICY.backgroundArea) continue
    if (
      candidate[2] - candidate[0] >= width * POLICY.pageRuleWidth &&
      candidate[3] - candidate[1] <= POLICY.ruleThickness * scale
    )
      continue
    let changed = true
    while (changed) {
      changed = false
      for (let index = components.length - 1; index >= 0; index--) {
        const other = components[index]
        const [horizontal, vertical] = gap(candidate, other)
        if (
          Math.max(horizontal, vertical) <= POLICY.graphicsGap * scale &&
          !crosses(candidate, other)
        ) {
          candidate = union(candidate, other)
          components.splice(index, 1)
          changed = true
        }
      }
    }
    components.push(candidate)
  }
  const candidates: Candidate[] = [
    ...tables,
    ...components
      .filter(
        (quad) =>
          quad[2] - quad[0] >= width * POLICY.minimumWidth &&
          quad[3] - quad[1] >= POLICY.minimumHeight * scale
      )
      .map((quad): Candidate => ({ quad, kind: 'figure' })),
  ]

  for (const candidate of candidates) {
    if (candidate.bounded) continue
    const rows = primitives.filter(
      (primitive) =>
        inside(primitive, candidate.quad) &&
        primitive[3] - primitive[1] >= POLICY.minimumRowHeight * scale &&
        primitive[3] - primitive[1] <= POLICY.rowHeight * scale &&
        primitive[2] - primitive[0] >= width * POLICY.minimumWidth
    )
    if (
      !text.some((item) => FLOW_ARROW.test(item.text) && inside(item.quad, candidate.quad)) &&
      rows.some(
        (row) =>
          rows.filter(
            (other) =>
              Math.abs(row[0] - other[0]) <= POLICY.rowAlignment * scale &&
              Math.abs(row[2] - other[2]) <= POLICY.rowAlignment * scale &&
              Math.abs(row[1] - other[1]) <= POLICY.tableRows * POLICY.rowHeight * scale &&
              rows.some(
                (neighbor) =>
                  neighbor !== other &&
                  gap(other, neighbor)[1] <= POLICY.rowAlignment * scale &&
                  Math.abs(other[0] - neighbor[0]) <= POLICY.rowAlignment * scale &&
                  Math.abs(other[2] - neighbor[2]) <= POLICY.rowAlignment * scale
              )
          ).length >= POLICY.tableRows
      )
    )
      candidate.kind = 'table'
  }

  for (let index = 0; index < candidates.length; index++) {
    for (let otherIndex = candidates.length - 1; otherIndex > index; otherIndex--) {
      const candidate = candidates[index]
      const other = candidates[otherIndex]
      if (candidate.bounded || other.bounded) continue
      if (candidate.kind !== 'table' && other.kind !== 'table') continue
      const rows = primitives.filter(
        (bounds) =>
          inside(bounds, candidate.quad) && bounds[3] - bounds[1] >= POLICY.minimumRowHeight * scale
      )
      const otherRows = primitives.filter(
        (bounds) =>
          inside(bounds, other.quad) && bounds[3] - bounds[1] >= POLICY.minimumRowHeight * scale
      )
      if (
        rows.some((row) =>
          otherRows.some(
            (next) =>
              Math.abs(row[0] - next[0]) <= POLICY.rowAlignment * scale &&
              Math.abs(row[2] - next[2]) <= POLICY.rowAlignment * scale &&
              gap(row, next)[1] <= POLICY.rowAlignment * scale
          )
        )
      ) {
        candidate.quad = union(candidate.quad, other.quad)
        candidate.kind = 'table'
        candidates.splice(otherIndex, 1)
      }
    }
  }

  for (const table of candidates.filter((candidate) => candidate.kind === 'table')) {
    if (table.bounded) continue
    for (let index = candidates.length - 1; index >= 0; index--) {
      const heading = candidates[index]
      if (heading === table || heading.kind !== 'figure' || heading.quad[3] > table.quad[1])
        continue
      const [horizontal, vertical] = gap(table.quad, heading.quad)
      if (
        horizontal === 0 &&
        vertical <= POLICY.graphicsGap * scale &&
        heading.quad[3] - heading.quad[1] <= POLICY.rowHeight * scale
      ) {
        table.quad = union(table.quad, heading.quad)
        candidates.splice(index, 1)
      }
    }
  }

  for (const caption of captions) {
    const nearby = candidates
      .filter((candidate) => {
        const [horizontal, vertical] = gap(candidate.quad, caption.quad)
        return (
          horizontal === 0 &&
          vertical <= POLICY.captionGap * scale &&
          !crosses(candidate.quad, caption.quad)
        )
      })
      .sort((left, right) => gap(left.quad, caption.quad)[1] - gap(right.quad, caption.quad)[1])
    const closest = nearby[0]
    if (closest && /^(?:tables?|表)/i.test(caption.text.trim())) closest.kind = 'table'
  }

  const seeds = candidates.map((candidate) => [...candidate.quad] as Bounds)
  for (const component of components) {
    if (
      seeds.some((seed) => inside(component, seed)) ||
      captionBounds.some((bounds) => intersects(bounds, component))
    )
      continue
    const owners = seeds
      .flatMap((seed, index) => {
        if (candidates[index].bounded) return []
        const [horizontal, vertical] = gap(seed, component)
        return Math.max(horizontal, vertical) <= POLICY.glyphGap * scale &&
          !crosses(seed, component)
          ? [{ index, distance: Math.hypot(horizontal, vertical) }]
          : []
      })
      .sort((left, right) => left.distance - right.distance)
    if (owners[0])
      candidates[owners[0].index].quad = union(candidates[owners[0].index].quad, component)
  }
  for (const line of lines) {
    if (captionBounds.some((bounds) => intersects(bounds, line.quad))) continue
    const owners = seeds
      .flatMap((seed, index) => {
        const [horizontal, vertical] = gap(seed, line.quad)
        if (inside(line.quad, seed)) return [{ index, distance: 0 }]
        if (candidates[index].bounded) return []
        if (
          candidates[index].kind === 'table' &&
          vertical === 0 &&
          line.quad[0] >= seed[0] - line.size &&
          gap(candidates[index].quad, line.quad)[0] <= line.size * POLICY.wordGap &&
          !seeds.some((other, otherIndex) => otherIndex !== index && intersects(line.quad, other))
        )
          return [{ index, distance: horizontal }]
        if (
          prose(line) ||
          Math.max(horizontal, vertical) > line.size * POLICY.labelFontGap ||
          crosses(seed, line.quad)
        )
          return []
        return [{ index, distance: Math.hypot(horizontal, vertical) }]
      })
      .sort((left, right) => left.distance - right.distance)
    if (owners[0])
      candidates[owners[0].index].quad = union(candidates[owners[0].index].quad, line.quad)
  }

  for (const anchor of text.filter((item) => EQUATION_NUMBER.test(item.text))) {
    if (lines.some((line) => prose(line) && intersects(line.quad, anchor.quad))) continue
    const column = lines
      .filter(
        (line) =>
          prose(line) &&
          line.quad[0] <= anchor.quad[0] &&
          line.quad[2] + anchor.size >= anchor.quad[2]
      )
      .sort((left, right) => gap(left.quad, anchor.quad)[1] - gap(right.quad, anchor.quad)[1])[0]
      ?.quad ?? [0, 0, width, height]
    const top = anchor.quad[1] - anchor.size * POLICY.equationBand
    const bottom = anchor.quad[3] + anchor.size * POLICY.equationBand
    const fragments = text.filter(
      (item) =>
        item.quad[3] >= top &&
        item.quad[1] <= bottom &&
        item.quad[0] >= column[0] - anchor.size &&
        item.quad[2] <= column[2] + anchor.size &&
        !lines.some((line) => prose(line) && intersects(line.quad, item.quad)) &&
        !captionBounds.some((bounds) => intersects(bounds, item.quad))
    )
    const combined = fragments.map((item) => item.text).join(' ')
    if (!mathematical(combined, true)) continue
    if (
      !RELATION.test(combined) &&
      (combined.match(OPERATOR)?.length ?? 0) < POLICY.formulaOperators
    )
      continue
    let quad = fragments.reduce((bounds, item) => union(bounds, item.quad), anchor.quad)
    if (candidates.some((candidate) => intersects(candidate.quad, quad))) continue
    for (const primitive of primitives) {
      const centerX = (primitive[0] + primitive[2]) / 2
      const centerY = (primitive[1] + primitive[3]) / 2
      if (centerX >= quad[0] && centerX <= quad[2] && centerY >= quad[1] && centerY <= quad[3])
        quad = union(quad, primitive)
    }
    candidates.push({ quad, kind: 'formula' })
  }

  const unclaimed = lines.filter(
    (line) =>
      !captionBounds.some((bounds) => intersects(bounds, line.quad)) &&
      !candidates.some((candidate) => intersects(line.quad, candidate.quad))
  )
  for (const line of unclaimed) {
    if (!mathematical(line.text)) continue
    const column = lines
      .filter(
        (other) =>
          prose(other) &&
          other.quad[0] <= line.quad[0] &&
          other.quad[2] >= line.quad[2] &&
          !crosses(other.quad, line.quad)
      )
      .sort((left, right) => gap(left.quad, line.quad)[1] - gap(right.quad, line.quad)[1])[0]
      ?.quad ?? [0, 0, width, height]
    if (
      Math.abs((line.quad[0] + line.quad[2] - column[0] - column[2]) / 2) >
      width * POLICY.shortFormulaCenter
    )
      continue
    const operators = line.text.match(OPERATOR)?.length ?? 0
    const inline = unclaimed.some(
      (other) =>
        other !== line &&
        prose(other) &&
        Math.min(other.quad[3], line.quad[3]) - Math.max(other.quad[1], line.quad[1]) >
          Math.min(other.size, line.size) * POLICY.lineOverlap
    )
    if (
      inline ||
      prose(line) ||
      (line.text.match(PROSE_WORD)?.length ?? 0) > POLICY.formulaProseWords ||
      (!RELATION.test(line.text) && !LARGE_OPERATOR.test(line.text)) ||
      (!RELATION.test(line.text) && operators < POLICY.formulaOperators) ||
      (!RELATION.test(line.text) &&
        !LARGE_OPERATOR.test(line.text) &&
        (line.text.match(PROSE_WORD)?.length ?? 0) > 0) ||
      (line.quad[2] - line.quad[0] < width * POLICY.formulaWidth &&
        (Math.abs((line.quad[0] + line.quad[2]) / 2 - width / 2) >
          width * POLICY.shortFormulaCenter ||
          !RELATION.test(line.text) ||
          unclaimed.some(
            (other) =>
              other !== line &&
              gap(line.quad, other.quad)[1] < line.size * POLICY.formulaWhitespace &&
              !crosses(line.quad, other.quad)
          )))
    )
      continue
    let quad = line.quad
    let uncertain = false
    for (const fragment of unclaimed) {
      if (fragment === line || prose(fragment)) continue
      const [horizontal, vertical] = gap(line.quad, fragment.quad)
      const number = EQUATION_NUMBER.test(fragment.text)
      if (
        vertical <= line.size * POLICY.formulaBand &&
        (horizontal <= line.size || (number && horizontal <= width * POLICY.minimumWidth)) &&
        !crosses(line.quad, fragment.quad)
      ) {
        if (!mathematical(fragment.text)) uncertain = true
        else quad = union(quad, fragment.quad)
      }
    }
    if (!uncertain && !candidates.some((candidate) => intersects(candidate.quad, quad)))
      candidates.push({ quad, kind: 'formula' })
  }
  return candidates
    .filter((candidate) => validBounds(candidate.quad) && area(candidate.quad) > 0)
    .sort((left, right) => left.quad[1] - right.quad[1] || left.quad[0] - right.quad[0])
    .map((candidate, index) => ({
      region_id: `pdfjs-${page}-${index}`,
      page,
      kind: candidate.kind,
      reason: 'pdfjs_owned_geometry',
      text_policy: 'retain',
      quad: [
        Math.max(0, candidate.quad[0] / width),
        Math.max(0, candidate.quad[1] / height),
        Math.min(1, candidate.quad[2] / width),
        Math.min(1, candidate.quad[3] / height),
      ],
    }))
}

export function visualRegionRect(region: PdfVisualRegion): number[] {
  const [left, top, right, bottom] = region.quad
  return [left, top, right - left, bottom - top]
}
