import { unzipSync } from 'fflate'

import {
  luminanceColor,
  readWorkbookStyles,
  resolveWorkbookColor,
  themeSchemeColor,
  tintColor,
  type WorkbookStyles,
} from './styles.ts'
import { OOXML_NS, readXml, resolvePart } from './xml.ts'

const DOCUMENT_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  'http://schemas.openxmlformats.org/drawingml/2006/main',
])
const EMU_PER_PIXEL = 9525
const DRAWING_PERCENT = 100000
const OFFICE_ANGLE = 60000
const DEFAULT_FONT_PT = 11
const DEFAULT_INSET_EMU = 91440
const DEFAULT_VERTICAL_INSET_EMU = 45720
const DEFAULT_LINE_SPACING_PERCENT = 100
const DRAWING_PERCENT_PER_PERCENT = 1000
const DRAWING_POINTS_PER_POINT = 100
const POINTS_TO_PIXELS = 4 / 3

interface Marker {
  column: number
  row: number
  columnOffsetEmu: number
  rowOffsetEmu: number
}
export interface DrawingAnchor {
  kind: 'oneCell' | 'twoCell' | 'absolute'
  editAs?: 'oneCell' | 'twoCell' | 'absolute'
  from?: Marker
  to?: Marker
  positionEmu?: { x: number; y: number }
  extentEmu?: { width: number; height: number }
}
export interface DrawingRun {
  text: string
  sizePt: number
  bold: boolean
  italic: boolean
  color?: string
  font?: string
}
export interface DrawingParagraph {
  alignment: 'left' | 'center' | 'right' | 'justify'
  lineSpacing: { unit: 'percent' | 'points'; value: number }
  runs: DrawingRun[]
}
export interface WorkbookDrawing {
  id: string
  name: string
  anchor: DrawingAnchor
  type: 'shape' | 'image'
  geometry: 'rect' | 'roundRect' | 'ellipse'
  fill?: string
  fillOpacity: number
  line?: string
  lineOpacity: number
  lineWidthEmu: number
  rotation: number
  paragraphs: DrawingParagraph[]
  verticalAlignment: 'top' | 'center' | 'bottom'
  insetsEmu: { left: number; right: number; top: number; bottom: number }
  imageDataUrl?: string
  hyperlink?: { sheet: string; range?: string }
}

export function drawingLineHeight(paragraph: DrawingParagraph, zoom: number): string {
  return paragraph.lineSpacing.unit === 'points'
    ? `${(paragraph.lineSpacing.value * POINTS_TO_PIXELS * zoom) / 100}px`
    : `${paragraph.lineSpacing.value}%`
}
export interface DrawingGrid {
  columnOffsets: readonly number[]
  rowOffsets: readonly number[]
  /** Original document geometry at the same zoom, before view-only resizing. */
  baseColumnOffsets?: readonly number[]
  baseRowOffsets?: readonly number[]
  zoom: number
  origin: { x: number; y: number }
}

interface Relationship {
  target: string
  type: string
  external: boolean
}

function children(element: Element | Document | undefined, name?: string): Element[] {
  return element
    ? Array.from(element.childNodes).filter(
        (node): node is Element =>
          node.nodeType === 1 &&
          DRAWING_NAMESPACES.has((node as Element).namespaceURI ?? '') &&
          (!name || (node as Element).localName === name)
      )
    : []
}
function child(element: Element | Document | undefined, name: string): Element | undefined {
  return children(element, name)[0]
}
function number(element: Element | undefined, attribute: string, fallback = 0): number {
  const value = element?.getAttribute(attribute)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : fallback
}
function textNumber(element: Element | undefined): number {
  return Number(element?.textContent ?? 0) || 0
}
function relationshipPath(owner: string): string {
  const index = owner.lastIndexOf('/')
  return `${owner.slice(0, index + 1)}_rels/${owner.slice(index + 1)}.rels`
}
function relationships(
  entries: Record<string, Uint8Array>,
  owner: string
): Map<string, Relationship> {
  const bytes = entries[owner ? relationshipPath(owner) : '_rels/.rels']
  if (!bytes) return new Map()
  return new Map(
    Array.from(readXml(bytes).getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')).map(
      (item) => [
        item.getAttribute('Id') ?? '',
        {
          target: item.getAttribute('Target') ?? '',
          type: item.getAttribute('Type') ?? '',
          external: item.getAttribute('TargetMode') === 'External',
        },
      ]
    )
  )
}
function linkedPart(
  entries: Record<string, Uint8Array>,
  owner: string,
  link: Relationship | undefined
): string | undefined {
  if (!link || link.external) return undefined
  const path = resolvePart(owner, link.target)
  return entries[path] ? path : undefined
}
function marker(element: Element | undefined): Marker {
  return {
    column: textNumber(child(element, 'col')),
    row: textNumber(child(element, 'row')),
    columnOffsetEmu: textNumber(child(element, 'colOff')),
    rowOffsetEmu: textNumber(child(element, 'rowOff')),
  }
}
function anchor(element: Element): DrawingAnchor {
  const extent = child(element, 'ext')
  if (element.localName === 'twoCellAnchor') {
    const editAs = element.getAttribute('editAs')
    return {
      kind: 'twoCell',
      ...(editAs === 'oneCell' || editAs === 'twoCell' || editAs === 'absolute' ? { editAs } : {}),
      from: marker(child(element, 'from')),
      to: marker(child(element, 'to')),
    }
  }
  const extentEmu = { width: number(extent, 'cx'), height: number(extent, 'cy') }
  if (element.localName === 'absoluteAnchor') {
    const position = child(element, 'pos')
    return {
      kind: 'absolute',
      positionEmu: { x: number(position, 'x'), y: number(position, 'y') },
      extentEmu,
    }
  }
  return { kind: 'oneCell', from: marker(child(element, 'from')), extentEmu }
}

/** DrawingML transforms are applied to source colors, never product palette colors. */
function paint(
  element: Element | undefined,
  styles: WorkbookStyles
): { color?: string; opacity: number } {
  if (!element || child(element, 'noFill')) return { color: undefined, opacity: 0 }
  const fill = child(element, 'solidFill') ?? element
  const source = children(fill).find((item) =>
    ['srgbClr', 'schemeClr', 'sysClr'].includes(item.localName)
  )
  if (!source) return { opacity: 1 }
  let color =
    source.localName === 'schemeClr'
      ? themeSchemeColor(source.getAttribute('val') ?? '', styles)
      : `#${source.getAttribute(source.localName === 'sysClr' ? 'lastClr' : 'val') || '000000'}`
  if (!color) return { opacity: 1 }
  const tint = child(source, 'tint')
  const shade = child(source, 'shade')
  if (tint) color = tintColor(color, number(tint, 'val') / DRAWING_PERCENT)
  if (shade) color = tintColor(color, number(shade, 'val') / DRAWING_PERCENT - 1)
  const mod = number(child(source, 'lumMod'), 'val', DRAWING_PERCENT) / DRAWING_PERCENT
  const offset = number(child(source, 'lumOff'), 'val') / DRAWING_PERCENT
  color = luminanceColor(color, mod, offset)
  return {
    color,
    opacity: number(child(source, 'alpha'), 'val', DRAWING_PERCENT) / DRAWING_PERCENT,
  }
}

function internalLink(target: string): WorkbookDrawing['hyperlink'] {
  const match = /^#?(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/i.exec(
    target
  )
  return match ? { sheet: (match[1] ?? match[2]).replace(/''/g, "'"), range: match[3] } : undefined
}
function imageUrl(entries: Record<string, Uint8Array>, path: string): string | undefined {
  const bytes = entries[path]
  if (!bytes) return undefined
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  const mime = types[path.split('.').at(-1)?.toLowerCase() ?? '']
  if (!mime) return undefined
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${mime};base64,${btoa(binary)}`
}

function parseDrawing(
  element: Element,
  owner: string,
  drawingAnchor: DrawingAnchor,
  entries: Record<string, Uint8Array>,
  links: Map<string, Relationship>,
  styles: WorkbookStyles
): WorkbookDrawing | undefined {
  const picture = element.localName === 'pic'
  if (!picture && element.localName !== 'sp') return undefined
  const properties = child(element, 'spPr')
  const nonVisual = child(child(element, picture ? 'nvPicPr' : 'nvSpPr'), 'cNvPr')
  if (nonVisual?.getAttribute('hidden') === '1') return undefined
  const body = child(element, 'txBody')
  const bodyProperties = child(body, 'bodyPr')
  const style = child(element, 'style')
  const fontReference = child(style, 'fontRef')
  const defaultFont =
    fontReference?.getAttribute('idx') === 'major' ? styles.fonts.major : styles.fonts.minor
  const fill = paint(
    properties && child(properties, 'noFill')
      ? properties
      : (child(properties, 'solidFill') ?? child(style, 'fillRef')),
    styles
  )
  const lineElement = child(properties, 'ln')
  const line = paint(lineElement ?? child(style, 'lnRef'), styles)
  const fontPaint = paint(fontReference, styles)
  const alignment = {
    l: 'left',
    ctr: 'center',
    r: 'right',
    just: 'justify',
    dist: 'justify',
  } as const
  const paragraphs = children(body, 'p').map((paragraph): DrawingParagraph => {
    const paragraphProperties = child(paragraph, 'pPr')
    const spacing = child(paragraphProperties, 'lnSpc')
    const spacingPoints = child(spacing, 'spcPts')
    const spacingPercent = child(spacing, 'spcPct')
    const defaults = child(paragraphProperties, 'defRPr') ?? child(paragraph, 'endParaRPr')
    return {
      alignment:
        alignment[(paragraphProperties?.getAttribute('algn') ?? 'l') as keyof typeof alignment] ??
        'left',
      lineSpacing: spacingPoints
        ? { unit: 'points', value: number(spacingPoints, 'val') / DRAWING_POINTS_PER_POINT }
        : {
            unit: 'percent',
            value:
              number(
                spacingPercent,
                'val',
                DEFAULT_LINE_SPACING_PERCENT * DRAWING_PERCENT_PER_PERCENT
              ) / DRAWING_PERCENT_PER_PERCENT,
          },
      runs: children(paragraph).flatMap((run): DrawingRun[] => {
        if (run.localName === 'br')
          return [
            {
              text: '\n',
              sizePt: number(defaults, 'sz', DEFAULT_FONT_PT * 100) / 100,
              bold: false,
              italic: false,
            },
          ]
        if (run.localName !== 'r' && run.localName !== 'fld') return []
        const runProperties = child(run, 'rPr')
        const typeface =
          child(runProperties, 'latin')?.getAttribute('typeface') ??
          child(defaults, 'latin')?.getAttribute('typeface')
        const font = typeface?.startsWith('+mj-')
          ? styles.fonts.major
          : typeface?.startsWith('+mn-')
            ? styles.fonts.minor
            : typeface || defaultFont
        return [
          {
            text: child(run, 't')?.textContent ?? '',
            sizePt:
              number(runProperties, 'sz', number(defaults, 'sz', DEFAULT_FONT_PT * 100)) / 100,
            bold: (runProperties?.getAttribute('b') ?? defaults?.getAttribute('b')) === '1',
            italic: (runProperties?.getAttribute('i') ?? defaults?.getAttribute('i')) === '1',
            color:
              paint(child(runProperties, 'solidFill') ?? child(defaults, 'solidFill'), styles)
                .color ??
              fontPaint.color ??
              resolveWorkbookColor(styles.defaultFont.color, styles) ??
              themeSchemeColor('tx1', styles),
            font,
          },
        ]
      }),
    }
  })
  const preset = child(properties, 'prstGeom')?.getAttribute('prst')
  if (!picture && preset && !['rect', 'roundRect', 'ellipse'].includes(preset)) return undefined
  const geometry = preset === 'ellipse' || preset === 'roundRect' ? preset : 'rect'
  const hyperlinkNode = child(nonVisual, 'hlinkClick')
  const hyperlink = internalLink(
    links.get(hyperlinkNode?.getAttributeNS(DOCUMENT_RELATIONSHIPS, 'id') ?? '')?.target ?? ''
  )
  const blip = child(child(element, 'blipFill'), 'blip')
  const imagePart = linkedPart(
    entries,
    owner,
    links.get(blip?.getAttributeNS(DOCUMENT_RELATIONSHIPS, 'embed') ?? '')
  )
  return {
    id: `${owner}:${nonVisual?.getAttribute('id') ?? ''}`,
    name: nonVisual?.getAttribute('name') ?? '',
    anchor: drawingAnchor,
    type: picture ? 'image' : 'shape',
    geometry,
    fill: fill.color,
    fillOpacity: fill.opacity,
    line: line.color,
    lineOpacity: line.opacity,
    lineWidthEmu: number(lineElement, 'w', EMU_PER_PIXEL),
    rotation: number(child(properties, 'xfrm'), 'rot') / OFFICE_ANGLE,
    paragraphs,
    verticalAlignment:
      bodyProperties?.getAttribute('anchor') === 'ctr'
        ? 'center'
        : bodyProperties?.getAttribute('anchor') === 'b'
          ? 'bottom'
          : 'top',
    insetsEmu: {
      left: number(bodyProperties, 'lIns', DEFAULT_INSET_EMU),
      right: number(bodyProperties, 'rIns', DEFAULT_INSET_EMU),
      top: number(bodyProperties, 'tIns', DEFAULT_VERTICAL_INSET_EMU),
      bottom: number(bodyProperties, 'bIns', DEFAULT_VERTICAL_INSET_EMU),
    },
    imageDataUrl: imagePart ? imageUrl(entries, imagePart) : undefined,
    hyperlink,
  }
}

/** Follow OPC relationships from the package root to the selected worksheet's drawing parts. */
export function parseDrawings(
  bytes: Uint8Array,
  sheetName: string,
  styles = readWorkbookStyles(bytes)
): WorkbookDrawing[] {
  const entries = unzipSync(bytes)
  const rootLinks = relationships(entries, '')
  const workbook = linkedPart(
    entries,
    '',
    Array.from(rootLinks.values()).find((link) => link.type.endsWith('/officeDocument'))
  )
  if (!workbook) return []
  const document = readXml(entries[workbook])
  const sheet = Array.from(document.getElementsByTagNameNS(OOXML_NS.spreadsheet, 'sheet')).find(
    (item) => item.getAttribute('name') === sheetName
  )
  const worksheet = linkedPart(
    entries,
    workbook,
    relationships(entries, workbook).get(sheet?.getAttributeNS(DOCUMENT_RELATIONSHIPS, 'id') ?? '')
  )
  if (!worksheet) return []
  const worksheetLinks = relationships(entries, worksheet)
  return Array.from(
    readXml(entries[worksheet]).getElementsByTagNameNS(OOXML_NS.spreadsheet, 'drawing')
  ).flatMap((node) => {
    const drawing = linkedPart(
      entries,
      worksheet,
      worksheetLinks.get(node.getAttributeNS(DOCUMENT_RELATIONSHIPS, 'id') ?? '')
    )
    if (!drawing) return []
    const links = relationships(entries, drawing)
    return children(readXml(entries[drawing]).documentElement).flatMap((item) => {
      if (!['oneCellAnchor', 'twoCellAnchor', 'absoluteAnchor'].includes(item.localName)) return []
      return children(item).flatMap((shape) => {
        const result = parseDrawing(shape, drawing, anchor(item), entries, links, styles)
        return result ? [result] : []
      })
    })
  })
}

export function drawingBounds(
  drawing: WorkbookDrawing,
  grid: DrawingGrid
): { x: number; y: number; width: number; height: number } {
  const scale = grid.zoom / 100 / EMU_PER_PIXEL
  const offset = (positions: readonly number[], index: number): number =>
    positions[index] ?? positions.at(-1) ?? 0
  const position = (point: Marker, original = false): { x: number; y: number } => ({
    x: offset(original ? grid.baseColumnOffsets ?? grid.columnOffsets : grid.columnOffsets, point.column) + point.columnOffsetEmu * scale,
    y: offset(original ? grid.baseRowOffsets ?? grid.rowOffsets : grid.rowOffsets, point.row) + point.rowOffsetEmu * scale,
  })
  // twoCellAnchor can explicitly request move-only or absolute geometry.
  // Grid offsets already include zoom; only marker/extent EMUs are scaled here.
  const fixedPosition = drawing.anchor.editAs === 'absolute'
  const fixedSize = fixedPosition || drawing.anchor.editAs === 'oneCell'
  const from = drawing.anchor.from
    ? position(drawing.anchor.from, fixedPosition)
    : {
        x: (drawing.anchor.positionEmu?.x ?? 0) * scale,
        y: (drawing.anchor.positionEmu?.y ?? 0) * scale,
      }
  const sizeFrom = drawing.anchor.from && fixedSize ? position(drawing.anchor.from, true) : from
  const to = drawing.anchor.to ? position(drawing.anchor.to, fixedSize) : undefined
  return {
    x: grid.origin.x + from.x,
    y: grid.origin.y + from.y,
    width: Math.max(0, to ? to.x - sizeFrom.x : (drawing.anchor.extentEmu?.width ?? 0) * scale),
    height: Math.max(0, to ? to.y - sizeFrom.y : (drawing.anchor.extentEmu?.height ?? 0) * scale),
  }
}
