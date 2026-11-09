import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

test('browser settings remain reachable without a settings sidebar entry', async () => {
  await fixture(async (page) => {
    await expect(page.getByTestId('account-settings-shell')).toBeVisible()
    await expect(page.getByTestId('account-settings-nav-browser')).toHaveCount(0)
    await expect(page.getByTestId('account-settings-nav-notifications')).toBeVisible()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
  }, '?store')
})

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const row = (title: string) => ({
  id: '12345678-1234-1234-1234-123456789abc',
  title,
  url: 'https://example.org/paper',
  visitedAt: 1,
})
async function resolveQuery(page: Page, index: number, title: string, total = 1) {
  await page.evaluate(
    ({ index, title, total, visit }) => {
      const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
      host.historyResolve(index, {
        ok: true,
        page: { items: title ? [{ ...visit, title }] : [], total },
      })
    },
    { index, title, total, visit: row(title) }
  )
}
async function count(page: Page, expected: number) {
  await page
    .waitForFunction(
      (expected) =>
        (window as unknown as { historyRequests: unknown[] }).historyRequests.length === expected,
      expected,
      { timeout: 10_000 }
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        requests: (window as unknown as { historyRequests: unknown[] }).historyRequests,
        body: document.body.innerText,
      }))
      throw Object.assign(
        new Error(`Expected ${expected} history requests: ${JSON.stringify(state)}`),
        { cause: error }
      )
    })
}
async function fixture(run: (page: Page) => Promise<void>, mode = '') {
  const baseline = process.env.T6A_HISTORY_BASELINE
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [
      ...(baseline
        ? [
            {
              name: 'exact-before-settings',
              enforce: 'pre' as const,
              load(id: string) {
                if (id === path.join(ROOT, 'features/browser/Settings.tsx'))
                  return readFileSync(baseline, 'utf8')
              },
            },
          ]
        : []),
      react(),
    ],
    cacheKey: `browser-history-${baseline ? 'before' : 'current'}`,
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(
      new URL(`/features/browser/history.render.fixture.html${mode}`, server.resolvedUrls!.local[0])
        .href
    )
    await count(page, 1)
    await run(page)
  } finally {
    await browser.close()
    await server.close()
  }
}

test(
  'history section replaces overview with shared search, results and a return action',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Overview visit')
      await page.getByRole('button', { name: 'Switch section' }).click()
      await count(page, 2)
      await expect(page.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible()
      await expect(page.getByTestId('browser-settings-cdp')).toHaveCount(0)
      await expect(page.getByTestId('browser-settings-history')).toHaveCount(1)
      await resolveQuery(page, 1, 'History visit')
      await expect(page.getByText('History visit')).toBeVisible()
      await page.getByRole('button', { name: '返回浏览器设置' }).click()
      await expect(page.getByTestId('browser-settings-cdp')).toBeVisible()
    })
)

test(
  'clear success preserves search, corrects the last page and shares the mutation slot',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Initial', 41)
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered', 41)
      await page.getByRole('button', { name: '第 3 页', exact: true }).click()
      await count(page, 3)
      await resolveQuery(page, 2, 'Last page', 41)
      await page
        .getByTestId('browser-settings-data')
        .getByRole('button', { name: '清除', exact: true })
        .click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
      await expect(page.getByRole('button', { name: '删除记录' })).toBeDisabled()
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: true })
      )
      await count(page, 4)
      await resolveQuery(page, 3, '', 0)
      await count(page, 5)
      await resolveQuery(page, 4, '', 0)
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      const query = await page.evaluate(
        () =>
          (
            window as unknown as {
              historyRequests: { query: { offset: number; search: string } }[]
            }
          ).historyRequests.at(-1)!.query
      )
      assert.deepEqual(
        { offset: query.offset, search: query.search },
        { offset: 0, search: 'paper' }
      )
      await expect(page.getByText('浏览数据已清除。')).toBeVisible()
    })
)

test(
  'history pending blocks clear and stale section reopen cannot navigate',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('button', { name: '重新打开' }).click()
      await count(page, 2)
      await expect(
        page.getByTestId('browser-settings-data').getByRole('button', { name: '清除', exact: true })
      ).toBeDisabled()
      await page.getByRole('button', { name: 'Switch section' }).click()
      await expect(page.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible()
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length
        ),
        2
      )
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(1, { ok: true })
      )
      await count(page, 3)
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
    })
)

test(
  'synchronous close retirement rejects results before React cleanup',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.evaluate(() => {
        const host = window as unknown as {
          historyRetire(): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyRetire()
        host.historyResolve(0, {
          ok: true,
          page: {
            items: [
              { id: 'old', url: 'https://old.test', title: 'Forbidden late query', visitedAt: 1 },
            ],
            total: 1,
          },
        })
      })
      await expect(page.getByText('Forbidden late query')).toHaveCount(0)
    })
)

test(
  'clear generation rejects pre-cleanup old total without resetting the selected page',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Initial', 41)
      await page.getByRole('button', { name: '第 3 页', exact: true }).click()
      await count(page, 2)
      await page
        .getByTestId('browser-settings-data')
        .getByRole('button', { name: '清除', exact: true })
        .click()
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="alertdialog"]')!
        const action = [...dialog.querySelectorAll('button')].find(
          (element) => element.textContent === '清除'
        )!
        action.click()
        const host = window as unknown as {
          historyClearResolve(index: number, reply: unknown): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyClearResolve(0, { ok: true, deleted: 0 })
        queueMicrotask(() => host.historyResolve(1, { ok: true, page: { items: [], total: 0 } }))
      })
      await count(page, 3)
      const query = await page.evaluate(
        () =>
          (
            window as unknown as { historyRequests: { query: { offset: number } }[] }
          ).historyRequests.at(-1)!.query
      )
      assert.equal(query.offset, 40)
      await resolveQuery(page, 2, 'Current page', 41)
      await expect(page.getByText('Current page')).toBeVisible()
    })
)

test(
  'clear failure keeps the filter, rereads without success and does not fabricate deletion',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered visit')
      await page
        .getByTestId('browser-settings-data')
        .getByRole('button', { name: '清除', exact: true })
        .click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: false, error: 'operation_failed' })
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'Still saved')
      await expect(page.getByText('Still saved')).toBeVisible()
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      await expect(page.getByText('浏览数据已清除。')).toHaveCount(0)
      await expect(page.getByTestId('browser-settings-data').getByRole('alert')).toBeVisible()
    })
)

test(
  'delete and reopen synchronously refuse duplicate clicks before disabled render',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.evaluate(() => {
        const button = [
          ...document.querySelectorAll('[data-testid="browser-settings-history"] button'),
        ].find((element) => element.textContent === '删除记录') as HTMLButtonElement
        button.click()
        button.click()
      })
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(1, { ok: true, deleted: true })
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'Another visit')
      await page.evaluate(() => {
        const button = [
          ...document.querySelectorAll('[data-testid="browser-settings-history"] button'),
        ].find((element) => element.textContent === '重新打开') as HTMLButtonElement
        button.click()
        button.click()
      })
      await count(page, 4)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(3, { ok: true })
      )
      await expect(page.getByTestId('reopened-count')).toHaveText('1')
    })
)

test(
  'close intent rejects a mounted reopen before React commits and cannot affect a new settings instance',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('button', { name: '重新打开' }).click()
      await count(page, 2)
      await page.evaluate(() => {
        const host = window as unknown as {
          historyRetire(): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyRetire()
        host.historyResolve(1, { ok: true })
      })
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
      await page.evaluate(() => (window as unknown as { historyClose(): void }).historyClose())
      await expect(page.getByTestId('account-settings-browser')).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { historyOpen(): void }).historyOpen())
      // The retired reopen cannot trigger a reread; only the new instance queries again.
      await count(page, 3)
      await resolveQuery(page, 2, 'New instance')
      await expect(page.getByText('New instance')).toBeVisible()
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
    })
)

test(
  'late clear failure cannot write to a newly mounted settings instance',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page
        .getByTestId('browser-settings-data')
        .getByRole('button', { name: '清除', exact: true })
        .click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
      await page.evaluate(() => (window as unknown as { historyClose(): void }).historyClose())
      await expect(page.getByTestId('account-settings-browser')).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { historyOpen(): void }).historyOpen())
      await count(page, 2)
      await resolveQuery(page, 1, 'New instance')
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: false, error: 'operation_failed' })
      )
      await expect(page.getByTestId('browser-settings-data').getByRole('alert')).toHaveCount(0)
      await expect(page.getByText('New instance')).toBeVisible()
    })
)

test(
  'real StoreProvider and AccountPanel reject close-before-render reopen and preserve one normal callback',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Actual AccountPanel visit')
      await page.getByRole('button', { name: '重新打开', exact: true }).click()
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyStoreCloseAndResolve(index: number): void }
        ).historyStoreCloseAndResolve(1)
      )
      await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
      await expect(page.getByTestId('store-view')).toHaveText('home')
      await expect(page.getByTestId('store-close-count')).toHaveText('0')
      await page.evaluate(() =>
        (window as unknown as { historyStoreOpen(section: string): void }).historyStoreOpen(
          'history'
        )
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'New actual host')
      await page.getByRole('button', { name: '重新打开', exact: true }).click()
      await count(page, 4)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(3, { ok: true })
      )
      await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
      await expect(page.getByTestId('store-view')).toHaveText('browser')
      await expect(page.getByTestId('store-close-count')).toHaveText('1')
    }, '?store')
)

test(
  'actual Store settings intents retire before commit, normalize direct patches and retain batched identity',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const results = await page.evaluate(() => {
        const host = window as unknown as {
          historyStoreCapture(): void
          historyStoreIsCapturedCurrent(): boolean
          historyStoreOpen(section?: string): void
          historyStoreClose(): void
          historyStorePatch(patch: object): void
        }
        host.historyStoreCapture()
        host.historyStoreOpen()
        const same = host.historyStoreIsCapturedCurrent()
        host.historyStoreOpen('history')
        const retired = host.historyStoreIsCapturedCurrent()
        host.historyStoreOpen('overview')
        const returned = host.historyStoreIsCapturedCurrent()
        host.historyStorePatch({ browserSettingsSection: 'downloads' })
        return { same, retired, returned }
      })
      assert.deepEqual(results, { same: true, retired: false, returned: false })
      await expect(page.getByTestId('store-section')).toHaveText('overview')
      await page.evaluate(() =>
        (window as unknown as { historyStorePatch(patch: object): void }).historyStorePatch({
          accountSettingsPage: 'models',
          browserSettingsSection: 'history',
        })
      )
      await expect(page.getByTestId('store-section')).toHaveText('null')
      await page.evaluate(() =>
        (window as unknown as { historyStoreOpen(section: string): void }).historyStoreOpen(
          'history'
        )
      )
      await expect(page.getByTestId('store-section')).toHaveText('history')
      await page.evaluate(() =>
        (window as unknown as { historyStoreClose(): void }).historyStoreClose()
      )
      await expect(page.getByTestId('store-section')).toHaveText('null')
    }, '?store')
)

test(
  'real AccountPanel close-open batched roundtrip rejects the old reopen lease',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Actual visit')
      await page.getByRole('button', { name: '重新打开', exact: true }).click()
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyStoreRoundtripAndResolve(index: number): void }
        ).historyStoreRoundtripAndResolve(1)
      )
      await expect(page.getByTestId('account-settings-shell')).toBeVisible()
      await expect(page.getByTestId('store-view')).toHaveText('home')
      await expect(page.getByTestId('store-close-count')).toHaveText('0')
    }, '?store')
)

test(
  'actual settings navigation leaves composer-only patches isolated and functional section patches authoritative',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered visit')
      const result = await page.evaluate(() => {
        const host = window as unknown as {
          historyStorePatch(
            patch: object | ((state: { browserSettingsSection: string }) => object)
          ): void
          historyStoreCapture(): void
          historyStoreIsCapturedCurrent(): boolean
          historyStoreDraft(): string
        }
        host.historyStoreCapture()
        host.historyStorePatch({ composerText: 'isolated draft' })
        return { current: host.historyStoreIsCapturedCurrent() }
      })
      assert.equal(result.current, true)
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { historyStoreDraft(): string }).historyStoreDraft()
          )
        )
        .toBe('isolated draft')
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length
        ),
        2
      )
      await page.evaluate(() => {
        const host = window as unknown as {
          historyStorePatch(patch: (state: { browserSettingsSection: string }) => object): void
        }
        host.historyStorePatch(() => ({ browserSettingsSection: 'history' }))
        host.historyStorePatch((state) => ({
          browserSettingsSection:
            state.browserSettingsSection === 'history' ? 'overview' : 'history',
        }))
      })
      await expect(page.getByTestId('store-section')).toHaveText('overview')
    }, '?store')
)

test(
  'section retirement does not resurrect an earlier clear confirmation on return',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page
        .getByTestId('browser-settings-data')
        .getByRole('button', { name: '清除', exact: true })
        .click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.evaluate(() =>
        (window as unknown as { historyNavigate(section: string): void }).historyNavigate('history')
      )
      await expect(page.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '返回浏览器设置' }).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
    })
)

test(
  'invalid history bridge replies retain the operation failure state',
  { timeout: 60_000 },
  async () => {
    for (const reply of [null, undefined]) {
      await fixture(async (page) => {
        await page.evaluate((value) => {
          const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
          host.historyResolve(0, value)
        }, reply)
        const history = page.getByTestId('browser-settings-history')
        await expect(history.getByRole('alert')).toBeVisible()
        await expect(history.getByRole('status')).toHaveCount(0)
        await count(page, 1)
      })
    }
  }
)
