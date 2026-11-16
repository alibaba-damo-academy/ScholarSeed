import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium, expect, type Page } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOTSTRAP_EXIT_TIMEOUT_MS = 30_000
const BOOTSTRAP_FAILURE = 'injected-browser-startup-failure'

async function openApproval(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.evaluate('window.approvalReady')
}

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
  'browser approval shows the reference details and decisions and hides the plan',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage({ viewport: { width: 340, height: 500 } })
      await openApproval(
        page,
        new URL('/components/browser-approval.render.fixture.html', url).href
      )
      await page.getByRole('button', { name: 'Open approval', exact: true }).click()
      const allow = page.getByTestId('hil-browser-allow-once')
      const deny = page.getByTestId('hil-browser-deny')
      await expect(allow).toBeInViewport({ ratio: 1 })
      await expect(deny).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('hil-card')).toContainText('https://example.org/')
      await expect(page.getByTestId('hil-card').locator('dl')).toHaveCount(1)
      await expect(page.getByTestId('hil-card')).toContainText('请求浏览器访问')
      await expect(page.getByTestId('hil-card')).toContainText('有效期至')
      await expect(page.getByTestId('hil-card')).toContainText('授权范围')
      await expect(allow).toHaveText('允许本次访问')
      await expect(page.getByTestId('todo-panel')).toBeHidden()
      await deny.click()
      await expect(page.getByTestId('todo-panel')).toBeVisible()
    } finally {
      await close()
    }
  }
)

test(
  'browser approval history is collapsed by default and expands to disabled decisions',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      await openApproval(
        page,
        new URL('/components/browser-approval.render.fixture.html?history', url).href
      )
      for (const decision of ['hil-browser-allow-once', 'hil-browser-deny']) {
        await page.getByRole('button', { name: 'Open approval', exact: true }).click()
        const history = page
          .getByTestId('hil-card')
          .filter({ hasNot: page.locator('[role="alertdialog"]') })
          .first()
        await history.getByTestId(decision).click()
        await expect(history).toHaveAttribute('data-hil-resolved', 'true')
        const toggle = history.getByTestId('turn-activity-trigger')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await expect(history.getByTestId('hil-browser-allow-once')).toBeHidden()
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(history.getByTestId('hil-browser-allow-once')).toBeDisabled()
        await expect(history.getByTestId('hil-browser-deny')).toBeDisabled()
        await expect(
          history
            .locator('dl > div')
            .filter({ has: page.getByText('授权范围', { exact: true }) })
            .locator('dd')
        ).toHaveText(decision === 'hil-browser-deny' ? '已拒绝' : '仅本次')
        await expect(history.locator('dt')).toHaveText(['网址', '有效期至', '授权范围', '操作'])
        await expect(history).not.toContainText('网页标签标识')
        await expect(history).not.toContainText('会话与任务轮次')
      }
    } finally {
      await close()
    }
  }
)

test(
  'expired browser approval scope shows a warning instead of a grant',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      await openApproval(
        page,
        new URL('/components/browser-approval.render.fixture.html?history&expired', url).href
      )
      await page.getByRole('button', { name: 'Open approval', exact: true }).click()
      const card = page.getByTestId('hil-card').first()
      await card.getByTestId('turn-activity-trigger').click()
      const scope = card
        .locator('dl > div')
        .filter({ has: page.getByText('授权范围', { exact: true }) })
        .locator('dd')
      await expect(scope).toHaveText('已过期')
      await expect(scope.getByText('已过期', { exact: true })).toHaveClass(
        /text-\[var\(--vds-warning-text-primary\)\]/
      )
      await expect(card.getByTestId('hil-browser-allow-once')).toBeDisabled()
      await expect(card.getByTestId('hil-browser-deny')).toBeDisabled()
    } finally {
      await close()
    }
  }
)

test(
  'literature authorization keeps the regular composer visible and preserves its draft',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(
      new URL('/components/browser-approval.render.fixture.html?composer', fixture.url).href
    )
    const plan = page.getByTestId('todo-panel')
    await expect(plan).toBeVisible()
    await expect(plan.getByText('执行计划', { exact: true })).toHaveCSS('font-weight', '400')

    const input = page.getByTestId('composer-input')
    const composer = page.getByTestId('composer-drop-zone')
    const stop = composer.getByTestId('composer-stop')
    const draft = '第一行草稿\n第二行草稿'
    await page.getByRole('button', { name: 'Clear literature approval' }).click()
    await input.fill(draft)
    await expect(input).toHaveCSS('height', '44px')
    await expect(stop).toBeVisible()
    await page.getByRole('button', { name: 'Open literature approval' }).click()
    const dock = page.getByTestId('hil-dock')
    await expect(dock).toHaveAttribute('data-hil-attached', 'true')
    const card = dock.getByTestId('hil-card').locator(':scope > div').first()
    await expect(card).toBeVisible()
    await expect(card.getByText('请求授权文献', { exact: true })).toHaveCSS('font-weight', '500')
    await expect(card.getByText(/^是否允许下载、读取并使用以下文献/)).toHaveCSS(
      'font-weight',
      '400'
    )
    await expect(plan).toBeHidden()
    await expect(composer).toBeVisible()
    await expect(input).toHaveValue(draft)

    await page.getByRole('button', { name: 'Clear literature approval' }).click()
    await expect(dock).toHaveCount(0)
    await expect(plan).toBeVisible()
    await expect(stop).toBeVisible()
    await expect(input).toHaveCSS('height', '44px')
    await expect(input).toHaveValue(draft)
  }
)

test(
  'literature authorization hides the floating composer until confirmation clears',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(
      new URL('/components/browser-approval.render.fixture.html?composer=floating', fixture.url)
        .href
    )
    const input = page.getByTestId('composer-input')
    const draft = '悬浮输入框草稿'
    await page.getByRole('button', { name: 'Clear literature approval' }).click()
    await input.fill(draft)
    await page.getByRole('button', { name: 'Open literature approval' }).click()
    await expect(page.getByTestId('hil-dock')).toBeVisible()
    await expect(input).toBeHidden()

    await page.getByRole('button', { name: 'Clear literature approval' }).click()
    await expect(page.getByTestId('hil-dock')).toHaveCount(0)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue(draft)
  }
)

test(
  'disabled product projects browser HIL records read-only without payload or IPC',
  { timeout: 60_000 },
  async () => {
    const { browser, url, close } = await renderFixture(ROOT)
    try {
      const page = await browser.newPage()
      await openApproval(
        page,
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
      await openApproval(
        page,
        new URL('/components/browser-approval.render.fixture.html', url).href
      )
      const trigger = page.getByRole('button', { name: 'Open approval' })
      await trigger.waitFor({ state: 'visible' })
      page.setDefaultTimeout(5000)
      await trigger.click()
      const dialog = page.getByRole('alertdialog', { name: '请求浏览器访问' })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /https:\/\/example.org\//)
      assert.equal(await dialog.evaluate((element) => document.activeElement === element), true)
      for (const modifier of ['Control', 'Meta', 'Alt', 'Shift']) {
        await dialog.press(`${modifier}+Enter`)
        assert.equal(await dialog.count(), 1, `${modifier}+Enter must not resolve approval`)
        await dialog.press(`${modifier}+Escape`)
        assert.equal(await dialog.count(), 1, `${modifier}+Escape must not resolve approval`)
      }
      const allowButton = page.getByRole('button', { name: '允许本次访问' })
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
      await page.getByRole('button', { name: '允许本次访问' }).waitFor({ state: 'visible' })
      assert.equal(await page.getByRole('button', { name: '允许本次访问' }).isEnabled(), true)
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
      await openApproval(
        page,
        new URL('/components/browser-approval.render.fixture.html', url).href
      )
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
