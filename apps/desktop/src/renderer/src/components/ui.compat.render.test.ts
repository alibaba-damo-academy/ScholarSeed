import assert from 'node:assert/strict'
import net from 'node:net'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { chromium, type Browser, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import type { ViteDevServer } from 'vite'
import { renderServers } from '../../../test-helpers/render.ts'

const servers = renderServers({ after })

const FIXTURE_URL = '/components/ui.compat.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Unable to reserve a local test port')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function withFixture(run: (page: Page) => Promise<void>): Promise<void> {
  let browser: Browser | undefined
  let server: ViteDevServer | undefined

  try {
    const port = await reservePort()
    server = await servers.create({
      configFile: false,
      // Concurrent Vite fixtures must not invalidate each other's optimized chunks.
      cacheKey: path.basename(FIXTURE_URL),
      root: ROOT_DIR,
      plugins: [react()],
      server: { host: '127.0.0.1', port, strictPort: true },
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url, 'Vite test server should expose a local URL')
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    const startupErrors: string[] = []
    page.on('pageerror', (error) => startupErrors.push(`pageerror: ${error.message}`))
    page.on('requestfailed', (request) =>
      startupErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`)
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        startupErrors.push(`response: ${response.status()} ${response.url()}`)
    })
    try {
      await page.goto(new URL(FIXTURE_URL, url).toString())
      await run(page)
    } catch (error) {
      console.error('UI fixture failure evidence', {
        url: page.url(),
        startupErrors,
        body: (await page.locator('body').innerText()).slice(0, 2000),
      })
      throw error
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
}

test('DeepRD shadcn-style compatibility exports render baseline DOM', async () => {
  await withFixture(async (page) => {
    await assert.equal(
      await page.getByTestId('compat-alert').getByText('Alert title').textContent(),
      'Alert title'
    )
    await assert.equal(await page.getByTestId('compat-avatar').getByText('AV').textContent(), 'AV')
    await assert.equal(
      await page.getByTestId('compat-badge').getByText('Removable').isVisible(),
      true
    )
    await assert.equal(await page.getByRole('button', { name: '移除标签' }).isVisible(), true)
    await assert.notEqual(await page.getByTestId('compat-form-field-id').textContent(), '')
    await assert.equal(await page.getByLabel('验证码第 1 位').first().isVisible(), true)
    await assert.equal(await page.getByLabel('验证码第 3 位').isVisible(), true)
    await assert.equal(await page.getByText('Compat dialog props').isVisible(), true)
    await assert.equal(await page.getByTestId('compat-dialog-overlay').count(), 1)
    await page.getByText('Close compat dialog').click()
    await assert.equal(await page.getByText('No value command').isVisible(), true)
    await assert.equal(
      await page.getByRole('radio', { name: 'One' }).getAttribute('aria-checked'),
      'true'
    )
    await assert.equal(await page.getByText('Compat progress').isVisible(), true)
    await assert.equal(await page.getByText('42%').isVisible(), true)
    await assert.equal(await page.getByText('Left compat panel').isVisible(), true)
    await assert.equal(await page.getByText('Right compat panel').isVisible(), true)
    await assert.equal(await page.getByRole('combobox').isVisible(), true)
    await assert.equal(await page.getByRole('combobox').getByText('快速文献总结').isVisible(), true)
    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: '深度文献综述' }).click()
    await assert.equal(await page.getByTestId('compat-select-value').textContent(), 'deep')
    await page.getByRole('combobox').click({ force: true })
    await assert.equal(await page.getByText('Open sheet compat').isVisible(), true)
    await assert.equal(await page.getByText('Open drawer compat').isVisible(), true)
    await page.getByText('Tip trigger').focus()
    await page.getByText('Tip content').waitFor({ state: 'visible' })
    await assert.equal(await page.getByText('Tip content').isVisible(), true)
    await assert.equal(await page.getByTestId('compat-sonner').count(), 1)
    await assert.match(
      (await page.getByTestId('compat-toggle-class').textContent()) ?? '',
      /vds-toggle--pressed/
    )
  })
})
