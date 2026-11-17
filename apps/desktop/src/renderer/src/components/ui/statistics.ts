export type DataValue = string | number | null
export interface DataColumn {
  key: string
  label: string
  unit?: string
}
export interface DataRow {
  id: string
  values: DataValue[]
}
export interface Dataset {
  columns: DataColumn[]
  rows: DataRow[]
}
export const CHART_KINDS = [
  'bar',
  'grouped-bar',
  'stacked-bar',
  'line',
  'scatter',
  'pie',
  'donut',
  'histogram',
  'boxplot',
  'heatmap',
] as const
export type ChartKind = (typeof CHART_KINDS)[number]
export interface ChartModel {
  kind: ChartKind
  dataset: Dataset
  x: number
  y: number[]
  value?: number
  bins?: number
}

const BOX_FIELDS = 5
const CHART_GRID = { left: 52, right: 24, top: 48, bottom: 64, containLabel: true }
const ZOOM = [{ type: 'inside' }, { type: 'slider', bottom: 4 }]
const RADIUS = { pie: '65%', donut: ['40%', '65%'] }

export function validateDataset(dataset: Dataset): void {
  if (
    !dataset ||
    !Array.isArray(dataset.columns) ||
    !Array.isArray(dataset.rows) ||
    !dataset.columns.length
  )
    throw new Error('dataset_invalid')
  if (
    dataset.columns.some(
      (column) =>
        !column || typeof column.key !== 'string' || !column.key || typeof column.label !== 'string'
    ) ||
    new Set(dataset.columns.map((column) => column.key)).size !== dataset.columns.length
  )
    throw new Error('dataset_invalid_column')
  if (new Set(dataset.rows.map((row) => row.id)).size !== dataset.rows.length)
    throw new Error('dataset_duplicate_row')
  if (
    dataset.rows.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        !Array.isArray(row.values) ||
        row.values.length !== dataset.columns.length ||
        row.values.some(
          (value) =>
            value !== null &&
            typeof value !== 'string' &&
            (typeof value !== 'number' || !Number.isFinite(value))
        )
    )
  )
    throw new Error('dataset_invalid_value')
}

function field(dataset: Dataset, index: number): DataColumn {
  if (!Number.isInteger(index) || !dataset.columns[index]) throw new Error('chart_field_missing')
  return dataset.columns[index]
}

function numeric(value: DataValue, missing = true): number | null {
  if (value === null && missing) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('chart_numeric_field')
  return value
}

export function datasetTSV(dataset: Dataset): string {
  validateDataset(dataset)
  const quote = (value: DataValue): string => {
    const text = value === null ? '' : String(value)
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[\t\r\n"]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return [
    dataset.columns.map((column) => quote(column.label)),
    ...dataset.rows.map((row) => row.values.map(quote)),
  ]
    .map((row) => row.join('\t'))
    .join('\n')
}

export function prepareChart(model: ChartModel, labels: { frequency?: string } = {}) {
  const { dataset, kind, x, y } = model
  validateDataset(dataset)
  if (!CHART_KINDS.includes(kind) || !Array.isArray(y)) throw new Error('chart_kind_invalid')
  const horizontal = field(dataset, x)
  y.forEach((index) => field(dataset, index))
  if (kind !== 'histogram' && !y.length) throw new Error('chart_field_missing')
  let members = dataset.rows.map((row) => [row.id])
  let intervals: number[][] | undefined
  let categories = dataset.rows.map((row) => String(row.values[x] ?? ''))
  let series: Record<string, unknown>[]
  const vertical = (index: number): string => {
    const column = field(dataset, index)
    return column.unit ? `${column.label} (${column.unit})` : column.label
  }
  let xAxis: Record<string, unknown> = {
    type: 'category',
    data: categories,
    name: horizontal.unit ? `${horizontal.label} (${horizontal.unit})` : horizontal.label,
  }
  let yAxis: Record<string, unknown> = { type: 'value', name: y.length === 1 ? vertical(y[0]) : '' }
  let visualMap: Record<string, unknown> | undefined
  if (kind === 'histogram') {
    yAxis = { type: 'value', name: labels.frequency ?? '', minInterval: 1 }
    const values = dataset.rows.map((row) => numeric(row.values[x], false) as number)
    const minimum = values.length ? Math.min(...values) : 0
    const maximum = values.length ? Math.max(...values) : minimum
    const count = model.bins ?? Math.max(1, Math.ceil(Math.sqrt(values.length)))
    if (!Number.isInteger(count) || count < 1) throw new Error('chart_bins_invalid')
    const width = maximum === minimum ? 1 : (maximum - minimum) / count
    intervals = Array.from({ length: count }, (_, index) => [
      minimum + index * width,
      minimum + (index + 1) * width,
    ])
    members = Array.from({ length: count }, () => [])
    values.forEach((value, index) =>
      members[Math.min(count - 1, Math.floor((value - minimum) / width))].push(
        dataset.rows[index].id
      )
    )
    categories = intervals.map(
      ([lower, upper], index) => `[${lower}, ${upper}${index === count - 1 ? ']' : ')'}`
    )
    xAxis = { ...xAxis, data: categories }
    series = [{ type: 'bar', data: members.map((group) => group.length) }]
  } else if (kind === 'pie' || kind === 'donut') {
    const data = dataset.rows.map((row) => {
      const value = numeric(row.values[y[0]], false) as number
      if (value < 0) throw new Error('chart_negative_slice')
      return { name: String(row.values[x] ?? ''), value }
    })
    series = [{ type: 'pie', radius: RADIUS[kind], data, selectedMode: 'multiple' }]
  } else if (kind === 'scatter') {
    series = y.map((index) => ({
      type: 'scatter',
      name: vertical(index),
      data: dataset.rows.map((row) => [numeric(row.values[x], false), numeric(row.values[index])]),
    }))
    xAxis = { ...xAxis, type: 'value', data: undefined }
  } else if (kind === 'boxplot') {
    if (y.length !== BOX_FIELDS) throw new Error('chart_boxplot_fields')
    const data = dataset.rows.map((row) =>
      y.map((index) => numeric(row.values[index], false) as number)
    )
    if (
      data.some((values) => values.some((value, index) => index > 0 && value < values[index - 1]))
    )
      throw new Error('chart_boxplot_order')
    series = [{ type: 'boxplot', data }]
  } else if (kind === 'heatmap') {
    const valueIndex = model.value
    if (y.length !== 1 || x === y[0] || valueIndex === x || valueIndex === y[0])
      throw new Error('chart_heatmap_fields')
    if (valueIndex === undefined) throw new Error('chart_field_missing')
    field(dataset, valueIndex)
    const names = [...new Set(dataset.rows.map((row) => String(row.values[x] ?? '')))]
    const labels = [...new Set(dataset.rows.map((row) => String(row.values[y[0]] ?? '')))]
    const data = dataset.rows.map((row) => [
      names.indexOf(String(row.values[x] ?? '')),
      labels.indexOf(String(row.values[y[0]] ?? '')),
      numeric(row.values[valueIndex], false) as number,
    ])
    const values = data.map((point) => point[2])
    visualMap = {
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
    }
    xAxis = { ...xAxis, data: names }
    yAxis = { type: 'category', data: labels, name: vertical(y[0]) }
    series = [{ type: 'heatmap', data }]
  } else {
    const type = kind === 'line' ? 'line' : 'bar'
    series = y.map((index) => ({
      type,
      name: vertical(index),
      data: dataset.rows.map((row) => numeric(row.values[index])),
      ...(kind === 'stacked-bar' ? { stack: 'values' } : {}),
    }))
  }
  const circular = kind === 'pie' || kind === 'donut'
  const option = {
    animation: false,
    aria: { enabled: true },
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
    legend: { type: 'scroll', top: 0 },
    grid: CHART_GRID,
    ...(circular ? {} : { xAxis, yAxis }),
    ...(!circular && kind !== 'heatmap' ? { dataZoom: ZOOM } : {}),
    ...(visualMap ? { visualMap } : {}),
    series,
  }
  return { option, members, intervals }
}
