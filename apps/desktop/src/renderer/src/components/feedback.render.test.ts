import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_URL = '/components/feedback.render.fixture.html'
const CLOCK_START = new Date('2026-09-13T00:00:00Z')
const TOAST_DURATION_MS = 6000
const LANGUAGE_SWITCH_AFTER_MS = 1500
const EXPIRY_BOUNDARY_MS = 1
const REMAINING_BEFORE_EXPIRY_MS = TOAST_DURATION_MS - LANGUAGE_SWITCH_AFTER_MS - EXPIRY_BOUNDARY_MS
const SAMPLES = [
  { name: 'failure', zh: /浏览器进程启动失败/, en: /browser was found, but it could not start/ },
  {
    name: 'fallback',
    zh: /当前运行时缺少搜索所需能力/,
    en: /current runtime lacks a capability required for search/,
  },
  { name: 'completed', zh: /3/, en: /Organized 3/ },
  { name: 'importFailure', zh: /upstream TLS detail abc/, en: /upstream TLS detail abc/ },
  { name: 'saved', zh: /已保存 2/, en: /Saved 2/ },
] as const

const FEEDBACK_TICKET = '1791542723_e1cedcd6'
const FEEDBACK_SUBMISSION_URL = '**/api/serve/feedback'
const FEEDBACK_LANGUAGES = [
  { language: '中文', receipt: `反馈编号：${FEEDBACK_TICKET}` },
  { language: 'English', receipt: `Feedback ID: ${FEEDBACK_TICKET}` },
] as const

test('feedback recording entry delegates without submitting and is absent when unavailable', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    let submissions = 0
    await page.route(FEEDBACK_SUBMISSION_URL, (route) => {
      submissions += 1
      return route.fulfill({ json: { id: FEEDBACK_TICKET } })
    })
    for (const sample of [
      { language: '中文', entry: '记录操作' },
      { language: 'English', entry: 'Log actions' },
    ]) {
      await page.goto(new URL(FIXTURE_URL, url).toString())
      await page.getByRole('button', { name: sample.language, exact: true }).click()
      await page.getByRole('button', { name: 'Open feedback', exact: true }).click()
      await expect(page.getByTestId('feedback-submit')).toBeDisabled()
      const { recordBounds, submitBounds } = await page
        .getByTestId('feedback-dialog')
        .evaluate((dialog) => ({
          recordBounds: dialog
            .querySelector('[data-testid="feedback-record"]')
            ?.getBoundingClientRect()
            .toJSON(),
          submitBounds: dialog
            .querySelector('[data-testid="feedback-submit"]')
            ?.getBoundingClientRect()
            .toJSON(),
        }))
      assert.ok(recordBounds && submitBounds)
      assert.ok(recordBounds.x + recordBounds.width <= submitBounds.x)
      assert.equal(recordBounds.y, submitBounds.y)
      await page.getByTestId('feedback-record').hover()
      await expect(page.getByRole('tooltip')).toHaveText('Ctrl+Alt+F')
      await page.getByRole('button', { name: sample.entry, exact: true }).click()
      await expect(page.getByTestId('feedback-dialog')).toHaveCount(0)
      await expect(page.getByTestId('recording-requested')).toBeVisible()
    }
    assert.equal(submissions, 0)
    await page.goto(new URL(`${FIXTURE_URL}?withoutRecorder`, url).toString())
    await page.getByRole('button', { name: 'Open feedback', exact: true }).click()
    await expect(page.getByTestId('feedback-record')).toHaveCount(0)
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('failure recovery opens feedback without workspace state and reports partial diagnostics', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.route(FEEDBACK_SUBMISSION_URL, (route) =>
      route.fulfill({ json: { ok: true, id: FEEDBACK_TICKET } })
    )
    for (const sample of [
      { lang: 'zh', notice: /完整运行日志及会话记录未能附带/ },
      { lang: 'en', notice: /conversation records could not be included/ },
    ]) {
      await page.goto(
        new URL(`${FIXTURE_URL}?recovery&partial&lang=${sample.lang}`, url).toString()
      )
      await page.getByTestId('feedback-recovery-entry').click()
      await expect(page.getByTestId('feedback-dialog')).toBeVisible()
      await expect(page.getByTestId('progress-screen')).toHaveCount(0)
      await page.getByTestId('feedback-description').fill('[测试] recovery feedback')
      await page.getByTestId('feedback-submit').click()
      await expect(page.getByTestId('feedback-partial-diagnostics')).toContainText(sample.notice)
      await expect(page.getByTestId('feedback-ticket')).toContainText(FEEDBACK_TICKET)
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('feedback stays above an open reader floating window', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(new URL(FIXTURE_URL, url).toString())
    await page.getByRole('button', { name: 'Open reader floating window' }).click()
    const floating = page.getByRole('dialog', { name: '翻译' })
    await expect(floating).toBeVisible()
    await page.getByRole('button', { name: 'Open feedback' }).click()
    const feedback = page.getByTestId('feedback-dialog')
    await expect(feedback).toBeVisible()
    const overlap = await page.evaluate(() => {
      const feedbackElement = document.querySelector<HTMLElement>('[data-testid="feedback-dialog"]')
      const floatingElement = document.querySelector<HTMLElement>('[aria-label="翻译"]')
      if (!feedbackElement || !floatingElement) return false
      const feedbackRect = feedbackElement.getBoundingClientRect()
      const floatingRect = floatingElement.getBoundingClientRect()
      const left = Math.max(feedbackRect.left, floatingRect.left)
      const right = Math.min(feedbackRect.right, floatingRect.right)
      const top = Math.max(feedbackRect.top, floatingRect.top)
      const bottom = Math.min(feedbackRect.bottom, floatingRect.bottom)
      if (left >= right || top >= bottom) return false
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      return feedbackElement.contains(hit)
    })
    assert.equal(overlap, true)
    await feedback.getByRole('button', { name: /关闭|Close/ }).click()
    await expect(floating).toBeVisible()
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('feedback receipt copies its label and allows partial mouse selection', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] })
    await page.route(FEEDBACK_SUBMISSION_URL, (route) =>
      route.fulfill({ json: { id: FEEDBACK_TICKET } })
    )
    await page.goto(new URL(FIXTURE_URL, url).toString())
    for (const sample of FEEDBACK_LANGUAGES) {
      await page.getByRole('button', { name: sample.language, exact: true }).click()
      await page.getByRole('button', { name: 'Open feedback', exact: true }).click()
      await page.getByTestId('feedback-description').fill('Receipt copy regression')
      await page.getByTestId('feedback-submit').click()
      const ticket = page.getByTestId('feedback-ticket')
      await expect(ticket).toHaveText(sample.receipt)
      await page.getByTestId('feedback-copy').click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sample.receipt)
      assert.equal(await ticket.evaluate((element) => getComputedStyle(element).userSelect), 'text')
      const bounds = await ticket.boundingBox()
      assert.ok(bounds)
      await page.mouse.move(bounds.x, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
        steps: 10,
      })
      await page.mouse.up()
      const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
      assert.ok(selection.length > 0 && selection.length < sample.receipt.length)
      await page
        .getByTestId('feedback-dialog')
        .getByRole('button', { name: /完成|Done/, exact: true })
        .click()
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('queued resource toasts redraw without replacement, duplicate delivery, or extended expiry', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
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

test('feedback previews preserve the draft, restore focus and release image URLs', async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      const active = new Set<string>()
      Object.assign(window, { activeImageUrls: active })
      URL.createObjectURL = (blob) => {
        const url = create(blob)
        active.add(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        active.delete(url)
        revoke(url)
      }
    })
    await page.goto(new URL(FIXTURE_URL, url).toString())
    for (const language of ['中文', 'English']) {
      await page.getByRole('button', { name: language, exact: true }).click()
      await page.getByRole('button', { name: 'Open feedback', exact: true }).click()
      const draft = page.getByTestId('feedback-description')
      await draft.fill('Keep this feedback draft')
      await page.getByTestId('feedback-include-logs').click()
      const auto = page.getByTestId('feedback-auto-screenshot-preview')
      await auto.focus()
      await page.keyboard.press('Enter')
      const preview = page.getByTestId('feedback-preview-dialog')
      const image = page.getByTestId('feedback-preview-image')
      await expect(preview).toBeVisible()
      const geometry = await preview.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        viewport: window.innerWidth,
      }))
      assert.ok(
        geometry.width > geometry.viewport * 0.8,
        'preview should use the available window width'
      )
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0)
      await page.keyboard.press('Tab')
      assert.equal(await preview.evaluate((el) => el.contains(document.activeElement)), true)
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
      await expect(auto).toBeFocused()
      await expect(draft).toHaveValue('Keep this feedback draft')
      await expect(page.getByTestId('feedback-include-logs')).toHaveAttribute(
        'aria-checked',
        'false'
      )
      const thumbnail = await page
        .getByTestId('feedback-auto-screenshot-thumb')
        .evaluate(async (el: HTMLImageElement) =>
          Array.from(new Uint8Array(await (await fetch(el.src)).arrayBuffer()))
        )
      await page.getByTestId('feedback-images').setInputFiles([
        { name: 'first.png', mimeType: 'image/png', buffer: Buffer.from(thumbnail) },
        { name: 'second.png', mimeType: 'image/png', buffer: Buffer.from(thumbnail) },
      ])
      const attachments = page.getByTestId('feedback-image-preview')
      await attachments.nth(1).click()
      await expect(preview.getByRole('heading')).toHaveText('second.png')
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0)
      await preview.getByRole('button').click()
      await expect(attachments.nth(1)).toBeFocused()
      await attachments.nth(0).click()
      await page.keyboard.press('Escape')
      await expect(attachments.nth(0)).toBeFocused()
      await expect(draft).toHaveValue('Keep this feedback draft')
      await attachments.nth(1).click()
      // The overlay dismisses only the image, keeping attachment controls intact.
      await page
        .locator('.vds-dialog__overlay')
        .last()
        .click({ position: { x: 1, y: 1 } })
      await expect(preview).toHaveCount(0)
      await expect(draft).toHaveValue('Keep this feedback draft')
      await page.getByTestId('feedback-images').setInputFiles({
        name: 'broken.png',
        mimeType: 'image/png',
        buffer: Buffer.from('invalid image'),
      })
      await attachments.nth(2).click()
      await expect(preview.getByRole('alert')).toHaveText(/无法显示此图片|could not be displayed/)
      await page.keyboard.press('Escape')
      await expect(draft).toHaveValue('Keep this feedback draft')
      // Only the automatic thumbnail URL remains while the feedback form is open.
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { activeImageUrls: Set<string> }).activeImageUrls.size
          )
        )
        .toBe(1)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('feedback-dialog')).toHaveCount(0)
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { activeImageUrls: Set<string> }).activeImageUrls.size
          )
        )
        .toBe(0)
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
