const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createRequire } = require('node:module')
const dependency = createRequire(path.resolve(__dirname, '../../../apps/desktop/package.json'))
const { build } = dependency('esbuild')
const { createParser, jsonToOpenUI } = dependency('@openuidev/lang-core')
const { previewExamples, groupedPreviewExamples } = require('./native.mjs')
const { contracts } = require('./catalog.mjs')
const { examples } = require('./examples.mjs')

test('every discovered native preview uses its real registered schema and official serializer', async context => {
  const cache = path.resolve(__dirname, '../../../apps/desktop/node_modules/.cache/openui')
  await fs.mkdir(cache, { recursive: true })
  const directory = await fs.mkdtemp(path.join(cache, 'registry-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'library.cjs')
  await build({ stdin: { contents: "export * from './library'; export { chartDataset, radialProgress } from './charts'", resolveDir: path.resolve(__dirname, '..'), loader: 'tsx' }, outfile: filename,
    bundle: true, platform: 'node', format: 'cjs', nodePaths: [path.resolve(__dirname, '../../../apps/desktop/node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' } })
  const { conversationLibrary: library, CONVERSATION_AUXILIARY_COMPONENTS: auxiliary, CONVERSATION_COMPONENT_ALIASES: aliases, chartDataset, radialProgress } = require(filename)
  await context.test('fixed-target radial progress uses the supplied denominator and retains raw values', () => {
    assert.deepEqual(radialProgress([0, 60, 100], 100), [0, 60, 100])
    assert.deepEqual(radialProgress([3], 5), [60])
    for (const [values, maximum] of [[[1], 0], [[-1], 100], [[101], 100], [[Infinity], 100]])
      assert.throws(() => radialProgress(values, maximum), /chart_radial_domain/)
    const data = chartDataset({ labels: ['Progress'], values: [60], maximum: 100 },
      { category: 'Category', value: 'Value', series: 'Series' })
    assert.deepEqual(data.rows[0].values, ['Progress', 60, 100])
    assert.match(library.prompt(), /RadialChart\(labels, values, title, maximum\)/)
  })
  const { nativeEntries, nativeTree } = await import('./native.mjs')
  const { generate, validate } = await import('./schema.mjs')
  const { validateSource, validateTree } = await import('../validation.ts')
  const entries = nativeEntries(library, auxiliary, {}, aliases)
  const labelled = nativeEntries(library, auxiliary, contracts, aliases)
  await context.test('general chart gallery includes every former chart entry with its original schema and presets', async () => {
    const { registeredExamples } = await import('./samples/registered.mjs')
    const allEntries = [...labelled, ...['Plot', 'BoxPlot', 'Heatmap', 'Histogram'].map(name => ({
      name, aliases: [], ...contracts[name],
    }))]
    const registered = registeredExamples(allEntries)
    const routed = previewExamples(allEntries, examples, contracts)
    const presets = Object.fromEntries(allEntries.map(entry => [entry.name,
      [...(registered[entry.name] ?? []), ...(routed[entry.name] ?? [])],
    ]))
    const grouped = groupedPreviewExamples(allEntries, presets, 'Plot', contracts.BarChart.group)
    const chartEntries = allEntries.filter(entry => entry.group === contracts.BarChart.group)
    assert.equal(chartEntries.length, 20)
    assert.equal(new Set(grouped.map(preset => preset.id)).size, grouped.length)
    assert.deepEqual(new Set(grouped.map(preset => preset.sample)),
      new Set(['Plot', ...chartEntries.map(entry => entry.name)]))
    for (const entry of [allEntries.find(entry => entry.name === 'Plot'), ...chartEntries]) {
      const actual = grouped.filter(preset => preset.sample === entry.name)
      assert.equal(actual.length, presets[entry.name].length, entry.name)
      for (const [index, preset] of actual.entries()) {
        assert.equal(preset.data, presets[entry.name][index].data, entry.name)
        assert.deepEqual(validate(entry.schema, preset.data), [], `${entry.name}/${preset.id}`)
      }
    }
  })
  await context.test('registered preview names and scaled examples cover real component contracts', async () => {
    assert.equal(labelled.find(entry => entry.name === 'AreaChart/natural').label, '平滑面积图')
    assert.equal(labelled.find(entry => entry.name === 'HorizontalBarChart/stacked').label, '水平堆叠条形图')
    assert.equal(labelled.find(entry => entry.name === 'Table').label, '基础表格')
    const { registeredExamples } = await import('./samples/registered.mjs')
    const presets = registeredExamples(labelled)
    for (const entry of labelled) {
      assert.match(entry.label, /[\u3400-\u9fff]/, entry.name)
      assert.ok(presets[entry.name]?.length >= 2, entry.name)
      if (entry.group === '图表') {
        assert.deepEqual(presets[entry.name].map(preset => preset.id), ['small', 'medium', 'large'], entry.name)
        assert.ok(presets[entry.name][0].count < presets[entry.name][1].count)
        assert.ok(presets[entry.name][1].count < presets[entry.name][2].count)
      }
      for (const preset of presets[entry.name]) {
        assert.deepEqual(validate(entry.schema, preset.data), [], `${entry.name}/${preset.id}`)
        const source = jsonToOpenUI(nativeTree(entry.component, preset.data, library.root), library)
        validateSource(source)
        const parsed = createParser(library.toJSONSchema(), library.root).parse(source)
        assert.deepEqual(parsed.meta.errors, [], `${entry.name}/${preset.id}`)
        assert.deepEqual(parsed.meta.unresolved, [], `${entry.name}/${preset.id}`)
        validateTree(parsed.root, Object.keys(library.components))
        if (preset.data.series) for (const series of preset.data.series)
          assert.equal(series.props.values.length, preset.data.labels.length)
        if (preset.data.values) assert.equal(preset.data.values.length, preset.data.labels.length)
        if (preset.data.columns) for (const column of preset.data.columns)
          assert.equal(column.props.data.length, preset.count)
        if (preset.data.datasets) for (const series of preset.data.datasets)
          assert.equal(series.props.points.length, preset.count)
      }
    }
  })
  assert.equal(labelled.find(entry => entry.component === 'BarChart').group, contracts.BarChart.group)
  assert.ok(entries.length > 0)
  assert.ok(entries.some(entry => entry.component === 'BarChart'))
  for (const name of ['CodeBlock', 'Separator', 'Citation', 'Artifact', 'Form', 'FormControl', 'Label', 'Input', 'TextArea', 'Select', 'SelectItem', 'CheckBoxGroup', 'CheckBoxItem', 'RadioGroup', 'RadioItem', 'Button', 'Buttons']) {
    assert.ok(!Object.hasOwn(library.components, name), `${name} is not an official conversation component`)
    assert.ok(!entries.some(entry => entry.component === name))
  }
  const prompt = library.prompt()
  assert.doesNotMatch(prompt, /(?:CodeBlock|Separator|Citation|Artifact)\(/)
  assert.ok(entries.some(entry => entry.component === 'TextContent'))
  assert.doesNotMatch(prompt, /@Submit\(|@Cancel\(/)
  assert.doesNotMatch(prompt, /@OpenUrl|@ToAssistant|@Set|@Run/)
  assert.deepEqual(Object.keys(library.actions), [])
  assert.throws(() => library.prompt({ tools: ['arbitrary_mcp'] }), /openui_capability_unavailable/)
  await context.test('upstream inspection exposes every built-in without widening the production registry', async () => {
    const inspection = path.join(directory, 'upstream.cjs')
    await build({ entryPoints: [path.resolve(__dirname, 'upstream.jsx')], outfile: inspection,
      jsx: 'automatic',
      bundle: true, platform: 'node', format: 'cjs', nodePaths: [path.resolve(__dirname, '../../../apps/desktop/node_modules')],
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty', '.webp': 'dataurl' } })
    const { upstreamEntries, upstreamExamples, upstreamLibrary, upstreamTree } = require(inspection)
    const upstream = dependency('@openuidev/react-ui').openuiLibrary
    assert.deepEqual(upstreamEntries.map(entry => entry.name).sort(), Object.keys(upstream.components).sort())
    const { collectionExamples } = await import('./samples/registered.mjs')
    const combined = collectionExamples(upstreamEntries, upstreamExamples)
    assert.deepEqual(Object.keys(upstreamExamples).sort(), upstreamEntries.map(entry => entry.name).sort())
    for (const name of ['CodeBlock', 'Separator', 'Input', 'Form', 'Modal']) {
      assert.ok(upstreamLibrary.components[name])
      assert.ok(!library.components[name])
    }
    for (const entry of upstreamEntries) {
      assert.match(entry.label, /[\u3400-\u9fff]/, entry.name)
      const scenarios = upstreamExamples[entry.name]
      const presets = combined[entry.name]
      assert.deepEqual(presets.slice(0, scenarios.length), scenarios, entry.name)
      assert.ok(presets.length >= 2, entry.name)
      assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length, entry.name)
      assert.notDeepEqual(presets[0].data, presets[1].data, entry.name)
      assert.deepEqual(entry.initial, presets[0].data, entry.name)
      if (entry.name === 'Table') {
        assert.deepEqual(presets.map(preset => preset.id), ['research', 'experiment', 'small', 'medium', 'large'])
        assert.deepEqual(presets.slice(2).map(preset => preset.count), [4, 12, 48])
      }
      for (const preset of presets) {
        const data = preset.data
        assert.deepEqual(validate(entry.schema, data), [], `${entry.name}/${preset.id}`)
        assert.doesNotMatch(JSON.stringify(data), /内容 \d+|合成 [AB]/, entry.name)
        const source = jsonToOpenUI(upstreamTree(entry.name, data), upstreamLibrary)
        const parsed = createParser(upstreamLibrary.toJSONSchema(), upstreamLibrary.root).parse(source)
        assert.deepEqual(parsed.meta.errors, [], entry.name)
        assert.deepEqual(parsed.meta.unresolved, [], entry.name)
        if (entry.name === 'SelectItem') {
          const items = upstreamTree(entry.name, data).props.children[0].props.items
          assert.equal(new Set(items.map(item => item.props.value)).size, items.length)
        }
      }
    }
  })
  await context.test('chart source tables retain gaps, duplicate labels, negative values and scatter sizes', () => {
    const labels = { category: 'Category', value: 'Value', series: 'Series' }
    const input = { labels: ['A', 'A'], xLabel: 'Time (s)', series: [
      { type: 'element', props: { category: 'Same', values: [0, -2, 9] } },
      { type: 'element', props: { category: 'Same', values: [5] } },
    ] }
    const before = JSON.stringify(input)
    const dataset = chartDataset(input, labels)
    assert.deepEqual(dataset.columns, [
      { key: 'category', label: 'Time (s)' },
      { key: 'series-0', label: 'Same' }, { key: 'series-1', label: 'Same' },
    ])
    assert.deepEqual(dataset.rows.map(row => row.values), [['A', 0, 5], ['A', -2, null], [null, 9, null]])
    assert.equal(JSON.stringify(input), before)
    const horizontal = chartDataset({ ...input, xLabel: 'Amount (kg)', yLabel: 'Group' }, labels, true)
    assert.equal(horizontal.columns[0].label, 'Group')
    assert.deepEqual(horizontal.rows, dataset.rows)
    assert.deepEqual(chartDataset({ labels: ['A', 'B'], values: [0] }, labels).rows.map(row => row.values), [['A', 0], ['B', null]])
    const scatter = chartDataset({ datasets: [
      { type: 'element', props: { name: 'Trial', points: [
        { type: 'element', props: { x: -1, y: 0, z: 3 } }, { x: 2, y: 4 },
      ] } },
    ] }, labels)
    assert.deepEqual(scatter.rows.map(row => row.values), [['Trial', -1, 0, 3], ['Trial', 2, 4, null]])
    assert.deepEqual(scatter.columns.map(column => column.label), ['Series', 'x', 'y', 'z'])
    for (const name of ['BarChart', 'LineChart', 'AreaChart', 'HorizontalBarChart', 'ScatterChart', 'PieChart', 'RadialChart', 'SingleStackedBarChart', 'RadarChart']) {
      const properties = Object.keys(library.toJSONSchema().$defs[name].properties)
      if (name === 'RadialChart') assert.deepEqual(properties.slice(-2), ['title', 'maximum'])
      else assert.equal(properties.at(-1), 'title', `${name} keeps all previous positional arguments`)
    }
  })
  await context.test('preset ownership preserves exact data and does not guess an ambiguous renderer', () => {
    const plot = { name: 'Plot', aliases: [], schema: contracts.Plot.schema }
    const charts = Object.fromEntries(['BarChart', 'GroupedBarChart', 'StackedBarChart'].map(name => [name, examples[name]]))
    const routed = previewExamples([...entries, plot], charts, contracts)
    assert.deepEqual(Object.keys(routed), ['Plot'])
    assert.equal(routed.Plot.length, Object.values(charts).flat().length)
    assert.equal(new Set(routed.Plot.map(preset => preset.id)).size, routed.Plot.length)
    assert.equal(new Set(routed.Plot.map(preset => preset.label)).size, routed.Plot.length)
    for (const [name, presets] of Object.entries(charts)) for (const preset of presets) {
      const actual = routed.Plot.find(candidate => candidate.id === `${name}/${preset.id}`)
      assert.equal(actual.data, preset.data)
      assert.deepEqual(validate(plot.schema, actual.data), [])
    }
    assert.equal(routed.Plot.find(preset => preset.id === 'BarChart/missing-negative').data.model.dataset.rows[0].values[1], null)
    assert.deepEqual(previewExamples([...entries, plot, { name: 'Unregistered', aliases: [] }], charts, contracts), routed)
    const native = entries.find(entry => entry.name === 'BarChart')
    const valid = { id: 'native', label: 'Registered', data: generate(native.schema, 'native', {}) }
    assert.equal(previewExamples(entries, { BarChart: [valid] }).BarChart[0], valid)
    const ambiguous = previewExamples([...entries, plot, { ...plot, name: 'OtherPlot' }], { BarChart: [examples.BarChart[0]] })
    assert.equal(ambiguous.BarChart[0], examples.BarChart[0])
    assert.ok(validate(native.schema, ambiguous.BarChart[0].data).length)
  })
  for (const entry of entries) await context.test(entry.name, () => {
    const data = generate(entry.schema, entry.name, {})
    assert.deepEqual(validate(entry.schema, data), [])
    const source = jsonToOpenUI(nativeTree(entry.component, data, library.root), library)
    validateSource(source)
    const parsed = createParser(library.toJSONSchema(), library.root).parse(source)
    assert.deepEqual(parsed.meta.errors, [], source)
    assert.deepEqual(parsed.meta.unresolved, [], source)
    assert.ok(parsed.root, source)
    validateTree(parsed.root, Object.keys(library.components))
  })
})
