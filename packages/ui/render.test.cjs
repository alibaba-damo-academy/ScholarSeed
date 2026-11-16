const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { chromium, expect } = desktopRequire('@playwright/test')
const { buildOfficialUI, buildExample } = require('./build.cjs')
const manifest = require('./manifest.json')
const { buildComponents } = require('../../apps/desktop/scripts/cd/components.cjs')
const { buildLaboratory, samples } = require('./demo.cjs')
const { contracts: previewContracts } = require('./preview/catalog.mjs')
const { generate } = require('./preview/schema.mjs')
const { rules } = require('./preview/rules.mjs')
const SNAPSHOTS = path.resolve(__dirname, '../../tmp/test-quality/ui-sdk')

let temporary
let browser
let officialResources
before(async () => {
  await fs.mkdir(SNAPSHOTS, { recursive: true })
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-render-'))
  await buildOfficialUI(path.join(temporary, 'official'))
  officialResources = new Set(JSON.parse(await fs.readFile(path.join(temporary, 'official/.scholarseed-package.json'), 'utf8')).files.map(resource => resource.path))
  await buildExample(path.join(temporary, 'example'))
  for (const category of ['plot', 'table', 'formula', 'markdown']) await buildComponents(path.join(temporary, 'example', category), '../../packages/ui/single.tsx')
  await buildLaboratory(path.join(temporary, 'example/laboratory'))
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  if (temporary) await fs.rm(temporary, { recursive: true, force: true })
})

async function openComponent(entry, state, embedded = false) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://resource.test/**', async route => {
    const resource = new URL(route.request().url()).pathname.slice(1)
    if (resource === 'embedded.html') return route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<body style="margin:0"><header style="height:180px">Host</header><main style="height:480px;overflow:auto"><iframe src="/" style="display:block;border:0;width:100%;height:1400px"></iframe></main><footer>Composer</footer></body>' })
    if (!resource) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div id="root"></div>' })
    const directory = resource.startsWith('__ui__/') || officialResources.has(resource) ? 'official' : 'example'
    const name = resource.replace(/^__ui__\//, '')
    await route.fulfill({ body: await fs.readFile(path.join(temporary, directory, name)), contentType: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2' })
  })
  await page.goto(`https://resource.test/${embedded ? 'embedded.html' : ''}`)
  const target = embedded ? page.frame({ url: 'https://resource.test/' }) : page
  await target.evaluate(initial => {
    let listener
    const state = structuredClone(initial)
    const actions = []
    const drafts = []
    Object.assign(window, {
      fixture: { state, actions, drafts, copySnapshots: [], copied: [], copiedPlots: [], exported: [], exportResult: {ok: true}, publish: () => listener(state) },
      plugin: {
        async exportPlot(request) { window.fixture.exported.push(request); return window.fixture.exportResult },
        async copyPlot(request) { window.fixture.copiedPlots.push(request); return {ok: true} },
        async copyText(text) { window.fixture.copied.push(text); return {copied: true} },
        async setCopyContent(content) { window.fixture.copySnapshots.push(content) },
        onState(callback) { listener = callback; callback(state); return () => { listener = undefined } },
        async save(values) { drafts.push(values); state.draft = values; listener(state); return { state: values, revision: drafts.length } },
        submit(action, values) {
          actions.push({ action, values })
          if (action === 'select' || action === 'choose') state.data = { ...state.data, ...values }
          else state.status = 'resolved'
          listener(state)
        },
      },
    })
  }, state)
  await target.addScriptTag({ url: 'https://resource.test/__ui__/ui.js' })
  if (entry) await target.addScriptTag({ url: `https://resource.test/${entry}` })
  return { page, errors, target }
}

test('review detail and copied text retain published citation numbers rather than array positions', async () => {
  const content = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../skills/community/literature-review/components/review.json'), 'utf8')).data
  content.references.rows = [
    { number: 5, title: 'Published fifth', authors: '', year: null, venue: '' },
    { number: 2, title: 'Published second', authors: '', year: null, venue: '' },
    { number: null, title: 'Unnumbered source', authors: '', year: null, venue: '' },
  ].map((citation, index) => ({
    citation_key: `sample-${index}`, paper_id: null, citation, evidence: null, target: null,
  }))
  for (const detail of [false, true]) {
    const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: { content, detail } })
    try {
      await page.evaluate(() => {
        const { React, Conversation, mount } = window.scholarseedUI
        mount(state => React.createElement(Conversation.Review, { ...state.data, ports: { openResults: async () => {} } }))
      })
      if (detail) {
        const table = page.getByRole('table', { name: '文献引用情况' })
        await expect(table).toContainText('5. Published fifth')
        await expect(table).toContainText('2. Published second')
        await expect(table).toContainText('Unnumbered source')
        await expect(table).not.toContainText('3. Unnumbered source')
      } else {
        await expect(page.locator('[data-artifact-receipt]')).toContainText('综述核对')
        await expect(page.getByRole('table')).toHaveCount(0)
      }
      await expect.poll(() => page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text)).toContain('5. Published fifth')
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test('all concrete charts export their live SVG and scroll data rows without filters or pagination', async () => {
  for (const name of ['BarChart', 'GroupedBarChart', 'StackedBarChart', 'LineChart', 'ScatterChart', 'PieChart', 'DonutChart', 'Histogram', 'BoxPlot', 'Heatmap']) {
    const data = generate(previewContracts[name].schema, 42, rules)
    const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data })
    try {
      await page.evaluate(name => {
        const { React, Conversation, mount } = window.scholarseedUI
        mount(state => React.createElement(Conversation[name], { ...state.data, onCopy: async () => {}, onSelectionChange: () => {} }))
      }, name)
      const rows = data.model.dataset.rows
      const plot = page.getByTestId('conversation-plot')
      await expect(plot.getByRole('tabpanel').locator('svg').first()).toBeVisible()
      await plot.getByTestId('plot-header').hover()
      await plot.getByRole('button', { name: '导出 SVG', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.fixture.exported.length)).toBe(1)
      const geometry = await page.evaluate(() => {
        const live = document.querySelector('[role="tabpanel"]:not([hidden])')
        const copy = new DOMParser().parseFromString(window.fixture.exported[0].svg, 'image/svg+xml')
        const paths = (root) => Array.from(root.querySelectorAll('path[d]'), path => path.getAttribute('d'))
        const exported = new Set(paths(copy))
        return paths(live).filter(path => exported.has(path)).length
      })
      assert.ok(geometry > 0, name)
      for (const count of [9, 10, 11, 21]) {
        data.model.dataset.rows = Array.from({ length: count }, (_, index) => ({ ...rows[index % rows.length], id: `page-row-${index}` }))
        data.selected = []
        await page.evaluate(data => { window.fixture.state.data = data; window.fixture.publish() }, data)
        await plot.getByTestId('plot-header').hover()
        await plot.getByRole('tab', { name: '查看原始数据', exact: true }).click()
        await expect(plot.getByRole('textbox', { name: '筛选数据行', exact: true })).toHaveCount(0)
        await expect(plot.locator('tbody tr')).toHaveCount(count)
        await expect(plot.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0)
        await expect(plot.getByRole('button', { name: '上一页', exact: true })).toHaveCount(0)
        if (count === 21) {
          const viewport = plot.getByTestId('table-scroll')
          assert.equal(await viewport.evaluate(element => element.scrollHeight > element.clientHeight), true)
          await viewport.hover()
          await page.mouse.wheel(0, 600)
          await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        }
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
  const data = generate(previewContracts.DataTable.schema, 42, rules)
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.DataTable, state.data))
    })
    await expect(page.getByRole('textbox', { name: '筛选数据行', exact: true })).toBeVisible()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('export requests a save directly in a tall frame clipped by its conversation host', async () => {
  const { page, target, errors } = await openComponent('plot/cards.js', {
    slot: 'plot.view', language: 'zh', revision: 0, status: 'resolved', data: {
      model: { kind: 'bar', x: 0, y: [1], dataset: {
        columns: [{ key: 'name', label: '类别' }, { key: 'value', label: '质量', unit: 'kg' }],
        rows: [{ id: 'a', values: ['A', 2] }],
      } },
    },
  }, true)
  try {
    await target.getByTestId('plot-header').hover()
    await target.getByRole('button', { name: '导出 SVG', exact: true }).click()
    await expect.poll(() => target.evaluate(() => window.fixture.exported.length)).toBe(1)
    await expect(target.getByRole('region', { name: '导出 SVG', exact: true })).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('independent Plot exports the chart directly without surrounding notes or metadata', async () => {
  const model = { kind: 'bar', x: 0, y: [1], dataset: {
    columns: [{ key: 'name', label: '方法' }, { key: 'value', label: '质量', unit: 'kg' }],
    rows: [{ id: 'a', values: ['甲', 2] }],
  } }
  const block = { id: 'chart', title: '导出测试', kind: 'chart', model,
    notes: '仅用于测试', sources: ['合成数据'], version: 'v1' }
  const { page, errors } = await openComponent('plot/cards.js', { slot: 'plot.view', language: 'zh', revision: 0,
    status: 'resolved', draft: {}, data: { model, title: block.title, notes: block.notes, sources: block.sources, version: block.version } })
  try {
    await page.getByTestId('plot-header').hover()
    await expect(page.getByText(block.title, { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: '导出 SVG', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.fixture.exported.length)).toBe(1)
    await expect(page.getByRole('spinbutton')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '导出 SVG', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导出 SVG', exact: true })).toBeFocused()
    const snapshot = await page.evaluate(() => {
      const figure = document.querySelector('[role="tabpanel"]:not([hidden])')
      const bar = figure.querySelector('path.openui-bar-chart-bar')
      const svg = new DOMParser().parseFromString(window.fixture.exported[0].svg, 'image/svg+xml')
      const line = Array.from(figure.querySelectorAll('svg line')).find(node =>
        getComputedStyle(node).strokeDasharray !== 'none')
      return { screen: bar && [bar.getAttribute('d'), getComputedStyle(bar).fill],
        bars: Array.from(svg.querySelectorAll('path'), path => [path.getAttribute('d'), path.getAttribute('fill')]),
        width: [figure.getBoundingClientRect().width, Number(svg.documentElement.getAttribute('width'))],
        grid: line && [getComputedStyle(line).strokeDasharray,
          Array.from(svg.querySelectorAll('line'), node => node.getAttribute('stroke-dasharray'))],
        hasBackdrop: Array.from(svg.documentElement.children).some(node =>
          node.localName === 'rect' &&
          node.getAttribute('width') === svg.documentElement.getAttribute('width') &&
          node.getAttribute('height') === svg.documentElement.getAttribute('height')),
        text: svg.documentElement.textContent }
    })
    assert.ok(snapshot.screen)
    assert.ok(snapshot.bars.some(bar => JSON.stringify(bar) === JSON.stringify(snapshot.screen)))
    assert.equal(...snapshot.width)
    assert.ok(snapshot.grid && snapshot.grid[1].includes(snapshot.grid[0]))
    assert.equal(snapshot.hasBackdrop, false)
    assert.match(snapshot.text, /质量 \(kg\)/)
    assert.doesNotMatch(snapshot.text, /合成数据|仅用于测试|v1/)
    await expect(page.getByTestId('conversation-plot').getByRole('status')).toContainText('SVG 已导出')
    await page.getByRole('button', { name: '复制图表图片', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.fixture.copiedPlots.length)).toBe(1)
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), [])
    assert.deepEqual(await page.evaluate(() => window.fixture.copiedPlots[0]), await page.evaluate(() => window.fixture.exported[0]))
    await page.getByRole('tab', { name: '数据' }).click()
    await page.getByRole('button', { name: '复制原始数据', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.fixture.copied.length)).toBe(1)
    assert.match(await page.evaluate(() => window.fixture.copied[0]), /甲\t2/)
    await page.evaluate(() => { window.fixture.exportResult = { ok: false, canceled: true } })
    await page.getByRole('button', { name: '导出 SVG', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已取消保存，未导出文件')
    const lastFigure = await page.evaluate(() => window.fixture.exported.at(-1).svg)
    assert.match(lastFigure, /质量 \(kg\)/)
    await page.evaluate(() => { window.fixture.exportResult = { ok: false, error: 'disk full' } })
    await page.getByRole('button', { name: '导出 SVG', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('SVG 导出失败，请重试')
    await page.evaluate(() => { window.fixture.exportResult = { ok: true } })
    await page.getByRole('button', { name: '导出 SVG', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('SVG 已导出')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const category of ['plot']) {
  test(`${category} composition registers complete copy text and its latest saved selection`, async () => {
    const dataset = { columns: [{ key: 'name', label: '方法' }, { key: 'score', label: '分数', unit: 'kg' }], rows: [{ id: 'a', values: ['甲', 2] }, { id: 'b', values: ['乙', null] }] }
    const { page, errors } = await openComponent(`${category}/cards.js`, { slot: 'plot.view', language: 'zh', revision: 0, status: 'pending', draft: {}, data: { title: '复制适配', model: { kind: 'bar', x: 0, y: [1], dataset }, sources: ['https://example.org/source'] } })
    try {
      const text = () => page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text ?? '')
      await expect.poll(text).toContain('https://example.org/source')
      const copied = await text()
      assert.ok(copied.startsWith('复制适配'))
      for (const value of ['方法', 'kg', '甲', '乙', 'https://example.org/source']) assert.ok(copied.includes(value), value)
      assert.doesNotMatch(copied, /按所选内容继续|查看原始数据|取消/)
      await page.getByTestId('plot-header').hover()
      await page.getByRole('tab', { name: '查看原始数据', exact: true }).click()
      await expect(page.getByRole('tab', { name: '查看原始数据', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('row').filter({ hasText: '乙' }).click()
      await expect.poll(text).toContain('已选择 1 条原始数据')
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test('typed charts expose real source data, stable selection and local failures', async () => {
  const data = { title: '真实映射', model: { kind: 'bar', x: 0, y: [1], dataset: { columns: [{ key: 'method', label: '方法' }, { key: 'score', label: '分数' }], rows: [{ id: 'first', values: ['甲', 2] }, { id: 'second', values: ['乙', -1] }, { id: 'missing', values: ['丙', null] }] } } }
  const { page, errors } = await openComponent('plot/cards.js', { slot: 'plot.view', data, draft: {}, language: 'zh', status: 'pending' })
  try {
    await expect(page.getByTestId('conversation-plot').locator('[role="img"] svg')).toBeVisible()
    await expect(page.getByTestId('conversation-plot').locator('[role="img"] svg')).toContainText('甲')
    await expect(page.getByTestId('conversation-plot').locator('[role="img"] svg')).toContainText('乙')
    await expect(page.getByTestId('conversation-plot').locator('[role="img"][tabindex="0"]')).toHaveAttribute('aria-label', /丙, 分数: 缺失/)
    await page.getByTestId('conversation-plot').locator('[role="img"][tabindex="0"]').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: '已选择 1' })).toBeVisible()
    await page.getByRole('tab', { name: '查看原始数据' }).click()
    await expect(page.getByRole('cell', { name: '-1', exact: true })).toBeVisible()
    await page.getByRole('row').filter({ hasText: '乙' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '按所选内容继续' }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [{ action: 'continue', values: { selected: ['first', 'second'] } }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared runtime blends into its host and follows both theme representations', async () => {
  const { page } = await openComponent(null, { language: 'zh', theme: 'light', status: 'pending', data: {} })
  try {
    await expect.poll(() => page.locator('body').evaluate(element => getComputedStyle(element).fontSize)).toBe('14px')
    const styles = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      return { background: body.backgroundColor, family: body.fontFamily, expectedFamily: body.getPropertyValue('--vds-font-main'), size: body.fontSize, line: body.lineHeight }
    })
    assert.equal(styles.background, 'rgba(0, 0, 0, 0)')
    assert.ok(styles.family.startsWith('"PingFang SC"'), styles.family)
    assert.equal(styles.size, '14px')
    assert.equal(styles.line, '22px')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(Conversation.Markdown, { text: '主题正文' }))
      window.fixture.state.theme = 'dark'
      window.fixture.publish()
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
    const paragraph = page.getByText('主题正文', { exact: true })
    assert.deepEqual(await paragraph.evaluate(element => ({ top: getComputedStyle(element).marginTop, bottom: getComputedStyle(element).marginBottom })), { top: '0px', bottom: '0px' })
    assert.equal(await paragraph.evaluate(element => getComputedStyle(element).color), await page.locator('body').evaluate(element => getComputedStyle(element).color))
    await page.evaluate(() => { window.fixture.state.theme = 'light'; window.fixture.publish() })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  } finally { await page.close() }
})

test('composed plots adapt to their container without nested scroll or duplicate titles', async () => {
  const dataset = { columns: [{ key: 'name', label: '材料' }, { key: 'value', label: '质量', unit: 'kg' }], rows: [{ id: 'a', values: ['长名称材料', 2] }, { id: 'b', values: ['铝', 7] }] }
  const { page } = await openComponent('plot/cards.js', { slot: 'plot.view', language: 'zh', theme: 'light', status: 'pending', data: { title: '容器中的柱状图', model: { kind: 'bar', x: 0, y: [1], dataset } } })
  try {
    const plot = page.getByTestId('conversation-plot')
    await expect(plot.getByRole('img', { name: 'Bar chart', exact: true })).toBeVisible()
    const heights = []
    for (const width of [400, 720]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(async () => plot.locator('[role="img"][tabindex]').evaluate(element => Math.round(element.clientWidth))).toBeGreaterThan(width - 100)
      heights.push(await plot.locator('[role="img"][tabindex]').evaluate(element => element.clientHeight))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    assert.ok(heights[1] > heights[0], `${heights}`)
    await expect(page.getByTestId('conversation-canvas')).toHaveCount(0)
    await expect(page.getByTestId('conversation-canvas-runtime')).toHaveCount(0)
    await expect(page.getByText('容器中的柱状图', { exact: true })).toHaveCount(1)
    await page.getByTestId('plot-header').hover()
    await page.getByRole('tab', { name: '查看原始数据' }).click()
    await expect(page.getByRole('cell', { name: '长名称材料', exact: true })).toBeVisible()
    const colors = () => plot.locator('svg[role="img"] path[fill]').evaluateAll(paths => paths.map(element => getComputedStyle(element).fill))
    const lightColors = await colors()
    await page.evaluate(() => { window.fixture.state.theme = 'dark'; window.fixture.publish() })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(colors).not.toEqual(lightColors)
  } finally { await page.close() }
})

test('shared result details do not feed the plugin viewport height back into their layout', async () => {
  const { page, errors } = await openComponent('laboratory/cards.js', { language: 'zh', status: 'resolved', data: { sample: 'Details' } })
  try {
    const heights = []
    for (const height of [420, 900]) {
      await page.setViewportSize({ width: 720, height })
      await expect(page.getByTestId('literature-search-tab')).toBeVisible()
      heights.push(await page.getByTestId('literature-search-tab').evaluate(element => element.clientHeight))
    }
    assert.equal(heights[0], heights[1], `viewport feedback: ${heights}`)
    assert.ok(heights[0] > 0 && heights[0] < 420)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('the conversation laboratory retains every export in individual cards with quiet debugging', async () => {
  const { page, errors } = await openComponent('laboratory/cards.js', { language: 'zh', theme: 'light', status: 'resolved', data: { sample: 'Markdown' } })
  try {
    const declared = await page.evaluate(() => Object.keys(window.scholarseedUI.Conversation))
    assert.deepEqual([...samples].sort(), declared.sort())
    assert.equal(samples.length, 27)
    assert.ok(!declared.includes('Downloads'))
    assert.ok(!declared.includes('Delivery'))
    for (const sample of samples) {
      await page.evaluate(sample => { window.fixture.state.data = { sample }; window.fixture.publish() }, sample)
      await expect(page.locator('[data-demo-sample]')).toHaveAttribute('data-demo-sample', sample)
      await expect(page.locator('[data-demo-component]')).toHaveCount(1)
      await expect(page.locator('[data-demo-debug] button').first()).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('[data-demo-error]')).toHaveCount(0)
    }
    await page.evaluate(() => { window.fixture.state.data = { sample: 'BarChart' }; window.fixture.publish() })
    await expect(page.locator('[data-demo-sample]')).toHaveAttribute('data-demo-sample', 'BarChart')
    await page.locator('[data-demo-debug] button').first().click()
    await expect(page.getByText('Conversation.BarChart', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '长内容', exact: true }).click()
    await page.getByRole('button', { name: '重置', exact: true }).click()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('table selection preserves literal data and cancels without executing business', async () => {
  const data = { dataset: { columns: [{ key: 'title', label: '材料' }], rows: [{ id: 'source', values: ['<script>window.evidenceExecutedForTest=true</script>'] }] } }
  const { page, errors } = await openComponent('table/cards.js', { slot: 'table.view', data, draft: {}, language: 'zh', status: 'pending' })
  try {
    await page.getByRole('checkbox', { name: '选择数据行 source', exact: true }).check()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [{ action: 'cancel', values: { selected: [] } }])
    assert.equal(await page.evaluate(() => window.evidenceExecutedForTest), undefined)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('category selection keeps unsaved edits and retries before submitting exactly once', async () => {
  const { page, errors } = await openComponent('table/cards.js', { slot: 'table.view', language: 'zh', status: 'pending', draft: {}, data: { dataset: { columns: [{ key: 'title', label: '材料' }], rows: [{ id: 'original', values: ['可重试证据'] }] } } })
  try {
    await page.evaluate(() => {
      const original = window.plugin.save
      let calls = 0
      window.plugin.save = values => ++calls === 1 ? Promise.reject(new Error('save-unavailable')) : original(values)
    })
    await page.getByRole('checkbox', { name: '选择数据行 original', exact: true }).check()
    await expect(page.getByRole('alert')).toContainText('选择尚未保存')
    await expect(page.getByRole('checkbox', { name: '选择数据行 original', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '按所选内容继续' }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [{ action: 'continue', values: { selected: ['original'] } }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('published literature adapter constructs typed ports without host access or permission escalation', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    const result = await page.evaluate(async () => {
      const calls = []
      const ports = window.scholarseedUI.createLiteraturePorts(async (action, values) => { calls.push({ action, values }); return { id: 'receipt' } }, { projectId: 'display-project' })
      const before = calls.length
      await ports.openSource('bound-paper')
      await ports.openResults()
      const receipt = await ports.addReference('bound-paper', 'collection')
      const denied = window.scholarseedUI.createLiteraturePorts(async () => { throw new Error('permission-denied') }, {})
      let failure
      try { await denied.openSource('bound-paper') } catch (error) { failure = error.message }
      return { before, calls, receipt, failure, projectId: ports.projectId }
    })
    assert.deepEqual(result, { before: 0, projectId: 'display-project', calls: [
      { action: 'open-source', values: { refId: 'bound-paper' } },
      { action: 'open-results', values: {} },
      { action: 'add-reference', values: { refId: 'bound-paper', collectionId: 'collection' } },
    ], receipt: { id: 'receipt' }, failure: 'permission-denied' })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const recovery of ['button', 'online']) {
  test(`copy registration recovers through ${recovery} without reopening or changing the snapshot`, async () => {
    const { page, errors } = await openComponent(null, { language: 'zh', revision: 0, status: 'pending', data: {} })
    try {
      await page.evaluate(() => {
        const { React, Conversation, mount } = window.scholarseedUI
        window.fixture.attempts = 0
        window.plugin.setCopyContent = async content => {
          window.fixture.attempts += 1
          if (window.fixture.attempts === 1) throw new Error('connection unavailable')
          window.fixture.copySnapshots.push(content)
        }
        mount(() => React.createElement(Conversation.Markdown, { text: '完整卡片内容' }))
      })
      await expect(page.getByRole('alert')).toContainText('卡片复制文本保存失败')
      if (recovery === 'button') await page.getByRole('button', { name: '重试', exact: true }).click()
      else await page.evaluate(() => window.dispatchEvent(new Event('online')))
      await expect(page.getByRole('alert')).toHaveCount(0)
      assert.equal(await page.evaluate(() => window.fixture.copySnapshots.at(-1).text), '完整卡片内容')
      assert.equal(await page.evaluate(() => window.fixture.attempts), 2)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test('official text, code, formula, table and artifact cards contribute complete ordered copy text', async () => {
  const {page,errors}=await openComponent(null,{language:'zh',revision:0,status:'pending',data:{}})
  try {
    await page.evaluate(()=>{
      const {React,Conversation,mount}=window.scholarseedUI
      const primary={artifact_id:'plan',title:'验证计划',name:'plan.md',path:'outputs/plan.md',status:'available'}
      const code=Array.from({length:16},(_,index)=>`source line ${index+1}`).join('\n')+'\n'
      mount(()=>React.createElement(React.Fragment,null,
        React.createElement(Conversation.Markdown,{text:'正文内容\n<!-- scholarseed-ref private -->\n[来源](https://example.org/evidence)',onOpenExternal:()=>{}}),
        React.createElement(Conversation.Markdown,{text:'```text\n'+code+'\n```'}),
        React.createElement(Conversation.Formula,{source:'E=mc^2',caption:'能量关系',notes:'质量单位 kg'}),
        React.createElement(Conversation.Tabulation,{copyText:'方法\t结果\nA\t1',sourceMarkdown:'| A | [证据](scholarseed-cite:receipt-one) |',caption:'方法对比',notes:'原始读数'}),
        React.createElement(Conversation.Artifact,{primary,versions:[primary],primaryMeta:'Markdown',canImport:false,preview:()=>{},previewVersion:()=>{},openImport:()=>{},menuProps:{apps:null,appsLoading:false,canSaveAs:false,canUsePath:false,downloading:false,loadApps:()=>{},onCopyPath:()=>{},onOpenWith:()=>{},onReveal:()=>{},onSaveAs:()=>{},revealLabel:'显示文件'}}),
      ))
    })
    await expect.poll(()=>page.evaluate(()=>window.fixture.copySnapshots.at(-1)?.text??'')).toContain('outputs/plan.md')
    const copied=await page.evaluate(()=>window.fixture.copySnapshots.at(-1).text)
    const markdown=await page.evaluate(()=>window.fixture.copySnapshots.at(-1).markdown)
    assert.ok(markdown.includes('[来源](https://example.org/evidence)'))
    assert.ok(markdown.includes('[证据](scholarseed-cite:receipt-one)'))
    const expected=['正文内容','https://example.org/evidence','source line 16','E=mc^2','能量关系','质量单位 kg','方法\t结果\nA\t1','原始读数','验证计划','outputs/plan.md']
    for(const value of expected) assert.ok(copied.includes(value),value)
    assert.ok(copied.indexOf('source line 16') < copied.indexOf('E=mc^2'))
    assert.ok(copied.indexOf('原始读数') < copied.indexOf('验证计划'))
    assert.doesNotMatch(copied,/scholarseed-ref|private|打开正文|复制路径/)
    assert.deepEqual(errors,[])
  } finally {await page.close()}
})


test('citation rechecks changed evidence before opening the exact original and preserves failure feedback', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.CitationLink), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []; window.fixture.changed = true; window.fixture.failOpen = true
      const source = { handle: 'receipt-1', pages: [{ page: 2, quads: [] }], source_kind: 'file', source_id: 'source-1', content_level: 'fulltext', project_id: 'project-1', path: 'paper.pdf', title: '原始文献.pdf', revision: 'sha256:revision-1', quote: '已核对的原文', version_bound: true, can_open_pdf: true, matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '已核对的原文', quality_reasons: [], manual_check: false } }
      mount(() => React.createElement(Conversation.CitationLink, { identity: { title: '未核验的展示标题', path: 'unverified.md' }, resolve: async () => ({ ...source, state: window.fixture.changed ? 'changed' : 'exact' }), reveal: async value => { if (window.fixture.failOpen) throw new Error('open denied'); window.fixture.opened.push({ handle: value.handle, revision: value.revision }) }, previewUrl: () => '', displayNumber: 1 }, '1'))
    })
    await page.getByRole('button').first().hover()
    const preview = page.getByLabel('引用预览', { exact: true })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('原始文献.pdf')
    await expect(preview).not.toContainText('未核验的展示标题')
    await expect(preview.locator('[data-citation-excerpt]')).toHaveCSS('-webkit-line-clamp', 'none')
    await expect(preview.getByRole('button', { name: '展开全文', exact: true })).toHaveCount(0)
    await preview.getByRole('button', { name: '原始文献.pdf', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), [])
    await page.evaluate(() => { window.fixture.changed = false })
    await page.getByRole('dialog').getByRole('button', { name: '重新检查并定位', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('原始文献.pdf')
    await page.evaluate(() => { window.fixture.failOpen = false })
    await page.getByRole('dialog').getByRole('button', { name: '重新检查并定位', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), [{ handle: 'receipt-1', revision: 'sha256:revision-1' }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('citation long excerpts collapse without losing expandable content', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      const text = '已核对的原文。'.repeat(50)
      const source = { handle: 'long-receipt', pages: [], source_kind: 'file', source_id: 'long-source', content_level: 'fulltext', project_id: 'project-1', path: 'paper.md', title: '长原文', revision: 'sha256:revision-1', quote: text, version_bound: true, state: 'exact', can_open_pdf: false, matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text, quality_reasons: [], manual_check: false } }
      mount(() => React.createElement(Conversation.CitationLink, { identity: source, resolve: async () => source, reveal: async () => {}, previewUrl: () => '' }, '1'))
    })
    await page.getByRole('button').first().hover()
    const preview = page.getByLabel('引用预览', { exact: true })
    const excerpt = preview.locator('[data-citation-excerpt]')
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    await preview.getByRole('button', { name: '展开全文', exact: true }).click()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', 'none')
    await expect(excerpt).toHaveText('已核对的原文。'.repeat(50))
    await preview.getByRole('button', { name: '收起全文', exact: true }).click()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('web citation chips retain short identity while previews navigate full sources', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      const sources = [
        { number: 1, kind: 'searched', title: 'Full research title', url: 'https://www.hbs.edu/research', search_kind: 'web', search_id: 'first', citation_urls: [], description: 'Truncated search summary ...' },
        { number: 2, kind: 'searched', title: 'Second research title', url: 'https://science.org/research', search_kind: 'web', search_id: 'second', citation_urls: [], excerpt: 'Second source abstract' },
      ]
      window.fixture.opened = []
      window.fixture.previews = []
      mount(() => React.createElement(Conversation.CitationLink, { source: sources[0], additionalSources: sources.slice(1), loadPreview: async url => {
        window.fixture.previews.push(url)
        if (url === sources[1].url) throw new Error('unavailable')
        return { title: 'Complete page title beyond the search snippet', description: 'Page metadata summary', abstract: 'Complete research abstract' }
      }, openWebSource: url => window.fixture.opened.push(url) }))
    })
    const chip = page.getByRole('button').first()
    await expect(chip).toHaveText('hbs+1')
    await expect(chip.locator('[data-citation-icon]')).toHaveCount(1)
    await chip.hover()
    await expect(page.getByText('Complete page title beyond the search snippet', { exact: true })).toBeVisible()
    await expect(page.getByText('Complete research abstract')).toBeVisible()
    await expect(page.getByText('Truncated search summary ...')).toHaveCount(0)
    await page.getByText('Second research title', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByText('Second source abstract')).toBeVisible()
    await expect(page.getByRole('status')).toBeVisible()
    await expect(chip).toHaveText('hbs+1')
    await page.getByText('Second research title', { exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://science.org/research'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('citation directory counts a verified document once and keeps separate locators', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      const base = { pages: [], source_kind: 'file', source_id: 'doc', content_level: 'fulltext', project_id: 'project', path: 'paper.pdf', title: '同一文档', revision: 'v1', quote: '原文', version_bound: true, can_open_pdf: true, state: 'exact', matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '原文', quality_reasons: [], manual_check: false } }
      const resolved = [{...base, handle: 'first'}, {...base, handle: 'second'}]
      const sources = [{ number: 1, kind: 'receipt', handle: 'first', citation_urls: [] }, { number: 2, kind: 'receipt', handle: 'second', citation_urls: [] }]
      mount(() => React.createElement(Conversation.CitationSources, { sourceKey: 'answer-1', answerSources: sources, loadSources: async () => ({ count: 2, sources: resolved }), resolveSource: async handle => resolved.find(item => item.handle === handle), reveal: async () => {}, previewUrl: () => '', openWebSource: () => {} }))
    })
    const summary = page.getByRole('button', { name: '1 个来源', exact: true })
    await expect(summary).toBeVisible()
    await expect(summary).toHaveCSS('font-size', '12px')
    await expect(summary).toHaveCSS('font-weight', '400')
    await expect(summary).toHaveCSS('line-height', '18px')
    await expect(summary).toHaveCSS('border-radius', '12px')
    assert.equal(await summary.evaluate(element => element.getBoundingClientRect().height), 34)
    await summary.click()
    await expect(page.locator('[data-citation-source-entry]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /查看引用.*同一文档/ })).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-citation-source-panel]')).toHaveCount(0)
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      const sources = Array.from({ length: 7 }, (_, index) => ({ number: index + 1, kind: 'searched', url: `https://example.org/${index}`, title: `Source ${index + 1}`, search_kind: 'web', search_id: `search-${index}`, citation_urls: [] }))
      mount(() => React.createElement(Conversation.CitationSources, { sourceKey: 'five-sources', answerSources: sources, sourceIconUrl: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0kAAAAASUVORK5CYII=', openWebSource: () => {} }))
    })
    const stacked = page.getByRole('button', { name: '7 个来源', exact: true })
    await expect(stacked.locator('[data-citation-source-icons] > span')).toHaveCount(5)
    await expect(stacked.locator('[data-citation-source-overflow]')).toHaveCount(0)
    await expect(stacked.locator('[data-citation-source-icons] img')).toHaveCount(5)
    await expect.poll(() => stacked.locator('[data-citation-source-icons] img').first().evaluate(image => image.naturalWidth)).toBe(1)
    await expect(stacked.locator('[data-citation-source-icons]')).not.toContainText('E')
    assert.equal(await stacked.locator('[data-citation-source-icons]').evaluate(element => element.getBoundingClientRect().width), 40)
    await stacked.click()
    await expect(page.locator('[data-citation-source-entry]')).toHaveCount(7)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('mixed citation directory lists deduplicated sources together in answer order and preserves opening', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []; window.fixture.failRefresh = false
      const resolved = { handle: 'receipt-2', pages: [], source_kind: 'file', source_id: 'source-2', content_level: 'abstract', project_id: 'project-1', path: 'material.pdf', title: '材料.pdf', revision: 'sha256:revision-2', quote: '摘要片段', version_bound: true, can_open_pdf: false, state: 'source_only', matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '摘要片段', quality_reasons: [], manual_check: false } }
      const resolutions = [
        resolved,
        { ...resolved, handle: 'receipt-3', source_id: 'notes', path: '笔记.md', title: '笔记.md' },
        { ...resolved, handle: 'receipt-4' },
      ]
      const web = { number: 1, kind: 'searched', title: '研究报道', url: 'https://example.org/%E5%8E%9F%E6%96%87#section', search_kind: 'web', search_id: 'search-1', citation_urls: [] }
      const sources = [
        web,
        ...resolutions.map(({ handle }, index) => ({ number: index + 2, kind: 'receipt', handle, citation_urls: [] })),
        { ...web, number: 5, title: '外部论文页', url: 'https://example.org/paper', search_kind: 'paper', search_id: 'search-2' },
        { ...web, number: 6 },
      ]
      mount(() => React.createElement(Conversation.CitationSources, { sourceKey: 'answer-1', answerSources: sources, loadSources: async () => { if (window.fixture.failRefresh) throw new Error('unavailable'); return { count: resolutions.length, sources: resolutions } }, resolveSource: async handle => resolutions.find(source => source.handle === handle), reveal: async value => window.fixture.opened.push(value.handle), previewUrl: () => '', openWebSource: url => window.fixture.opened.push(url) }))
    })
    const summary = page.getByRole('button', { name: '4 个来源', exact: true })
    await summary.click()
    const directory = page.locator('[data-citation-source-panel]')
    const list = directory.getByRole('list', { name: '4 个来源', exact: true })
    await expect(directory.getByRole('tablist')).toHaveCount(0)
    await expect(list.getByRole('listitem')).toHaveText([
      /研究报道/,
      /材料.pdf/,
      /笔记.md/,
      /外部论文页/,
    ])
    await expect(directory).toHaveCSS('width', '340px')
    await expect(directory).toHaveCSS('border-radius', '12px')
    const webCard = directory.getByRole('button', { name: /查看引用.*研究报道/ })
    await expect(webCard).toHaveCSS('padding', '8px')
    await expect(webCard.getByText('网页', { exact: true })).toHaveCount(0)
    const layout = await webCard.evaluate(card => {
      const style = getComputedStyle(card)
      const grid = card.querySelector('[data-citation-source-title]').parentElement
      const bounds = grid.getBoundingClientRect()
      const rows = Array.from(grid.children, child => {
        const row = child.getBoundingClientRect()
        return { top: row.top, bottom: row.bottom, left: row.left, right: row.right, height: child.offsetHeight }
      })
      const gap = Number.parseFloat(getComputedStyle(grid).rowGap)
      const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((total, property) => total + Number.parseFloat(style[property]), 0)
      return { height: card.offsetHeight, naturalHeight: rows.reduce((total, row) => total + row.height, 0) + gap * (rows.length - 1) + inset, gap, rows, contentTop: bounds.top, contentBottom: bounds.bottom, contentLeft: bounds.left, contentRight: bounds.right }
    })
    assert.equal(layout.gap, 4)
    assert.equal(layout.height, layout.naturalHeight)
    assert.ok(layout.rows.every(row => row.top >= layout.contentTop && row.bottom <= layout.contentBottom && row.left >= layout.contentLeft && row.right <= layout.contentRight), JSON.stringify(layout))
    await expect(webCard.locator('[data-citation-source-domain]')).toHaveText('example.org')
    await expect(webCard.locator('[data-citation-source-title]')).toHaveCSS('font-size', '14px')
    await expect(webCard.locator('[data-citation-source-title]')).toHaveCSS('line-height', '20px')
    await page.getByRole('button', { name: /查看引用.*研究报道/ }).click()
    await expect(page.getByLabel('网页来源预览')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://example.org/%E5%8E%9F%E6%96%87#section'])
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.fixture.failRefresh = true })
    await summary.click()
    await directory.hover()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(directory).toHaveCSS('opacity', '1')
    await expect(directory).toBeInViewport()
    await expect(page.getByText('暂时无法更新来源状态，已保留上次信息；可点击引用重试。', { exact: true })).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await page.screenshot({ path: path.join(SNAPSHOTS, 'citation-component.png') })
    const fileCard = directory.getByRole('button', { name: /查看引用.*材料.pdf/ }).first()
    await expect(fileCard).toHaveAttribute('data-citation-source-card', 'true')
    await fileCard.hover()
    await expect(page.getByLabel('引用预览', { exact: true })).toHaveCount(0)
    await fileCard.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://example.org/%E5%8E%9F%E6%96%87#section', 'receipt-2'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('file source cards open verified PDF, spreadsheet and Markdown sources without hover previews', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    for (const extension of ['pdf', 'xlsx', 'md']) {
      await page.evaluate((extension) => {
        const { React, Conversation, mount } = window.scholarseedUI
        window.fixture.opened = []
        const source = { handle: 'file', pages: [], source_kind: 'file', source_id: 'file', content_level: 'structured_text', project_id: 'project', path: `notes.${extension}`, title: `notes.${extension}`, revision: 'v1', quote: '', version_bound: true, can_open_pdf: false, state: 'source_only', matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '', quality_reasons: [], manual_check: false } }
        mount(() => React.createElement(Conversation.CitationSources, { sourceKey: extension, answerSources: [{ number: 1, kind: 'receipt', handle: 'file', citation_urls: [] }], loadSources: async () => ({ count: 1, sources: [source] }), resolveSource: async () => source, reveal: async value => window.fixture.opened.push(value.path), previewUrl: () => '', openWebSource: () => {} }))
      }, extension)
      await page.getByRole('button', { name: '1 个来源', exact: true }).click()
      const card = page.getByRole('button', { name: `查看引用：notes.${extension}`, exact: true })
      await expect(card).toHaveAttribute('data-citation-source-card', 'true')
      await card.hover()
      await expect(page.getByLabel('引用预览', { exact: true })).toHaveCount(0)
      await card.click()
      await expect.poll(() => page.evaluate(() => window.fixture.opened)).toEqual([`notes.${extension}`])
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-citation-source-panel]')).toHaveCount(0)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const count of [3, 12]) test(`artifact group wraps ${count} complete cards without batch actions or shared operation results`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.artifacts', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ArtifactGroup), 'function')
    await page.setViewportSize({ width: 960, height: 800 })
    await page.evaluate(count => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []
      function Example() {
        const [results, setResults] = React.useState({})
        return React.createElement(Conversation.ArtifactGroup, null, Array.from({ length: count }, (_, index) => {
          const primary = { artifact_id: `file-${index}`, publication_id: 'publication-1', role: 'final', status: 'available', name: `非常长的研究产物名称-${index}.md`, path: `report-${index}.md` }
          return React.createElement(Conversation.Artifact, { key: primary.artifact_id, primary, versions: [primary], primaryMeta: 'Markdown', canImport: true,
            preview: value => window.fixture.opened.push(value.artifact_id), previewVersion: value => window.fixture.opened.push(value.artifact_id),
            openImport: () => setResults(current => ({ ...current, [primary.artifact_id]: '样例导入失败，可重试' })),
            menuProps: { apps: [], appsLoading: false, canUsePath: false, canSaveAs: false, downloading: false, loadApps: () => {}, onOpenWith: () => {}, onCopyPath: () => {}, onReveal: () => {}, onSaveAs: () => {}, revealLabel: '显示文件' },
          }, React.createElement('p', { role: 'status' }, results[primary.artifact_id] || '尚未导入'))
        }))
      }
      mount(() => React.createElement(Example))
    }, count)
    const cards = page.locator('[data-artifact-card]')
    await expect(cards).toHaveCount(count)
    const first = await cards.nth(0).boundingBox()
    const second = await cards.nth(1).boundingBox()
    assert.equal(first.y, second.y)
    assert.equal(second.x - first.x - first.width, 8)
    assert.equal(first.width, second.width)
    await page.setViewportSize({ width: 390, height: 800 })
    const stackedFirst = await cards.nth(0).boundingBox()
    const stackedSecond = await cards.nth(1).boundingBox()
    assert.equal(stackedFirst.x, stackedSecond.x)
    assert.ok(stackedSecond.y >= stackedFirst.y + stackedFirst.height + 8)
    assert.ok(stackedFirst.width > 300)
    await page.setViewportSize({ width: 960, height: 800 })
    await cards.nth(1).getByTestId('artifact-import-resources').click()
    await expect(cards.nth(1).getByRole('status')).toHaveText('样例导入失败，可重试')
    await expect(cards.nth(0).getByRole('status')).toHaveText('尚未导入')
    if (count === 3) await page.screenshot({ path: path.join(SNAPSHOTS, 'artifact-group-component.png') })
    await cards.nth(count - 1).getByTestId('artifact-open').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), [`file-${count - 1}`])
    await expect(page.getByRole('heading')).toHaveCount(0)
    await page.setViewportSize({ width: 260, height: 800 })
    const narrowFirst = await cards.nth(0).boundingBox()
    const narrowSecond = await cards.nth(1).boundingBox()
    assert.equal(narrowFirst.x, narrowSecond.x)
    assert.ok(narrowSecond.y >= narrowFirst.y + narrowFirst.height)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await cards.nth(count - 1).getByTestId('artifact-open').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), [`file-${count - 1}`, `file-${count - 1}`])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const family of ['DropdownMenu', 'ContextMenu', 'Menubar']) test(`nested menu selection closes its chain while Escape retreats one level: ${family}`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(family => {
      const ui = window.scholarseedUI
      const { React, Button, mount } = ui
      const root = family === 'Menubar' ? ui.MenubarMenu : ui[family]
      const trigger = ui[`${family}Trigger`]
      const content = ui[`${family}Content`]
      const sub = ui[`${family}Sub`]
      const subTrigger = ui[`${family}SubTrigger`]
      const subContent = ui[`${family}SubContent`]
      const item = ui[`${family}Item`]
      window.fixture.calls = []
      mount(() => React.createElement(root, null,
        React.createElement(trigger, { asChild: true }, React.createElement(Button, null, '操作')),
        React.createElement(content, null,
          React.createElement(sub, null,
            React.createElement(subTrigger, null, '一级'),
            React.createElement(subContent, null,
              React.createElement(sub, null,
                React.createElement(subTrigger, null, '二级'),
                React.createElement(subContent, null,
                  React.createElement(item, { onSelect: () => window.fixture.calls.push('selected') }, '最终操作'))))))))
    }, family)
    const open = () => page.getByRole('button', { name: '操作', exact: true }).click(family === 'ContextMenu' ? { button: 'right' } : {})
    await open()
    for (const name of ['一级', '二级']) {
      await page.getByRole('menuitem', { name, exact: true }).focus()
      await page.keyboard.press('ArrowRight')
    }
    await expect(page.getByRole('menuitem', { name: '最终操作', exact: true })).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(3)
    await expect(page.getByRole('menuitem', { name: '最终操作', exact: true })).toBeInViewport({ ratio: 1 })
    if (family === 'DropdownMenu') await page.screenshot({ path: path.join(SNAPSHOTS, 'file-menu-component.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(2)
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    await page.getByRole('menuitem', { name: '二级', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('menuitem', { name: '最终操作', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['selected'])
    await open()
    await expect(page.getByRole('menu')).toHaveCount(1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared menus keep their last action reachable in short plugin viewports', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.setViewportSize({ width: 420, height: 210 })
    await page.evaluate(() => {
      const { React, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, mount } = window.scholarseedUI
      mount(() => React.createElement(DropdownMenu, null,
        React.createElement(DropdownMenuTrigger, { asChild: true }, React.createElement(Button, null, '操作')),
        React.createElement(DropdownMenuContent, null, Array.from({ length: 9 }, (_, index) => React.createElement(DropdownMenuItem, { key: index }, `操作 ${index + 1}`)))))
    })
    await page.getByRole('button', { name: '操作', exact: true }).click()
    await expect(page.getByRole('menu')).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('End')
    await expect(page.getByRole('menuitem', { name: '操作 9', exact: true })).toBeFocused()
    await expect(page.getByRole('menuitem', { name: '操作 9', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Home')
    await expect(page.getByRole('menuitem', { name: '操作 1', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const directory of [false, true]) test(`shared file menu preserves complete actions and directory restrictions: ${directory}`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.FileMenuItems), 'function')
    assert.equal(await page.evaluate(() => window.scholarseedUI.Conversation.FileMenuItems === window.scholarseedUI.Conversation.ArtifactMenuItems), true)
    await page.evaluate(directory => {
      const { React, Conversation, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, mount } = window.scholarseedUI
      window.fixture.calls = []
      function Example() {
        const [apps, setApps] = React.useState(null)
        const record = action => window.fixture.calls.push(action)
        return React.createElement(DropdownMenu, null,
          React.createElement(DropdownMenuTrigger, { asChild: true }, React.createElement(Button, null, '文件操作')),
          React.createElement(DropdownMenuContent, null, React.createElement(Conversation.FileMenuItems, {
            kind: 'dropdown', directory, apps, appsLoading: false, canUsePath: true, canSaveAs: true, downloading: false, canImport: true,
            onOpen: () => record('open'), onImport: () => record('import'), onSaveAs: () => record('save'), onCopyPath: () => record('copy'), onReveal: () => record('reveal'),
            loadApps: () => setApps([{ name: 'Editor', path: '/sample/editor', isDefault: true }]),
            onOpenWith: app => record(`app:${app.path}`), revealLabel: '在文件管理器中显示',
          })))
      }
      mount(() => React.createElement(Example))
    }, directory)
    const open = async () => {
      const trigger = page.getByRole('button', { name: '文件操作', exact: true })
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    }
    for (const name of directory ? ['打开'] : ['打开', '导入资料库', '另存为…']) {
      await open()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    if (!directory) {
      await open()
      await page.getByTestId('artifact-dropdown-open-with').focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitem', { name: /Editor/ })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '复制路径', exact: true })).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('menuitem', { name: /Editor/ })).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: path.join(SNAPSHOTS, 'file-actions-component.png') })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '文件操作', exact: true })).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('menuitem', { name: /Editor/ })).toHaveCount(0)
      await page.getByTestId('artifact-dropdown-open-with').focus()
      await page.keyboard.press('ArrowRight')
      await page.getByRole('menuitem', { name: /Editor/ }).click()
    }
    await open()
    if (directory) {
      await expect(page.getByRole('menuitem')).toHaveCount(3)
      await expect(page.getByTestId('artifact-dropdown-open-with')).toHaveCount(0)
    }
    await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
    await open()
    await page.getByRole('menuitem', { name: '在文件管理器中显示', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), directory ? ['open', 'copy', 'reveal'] : ['open', 'import', 'save', 'app:/sample/editor', 'copy', 'reveal'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('file actions do not enable unavailable host ports', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, mount } = window.scholarseedUI
      window.fixture.calls = []
      mount(() => React.createElement(DropdownMenu, null,
        React.createElement(DropdownMenuTrigger, { asChild: true }, React.createElement(Button, null, '文件操作')),
        React.createElement(DropdownMenuContent, null, React.createElement(Conversation.FileMenuItems, {
          kind: 'dropdown', apps: null, appsLoading: false, canUsePath: false, canSaveAs: true, downloading: false,
          loadApps: () => window.fixture.calls.push('apps'), onOpenWith: () => window.fixture.calls.push('open'),
          onCopyPath: () => window.fixture.calls.push('copy'), onReveal: () => window.fixture.calls.push('reveal'), revealLabel: '在文件管理器中显示',
        }))))
    })
    await page.getByRole('button', { name: '文件操作', exact: true }).click()
    for (const name of ['打开方式', '另存为…', '复制路径', '在文件管理器中显示']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeDisabled()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared artifact keeps version identity, deep menus and independent open/import ports', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.artifact', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.artifactActions = []
      const primary = { artifact_id: 'revision-2', publication_id: 'publication-1', name: 'report.tex', title: '研究报告', path: 'report.md', role: 'final', status: 'available' }
      const versions = [primary, { ...primary, artifact_id: 'revision-1' }]
      function Example() {
        const record = (action, value) => { window.fixture.artifactActions.push({ action, value }) }
        return React.createElement(Conversation.Artifact, {
          primary, versions, primaryMeta: 'Markdown', canImport: true,
          preview: value => record('preview', value.artifact_id), previewVersion: value => record('version', value.artifact_id), openImport: () => record('import', primary.artifact_id),
          menuProps: { apps: [{ name: 'Editor', path: '/apps/editor', isDefault: true }], appsLoading: false, canUsePath: true, canSaveAs: true, downloading: false,
            loadApps: () => {}, onOpenWith: value => record('open-with', value.path), onCopyPath: () => record('copy-path', primary.artifact_id), onReveal: () => record('reveal', primary.artifact_id), onSaveAs: () => record('save-as', primary.artifact_id), revealLabel: '在文件管理器中显示' },
        }, React.createElement('p', { role: 'status' }, '尚未导入'))
      }
      mount(() => React.createElement(Example))
    })
    const entry = page.getByTestId('artifact-open')
    const card = page.getByTestId('turn-artifact-revision-2')
    await expect(card.locator('[data-artifact-receipt]')).toHaveCount(1)
    await expect(entry).toHaveAccessibleName('report.tex')
    await entry.focus()
    await expect(card.getByTestId('artifact-import-resources')).toBeVisible()
    await expect(card).toContainText('研究报告')
    await entry.focus()
    await entry.press('Enter')
    await page.getByTestId('artifact-import-resources').click()
    await page.getByTestId('artifact-more-actions').click()
    await page.getByTestId('artifact-versions').click()
    await page.getByTestId('artifact-version-revision-1').click()
    await page.getByTestId('artifact-open-options').click()
    await page.getByRole('menuitem', { name: /Editor/ }).click()
    await page.getByTestId('artifact-more-actions').click()
    await page.getByTestId('artifact-dropdown-save-as').click()
    await page.getByTestId('turn-artifact-revision-2').click({ button: 'right' })
    await page.getByTestId('artifact-context-copy-path').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.artifactActions), [
      { action: 'preview', value: 'revision-2' }, { action: 'import', value: 'revision-2' }, { action: 'version', value: 'revision-1' },
      { action: 'open-with', value: '/apps/editor' }, { action: 'save-as', value: 'revision-2' }, { action: 'copy-path', value: 'revision-2' },
    ])
    await expect(page.getByRole('status')).toHaveText('尚未导入')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared artifact destination preserves nested selection through a rejected save and supports cancel and retry', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.artifact', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      window.fixture.locations = []
      function Example() {
        const [open, setOpen] = React.useState(false)
        const [location, setLocation] = React.useState({ parent: '', name: 'report' })
        const [error, setError] = React.useState('')
        const [saved, setSaved] = React.useState(false)
        return React.createElement(React.Fragment, null,
          React.createElement(Button, { onClick: () => { setLocation({ parent: '', name: 'report' }); setError(''); setOpen(true) } }, '选择导入位置'),
          React.createElement('p', { role: 'status' }, saved ? '样例导入已完成' : '尚未导入'),
          React.createElement(Conversation.ArtifactDestination, {
            open, onOpenChange: setOpen, title: '导入资料库', description: '样例目标选择，不执行真实导入', projectName: '测试项目',
            tree: [{ name: 'papers', kind: 'dir', children: [{ name: 'review', kind: 'dir' }] }], location, onLocationChange: setLocation,
            fixedSuffix: '.md', rootLabel: '资料根目录', saving: false, error,
            onSubmit: () => { window.fixture.locations.push({ ...location }); if (window.fixture.locations.length === 1) setError('样例校验失败'); else { setSaved(true); setOpen(false) } },
          }))
      }
      mount(() => React.createElement(Example))
    })
    await page.getByRole('button', { name: '选择导入位置', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '导入资料库', exact: true })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.locations), [])
    await page.getByRole('button', { name: '选择导入位置', exact: true }).click()
    await dialog.getByRole('button', { name: '展开 papers', exact: true }).click()
    await dialog.getByRole('button', { name: 'review', exact: true }).click()
    await dialog.getByRole('textbox', { name: '资料名称', exact: true }).fill('comparison')
    await dialog.getByRole('button', { name: '导入', exact: true }).click()
    await expect(page.getByText(/样例校验失败/).first()).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: '资料名称', exact: true })).toHaveValue('comparison')
    await expect(dialog.getByText('保存位置：papers/review', { exact: true })).toBeVisible()
    await page.screenshot({ path: path.join(SNAPSHOTS, 'artifact-destination-component.png') })
    await dialog.getByRole('button', { name: '导入', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: '样例导入已完成' })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.locations), [{ parent: 'papers/review', name: 'comparison' }, { parent: 'papers/review', name: 'comparison' }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('markdown tables copy TSV without inventing missing data and keep first-column context while scrolling', async () => {
  const header = ['方法', '准确率', ...Array.from({ length: 12 }, (_, index) => `说明${index}`)]
  const first = ['[方法 A](https://example.com/paper)', '86.5', ...Array.from({ length: 12 }, () => '完整的长单元格内容')]
  const second = ['方法 B', '—', ...Array.from({ length: 12 }, () => '')]
  const text = [header.join('|'), header.map(() => '---').join('|'), first.join('|'), second.join('|')].join('\n')
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.table', status: 'pending', data: { text } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []; window.fixture.opened = []
      mount(state => React.createElement(Conversation.Markdown, { text: state.data.text, onCopy: async text => { window.fixture.copies.push(text) }, onOpenExternal: url => window.fixture.opened.push(url) }))
    })
    const panel = page.getByTestId('conversation-table')
    const scroll = panel.getByTestId('table-scroll')
    await expect(scroll).toBeVisible()
    assert.ok((await scroll.boundingBox()).y - (await panel.boundingBox()).y < 2, 'captionless copy action must not reserve an empty toolbar row')
    await expect(panel.locator('tbody tr').first().locator('td').nth(1)).toHaveCSS('text-align', 'right')
    await expect(panel.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('—')
    const cell = panel.locator('tbody tr').first().locator('td').first()
    const before = await cell.boundingBox()
    assert.ok(await scroll.evaluate(element => element.scrollWidth > element.clientWidth))
    await scroll.evaluate(element => { element.scrollLeft = 200 })
    const after = await cell.boundingBox()
    assert.ok(Math.abs(after.x - before.x) < 2)
    await panel.getByRole('link', { name: '方法 A', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://example.com/paper'])
    await panel.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies), [[header.join('\t'), ['方法 A', ...first.slice(1)].join('\t'), second.join('\t')].join('\n')])
    await page.screenshot({ path: path.join(SNAPSHOTS, 'table-component.png') })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('table notes preserve literal multiline content, optional visibility and the original copy port', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  const notes = '未报告不代表 0。\n<img src=x onerror="window.tableNoteExecuted=true">'
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement(Conversation.Tabulation, {
        notes: state.data.notes,
        copyText: '指标\t值\nA\t—',
        onCopy: async text => { window.fixture.copies.push(text) },
      }, React.createElement('span', null, 'A: —')))
    })
    const table = page.getByTestId('conversation-table')
    await expect(table.getByRole('note')).toHaveCount(0)
    await page.evaluate(notes => { window.fixture.state.data.notes = notes; window.fixture.publish() }, notes)
    await expect(table.getByRole('note')).toHaveText(notes)
    await expect(table.getByRole('note')).toHaveCSS('white-space', 'pre-wrap')
    await expect(table.getByRole('note').locator('img, script')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.tableNoteExecuted), undefined)
    await table.hover()
    await table.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies), ['指标\t值\nA\t—'])
    await page.evaluate(() => { window.fixture.state.data.notes = ''; window.fixture.publish() })
    await expect(table.getByRole('note')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('malformed table retains its exact source and copy path instead of inventing cells', async () => {
  const source = '| 方法 | 准确率 | 延迟 |\n| --- | --- |\n| A | 86 | 未报告 |'
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.table', status: 'pending', data: { text: source } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement(Conversation.Markdown, { text: state.data.text, onOpenExternal: () => {}, onCopy: async text => { window.fixture.copies.push(text) } }))
    })
    const panel = page.getByTestId('conversation-table')
    await expect(panel.locator('xpath=following-sibling::*[@role="status"][1]')).toContainText('表格格式不完整')
    await expect(panel.locator('pre')).toHaveText(source)
    await expect(panel.locator('td')).toHaveCount(0)
    await panel.hover()
    await expect(panel.getByTestId('table-copy-control')).toHaveCSS('pointer-events', 'auto')
    await panel.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies), [source])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('block formulas share view/source switching, rich copying and parse failure without losing the rest of the answer', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.math', status: 'pending', data: { text: '说明 $x^2$\n\n$$\n\\frac{a}{b}\n$$\n\n后续正文' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement(Conversation.Markdown, {
        text: state.data.text, math: true, onOpenExternal: () => {},
        onCopy: async (text, html) => { window.fixture.copies.push({ text, html }) },
      }))
    })
    const formula = page.getByTestId('conversation-formula')
    await expect(formula.locator('.katex')).toHaveCount(1)
    await expect(page.getByText('后续正文', { exact: true })).toBeVisible()
    await formula.hover()
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    const rich = await page.evaluate(() => window.fixture.copies[0])
    assert.equal(rich.text, '\\[\\frac{a}{b}\\]')
    assert.match(rich.html, /<math[\s\S]*<annotation encoding="application\/x-tex">/)
    assert.doesNotMatch(rich.html, /class="katex-html"/)
    await formula.getByRole('tab', { name: 'LaTeX', exact: true }).click()
    await expect(formula.getByRole('tab', { name: 'LaTeX', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(formula.locator('pre')).toHaveText('\\frac{a}{b}')
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    const sourceCopy = await page.evaluate(() => window.fixture.copies[1])
    assert.equal(sourceCopy.text, '\\frac{a}{b}')
    assert.equal(sourceCopy.html, rich.html)
    await page.evaluate(() => { window.fixture.state.data.text = '$$\n\\unknowncommand{x}\n$$\n\n仍然保留的正文'; window.fixture.publish() })
    await expect(formula.getByRole('status')).toContainText('公式有误，已显示原文')
    await expect(formula.locator('pre')).toHaveText('\\unknowncommand{x}')
    await expect(page.getByText('仍然保留的正文', { exact: true })).toBeVisible()
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(await page.evaluate(() => window.fixture.copies.at(-1).text), '\\unknowncommand{x}')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('mapped answer Markdown keeps Mermaid toolbars and isolates invalid diagrams without losing source annotations', async () => {
  const diagram = 'flowchart LR\n A["输入"] --> B["核对"]\n'
  const invalid = 'flowchart LR\n A -->\n'
  const restored = 'flowchart LR\n X["恢复"] --> Y["成功"]\n'
  const text = `保留正文\n\n\`\`\`mermaid\n${diagram}\`\`\`\n\n\`\`\`mermaid\n${invalid}\`\`\`\n\n\`\`\`mermaid\n${restored}\`\`\`\n\n\`\`\`javascript\nconst original = 0\n\`\`\``
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: { text } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement(Conversation.Markdown, {
        text: state.data.text, math: true, sourceMapped: true,
        answerAnnotations: [
          { id: 'paragraph', start_utf16: 0, end_utf16: 4 },
          { id: 'code', start_utf16: state.data.text.indexOf('输入'), end_utf16: state.data.text.indexOf('输入') + 2 },
        ],
        onCopy: async source => { window.fixture.copies.push(source) },
      }))
    })
    const diagrams = page.getByTestId('conversation-diagram')
    await expect(diagrams).toHaveCount(3)
    await expect(diagrams.nth(0).getByRole('img')).toBeVisible()
    await expect(diagrams.nth(1).getByRole('alert')).toContainText('原始源码已保留')
    await expect(diagrams.nth(1).getByRole('tab', { name: '图形', exact: true })).toBeDisabled()
    await expect(diagrams.nth(1).getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
    await expect(diagrams.nth(1).getByTestId('conversation-code').locator('pre code')).toHaveText(invalid)
    await expect(diagrams.nth(2).getByRole('img')).toBeVisible()
    await diagrams.nth(0).getByTestId('diagram-toolbar').hover()
    await diagrams.nth(0).getByRole('tab', { name: '源码', exact: true }).click()
    await expect(diagrams.nth(0).getByTestId('conversation-code').locator('pre code')).toHaveText(diagram)
    await diagrams.nth(0).getByRole('button', { name: '复制', exact: true }).click()
    assert.equal((await page.evaluate(() => window.fixture.copies))[0], diagram)
    await diagrams.nth(1).getByTestId('diagram-toolbar').hover()
    await diagrams.nth(1).getByRole('button', { name: '复制', exact: true }).click()
    assert.equal((await page.evaluate(() => window.fixture.copies))[1], invalid)
    await expect(page.locator('mark[data-scholarseed-answer-annotation-id="paragraph"]')).toHaveText('保留正文')
    const code = page.getByTestId('conversation-code').last().locator('pre code [data-md-source-start]')
    await expect(code).toHaveText('const original = 0')
    await expect(code).toHaveAttribute('data-md-source-start', String(text.indexOf('const original')))
    await expect(code).toHaveAttribute('data-md-source-end', String(text.indexOf('const original') + 'const original = 0'.length))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('formula optional metadata, mathematical notes and parse failure match the answer contract', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.math', status: 'pending', data: { source: 'E=mc^2' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement(Conversation.Formula, {
        ...state.data,
        onCopy: async (text, html) => window.fixture.copies.push({ text, html }),
      }))
    })
    const formula = page.getByTestId('conversation-formula')
    await expect(formula.getByTestId('formula-caption')).toHaveCount(0)
    await expect(formula.getByTestId('formula-notes')).toHaveCount(0)
    await expect(formula).not.toContainText('渲染成功不代表数学验证通过')
    const headerBounds = await formula.getByTestId('formula-toolbar').boundingBox()
    const contentBounds = await formula.getByTestId('formula-render').boundingBox()
    assert.ok(headerBounds && contentBounds)
    assert.ok(contentBounds.y >= headerBounds.y + headerBounds.height)
    await expect(formula.getByTestId('formula-toolbar')).toHaveCSS('position', 'static')
    await expect(formula.getByTestId('formula-toolbar')).toHaveCSS('display', 'flex')
    for (const notes of ['$\\hat{\\beta}$ 无量纲。', '$$\\frac{19}{24}$$ 非数学核验。', '\\(x^2\\) 的单位。', '\\[x^2\\]']) {
      await page.evaluate(notes => { window.fixture.state.data.notes = notes; window.fixture.publish() }, notes)
      await expect(formula.getByTestId('formula-notes').locator('.katex')).toHaveCount(1)
      await expect(page.getByTestId('conversation-formula')).toHaveCount(1)
    }
    await page.evaluate(() => {
      Object.assign(window.fixture.state.data, { caption: '百分比换算', notes: '$\\unknowncommand{x}$\n\n<script>window.formulaUnsafe=true</script>' })
      window.fixture.publish()
    })
    await expect(formula.getByTestId('formula-caption')).toHaveText('百分比换算')
    await expect(formula.getByTestId('formula-notes')).toContainText('\\unknowncommand{x}')
    assert.equal(await page.evaluate(() => window.formulaUnsafe), undefined)
    await expect(formula.locator('[data-testid="formula-render"] .katex')).toHaveCount(1)
    const invalid = '\\unknowncommand{x}'
    await page.evaluate(source => { window.fixture.state.data.source = source; window.fixture.publish() }, invalid)
    const status = formula.getByRole('status')
    await expect(status).toHaveText('公式有误，已显示原文')
    await expect(status.locator('svg')).toHaveCount(1)
    assert.equal(await status.evaluate(element => Boolean(element.compareDocumentPosition(element.parentElement.querySelector('pre')) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
    const border = await formula.evaluate(element => {
      const style = getComputedStyle(element)
      return { actual: style.borderTopColor, token: style.getPropertyValue('--vds-warning-light-border').trim() }
    })
    assert.ok(border.token)
    assert.match(await formula.getAttribute('class'), /border-\[var\(--vds-warning-light-border\)\]/)
    await expect(formula.getByRole('tab', { name: '公式', exact: true })).toBeDisabled()
    await formula.hover()
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies.at(-1)), { text: invalid, html: undefined })
    await page.evaluate(() => { window.fixture.state.data.caption = ''; window.fixture.publish() })
    await page.setViewportSize({ width: 360, height: 660 })
    await expect(formula.getByTestId('formula-caption')).toHaveCount(0)
    await expect(formula.getByTestId('formula-toolbar')).toHaveCSS('position', 'static')
    const toolbarBounds = await formula.getByTestId('formula-toolbar').boundingBox()
    const statusBounds = await status.boundingBox()
    assert.ok(toolbarBounds.y + toolbarBounds.height <= statusBounds.y, JSON.stringify({ toolbarBounds, statusBounds }))
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { source: 'x^2', caption: '', notes: '' }); window.fixture.publish() })
    await expect(formula.getByRole('status')).toHaveCount(0)
    await expect(formula.getByTestId('formula-caption')).toHaveCount(0)
    await expect(formula.getByTestId('formula-notes')).toHaveCount(0)
    await expect(formula.getByRole('tab', { name: '公式', exact: true })).toBeEnabled()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('named formula retains verification notes, scrolls without clipping its start and refuses trusted HTML commands', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.math', status: 'pending', data: { source: Array.from({ length: 80 }, (_, index) => `x_{${index}}`).join('+') } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Formula, { source: state.data.source, caption: '符号核对', notes: 'x 的单位及适用条件：待核对' }))
    })
    await expect(page.getByText('符号核对', { exact: true })).toBeVisible()
    await expect(page.getByText('x 的单位及适用条件：待核对', { exact: true })).toBeVisible()
    const region = page.getByTestId('formula-render')
    assert.ok(await region.evaluate(element => element.scrollWidth > element.clientWidth))
    const regionBounds = await region.boundingBox()
    const formulaBounds = await region.locator('.katex-display').boundingBox()
    assert.ok(formulaBounds.x >= regionBounds.x)
    await region.focus()
    await page.screenshot({ path: path.join(SNAPSHOTS, 'formula-component.png') })
    await page.evaluate(() => { window.fixture.state.data.source = '\\href{javascript:alert(1)}{unsafe}'; window.fixture.publish() })
    await expect(page.getByTestId('conversation-formula').locator('a')).toHaveCount(0)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['\\[\\href{javascript:alert(1)}{unsafe}\\]'])
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('markdown code keeps complete source, folds long content and returns copy success or failure through its host port', async () => {
  const code = Array.from({ length: 18 }, (_, index) => `line_${index} = "${'wide '.repeat(80)}"`).join('\n') + '\n'
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.code', status: 'pending', data: { text: '```unknown-lang\n' + code + '```' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copied = []
      window.fixture.copyFails = true
      mount(state => React.createElement(Conversation.Markdown, {
        text: state.data.text, onOpenExternal: () => {},
        onCopy: async source => { if (window.fixture.copyFails) throw new Error('denied'); window.fixture.copied.push(source) },
      }))
    })
    await expect(page.getByTestId('conversation-code')).toContainText('unknown-lang')
    const pre = page.getByTestId('conversation-code').locator('pre')
    assert.equal(await pre.locator('code').evaluate(element => getComputedStyle(element).fontSize), await pre.evaluate(element => getComputedStyle(element).fontSize))
    await expect(pre.locator('[data-code-line]')).toHaveCount(12)
    await expect(page.getByRole('button', { name: '展开全部 18 行' })).toHaveAttribute('aria-expanded', 'false')
    assert.ok(await pre.evaluate(element => element.scrollWidth > element.clientWidth))
    await page.getByRole('button', { name: '展开全部 18 行' }).click()
    await expect(page.getByRole('button', { name: '收起代码' })).toHaveAttribute('aria-expanded', 'true')
    assert.equal(await pre.locator('code').textContent(), code.slice(0, -1))
    await page.getByTestId('conversation-code').hover()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '复制失败', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), [])
    await page.evaluate(() => { window.fixture.copyFails = false })
    await page.getByRole('button', { name: '复制失败', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), [code])
    await page.getByRole('button', { name: '收起代码' }).click()
    await page.evaluate(() => { window.fixture.state.language = 'en'; window.fixture.publish() })
    await expect(page.getByRole('button', { name: 'Expand all 18 lines' })).toBeVisible()
    await page.screenshot({ path: path.join(SNAPSHOTS, 'code-component.png') })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('Markdown command and output fences copy literal source without inventing execution', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.command', status: 'pending', data: { mode: 'command', code: 'python analyze.py\n' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Markdown, { text: '```' + (state.data.mode === 'command' ? 'bash' : 'text') + '\n' + state.data.code + '```' }))
    })
    await expect(page.getByTestId('conversation-code')).toContainText('bash')
    await page.getByTestId('conversation-code').hover()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['python analyze.py\n'])
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { mode: 'output', code: 'permission denied\n' }); window.fixture.publish() })
    await expect(page.getByTestId('conversation-code')).toContainText('text')
    await expect(page.locator('pre')).toHaveText('permission denied')
    await page.getByTestId('conversation-code').hover()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['python analyze.py\n', 'permission denied\n'])
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared answer body renders math, tables and code without opening external resources itself', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.answer', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.links = []
      mount(() => React.createElement(Conversation.Markdown, {
        text: '# 计算结果\n\n$x^2$\n\n| 方法 | 得分 |\n| --- | --- |\n| A | 12 |\n\n```python\nprint(12)\n```\n\n[原文](https://example.com/paper)\n\n[报告](report.md)',
        math: true,
        onOpenExternal: url => window.fixture.links.push({ external: url }),
        onOpenSessionFile: path => window.fixture.links.push({ file: path }),
      }))
    })
    await expect(page.getByRole('heading', { name: '计算结果' })).toBeVisible()
    await expect(page.locator('.katex')).toBeVisible()
    await expect(page.getByRole('table')).toContainText('得分')
    await expect(page.locator('pre')).toContainText('print(12)')
    await page.getByRole('link', { name: '原文', exact: true }).click()
    await page.getByTestId('session-file-link').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.links), [{ external: 'https://example.com/paper' }, { file: 'report.md' }])
    assert.equal(page.url(), 'https://resource.test/')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('compact answer links use the SDK bridge and preserve explicit copy port failures', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copied = []
      window.fixture.bridgeCopies = []
      window.plugin.copyText = async text => { window.fixture.bridgeCopies.push(text); return { copied: true } }
      window.fixture.copyFails = true
      window.fixture.linkCopy = false
      window.fixture.render = () => mount(() => React.createElement(Conversation.Markdown, {
        text: 'https://example.com/paper',
        onOpenExternal() {},
        ...(window.fixture.linkCopy ? { onCopy: async source => {
          if (window.fixture.copyFails) throw new Error('copy denied')
          window.fixture.copied.push(source)
        } } : {}),
      }))
      window.fixture.render()
    })
    await expect(page.getByTestId('answer-link').getByRole('link')).toBeVisible()
    await page.getByTestId('answer-link').hover()
    const copy = page.getByTestId('answer-link').getByRole('button')
    await copy.click()
    assert.deepEqual(await page.evaluate(() => window.fixture.bridgeCopies), ['https://example.com/paper'])
    await expect(copy).toHaveAttribute('aria-label', '复制')
    await page.evaluate(() => { window.fixture.linkCopy = true; window.fixture.render() })
    await page.getByTestId('answer-link').getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('button', { name: '复制失败', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), [])
    await page.evaluate(() => { window.fixture.copyFails = false })
    await page.getByRole('button', { name: '复制失败', exact: true }).click()
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), ['https://example.com/paper'])
    assert.deepEqual(await page.evaluate(() => window.fixture.bridgeCopies), ['https://example.com/paper'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('answer Markdown keeps raw HTML inert without native empty-answer controls', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(React.Fragment, null,
        React.createElement(Conversation.Markdown, { text: '<script>window.answerExecuted=true</script>\n\n<img src=x onerror="window.answerExecuted=true">', onOpenExternal() {} }),
      ))
    })
    await expect(page.getByText('<script>window.answerExecuted=true</script>', { exact: false })).toBeVisible()
    await expect(page.locator('#root script, #root img')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.answerExecuted), undefined)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('Canvas sandbox rolls back locally, preserves draft on failure and submits current values', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.failSubmit = true
      mount(() => React.createElement(Conversation.Canvas, {
        title: '任务画布', status: 'pending', document: { format: 'html', version: 1,
          source: '<input aria-label="备注" id="note"><script>const input=document.getElementById("note");input.oninput=()=>canvas.save({note:input.value});canvas.register({onRestore(s){input.value=s.note??""},onRollback(){input.value="";return {note:""}},onCancel(){},onSubmit(){return {note:input.value}}});</script>',
          interaction: { actions: ['rollback', 'cancel', 'submit'] } },
        onDraft: async values => { window.fixture.drafts.push(values) },
        onAction: async (action, values) => { if(window.fixture.failSubmit) throw new Error('not acknowledged'); window.fixture.actions.push({action,values}) },
      }))
    })
    const input = page.frameLocator('iframe').getByRole('textbox', {name:'备注'})
    await input.fill('先撤销')
    await page.getByRole('button', {name:'撤销',exact:true}).click()
    await expect(input).toHaveValue('')
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    await input.fill('最终值')
    await page.getByRole('button', {name:'提交',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('not acknowledged')
    await expect(input).toHaveValue('最终值')
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    await page.evaluate(() => { window.fixture.failSubmit = false })
    await page.getByRole('button', {name:'提交',exact:true}).click()
    await expect.poll(() => page.evaluate(() => window.fixture.actions)).toEqual([{action:'submit',values:{note:'最终值'}}])
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.drafts.at(-1)), {canvas_state:{note:'最终值'}})
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('Canvas can cancel an invalid OpenUI page without submitting its state', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(Conversation.Canvas, {
        document: { format:'openui-lang', version:1, source:'root = Stack([Input("note",', initial_state:{note:'not submitted'}, interaction:{actions:['rollback','cancel','submit']} },
        status:'pending', onAction:async (action,values) => {window.fixture.actions.push({action,values})},
      }))
    })
    await expect(page.getByRole('alert')).toContainText('openui_incomplete')
    await expect(page.getByRole('button',{name:'提交',exact:true})).toBeDisabled()
    await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled()
    await page.getByRole('button',{name:'取消',exact:true}).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [{action:'cancel',values:{}}])
    await expect(page.getByRole('button',{name:'取消',exact:true})).toBeDisabled()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const bound of [false, true]) test(`Canvas uses official OpenUI ${bound ? 'bound' : 'unbound'} fields and restores local rollback`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(bound => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(Conversation.Canvas, {
        document: { format:'openui-lang', version:1, source:bound ? 'root = Stack([TextArea("note", "备注", 4, null, $note)])\n$note = ""' : 'root = Stack([Input("note", "备注")])', interaction:{actions:['rollback','submit']} },
        status:'pending', onDraft:async values => {window.fixture.drafts.push(values)}, onAction:async (action,values) => {window.fixture.actions.push({action,values})},
      }))
    }, bound)
    const input = page.getByRole('textbox')
    await input.fill('草稿')
    await expect.poll(() => page.evaluate(bound => bound ? window.fixture.drafts.at(-1)?.canvas_state?.$note : window.fixture.drafts.at(-1)?.canvas_state?.note?.value, bound)).toBe('草稿')
    await page.getByRole('button',{name:'撤销',exact:true}).click()
    await expect(input).toHaveValue('')
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    await input.fill('最后编辑')
    await page.getByRole('button',{name:'提交',exact:true}).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [{action:'submit',values:{note:'最后编辑'}}])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('Mermaid shares real rendering, source copy, zoom and local failure recovery', async (context) => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: { source: 'flowchart LR\n A[研究问题] --> B[证据核对]' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []
      mount(state => React.createElement('div', { style: { width: 320, overflow: 'hidden', transform: 'translateZ(0)' } },
        React.createElement(Conversation.Markdown, { text: '```mermaid\n' + state.data.source + '\n```', onCopy: async source => { window.fixture.copies.push(source) } })))
    })
    await expect(page.getByRole('img', { name: '流程图', exact: true })).toBeVisible()
    await page.getByTestId('conversation-diagram').hover()
    await page.getByRole('tab', { name: '源码', exact: true }).click()
    await expect(page.getByRole('tab', { name: '源码', exact: true })).toHaveAttribute('aria-selected', 'true')
    const source = page.getByTestId('conversation-diagram').getByTestId('conversation-code').locator('code')
    await expect(source).toHaveText('flowchart LR\n A[研究问题] --> B[证据核对]')
    await page.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal((await page.evaluate(() => window.fixture.copies))[0], 'flowchart LR\n A[研究问题] --> B[证据核对]\n')
    await page.getByRole('tab', { name: '图形', exact: true }).click()
    await expect(page.getByRole('tab', { name: '图形', exact: true })).toHaveAttribute('aria-selected', 'true')
    const expand = page.getByRole('button', { name: '放大', exact: true })
    const image = expand.getByRole('img', { name: '流程图', exact: true })
    await expect(image).toBeVisible()
    const bounds = await image.boundingBox()
    const natural = await image.evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight }))
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0)
    assert.ok(natural.width > 0 && natural.height > 0)
    context.diagnostic(JSON.stringify({ image: bounds, natural, button: await expand.boundingBox() }))
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.fixture.state.data.source = 'not a diagram <script>window.executed=true</script>'; window.fixture.publish() })
    await expect(page.getByRole('alert')).toContainText('原始源码已保留')
    await expect(source).toHaveText('not a diagram <script>window.executed=true</script>')
    await expect(page.getByRole('tab', { name: '图形', exact: true })).toBeDisabled()
    await expect(expand).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.executed), undefined)
    await page.evaluate(() => { window.fixture.state.data.source = 'flowchart LR\n C --> D'; window.fixture.publish() })
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('tab', { name: '图形', exact: true }).click()
    await expect(page.getByRole('img', { name: '流程图', exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.fixture.state.data.source = '%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\n A["<b>literal</b>"] --> B[Safe]\n click A "javascript:window.diagramExecuted=true"'
      window.fixture.publish()
    })
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeEnabled()
    const svg = await page.getByRole('img', { name: '流程图', exact: true }).evaluate(async element => await (await fetch(element.src)).text())
    assert.doesNotMatch(svg, /<foreignObject|<script|(?:xlink:)?href=["']javascript:/i)
    assert.equal(await page.evaluate(() => window.diagramExecuted), undefined)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('formula delimiters and Mermaid images work under the plugin image policy', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: {} })
  try {
    await page.evaluate(() => {
      const policy = document.createElement('meta')
      policy.httpEquiv = 'Content-Security-Policy'
      policy.content = "img-src https://resource.test data:; connect-src 'none'"
      document.head.append(policy)
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(React.Fragment, null,
        React.createElement(Conversation.Formula, { source: '$$\\frac{80}{100}\\times100\\%$$' }),
        React.createElement(Conversation.Markdown, { text: '```mermaid\nflowchart LR\n A["用户材料<br/>缺失保留"] --> B[核对]\n```' })))
    })
    await expect(page.getByTestId('conversation-formula').locator('.katex')).toHaveCount(1)
    const diagram = page.getByRole('img', { name: '流程图', exact: true })
    await expect.poll(() => diagram.evaluate(element => element.naturalWidth)).toBeGreaterThan(0)
    await expect(diagram).toHaveAttribute('src', /^data:image\/svg\+xml/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('code highlighting preserves full literal source and unknown languages stay plain', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'resolved', data: { language: 'javascript' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Markdown, { text: '```' + state.data.language + '\nconst source = "<script>not executed</script>";\n// 原文\n```' }))
    })
    const keyword = page.locator('pre code').getByText('const', { exact: true })
    await expect(keyword).toBeVisible()
    const colors = await keyword.evaluate(element => ({ keyword: getComputedStyle(element).color, plain: getComputedStyle(element.closest('code')).color }))
    assert.notEqual(colors.keyword, colors.plain)
    assert.equal(await page.locator('pre code').innerText(), 'const source = "<script>not executed</script>";\n// 原文')
    await page.evaluate(() => { window.fixture.state.data.language = 'not-a-language'; window.fixture.publish() })
    await expect(keyword).toHaveCount(0)
    assert.equal(await page.locator('pre code').innerText(), 'const source = "<script>not executed</script>";\n// 原文')
    await expect(page.getByTestId('conversation-code').locator('script')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('custom card uses official base controls, saves draft, restores state and submits the selected values', async () => {
  const { page, errors } = await openComponent('custom.js', {
    language: 'zh', slot: 'methods.comparison', status: 'pending', draft: { selected: ['evidence'] },
    data: { choices: [{ id: 'evidence', label: '证据' }, { id: 'limits', label: '局限' }] },
  })
  try {
    await expect(page.getByRole('checkbox', { name: '证据', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('checkbox', { name: '局限', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '局限', exact: true })).toHaveAttribute('aria-checked', 'true')
    assert.deepEqual(await page.evaluate('window.fixture.drafts'), [{ selected: ['evidence', 'limits'] }])
    await page.getByRole('button', { name: '确认对比维度', exact: true }).click()
    await expect(page.getByRole('button', { name: '已确认对比维度', exact: true })).toBeDisabled()
    assert.deepEqual(await page.evaluate('window.fixture.actions'), [{ action: 'confirm', values: { selected: ['evidence', 'limits'] } }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('official content exposes code, formula and diagram copy through the explicit host bridge', async () => {
  const blocks = [
    { id: 'code', kind: 'markdown', source: '```python\nprint("source")\n```' },
    { id: 'formula', kind: 'formula', source: 'E=mc^2' },
    { id: 'diagram', kind: 'markdown', source: '```mermaid\ngraph TD; A-->B;\n```' },
  ]
  const { page, errors } = await openComponent(null, {
    language: 'zh',
    status: 'resolved',
    data: { blocks },
    draft: {},
    revision: 0,
  })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(React.Fragment, null, ...state.data.blocks.map(block =>
        block.kind === 'formula' ? React.createElement(Conversation.Formula, {key:block.id,source:block.source})
          : React.createElement(Conversation.Markdown, {key:block.id,text:block.source}))))
    })
    await expect.poll(() => page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text)).toContain('print("source")')
    await expect.poll(() => page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text)).toContain('E=mc^2')
    const registered = await page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text)
    for (const kind of ['code', 'formula', 'diagram']) {
      const card = page.getByTestId(`conversation-${kind}`)
      await card.hover()
      await card.getByRole('button', { name: '复制', exact: true }).click()
      await expect(card.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    }
    assert.deepEqual(
      await page.evaluate(() => window.fixture.copied),
      ['print("source")\n', '\\[E=mc^2\\]', 'graph TD; A-->B;\n']
    )
    assert.equal(await page.evaluate(() => window.fixture.copySnapshots.at(-1)?.text), registered)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('official copy respects a supplied callback and reports a missing old host bridge as failure', async () => {
  for (const custom of [true, false]) {
    const { page } = await openComponent(null, {
      language: 'zh',
      status: 'resolved',
      data: {},
      draft: {},
    })
    try {
      await page.evaluate((custom) => {
        const ui = window.scholarseedUI
        if (!custom) delete window.plugin.copyText
        window.fixture.custom = []
        ui.mount(() =>
          ui.React.createElement(ui.Conversation.Markdown, {
            text: '```js\nlet value = 1\n```',
            ...(custom
              ? {
                  onCopy: async (text) => {
                    window.fixture.custom.push(text)
                  },
                }
              : {}),
          })
        )
      }, custom)
      const card = page.getByTestId('conversation-code')
      await card.hover()
      await card.getByRole('button', { name: '复制', exact: true }).click()
      await expect(
        card.getByRole('button', {
          name: custom ? '已复制' : '复制失败',
          exact: true,
        })
      ).toBeVisible()
      assert.deepEqual(
        await page.evaluate(() => window.fixture.custom),
        custom ? ['let value = 1\n'] : []
      )
      assert.deepEqual(await page.evaluate(() => window.fixture.copied), [])
    } finally {
      await page.close()
    }
  }
})
