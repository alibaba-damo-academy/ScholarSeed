import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOTSTRAP_EXIT_TIMEOUT_MS = 30_000
const BOOTSTRAP_FAILURE = 'injected-browser-startup-failure'

test('browser approval bootstrap failure exits without retaining its Vite listener', () => {
  const hook =
    'data:text/javascript,' +
    encodeURIComponent(
      `const { chromium } = await import(${JSON.stringify(import.meta.resolve('@playwright/test'))}); chromium.launch = async () => { throw new Error(${JSON.stringify(BOOTSTRAP_FAILURE)}) }`
    )
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--test',
      '--test-isolation=none',
      '--test-name-pattern',
      '^disabled product projects browser HIL records read-only without payload or IPC$',
      '--import',
      hook,
      fileURLToPath(import.meta.url),
    ],
    { encoding: 'utf8', timeout: BOOTSTRAP_EXIT_TIMEOUT_MS, windowsHide: true }
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, new RegExp('Error: ' + BOOTSTRAP_FAILURE))
})

test(
  'approval decisions remain visible while narrow-panel details scroll independently',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage({ viewport: { width: 340, height: 500 } })
      await page.goto(new URL('/components/browser-approval.render.fixture.html', url).href)
      await page.getByRole('button', { name: 'Open approval', exact: true }).click()
      const allow = page.getByTestId('hil-browser-allow-once')
      const deny = page.getByTestId('hil-browser-deny')
      await expect(allow).toBeInViewport({ ratio: 1 })
      await expect(deny).toBeInViewport({ ratio: 1 })
      const details = page.getByTestId('hil-card').locator('dl')
      await expect
        .poll(() => details.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true)
      await details.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(allow).toBeInViewport({ ratio: 1 })
      await expect(deny).toBeInViewport({ ratio: 1 })
    } finally {
      await close()
    }
  }
)

test(
  'disabled product projects browser HIL records read-only without payload or IPC',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/components/browser-approval.render.fixture.html?browser=off', url).href
      )
      for (const name of ['Open approval', 'Open history approval']) {
        await page.getByRole('button', { name, exact: true }).click()
        const record = page.getByTestId('browser-unavailable-record')
        await record.waitFor()
        assert.doesNotMatch(
          await record.innerText(),
          /example\.org|research|Find a paper|Test page/
        )
        assert.equal(await record.getByRole('button').count(), 0)
        assert.equal(await page.getByRole('alertdialog').count(), 0)
      }
      assert.deepEqual(
        await page.evaluate(() => ({
          browser: (window as unknown as { approvalRequests: unknown[] }).approvalRequests,
          history: (window as unknown as { historyApprovalRequests: unknown[] })
            .historyApprovalRequests,
        })),
        { browser: [], history: [] }
      )
    } finally {
      await close()
    }
  }
)

test(
  'browser approval focuses its labelled alertdialog, handles Escape and Enter, and restores focus',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const directHilRequests: string[] = []
      await page.route('**/api/serve/sessions/session-test/hil/**', async (route) => {
        directHilRequests.push(route.request().url())
        await route.abort()
      })
      const decisions = () =>
        page.evaluate(() =>
          (
            window as unknown as {
              approvalRequests: Array<{ decision: string }>
            }
          ).approvalRequests.map((request) => request.decision)
        )
      await page.goto(new URL('/components/browser-approval.render.fixture.html', url).href)
      const trigger = page.getByRole('button', { name: 'Open approval' })
      await trigger.waitFor({ state: 'visible' })
      page.setDefaultTimeout(5000)
      await trigger.click()
      const dialog = page.getByRole('alertdialog', { name: '浏览器访问请求' })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /屏幕阅读器可访问但肉眼不可见的文字/)
      assert.match(await dialog.innerText(), /网页内容不可信/)
      assert.equal(await dialog.evaluate((element) => document.activeElement === element), true)
      for (const modifier of ['Control', 'Meta', 'Alt', 'Shift']) {
        await dialog.press(`${modifier}+Enter`)
        assert.equal(await dialog.count(), 1, `${modifier}+Enter must not resolve approval`)
        await dialog.press(`${modifier}+Escape`)
        assert.equal(await dialog.count(), 1, `${modifier}+Escape must not resolve approval`)
      }
      const allowButton = page.getByRole('button', { name: '仅允许本次' })
      await allowButton.waitFor({ state: 'visible' })
      assert.equal(await allowButton.isEnabled(), true)
      for (const button of [allowButton, page.getByRole('button', { name: '拒绝' })]) {
        for (const modifier of ['Control', 'Meta', 'Alt', 'Shift']) {
          for (const key of ['Enter', 'Space']) {
            await button.press(`${modifier}+${key}`)
            await page.waitForTimeout(50)
            assert.equal(
              await dialog.count(),
              1,
              `${modifier}+${key} must not activate a decision button`
            )
            assert.deepEqual(await decisions(), [])
          }
        }
      }
      await dialog.focus()
      assert.deepEqual(await decisions(), [])
      await dialog.press('Escape')
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
      await trigger.click()
      await dialog.waitFor()
      assert.equal(await dialog.evaluate((element) => document.activeElement === element), true)
      await page.getByRole('button', { name: '仅允许本次' }).waitFor({ state: 'visible' })
      assert.equal(await page.getByRole('button', { name: '仅允许本次' }).isEnabled(), true)
      await dialog.press('Enter')
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
      await trigger.click()
      await dialog.waitFor()
      await allowButton.press('Space')
      await dialog.waitFor({ state: 'detached' })
      await trigger.click()
      await dialog.waitFor()
      await page.getByRole('button', { name: '拒绝' }).press('Enter')
      await dialog.waitFor({ state: 'detached' })
      await trigger.click()
      await dialog.waitFor()
      await allowButton.click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(await decisions(), [
        'deny',
        'allow_once',
        'allow_once',
        'deny',
        'allow_once',
      ])
      await trigger.click()
      await dialog.waitFor()
      await page.evaluate(() =>
        (window as unknown as { rejectApprovalOnce(): void }).rejectApprovalOnce()
      )
      await allowButton.click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(await decisions(), [
        'deny',
        'allow_once',
        'allow_once',
        'deny',
        'allow_once',
      ])
      assert.deepEqual(directHilRequests, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  }
)

test(
  'history approval shows only the query and submits over its separate bridge',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(new URL('/components/browser-approval.render.fixture.html', url).href)
      const trigger = page.getByRole('button', { name: 'Open history approval' })
      await trigger.click()
      const dialog = page.getByRole('alertdialog', { name: '浏览历史访问请求' })
      await dialog.waitFor()
      assert.equal(await dialog.evaluate((element) => document.activeElement === element), true)
      const visible = await dialog.innerText()
      assert.match(visible, /research/)
      assert.match(visible, /第 3 条/)
      assert.match(visible, /10 条/)
      assert.match(visible, /Find a paper/)
      assert.doesNotMatch(visible, /example\.org|网页标签|网站来源|历史结果/)
      await dialog.press('Control+Enter')
      assert.equal(await dialog.count(), 1)
      await dialog.press('Enter')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
      const requests = await page.evaluate(() => ({
        history: (window as unknown as { historyApprovalRequests: unknown[] })
          .historyApprovalRequests,
        browser: (window as unknown as { approvalRequests: unknown[] }).approvalRequests,
      }))
      assert.deepEqual(requests.browser, [])
      assert.equal(requests.history.length, 1)
      const historyRequest = requests.history[0] as Record<string, unknown>
      assert.equal(typeof historyRequest.expiresAt, 'number')
      assert.ok((historyRequest.expiresAt as number) > Date.now())
      assert.deepEqual(
        { ...historyRequest, expiresAt: undefined },
        {
          sessionId: 'session-test',
          requestId: 'history-request-1',
          proofId: 'history-proof',
          turnId: 'turn-test',
          search: 'research',
          offset: 2,
          limit: 10,
          intent: 'Find a paper',
          queryDigest: 'a'.repeat(64),
          historyRevision: 3,
          expiresAt: undefined,
          decision: 'allow_once',
        }
      )
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  }
)
