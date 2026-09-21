import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { chromium, type Browser, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_URL = '/components/ui.missing.fixture.html'
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
    server = await createServer({
      configFile: false,
      // Concurrent Vite fixtures must not invalidate each other's optimized chunks.
      cacheDir: path.join(ROOT_DIR, 'node_modules/.vite-tests', `${path.basename(FIXTURE_URL)}-${process.pid}`),
      root: ROOT_DIR,
      plugins: [react()],
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true
      }
    })
    await server.listen()

    const url = server.resolvedUrls?.local[0]
    assert.ok(url, 'Vite test server should expose a local URL')

    browser = await chromium.launch()
    const page = await browser.newPage()
    const startupErrors: string[] = []
    page.on('pageerror', error => startupErrors.push(`pageerror: ${error.message}`))
    page.on('requestfailed', request => startupErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`))
    page.on('response', response => {
      if (response.status() >= 400) startupErrors.push(`response: ${response.status()} ${response.url()}`)
    })
    try {
      await page.goto(new URL(FIXTURE_URL, url).toString())
      await run(page)
    } catch (error) {
      console.error('UI fixture failure evidence', { url: page.url(), startupErrors, body: (await page.locator('body').innerText()).slice(0, 2000) })
      throw error
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
}

test('ported DeepRD primitives render and expose core interactions', async () => {
  await withFixture(async (page) => {
    await page.getByRole('button', { name: 'Open dialog' }).click()
    await assert.equal(await page.getByRole('dialog', { name: 'Dialog title' }).isVisible(), true)
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await assert.equal(await page.getByRole('dialog', { name: 'Dialog title' }).count(), 0)

    await page.getByRole('button', { name: 'Open alert dialog' }).click()
    await assert.equal(await page.getByRole('alertdialog', { name: 'Delete project' }).isVisible(), true)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await assert.equal(await page.getByRole('alertdialog', { name: 'Delete project' }).count(), 0)
    await assert.equal(await page.getByTestId('render-alert-dialog-result').textContent(), 'deleted')

    await page.getByRole('button', { name: 'Open popover' }).click()
    await assert.equal(await page.getByTestId('render-popover-content').isVisible(), true)

    await page.getByTestId('render-hover-card-trigger').hover()
    await assert.equal(await page.getByTestId('render-hover-card-content').isVisible(), true)
    await page.getByTestId('render-hover-card-content').hover()
    await assert.equal(await page.getByTestId('render-hover-card-content').getAttribute('data-state'), 'open')
    await page.getByRole('button', { name: 'Open hover detail' }).click()
    await assert.equal(await page.getByTestId('render-hover-card-value').textContent(), 'opened')
    await page.mouse.move(1, 1)
    await page.waitForTimeout(300)
    await assert.equal(await page.getByTestId('render-hover-card-content').count(), 0)
    await page.getByTestId('render-hover-card-trigger').focus()
    await assert.equal(await page.getByTestId('render-hover-card-content').isVisible(), true)
    await assert.equal(await page.getByTestId('render-hover-card-content').getAttribute('data-state'), 'open')
    const hoverBounds = await page.getByTestId('render-hover-card-content').boundingBox()
    assert.ok(hoverBounds && hoverBounds.width > 0 && hoverBounds.x >= 0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Open dropdown' }).click()
    const dropdown = page.getByRole('menu')
    const dropdownTrigger = page.getByRole('button', { name: 'Open dropdown' })
    const dropdownBounds = await dropdown.boundingBox()
    const dropdownTriggerBounds = await dropdownTrigger.boundingBox()
    assert.ok(dropdownBounds)
    assert.ok(dropdownTriggerBounds)
    await assert.equal(await dropdown.evaluate((element) => element.parentElement === document.body), true)
    assert.ok(Math.abs(dropdownBounds.x - dropdownTriggerBounds.x) <= 1)
    assert.ok(dropdownBounds.y >= dropdownTriggerBounds.y + dropdownTriggerBounds.height)
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await assert.equal(await page.getByTestId('render-dropdown-value').textContent(), 'Archive')
    await assert.equal(await page.getByRole('menu').count(), 0)
    await dropdownTrigger.click()
    await page.keyboard.press('Escape')
    await assert.equal(await page.getByRole('menu').count(), 0)
    await dropdownTrigger.click()
    await page.mouse.click(1, 1)
    await assert.equal(await page.getByRole('menu').count(), 0)

    await page.getByTestId('render-context-menu-trigger').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await assert.equal(await page.getByTestId('render-context-menu-value').textContent(), 'Duplicate')

    await page.getByRole('button', { name: 'File' }).click()
    await page.getByRole('menuitem', { name: 'New' }).click()
    await assert.equal(await page.getByTestId('render-menubar-value').textContent(), 'New')

    await page.getByRole('button', { name: 'Docs' }).click()
    await assert.equal(await page.getByTestId('render-navigation-menu-content').isVisible(), true)
    await page.getByRole('button', { name: 'Docs' }).click()
    await assert.equal(await page.getByTestId('render-navigation-menu-content').isVisible(), false)

    await page.getByRole('button', { name: 'Next slide' }).click()
    const carouselContent = page.getByTestId('render-carousel-active-slide')
    await assert.equal(await carouselContent.textContent(), 'FirstSecond')
    assert.match(await carouselContent.getAttribute('style') ?? '', /translateX\(calc\(-1 \*/)
    await page.getByRole('button', { name: 'Previous slide' }).click()
    assert.match(await carouselContent.getAttribute('style') ?? '', /translateX\(calc\(-0 \*/)

    await page.getByRole('button', { name: '15' }).click()
    await assert.equal(await page.getByTestId('render-calendar-value').textContent(), '15')

    await assert.equal(await page.getByTestId('render-chart').locator('svg').count(), 1)
  })
})
