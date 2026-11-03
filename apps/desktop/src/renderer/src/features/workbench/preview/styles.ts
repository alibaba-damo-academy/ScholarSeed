import type ExcelJS from 'exceljs'
import { type CSSProperties } from 'react'
import { unzipSync } from 'fflate'

import { OOXML_NS, readXml, resolvePart } from './xml.ts'
import { cellText } from './cells.ts'

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const THEME_ORDER = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const
const SCHEME_ALIASES: Readonly<Record<string, string>> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
}
// OOXML's default Office theme and indexed palette are document defaults, not UI colors.
const DEFAULT_THEME = [
  'FFFFFF',
  '000000',
  'EEECE1',
  '1F497D',
  '4F81BD',
  'C0504D',
  '9BBB59',
  '8064A2',
  '4BACC6',
  'F79646',
  '0000FF',
  '800080',
]
const DEFAULT_INDEXED = [
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '800000',
  '008000',
  '000080',
  '808000',
  '800080',
  '008080',
  'C0C0C0',
  '808080',
  '9999FF',
  '993366',
  'FFFFCC',
  'CCFFFF',
  '660066',
  'FF8080',
  '0066CC',
  'CCCCFF',
  '000080',
  'FF00FF',
  'FFFF00',
  '00FFFF',
  '800080',
  '800000',
  '008080',
  '0000FF',
  '00CCFF',
  'CCFFFF',
  'CCFFCC',
  'FFFF99',
  '99CCFF',
  'FF99CC',
  'CC99FF',
  'FFCC99',
  '3366FF',
  '33CCCC',
  '99CC00',
  'FFCC00',
  'FF9900',
  'FF6600',
  '666699',
  '969696',
  '003366',
  '339966',
  '003300',
  '333300',
  '993300',
  '993366',
  '333399',
  '333333',
]
// Normalize the same encoded document defaults as authored OOXML colors.
const DOCUMENT_WHITE = rgb(DEFAULT_THEME[0])!
const DOCUMENT_BLACK = rgb(DEFAULT_THEME[1])!
const GRID_COLOR = rgb('D9D9D9')!
const POINTS_TO_PIXELS = 4 / 3
const DEFAULT_FONT_SIZE = 11
const INDENT_EM = 3
const NORMAL_LINE_HEIGHT = 1.2
const MEASUREMENT_EPSILON = 0.000001
const BORDER_STYLES: Readonly<Record<string, { width: number; style: string }>> = {
  hair: { width: 0.5, style: 'solid' },
  thin: { width: 1, style: 'solid' },
  medium: { width: 2, style: 'solid' },
  thick: { width: 3, style: 'solid' },
  dotted: { width: 1, style: 'dotted' },
  dashed: { width: 1, style: 'dashed' },
  dashDot: { width: 1, style: 'dashed' },
  dashDotDot: { width: 1, style: 'dashed' },
  mediumDashed: { width: 2, style: 'dashed' },
  mediumDashDot: { width: 2, style: 'dashed' },
  mediumDashDotDot: { width: 2, style: 'dashed' },
  slantDashDot: { width: 2, style: 'dashed' },
  double: { width: 3, style: 'double' },
}
const HATCHES: Readonly<Record<string, { angles: number[]; spacing: number; width: number }>> = {
  darkHorizontal: { angles: [0], spacing: 4, width: 2 },
  darkVertical: { angles: [90], spacing: 4, width: 2 },
  darkDown: { angles: [135], spacing: 4, width: 2 },
  darkUp: { angles: [45], spacing: 4, width: 2 },
  darkGrid: { angles: [0, 90], spacing: 4, width: 1 },
  darkTrellis: { angles: [45, 135], spacing: 4, width: 1 },
  lightHorizontal: { angles: [0], spacing: 8, width: 1 },
  lightVertical: { angles: [90], spacing: 8, width: 1 },
  lightDown: { angles: [135], spacing: 8, width: 1 },
  lightUp: { angles: [45], spacing: 8, width: 1 },
  lightGrid: { angles: [0, 90], spacing: 8, width: 1 },
  lightTrellis: { angles: [45, 135], spacing: 8, width: 1 },
}
const GRAY_COVERAGE: Readonly<Record<string, number>> = {
  darkGray: 0.75,
  mediumGray: 0.5,
  lightGray: 0.25,
  gray125: 0.125,
  gray0625: 0.0625,
}

export interface WorkbookStyles {
  readonly theme: readonly string[]
  readonly indexed: readonly string[]
  readonly fonts: Readonly<{ major: string; minor: string }>
  readonly defaultFont: Partial<ExcelJS.Font>
}

export type WorkbookColor = Partial<ExcelJS.Color> & {
  indexed?: number
  tint?: number
  auto?: boolean
}
export type StyledCell = Pick<ExcelJS.Cell, 'font' | 'alignment' | 'border' | 'fill' | 'value'>

function rgb(value: string | null | undefined): string | undefined {
  if (!value || !/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return undefined
  return `#${value.slice(-6).toUpperCase()}`
}

function children(element: Element | undefined, name: string, namespace: string): Element[] {
  return element
    ? Array.from(element.childNodes).filter(
        (child): child is Element =>
          child.nodeType === 1 &&
          (child as Element).localName === name &&
          (child as Element).namespaceURI === namespace
      )
    : []
}

function colorElement(element: Element): WorkbookColor {
  const indexed = element.getAttribute('indexed')
  const theme = element.getAttribute('theme')
  const tint = element.getAttribute('tint')
  return {
    ...(element.getAttribute('rgb') ? { argb: element.getAttribute('rgb')! } : {}),
    ...(element.hasAttribute('indexed') ? { indexed: Number(indexed) } : {}),
    ...(element.hasAttribute('theme') ? { theme: Number(theme) } : {}),
    ...(element.hasAttribute('tint') ? { tint: Number(tint) } : {}),
    ...(element.getAttribute('auto') === '1' ? { auto: true } : {}),
  }
}

/** Resolve package-owned theme/styles through relationships without private ExcelJS fields. */
export function readWorkbookStyles(bytes: Uint8Array): WorkbookStyles {
  const entries = unzipSync(bytes)
  // Standard package locations are defaults for minimal fixtures without root relationships.
  let workbookOwner = 'xl/workbook.xml'
  if (entries['_rels/.rels']) {
    const root = readXml(entries['_rels/.rels'])
    const office = Array.from(
      root.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')
    ).find(
      (relation) =>
        relation.getAttribute('Type')?.split('/').at(-1) === 'officeDocument' &&
        relation.getAttribute('TargetMode') !== 'External'
    )
    if (office?.getAttribute('Target'))
      workbookOwner = resolvePart('', office.getAttribute('Target')!)
  }
  const ownerSlash = workbookOwner.lastIndexOf('/')
  const ownerDirectory = ownerSlash >= 0 ? workbookOwner.slice(0, ownerSlash + 1) : ''
  const ownerName = workbookOwner.slice(ownerSlash + 1)
  const parts = { theme: 'xl/theme/theme1.xml', styles: 'xl/styles.xml' }
  const relationships = entries[`${ownerDirectory}_rels/${ownerName}.rels`]
  if (relationships) {
    const document = readXml(relationships)
    for (const relation of Array.from(
      document.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')
    )) {
      const type = relation.getAttribute('Type')?.split('/').at(-1)
      if (
        relation.getAttribute('TargetMode') !== 'External' &&
        (type === 'theme' || type === 'styles')
      ) {
        parts[type] = resolvePart(workbookOwner, relation.getAttribute('Target') || '')
      }
    }
  }
  const theme = DEFAULT_THEME.map((color) => `#${color}`)
  const indexed = DEFAULT_INDEXED.map((color) => `#${color}`)
  const fonts = { major: 'Cambria', minor: 'Calibri' }
  if (entries[parts.theme]) {
    const document = readXml(entries[parts.theme])
    const scheme = document.getElementsByTagNameNS(DRAWING_NS, 'clrScheme')[0]
    THEME_ORDER.forEach((name, index) => {
      const slot = children(scheme, name, DRAWING_NS)[0]
      const srgb = children(slot, 'srgbClr', DRAWING_NS)[0]
      const system = children(slot, 'sysClr', DRAWING_NS)[0]
      theme[index] =
        rgb(srgb?.getAttribute('val') || system?.getAttribute('lastClr')) ?? theme[index]
    })
    for (const kind of ['major', 'minor'] as const) {
      const font = document.getElementsByTagNameNS(DRAWING_NS, `${kind}Font`)[0]
      fonts[kind] = children(font, 'latin', DRAWING_NS)[0]?.getAttribute('typeface') || fonts[kind]
    }
  }
  const defaultFont: Partial<ExcelJS.Font> = {
    name: fonts.minor,
    size: DEFAULT_FONT_SIZE,
    color: { theme: 1 },
  }
  if (entries[parts.styles]) {
    const document = readXml(entries[parts.styles])
    const palette = document.getElementsByTagNameNS(OOXML_NS.spreadsheet, 'indexedColors')[0]
    children(palette, 'rgbColor', OOXML_NS.spreadsheet).forEach((color, index) => {
      indexed[index] = rgb(color.getAttribute('rgb')) ?? indexed[index]
    })
    const font = children(
      document.getElementsByTagNameNS(OOXML_NS.spreadsheet, 'fonts')[0],
      'font',
      OOXML_NS.spreadsheet
    )[0]
    const property = (name: string) => children(font, name, OOXML_NS.spreadsheet)[0]
    defaultFont.name = property('name')?.getAttribute('val') || defaultFont.name
    defaultFont.size = Number(property('sz')?.getAttribute('val')) || defaultFont.size
    const scheme = property('scheme')?.getAttribute('val')
    if (scheme === 'major' || scheme === 'minor') {
      defaultFont.scheme = scheme
      if (!property('name')?.getAttribute('val')) defaultFont.name = fonts[scheme]
    }
    const underline = property('u')
    if (underline)
      defaultFont.underline = (underline.getAttribute('val') ||
        'single') as ExcelJS.Font['underline']
    for (const [key, tag] of [
      ['bold', 'b'],
      ['italic', 'i'],
      ['strike', 'strike'],
    ] as const) {
      const element = property(tag)
      if (element)
        defaultFont[key] =
          element.getAttribute('val') !== '0' && element.getAttribute('val') !== 'false'
    }
    const color = property('color')
    if (color) defaultFont.color = colorElement(color)
  }
  return { theme, indexed, fonts, defaultFont }
}

/** Excel theme numbering starts lt1,dk1,lt2,dk2; DrawingML clrScheme XML starts dk1. */
export function themeSchemeColor(name: string, context: WorkbookStyles): string | undefined {
  const index = THEME_ORDER.indexOf((SCHEME_ALIASES[name] ?? name) as (typeof THEME_ORDER)[number])
  return index < 0 ? undefined : context.theme[index]
}

/** DrawingML luminosity and Excel tint operate on HSL lightness, not each RGB channel. */
export function luminanceColor(color: string, multiplier: number, offset: number): string {
  const source = rgb(color.replace(/^#/, ''))
  if (!source || !Number.isFinite(multiplier) || !Number.isFinite(offset)) return color
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(source.slice(start, start + 2), 16) / 255)
  const maximum = Math.max(r, g, b),
    minimum = Math.min(r, g, b),
    difference = maximum - minimum
  const lightness = (maximum + minimum) / 2
  const saturation = difference === 0 ? 0 : difference / (1 - Math.abs(2 * lightness - 1))
  const hue =
    difference === 0
      ? 0
      : maximum === r
        ? ((g - b) / difference + (g < b ? 6 : 0)) / 6
        : maximum === g
          ? ((b - r) / difference + 2) / 6
          : ((r - g) / difference + 4) / 6
  const next = Math.max(0, Math.min(1, lightness * multiplier + offset))
  const amplitude = (1 - Math.abs(2 * next - 1)) * saturation
  const segment = hue * 6
  const intermediate = amplitude * (1 - Math.abs((segment % 2) - 1))
  const channels =
    segment < 1
      ? [amplitude, intermediate, 0]
      : segment < 2
        ? [intermediate, amplitude, 0]
        : segment < 3
          ? [0, amplitude, intermediate]
          : segment < 4
            ? [0, intermediate, amplitude]
            : segment < 5
              ? [intermediate, 0, amplitude]
              : [amplitude, 0, intermediate]
  return `#${channels
    .map((value) =>
      Math.round((value + next - amplitude / 2) * 255 + Number.EPSILON * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()}`
}

export function tintColor(color: string, tint: number): string {
  const selected = Math.max(-1, Math.min(1, tint))
  return luminanceColor(
    color,
    selected < 0 ? 1 + selected : 1 - selected,
    selected < 0 ? 0 : selected
  )
}

export function resolveWorkbookColor(
  color: WorkbookColor | undefined,
  context: WorkbookStyles
): string | undefined {
  if (!color) return undefined
  const indexed =
    color.indexed === 64
      ? DOCUMENT_BLACK
      : color.indexed === 65
        ? DOCUMENT_WHITE
        : color.indexed !== undefined
          ? context.indexed[color.indexed]
          : undefined
  const selected =
    rgb(color.argb) ??
    (color.theme !== undefined ? context.theme[color.theme] : undefined) ??
    indexed ??
    (color.auto ? DOCUMENT_BLACK : undefined)
  return selected && color.tint !== undefined ? tintColor(selected, color.tint) : selected
}

/** Auto-height applies only to wrapping cells; explicit row geometry belongs to the sheet. */
export function wrappedCellHeight(
  cell: StyledCell,
  context: WorkbookStyles,
  width: number,
  canvasContext: CanvasRenderingContext2D,
  scale = 1
): number {
  const text = cellText(cell.value)
  if (!cell.alignment?.wrapText || !text) return 0
  const style = cellStyle(cell, context, scale)
  const size = Number.parseFloat(String(style.fontSize))
  canvasContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const metrics = canvasContext.measureText('Mg')
  const measuredHeight =
    (metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? 0) +
    (metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0)
  const lineHeight = Math.max(size * NORMAL_LINE_HEIGHT, measuredHeight)
  const borderWidth = (value: CSSProperties['borderTop']) => Number.parseFloat(String(value)) || 0
  const horizontalBorders = borderWidth(style.borderLeft) + borderWidth(style.borderRight)
  const verticalBorders = borderWidth(style.borderTop) + borderWidth(style.borderBottom)
  const indent = (cell.alignment.indent ?? 0) * INDENT_EM * size
  const available = Math.max(MEASUREMENT_EPSILON, width - horizontalBorders - indent)
  const fits = (value: string) => canvasContext.measureText(value).width <= available + MEASUREMENT_EPSILON
  let lines = 0
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    lines++
    let line = ''
    // pre-wrap retains whitespace; word boundaries wrap before anywhere splitting a long word.
    for (const token of paragraph.split(/([\t ]+)/).filter(Boolean)) {
      if (/^[\t ]+$/.test(token)) {
        line += token
        continue
      }
      if (line && !fits(line + token)) {
        lines++
        line = ''
      }
      for (const character of Array.from(token)) {
        if (line && !fits(line + character)) {
          lines++
          line = ''
        }
        line += character
      }
    }
  }
  return Math.ceil(lines * lineHeight + verticalBorders)
}

function borderCss(
  border: Partial<ExcelJS.Border> | undefined,
  context: WorkbookStyles,
  scale: number,
  grid: boolean
): string {
  const definition = border?.style ? BORDER_STYLES[border.style] : undefined
  return definition
    ? `${definition.width * scale}px ${definition.style} ${resolveWorkbookColor(border?.color, context) ?? DOCUMENT_BLACK}`
    : grid
      ? `${scale}px solid ${GRID_COLOR}`
      : 'none'
}

function fillStyle(
  fill: ExcelJS.Fill | undefined,
  context: WorkbookStyles,
  scale: number
): CSSProperties {
  if (!fill || (fill.type === 'pattern' && fill.pattern === 'none'))
    return { backgroundColor: DOCUMENT_WHITE }
  if (fill.type === 'gradient') {
    const stops = fill.stops
      .map(
        (stop) =>
          `${resolveWorkbookColor(stop.color, context) ?? DOCUMENT_WHITE} ${stop.position * 100}%`
      )
      .join(', ')
    return {
      backgroundColor: DOCUMENT_WHITE,
      backgroundImage:
        fill.gradient === 'angle'
          ? `linear-gradient(${fill.degree + 90}deg, ${stops})`
          : `radial-gradient(ellipse at ${fill.center.left * 100}% ${fill.center.top * 100}%, ${stops})`,
    }
  }
  const foreground = resolveWorkbookColor(fill.fgColor, context) ?? DOCUMENT_BLACK
  const background = resolveWorkbookColor(fill.bgColor, context) ?? DOCUMENT_WHITE
  if (fill.pattern === 'solid') return { backgroundColor: foreground }
  const hatch = HATCHES[fill.pattern]
  if (hatch)
    return {
      backgroundColor: background,
      backgroundImage: hatch.angles
        .map(
          (angle) =>
            `repeating-linear-gradient(${angle}deg, ${foreground} 0 ${hatch.width * scale}px, transparent ${hatch.width * scale}px ${hatch.spacing * scale}px)`
        )
        .join(', '),
    }
  const coverage = GRAY_COVERAGE[fill.pattern]
  return coverage !== undefined
    ? {
        backgroundColor: background,
        backgroundImage: `repeating-linear-gradient(45deg, ${foreground} 0 ${coverage * 4 * scale}px, transparent ${coverage * 4 * scale}px ${4 * scale}px)`,
      }
    : { backgroundColor: background }
}

/** All visual values below originate in OOXML data or spreadsheet document defaults. */
export function cellStyle(
  cell: StyledCell,
  context: WorkbookStyles,
  scale = 1,
  showGridLines = true
): CSSProperties {
  const font = { ...context.defaultFont, ...cell.font }
  const alignment = cell.alignment ?? {}
  const underline = font.underline && font.underline !== 'none'
  const horizontal =
    alignment.horizontal ??
    (typeof cell.value === 'number' ||
    (typeof cell.value === 'object' &&
      cell.value &&
      'result' in cell.value &&
      typeof cell.value.result === 'number')
      ? 'right'
      : 'left')
  const decorations = [underline ? 'underline' : '', font.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  const style: CSSProperties = {
    ...fillStyle(cell.fill, context, scale),
    color: resolveWorkbookColor(font.color, context) ?? DOCUMENT_BLACK,
    fontFamily: JSON.stringify(
      font.name || context.fonts[font.scheme === 'major' ? 'major' : 'minor']
    ),
    fontSize: `${(font.size || DEFAULT_FONT_SIZE) * POINTS_TO_PIXELS * scale}px`,
    lineHeight: 'normal',
    fontWeight: font.bold ? 'bold' : 'normal',
    fontStyle: font.italic ? 'italic' : 'normal',
    textDecorationLine: decorations || 'none',
    textDecorationStyle:
      font.underline === 'double' || font.underline === 'doubleAccounting' ? 'double' : 'solid',
    display: 'flex',
    flexDirection: 'column',
    justifyContent:
      alignment.vertical === 'top'
        ? 'flex-start'
        : alignment.vertical === 'middle'
          ? 'center'
          : alignment.vertical === 'distributed'
            ? 'space-evenly'
            : alignment.vertical === 'justify'
              ? 'space-between'
              : 'flex-end',
    textAlign:
      horizontal === 'centerContinuous'
        ? 'center'
        : horizontal === 'distributed' || horizontal === 'fill'
          ? 'justify'
          : horizontal,
    whiteSpace: alignment.wrapText ? 'pre-wrap' : 'pre',
    overflowWrap: alignment.wrapText ? 'anywhere' : 'normal',
    paddingInlineStart: alignment.indent ? `${alignment.indent * INDENT_EM}em` : undefined,
    direction: alignment.readingOrder,
    borderTop: borderCss(cell.border?.top, context, scale, showGridLines),
    borderRight: borderCss(cell.border?.right, context, scale, showGridLines),
    borderBottom: borderCss(cell.border?.bottom, context, scale, showGridLines),
    borderLeft: borderCss(cell.border?.left, context, scale, showGridLines),
  }
  const diagonal = cell.border?.diagonal
  if (diagonal?.style && (diagonal.up || diagonal.down)) {
    const width = BORDER_STYLES[diagonal.style]?.width ?? 1
    const color = resolveWorkbookColor(diagonal.color, context) ?? DOCUMENT_BLACK
    const lines = [diagonal.up ? 45 : null, diagonal.down ? 135 : null]
      .filter((angle) => angle !== null)
      .map(
        (angle) =>
          `linear-gradient(${angle}deg, transparent calc(50% - ${(width * scale) / 2}px), ${color} calc(50% - ${(width * scale) / 2}px) calc(50% + ${(width * scale) / 2}px), transparent calc(50% + ${(width * scale) / 2}px))`
      )
    style.backgroundImage = [...lines, style.backgroundImage].filter(Boolean).join(', ')
  }
  return style
}

/** Apply to the cell's text child so rotation never rotates borders or merged geometry. */
export function cellTextStyle(cell: Pick<ExcelJS.Cell, 'alignment'>): CSSProperties {
  const rotation = cell.alignment?.textRotation
  return rotation === 'vertical'
    ? { writingMode: 'vertical-rl', textOrientation: 'upright' }
    : typeof rotation === 'number' && rotation
      ? { transform: `rotate(${-rotation}deg)`, transformOrigin: 'center' }
      : {}
}

/** A merged master spans the original rectangle; inspect its four outer edges only. */
export function mergeCellBorders(
  sheet: ExcelJS.Worksheet,
  top: number,
  left: number,
  bottom: number,
  right: number
): Partial<ExcelJS.Borders> {
  const selected: Partial<ExcelJS.Borders> = {}
  for (let column = left; column <= right; column++) {
    const first = sheet.getCell(top, column).border,
      last = sheet.getCell(bottom, column).border
    if (!selected.top?.style && first?.top?.style) selected.top = first.top
    if (!selected.bottom?.style && last?.bottom?.style) selected.bottom = last.bottom
  }
  for (let row = top; row <= bottom; row++) {
    const first = sheet.getCell(row, left).border,
      last = sheet.getCell(row, right).border
    if (!selected.left?.style && first?.left?.style) selected.left = first.left
    if (!selected.right?.style && last?.right?.style) selected.right = last.right
  }
  return selected
}
