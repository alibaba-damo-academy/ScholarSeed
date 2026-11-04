import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function fixture(run: (page: Page) => Promise<void>): Promise<void> {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    plugins: [react()],
    define: { __SCHOLARSEED_WEB_VERSION__: JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, json: { error: 'fixture_unavailable' } })
    )
    await page.goto(
      new URL('/components/business/prompts.render.fixture.html', server.resolvedUrls!.local[0])
        .href
    )
    await expect(page.getByTestId('selection-prompt-explain')).toBeVisible()
    await run(page)
  } finally {
    await browser.close()
    await server.close()
  }
}

test('prompt resets use the current language as an unsaved draft and saving changes the actual instruction', async () => {
  await fixture(async (page) => {
    const explain = page.getByTestId('selection-prompt-explain')
    const original = await explain.inputValue()
    const saved = page.getByTestId('fixture-saved-prompts')
    const originalSaved = await saved.innerText()
    await explain.fill('My unsaved custom instructions')
    await page.getByTestId('fixture-language-en').click()
    await expect(page.getByTestId('selection-prompts-save')).toHaveText('Save')
    await expect(explain).toHaveValue('My unsaved custom instructions')
    assert.equal(await saved.innerText(), originalSaved)
    await page.getByTestId('selection-prompt-restore-explain').click()
    await expect(explain).toHaveValue(/^Explain /)
    const english = await explain.inputValue()
    await expect(page.getByTestId('fixture-instruction')).toHaveText(original)
    await page.getByTestId('fixture-toggle-prompts').click()
    await page.getByTestId('fixture-toggle-prompts').click()
    await expect(explain).toHaveValue(original)
    await page.getByTestId('selection-prompt-restore-explain').click()
    await page.getByTestId('selection-prompts-save').click()
    await expect(page.getByTestId('fixture-instruction')).toHaveText(english)
    const committed = JSON.parse(await saved.innerText())
    assert.equal(committed.explain, english)
    assert.equal(committed.translate, JSON.parse(originalSaved).translate)
    await page.getByTestId('fixture-language-zh').click()
    await expect(page.getByTestId('selection-prompts-save')).toHaveText('保存')
    await expect(explain).toHaveValue(english)
    await expect(page.getByTestId('fixture-instruction')).toHaveText(english)
    await page.reload()
    await expect(explain).toHaveValue(english)
    await expect(page.getByTestId('fixture-instruction')).toHaveText(english)
    await page.getByTestId('selection-prompt-restore-explain').click()
    await expect(explain).toHaveValue(original)
    await expect(page.getByTestId('fixture-instruction')).toHaveText(english)
  })
})

test('a failed prompt save preserves the actual instruction and retains the editable draft', async () => {
  await fixture(async (page) => {
    const explain = page.getByTestId('selection-prompt-explain')
    const original = await explain.inputValue()
    await explain.fill('Do not commit this failed save')
    await page.getByTestId('fixture-fail-save').click()
    await page.getByTestId('selection-prompts-save').click()
    await expect(page.getByTestId('selection-prompts-save')).toBeEnabled()
    await expect(explain).toHaveValue('Do not commit this failed save')
    await expect(page.getByTestId('fixture-instruction')).toHaveText(original)
    await page.reload()
    await expect(explain).toHaveValue(original)
  })
})
