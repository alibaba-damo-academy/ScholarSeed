import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { Dispatch, SetStateAction } from 'react'
import type { AccountMenuView, MenuValue } from '../../../../menu'

interface AccountRenderTestWindow extends Window {
  setAccountView: Dispatch<SetStateAction<AccountMenuView>>
  accountActions: Array<{ action: string; value: MenuValue }>
  accountClosed: boolean
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'account feedback displays the platform shortcut in both languages',
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
      for (const platform of [
        { userAgent: 'Macintosh; Intel Mac OS X', shortcut: '⌘+⌥+F' },
        { userAgent: 'Windows NT 10.0; Win64; x64', shortcut: 'Ctrl+Alt+F' },
      ]) {
        const page = await browser.newPage({ userAgent: platform.userAgent })
        await page.goto(
          new URL('/components/business/account.render.fixture.html', server.resolvedUrls!.local[0])
            .href
        )
        await page.evaluate(() =>
          (window as unknown as AccountRenderTestWindow).setAccountView((view) => ({
            ...view,
            availableActions: [...view.availableActions, 'account.feedback'],
          }))
        )
        const feedback = page.getByTestId('account-menu-feedback')
        await expect(feedback).toContainText('问题反馈')
        await expect(feedback.locator('.vds-menu__shortcut')).toHaveText(platform.shortcut)
        await page.evaluate(() =>
          (window as unknown as AccountRenderTestWindow).setAccountView((view) => ({
            ...view,
            locale: 'en',
          }))
        )
        await expect(feedback).toContainText('Report a problem')
        await expect(feedback.locator('.vds-menu__shortcut')).toHaveText(platform.shortcut)
        await feedback.click()
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as AccountRenderTestWindow).accountActions),
          [{ action: 'account.feedback', value: { kind: 'none' } }]
        )
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'logout busy disables every action including language submenu',
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
        new URL('/components/business/account.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.getByTestId('account-menu-language')).toBeVisible()
      await page.evaluate(() =>
        (window as unknown as AccountRenderTestWindow).setAccountView((view) => ({
          ...view,
          logoutBusy: true,
        }))
      )
      await expect(page.getByTestId('account-menu-language')).toBeDisabled()
      await expect(page.getByTestId('account-menu-settings')).toBeDisabled()
      await expect(page.getByTestId('account-menu-logout')).toBeDisabled()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as AccountRenderTestWindow).accountActions),
        []
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'account_panel_has_no_business_fetch, credit_error_is_not_zero_balance and logout_failure_keeps_error',
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
      const businessRequests: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('/api/')) businessRequests.push(request.url())
      })
      await page.goto(
        new URL('/components/business/account.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.getByRole('menuitem', { name: '剩余积分' })).toBeVisible({ timeout: 2500 })
      await expect(page.getByTestId('account-menu-credits-value')).toHaveText('--')
      await page.evaluate(() =>
        (window as unknown as AccountRenderTestWindow).setAccountView((view) => ({
          ...view,
          credits: { phase: 'ready', value: 0, unlimited: false },
          logoutError: '退出失败，请重试',
        }))
      )
      await expect(page.getByTestId('account-menu-credits-value')).toHaveText('0')
      await expect(page.getByRole('alert')).toHaveText('退出失败，请重试')
      await page.getByRole('menuitem', { name: '退出登录' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      assert.deepEqual(businessRequests, [])
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as AccountRenderTestWindow).accountActions),
        [{ action: 'account.logout', value: { kind: 'none' } }]
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'language_submenu_escape uses real Menu semantics and preserves the root on selection',
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
        new URL('/components/business/account.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      const language = page.getByRole('menuitem', { name: /语言/ })
      await expect(language).toBeVisible({ timeout: 2500 })
      await language.focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitemradio', { name: '简体中文' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(language).toBeFocused()
      assert.equal(
        await page.evaluate(() => (window as unknown as AccountRenderTestWindow).accountClosed),
        false
      )
      await page.keyboard.press('ArrowRight')
      await page.getByRole('menuitemradio', { name: 'English' }).click()
      await expect(page.getByRole('menuitem', { name: /Language/ })).toBeVisible()
      assert.equal(
        await page.evaluate(() => (window as unknown as AccountRenderTestWindow).accountClosed),
        false
      )
      await page.getByRole('menuitem', { name: /Language/ }).focus()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
