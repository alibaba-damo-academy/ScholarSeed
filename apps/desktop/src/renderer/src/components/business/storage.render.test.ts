import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORKSPACE_PATH = '/api/serve/workspace-root'
const WORKSPACE = { root: '/fixture/effective', configured: null }
type Fixture = {
  homeReads: unknown[]
  home: (index: number, success: boolean) => void
  picker: (value: 'cancel' | 'reject' | 'select' | 'pending') => void
  pickerCalls: () => number
  cancelPicker: () => void
}

async function home(page: Page, success: boolean): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { storageFixture: Fixture }).storageFixture
    for (let index = 0; index < fixture.homeReads.length; index += 1) fixture.home(index, value)
  }, success)
}

test(
  'storage reads fail independently, retry safely and settle picker/save failures under StrictMode',
  { timeout: 120_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [
        {
          name: 'storage-launch-fixture-store',
          enforce: 'pre',
          transform(source, id) {
            if (!id.endsWith('/components/business/StorageFirstLaunch.tsx')) return
            return source.replace(
              "import { useApp } from '../../store'",
              "import { useStorageFixtureApp as useApp } from './storage.render.state'"
            )
          },
        },
        react(),
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      let readFailure = false
      let writes = 0
      let failWrite = false
      let releaseWrite: (() => void) | undefined
      let holdWrite = false
      let holdRead = false
      const staleReads: (() => void)[] = []
      await page.route(`**${WORKSPACE_PATH}`, async (route) => {
        const writing = route.request().method() === 'PUT'
        if (writing) {
          writes += 1
          if (holdWrite)
            await new Promise<void>((resolve) => {
              releaseWrite = resolve
            })
        }
        if (!writing && holdRead) {
          await new Promise<void>((resolve) => staleReads.push(resolve))
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ root: '/fixture/stale', configured: null }),
          })
          return
        }
        await route.fulfill({
          status: writing ? (failWrite ? 503 : 200) : readFailure ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            writing
              ? { ...WORKSPACE, configured: '/fixture/chosen', restartRequired: true }
              : WORKSPACE
          ),
        })
      })
      const initialWorkspaceRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === WORKSPACE_PATH &&
          response.request().method() === 'GET'
      )
      await page.goto(
        new URL('/components/business/storage.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await (await initialWorkspaceRead).finished()
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      await home(page, false)
      await expect(page.getByTestId('storage-data-home-error')).toBeVisible()
      await page.screenshot({
        path: path.join(tmpdir(), 'storage-render-home-error.png'),
        fullPage: true,
      })
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      await page.getByTestId('storage-data-home-retry').click()
      await expect(page.getByTestId('storage-data-home-loading')).toBeVisible()
      await home(page, true)
      await expect(page.getByTestId('storage-data-home-value')).toHaveText('/fixture/home')
      holdRead = true
      await page.getByTestId('fixture-toggle').click()
      await page.getByTestId('fixture-toggle').click()
      await home(page, true)
      await expect(page.getByTestId('storage-container-root-loading')).toBeVisible()
      await expect(page.getByTestId('storage-container-root-change')).toBeDisabled()
      await expect.poll(() => staleReads.length).toBeGreaterThan(0)
      await page.getByTestId('fixture-toggle').click()
      holdRead = false
      await page.getByTestId('fixture-toggle').click()
      await home(page, true)
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      const oldReplies = page.waitForResponse(
        (response) =>
          response.url().endsWith(WORKSPACE_PATH) &&
          response.request().method() === 'GET' &&
          response.status() === 200
      )
      staleReads.forEach((resolve) => resolve())
      await oldReplies
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      await page.evaluate(() =>
        (window as unknown as { storageFixture: Fixture }).storageFixture.picker('pending')
      )
      await page.getByTestId('storage-container-root-change').click()
      await expect(page.getByTestId('storage-container-root-change')).toBeDisabled()
      await page.keyboard.press('Enter')
      await page.evaluate(() =>
        (window as unknown as { storageFixture: Fixture }).storageFixture.cancelPicker()
      )
      await expect(page.getByTestId('storage-container-root-change')).toBeEnabled()
      assert.equal(writes, 0)
      readFailure = true
      await page.getByTestId('fixture-toggle').click()
      await page.getByTestId('fixture-toggle').click()
      await home(page, true)
      await expect(page.getByTestId('storage-container-root-error')).toBeVisible()
      await expect(page.getByTestId('storage-data-home-value')).toHaveText('/fixture/home')
      await expect(page.getByTestId('storage-container-root-change')).toBeDisabled()
      readFailure = false
      await page.getByTestId('storage-container-root-retry').click()
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      await page.evaluate(() =>
        (window as unknown as { storageFixture: Fixture }).storageFixture.picker('reject')
      )
      await page.getByTestId('storage-container-root-change').click()
      await expect(page.getByTestId('storage-container-root-failed')).toBeVisible()
      await expect(page.getByTestId('storage-container-root-change')).toBeEnabled()
      assert.equal(writes, 0)
      await page.evaluate(() =>
        (window as unknown as { storageFixture: Fixture }).storageFixture.picker('select')
      )
      failWrite = true
      await page.getByTestId('storage-container-root-change').click()
      await expect.poll(() => writes).toBe(1)
      await expect(page.getByTestId('storage-container-root-change')).toBeEnabled()
      await expect(page.getByTestId('storage-container-root-value')).toHaveText(WORKSPACE.root)
      failWrite = false
      holdWrite = true
      await page.getByTestId('storage-container-root-change').click()
      await expect.poll(() => writes).toBe(2)
      await expect(page.getByTestId('storage-container-root-change')).toBeDisabled()
      releaseWrite!()
      await expect(page.getByTestId('storage-container-root-value')).toHaveText('/fixture/chosen')
      await expect(page.getByTestId('storage-container-root-restart')).toBeVisible()
      await expect(page.getByTestId('storage-container-root-change')).toBeEnabled()
      await page.getByTestId('fixture-english').click()
      await expect(page.getByTestId('account-settings-storage')).toContainText('Data storage')
      await page.screenshot({
        path: path.join(tmpdir(), 'storage-render-ready-english.png'),
        fullPage: true,
      })
      const fixtureUrl = new URL(
        '/components/business/storage.render.fixture.html',
        server.resolvedUrls!.local[0]
      )
      fixtureUrl.search = 'launch&seen'
      await page.goto(fixtureUrl.href)
      await expect(page.getByTestId('fixture-seen')).toHaveText('true')
      expect(
        await page.evaluate(
          () => (window as unknown as { storageFixture: Fixture }).storageFixture.homeReads.length
        )
      ).toBe(0)
      fixtureUrl.search = 'launch'
      await page.goto(fixtureUrl.href)
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { storageFixture: Fixture }).storageFixture.homeReads.length
          )
        )
        .toBeGreaterThan(0)
      await home(page, false)
      await expect(page.getByTestId('storage-first-launch-read-error')).toBeVisible()
      await expect(page.getByTestId('fixture-seen')).toHaveText('false')
      await expect(page.getByTestId('storage-first-launch-dialog')).toHaveCount(0)
      await page.screenshot({
        path: path.join(tmpdir(), 'storage-render-firstlaunch-error.png'),
        fullPage: true,
      })
      await page.getByTestId('storage-first-launch-read-retry').click()
      await home(page, true)
      await expect(page.getByTestId('storage-first-launch-dialog')).toBeVisible()
      await expect(page.getByTestId('storage-first-launch-read-error')).toHaveCount(0)
      await page.getByTestId('storage-first-launch-default').click()
      await expect(page.getByTestId('fixture-seen')).toHaveText('true')
      await expect(page.getByTestId('storage-first-launch-dialog')).toHaveCount(0)
      await page.goto(fixtureUrl.href)
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { storageFixture: Fixture }).storageFixture.homeReads.length
          )
        )
        .toBeGreaterThan(0)
      await page.getByTestId('fixture-toggle').click()
      await home(page, false)
      await expect(page.getByTestId('storage-first-launch-read-error')).toHaveCount(0)
      await expect(page.getByTestId('fixture-seen')).toHaveText('false')
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
