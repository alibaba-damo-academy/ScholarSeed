const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { chromium, expect } = desktopRequire('@playwright/test')
const { build } = desktopRequire('esbuild')
const { buildOfficialUI } = require('./build.cjs')
const { buildComponents } = require('../../apps/desktop/scripts/cd/components.cjs')
const manifest = require('./manifest.json')
const skills = ['agentic-search', 'precise-literature-search', 'literature-review', 'research-idea-partner']
let directory
let browser
let preview

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-research-'))
  await buildOfficialUI(directory)
  await buildComponents(path.join(directory, 'review'))
  preview = (await build({ entryPoints: [path.resolve(__dirname, '../../apps/desktop/src/renderer/src/components/business/preview.ts')], bundle: true, format: 'iife', globalName: 'preview', write: false })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function openCard(skill, id) {
  const root = path.resolve(__dirname, '../../skills/community', skill)
  const descriptor = JSON.parse(await fs.readFile(path.join(root, '.scholarseed-plugin.json'), 'utf8'))
  const component = descriptor.components.find(value => value.id === id)
  const scenario = JSON.parse(await fs.readFile(path.join(root, component.preview), 'utf8'))
  const registration = manifest.components.find(value => value.slot === component.slot)
  const entry = registration?.entry ?? (skill === 'literature-review' && component.entry === 'components/cards.js' ? 'review/cards.js' : undefined)
  assert.ok(entry, `${skill}/${id} has an independent implementation`)
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const fixture = `${preview}
    const scenario = ${JSON.stringify(scenario)};
    const execution = preview.createPreviewSession(scenario);
    const state = { language:'zh', revision:0, slot:${JSON.stringify(component.slot)}, status:'pending', data:scenario.data };
    if (scenario.interaction?.questions?.length === 1) state.data = {...state.data, options:scenario.interaction.questions[0].options};
    let listener;
    window.fixture = {calls:[], copies:[], state, publish:()=>listener(state)};
    window.plugin = {
      async setCopyContent(content) {
        if(window.fixture.rejectCopy) throw new Error('registration_failed');
        const revision = state.revision;
        if(window.fixture.deferCopy) await new Promise(resolve=>window.fixture.settleCopy=resolve);
        window.fixture.copies.push({content,revision});
      },
      onState(callback) { listener=value=>callback(structuredClone(value)); listener(state); return ()=>{listener=undefined} },
      submit(action,values) { window.fixture.calls.push({action,values}); state.data={...state.data,...values}; listener(state) },
      async request(action,values) {
        window.fixture.calls.push({action,values});
        if (window.fixture.rejectNext) { window.fixture.rejectNext=false; throw new Error('preview_navigation_failed'); }
        if (window.fixture.delayNext) { window.fixture.delayNext=false; await new Promise(resolve => { window.fixture.release=resolve }); }
        const response=execution.execute(action,values);
        window.fixture.response=response.data;
        if(response.state==='failed') throw new Error(response.data.error);
        return response.data.result;
      }
    };`
  await page.route('http://research.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1)
    if (!name) return route.fulfill({ contentType: 'text/html', body: '<iframe title="Card" sandbox="allow-scripts" src="/frame" width="1400" height="950"></iframe>' })
    if (name === 'frame') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script><script src="/ui.js"></script><script src="/${entry}"></script>` })
    if (name === 'fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture })
    return route.fulfill({ body: await fs.readFile(path.join(directory, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2' })
  })
  await page.goto('http://research.test/')
  const frame = page.frameLocator('iframe')
  const context = page.frames().find(value => value.url().endsWith('/frame'))
  return { page, frame, context, errors, component, scenario }
}

for (const skill of skills) {
  test(`${skill}: result titles navigate by bound paper identity and keep retry in the card`, async (testContext) => {
    const { page, frame, context, errors } = await openCard(skill, 'details')
    try {
      const paper = frame.getByRole('link', { name: '样例 1：长上下文方法对比', exact: true }).first()
      await paper.click()
      await expect.poll(() => context.evaluate(() => window.fixture.calls)).toEqual([
        { action: 'open-source', values: { refId: 'sample-0' } },
      ])
      await context.evaluate(() => { window.fixture.rejectNext = true })
      await paper.click()
      await expect(frame.getByRole('alert')).toContainText('打开失败，请重试。')
      await expect(paper).toBeEnabled()
      await frame.getByRole('alert').getByRole('button', { name: '关闭通知', exact: true }).click()
      await expect(frame.getByRole('alert')).toHaveCount(0)
      await paper.click()
      await expect(frame.getByRole('alert')).toHaveCount(0)
      await context.evaluate(() => {
        const request = window.plugin.request
        window.plugin.request = (action, values) => {
          window.plugin.request = request
          window.fixture.calls.push({ action, values })
          throw new Error('preview_navigation_thrown')
        }
      })
      await paper.click()
      await expect(frame.getByRole('alert')).toContainText('打开失败，请重试。')
      await frame.getByRole('alert').getByRole('button', { name: '关闭通知', exact: true }).click()
      await paper.click()
      await expect(frame.getByRole('alert')).toHaveCount(0)
      assert.deepEqual(await context.evaluate(() => window.fixture.calls), [
        { action: 'open-source', values: { refId: 'sample-0' } },
        { action: 'open-source', values: { refId: 'sample-0' } },
        { action: 'open-source', values: { refId: 'sample-0' } },
        { action: 'open-source', values: { refId: 'sample-0' } },
        { action: 'open-source', values: { refId: 'sample-0' } },
      ])
      assert.deepEqual(errors, [])
    } finally {
      if (errors.length) testContext.diagnostic(JSON.stringify({ errors }))
      await page.close()
    }
  })

  test(`${skill}: result receipt previews papers and retries bound navigation`, async () => {
    const { page, frame, context, errors } = await openCard(skill, 'results')
    try {
      const receipt = frame.getByTestId('artifact-open')
      await expect(frame.getByTestId('receipt-toggle')).toHaveCount(0)
      const preview = frame.getByTestId('receipt-preview')
      await expect(preview).toBeVisible()
      await expect(preview.getByRole('listitem').first()).toBeVisible()
      await expect(frame.getByRole('button', { name: /打开文献：/ })).toHaveCount(0)
      await context.evaluate(() => { window.fixture.rejectNext = true })
      await receipt.click()
      await expect(frame.getByRole('alert')).toContainText('打开失败，请重试。')
      await expect(receipt).toBeEnabled()
      await receipt.click()
      await expect(frame.getByRole('alert')).toHaveCount(0)
      assert.deepEqual(await context.evaluate(() => window.fixture.calls), [
        { action: 'open-results', values: {} },
        { action: 'open-results', values: {} },
      ])
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })

  test(`${skill}: independent result card sends its original detail operation`, async () => {
    const { page, frame, context, errors } = await openCard(skill, 'results')
    try {
      await expect(frame.getByTestId('receipt-toggle')).toHaveCount(0)
      await frame.getByTestId('artifact-open').click()
      assert.deepEqual(await context.evaluate(() => window.fixture.calls), [{ action: 'open-results', values: {} }])
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
  test(`${skill}: independent result details preserve filtering and table controls`, async () => {
    const { page, frame, errors } = await openCard(skill, 'details')
    try {
      await expect(frame.getByTestId('literature-search-tab')).toBeVisible()
      await expect(frame.getByText('样例 1：长上下文方法对比', { exact: true }).first()).toBeVisible()
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test('result navigation waits for its host reply and retries the same detail request after failure', async () => {
  const { page, frame, context, errors } = await openCard('agentic-search', 'results')
  try {
    const details = frame.getByTestId('artifact-open')
    await context.evaluate(() => { window.fixture.rejectNext = true })
    await details.click()
    await expect(frame.getByRole('alert')).toContainText('打开失败，请重试。')
    await context.evaluate(() => { window.fixture.delayNext = true })
    await details.click()
    await expect(details).toBeDisabled()
    await details.press('Enter')
    assert.deepEqual(await context.evaluate(() => window.fixture.calls), [
      { action: 'open-results', values: {} }, { action: 'open-results', values: {} },
    ])
    await expect(details).toHaveAttribute('aria-busy', 'true')
    await expect(frame.getByRole('button', { name: /打开文献：/ })).toHaveCount(0)
    await context.evaluate(() => window.fixture.release())
    await expect(details).toBeEnabled()
    await expect(frame.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(await context.evaluate(() => window.fixture.calls), [
      { action: 'open-results', values: {} }, { action: 'open-results', values: {} },
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('related citations reuse Results and hand the list to native navigation', async () => {
  const { page, frame, context, errors } = await openCard('research-idea-partner', 'results')
  try {
    await context.evaluate(() => {
      window.fixture.state.data.origin = 'research-idea-citations'
      window.fixture.publish()
    })
    await expect(frame.getByTestId('artifact-open')).toContainText('实际引用文献')
    await expect(frame.getByRole('searchbox')).toHaveCount(0)
    await expect(frame.getByRole('menuitem')).toHaveCount(0)
    await frame.getByTestId('artifact-open').click()
    assert.deepEqual(await context.evaluate(() => window.fixture.calls), [{ action: 'open-results', values: {} }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [skill, id] of [
  ['precise-literature-search', 'results'],
  ['precise-literature-search', 'details'],
  ['research-idea-partner', 'results'],
  ['literature-review', 'review'],
]) {
  test(`${skill}/${id}: official composition registers copy text without clipboard access`, async () => {
    const {page, context, errors} = await openCard(skill, id)
    try {
      await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1)?.content.text ?? '')).not.toBe('')
      const copied = await context.evaluate(() => window.fixture.copies.at(-1).content.text)
      assert.doesNotMatch(copied, /\[object Object\]/)
      if (id === 'review' || id === 'outline') {
        assert.match(copied, /问题与评估设置/)
        assert.match(copied, /界定上下文长度与信息位置/)
      }
      if (id === 'review') {
        assert.match(copied, /位置与上下文长度对照表/)
        assert.match(copied, /Example Researcher/)
        assert.match(copied, /不要将摘要判断写成全文结论/)
        assert.match(copied, /sample-review\/06_output\/survey.md/)
        assert.doesNotMatch(copied, /sample-project|00000000000000000000000000000000/)
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test('review iframe retains content but leaves outline questions and resolution to the native host', async () => {
  const { page, frame, context, errors } = await openCard('literature-review', 'review')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1)?.content.text ?? '')).toContain('问题与评估设置')
    await expect(frame.getByRole('radio')).toHaveCount(0)
    await expect(frame.getByRole('checkbox')).toHaveCount(0)
    await context.evaluate(() => {
      window.fixture.state.revision = 1
      window.fixture.state.draft = { answers: ['按当前方案开始撰写'] }
      window.fixture.state.status = 'resolved'
      window.fixture.publish()
    })
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1)?.revision)).toBe(1)
    assert.deepEqual(await context.evaluate(() => window.fixture.calls), [])
    assert.doesNotMatch(await context.evaluate(() => window.fixture.copies.at(-1).content.text), /\[x\] 按当前方案开始撰写/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('copy registration failure is visible and recovers on the next saved state', async () => {
  const {page, frame, context, errors} = await openCard('literature-review', 'review')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.length)).toBeGreaterThan(0)
    await context.evaluate(() => {
      window.fixture.rejectCopy = true
      window.fixture.state.revision++
      window.fixture.publish()
    })
    await expect(frame.getByRole('alert')).toContainText('卡片复制文本保存失败')
    await context.evaluate(() => {
      window.fixture.rejectCopy = false
      window.fixture.state.revision++
      window.fixture.publish()
    })
    await expect(frame.getByText('卡片复制文本保存失败，请重试或重新打开卡片。', {exact:true})).toHaveCount(0)
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1).revision)).toBe(2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('queued registrations keep the newest saved revision after an older request settles', async () => {
  const {page, context, errors} = await openCard('literature-review', 'review')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.length)).toBeGreaterThan(0)
    await context.evaluate(() => {
      window.fixture.deferCopy = true
      window.fixture.state.revision = 1
      window.fixture.state.data = { ...window.fixture.state.data, title: '较早的大纲版本' }
      window.fixture.publish()
    })
    await expect.poll(() => context.evaluate(() => typeof window.fixture.settleCopy)).toBe('function')
    await context.evaluate(() => {
      window.fixture.state.revision = 2
      window.fixture.state.data = { ...window.fixture.state.data, title: '最新的大纲版本' }
      window.fixture.publish()
    })
    await expect(context.locator('input')).toHaveCount(0)
    await context.evaluate(() => {window.fixture.deferCopy = false; window.fixture.settleCopy()})
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1).revision)).toBe(2)
    const copied = await context.evaluate(() => window.fixture.copies.at(-1).content.text)
    assert.match(copied, /问题与评估设置/)
    assert.match(copied, /最新的大纲版本/)
    assert.doesNotMatch(copied, /较早的大纲版本/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('a fresh card snapshot retries failed registration even when text and revision are unchanged', async () => {
  const {page, frame, context, errors} = await openCard('literature-review', 'review')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.length)).toBeGreaterThan(0)
    await context.evaluate(() => { window.fixture.rejectCopy = true; window.fixture.state.revision++; window.fixture.publish() })
    await expect(frame.getByRole('alert')).toContainText('卡片复制文本保存失败')
    const before = await context.evaluate(() => window.fixture.copies.length)
    await context.evaluate(() => { window.fixture.rejectCopy = false; window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect.poll(() => context.evaluate(() => window.fixture.copies.length)).toBeGreaterThan(before)
    await expect(frame.getByText('卡片复制文本保存失败，请重试或重新打开卡片。', {exact:true})).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('retired download and delivery cards are absent from the published skill and UI', async () => {
  const plugin = JSON.parse(await fs.readFile(path.resolve(__dirname,
    '../../skills/community/precise-literature-search/.scholarseed-plugin.json'), 'utf8'))
  for (const id of ['downloads', 'delivery']) {
    assert.ok(!plugin.components.some(component => component.id === id), id)
  }
  const { page, context, errors } = await openCard('precise-literature-search', 'results')
  try {
    const names = await context.evaluate(() => Object.keys(window.scholarseedUI.Conversation))
    assert.ok(!names.includes('Downloads'))
    assert.ok(!names.includes('Delivery'))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('review receipt declares host navigation and opens the same preview identity', async () => {
  const { page, frame, context, errors, component, scenario } = await openCard('literature-review', 'review')
  try {
    const receipt = frame.getByTestId('artifact-open')
    await expect(receipt).toBeVisible()
    assert.deepEqual(await context.evaluate(() => window.fixture.calls), [])
    assert.ok(component.actions.some(action => action.id === 'open-results' && action.capability === 'navigation.open'))
    assert.equal(scenario.responses['open-results']?.state, 'resolved')
    await receipt.click()
    await expect.poll(() => context.evaluate(() => window.fixture.calls)).toEqual([{ action: 'open-results', values: {} }])
    assert.deepEqual(await context.evaluate(() => window.fixture.response.view), {
      title: scenario.data.title,
      body: scenario.responses['open-results'].data.view.body,
      identifier: scenario.data.workspace,
    })
    await expect(frame.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('review composition keeps outline display and artifact operations without question controls', async () => {
  const outline = await openCard('literature-review', 'review')
  try {
    const receipt = outline.frame.locator('[data-artifact-receipt]')
    await expect(receipt).toContainText('综述核对')
    await expect(receipt.locator('.lucide-book-open-check')).toBeVisible()
    await expect(receipt.getByRole('button')).toHaveCount(2)
    await expect(outline.frame.getByTestId('receipt-preview')).toHaveCount(0)
    await expect(outline.frame.getByTestId('artifact-more-actions')).toHaveCount(0)
    await receipt.getByRole('button', { name: '打开综述详情', exact: true }).press('Enter')
    assert.deepEqual(await outline.context.evaluate(() => window.fixture.calls), [{ action: 'open-results', values: {} }])
    assert.equal(outline.component.actions.find(action => action.id === 'open-results')?.capability, 'navigation.open')
    await expect(outline.frame.getByRole('alert')).toHaveCount(0)
    const mountDetails = () => {
      const { React, Conversation, createLiteraturePorts, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Review, {
        content: state.data,
        detail: true,
        ports: createLiteraturePorts((action, values) => window.plugin.request(action, values), state.data.context ?? {}),
      }))
    }
    await outline.context.evaluate(mountDetails)
    await expect(outline.frame.getByText('1. 问题与评估设置', { exact: true }).first()).toBeVisible()
    await outline.frame.getByRole('button', { name: '引用依据说明' }).first().focus()
    await expect(outline.frame.getByRole('tooltip')).toContainText('不等于已阅读全文')
    await expect(outline.frame.getByRole('radio')).toHaveCount(0)
    assert.deepEqual(await outline.context.evaluate(() => window.fixture.calls), [{ action: 'open-results', values: {} }])
    assert.deepEqual(outline.errors, [])
  } finally { await outline.page.close() }
  const review = await openCard('literature-review', 'review')
  try {
    await review.context.evaluate(() => {
      const { React, Conversation, createLiteraturePorts, mount } = window.scholarseedUI
      mount(state => React.createElement(Conversation.Review, {
        content: state.data,
        detail: true,
        ports: createLiteraturePorts((action, values) => window.plugin.request(action, values), state.data.context ?? {}),
      }))
    })
    await review.frame.getByRole('button', { name: '打开正文', exact: true }).click()
    assert.ok((await review.context.evaluate(() => window.fixture.calls)).some(call => call.action === 'open-artifact' && call.values.artifactId === 'sample-body'))
    assert.deepEqual(review.errors, [])
  } finally { await review.page.close() }
})
