import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_URL = '/components/feedback.render.fixture.html'
const CLOCK_START = new Date('2026-09-13T00:00:00Z')
const LANGUAGE_SWITCH_AFTER_MS = 1500
const REMAINING_BEFORE_EXPIRY_MS = 1499
const EXPIRY_BOUNDARY_MS = 1
const SAMPLES = [
  { name: 'failure', zh: /浏览器进程启动失败/, en: /browser was found, but it could not start/ },
  { name: 'fallback', zh: /当前运行时缺少搜索所需能力/, en: /current runtime lacks a capability required for search/ },
  { name: 'completed', zh: /3/, en: /Organized 3/ },
  { name: 'importFailure', zh: /upstream TLS detail abc/, en: /upstream TLS detail abc/ },
  { name: 'saved', zh: /已保存 2/, en: /Saved 2/ }
] as const

test('queued resource toasts redraw without replacement, duplicate delivery, or extended expiry', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 }
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.clock.install({ time: CLOCK_START })
    await page.clock.pauseAt(CLOCK_START)
    await page.goto(new URL(FIXTURE_URL, url).toString())
    let emissions = 0
    for (const sample of SAMPLES) {
      await page.getByRole('button', { name: '中文', exact: true }).click()
      await page.getByRole('button', { name: sample.name, exact: true }).click()
      emissions += 1
      const toast = page.locator('.vds-toast')
      assert.equal(await toast.count(), 1)
      const node = await toast.elementHandle()
      assert.ok(node)
      assert.match(await toast.innerText(), sample.zh)
      const chineseTitle = await toast.locator('.vds-toast__title').innerText()
      await page.clock.runFor(LANGUAGE_SWITCH_AFTER_MS)
      await page.getByRole('button', { name: 'English', exact: true }).click()
      assert.match(await toast.innerText(), sample.en)
      assert.notEqual(await toast.locator('.vds-toast__title').innerText(), chineseTitle)
      assert.equal(await toast.evaluate((element, original) => element === original, node), true)
      assert.equal(await page.getByTestId('toast-ids').innerText(), sample.name)
      assert.equal(await page.getByTestId('emissions').innerText(), String(emissions))
      if (sample.name === 'failure') await page.screenshot({ path: '/tmp/resources-toast-en.png' })
      await page.clock.runFor(REMAINING_BEFORE_EXPIRY_MS)
      assert.equal(await toast.count(), 1)
      await page.clock.runFor(EXPIRY_BOUNDARY_MS)
      assert.equal(await toast.count(), 0)
      assert.equal(await page.getByTestId('toast-ids').innerText(), '')
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
