import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
for (const cancelled of [false, true]) {
  test(
    `Landing verification ${cancelled ? 'cancels on unmount' : 'is single-flight across duplicate snapshots and rerenders'}`,
    { timeout: 60_000 },
    async () => {
      const fixture = await renderFixture(ROOT, {
        launch: () =>
          chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined }),
      })
      const { browser, server } = fixture
      try {
        const page = await browser.newPage()
        let requests = 0
        await page.route('**/api/auth/me', (route) => {
          requests += 1
          return route.fulfill({
            status: requests === 1 ? 401 : 200,
            contentType: 'application/json',
            body: JSON.stringify({ auth: requests > 1 }),
          })
        })
        await page.route('**/api/capabilities/**', (route) =>
          route.fulfill({ status: 200, body: '{}' })
        )
        await page.goto(
          new URL('/components/business/landing.fixture.html', server.resolvedUrls!.local[0]).href
        )
        await expect(page.getByTestId('landing-dialog')).toBeVisible()
        await page.evaluate(() =>
          window.loginHarness.snapshot({ phase: 'adopted', confirmationId: 1 })
        )
        await expect.poll(() => requests).toBe(1)
        assert.deepEqual(await page.evaluate(() => window.loginHarness.acks), [])
        if (cancelled) {
          await page.evaluate(() => window.loginHarness.unmount())
          await page.waitForTimeout(1300)
          assert.equal(requests, 1)
          assert.deepEqual(await page.evaluate(() => window.loginHarness.acks), [])
        } else {
          await page.evaluate(() => {
            window.loginHarness.rerender()
            window.loginHarness.snapshot({ phase: 'adopted', confirmationId: 1 })
          })
          await expect
            .poll(() => page.evaluate(() => window.loginHarness.acks))
            .toEqual([{ id: 1, confirmed: true }])
          assert.equal(requests, 2)
          assert.equal(await page.evaluate(() => window.loginHarness.authed()), 1)
        }
      } finally {
        await fixture.close()
      }
    }
  )
}
