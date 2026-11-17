import { init, type EChartsCoreOption } from 'echarts/core'
import { CHART_PALETTE } from './charting'
import { prepareChart, type ChartModel } from './statistics'

export const CHART_EXPORT_SIZE = { width: 1200, height: 800, minimum: 320, maximum: 4096 } as const
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const EXPORT_PADDING = 24
const EXPORT_LINE_HEIGHT = 20
const EXPORT_MIN_CHART_HEIGHT = 160
const EXPORT_FONT_SIZE = 12
const EXPORT_FONT_WEIGHT = 400
const EXPORT_TEXT_FIELDS = ['title', 'notes', 'script', 'version'] as const
const EXPORT_FIELDS = ['model', 'width', 'height', 'sources', ...EXPORT_TEXT_FIELDS]
const MODEL_FIELDS = ['kind', 'dataset', 'x', 'y', 'value', 'bins']

export interface LegacyChartExportRequest {
  model: ChartModel
  width: number
  height: number
  title?: string
  notes?: string
  sources?: string[]
  script?: string
  version?: string
}
type ChartTheme = Pick<CSSStyleDeclaration, 'color' | 'fontFamily' | 'getPropertyValue'>
interface ExportLabels {
  sources: string
  version: string
  frequency: string
}

export function validateLegacyChartExport(value: unknown): value is LegacyChartExportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as LegacyChartExportRequest
  if (Object.keys(request).some((key) => !EXPORT_FIELDS.includes(key))) return false
  if (
    ![request.width, request.height].every(
      (size) =>
        Number.isInteger(size) &&
        size >= CHART_EXPORT_SIZE.minimum &&
        size <= CHART_EXPORT_SIZE.maximum
    )
  )
    return false
  if (
    EXPORT_TEXT_FIELDS.some((key) => request[key] !== undefined && typeof request[key] !== 'string')
  )
    return false
  if (
    request.sources !== undefined &&
    (!Array.isArray(request.sources) ||
      request.sources.some((source) => typeof source !== 'string'))
  )
    return false
  try {
    if (Object.keys(request.model).some((key) => !MODEL_FIELDS.includes(key))) return false
    prepareChart(request.model)
    return request.model.dataset.columns.every(
      (column) => column.unit === undefined || typeof column.unit === 'string'
    )
  } catch {
    return false
  }
}

function escapeXML(value: string): string {
  return value
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[character]!
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

export function renderLegacyChartSVG(
  request: LegacyChartExportRequest,
  theme: ChartTheme,
  labels: ExportLabels
): string {
  if (!validateLegacyChartExport(request)) throw new Error('plot_export_invalid')
  const { model, width, height } = request
  const fontSize = parseFloat(theme.getPropertyValue('--vds-chart-font-size')) || EXPORT_FONT_SIZE
  const color = theme.getPropertyValue('--vds-chart-text').trim() || theme.color
  const border = theme.getPropertyValue('--vds-border-default').trim() || color
  const fontFamily = theme.fontFamily
  const fontWeight =
    parseFloat(theme.getPropertyValue('--vds-chart-font-weight')) || EXPORT_FONT_WEIGHT
  const textStyle = { color, fontSize, fontFamily, fontWeight }
  const wrap = (text: string, available = width - EXPORT_PADDING * 2): string[] => {
    const limit = Math.max(1, Math.floor(available / fontSize))
    return text.split(/\r?\n/).flatMap((line) => {
      const characters = Array.from(line)
      return characters.length
        ? Array.from({ length: Math.ceil(characters.length / limit) }, (_, index) =>
            characters.slice(index * limit, (index + 1) * limit).join('')
          )
        : ['']
    })
  }
  const heading = request.title ? wrap(request.title) : []
  const footer = [
    request.notes,
    request.sources?.length ? `${labels.sources}: ${request.sources.join('\n')}` : undefined,
    request.script,
    request.version ? `${labels.version}: ${request.version}` : undefined,
  ]
    .filter((text): text is string => Boolean(text))
    .flatMap((text) => wrap(text))
  const top = EXPORT_PADDING + heading.length * EXPORT_LINE_HEIGHT
  const chartHeight = height - top - EXPORT_PADDING - footer.length * EXPORT_LINE_HEIGHT
  if (chartHeight < EXPORT_MIN_CHART_HEIGHT) throw new Error('plot_export_metadata_too_large')
  const prepared = prepareChart(model, { frequency: labels.frequency })
  const { containLabel: _containLabel, ...grid } = prepared.option.grid
  const circular = model.kind === 'pie' || model.kind === 'donut'
  const legendNames = circular
    ? model.dataset.rows.map((row) => String(row.values[model.x] ?? ''))
    : prepared.option.series.flatMap((series) =>
        typeof series.name === 'string' ? [series.name] : []
      )
  const legendWidth = width - EXPORT_PADDING * 2
  const legendText = (name: string): string[] => wrap(name, legendWidth - fontSize * 3)
  let legendHeight = 0
  let rowWidth = 0
  let rowHeight = 0
  for (const name of legendNames) {
    const lines = legendText(name)
    const itemWidth =
      Math.max(...lines.map((line) => Array.from(line).length)) * fontSize + fontSize * 3
    if (rowWidth && rowWidth + itemWidth > legendWidth) {
      legendHeight += rowHeight
      rowWidth = 0
      rowHeight = 0
    }
    rowWidth += itemWidth
    rowHeight = Math.max(rowHeight, lines.length * EXPORT_LINE_HEIGHT)
  }
  legendHeight += rowHeight
  if (chartHeight - legendHeight < EXPORT_MIN_CHART_HEIGHT)
    throw new Error('plot_export_metadata_too_large')
  const palette = CHART_PALETTE.map((token) => theme.getPropertyValue(token).trim()).filter(Boolean)
  const axis = {
    nameTextStyle: textStyle,
    axisLabel: textStyle,
    axisLine: { lineStyle: { color: border } },
    splitLine: { lineStyle: { color: border } },
  }
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width, height: chartHeight })
  try {
    chart.setOption({
      ...prepared.option,
      animation: false,
      backgroundColor: 'transparent',
      color: palette,
      textStyle,
      grid: {
        ...grid,
        outerBoundsMode: 'same',
        outerBoundsContain: 'all',
        top: Math.max(grid.top, legendHeight + EXPORT_PADDING),
        left: EXPORT_PADDING,
        right: EXPORT_PADDING,
      },
      tooltip: { show: false },
      legend: {
        type: 'plain',
        left: EXPORT_PADDING,
        right: EXPORT_PADDING,
        itemWidth: fontSize,
        itemHeight: fontSize,
        itemGap: fontSize,
        formatter: (name: string) => legendText(name).join('\n'),
        textStyle: { ...textStyle, lineHeight: EXPORT_LINE_HEIGHT },
      },
      dataZoom: [],
      ...('xAxis' in prepared.option
        ? {
            xAxis: { ...prepared.option.xAxis, ...axis },
            yAxis: { ...prepared.option.yAxis, ...axis },
          }
        : {}),
      ...('visualMap' in prepared.option
        ? {
            visualMap: {
              ...prepared.option.visualMap,
              textStyle,
              inRange: {
                color: [
                  '--vds-chart-heat-low',
                  '--vds-chart-heat-mid',
                  '--vds-chart-heat-high',
                ].map((token) => theme.getPropertyValue(token).trim()),
              },
            },
          }
        : {}),
      series: prepared.option.series.map((series) => ({
        ...series,
        label: { color, fontSize, fontFamily },
        ...(circular ? { top: legendHeight + EXPORT_PADDING, bottom: EXPORT_PADDING } : {}),
        ...(series.type === 'boxplot'
          ? {
              itemStyle: {
                color: theme.getPropertyValue('--vds-chart-surface').trim() || 'transparent',
                borderColor: palette[0],
              },
            }
          : {}),
      })),
    } as EChartsCoreOption)
    const figure = chart
      .renderToSVGString()
      .replaceAll(`font-family:${fontFamily};`, `font-family:${escapeXML(fontFamily)};`)
      .replace(/^<svg\b[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
    const text = (lines: string[], start: number): string =>
      lines
        .map(
          (line, index) =>
            `<text x="${EXPORT_PADDING}" y="${start + index * EXPORT_LINE_HEIGHT}" xml:space="preserve">${escapeXML(line)}</text>`
        )
        .join('')
    return `<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><metadata>${escapeXML(JSON.stringify(request))}</metadata><g font-family="${escapeXML(fontFamily)}" font-size="${fontSize}" fill="${escapeXML(color)}">${text(heading, EXPORT_PADDING)}<g transform="translate(0 ${top})">${figure}</g>${text(footer, top + chartHeight + EXPORT_LINE_HEIGHT)}</g></svg>`
  } finally {
    chart.dispose()
  }
}
