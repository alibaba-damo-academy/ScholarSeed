import { LIMITS } from './schema.mjs'
import { schemas } from '../schemas.ts'

const WORDS = ['材料', '观测', '方法', '证据', '结果', '比较', '记录', '分析']
const CHART_KINDS = new Set(schemas.chart.properties.kind.enum)
export const IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e9efea"/><text x="36" y="180" font-size="28">Synthetic preview image</text></svg>'
  )

function dataset(context, schema, normalExtraRows = 0) {
  const kind = schema['x-kind'] ?? 'bar'
  const columns =
    kind === 'boxplot'
      ? ['分组', '最小值', 'Q1', '中位数', 'Q3', '最大值']
      : kind === 'heatmap'
        ? ['区域', '时段', '温度']
        : ['材料', '质量', '净变化']
  const count =
    context.profile === 'empty'
      ? 0
      : context.profile === 'dense'
        ? LIMITS.dense
        : context.integer(3, 6) +
          (context.profile === 'normal' ? normalExtraRows : 0)
  return {
    columns: columns.map((label, index) => ({
      key: `field-${index}`,
      label,
      ...(index > 0 ? { unit: kind === 'heatmap' ? '℃' : 'kg' } : {}),
    })),
    rows: Array.from({ length: count }, (_, index) => {
      const label = `${WORDS[context.integer(0, WORDS.length - 1)]} ${index + 1}`
      let values
      if (kind === 'boxplot') {
        const ordered = Array.from({ length: 5 }, () => context.integer(0, 100)).sort(
          (left, right) => left - right
        )
        values = [label, ...ordered]
      } else if (kind === 'heatmap')
        values = [label, `时段 ${(index % 3) + 1}`, context.integer(-10, 40)]
      else if (kind === 'histogram')
        values = [context.integer(1, 100), context.integer(0, 100), context.integer(-10, 20)]
      else if (kind === 'scatter')
        values = [context.integer(0, 100), context.integer(-5, 20), context.integer(0, 50)]
      else
        values = [
          context.profile === 'long' ? label.repeat(LIMITS.long) : label,
          index === 0 ? 0 : context.integer(1, 100),
          index % 3 === 0 ? null : context.integer(-20, 20),
        ]
      return { id: `row-${index + 1}`, values }
    }),
  }
}

export const rules = Object.freeze({
  tabulation: (context, schema, visit) => {
    const result = visit({ ...schema, 'x-rule': undefined })
    result.sources.forEach((source, index) => {
      source.number = index + 1
    })
    result.citations =
      result.dataset.rows.length && result.sources.length
        ? [
            {
              rowId: result.dataset.rows[0].id,
              columnKey: result.dataset.columns.at(-1).key,
              sourceNumber: result.sources[0].number,
            },
          ]
        : []
    return result
  },
  id: (context) => 'preview-' + context.integer(1, 1000000000),
  url: (context) => `https://example.invalid/source/${context.integer(1, 99999)}`,
  text: (context, schema) => {
    const words = `${schema.title ?? '说明'}：${WORDS[context.integer(0, WORDS.length - 1)]}与${WORDS[context.integer(0, WORDS.length - 1)]} ${context.integer(1, 999)}。`
    return context.profile === 'long' ? words.repeat(LIMITS.long) : words
  },
  dataset: (context, schema) => dataset(context, schema),
  tabulationDataset: (context, schema) => dataset(context, schema, 5),
  chart: (context, schema) => {
    const kind = schema['x-kind'] ?? 'bar'
    return {
      kind,
      dataset: dataset(context, schema),
      x: 0,
      y:
        kind === 'boxplot'
          ? [1, 2, 3, 4, 5]
          : ['grouped-bar', 'stacked-bar', 'line'].includes(kind)
            ? [1, 2]
            : [1],
      ...(kind === 'heatmap' ? { value: 2 } : {}),
    }
  },
  image: () => IMAGE,
  markdown: (context) =>
    `### 合成${WORDS[context.integer(0, WORDS.length - 1)]}\n\n此内容按种子生成，不代表真实研究结果。\n\n- 观测 ${context.integer(1, 100)}\n- 记录 ${context.integer(1, 100)}`,
  formula: (context) => `$$\\frac{${context.integer(1, 20)}}{${context.integer(21, 40)}}$$`,
  diagram: (context) => `flowchart LR\n A[输入 ${context.integer(1, 100)}] --> B[核对] --> C[结果]`,
  code: (context) =>
    `values = [${context.integer(0, 100)}, ${context.integer(0, 100)}]\nprint(sum(values))`,
  search: (context, schema, visit) => {
    const result = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, visit(value)])
    )
    result.candidates = result.deduplicated = result.retained = result.papers.length
    return result
  },
  review: (context, schema, visit) => {
    const result = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, visit(value)])
    )
    result.section_count = result.sections.length
    result.included = result.references.cited_count = result.references.rows.length
    result.fulltext = Math.floor(result.included / 2)
    result.abstract_only = result.included - result.fulltext
    result.references.fulltext_cited_count = null
    result.references.abstract_cited_count = null
    result.verification.issue_count = result.verification.rows.filter((row) => row.issue).length
    return result
  },
})

export function relationships(value, path = '$') {
  const errors = []
  if (!value || typeof value !== 'object') return errors
  if (value.dataset && Array.isArray(value.citations)) {
    const sources = new Set((value.sources ?? []).map((source) => source.number))
    const rows = new Set(value.dataset.rows.map((row) => row.id))
    const columns = new Set(value.dataset.columns.map((column) => column.key))
    value.citations.forEach((citation, index) => {
      if (!sources.has(citation.sourceNumber))
        errors.push(`${path}.citations[${index}].sourceNumber：引用来源不存在`)
      if (!rows.has(citation.rowId))
        errors.push(`${path}.citations[${index}].rowId：引用数据行不存在`)
      if (!columns.has(citation.columnKey))
        errors.push(`${path}.citations[${index}].columnKey：引用数据列不存在`)
    })
  }
  if (Array.isArray(value.columns) && Array.isArray(value.rows)) {
    const ids = new Set()
    value.rows.forEach((row, index) => {
      if (ids.has(row.id)) errors.push(`${path}.rows[${index}].id：数据行 ID 必须唯一`)
      ids.add(row.id)
      if (row.values?.length !== value.columns.length)
        errors.push(`${path}.rows[${index}].values：必须与列数量一致`)
    })
  }
  if (value.dataset && CHART_KINDS.has(value.kind)) {
    const length = value.dataset.columns.length
    for (const index of [
      value.x,
      ...(value.y ?? []),
      ...(value.value === undefined ? [] : [value.value]),
    ]) {
      if (!Number.isInteger(index) || index < 0 || index >= length)
        errors.push(`${path}：图表字段索引超出列范围`)
    }
    for (const [index, row] of value.dataset.rows.entries()) {
      if (value.kind === 'histogram' && typeof row.values[value.x] !== 'number')
        errors.push(`${path}.dataset.rows[${index}]：直方图字段必须为数值`)
      if (value.kind === 'scatter' && typeof row.values[value.x] !== 'number')
        errors.push(`${path}.dataset.rows[${index}]：散点横轴必须为数值`)
      if (
        ['pie', 'donut'].includes(value.kind) &&
        value.y.some((field) => typeof row.values[field] !== 'number' || row.values[field] < 0)
      )
        errors.push(`${path}.dataset.rows[${index}]：饼图必须使用非负完整数值`)
      if (
        value.kind === 'boxplot' &&
        value.y.some(
          (field, order) => order > 0 && row.values[field] < row.values[value.y[order - 1]]
        )
      )
        errors.push(`${path}.dataset.rows[${index}]：箱线五数必须有序`)
    }
    if (value.kind === 'boxplot' && value.y.length !== 5)
      errors.push(`${path}.y：箱线图必须指定五个数值字段`)
  }
  for (const [key, child] of Object.entries(value))
    errors.push(...relationships(child, `${path}.${key}`))
  return errors
}
