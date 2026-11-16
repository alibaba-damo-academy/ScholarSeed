import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDirectory } from './directory.mjs'
import { GROUPS } from './catalog.mjs'
import { contracts } from './catalog.mjs'

test('host-detail preview capabilities are limited to the two approved receipt components', () => {
  for (const contract of Object.values(contracts)) {
    for (const field of ['label', 'group', 'adapter', 'description']) {
      assert.equal(typeof contract[field], 'string')
    }
    assert.ok(contract.schema && typeof contract.schema === 'object')
    assert.equal(Array.isArray(contract.schema), false)
    if ('aliasOf' in contract) assert.equal(typeof contract.aliasOf, 'string')
    if ('internal' in contract) {
      assert.equal(typeof contract.internal, 'string')
      assert.ok(contract.internal.trim())
    }
    if (contract.sidebar) {
      assert.equal(typeof contract.sidebar.name, 'string')
      if (contract.sidebar.props) {
        assert.equal(typeof contract.sidebar.props, 'object')
        assert.equal(Array.isArray(contract.sidebar.props), false)
      }
    }
  }
  assert.deepEqual(
    Object.keys(contracts)
      .filter((name) => contracts[name].sidebar)
      .sort(),
    ['Canvas', 'Results', 'Review']
  )
  assert.equal(contracts.Results.sidebar.name, 'Details')
  assert.deepEqual(contracts.Review.sidebar, { name: 'Review', props: { detail: true } })
})

test('shared directory follows official categories and merges aliases without losing chart types', () => {
  const menu = () => null
  const exports = {
    Markdown: () => null,
    BarChart: () => null,
    Plot: () => null,
    FileMenuItems: menu,
    ArtifactMenuItems: menu,
    NewCard: () => null,
  }
  const { entries, sections } = createDirectory(exports)
  assert.equal(entries.length, 5)
  assert.deepEqual(
    sections.slice(0, Object.keys(GROUPS).length).map((section) => section.label),
    Object.values(GROUPS)
  )
  assert.deepEqual(
    sections.find((section) => section.id === 'charts').items.map((item) => item.name),
    ['BarChart']
  )
  const canonical = entries.find((entry) => entry.name === 'FileMenuItems')
  assert.deepEqual(canonical.aliases, ['ArtifactMenuItems'])
  assert.equal(entries.find((entry) => entry.name === 'NewCard').missing, true)
  assert.ok(sections.at(-1).items.some((entry) => entry.name === 'NewCard'))
  delete exports.NewCard
  assert.equal(
    createDirectory(exports).entries.some((entry) => entry.name === 'NewCard'),
    false
  )
})

test('internal host utilities stay out of the preview without hiding newly discovered exports', () => {
  const { entries, internal } = createDirectory({
    ArtifactDestination: () => null,
    Details: () => null,
    FileFormatIcon: () => null,
    NewCard: () => null,
  })
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['NewCard']
  )
  assert.equal(entries[0].missing, true)
  assert.deepEqual(
    internal.map((entry) => entry.name),
    ['ArtifactDestination', 'Details', 'FileFormatIcon']
  )
})

test('host file cards retain their contract without a generated resource reference entry', () => {
  const { entries } = createDirectory({ Artifact: () => null })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'Artifact')
  assert.equal(entries[0].adapter, 'artifact')
})

test('shared building blocks form one foundations category without duplicating business entries', () => {
  const foundations = [
    'Artifact',
    'CitationLink',
    'CitationSources',
    'DataTable',
    'FileMenuItems',
    'Plot',
  ]
  const charts = [
    'BarChart',
    'BoxPlot',
    'DonutChart',
    'GroupedBarChart',
    'Heatmap',
    'Histogram',
    'LineChart',
    'PieChart',
    'ScatterChart',
    'StackedBarChart',
  ]
  const names = [
    ...foundations,
    ...charts,
    'Markdown',
    'Tabulation',
    'ArtifactGroup',
  ]
  const exports = Object.fromEntries(names.map((name) => [name, () => null]))
  exports.ArtifactMenuItems = exports.FileMenuItems
  const { entries, sections } = createDirectory(exports)
  assert.equal(GROUPS.foundations, '基础组件')
  assert.deepEqual(
    sections.find((section) => section.id === 'foundations').items.map((item) => item.name),
    foundations
  )
  assert.deepEqual(
    sections.find((section) => section.id === 'charts').items.map((item) => item.name),
    charts
  )
  for (const [name, category] of [
    ['Markdown', 'content'],
    ['Tabulation', 'content'],
    ['ArtifactGroup', 'artifacts'],
  ])
    assert.ok(
      sections.find((section) => section.id === category).items.some((item) => item.name === name)
    )
  assert.equal(entries.length, names.length)
  assert.equal(sections.flatMap((section) => section.items).length, entries.length)
  assert.deepEqual(entries.find((entry) => entry.name === 'FileMenuItems').aliases, [
    'ArtifactMenuItems',
  ])
})
