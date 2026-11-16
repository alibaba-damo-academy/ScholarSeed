import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { discover, generate, validate, PROFILES } from './schema.mjs'
import { contracts } from './catalog.mjs'
import { rules, relationships } from './rules.mjs'
import { prepareChart } from '../../../apps/desktop/src/renderer/src/components/ui/statistics.ts'
import { examples } from './examples.mjs'
import { fencedExamples } from './samples/content.mjs'
import { schemas } from '../schemas.ts'
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
const katex = require('katex')

test('the default Tabulation preview generates eleven mock rows', () => {
  const { dataset } = generate(contracts.Tabulation.schema, 'Tabulation:42', rules)
  assert.equal(dataset.rows.length, 11)
})

test('citation presets declare their real source kind independently of inherited metadata', () => {
  const presets = new Map(examples.CitationLink.map(example => [example.id, example.data]))
  assert.equal(presets.get('paper').resolution.source_kind, 'literature')
  assert.equal(presets.get('local').resolution.source_kind, 'file')
  assert.equal(presets.get('resource').resolution.source_kind, 'resource')
  assert.equal(presets.get('attachment').resolution.source_kind, 'attachment')
  assert.equal(presets.get('selection').resolution.source_kind, 'selection')
  assert.equal(presets.get('managed-fulltext').resolution.source_kind, 'managed_fulltext')
})

test('dataset contracts accept large data and column indices beyond 63', () => {
  const dataset = {
    columns: Array.from({ length: 65 }, (_, index) => ({ key: `c${index}`, label: `C${index}` })),
    rows: Array.from({ length: 10001 }, (_, index) => ({
      id: `r${index}`,
      values: Array(65).fill(index),
    })),
  }
  const errors = validate(schemas.chart, { kind: 'line', dataset, x: 0, y: [64] })
  assert.equal(errors.length, 0, errors.slice(0, 5).join('\n'))
  dataset.columns[0].label = 'x'.repeat(65537)
  dataset.rows[0].id = 'id'.repeat(100)
  assert.deepEqual(validate(schemas.dataset, dataset), [])
  assert.deepEqual(
    validate(schemas.selection, {
      selected: dataset.rows.map((row) => row.id),
    }),
    []
  )
})

test('heatmap contracts reject wide matrices and require one category axis and a value column', () => {
  const heatmap = {
    kind: 'heatmap',
    x: 0,
    y: [1],
    value: 2,
    dataset: {
      columns: ['method', 'task', 'score'].map((key) => ({ key, label: key })),
      rows: [{ id: 'a', values: ['A', 'Task', 3] }],
    },
  }
  assert.deepEqual(validate(schemas.chart, heatmap), [])
  const missing = structuredClone(heatmap)
  delete missing.value
  assert.ok(validate(schemas.chart, missing).some((error) => error.includes('value')))
  assert.ok(validate(schemas.chart, { ...heatmap, y: [1, 2] }).length)
  assert.deepEqual(validate(schemas.chart, { ...missing, kind: 'bar', y: [2] }), [])
  assert.deepEqual(validate({ type: 'number', allOf: [{ minimum: 2 }, { maximum: 4 }] }, 3), [])
  assert.ok(validate({ type: 'number', allOf: [{ minimum: 2 }] }, 1).length)
  assert.ok(validate({ if: { const: 1 }, then: { const: 2 }, else: { const: 3 } }, 1).length)
  assert.deepEqual(validate({ if: { const: 1 }, then: { const: 2 }, else: { const: 3 } }, 3), [])
})

test('documented preview presets have unique names, valid data and varied chart dimensions', () => {
  const chartNames = [
    'BarChart',
    'GroupedBarChart',
    'StackedBarChart',
    'LineChart',
    'ScatterChart',
    'PieChart',
    'DonutChart',
    'Histogram',
    'BoxPlot',
    'Heatmap',
  ]
  for (const name of [
    'Formula',
    'Tabulation',
    'ArtifactGroup',
    'Artifact',
    'Markdown',
    'Review',
    'CitationSources',
    'CitationLink',
    'Results',
    ...chartNames,
  ]) {
    const presets = examples[name]
    assert.ok(presets?.length, `${name} missing presets`)
    assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length, name)
    assert.equal(new Set(presets.map((preset) => preset.label)).size, presets.length, name)
    for (const preset of presets) {
      assert.ok(preset.id && preset.label, name)
      assert.deepEqual(validate(contracts[name].schema, preset.data), [], `${name}/${preset.id}`)
      assert.deepEqual(relationships(preset.data), [], `${name}/${preset.id}`)
      if (preset.data.model)
        assert.doesNotThrow(() => prepareChart(preset.data.model), `${name}/${preset.id}`)
    }
    if (chartNames.includes(name)) {
      assert.ok(presets.length >= 3, name)
      assert.ok(
        new Set(presets.map((preset) => preset.data.model.dataset.rows.length)).size >= 3,
        name
      )
      const magnitudes = presets
        .slice(0, 3)
        .map(({ data }) =>
          Math.max(
            ...data.model.dataset.rows.flatMap((row) =>
              row.values.filter((value) => typeof value === 'number').map(Math.abs)
            )
          )
        )
      assert.ok(magnitudes[0] < magnitudes[1] && magnitudes[1] < magnitudes[2], name)
    }
  }
  const heatmaps = examples.Heatmap.map(({ data }) => data.model.dataset.rows)
  for (const axis of [0, 1])
    assert.ok(
      new Set(heatmaps.map((rows) => new Set(rows.map((row) => row.values[axis])).size)).size >= 3
    )
  for (const name of ['GroupedBarChart', 'StackedBarChart', 'LineChart', 'ScatterChart'])
    assert.ok(new Set(examples[name].map(({ data }) => data.model.y.length)).size >= 3, name)
})

test('document feedback presets cover file formats, Markdown features and real review bibliographies', () => {
  const files = examples.Artifact.map(({ data }) => data.primary.name.split('.').at(-1))
  for (const extension of [
    'md',
    'tex',
    'bib',
    'docx',
    'pdf',
    'xlsx',
    'csv',
    'pptx',
    'py',
    'lean',
    'zip',
    'parquet',
  ])
    assert.ok(files.includes(extension), extension)
  for (const id of ['import-disabled', 'downloading', 'deleted', 'failed'])
    assert.ok(
      examples.Artifact.some((preset) => preset.id === id),
      id
    )
  for (const id of ['inline-math', 'tables', 'citations', 'code', 'images', 'mermaid', 'mixed'])
    assert.ok(
      examples.Markdown.some((preset) => preset.id === id),
      id
    )
  for (const preset of examples.Review) {
    const content = preset.data.content
    assert.equal(content.section_count, content.sections.length)
    assert.equal(content.included, content.citations.length)
    assert.equal(content.fulltext + content.abstract_only, content.included)
    assert.ok(
      content.citations.every(
        (citation) => !/合成|示例作者/.test(citation.title + citation.authors)
      )
    )
    assert.ok(content.warnings.some((warning) => /非真实任务|非模型/.test(warning)))
  }
  const table = examples.Tabulation.find((preset) => preset.id === 'sources-missing').data
  assert.ok(table.dataset.rows.some((row) => row.values.includes(null)))
  assert.ok(table.sources.every((source) => new URL(source.url).pathname.length > 1))
})

test('screenshot formula examples render except the explicit failure example', () => {
  for (const preset of examples.Formula) {
    const render = () =>
      katex.renderToString(preset.data.source, {
        trust: false,
        throwOnError: true,
      })
    if (preset.id === 'parse-error') assert.throws(render, katex.ParseError)
    else assert.doesNotThrow(render, preset.id)
  }
  assert.equal(
    fencedExamples.Code.find((preset) => preset.id === 'long-python').data.code.split('\n').length,
    23
  )
})

test('code language accepts highlighter languages and preserves unknown-language text', () => {
  for (const language of ['c++', 'typescript', 'r', 'bash', 'json', 'custom-language'])
    assert.deepEqual(
      validate(contracts.Markdown.schema, {
        text: `\`\`\`${language}\nsource\n\`\`\``,
        math: true,
      }),
      []
    )
})

test('formula preview requires only source and accepts omitted or empty caption and notes', () => {
  const schema = contracts.Formula.schema
  for (const data of [
    { source: 'E=mc^2' },
    { source: 'E=mc^2', caption: '' },
    { source: 'E=mc^2', notes: '' },
    { source: 'E=mc^2', notes: '$m$ 的单位为 kg。' },
  ])
    assert.deepEqual(validate(schema, data), [])
  assert.match(validate(schema, {}).join('\n'), /source/)
  assert.match(validate(schema, { source: 'x', notes: 3 }).join('\n'), /notes/)
})

test('all registered contracts generate repeatable constrained data for every profile and seed', () => {
  for (const [name, contract] of Object.entries(contracts)) {
    for (const profile of Object.keys(PROFILES))
      for (const seed of [1, 9, 42, 6789]) {
        const data = generate(contract.schema, `${name}:${seed}`, rules, profile)
        assert.deepEqual(
          data,
          generate(contract.schema, `${name}:${seed}`, rules, profile),
          `${name}/${profile}/${seed}`
        )
        assert.deepEqual(validate(contract.schema, data), [], `${name}/${profile}/${seed}`)
        assert.deepEqual(relationships(data), [], `${name}/${profile}/${seed}`)
        if (data.model)
          assert.doesNotThrow(() => prepareChart(data.model), `${name}/${profile}/${seed}`)
      }
  }
  assert.notDeepEqual(
    generate(contracts.BarChart.schema, 1, rules),
    generate(contracts.BarChart.schema, 2, rules)
  )
})

test('table preview accepts optional notes and cell sources without requiring decorative metadata', () => {
  const schema = contracts.Tabulation.schema
  const dataset = {
    columns: [{ key: 'value', label: '数值' }],
    rows: [{ id: 'first', values: [null] }],
  }
  assert.deepEqual(validate(schema, { dataset }), [])
  const data = {
    dataset,
    notes: '— 表示本次未提供，不代表 0。',
    sources: [
      {
        number: 1,
        kind: 'searched',
        title: '研究原文',
        url: 'https://example.invalid/paper',
        site: 'example.invalid',
      },
    ],
    citations: [{ rowId: 'first', columnKey: 'value', sourceNumber: 1 }],
  }
  assert.deepEqual(validate(schema, data), [])
  assert.deepEqual(relationships(data), [])
  data.citations[0].sourceNumber = 2
  assert.match(relationships(data).join('\n'), /sourceNumber/)
})

test('discovery is driven by real exports, including unregistered additions and forward refs', () => {
  const actual = {
    Added: () => null,
    File: { $$typeof: Symbol.for('react.forward_ref') },
    helper: 3,
  }
  const found = discover(actual, {
    File: { schema: {} },
    Removed: { schema: {} },
  })
  assert.deepEqual(
    found.map((entry) => entry.name),
    ['Added', 'File']
  )
  assert.equal(found[0].missing, true)
  assert.equal(found[1].missing, false)
})

test('invalid JSON data reports structural paths, relationship faults and unsafe names', () => {
  const schema = contracts.DataTable.schema
  const data = generate(schema, 4, rules)
  data.dataset.rows[0].values.pop()
  assert.match(relationships(data)[0], /values/)
  data.dataset.rows[0].values = 'wrong'
  assert.match(validate(schema, data)[0], /rows\[0\]\.values/)
  assert.match(validate(schema, JSON.parse('{"__proto__":{}}')).join('\n'), /不允许/)
  assert.equal({}.polluted, undefined)
  assert.throws(() => generate({ type: 'string', 'x-rule': 'not-supported' }, 1, rules), /未实现/)
  assert.throws(() => generate({ type: 'string', pattern: 'not-implemented' }, 1, rules), /未支持/)
})

test('directory metadata separates foundations in the current categories without counting menu aliases twice', () => {
  const counts = {}
  for (const contract of Object.values(contracts)) {
    if (!contract.aliasOf) counts[contract.group] = (counts[contract.group] ?? 0) + 1
  }
  assert.equal(contracts.Downloads, undefined)
  assert.equal(contracts.Delivery, undefined)
  assert.deepEqual(counts, {
    正文与富内容: 3,
    图表: 10,
    产物与工作台: 5,
    基础组件: 8,
  })
})

test('discovery deduplicates identical renderers but preserves chart types and unknown components', () => {
  const menu = () => null
  const actual = {
    ArtifactMenuItems: menu,
    FileMenuItems: menu,
    AddedAlias: menu,
    BarChart: () => null,
    GroupedBarChart: () => null,
    Unregistered: () => null,
  }
  const found = discover(actual, {
    ArtifactMenuItems: { aliasOf: 'FileMenuItems' },
    FileMenuItems: { schema: {} },
    BarChart: { schema: {} },
    GroupedBarChart: { schema: {} },
  })
  assert.deepEqual(
    found.map((entry) => entry.name),
    ['BarChart', 'FileMenuItems', 'GroupedBarChart', 'Unregistered']
  )
  assert.deepEqual(found.find((entry) => entry.name === 'FileMenuItems').aliases, [
    'AddedAlias',
    'ArtifactMenuItems',
  ])
  assert.equal(found.find((entry) => entry.name === 'Unregistered').missing, true)
  const separated = discover({ ...actual, ArtifactMenuItems: () => null }, contracts)
  assert.ok(separated.some((entry) => entry.name === 'ArtifactMenuItems'))
})
