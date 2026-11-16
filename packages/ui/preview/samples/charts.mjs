const scale = [
  { id: 'small', label: '小规模', count: 4, series: 2, factor: 0.1 },
  { id: 'medium', label: '中等规模', count: 12, series: 3, factor: 1 },
  { id: 'large', label: '大规模', count: 48, series: 4, factor: 10 },
]
const columns = (labels) => labels.map((label, index) => ({ key: `column-${index}`, label }))
const rows = (values) => values.map((row, index) => ({ id: `row-${index + 1}`, values: row }))

function chartPreset(kind, title, setting) {
  const count = setting.count
  let labels = ['类别', '数值']
  let values = Array.from({ length: count }, (_, index) => [
    `类别 ${index + 1}`,
    10 + ((index * 17) % 83),
  ])
  let y = [1]
  let extra = {}
  if (['grouped-bar', 'stacked-bar', 'line'].includes(kind)) {
    labels = ['类别', ...Array.from({ length: setting.series }, (_, index) => `系列 ${index + 1}`)]
    values = Array.from({ length: count }, (_, index) => [
      `类别 ${index + 1}`,
      ...Array.from(
        { length: setting.series },
        (_, series) => 10 + ((index * 13 + series * 19) % 80)
      ),
    ])
    y = Array.from({ length: setting.series }, (_, index) => index + 1)
  } else if (kind === 'scatter') {
    const seriesCount = setting.series - 1
    labels = [
      '横轴数值',
      ...Array.from({ length: seriesCount }, (_, index) => `纵轴系列 ${index + 1}`),
    ]
    values = Array.from({ length: count }, (_, index) => [
      index * 2,
      ...Array.from({ length: seriesCount }, (_, series) => 10 + ((index * 17 + series * 11) % 83)),
    ])
    y = Array.from({ length: seriesCount }, (_, index) => index + 1)
  } else if (kind === 'histogram') {
    labels = ['观测值']
    values = Array.from({ length: count }, (_, index) => [20 + ((index * 17) % 67)])
    y = [0]
    extra = { bins: setting.id === 'small' ? 2 : setting.id === 'medium' ? 4 : 8 }
  } else if (kind === 'boxplot') {
    labels = ['分组', '最小值', 'Q1', '中位数', 'Q3', '最大值']
    values = Array.from({ length: count }, (_, index) => [
      `组 ${index + 1}`,
      index,
      index + 5,
      index + 10,
      index + 15,
      index + 20,
    ])
    y = [1, 2, 3, 4, 5]
  } else if (kind === 'heatmap') {
    labels = ['区域', '时段', '测量值']
    const side = setting.id === 'small' ? 2 : setting.id === 'medium' ? 4 : 8
    values = Array.from({ length: side * side }, (_, index) => [
      `区域 ${Math.floor(index / side) + 1}`,
      `时段 ${(index % side) + 1}`,
      (index * 7) % 37,
    ])
    y = [1]
    extra = { value: 2 }
  }
  values = values.map((row) =>
    row.map((value) =>
      typeof value === 'number' ? Math.round(value * setting.factor * 10) / 10 : value
    )
  )
  const seriesLabel = y.length > 1 && kind !== 'boxplot' ? ` / ${y.length} 系列` : ''
  return {
    id: setting.id,
    label: `${setting.label}：${values.length} 条${seriesLabel}`,
    data: {
      title: `${title}：${setting.label}合成数据`,
      model: { kind, dataset: { columns: columns(labels), rows: rows(values) }, x: 0, y, ...extra },
      sources: [],
      selected: [],
      notes: '仅用于展示和测试，不代表真实研究数据。',
    },
  }
}
const presets = (kind, title) => scale.map((setting) => chartPreset(kind, title, setting))
function mixedValues(kind, title) {
  const result = chartPreset(kind, title, scale[1])
  result.id = 'missing-negative'
  result.label = '负值与缺失值'
  result.data.title = `${title}：负值与缺失值（合成）`
  result.data.model.dataset.rows[0].values[1] = null
  result.data.model.dataset.rows[1].values[1] = -12
  return result
}
export const chartExamples = {
  BarChart: [...presets('bar', '柱状图'), mixedValues('bar', '柱状图')],
  GroupedBarChart: presets('grouped-bar', '分组柱状图'),
  StackedBarChart: presets('stacked-bar', '堆叠柱状图'),
  LineChart: [...presets('line', '折线图'), mixedValues('line', '折线图')],
  ScatterChart: [...presets('scatter', '散点图'), mixedValues('scatter', '散点图')],
  PieChart: presets('pie', '饼图'),
  DonutChart: presets('donut', '环图'),
  Histogram: presets('histogram', '直方图'),
  BoxPlot: presets('boxplot', '箱线图'),
  Heatmap: presets('heatmap', '热力图'),
}
