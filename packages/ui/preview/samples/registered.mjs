import zh from '../../../../apps/desktop/src/localization/locales/zh/official.json' with { type: 'json' }

const SCALES = [
  { id: 'small', count: 4, series: 2, factor: 0.1, dimensions: 4, slices: 4, paragraphs: 1, lines: 8 },
  { id: 'medium', count: 12, series: 3, factor: 1, dimensions: 6, slices: 8, paragraphs: 4, lines: 24 },
  { id: 'large', count: 48, series: 4, factor: 10, dimensions: 10, slices: 16, paragraphs: 12, lines: 96 },
]
const element = (typeName, props) => ({ type: 'element', typeName, props, partial: false })
const measurement = (index, series, factor) => Math.round((10 + ((index * 13 + series * 19) % 80)) * factor * 10) / 10
const categories = count => Array.from({ length: count }, (_, index) => `组别 ${index + 1}`)
const series = (count, setting) => Array.from({ length: setting.series }, (_, group) => element('Series', {
  category: `观测系列 ${group + 1}`,
  values: Array.from({ length: count }, (_, index) => measurement(index, group, setting.factor)),
}))

function chart(entry, setting) {
  const properties = entry.schema.properties
  const count = entry.component === 'RadarChart' ? setting.dimensions
    : properties.values ? setting.slices : setting.count
  const data = properties.title ? { title: `${entry.label}：${zh.scale[setting.id]}合成数据` } : {}
  const variant = properties.variant?.const ?? properties.variant?.enum?.[0]
  if (variant) data.variant = variant
  if (properties.datasets) {
    data.datasets = Array.from({ length: setting.series }, (_, group) => element('ScatterSeries', {
      name: `观测系列 ${group + 1}`,
      points: Array.from({ length: count }, (_, index) => element('Point', {
        x: (index - 2) * setting.factor,
        y: measurement(index, group, setting.factor),
        z: 4 + ((index + group) % 8),
      })),
    }))
    data.xLabel = '输入值（合成）'
    data.yLabel = '观测值（合成）'
  } else {
    data.labels = categories(count)
    if (properties.series) data.series = series(count, setting)
    if (properties.values) data.values = Array.from({ length: count }, (_, index) => 20 + ((index * 17) % 71))
    if (properties.xLabel) data.xLabel = entry.component === 'HorizontalBarChart' ? '观测值' : '组别'
    if (properties.yLabel) data.yLabel = entry.component === 'HorizontalBarChart' ? '组别' : '观测值'
  }
  return { data, count, series: properties.values ? 1 : setting.series,
    unit: properties.datasets ? 'points' : 'categories' }
}

const content = {
  Table: (_entry, setting) => {
    const width = setting.series + 1
    return { count: setting.count, series: width, unit: 'rows', data: {
      columns: Array.from({ length: width }, (_, column) => element('Col', {
        label: column ? `观测值 ${column}` : '组别',
        type: column ? 'number' : 'string',
        data: Array.from({ length: setting.count }, (_, index) => column
          ? measurement(index, column - 1, setting.factor) : `组别 ${index + 1}`),
      })),
    } }
  },
  TextContent: (_entry, setting) => ({ count: setting.paragraphs, unit: 'paragraphs', data: {
    text: Array.from({ length: setting.paragraphs }, (_, index) =>
      `### 观察 ${index + 1}\n\n这是用于界面预览的合成说明。**观测值**仅展示排版，不构成真实研究结论。可核对段落间距、长文本换行与[文字链接](https://example.org)。`
    ).join('\n\n'),
  } }),
  CodeBlock: (_entry, setting) => ({ count: setting.lines, unit: 'lines', data: {
    language: 'python',
    codeString: ['measurements = [',
      ...Array.from({ length: setting.lines - 3 }, (_, index) => `    {"group": ${index + 1}, "value": ${measurement(index, 0, setting.factor)}},`),
      ']', 'print(sum(item["value"] for item in measurements))'].join('\n'),
  } }),
  TagBlock: (_entry, setting) => ({ count: setting.count, unit: 'tags', data: {
    tags: Array.from({ length: setting.count }, (_, index) => `合成主题 ${index + 1}`),
  } }),
  Tag: (_entry, setting) => ({ count: setting.count, unit: 'characters', data: {
    text: '待核验的合成主题标签'.repeat(setting.count).slice(0, setting.count),
  } }),
}

export function registeredExamples(entries) {
  return Object.fromEntries(entries.filter(entry => entry.native).map(entry => {
    if (entry.component === 'Separator') return [entry.name, [
      { id: 'horizontal', label: zh.separator.horizontal, labelKey: 'separator.horizontal', data: { orientation: 'horizontal', decorative: true } },
      { id: 'vertical', label: zh.separator.vertical, labelKey: 'separator.vertical', data: { orientation: 'vertical', decorative: false } },
    ]]
    const properties = entry.schema.properties
    const chartData = properties.datasets || (properties.labels && (properties.series || properties.values))
    const build = content[entry.component] ?? (chartData ? chart : undefined)
    return [entry.name, build ? SCALES.map(setting => {
      const preset = build(entry, setting)
      return { id: setting.id, scale: setting.id,
        label: `${zh.scale[setting.id]}：${preset.count}`,
        ...preset }
    }) : []]
  }))
}

export function collectionExamples(entries, examples = {}) {
  const scaled = registeredExamples(entries)
  return Object.fromEntries(entries.map(entry => [entry.name,
    [...(examples[entry.name] ?? []), ...(scaled[entry.name] ?? [])],
  ]))
}
