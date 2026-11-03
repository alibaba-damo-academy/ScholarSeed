const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { chromium, expect } = desktopRequire('@playwright/test')
const { buildOfficialUI } = require('./build.cjs')

let directory
let browser
before(async () => {
  const work = path.resolve(__dirname, '../../work/template-tests')
  await fs.mkdir(work, { recursive: true })
  directory = await fs.mkdtemp(path.join(work, 'resources-'))
  await buildOfficialUI(directory)
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

for (const withFields of [false, true]) test(`editable template preserves edits across saving, failure, state updates and confirmation: fields=${withFields}`, async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('http://template.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1)
      if (!name) return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      return route.fulfill({ body: await fs.readFile(path.join(directory, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2' })
    })
    await page.goto('http://template.test/')
    await page.evaluate(withFields => {
      let listener
      const state = { language: 'zh', status: 'pending', draft: {}, data: { title: '科研目标', choices: [{ id: 'one', label: '目标一' }, { id: 'two', label: '目标二' }], fields: [{ id: 'question', label: '自定义问题' }], selected: ['one'], actions: ['confirm'] } }
      if (!withFields) delete state.data.fields
      const fixture = { state, submissions: [], saves: [], publish: () => listener(state), settle: null }
      Object.assign(window, { fixture, plugin: {
        onState(callback) { listener = callback; callback(state); return () => {} },
        save(values) { fixture.saves.push(values); return new Promise((resolve, reject) => { fixture.settle = success => {
          if (!success) return reject(new Error('save_failed'))
          state.draft = values; fixture.publish(); resolve({ state: values, revision: fixture.saves.length })
        } }) },
        submit(action, values) { fixture.submissions.push({ action, values }); state.status = 'submitting'; fixture.publish() }
      } })
    }, withFields)
    await page.addScriptTag({ url: 'http://template.test/ui.js' })
    await page.addScriptTag({ content: await fs.readFile(path.resolve(__dirname, '../../skills/community/plugin-create/templates/card.js'), 'utf8') })
    await expect(page.getByRole('checkbox', { name: '目标一', exact: true })).toHaveAttribute('aria-checked', 'true')
    if (withFields) {
      await page.getByRole('textbox', { name: '自定义问题' }).fill('初次问题')
      await expect(page.getByRole('textbox', { name: '自定义问题' })).toHaveValue('初次问题')
      await page.getByRole('textbox', { name: '自定义问题' }).fill('')
      await page.getByRole('textbox', { name: '自定义问题' }).fill('修订问题')
    }
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await page.getByRole('checkbox', { name: '目标二', exact: true }).click()
    if (withFields) {
      await page.getByRole('checkbox', { name: '目标一', exact: true }).click()
      await page.getByRole('textbox', { name: '自定义问题' }).fill('保存期间的最新问题')
    }
    await page.evaluate(() => window.fixture.settle(true))
    await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: '目标二', exact: true })).toHaveAttribute('aria-checked', 'true')
    if (withFields) {
      await expect(page.getByRole('checkbox', { name: '目标一', exact: true })).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByRole('textbox', { name: '自定义问题' })).toHaveValue('保存期间的最新问题')
    }
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await page.evaluate(() => window.fixture.settle(false))
    await expect(page.getByRole('alert')).toHaveText('保存失败，选择仍保留')
    await page.getByRole('button', { name: '确认', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.submissions), [{ action: 'confirm', values: withFields ? { selected: ['two'], fields: { question: '保存期间的最新问题' } } : { selected: ['one', 'two'] } }])
    await expect(page.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.fixture.state.status = 'pending'; window.fixture.publish() })
    await expect(page.getByRole('button', { name: '确认', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await page.evaluate(() => { window.fixture.state.status = 'resolved'; window.fixture.publish() })
    await expect(page.getByText('已确认', { exact: true })).toBeVisible()
    for (const status of ['cancelled', 'unknown', 'stale']) {
      await page.evaluate(value => { window.fixture.state.status = value; window.fixture.publish() }, status)
      await expect(page.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
      await expect(page.getByRole('checkbox', { name: '目标二', exact: true })).toHaveAttribute('aria-checked', 'true')
    }
    assert.equal(await page.evaluate(() => window.fixture.submissions.length), 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
