import { init, use as registerCharts } from 'echarts/core'
import {
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  BoxplotChart,
  HeatmapChart,
} from 'echarts/charts'
import {
  AriaComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  VisualMapComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

registerCharts([
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  BoxplotChart,
  HeatmapChart,
  AriaComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  VisualMapComponent,
  SVGRenderer,
])

export const CHART_PALETTE = Array.from(
  { length: 8 },
  (_, index) => `--vds-chart-series-${index + 1}`
)

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const TAGS = new Set([
  'svg',
  'g',
  'defs',
  'clipPath',
  'rect',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
])
const GEOMETRY = new Set([
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'dx',
  'dy',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'd',
  'points',
  'transform',
  'viewBox',
  'preserveAspectRatio',
  'id',
  'clipPathUnits',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'fx',
  'fy',
  'fr',
  'spreadMethod',
])
const PRESENTATION = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'paint-order',
  'fill-rule',
  'clip-rule',
  'clip-path',
  'stop-color',
  'stop-opacity',
] as const
const ATTRIBUTES = new Set([...GEOMETRY, ...PRESENTATION])
const LOCAL_REFERENCE = /^url\(["']?#[\w:.-]+["']?\)$/
const PAINT =
  /^(?:#[0-9a-f]+|[a-z]+|(?:rgb|rgba|hsl|hsla|color|oklch|oklab|lab|lch)\([\w.% ,/+*-]+\))$/i
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color'])
const NATIVE_LEGEND = '.openui-chart-legend-item'
const CLIPBOARD_IMAGE_SCALE = 2
const CLIPBOARD_IMAGE_MAX_EDGE = 4096

export interface ChartExportRequest {
  svg: string
}
export interface ChartExportResult {
  ok: boolean
  canceled?: boolean
  error?: string
}
export type ChartExporter = (request: ChartExportRequest) => Promise<ChartExportResult>

function safeAttribute(name: string, value: string): boolean {
  if (name === 'clip-path') return value === 'none' || LOCAL_REFERENCE.test(value)
  if (PAINT_ATTRIBUTES.has(name)) return PAINT.test(value) || LOCAL_REFERENCE.test(value)
  return ATTRIBUTES.has(name)
}

export function prepareChartExport(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return null
  const { svg } = value as ChartExportRequest
  if (typeof svg !== 'string' || /<!|<\?/i.test(svg)) return null
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) return null
  const valid = [root, ...root.querySelectorAll('*')].every(
    (element) =>
      element.namespaceURI === SVG_NAMESPACE &&
      TAGS.has(element.localName) &&
      Array.from(element.attributes).every(({ name, value, namespaceURI }) =>
        name === 'xmlns'
          ? element === root && value === SVG_NAMESPACE
          : namespaceURI === null && safeAttribute(name, value)
      )
  )
  if (!valid) return null
  const backdrop = root.firstElementChild
  if (
    backdrop?.localName === 'rect' &&
    backdrop.attributes.length === 3 &&
    backdrop.hasAttribute('fill') &&
    root.hasAttribute('width') &&
    root.hasAttribute('height') &&
    backdrop.getAttribute('width') === root.getAttribute('width') &&
    backdrop.getAttribute('height') === root.getAttribute('height') &&
    Array.from(root.children).some((element) => element.localName === 'svg')
  ) {
    backdrop.remove()
    return new XMLSerializer().serializeToString(root)
  }
  return svg
}

export async function rasterizeChartSVG(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('plot_image_unavailable')
    const scale = Math.min(
      CLIPBOARD_IMAGE_SCALE,
      CLIPBOARD_IMAGE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight)
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('plot_image_unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('plot_image_unavailable')
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
}

function createSVG<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name)
}

function setAttributes(element: SVGElement, attributes: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
}

function copyPaint(element: SVGElement, styles: CSSStyleDeclaration): void {
  for (const name of PRESENTATION) {
    const value = styles.getPropertyValue(name).trim()
    if (value && safeAttribute(name, value)) element.setAttribute(name, value)
  }
}

function copySVG(source: SVGElement): SVGElement | null {
  if (source.namespaceURI !== SVG_NAMESPACE || !TAGS.has(source.localName)) return null
  const style = getComputedStyle(source)
  if (style.display === 'none' || style.visibility === 'hidden') return null
  const copy = document.createElementNS(SVG_NAMESPACE, source.localName)
  for (const { name, value } of source.attributes) {
    if (safeAttribute(name, value)) copy.setAttribute(name, value)
  }
  copyPaint(copy, style)
  for (const node of source.childNodes) {
    if (node instanceof SVGElement) {
      const child = copySVG(node)
      if (child) copy.append(child)
    } else if (node.nodeType === Node.TEXT_NODE) {
      copy.append(node.textContent ?? '')
    }
  }
  return copy
}

function addText(output: SVGElement, source: HTMLElement, origin: DOMRect, value: string): void {
  const bounds = source.getBoundingClientRect()
  if (!bounds.width || !bounds.height || !value) return
  const styles = getComputedStyle(source)
  const text = createSVG('text')
  copyPaint(text, styles)
  setAttributes(text, {
    x: bounds.left - origin.left,
    y: bounds.top + bounds.height / 2 - origin.top,
    fill: styles.color,
    'dominant-baseline': 'central',
  })
  text.textContent = value
  output.append(text)
}

export function captureChartSVG(
  figure: HTMLElement,
  heading: HTMLElement | null
): ChartExportRequest | null {
  const bounds = figure.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const surfaces = Array.from(figure.querySelectorAll<SVGSVGElement>('svg')).filter(
    (svg) =>
      !svg.parentElement?.closest('svg, button, [role="tooltip"]') &&
      svg.getBoundingClientRect().width &&
      svg.getBoundingClientRect().height
  )
  if (!surfaces.length) return null
  const titleHeight = heading?.parentElement?.getBoundingClientRect().height ?? 0
  const output = createSVG('svg')
  const origin = new DOMRect(
    bounds.left,
    bounds.top - titleHeight,
    bounds.width,
    bounds.height + titleHeight
  )
  setAttributes(output, {
    width: origin.width,
    height: origin.height,
    viewBox: '0 0 ' + origin.width + ' ' + origin.height,
  })
  if (heading)
    addText(
      output,
      heading,
      new DOMRect(bounds.left, heading.parentElement?.getBoundingClientRect().top ?? origin.top),
      heading.innerText
    )
  for (const surface of surfaces) {
    const copy = copySVG(surface)
    if (!copy) continue
    const box = surface.getBoundingClientRect()
    setAttributes(copy, {
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height,
    })
    output.append(copy)
  }
  for (const item of figure.querySelectorAll<HTMLElement>(NATIVE_LEGEND)) {
    const legend = createSVG('g')
    legend.setAttribute('opacity', getComputedStyle(item).opacity)
    const marker = item.querySelector<HTMLElement>('.openui-chart-legend-item-indicator')
    if (marker) {
      const box = marker.getBoundingClientRect()
      const style = getComputedStyle(marker)
      const rect = createSVG('rect')
      setAttributes(rect, {
        x: box.left - origin.left,
        y: box.top - origin.top,
        width: box.width,
        height: box.height,
        rx: parseFloat(style.borderTopLeftRadius) || 0,
        fill: style.backgroundColor,
      })
      legend.append(rect)
    }
    for (const label of item.querySelectorAll<HTMLElement>(
      '.openui-chart-legend-item-label, .openui-chart-legend-item-percentage'
    ))
      addText(legend, label, origin, label.innerText)
    output.append(legend)
  }
  return { svg: new XMLSerializer().serializeToString(output) }
}
