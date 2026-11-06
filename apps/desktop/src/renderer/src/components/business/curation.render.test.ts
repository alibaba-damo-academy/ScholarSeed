import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'outline confirmation renders English, submits the original answer and localizes history',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/components/business/curation.fixture.html?outline', server.resolvedUrls!.local[0])
          .href
      )
      const card = page.getByTestId('hil-card')
      await expect(card).toContainText('Confirm outline and output settings')
      await expect(card).toContainText('Output format: PDF: English typesetting')
      await expect(card).toContainText('Writing will start only after confirmation')
      await expect(card).not.toContainText('是否按上述大纲')
      const option = page.getByTestId('hil-question-option-0-0')
      await expect(option).toContainText('Start writing with the current plan')
      await option.focus()
      await option.press('Space')
      await page.getByTestId('hil-question-confirm').click()
      assert.deepEqual(await page.evaluate('window.curationFixture.requests'), [
        { answers: { 'outline-review:fixture': '按当前方案开始撰写' } },
      ])
      await expect(page.getByTestId('hil-resolved')).toContainText(
        'Start writing with the current plan'
      )
      await page.evaluate("window.curationFixture.language('zh')")
      await expect(page.getByTestId('hil-resolved')).toContainText('按当前方案开始撰写')
      await page.evaluate("window.curationFixture.language('en')")
      await expect(page.getByTestId('hil-resolved')).toContainText(
        'Start writing with the current plan'
      )
      await page.goto(
        new URL(
          '/components/business/curation.fixture.html?outline&history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const reply = page.getByTestId('interaction-reply')
      await expect(reply).toContainText('Confirm outline and output settings')
      await reply.getByRole('button').click()
      await expect(reply).toContainText('Start writing with the current plan')
      await expect(reply).not.toContainText('按当前方案开始撰写')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'curation card uses the rendering language and submits only canonical answers',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ headless: true })
    try {
      for (const [index, canonical, displayed] of [
        [0, '确认执行', 'Confirm execution'],
        [1, '取消', 'Cancel'],
      ] as const) {
        const page = await browser.newPage()
        await page.goto(
          new URL('/components/business/curation.fixture.html', server.resolvedUrls!.local[0]).href
        )
        const card = page.getByTestId('hil-question-toggle')
        await expect(card).toContainText('Literature library confirmation')
        const option = page.getByTestId(`hil-question-option-0-${index}`)
        await expect(option).toContainText(displayed)
        await option.click()
        await page.getByTestId('hil-question-confirm').click()
        assert.deepEqual(await page.evaluate('window.curationFixture.requests'), [
          { answers: { 'literature-curation-fixture': canonical } },
        ])
        await expect(page.getByTestId('hil-resolved')).toContainText(displayed)
        await page.evaluate("window.curationFixture.language('zh')")
        await expect(card).toContainText('文献库操作确认')
        await expect(page.getByTestId('hil-resolved')).toContainText(canonical)
        await page.evaluate("window.curationFixture.language('en')")
        await expect(card).toContainText('Literature library confirmation')
        await expect(page.getByTestId('hil-resolved')).toContainText(displayed)
        assert.deepEqual(await page.evaluate('window.curationFixture.requests'), [
          { answers: { 'literature-curation-fixture': canonical } },
        ])
        await page.close()
      }
      const page = await browser.newPage()
      await page.goto(
        new URL('/components/business/curation.fixture.html?history', server.resolvedUrls!.local[0])
          .href
      )
      const reply = page.getByTestId('interaction-reply')
      await expect(reply).toContainText('Literature library confirmation')
      await expect(reply).toContainText('Cancel')
      await reply.getByRole('button').click()
      await expect(reply).toContainText('AI requests the destructive operation delete')
      await expect(reply).toContainText('用户标题')
      await expect(reply).not.toContainText('文献库操作确认')
      await page.evaluate("window.curationFixture.language('zh')")
      await expect(reply).toContainText('文献库操作确认')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
