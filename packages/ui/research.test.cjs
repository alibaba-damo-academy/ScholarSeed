const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { chromium, expect } = desktopRequire('@playwright/test')
const { build } = desktopRequire('esbuild')
const { buildOfficialUI } = require('./build.cjs')
const { buildComponents } = require('../../apps/desktop/scripts/components.cjs')
const manifest = require('./manifest.json')
const skills = ['agentic-search', 'precise-literature-search', 'literature-review', 'research-idea-partner']
let directory
let browser
let preview

before(async () => {
  const work = path.resolve(__dirname, '../../work/ui-sdk')
  await fs.mkdir(work, { recursive: true })
  directory = await fs.mkdtemp(path.join(work, 'research-'))
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
        const response=execution.execute(action,values);
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
  return { page, frame, context, errors }
}

for (const skill of skills) {
  test(`${skill}: independent result card sends its original detail operation`, async () => {
    const { page, frame, context, errors } = await openCard(skill, 'results')
    try {
      await frame.getByRole('button', { name: '查看全部结果', exact: true }).click()
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

test('references retain their searchable list and nested destination menu in isolation', async () => {
  const { page, frame, context, errors } = await openCard('research-idea-partner', 'references')
  try {
    await expect(frame.getByText('样例 1：长上下文方法对比', { exact: true })).toBeVisible()
    await frame.getByRole('searchbox', { name: '搜索文献标题' }).fill('样例 1：')
    await expect(frame.getByText('样例 2：长上下文方法对比', { exact: true })).toHaveCount(0)
    await frame.getByRole('button', { name: '添加到文献库：样例 1：长上下文方法对比', exact: true }).click()
    await frame.getByRole('menuitem', { name: '加入我的分类', exact: true }).hover()
    await frame.getByRole('menuitem', { name: '新建分类…', exact: true }).click()
    await expect(frame.getByRole('dialog')).toBeVisible()
    await frame.getByRole('textbox', { name: '分类名称' }).fill('隔离预览分类')
    await frame.getByRole('button', { name: '创建并添加', exact: true }).click()
    await expect(frame.getByRole('dialog')).toHaveCount(0)
    await expect(frame.getByText('已添加', { exact: true })).toBeVisible()
    const calls = await context.evaluate(() => window.fixture.calls)
    assert.ok(calls.some(call => call.action === 'create-collection' && call.values.name === '隔离预览分类'))
    assert.ok(calls.some(call => call.action === 'add-reference' && call.values.refId === 'sample-0'))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [skill, id] of [
  ['precise-literature-search', 'question'],
  ['precise-literature-search', 'paper-selection'],
  ['precise-literature-search', 'results'],
  ['precise-literature-search', 'details'],
  ['precise-literature-search', 'downloads'],
  ['precise-literature-search', 'delivery'],
  ['research-idea-partner', 'references'],
  ['literature-review', 'authorization'],
  ['literature-review', 'outline'],
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

test('composed outline keeps review text and current choices across saved revisions and terminal state', async () => {
  const {page, context, errors} = await openCard('literature-review', 'outline')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1)?.content.text ?? '')).toContain('[ ] 按当前方案开始撰写')
    await context.evaluate(() => {
      window.fixture.state.revision = 1
      window.fixture.state.draft = {answers:['按当前方案开始撰写']}
      window.fixture.state.status = 'resolved'
      window.fixture.publish()
    })
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1)?.content.text ?? '')).toContain('[x] 按当前方案开始撰写')
    const final = await context.evaluate(() => window.fixture.copies.at(-1))
    assert.match(final.content.text, /问题与评估设置/)
    assert.ok(final.content.text.indexOf('问题与评估设置') < final.content.text.indexOf('[x]'))
    assert.equal(final.revision, 1)
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
  const {page, context, errors} = await openCard('literature-review', 'outline')
  try {
    await expect.poll(() => context.evaluate(() => window.fixture.copies.length)).toBeGreaterThan(0)
    await context.evaluate(() => {
      window.fixture.deferCopy = true
      window.fixture.state.revision = 1
      window.fixture.state.draft = {answers:['按当前方案开始撰写']}
      window.fixture.publish()
    })
    await expect.poll(() => context.evaluate(() => typeof window.fixture.settleCopy)).toBe('function')
    await context.evaluate(() => {
      window.fixture.state.revision = 2
      window.fixture.state.draft = {answers:['修改大纲']}
      window.fixture.publish()
    })
    await expect(context.locator('input')).toHaveCount(0)
    await context.evaluate(() => {window.fixture.deferCopy = false; window.fixture.settleCopy()})
    await expect.poll(() => context.evaluate(() => window.fixture.copies.at(-1).revision)).toBe(2)
    const copied = await context.evaluate(() => window.fixture.copies.at(-1).content.text)
    assert.match(copied, /问题与评估设置/)
    assert.match(copied, /\[x\] 修改大纲/)
    assert.match(copied, /\[ \] 按当前方案开始撰写/)
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

test('delivery loads its real component state through sample request responses', async () => {
  const { page, frame, context, errors } = await openCard('precise-literature-search', 'delivery')
  try {
    await expect(frame.getByRole('button', { name: '选择保存位置', exact: true })).toBeVisible()
    await frame.getByRole('button', { name: '选择保存位置', exact: true }).click()
    await expect(frame.getByRole('dialog')).toBeVisible()
    await frame.getByRole('button', { name: '稍后保存', exact: true }).click()
    await expect(frame.getByRole('dialog')).toHaveCount(0)
    await expect(frame.getByRole('button', { name: '选择保存位置', exact: true })).toBeVisible()
    assert.ok((await context.evaluate(() => window.fixture.calls)).some(call => call.action === 'delivery'))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('review composition keeps outline choices, confirmed state and artifact operations', async () => {
  const outline = await openCard('literature-review', 'outline')
  try {
    await expect(outline.frame.getByText('问题与评估设置', { exact: true }).first()).toBeVisible()
    const choice = outline.frame.getByRole('radio', { name: /按当前方案开始撰写/ })
    await choice.click()
    assert.deepEqual(await outline.context.evaluate(() => window.fixture.calls), [{ action: 'choose', values: { answers: ['按当前方案开始撰写'] } }])
    await expect(choice).toBeChecked()
    await outline.context.evaluate(() => { window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect(choice).toBeDisabled()
    assert.deepEqual(outline.errors, [])
  } finally { await outline.page.close() }
  const review = await openCard('literature-review', 'review')
  try {
    await review.frame.getByRole('button', { name: '打开正文', exact: true }).click()
    assert.ok((await review.context.evaluate(() => window.fixture.calls)).some(call => call.action === 'open-artifact' && call.values.artifactId === 'sample-body'))
    assert.deepEqual(review.errors, [])
  } finally { await review.page.close() }
})
