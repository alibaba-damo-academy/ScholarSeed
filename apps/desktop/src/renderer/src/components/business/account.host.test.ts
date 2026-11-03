import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { before, after } from 'node:test'
import { expect } from '@playwright/test'
import type { ViteDevServer } from 'vite'
import type { AccountMenuView, MenuDismissReason, MenuModel } from '../../../../menu'
import { renderFixture } from '../../../../test-helpers/render.ts'

interface AccountHostTestWindow extends Window {
  accountHostModels: Array<MenuModel & { account: AccountMenuView }>
  accountHostLog: string[]
  accountHostSeeds: Array<() => void>
  accountHostOpen: boolean
  revokeAccount: (reason: MenuDismissReason) => void
  seedAccount: (index?: number) => void
  paintAccount: (index?: number) => void
  accountAction: (actionId: string) => void
  changeAccountIdentity: () => void
  reopenAccount: () => void
  updateAccountView: (value: { busy: boolean; error: string; lang: 'en' | 'zh' }) => void
  finishLogout: () => void
  disposeAccount: () => void
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE_TIMEOUT_MS = 60_000
let fixture: Awaited<ReturnType<typeof renderFixture>>
let server: ViteDevServer
before(
  async () => {
    fixture = await renderFixture(ROOT)
    server = fixture.server
  },
  { timeout: FIXTURE_TIMEOUT_MS }
)
after(
  async () => {
    await fixture?.close()
  },
  { timeout: FIXTURE_TIMEOUT_MS }
)

for (const variation of [
  'unavailable',
  'presentationerror',
  'native&failed',
  'native&timeout',
  'native&crash',
])
  test(
    `account failure ${variation} is visible and dismissible`,
    { timeout: 60_000 },
    async (context) => {
      const page = await fixture.page(context)
      const diagnostics: string[] = []
      page.on('console', (message) => {
        if (message.text().startsWith('[account-menu]')) diagnostics.push(message.text())
      })
      await page.goto(
        new URL(
          `/components/business/account.host.fixture.html?${variation}`,
          server.resolvedUrls!.local[0]
        ).href
      )
      if (variation.includes('timeout') || variation.includes('crash')) {
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as AccountHostTestWindow).accountHostModels.length
            )
          )
          .toBe(1)
        await page.evaluate(
          (reason: 'timeout' | 'crash') =>
            (window as unknown as AccountHostTestWindow).revokeAccount(reason),
          variation.includes('timeout') ? ('timeout' as const) : ('crash' as const)
        )
      }
      const failure = page.getByRole('alert')
      await expect(failure).toBeVisible()
      await expect(failure).toContainText('账户菜单未能打开，请重试。')
      assert.equal(
        await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
        false
      )
      assert.ok(diagnostics.length > 0)
      assert.equal(diagnostics.join('').includes('private'), false)
      await failure.getByRole('button').click()
      await expect(failure).toHaveCount(0)
      if (
        variation.includes('failed') ||
        variation === 'unavailable' ||
        variation === 'presentationerror'
      ) {
        await page.getByRole('button', { name: 'Account', exact: true }).click()
        await expect(page.getByRole('alert')).toBeVisible()
        await expect(page.getByRole('alert')).toHaveCount(1)
      }
    }
  )

for (const reason of ['escape', 'blur'])
  test(
    `ordinary host ${reason} closes with correct focus ownership`,
    { timeout: 60_000 },
    async (context) => {
      const page = await fixture.page(context)
      await page.goto(
        new URL('/components/business/account.host.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.getByTestId('account-menu')).toBeVisible()
      assert.equal(
        await page.getByTestId('account-menu').getAttribute('id'),
        await page
          .getByRole('button', { name: 'Account', exact: true })
          .getAttribute('aria-controls')
      )
      await page.getByTestId('account-menu-settings').focus()
      if (reason === 'escape') await page.keyboard.press('Escape')
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expect(page.getByTestId('account-menu')).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      if (reason === 'escape')
        await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused()
      else
        assert.notEqual(
          await page
            .getByRole('button', { name: 'Account', exact: true })
            .evaluate((element) => element === document.activeElement),
          true
        )
    }
  )

for (const variation of ['native', 'native&failed'])
  test(
    `account host ${variation} never falls back to a webpage-covered DOM menu`,
    { timeout: 60_000 },
    async (context) => {
      const page = await fixture.page(context)
      await page.goto(
        new URL(
          `/components/business/account.host.fixture.html?${variation}`,
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible()
      if (variation.includes('failed')) {
        await expect(page.getByRole('alert')).toHaveText(/账户菜单未能打开，请重试。/)
        await expect(page.getByRole('alert')).toBeVisible()
        assert.equal(
          await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
          false
        )
      } else {
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as AccountHostTestWindow).accountHostModels.length
            )
          )
          .toBe(1)
        const serialized = await page.evaluate(() =>
          JSON.stringify((window as unknown as AccountHostTestWindow).accountHostModels)
        )
        for (const secret of ['private-user', 'private@example', '13812348001', 'https://private'])
          assert.equal(serialized.includes(secret), false)
        await page.evaluate(() =>
          (window as unknown as AccountHostTestWindow).accountAction('account.settings')
        )
        assert.equal(
          await page.evaluate(() =>
            (window as unknown as AccountHostTestWindow).accountHostLog.includes('settings')
          ),
          false
        )
        await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
        await page.evaluate(() =>
          (window as unknown as AccountHostTestWindow).accountAction('account.settings')
        )
        await expect
          .poll(() =>
            page.evaluate(() =>
              (window as unknown as AccountHostTestWindow).accountHostLog.includes('settings')
            )
          )
          .toBe(true)
        const log: string[] = await page.evaluate(
          () => (window as unknown as AccountHostTestWindow).accountHostLog
        )
        assert.ok(log.indexOf('dismiss:action') < log.indexOf('settings'))
      }
      await expect(page.getByTestId('account-menu')).toHaveCount(0)
    }
  )

test(
  'ordinary host retains logout error and closes dirty-language menu before confirmation',
  { timeout: 60_000 },
  async (context) => {
    const page = await fixture.page(context)
    await page.goto(
      new URL('/components/business/account.host.fixture.html?dirty', server.resolvedUrls!.local[0])
        .href
    )
    await expect(page.getByTestId('account-menu')).toBeVisible()
    await page.getByTestId('account-menu-logout').click()
    await expect(page.getByTestId('account-menu-logout')).toBeDisabled()
    assert.equal(
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
      true
    )
    await page.evaluate(() => (window as unknown as AccountHostTestWindow).finishLogout())
    await expect(page.getByRole('alert')).toHaveText('退出失败，请重试')
    await page.getByTestId('account-menu-language').click()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
    await expect(page.getByTestId('account-menu')).toHaveCount(0)
    const log: string[] = await page.evaluate(
      () => (window as unknown as AccountHostTestWindow).accountHostLog
    )
    assert.ok(log.indexOf('close') < log.indexOf('language-confirmation'))
  }
)

test(
  'identity replacement revokes an open host instead of reopening against the new account',
  { timeout: 60_000 },
  async (context) => {
    const page = await fixture.page(context)
    await page.goto(
      new URL('/components/business/account.host.fixture.html', server.resolvedUrls!.local[0]).href
    )
    await expect(page.getByTestId('account-menu')).toBeVisible()
    await page.evaluate(() => (window as unknown as AccountHostTestWindow).changeAccountIdentity())
    await expect(page.getByTestId('account-menu')).toHaveCount(0)
    assert.equal(
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
      false
    )
  }
)

test(
  'native host projects logout failure received before its first paint ACK',
  { timeout: 60_000 },
  async (context) => {
    const page = await fixture.page(context)
    await page.goto(
      new URL(
        '/components/business/account.host.fixture.html?native',
        server.resolvedUrls!.local[0]
      ).href
    )
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostModels.length)
      )
      .toBe(1)
    await page.evaluate(async () => {
      ;(window as unknown as AccountHostTestWindow).finishLogout()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as AccountHostTestWindow).accountHostModels.at(-1)!.account
              .logoutError
        )
      )
      .toBe('退出失败，请重试')
    assert.equal(
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
      true
    )
  }
)

for (const deferred of ['paint', 'seed'])
  test(
    `native host coalesces latest view and theme during deferred ${deferred}`,
    { timeout: 60_000 },
    async (context) => {
      const page = await fixture.page(context)
      let settleCredits: () => Promise<void> = async () => undefined
      await page.route(
        '**/api/account/credits',
        (route) =>
          new Promise<void>((resolve) => {
            settleCredits = async () => {
              await route.fulfill({ json: { balance_credits: 73, unlimited: false } })
              resolve()
            }
          })
      )
      await page.goto(
        new URL(
          `/components/business/account.host.fixture.html?native&credits${deferred === 'seed' ? '&deferredseed' : ''}`,
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as AccountHostTestWindow)[
                window.location.search.includes('deferredseed')
                  ? 'accountHostSeeds'
                  : 'accountHostModels'
              ].length
          )
        )
        .toBe(1)
      await settleCredits()
      await page.evaluate(async () => {
        ;(window as unknown as AccountHostTestWindow).updateAccountView({
          busy: true,
          error: 'latest failure',
          lang: 'en',
        })
        document.documentElement.dataset.theme = 'dark'
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      if (deferred === 'seed') {
        await page.evaluate(() => (window as unknown as AccountHostTestWindow).seedAccount())
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as AccountHostTestWindow).accountHostModels.length
            )
          )
          .toBe(1)
      }
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount(0))
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as AccountHostTestWindow).accountHostModels.at(-1)!.account
                .logoutBusy
          )
        )
        .toBe(true)
      const model = await page.evaluate(() =>
        (window as unknown as AccountHostTestWindow).accountHostModels.at(-1)
      )
      assert.ok(model)
      assert.deepEqual(model.account.credits, { phase: 'ready', value: 73, unlimited: false })
      assert.equal(model.account.logoutError, 'latest failure')
      assert.equal(model.account.locale, 'en')
      assert.equal(model.language, 'en')
      assert.equal(model.theme, 'dark')
      const pendingCount = await page.evaluate(
        () => (window as unknown as AccountHostTestWindow).accountHostModels.length
      )
      await page.evaluate(async () => {
        ;(window as unknown as AccountHostTestWindow).finishLogout()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      assert.equal(
        await page.evaluate(
          () => (window as unknown as AccountHostTestWindow).accountHostModels.length
        ),
        pendingCount
      )
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as AccountHostTestWindow).accountHostModels.at(-1)!.account
                .logoutBusy
          )
        )
        .toBe(false)
      await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
      await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      assert.equal(
        await page.evaluate(
          () => (window as unknown as AccountHostTestWindow).accountHostModels.length
        ),
        pendingCount + 1
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
        true
      )
    }
  )

for (const deferred of ['paint', 'seed', 'update'])
  for (const invalidation of ['replace', 'dispose'])
    test(
      `native host ignores deferred ${deferred} after lease ${invalidation}`,
      { timeout: 60_000 },
      async (context) => {
        const page = await fixture.page(context)
        await page.goto(
          new URL(
            `/components/business/account.host.fixture.html?native${deferred === 'seed' ? '&deferredseed' : ''}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as AccountHostTestWindow)[
                  window.location.search.includes('deferredseed')
                    ? 'accountHostSeeds'
                    : 'accountHostModels'
                ].length
            )
          )
          .toBe(1)
        if (deferred === 'update') {
          await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
          await page.evaluate(() =>
            (window as unknown as AccountHostTestWindow).updateAccountView({
              busy: true,
              error: '',
              lang: 'zh',
            })
          )
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as unknown as AccountHostTestWindow).accountHostModels.length
              )
            )
            .toBe(2)
        }
        await page.evaluate(async () => {
          ;(window as unknown as AccountHostTestWindow).finishLogout()
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
        })
        if (invalidation === 'dispose')
          await page.evaluate(() => (window as unknown as AccountHostTestWindow).disposeAccount())
        else {
          await page.evaluate(() =>
            (window as unknown as AccountHostTestWindow).changeAccountIdentity()
          )
          await expect
            .poll(() =>
              page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen)
            )
            .toBe(false)
          await page.evaluate(() => (window as unknown as AccountHostTestWindow).reopenAccount())
          if (deferred === 'seed') {
            await expect
              .poll(() =>
                page.evaluate(
                  () => (window as unknown as AccountHostTestWindow).accountHostSeeds.length
                )
              )
              .toBe(2)
            await page.evaluate(() => (window as unknown as AccountHostTestWindow).seedAccount(1))
          }
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as unknown as AccountHostTestWindow).accountHostModels.length
              )
            )
            .toBe(deferred === 'seed' ? 1 : deferred === 'update' ? 3 : 2)
          await page.evaluate(() => (window as unknown as AccountHostTestWindow).paintAccount())
        }
        const count = await page.evaluate(
          () => (window as unknown as AccountHostTestWindow).accountHostModels.length
        )
        await page.evaluate(
          async (pendingIndex) => {
            if (window.location.search.includes('deferredseed'))
              (window as unknown as AccountHostTestWindow).seedAccount(0)
            else (window as unknown as AccountHostTestWindow).paintAccount(pendingIndex)
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            )
          },
          deferred === 'update' ? 1 : 0
        )
        assert.equal(
          await page.evaluate(
            () => (window as unknown as AccountHostTestWindow).accountHostModels.length
          ),
          count
        )
        if (invalidation === 'replace')
          assert.equal(
            await page.evaluate(() => (window as unknown as AccountHostTestWindow).accountHostOpen),
            true
          )
      }
    )
