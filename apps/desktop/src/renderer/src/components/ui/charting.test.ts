import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { DOMParser } from '@xmldom/xmldom'
import type * as Charting from './legacychart'
import { CHART_KINDS } from './statistics.ts'

const require = createRequire(import.meta.url)
const compiled = buildSync({
  entryPoints: [new URL('./legacychart.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text
const loaded = { exports: {} as typeof Charting }
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports)
const { renderLegacyChartSVG, validateLegacyChartExport, CHART_EXPORT_SIZE } = loaded.exports
const request = {
  model: {
    kind: 'bar' as const,
    dataset: {
      columns: [
        { key: 'name', label: 'Method' },
        { key: 'score', label: 'Score', unit: '%' },
      ],
      rows: [
        { id: 'a', values: ['A', -2] },
        { id: 'b', values: ['B', 3] },
      ],
    },
    x: 0,
    y: [1],
  },
  width: 1200,
  height: 800,
  title: 'Chart <script>alert(1)</script>',
  notes: 'Synthetic data & testing only',
  sources: ['Dataset <v1>'],
  version: 'r3075',
}
const theme = {
  color: '#222222',
  fontFamily: 'sans-serif',
  getPropertyValue: (key: string) => (key.includes('font-size') ? '12px' : '#888888'),
}

test('boxplot median remains distinguishable from its box fill', () => {
  const svg = renderLegacyChartSVG(
    {
      ...request,
      model: {
        kind: 'boxplot',
        x: 0,
        y: [1, 2, 3, 4, 5],
        dataset: {
          columns: ['label', 'min', 'q1', 'median', 'q3', 'max'].map((key) => ({
            key,
            label: key,
          })),
          rows: [{ id: 'sample', values: ['Sample', 1, 2, 3, 4, 5] }],
        },
      },
    },
    {
      ...theme,
      getPropertyValue: (key) => (key === '--vds-chart-surface' ? '#ffffff' : '#2c5545'),
    },
    {
      sources: 'Sources',
      version: 'Version',
      frequency: 'Count',
    }
  )
  assert.match(svg, /fill="#ffffff" stroke="#2c5545"/)
})

test('standalone SVG is valid XML with the real quoted theme font stack', () => {
  const fontFamily = '"PingFang SC", "Segoe UI", "Font & More", sans-serif'
  const svg = renderLegacyChartSVG(
    request,
    { ...theme, fontFamily },
    {
      sources: 'Sources',
      version: 'Version',
      frequency: 'Count',
    }
  )
  const errors: string[] = []
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(svg, 'image/svg+xml')
  assert.deepEqual(errors, [])
  assert.ok(document.documentElement.textContent?.includes('Dataset <v1>'))
  const labels = Array.from(document.getElementsByTagName('text'))
  assert.ok(labels.some((label) => label.getAttribute('style')?.includes(fontFamily)))
})

test('SVG export preserves dimensions, units, metadata and escaped text without animation', () => {
  const svg = renderLegacyChartSVG(request, theme, {
    sources: 'Sources',
    version: 'Version',
    frequency: 'Count',
  })
  assert.match(svg, /width="1200" height="800"/)
  for (const text of [
    'Score (%)',
    'Synthetic data &amp; testing only',
    'Dataset &lt;v1&gt;',
    'r3075',
  ])
    assert.ok(svg.includes(text), text)
  assert.doesNotMatch(svg, /<script|foreignObject|@keyframes/)
  assert.match(svg, /&lt;script&gt;/)
})

test('export validation rejects invalid dimensions, data and extra executable options', () => {
  assert.equal(validateLegacyChartExport(request), true)
  for (const invalid of [
    { ...request, width: 0 },
    { ...request, height: NaN },
    { ...request, width: CHART_EXPORT_SIZE.maximum + 1 },
    { ...request, width: 900.5 },
    { ...request, sources: [null] },
    { ...request, model: { ...request.model, option: { formatter: 'callback' } } },
    { ...request, model: { ...request.model, y: [99] } },
    { ...request, svg: '<svg onload="evil()"/>' },
  ])
    assert.equal(validateLegacyChartExport(invalid), false)
})

test('every supported chart kind exports vector geometry with complete source data', () => {
  for (const kind of CHART_KINDS) {
    const model = { ...request.model, kind }
    if (kind === 'pie' || kind === 'donut')
      model.dataset = { ...model.dataset, rows: [{ id: 'slice', values: ['Positive', 2] }] }
    if (kind === 'scatter') model.x = 1
    if (kind === 'histogram') {
      model.x = 1
      model.y = []
    }
    if (kind === 'heatmap')
      model.dataset = {
        columns: ['x', 'y', 'value'].map((key) => ({ key, label: key })),
        rows: [{ id: 'cell', values: ['A', 'B', 2] }],
      }
    if (kind === 'boxplot') {
      model.dataset = {
        columns: ['group', 'min', 'q1', 'median', 'q3', 'max'].map((key) => ({ key, label: key })),
        rows: [{ id: 'box', values: ['Group A', 0, 1, 2, 3, 4] }],
      }
      model.y = [1, 2, 3, 4, 5]
    }
    const exported = {
      ...request,
      model: { ...model, ...(kind === 'heatmap' ? { value: 2 } : {}) },
    }
    const svg = renderLegacyChartSVG(exported, theme, {
      sources: 'Sources',
      version: 'Version',
      frequency: 'Count',
    })
    assert.match(svg, /<path/, kind)
    assert.match(svg, /<metadata>/, kind)
    assert.ok(svg.includes(`&quot;kind&quot;:&quot;${kind}&quot;`), kind)
    assert.doesNotMatch(svg, /NaN|<script|<foreignObject/, kind)
  }
})

test('metadata overflow fails explicitly and missing version is not invented', () => {
  assert.throws(
    () =>
      renderLegacyChartSVG({ ...request, notes: 'long note\n'.repeat(100) }, theme, {
        sources: 'Sources',
        version: 'Version',
        frequency: 'Count',
      }),
    /plot_export_metadata_too_large/
  )
  const { version, ...unversioned } = request
  const svg = renderLegacyChartSVG(unversioned, theme, {
    sources: 'Sources',
    version: 'Version',
    frequency: 'Count',
  })
  assert.doesNotMatch(svg, /Version:|r3075/)
})

test('dense multiline legends retain every series or fail instead of clipping silently', () => {
  const labels = Array.from({ length: 16 }, (_, index) => `Long scientific series ${index + 1}`)
  const grouped = {
    ...request,
    width: 320,
    height: 4096,
    model: {
      kind: 'grouped-bar' as const,
      x: 0,
      y: labels.map((_, index) => index + 1),
      dataset: {
        columns: [
          { key: 'name', label: 'Method' },
          ...labels.map((label) => ({ key: label, label })),
        ],
        rows: [{ id: 'all', values: ['A', ...labels.map((_, index) => index)] }],
      },
    },
  }
  const svg = renderLegacyChartSVG(grouped, theme, {
    sources: 'Sources',
    version: 'Version',
    frequency: 'Count',
  })
  for (const label of labels) assert.ok(svg.includes(label), label)
  assert.throws(
    () =>
      renderLegacyChartSVG({ ...grouped, height: 320 }, theme, {
        sources: 'Sources',
        version: 'Version',
        frequency: 'Count',
      }),
    /plot_export_metadata_too_large/
  )
})
