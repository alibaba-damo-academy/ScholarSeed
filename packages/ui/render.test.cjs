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

let temporary
let browser
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-render-'))
  await buildOfficialUI(path.join(temporary, 'official'))
  await buildExample(path.join(temporary, 'example'))
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  if (temporary) await fs.rm(temporary, { recursive: true, force: true })
})

async function openComponent(entry, state) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://resource.test/**', async route => {
    const resource = new URL(route.request().url()).pathname.slice(1)
    if (!resource) return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    const directory = resource.startsWith('__ui__/') ? 'official' : 'example'
    const name = resource.replace(/^__ui__\//, '')
    await route.fulfill({ body: await fs.readFile(path.join(temporary, directory, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2' })
  })
  await page.goto('http://resource.test/')
  await page.evaluate(initial => {
    let listener
    const state = structuredClone(initial)
    const actions = []
    const drafts = []
    Object.assign(window, {
      fixture: { state, actions, drafts, copySnapshots: [], publish: () => listener(state) },
      plugin: {
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
  await page.addScriptTag({ url: 'http://resource.test/__ui__/ui.js' })
  if (entry) await page.addScriptTag({ url: `http://resource.test/${entry}` })
  return { page, errors }
}

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
        mount(() => React.createElement(Conversation.Message, { text: '完整卡片内容' }))
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

test('official text, code, formula, table, message and artifact cards contribute complete ordered copy text', async () => {
  const {page,errors}=await openComponent(null,{language:'zh',revision:0,status:'pending',data:{}})
  try {
    await page.evaluate(()=>{
      const {React,Conversation,mount}=window.scholarseedUI
      const primary={artifact_id:'plan',title:'验证计划',name:'plan.md',path:'outputs/plan.md',status:'available'}
      const code=Array.from({length:16},(_,index)=>`source line ${index+1}`).join('\n')+'\n'
      mount(()=>React.createElement(React.Fragment,null,
        React.createElement(Conversation.Message,{text:'用户原文 <literal>'}),
        React.createElement(Conversation.Markdown,{text:'正文内容\n<!-- scholarseed-ref private -->\n[来源](https://example.org/evidence)',onOpenExternal:()=>{}}),
        React.createElement(Conversation.Code,{code,language:'text'}),
        React.createElement(Conversation.Formula,{source:'E=mc^2',caption:'能量关系',notes:'质量单位 kg'}),
        React.createElement(Conversation.Tabulation,{copyText:'方法\t结果\nA\t1',caption:'方法对比',notes:'原始读数'}),
        React.createElement(Conversation.Artifact,{primary,versions:[primary],primaryMeta:'Markdown',canImport:false,preview:()=>{},previewVersion:()=>{},openImport:()=>{},menuProps:{apps:null,appsLoading:false,canSaveAs:false,canUsePath:false,downloading:false,loadApps:()=>{},onCopyPath:()=>{},onOpenWith:()=>{},onReveal:()=>{},onSaveAs:()=>{},revealLabel:'显示文件'}}),
      ))
    })
    await expect.poll(()=>page.evaluate(()=>window.fixture.copySnapshots.at(-1)?.text??'')).toContain('outputs/plan.md')
    const copied=await page.evaluate(()=>window.fixture.copySnapshots.at(-1).text)
    const expected=['用户原文 <literal>','正文内容','https://example.org/evidence','source line 16','E=mc^2','能量关系','质量单位 kg','方法\t结果\nA\t1','原始读数','验证计划','outputs/plan.md']
    for(const value of expected) assert.ok(copied.includes(value),value)
    assert.ok(copied.indexOf('用户原文') < copied.indexOf('正文内容'))
    assert.ok(copied.indexOf('source line 16') < copied.indexOf('E=mc^2'))
    assert.ok(copied.indexOf('原始读数') < copied.indexOf('验证计划'))
    assert.doesNotMatch(copied,/scholarseed-ref|private|打开正文|复制路径/)
    assert.deepEqual(errors,[])
  } finally {await page.close()}
})

test('process outcomes lock running content, preserve child state and reveal focused evidence', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ExecutionProcess), 'function')
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      window.fixture.calls = []
      function ProcessFixture() {
        const [outcome, setOutcome] = React.useState('running')
        const [reveal, setReveal] = React.useState(false)
        window.fixture.outcome = setOutcome
        window.fixture.reveal = setReveal
        return React.createElement(Conversation.ExecutionProcess, { outcome, reveal, turnId: 'turn-source' },
          React.createElement(Conversation.ToolExecution, { data: { name: 'read', label: '读取来源', status: 'done', statusLabel: '已处理', output: '完整来源' }, actions: React.createElement(Button, { onClick: () => window.fixture.calls.push('open') }, '查看来源') }))
      }
      mount(() => React.createElement(ProcessFixture))
    })
    await expect(page.getByRole('button', { name: '进行中', exact: true })).toBeDisabled()
    const step = page.getByTestId('tool-run-step').locator(':scope > button')
    await step.click()
    await page.evaluate(() => window.fixture.outcome('completed'))
    const completed = page.getByRole('button', { name: '已完成', exact: true })
    await expect(completed).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toHaveCount(0)
    await completed.click()
    await expect(step).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '查看来源', exact: true }).click()
    await completed.click()
    await page.evaluate(() => window.fixture.reveal(true))
    await expect(completed).toHaveAttribute('aria-expanded', 'true')
    await page.evaluate(() => window.fixture.reveal(false))
    await expect(completed).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('完整来源', { exact: true })).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/process-component.png') })
    for (const [outcome, label] of [['unknown', '结果待确认'], ['failed', '未完成'], ['interrupted', '已中断']]) {
      await page.evaluate(value => window.fixture.outcome(value), outcome)
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-expanded', 'true')
    }
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['open'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('execution process, batch and step disclosures retain independent state and original actions', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ExecutionBatch), 'function')
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      window.fixture.calls = []
      function Batches() {
        const [process, setProcess] = React.useState(true)
        const [batch, setBatch] = React.useState(true)
        return React.createElement(Conversation.ExecutionBatch, { label: '处理过程', expanded: process, onExpandedChange: setProcess },
          React.createElement(Conversation.ExecutionBatch, { label: '执行工具 2 次', state: '用时 3s', expanded: batch, onExpandedChange: setBatch },
            React.createElement(Conversation.ToolExecution, { groupOpen: process && batch, data: { name: 'read', label: '读取资料', status: 'done', statusLabel: '已完成', input: 'source.md', output: '完整结果' }, actions: React.createElement(Button, { onClick: () => window.fixture.calls.push('open-source') }, '打开来源') }),
          ),
        )
      }
      mount(() => React.createElement(Batches))
    })
    const process = page.getByRole('button', { name: '处理过程', exact: true })
    const batch = page.getByRole('button', { name: '执行工具 2 次', exact: true })
    await page.getByTestId('tool-run-step').locator(':scope > button').click()
    await page.getByRole('button', { name: '打开来源', exact: true }).click()
    await batch.click()
    await expect(batch).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: '打开来源', exact: true })).toHaveCount(0)
    await process.click()
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.click()
    await expect(batch).toHaveAttribute('aria-expanded', 'false')
    await batch.click()
    await expect(page.getByTestId('tool-run-step').locator(':scope > button')).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '打开来源', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['open-source', 'open-source'])
    await expect(page.getByRole('button', { name: '打开来源', exact: true })).toBeInViewport({ ratio: 1 })
    await fs.writeFile(path.resolve(__dirname, '../../work/ui-sdk/batch-layout.json'), JSON.stringify(await page.getByTestId('tool-run-step').evaluate(element => {
      const ancestors = []
      for (let current = element; current; current = current.parentElement) {
        const bounds = current.getBoundingClientRect()
        ancestors.push({ name: current.tagName, classes: current.className, scrollTop: current.scrollTop, height: bounds.height, scrollHeight: current.scrollHeight, clientHeight: current.clientHeight, overflow: getComputedStyle(current).overflowY, animations: current.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime })) })
      }
      return ancestors
    }), null, 2))
    await expect(page.getByTestId('tool-run-step').locator(':scope > button')).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '打开来源', exact: true })).toBeInViewport({ ratio: 1 })
    await fs.writeFile(path.resolve(__dirname, '../../work/ui-sdk/batch-layout-expanded.json'), JSON.stringify(await page.getByTestId('tool-run-step').evaluate(element => {
      const ancestors = []
      for (let current = element; current; current = current.parentElement) {
        ancestors.push({ scrollTop: current.scrollTop, scrollHeight: current.scrollHeight, clientHeight: current.clientHeight, overflow: getComputedStyle(current).overflowY })
      }
      return ancestors
    }), null, 2))
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/batch-component.png') })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('tool execution preserves failure, full technical evidence, nested disclosure and host actions', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ToolExecution), 'function')
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      window.fixture.actions = []
      function ToolFixture() {
        const [data, setData] = React.useState({ name: 'read-source', label: '读取资料', status: 'error', statusLabel: '失败', duration: '3s', input: '原始输入\n<script>literal</script>', output: '证据第一行\n证据最后一行', exitCode: 13, failure: { summary: '访问被拒绝', help: '请检查资料授权' } })
        window.fixture.update = setData
        return React.createElement(Conversation.ToolExecution, { data, actions: React.createElement(Button, { onClick: () => window.fixture.actions.push(data.name) }, '打开技能文件') })
      }
      mount(() => React.createElement(ToolFixture))
    })
    const root = page.getByTestId('tool-run-step')
    const header = root.locator(':scope > button')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await header.click()
    await expect(page.getByText('请检查资料授权', { exact: true })).toBeVisible()
    await expect(root.locator('pre')).toHaveCount(0)
    const technical = root.getByRole('button', { name: /技术详情/ })
    await technical.click()
    await expect(root.locator('pre').first()).toHaveText('原始输入\n<script>literal</script>')
    await expect(root.locator('pre').last()).toHaveText('证据第一行\n证据最后一行')
    await expect(root.locator('script')).toHaveCount(0)
    await expect(root.getByRole('button', { name: '打开技能文件', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/execution-component.png') })
    await root.getByRole('button', { name: '打开技能文件', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), ['read-source'])
    await header.click()
    await expect(root.getByRole('button', { name: '打开技能文件', exact: true })).toHaveCount(0)
    await header.click()
    await expect(technical).toHaveAttribute('aria-expanded', 'true')
    await page.evaluate(() => window.fixture.update(previous => ({ ...previous, status: 'done', statusLabel: '已完成', failure: undefined, duration: '5s', preview: '读取成功' })))
    await expect(root.getByText('请检查资料授权', { exact: true })).toHaveCount(0)
    await expect(root.getByTestId('tool-run-step-duration')).toHaveText('5s')
    await expect(root.getByText('读取成功', { exact: false })).toBeVisible()
    await expect(root.locator('pre').last()).toHaveText('证据第一行\n证据最后一行')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('web tool record keeps queries, complete results and failed open retry in the same disclosure', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.WebSearchRecord), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []
      let failed = false
      mount(() => React.createElement(Conversation.WebSearchRecord, {
        title: '核实科研结论', queries: ['first exact query', '第二条查询'], status: '6 条结果',
        results: Array.from({ length: 6 }, (_, index) => ({ id: `result-${index}`, title: `原始网页 ${index}`, url: `https://source.test/${index}`, site: 'source.test' })),
        onOpenResult: async result => { window.fixture.opened.push(result.url); if (!failed) { failed = true; throw new Error('fixture rejected') } },
      }))
    })
    await expect(page.getByTestId('web-search-results')).toBeHidden()
    await expect(page.getByRole('button', { name: /核实科研结论/ })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /核实科研结论/ }).click()
    await expect(page.getByRole('button', { name: /核实科研结论/ })).toHaveCSS('border-top-width', '0px')
    await expect(page.getByTestId('web-search-step').locator('.vds-collapsible__content')).toHaveCSS('border-top-width', '0px')
    await expect(page.getByText('first exact query', { exact: true })).toBeVisible()
    await expect(page.getByText('第二条查询', { exact: true })).toBeVisible()
    await expect(page.getByTestId('web-search-results').getByRole('button')).toHaveCount(3)
    await page.getByRole('button', { name: '+其他 3 个', exact: true }).click()
    await expect(page.getByTestId('web-search-results').getByRole('button')).toHaveCount(6)
    await page.getByRole('button', { name: '原始网页 5', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('打开网页失败')
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/web-record-component.png') })
    await page.getByRole('button', { name: '原始网页 5', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://source.test/5', 'https://source.test/5'])
    await page.getByRole('button', { name: '收起结果', exact: true }).click()
    await expect(page.getByTestId('web-search-results').getByRole('button')).toHaveCount(3)
    await page.getByRole('button', { name: /核实科研结论/ }).click()
    await expect(page.getByTestId('web-search-results')).toBeHidden()
    await expect(page.getByRole('button', { name: /核实科研结论/ })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /核实科研结论/ }).click()
    await expect(page.getByTestId('web-search-results').getByRole('button')).toHaveCount(3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('tool evidence stays complete for neutral search outcomes and cancelled steps', async () => {
  const { page, errors } = await openComponent(null, { language: 'en', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(React.Fragment, null,
        React.createElement(Conversation.ToolExecution, { data: { name: 'grep', label: 'Search sources', status: 'done', statusLabel: 'No matches', input: 'rg evidence source.md', output: '', exitCode: 1, failure: { help: 'No matching lines, not a processing failure' } } }),
        React.createElement(Conversation.ToolExecution, { groupOpen: false, data: { name: 'read', label: 'Cancelled read', status: 'cancelled', statusLabel: 'Cancelled', input: 'source.md', output: 'Partial evidence retained' } }),
      ))
    })
    const steps = page.getByTestId('tool-run-step')
    await steps.first().locator(':scope > button').click()
    await expect(steps.first().getByText('No matching lines, not a processing failure', { exact: true })).toBeVisible()
    await expect(steps.first().locator('pre')).toHaveCount(0)
    await steps.first().getByRole('button', { name: /technical details/i }).click()
    await expect(steps.first().locator('pre')).toHaveCount(2)
    await expect(steps.first().locator('pre').last()).toHaveText('')
    await expect(steps.last().locator(':scope > button')).toHaveAttribute('tabindex', '-1')
    await steps.last().locator(':scope > button').click()
    assert.equal(await steps.last().locator('[aria-hidden="false"]').evaluate(element => element.inert), true)
    await expect(steps.last().locator('pre').last()).toHaveText('Partial evidence retained')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('conversation reference retains snapshot messages during pagination failure and closes accessibly', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ConversationReference), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.calls = []
      function ReferenceFixture() {
        const [view, setView] = React.useState({ loaded: false, loading: false, messages: [], error: null })
        window.fixture.respond = setView
        return React.createElement(Conversation.ConversationReference, {
          ...view, id: 'snapshot-reference', label: '原会话标题', title: '快照标题', canPreview: true,
          onOpen: () => { if (!view.loaded) { window.fixture.calls.push('open'); setView({ ...view, loading: true }) } },
          onMore: view.loaded ? () => { window.fixture.calls.push('more'); setView({ ...view, loading: true, error: null }) } : undefined,
        })
      }
      mount(() => React.createElement(ReferenceFixture))
    })
    await expect(page.getByTestId('sent-session-reference-snapshot-reference')).toBeVisible()
    assert.deepEqual(errors, [])
    await page.getByRole('button', { name: '原会话标题', exact: true }).click()
    const preview = page.getByTestId('session-reference-preview')
    await expect(preview).toHaveCSS('width', '420px')
    await expect(preview.getByRole('button')).toHaveCount(0)
    await page.evaluate(() => window.fixture.respond({ loaded: true, loading: false, changed: true, messages: [{ message_id: 'm1', role: 'user', text: '<b>原始问题</b>\n完整换行' }], error: null }))
    await expect(preview.getByText('<b>原始问题</b>\n完整换行', { exact: true })).toBeVisible()
    await expect(preview.locator('b')).toHaveCount(0)
    await preview.getByRole('button').click()
    await expect(preview.getByRole('button')).toBeDisabled()
    await page.evaluate(() => window.fixture.respond(previous => ({ ...previous, loading: false, error: '样例分页失败' })))
    await expect(preview.getByText('样例分页失败')).toBeVisible()
    await expect(preview.getByText(/原始问题/)).toBeVisible()
    await preview.getByRole('button').click()
    await page.evaluate(() => window.fixture.respond(previous => ({ ...previous, loading: false, error: null, messages: [...previous.messages, { message_id: 'm2', role: 'assistant', text: '后续回答' }] })))
    await expect(preview.getByText('后续回答', { exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['open', 'more', 'more'])
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(page.getByRole('button', { name: '原会话标题', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '原会话标题', exact: true }).click()
    await expect(preview.getByText('后续回答', { exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['open', 'more', 'more'])
    await page.setViewportSize({ width: 360, height: 600 })
    await expect(preview).toHaveCSS('width', '328px')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('web record keeps configurable result limits, original page parameters and missing capabilities explicit', async () => {
  const { page, errors } = await openComponent(null, { language: 'en', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(() => React.createElement(Conversation.WebSearchRecord, {
        title: 'Find in page', queries: [], page: 'https://paper.test/exact', pattern: '<script>literal pattern</script>',
        defaultExpanded: true, initialVisibleResults: 2, groupOpen: false,
        results: [{ id: 'first', title: 'Unavailable source' }, { id: 'second', title: '', url: 'https://source.test/exact' }, { id: 'third', title: 'Last result', url: 'https://source.test/last' }],
      }))
    })
    const results = page.getByTestId('web-search-results')
    await expect(results.getByRole('button')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Unavailable source', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'https://source.test/exact', exact: true })).toBeDisabled()
    await expect(page.getByText('https://paper.test/exact', { exact: true })).toBeVisible()
    await expect(page.getByText('<script>literal pattern</script>', { exact: true })).toBeVisible()
    await expect(page.locator('[data-testid="web-search-step"] script')).toHaveCount(0)
    const more = page.getByRole('button', { name: '+1 other result', exact: true })
    await expect(more).toHaveAttribute('tabindex', '-1')
    await more.click()
    await expect(results.getByRole('button')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Last result', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Collapse results', exact: true }).click()
    await expect(results.getByRole('button')).toHaveCount(2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('context references keep unavailable sources disabled and removal separate from opening', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.calls = []
      mount(() => React.createElement(React.Fragment, null,
        React.createElement(Conversation.ConversationReference, { id: 'unavailable', label: '不可访问', title: '不可访问', loaded: false, loading: false, messages: [], canPreview: false, onOpen: () => window.fixture.calls.push('unauthorized') }),
        React.createElement(Conversation.ConversationReference, { id: 'empty', label: '空会话', title: '空会话', loaded: true, loading: false, messages: [], canPreview: true, onOpen: () => window.fixture.calls.push('empty') }),
        React.createElement(Conversation.ComposerRefChip, { label: '资料甲', suffix: 'PDF', closeLabel: '移除资料甲', onClick: () => window.fixture.calls.push('open'), onClose: () => window.fixture.calls.push('remove') }),
      ))
    })
    await expect(page.getByRole('button', { name: '不可访问', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '移除资料甲', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['remove'])
    await page.getByRole('button', { name: '空会话', exact: true }).click()
    const preview = page.getByTestId('session-reference-preview')
    await expect(preview.getByRole('button')).toHaveCount(0)
    await expect(preview).toContainText('原任务暂无可显示内容')
    await page.keyboard.press('Escape')
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['remove', 'empty'])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const imageCount of [3, 10, 20]) test(`image group retains order and identity through viewer navigation and close: ${imageCount}`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.Images), 'function')
    await page.evaluate(count => {
      const { React, Conversation, mount } = window.scholarseedUI
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>')
      const items = Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, title: `figure-${index}.svg`, url }))
      window.fixture.opened = []
      mount(() => React.createElement(Conversation.Images, { items, renderActions: item => React.createElement(window.scholarseedUI.Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
    }, imageCount)
    await page.getByRole('button', { name: 'figure-0.svg', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText('figure-0.svg')
    await expect(dialog.getByTestId('image-dimensions')).toHaveText('800 × 400')
    await dialog.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText('figure-1.svg')
    await expect(dialog.getByText(`2 / ${imageCount}`, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['asset-1'])
    for (let index = 2; index < imageCount; index++) await dialog.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText(`figure-${imageCount - 1}.svg`)
    await expect(dialog.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'figure-0.svg', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('figure-0.svg')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('controlled image viewer opens from a separate card and returns the selected source', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')
      const items = [{ id: 'revision-a', title: 'A.svg', url }, { id: 'revision-b', title: 'B.svg', url }]
      window.fixture.opened = []
      function Example() {
        const [id, onChange] = React.useState(null)
        return React.createElement(React.Fragment, null, React.createElement(Button, { onClick: () => onChange('revision-a') }, '打开卡片 A'), React.createElement(Conversation.Images, { items, thumbnails: false, selection: { id, onChange }, renderActions: item => React.createElement(Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
      }
      mount(() => React.createElement(Example))
    })
    await expect(page.getByRole('button', { name: 'A.svg', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '打开卡片 A', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText('A.svg')
    await dialog.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText('B.svg')
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['revision-b'])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '打开卡片 A', exact: true })).toBeFocused()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('single failed image keeps its original action and empty groups render nothing', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: { items: [{ id: 'failed-original', title: 'missing.png', failed: true }] } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.scholarseedUI
      window.fixture.opened = []
      mount(state => React.createElement(Conversation.Images, { items: state.data.items, renderActions: item => React.createElement(Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
    })
    await page.getByRole('button', { name: 'missing.png', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('alert')).toContainText('无法显示此图片')
    await expect(dialog.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['failed-original'])
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.fixture.state.data.items = []; window.fixture.publish() })
    await expect(page.getByRole('button')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared image view preserves zoom and pan, reports invalid content and recovers on a new resource', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: { url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>') } })
  try {
    await page.evaluate(async () => {
      const cached = new Image()
      cached.src = window.fixture.state.data.url
      await cached.decode()
    })
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.ImageView), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.views = []
      function Example({ url }) {
        const [viewState, setView] = React.useState({})
        return React.createElement('div', { style: { height: 500 } }, React.createElement(Conversation.ImageView, { url, title: 'figure.svg', failed: false, viewState, onViewChange: next => { window.fixture.views.push(next); setView(next) } }))
      }
      mount(state => React.createElement(Example, { url: state.data.url }))
    })
    await expect(page.getByTestId('image-viewport').locator('img')).toHaveJSProperty('naturalWidth', 800)
    await expect(page.getByTestId('image-dimensions')).toHaveText('800 × 400')
    await page.getByRole('button', { name: '实际大小', exact: true }).click()
    await expect(page.getByTestId('image-zoom')).toHaveText('100%')
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    await expect(page.getByTestId('image-zoom')).toHaveText('125%')
    const surface = page.getByTestId('image-viewport')
    const bounds = await surface.boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 30); await page.mouse.up()
    await expect(surface).toHaveAttribute('data-pan-x', '40')
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(surface).toHaveAttribute('data-pan-x', '0')
    const fittedScale = Number(await surface.getAttribute('data-scale'))
    await surface.dblclick()
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale * 2))
    await surface.dblclick()
    await expect(surface).toHaveAttribute('data-mode', 'fit')
    const pageScroll = await page.evaluate(() => window.scrollY)
    await surface.hover()
    await page.mouse.wheel(0, -100)
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale * 1.25))
    assert.equal(await page.evaluate(() => window.scrollY), pageScroll)
    await page.mouse.wheel(0, 100)
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale))
    await page.evaluate(() => { window.fixture.state.data.url = 'data:image/png;base64,invalid'; window.fixture.publish() })
    await expect(page.getByRole('alert')).toHaveText('无法显示此图片，请检查文件是否完整。')
    await expect(page.getByRole('button', { name: '放大图片', exact: true })).toBeDisabled()
    const failedViewCount = await page.evaluate(() => window.fixture.views.length)
    await surface.dblclick()
    await page.mouse.wheel(0, -100)
    assert.equal(await page.evaluate(() => window.fixture.views.length), failedViewCount)
    await page.evaluate(() => { window.fixture.state.data.url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="40"/>'); window.fixture.publish() })
    await expect(page.getByTestId('image-dimensions')).toHaveText('20 × 40')
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('citation rechecks changed evidence before opening the exact original and preserves failure feedback', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.scholarseedUI.Conversation.CitationLink), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []; window.fixture.changed = true; window.fixture.failOpen = true
      const source = { handle: 'receipt-1', pages: [{ page: 2, quads: [] }], source_kind: 'file', source_id: 'source-1', content_level: 'fulltext', project_id: 'project-1', path: 'paper.pdf', title: '原始文献.pdf', revision: 'sha256:revision-1', quote: '已核对的原文', version_bound: true, can_open_pdf: true, matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '已核对的原文', quality_reasons: [], manual_check: false } }
      mount(() => React.createElement(Conversation.CitationLink, { resolve: async () => ({ ...source, state: window.fixture.changed ? 'changed' : 'exact' }), reveal: async value => { if (window.fixture.failOpen) throw new Error('open denied'); window.fixture.opened.push({ handle: value.handle, revision: value.revision }) }, previewUrl: () => '', displayNumber: 1 }, '1'))
    })
    await page.getByRole('button').first().hover()
    const preview = page.getByLabel('PDF 引用预览', { exact: true })
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
    await page.getByRole('button').first().click()
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

test('mixed citation directory keeps provenance, original URLs and previous sources when refresh fails', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.opened = []; window.fixture.failRefresh = false
      const resolved = { handle: 'receipt-2', pages: [], source_kind: 'file', source_id: 'source-2', content_level: 'abstract', project_id: 'project-1', path: 'material.pdf', title: '材料.pdf', revision: 'sha256:revision-2', quote: '摘要片段', version_bound: true, can_open_pdf: false, state: 'source_only', matches: [], presentation: { version: 1, mode: 'structured_text', precision: 'source', text: '摘要片段', quality_reasons: [], manual_check: false } }
      const sources = [{ number: 1, kind: 'searched', title: '研究报道', url: 'https://example.org/%E5%8E%9F%E6%96%87#section', search_kind: 'web', search_id: 'search-1', citation_urls: [] }, { number: 2, kind: 'receipt', handle: 'receipt-2', citation_urls: [] }]
      mount(() => React.createElement(Conversation.CitationSources, { sourceKey: 'answer-1', answerSources: sources, loadSources: async () => { if (window.fixture.failRefresh) throw new Error('unavailable'); return { count: 1, sources: [resolved] } }, resolveSource: async () => resolved, reveal: async value => window.fixture.opened.push(value.handle), previewUrl: () => '', openWebSource: url => window.fixture.opened.push(url) }))
    })
    const summary = page.getByRole('button', { name: /2.*来源/ })
    await summary.click()
    await expect(page.locator('[data-citation-source-entry]')).toHaveCount(2)
    await expect(page.getByText('材料.pdf', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /查看引用.*研究报道/ }).click()
    await expect(page.getByLabel('网页来源预览')).toContainText('网页搜索来源')
    await page.getByLabel('网页来源预览').getByRole('button', { name: '查看原文', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://example.org/%E5%8E%9F%E6%96%87#section'])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.fixture.failRefresh = true })
    await summary.click()
    await expect(page.getByText('暂时无法更新来源状态，已保留上次信息；可点击引用重试。', { exact: true })).toBeVisible()
    await expect(page.getByText('材料.pdf', { exact: true })).toBeVisible()
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/citation-component.png') })
    await page.getByRole('button', { name: /查看引用.*材料.pdf/ }).click()
    await expect(page.getByRole('dialog')).toContainText('摘要片段')
    await expect(page.getByRole('dialog').getByRole('button', { name: '打开 PDF', exact: true })).toHaveCount(0)
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['https://example.org/%E5%8E%9F%E6%96%87#section'])
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
    assert.ok(second.x >= first.x + first.width)
    await cards.nth(1).getByTestId('artifact-import-resources').click()
    await expect(cards.nth(1).getByRole('status')).toHaveText('样例导入失败，可重试')
    await expect(cards.nth(0).getByRole('status')).toHaveText('尚未导入')
    if (count === 3) await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/artifact-group-component.png') })
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

test('shared artifact keeps version identity, deep menus and independent open/import ports', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.artifact', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.artifactActions = []
      const primary = { artifact_id: 'revision-2', publication_id: 'publication-1', name: 'report.md', title: '研究报告', path: 'report.md', role: 'final', status: 'available' }
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
    await page.getByTestId('artifact-open').click()
    await page.getByTestId('artifact-import-resources').click()
    await page.getByTestId('artifact-versions').click()
    await page.getByTestId('artifact-version-revision-1').click()
    await page.getByTestId('artifact-more-actions').click()
    await page.getByTestId('artifact-dropdown-open-with').click()
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
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/artifact-destination-component.png') })
    await dialog.getByRole('button', { name: '导入', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: '样例导入已完成' })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.fixture.locations), [{ parent: 'papers/review', name: 'comparison' }, { parent: 'papers/review', name: 'comparison' }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('user messages keep literal text, complete copying, expandable reading and controlled links', async () => {
  const url = 'https://example.com/paper?q=a%20b#part'
  const text = '**不是 Markdown 标题**\n' + Array.from({ length: 14 }, (_, index) => `研究约束 ${index}，保留完整表达。`).join('\n') + `\n${url}\njavascript:alert(1)`
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.message', status: 'pending', data: { text } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.copies = []; window.fixture.opened = []; window.fixture.rejectLink = true
      mount(state => React.createElement(Conversation.Message, {
        text: state.data.text,
        onCopy: async text => { window.fixture.copies.push(text) },
        onOpenExternal: async url => { if (window.fixture.rejectLink) throw new Error('rejected'); window.fixture.opened.push(url) },
      }))
    })
    const content = page.getByTestId('message-text')
    await expect(content).toHaveText(text)
    await expect(content.locator('strong')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '展开更多', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies), [text])
    await page.getByRole('button', { name: '展开更多', exact: true }).click()
    await expect(page.getByRole('button', { name: '收起', exact: true })).toBeVisible()
    await page.getByRole('link', { name: url, exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法打开链接')
    await page.evaluate(() => { window.fixture.rejectLink = false })
    await page.getByRole('link', { name: url, exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), [url])
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.setViewportSize({ width: 360, height: 640 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/message-component.png') })
    await page.evaluate(() => { window.fixture.state.data.text = '短消息 **原样保留**'; window.fixture.publish() })
    await expect(content).toHaveText('短消息 **原样保留**')
    await expect(page.getByRole('button', { name: /展开更多|收起/ })).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('user messages without host ports do not acquire clipboard or navigation capabilities', async () => {
  const text = 'https://example.com/plain **原始文字**'
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.message', status: 'pending', data: { text } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Message, { text: state.data.text, timestamp: Number.MAX_VALUE }))
    })
    await expect(page.getByTestId('message-text')).toHaveText(text)
    await expect(page.getByRole('link')).toHaveCount(0)
    await expect(page.getByRole('button')).toHaveCount(0)
    await expect(page.locator('time')).toHaveCount(0)
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
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/table-component.png') })
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
    await expect(panel.getByRole('status')).toContainText('表格格式不完整')
    await expect(panel.locator('pre')).toHaveText(source)
    await expect(panel.locator('td')).toHaveCount(0)
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
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    const rich = await page.evaluate(() => window.fixture.copies[0])
    assert.equal(rich.text, '\\frac{a}{b}')
    assert.match(rich.html, /<math[\s\S]*<annotation encoding="application\/x-tex">/)
    assert.doesNotMatch(rich.html, /class="katex-html"/)
    await formula.getByRole('button', { name: 'LaTeX', exact: true }).click()
    await expect(formula.locator('pre')).toHaveText('\\frac{a}{b}')
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.copies[1]), { text: '\\frac{a}{b}', html: undefined })
    await page.evaluate(() => { window.fixture.state.data.text = '$$\n\\unknowncommand{x}\n$$\n\n仍然保留的正文'; window.fixture.publish() })
    await expect(formula.getByRole('status')).toContainText('公式解析失败')
    await expect(formula.locator('pre')).toHaveText('\\unknowncommand{x}')
    await expect(page.getByText('仍然保留的正文', { exact: true })).toBeVisible()
    await formula.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(await page.evaluate(() => window.fixture.copies.at(-1).text), '\\unknowncommand{x}')
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
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/formula-component.png') })
    await page.evaluate(() => { window.fixture.state.data.source = '\\href{javascript:alert(1)}{unsafe}'; window.fixture.publish() })
    await expect(page.getByTestId('conversation-formula').locator('a')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制', exact: true })).toHaveCount(0)
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
    await page.screenshot({ path: path.resolve(__dirname, '../../work/ui-sdk/code-component.png') })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('command and output displays preserve plain text without inventing execution or a copy capability', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.command', status: 'pending', data: { mode: 'command', code: 'python analyze.py\n' } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Code, { mode: state.data.mode, code: state.data.code }))
    })
    await expect(page.getByTestId('conversation-code')).toContainText('命令')
    assert.equal(await page.locator('[data-code-line]').evaluate(element => getComputedStyle(element, '::before').content), 'none')
    await expect(page.getByRole('button')).toHaveCount(0)
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { mode: 'output', code: 'permission denied\n' }); window.fixture.publish() })
    await expect(page.getByTestId('conversation-code')).toContainText('输出')
    await expect(page.locator('pre')).toHaveText('permission denied')
    assert.deepEqual(await page.evaluate(() => window.fixture.actions), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared failure keeps recovery bound to the original item and displays pending and failed outcomes', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.failure', status: 'pending', data: { actionState: 'idle', available: true } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.recoveries = []
      mount(state => React.createElement(Conversation.Failure, {
        item: { kind: 'error', id: 'failure', turnId: 'original-turn', runtimeAction: 'continue_turn', failure: { kind: 'unavailable' }, actionState: state.data.actionState },
        failureText: { title: '连接失败', message: '连接暂时不可用', action: '请重试' },
        recoveryAvailable: state.data.available,
        actionError: state.data.error,
        onContinue: item => { window.fixture.recoveries.push(item.turnId); state.data.actionState = 'submitting'; window.fixture.publish() },
      }))
    })
    await expect(page.getByTestId('turn-recoverable-notice')).toContainText('连接暂时不可用')
    await page.getByTestId('turn-continue').click()
    await expect(page.getByTestId('turn-continue')).toBeDisabled()
    assert.deepEqual(await page.evaluate(() => window.fixture.recoveries), ['original-turn'])
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { actionState: 'outcome_unknown', error: '结果待核对' }); window.fixture.publish() })
    await expect(page.getByTestId('turn-continue')).toBeDisabled()
    await expect(page.getByTestId('turn-continue-error')).toContainText('结果待核对')
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { actionState: 'idle', error: '重试失败' }); window.fixture.publish() })
    await expect(page.getByTestId('turn-continue')).toBeEnabled()
    await expect(page.getByTestId('turn-continue-error')).toContainText('重试失败')
    await page.evaluate(() => { window.fixture.state.data.available = false; window.fixture.publish() })
    await expect(page.getByTestId('turn-continue')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared authentication and unknown-turn notices retain repair and controlled confirmation semantics', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.failure', status: 'pending', data: { unknown: false } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.repairs = []
      mount(state => React.createElement(Conversation.Failure, {
        item: { kind: 'error', id: 'auth', turnId: 'auth-turn', runtimeAction: state.data.unknown ? 'confirm_turn_unknown' : 'continue_turn', failure: { kind: 'auth' }, actionState: state.data.pending ? 'outcome_unknown' : 'idle' },
        failureText: { title: '认证失败', message: '需要核对账号', action: '核对后继续' },
        recoveryAvailable: true,
        authenticationAction: 'login', authenticationChecking: state.data.checking, authenticationCheckFailed: state.data.failed,
        onContinue: async item => { window.fixture.repairs.push(item.turnId) },
        onRepair: async resume => { window.fixture.repairs.push(resume); state.data.checking = true; window.fixture.publish() },
      }))
    })
    await expect(page.getByTestId('turn-failure-description')).toContainText('需要核对账号 核对后继续')
    await page.getByTestId('turn-authentication-repair').click()
    await expect(page.getByTestId('turn-continue')).toBeDisabled()
    await expect(page.getByTestId('turn-authentication-repair')).toBeDisabled()
    assert.deepEqual(await page.evaluate(() => window.fixture.repairs), [false])
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { checking: false, failed: true }); window.fixture.publish() })
    await expect(page.getByTestId('turn-failure-card').getByRole('status')).toBeVisible()
    await page.getByTestId('turn-continue').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.repairs), [false, true])
    await page.evaluate(() => { Object.assign(window.fixture.state.data, { unknown: true, checking: false }); window.fixture.publish() })
    await expect(page.getByTestId('turn-interrupted-notice')).toBeVisible()
    await page.getByTestId('turn-unknown-continue').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.repairs), [false, true, 'auth-turn'])
    await page.evaluate(() => { window.fixture.state.data.pending = true; window.fixture.publish() })
    await expect(page.getByTestId('turn-unknown-continue')).toBeDisabled()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared plan shows nested steps and elapsed state; only the host continuation callback executes', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.plan', status: 'pending', data: { done: false } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.continuations = 0
      mount(state => React.createElement(Conversation.Plan, {
        id: 'plan-1',
        items: [{ id: 'read', content: '阅读材料', status: 'done', elapsedMilliseconds: 2000 }, { id: 'compare', content: '比较方法', status: state.data.done ? 'done' : 'stopped', children: [{ content: '核对证据', status: state.data.done ? 'done' : 'todo' }] }],
        summary: { status: state.data.done ? 'done' : 'stopped', label: state.data.done ? '已完成' : '已暂停', paused: !state.data.done },
        elapsedMilliseconds: 61000,
        canContinue: !state.data.done,
        onContinue: () => { window.fixture.continuations++; return new Promise(resolve => { window.fixture.complete = resolve }) },
      }))
    })
    await expect(page.getByTestId('todo-panel')).toBeVisible()
    await expect(page.getByTestId('todo-body')).toContainText('比较方法')
    await expect(page.getByTestId('todo-body')).toContainText('核对证据')
    await expect(page.getByTestId('todo-step-elapsed').first()).toContainText('2s')
    await page.getByTestId('todo-continue').click()
    await expect(page.getByTestId('todo-continue')).toBeDisabled()
    assert.equal(await page.evaluate(() => window.fixture.continuations), 1)
    await page.evaluate(() => window.fixture.complete(false))
    await expect(page.getByTestId('todo-continue')).toBeEnabled()
    await page.evaluate(() => { window.fixture.state.data.done = true; window.fixture.publish() })
    await expect(page.getByTestId('todo-continue')).toHaveCount(0)
    await expect(page.getByTestId('todo-progress')).toContainText('2 / 2')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('shared attachments preserve original indexes, keyboard opening, menus and controlled preview state', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.files', status: 'pending', data: { openPaths: [] } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, IconButton, mount } = window.scholarseedUI
      window.fixture.operations = []
      mount(state => React.createElement(Conversation.Attachments, {
        refs: [{ type: 'skill', id: 'skill', title: '阅读', path: 'skill' }, { type: 'file', id: 'paper', title: '目录/论文.pdf', path: 'paper.pdf', size: 42 }, { type: 'directory', id: 'folder', title: '材料', path: 'materials' }],
        openPaths: state.data.openPaths,
        onOpen: value => window.fixture.operations.push({ open: value }),
        onRemove: index => window.fixture.operations.push({ remove: index }),
        renderActions: ref => React.createElement(IconButton, { label: '操作', size: 'sm', variant: 'ghost', icon: React.createElement('span', null, '⋯'), onClick: () => window.fixture.operations.push({ menu: ref.id }) }),
      }))
    })
    const file = page.getByTestId('message-attachment-paper')
    await expect(file).toBeVisible()
    const opener = file.getByRole('button', { name: '论文.pdf 移除附件 目录/论文.pdf', exact: true })
    await opener.focus()
    await page.keyboard.press('Enter')
    await file.hover()
    await file.getByRole('button', { name: '操作', exact: true }).click()
    await file.getByRole('button', { name: '移除附件 目录/论文.pdf', exact: true }).click()
    const operations = await page.evaluate(() => window.fixture.operations)
    assert.equal(operations[0].open.path, 'paper.pdf')
    assert.equal(operations[0].open.size, 42)
    assert.deepEqual(operations.slice(1), [{ menu: 'paper' }, { remove: 1 }])
    await page.evaluate(() => { window.fixture.state.data.openPaths = ['paper.pdf']; window.fixture.publish() })
    await expect(opener).toHaveClass(/border-\[var\(--brand-ink\)\]/)
    await page.evaluate(() => { window.fixture.state.data.openPaths = []; window.fixture.publish() })
    await expect(opener).not.toHaveClass(/border-\[var\(--brand-ink\)\]/)
    await expect(page.getByTestId('message-attachment-folder')).toContainText('材料')
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
    assert.equal(page.url(), 'http://resource.test/')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('suggestions share host-controlled availability, input, busy and failure feedback', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', slot: 'custom.next', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.scholarseedUI
      window.fixture.messages = []
      mount(state => React.createElement(Conversation.Suggestions, {
        payload: { title: '下一步', options: [{ label: '阅读', description: '阅读全文' }, { label: '对比', description: '比较方法' }], free_text_label: '补充要求', submit_label: '继续' },
        available: state.status === 'pending', busy: state.data.busy || false,
        failed: state.data.failed || false, draft: state.data.draft || '',
        onDraft: draft => { state.data.draft = draft; window.fixture.publish() },
        onSend: message => window.fixture.messages.push(message),
      }))
    })
    await page.getByRole('button', { name: '阅读 阅读全文' }).click()
    await page.getByRole('textbox', { name: '补充要求' }).fill('只比较已读论文')
    await page.getByRole('button', { name: '继续', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.messages), ['阅读\n阅读全文', '只比较已读论文'])
    await page.evaluate(() => { window.fixture.state.data.busy = true; window.fixture.publish() })
    await expect(page.getByRole('button', { name: '阅读 阅读全文' })).toBeDisabled()
    await expect(page.getByRole('textbox', { name: '补充要求' })).toBeDisabled()
    await page.evaluate(() => { window.fixture.state.data.busy = false; window.fixture.publish() })
    await page.evaluate(() => { window.fixture.state.data.failed = true; window.fixture.publish() })
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '补充要求' })).toHaveValue('只比较已读论文')
    await page.getByRole('button', { name: '继续', exact: true }).click()
    assert.equal((await page.evaluate(() => window.fixture.messages)).length, 3)
    await page.evaluate(() => { window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect(page.getByRole('button', { name: '阅读 阅读全文' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('official selection preserves descriptions, subset, mixed/all state, language and terminal disable', async () => {
  const { page, errors } = await openComponent('__ui__/selection.js', {
    language: 'zh', slot: 'literature.selection', status: 'pending',
    data: { papers: [{ id: 'one', label: '论文一', description: '证据说明一' }, { id: 'two', label: '论文二', description: '证据说明二' }], selected_paper_ids: [] },
  })
  try {
    await expect(page.getByText('证据说明一')).toBeVisible()
    const initialBackground = await page.getByRole('checkbox', { name: '论文一 证据说明一' }).evaluate(element => getComputedStyle(element).backgroundColor)
    await page.getByRole('checkbox', { name: '论文一 证据说明一' }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute('aria-checked', 'mixed')
    assert.notEqual(await page.getByRole('checkbox', { name: '论文一 证据说明一' }).evaluate(element => getComputedStyle(element).backgroundColor), initialBackground)
    assert.deepEqual(await page.evaluate('window.fixture.actions.at(-1)'), { action: 'select', values: { selected_paper_ids: ['one'] } })
    await page.getByRole('checkbox', { name: '全选', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('checkbox', { name: '全选', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute('aria-checked', 'false')
    await page.evaluate(() => { window.fixture.state.language = 'en'; window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect(page.getByRole('checkbox', { name: 'Select all', exact: true })).toBeDisabled()
    assert.equal(await page.locator('html').getAttribute('data-ui-version'), manifest.version)
    const paperRow = page.getByRole('checkbox').nth(1)
    assert.equal(await paperRow.evaluate(element => getComputedStyle(element).borderTopWidth), '1px')
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

test('migrated question keeps selected answers, descriptions and host-controlled resolution', async () => {
  const { page, errors } = await openComponent('__ui__/choices.js', {
    language: 'zh', slot: 'interaction.question', status: 'pending',
    data: { multiSelect: true, answers: ['first'], options: [{ label: 'first', displayLabel: '第一项', description: '原有说明' }, { label: 'second', displayLabel: '第二项' }] },
  })
  try {
    await expect(page.getByRole('checkbox', { name: '第一项 原有说明' })).toBeChecked()
    await page.getByRole('checkbox', { name: '第二项', exact: true }).click()
    assert.deepEqual(await page.evaluate('window.fixture.actions.at(-1)'), { action: 'choose', values: { answers: ['first', 'second'] } })
    await expect(page.getByRole('checkbox', { name: '第二项', exact: true })).toBeChecked()
    await page.evaluate(() => { window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect(page.getByRole('checkbox', { name: '第二项', exact: true })).toBeDisabled()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('migrated authorization renders the complete host scope without inventing approval actions', async () => {
  const papers = Array.from({ length: 12 }, (_, index) => ({ id: String(index), label: `论文 ${index}`, description: `范围 ${index}` }))
  const { page, errors } = await openComponent('__ui__/choices.js', { language: 'zh', slot: 'literature.authorization', status: 'pending', data: { papers } })
  try {
    await expect(page.getByRole('listitem')).toHaveCount(papers.length)
    await expect(page.getByText('范围 11', { exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate('window.fixture.actions'), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
