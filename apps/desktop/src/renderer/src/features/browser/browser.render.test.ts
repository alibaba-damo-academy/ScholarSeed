import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'

import type { BrowserCommand } from '../../../../browser.ts'
import type { BrowserOverlayModel } from '../../../../overlay'
import browserZh from '../../../../localization/locales/zh/browser.json' with { type: 'json' }
import browserEn from '../../../../localization/locales/en/browser.json' with { type: 'json' }
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

for (const mode of ['pending', 'failed'] as const) {
  test(
    'browser initial snapshot preserves guidance and current failure recovery: ' + mode,
    { timeout: 60_000 },
    async () => {
      const server = await servers.create({
        cacheKey: 'browser',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      let browser
      try {
        browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
        const page = await browser.newPage()
        const diagnostics: string[] = []
        page.on('console', (message) => {
          if (message.text().startsWith('[browser-failure]')) diagnostics.push(message.text())
        })
        await page.goto(
          new URL(
            '/features/browser/browser.render.fixture.html?snapshot-read=' + mode,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as { snapshotReadCount: number }).snapshotReadCount
            )
          )
          .toBe(1)
        const workspace = page.getByTestId('browser-workspace')
        const address = workspace.getByRole('textbox', { name: browserZh.address, exact: true })
        await expect(page.getByTestId('browser-start-page')).toBeVisible()
        await expect(workspace.getByRole('tablist')).toHaveCount(0)
        await expect(
          workspace.getByRole('button', { name: browserZh.newTabAction, exact: true })
        ).toHaveCount(0)
        if (mode === 'pending') {
          await expect(address).toHaveValue('')
          await page.evaluate(() =>
            (window as unknown as { finishBrowserSnapshot(): void }).finishBrowserSnapshot()
          )
          await expect(address).toHaveValue('https://example.com/')
          await expect(workspace.getByRole('tablist')).toHaveCount(0)
        } else {
          assert.ok(diagnostics.some((line) => line.includes('"source":"snapshot"')))
          await expect(address).toHaveAttribute('aria-invalid', 'true')
          await expect(
            page.getByText(browserZh.errors.operation_failed, { exact: true })
          ).toBeVisible()
          await page.reload()
          await expect(address).toHaveAttribute('aria-invalid', 'true')
          await expect(
            page.getByText(browserZh.errors.operation_failed, { exact: true })
          ).toBeVisible()
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as unknown as { snapshotReadCount: number }).snapshotReadCount
              )
            )
            .toBe(1)
        }
      } finally {
        try {
          await browser?.close()
        } finally {
          await server.close()
        }
      }
    }
  )
}

test(
  'browser settings hide the advanced entry by default in both languages',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser')
      await expect(settings.getByTestId('browser-history-management')).toBeVisible()
      await expect(settings.getByTestId('browser-settings-downloads')).toBeVisible()
      await expect(settings.getByText(browserZh.settings.advanced, { exact: true })).toHaveCount(0)
      await expect(settings.getByTestId('browser-settings-advanced')).toHaveCount(0)
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'policyRequests')), [])
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await expect(settings.getByRole('heading', { name: browserEn.settings.title })).toBeVisible()
      await expect(settings.getByText(browserEn.settings.advanced, { exact: true })).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings overview follows grouped design without removing download or advanced controls',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1040, height: 660 } })
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&advanced',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser')
      await expect(settings.getByRole('heading', { name: '常规', exact: true })).toBeVisible()
      await expect(settings.getByRole('heading', { name: '下载', exact: true })).toBeVisible()
      await expect(settings.getByRole('heading', { name: '下载', exact: true })).toHaveCSS(
        'line-height',
        '20px'
      )
      await expect(
        settings.getByText('管理内置浏览器的历史、网站数据和自动化访问。', { exact: true })
      ).toHaveCount(0)
      await expect(settings.getByRole('heading', { name: '浏览器设置', exact: true })).toHaveCSS(
        'font-size',
        '16px'
      )
      await expect(settings.locator('[data-slot="page-body"]')).toHaveCSS('row-gap', '20px')
      const history = settings.getByTestId('browser-history-management')
      await expect(history).toHaveCSS('border-radius', '8px')
      await expect(history.getByText('查看和管理在内置浏览器中访问过的页面')).toHaveCSS(
        'font-size',
        '12px'
      )
      await expect(history.getByText('查看和管理在内置浏览器中访问过的页面')).toHaveCSS(
        'color',
        'rgb(146, 146, 146)'
      )
      await expect(history.getByRole('button', { name: '管理', exact: true })).toHaveCSS(
        'height',
        '28px'
      )
      const downloads = settings.getByTestId('browser-settings-downloads')
      await expect(history.getByRole('button', { name: '管理', exact: true })).toHaveCSS(
        'font-size',
        '12px'
      )
      await expect(history.getByRole('button', { name: '管理', exact: true })).toHaveCSS(
        'line-height',
        '18px'
      )
      await expect(downloads).toHaveCSS('border-radius', '8px')
      await expect(downloads.getByTestId('browser-download-directory')).toHaveCSS(
        'font-size',
        '12px'
      )
      await expect(downloads.getByRole('switch', { name: '下载前询问保存位置' })).not.toBeChecked()
      await expect(
        settings.getByRole('heading', { name: 'Agent Browser Use', exact: true })
      ).toBeHidden()
      await settings.getByRole('button', { name: '高级设置', exact: true }).click()
      await expect(
        settings.getByRole('heading', { name: 'Agent Browser Use', exact: true })
      ).toHaveCount(0)
      await expect(
        settings.getByRole('switch', { name: 'Agent Browser Use', exact: true })
      ).toBeVisible()
      const advanced = settings.getByTestId('browser-settings-advanced')
      for (const card of await advanced.locator('.vds-card').all()) {
        await expect(card).toHaveCSS('border-top-width', '1px')
      }
      for (const title of await advanced.locator('.vds-card__title').all()) {
        await expect(title).toHaveCSS('font-size', '14px')
        await expect(title).toHaveCSS('font-weight', '400')
      }
      for (const control of await advanced.locator('.vds-input, .vds-select, .vds-button').all()) {
        await expect(control).toHaveCSS('height', '28px')
      }
      await settings.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await expect(settings.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(history).toHaveCSS('background-color', 'rgb(31, 31, 31)')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'operation failure toast projects above native pages without changing viewport and forwards pause and close',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const diagnostics: string[] = []
      page.on('console', (message) => {
        if (message.text().startsWith('[browser-failure]')) diagnostics.push(message.text())
      })
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?native-tooltip',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
      const viewport = page.locator('[data-browser-viewport]')
      const before = await viewport.boundingBox()
      assert.ok(before && before.height > 0)
      await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
      await page.waitForFunction(
        () => (window as unknown as { menuModels: unknown[] }).menuModels.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(false)
      )
      const toast = page.locator('.vds-toaster [role="alert"]')
      await expect(toast).toHaveText('浏览器操作失败，请重试。')
      assert.ok(diagnostics.some((line) => line.includes('"source":"menu"')))
      await page.locator('.vds-toaster').evaluate((element) => {
        const bounds = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        ;(element as HTMLElement).style.top = `${bounds.top}px`
      })
      await page.waitForFunction(() =>
        (window as unknown as { tooltipModels: { toast?: unknown }[] }).tooltipModels.some(
          (model) => model.toast
        )
      )
      await page.evaluate(() =>
        (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(true)
      )
      await expect(toast).toHaveCSS('opacity', '0')
      assert.deepEqual(await viewport.boundingBox(), before)
      const lastBounds = await page.evaluate(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands
          .filter((command) => command.kind === 'bounds')
          .at(-1)
      )
      assert.ok(lastBounds?.kind === 'bounds' && lastBounds.visible)
      await page.evaluate(() => {
        const fixture = window as unknown as {
          tooltipModels: { revision: number }[]
          emitTooltipEvent(event: unknown): void
        }
        fixture.emitTooltipEvent({
          kind: 'toast-hover',
          revision: fixture.tooltipModels.at(-1)!.revision,
          paused: true,
        })
      })
      await page.waitForTimeout(6100)
      await expect(toast).toHaveCount(1)
      await page.evaluate(() => {
        const fixture = window as unknown as {
          tooltipModels: { revision: number }[]
          emitTooltipEvent(event: unknown): void
        }
        fixture.emitTooltipEvent({
          kind: 'toast-close',
          revision: fixture.tooltipModels.at(-1)!.revision,
        })
      })
      await expect(toast).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'download settings show change, conditional reset and an initially disabled ask preference',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const downloads = page.getByTestId('browser-settings-downloads')
      await expect(downloads.getByTestId('browser-download-directory')).toHaveText('/downloads')
      const ask = downloads.getByRole('switch', { name: '下载前询问保存位置' })
      await expect(ask).not.toBeChecked()
      await expect(downloads.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0)
      await downloads.getByRole('button', { name: '更改', exact: true }).click()
      await expect(downloads.getByTestId('browser-download-directory')).toHaveText('/chosen')
      await downloads.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect(downloads.getByTestId('browser-download-directory')).toHaveText('/downloads')
      await expect(downloads.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0)
      await ask.click()
      await expect(ask).toBeChecked()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
async function openClearDialog(page: Page) {
  if (await page.getByRole('button', { name: '管理', exact: true }).count())
    await page.getByRole('button', { name: '管理', exact: true }).click()
  await page.getByRole('button', { name: '清除浏览数据', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('checkbox', { name: '浏览历史', exact: true })
    .check()
}

test(
  'external browser opening uses the committed URL without closing the embedded page',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      await expect(address).toHaveCSS('font-weight', '400')
      const longAddress = `https://example.com/${'long-path/'.repeat(80)}`
      await address.fill(longAddress)
      await address.blur()
      await expect(address).toHaveCSS('text-overflow', 'ellipsis')
      await expect(address).toHaveValue(longAddress)
      await address.focus()
      await expect(address).toHaveCSS('text-overflow', 'clip')
      await address.fill('unvisited.example')
      await page.getByRole('button', { name: '用外部浏览器打开', exact: true }).click()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { externalUrls: string[] }).externalUrls),
        ['https://example.com/']
      )
      await expect(page.getByTestId('browser-workspace')).toBeVisible()
      assert.equal(
        await page.evaluate(() =>
          (window as unknown as { commands: BrowserCommand[] }).commands.some(
            (command) => command.kind === 'close'
          )
        ),
        false
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser menu copies the active URL and opens data controls without clearing automatically',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const open = async (): Promise<void> => {
        await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
        await page.evaluate(() =>
          (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
        )
        await expect(
          page.getByRole('button', { name: '更多浏览器功能', exact: true })
        ).toHaveAttribute('aria-expanded', 'true')
      }
      await open()
      await page.evaluate(() =>
        (window as unknown as { menuAction(action: string): void }).menuAction('browser.copy')
      )
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { copiedAddresses: string[] }).copiedAddresses)
        )
        .toEqual(['https://example.com/'])
      await expect(page.getByRole('status').filter({ hasText: '复制成功' })).toBeVisible()
      await open()
      await page.evaluate(() =>
        (window as unknown as { menuAction(action: string): void }).menuAction('browser.data')
      )
      await expect(page.getByTestId('account-settings-browser-history')).toBeVisible()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { dataRequests: unknown[] }).dataRequests),
        []
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser uses history arrows without an inner tab bar or page creation controls',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      await expect(workspace.getByRole('textbox', { name: '网址', exact: true })).toHaveValue(
        'https://example.com/'
      )
      await expect(workspace.getByRole('tablist')).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: '打开新的标签页', exact: true })
      ).toHaveCount(0)
      await workspace.getByRole('button', { name: '后退', exact: true }).click()
      await workspace.getByRole('button', { name: '前进', exact: true }).click()
      await workspace.getByRole('button', { name: '刷新', exact: true }).click()
      const commands = await page.evaluate(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands.filter(
          (command) => command.kind !== 'bounds'
        )
      )
      assert.deepEqual(commands, [
        { kind: 'back', tabId: 'first' },
        { kind: 'forward', tabId: 'first' },
        { kind: 'reload', tabId: 'first' },
      ])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser tooltip buttons suppress native titles while preserving accessible names',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toHaveCount(0)
      for (const name of ['更多浏览器功能']) {
        const control = workspace.getByRole('button', { name, exact: true })
        await expect(control).toHaveAccessibleName(name)
        await expect(control).not.toHaveAttribute('title')
      }
      await expect(workspace.getByRole('button', { name: '刷新', exact: true })).toHaveAttribute(
        'title',
        '刷新'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'more tooltip stays inside narrow and wide viewport edges on hover and keyboard focus',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      const more = workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      const external = workspace.getByRole('button', { name: '用外部浏览器打开', exact: true })
      const tooltip = page.getByRole('tooltip')
      for (const width of [1280, 480]) {
        await page.setViewportSize({ width, height: 800 })
        for (const trigger of ['hover', 'keyboard']) {
          if (trigger === 'hover') await more.hover()
          else {
            await page.mouse.move(0, 0)
            await external.focus()
            await page.keyboard.press('Tab')
            await expect(more).toBeFocused()
          }
          await expect(tooltip).toHaveCount(1)
          await expect(tooltip).toHaveText('更多浏览器功能')
          await expect(more).toHaveAccessibleDescription('更多浏览器功能')
          await expect
            .poll(() =>
              tooltip.evaluate((element) => {
                const bounds = element.getBoundingClientRect()
                return (
                  bounds.left >= 0 &&
                  bounds.top >= 0 &&
                  bounds.right <= innerWidth &&
                  bounds.bottom <= innerHeight
                )
              })
            )
            .toBe(true)
          await more.blur()
          await page.mouse.move(0, 0)
          await expect(tooltip).toHaveCount(0)
        }
      }
      await more.click()
      await expect(more).toBeDisabled()
      await expect(more).toHaveAttribute('aria-busy', 'true')
      await expect(tooltip).toHaveCount(0)
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await more.hover()
      await more.focus()
      await expect(tooltip).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'compact toolbar shows errors and control status directly without a help button',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?native-tooltip',
          server.resolvedUrls!.local[0]
        ).href
      )
      const workspace = page.getByTestId('browser-workspace')
      const reload = workspace.getByRole('button', { name: '刷新', exact: true })
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toHaveCount(0)
      const viewport = workspace.getByTestId('browser-viewport')
      const address = workspace.getByRole('textbox', { name: '网址', exact: true })
      await expect(reload).toBeEnabled()
      const original = await viewport.boundingBox()
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ loading: true })
      )
      await expect(reload).toHaveCount(0)
      const stopLoading = workspace.getByRole('button', { name: '停止加载', exact: true })
      await expect(stopLoading).toBeEnabled()
      await stopLoading.press('Enter')
      assert.ok(
        await page.evaluate(() =>
          (window as unknown as { commands: BrowserCommand[] }).commands.some(
            (command) => command.kind === 'stop-loading' && command.tabId === 'first'
          )
        )
      )
      await expect(workspace.getByText('网页加载中', { exact: true })).toHaveCount(0)
      assert.deepEqual(await viewport.boundingBox(), original)
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ loading: false })
      )
      await expect(reload).toBeEnabled()
      await expect(workspace.getByRole('button', { name: '前往', exact: true })).toHaveCount(0)
      const spacing = await address.evaluate((element) => {
        const form = element.closest('form')!
        const bounds = form.getBoundingClientRect()
        const rect = element.getBoundingClientRect()
        return {
          top: rect.top - bounds.top,
          bottom: bounds.bottom - rect.bottom,
          after:
            document.querySelector('[data-browser-viewport]')!.getBoundingClientRect().top -
            bounds.bottom,
        }
      })
      assert.equal(spacing.top, spacing.bottom)
      assert.equal(spacing.after, 0)
      await expect(workspace.getByRole('alert')).toHaveCount(0)
      assert.deepEqual(await viewport.boundingBox(), original)
      await address.fill('bad:address')
      await address.press('Enter')
      await expect(workspace.getByRole('alert')).toHaveText('请输入有效的 HTTP 或 HTTPS 网址。')
      await expect(workspace.getByRole('alert')).toBeVisible()
      await expect(address).toHaveAccessibleDescription('请输入有效的 HTTP 或 HTTPS 网址。')
      const errorBounds = await workspace.getByRole('alert').boundingBox()
      const pageBounds = await viewport.boundingBox()
      assert.ok(errorBounds && pageBounds)
      assert.deepEqual(pageBounds, original)
      const errorContent = await workspace
        .getByTestId('browser-error-page')
        .locator('[data-variant="panel"]')
        .boundingBox()
      assert.ok(errorContent)
      assert.ok(
        Math.abs(errorContent.y + errorContent.height / 2 - pageBounds.y - pageBounds.height / 2) <
          1
      )
      await expect(
        workspace
          .getByTestId('browser-error-page')
          .getByRole('button', { name: '刷新', exact: true })
      ).toBeEnabled()
      await page.getByRole('button', { name: 'English', exact: true }).click()
      const englishAddress = workspace.getByRole('textbox', { name: 'Address', exact: true })
      await expect(workspace.getByRole('alert')).toHaveText('Enter a valid HTTP or HTTPS address.')
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ navigationError: null, cdpStatus: 'connected' })
      )
      await englishAddress.fill('https://example.org')
      await englishAddress.press('Enter')
      await expect(workspace.getByRole('status')).toHaveText(
        'This page is controlled by an external program'
      )
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ url: 'https://hello/', navigationError: 'navigation_failed' })
      )
      const errorPage = workspace.getByTestId('browser-error-page')
      await expect(errorPage).toBeVisible()
      await expect(errorPage.getByText('This site can’t be reached', { exact: true })).toBeVisible()
      await expect(
        errorPage.getByText(
          'Check for a typo in hello. If the address is correct, check your network connection and try again.',
          { exact: true }
        )
      ).toBeVisible()
      await page.getByRole('button', { name: '简体中文', exact: true }).click()
      await expect(errorPage.getByText('无法访问此网站', { exact: true })).toBeVisible()
      await expect(
        errorPage.getByText('请检查 hello 中是否有拼写错误。如果网址无误，请检查网络连接后重试。', {
          exact: true,
        })
      ).toBeVisible()
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: BrowserCommand[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === false
      )
      await errorPage.getByRole('button', { name: 'Reload page', exact: true }).click()
      await page.waitForFunction(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands.some(
          (command) => command.kind === 'reload'
        )
      )
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ navigationError: null, cdpStatus: 'devtools_conflict' })
      )
      await expect(workspace.getByRole('status')).toHaveText(
        'Developer tools now control this page. Close them before reconnecting automation.'
      )
      const more = workspace.getByRole('button', { name: 'More browser features', exact: true })
      await more.click()
      await expect(
        page.getByRole('tooltip').filter({ hasText: 'Developer tools now control' })
      ).toHaveCount(0)
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await expect(
        page.getByRole('tooltip').filter({ hasText: 'Developer tools now control' })
      ).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { menuFailure(): void }).menuFailure())
      await expect(page.locator('.vds-toaster').getByRole('alert')).toBeVisible()
      await expect(page.locator('.vds-toaster').getByRole('alert')).toContainText(
        'Browser operation failed. Please try again.'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'invalid tooltip paint revokes displayed and pending native models without late visual resurrection',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const displayed of [false, true]) {
        const page = await browser.newPage()
        await page.goto(
          new URL(
            '/features/browser/browser.render.fixture.html?native-tooltip',
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
        await page.evaluate(() =>
          (window as unknown as { setTooltipOpen(open: boolean): void }).setTooltipOpen(true)
        )
        const tooltip = page.getByRole('tooltip', { name: 'Animated browser tooltip' })
        await tooltip.evaluate((element) => {
          const viewport = document
            .querySelector('[data-browser-viewport]')!
            .getBoundingClientRect()
          Object.assign((element as HTMLElement).style, {
            animation: 'none',
            position: 'fixed',
            left: `${viewport.left}px`,
            top: `${viewport.top}px`,
          })
        })
        await page.waitForFunction(
          () => (window as unknown as { tooltipModels: unknown[] }).tooltipModels.length > 0
        )
        if (displayed) {
          await page.evaluate(() =>
            (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(true)
          )
          await expect(tooltip).toHaveCSS('opacity', '0')
        }
        const before = await page.evaluate(
          () => (window as unknown as { tooltipDismissCount: number }).tooltipDismissCount
        )
        await tooltip.evaluate((element) => {
          Object.assign((element as HTMLElement).style, {
            width: `${innerWidth + 1}px`,
            maxWidth: 'none',
          })
        })
        await expect(page.getByText('浏览器操作失败，请重试。', { exact: true })).toBeVisible()
        await page.waitForFunction(
          (before) =>
            (window as unknown as { tooltipDismissCount: number }).tooltipDismissCount > before,
          before
        )
        await page.evaluate(() =>
          (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(true)
        )
        await tooltip.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        await expect(tooltip).not.toHaveCSS('opacity', '0')
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'native tooltip presentation fills its exact view without inherited side translation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
      await page.waitForFunction(
        () => (window as unknown as { suggestionsFixtureReady: boolean }).suggestionsFixtureReady
      )
      await page.evaluate(() =>
        (
          window as unknown as {
            scholarseed: { browserOverlay: { publish(model: unknown): Promise<unknown> } }
          }
        ).scholarseed.browserOverlay.publish({
          revision: 101,
          bounds: { x: 100, y: 100, width: 104, height: 66 },
          tooltipBounds: { x: 16, y: 14, width: 68, height: 30 },
          theme: 'light',
          language: 'zh-CN',
          tooltip: '文献中心',
          status: 'ready',
          items: [],
        })
      )
      const tooltip = page
        .frameLocator('[data-suggestions-fixture]')
        .getByTestId('browser-native-tooltip')
      await expect(tooltip).toHaveText('文献中心')
      const bounds = await tooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
          overflow: getComputedStyle(document.getElementById('root')!).overflow,
          shadow: getComputedStyle(element).boxShadow,
        }
      })
      assert.deepEqual(
        { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        { x: 16, y: 14, width: 68, height: 30 }
      )
      assert.equal(bounds.html, 'rgba(0, 0, 0, 0)')
      assert.equal(bounds.body, 'rgba(0, 0, 0, 0)')
      assert.equal(bounds.overflow, 'visible')
      assert.notEqual(bounds.shadow, 'none')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .locator('#root > span')
        .click({ position: { x: 2, y: 2 } })
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'native plain tooltip preserves viewport before publish and reports display failure without hiding webpage',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      page.on('console', (message) => {
        if (message.type() === 'warning') console.warn(message.text())
      })
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?native-tooltip',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.waitForFunction(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands.some(
          (command) => command.kind === 'bounds' && command.visible
        )
      )
      const initial = await page.evaluate(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands
          .filter((command) => command.kind === 'bounds')
          .at(-1)
      )
      await page.evaluate(() => {
        const fixture = window as unknown as {
          commands: BrowserCommand[]
          setTooltipOpen(open: boolean): void
        }
        fixture.commands.length = 0
        fixture.setTooltipOpen(true)
      })
      const tooltip = page.getByRole('tooltip')
      await tooltip.evaluate((element) => {
        element.textContent = 'Long browser tab title '.repeat(50)
        const bounds = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        Object.assign((element as HTMLElement).style, {
          animation: 'none',
          position: 'fixed',
          left: `${bounds.left}px`,
          top: `${bounds.top - element.getBoundingClientRect().height + 3}px`,
        })
      })
      assert.ok(await tooltip.evaluate((element) => element.scrollHeight > element.clientHeight))
      await page
        .waitForFunction(
          () => (window as unknown as { tooltipModels: unknown[] }).tooltipModels.length > 0,
          undefined,
          { timeout: 5000 }
        )
        .catch(async (error) => {
          const state = await tooltip.evaluate((element) => ({
            shadow: getComputedStyle(element).boxShadow,
            rect: element.getBoundingClientRect().toJSON(),
            viewport: { width: innerWidth, height: innerHeight },
            body: document.body.innerText,
          }))
          throw new Error(`${error.message}: ${JSON.stringify(state)}`)
        })
      assert.equal(await tooltip.evaluate((element) => (element as HTMLElement).style.opacity), '')
      await page.evaluate(() =>
        (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(true)
      )
      await expect(tooltip).toHaveCSS('opacity', '0')
      await tooltip.evaluate((element) => {
        const events: string[] = []
        element.addEventListener('mouseover', () => events.push('enter'))
        element.addEventListener('mouseout', () => events.push('leave'))
        Object.assign(window, { tooltipHoverEvents: events })
      })
      await page.evaluate(() => {
        const fixture = window as unknown as {
          tooltipModels: BrowserOverlayModel[]
          emitTooltipEvent(event: {
            kind: 'tooltip-hover'
            revision: number
            paused: boolean
          }): void
        }
        const revision = fixture.tooltipModels.at(-1)!.revision
        fixture.emitTooltipEvent({ kind: 'tooltip-hover', revision, paused: true })
        fixture.emitTooltipEvent({ kind: 'tooltip-hover', revision, paused: false })
      })
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { tooltipHoverEvents: string[] }).tooltipHoverEvents
        ),
        ['enter', 'leave']
      )
      const paint = await page.evaluate(() => {
        const models = (
          window as unknown as { tooltipModels: { bounds: { width: number; height: number } }[] }
        ).tooltipModels
        const source = document.querySelector('[role="tooltip"]')!.getBoundingClientRect()
        return {
          bounds: models.at(-1)!.bounds,
          source: { width: source.width, height: source.height },
        }
      })
      assert.ok(
        paint.bounds.width > paint.source.width && paint.bounds.height > paint.source.height,
        'native view includes the tooltip shadow paint extent'
      )
      const commands = await page.evaluate(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands.filter(
          (command) => command.kind === 'bounds'
        )
      )
      assert.ok(commands.every((command) => JSON.stringify(command) === JSON.stringify(initial)))
      await tooltip.evaluate((element) => element.append(document.createElement('img')))
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: BrowserCommand[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === false,
        undefined,
        { timeout: 2000 }
      )
      await tooltip.evaluate((element) => element.querySelector('img')!.remove())
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: BrowserCommand[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === true
      )
      await page.evaluate(() => {
        ;(window as unknown as { commands: BrowserCommand[] }).commands.length = 0
      })
      await page.evaluate(() =>
        (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(false)
      )
      await page.evaluate(() =>
        (window as unknown as { setTooltipOpen(open: boolean): void }).setTooltipOpen(false)
      )
      await page.evaluate(() =>
        (window as unknown as { setTooltipOpen(open: boolean): void }).setTooltipOpen(true)
      )
      await tooltip.evaluate((element) => {
        const bounds = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        Object.assign((element as HTMLElement).style, {
          animation: 'none',
          position: 'fixed',
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
        })
      })
      await page.waitForFunction(
        () => (window as unknown as { tooltipModels: unknown[] }).tooltipModels.length > 1
      )
      await page.evaluate(() =>
        (window as unknown as { finishTooltip(ok: boolean): void }).finishTooltip(false)
      )
      await expect(page.getByText('浏览器操作失败，请重试。', { exact: true })).toBeVisible()
      await expect(tooltip).not.toHaveCSS('opacity', '0')
      const final = await page.evaluate(() =>
        (window as unknown as { commands: BrowserCommand[] }).commands.filter(
          (command) => command.kind === 'bounds'
        )
      )
      assert.ok(final.every((command) => command.kind === 'bounds' && command.visible))
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser toolbar icons retain accessible actions without a webpage tab track',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      await expect(workspace.getByRole('tablist')).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: '打开新的标签页', exact: true })
      ).toHaveCount(0)
      const tools = workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      assert.equal((await tools.textContent())?.trim(), '')
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toHaveCount(0)
      await expect(tools.locator('svg.lucide-ellipsis')).toHaveCount(1)
      await expect(tools).toHaveAttribute('type', 'button')
      await expect(tools).toHaveAttribute('aria-expanded', 'false')
      await expect(tools).toHaveAttribute('aria-pressed', 'false')
      await expect(tools).toHaveAttribute('aria-haspopup', 'menu')
      await tools.click()
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(tools).toHaveAttribute('aria-expanded', 'true')
      await expect(tools).toHaveAttribute('aria-pressed', 'true')
      await page.evaluate(() =>
        (window as unknown as { revokeMenu(reason: string): void }).revokeMenu('escape')
      )
      await expect(tools).toBeFocused()
      const address = workspace.getByRole('textbox', { name: '网址' })
      await address.fill('example.org')
      await address.press('Enter')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commands: BrowserCommand[] }).commands.filter(
                (command) => command.kind === 'navigate'
              ).length
          )
        )
        .toBe(1)
      await address.fill('')
      await address.press('Enter')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commands: BrowserCommand[] }).commands.filter(
                (command) => command.kind === 'navigate'
              ).length
          )
        )
        .toBe(1)
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await expect(workspace.getByRole('button', { name: 'Open a new tab' })).toHaveCount(0)
      await expect(workspace.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: 'Browser help and status', exact: true })
      ).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: 'More browser features' })
      ).toHaveAttribute('aria-expanded', 'false')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'native menu non-Escape revocation preserves existing product focus while Escape restores More',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const tools = page.getByRole('button', { name: '更多浏览器功能', exact: true })
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      for (const reason of ['outside', 'blur', 'minimize', 'invalid', 'escape']) {
        await tools.click()
        await page.evaluate(() =>
          (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
        )
        await expect(tools).toHaveAttribute('aria-expanded', 'true')
        await address.focus()
        await expect(address).toBeFocused()
        await page.evaluate(
          (reason) =>
            (window as unknown as { revokeMenu(reason: string): void }).revokeMenu(reason),
          reason
        )
        await expect(tools).toHaveAttribute('aria-expanded', 'false')
        await expect(reason === 'escape' ? tools : address).toBeFocused()
      }
      await tools.press('Enter')
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(tools).toHaveAttribute('aria-expanded', 'true')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'navigation remains reachable with multiple native targets and preserves disabled states',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 660 } })
      const fixture = new URL(
        '/features/browser/browser.render.fixture.html',
        server.resolvedUrls!.local[0]
      )
      await page.goto(`${fixture.href}?many-tabs`)
      const workspace = page.getByTestId('browser-workspace')
      await expect(workspace.getByRole('tablist')).toHaveCount(0)
      await expect(workspace.getByRole('textbox', { name: '网址', exact: true })).toBeInViewport()
      await expect(workspace.getByRole('button', { name: '后退', exact: true })).toBeInViewport()
      await page.goto(fixture.href + '?empty-tabs')
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toBeEnabled()
      await expect(workspace.getByRole('button', { name: '后退', exact: true })).toBeDisabled()
      await expect(workspace.getByRole('button', { name: '前进', exact: true })).toBeDisabled()
      await page.goto(fixture.href + '?empty-tabs&slow')
      await workspace.getByRole('textbox', { name: '网址', exact: true }).fill('example.org')
      await workspace.getByRole('textbox', { name: '网址', exact: true }).press('Enter')
      await expect(
        workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toBeDisabled()
      await page.goto(`${fixture.href}?web`)
      await expect(
        workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toBeDisabled()
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'already focused address click reopens after native dismiss and Escape without automatic restore reopening',
  { timeout: 60_000 },
  async (t) => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const evidenceRoot = path.resolve(ROOT, '../../../../../tmp/test_snapshot/browser-focus')
    mkdirSync(evidenceRoot, { recursive: true })
    const evidence = mkdtempSync(path.join(evidenceRoot, 'run-'))
    let context: BrowserContext | undefined
    let page: Page | undefined
    try {
      context = await browser.newContext()
      await context.tracing.start({ screenshots: true, snapshots: true })
      page = await context.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByRole('textbox', { name: '网址', exact: true })).toBeVisible()
      await page.evaluate(() => {
        const fixture = window as unknown as {
          focusEvidence: unknown[]
          scholarseed: {
            browserOverlay: {
              publish(model: { revision: number; status: string }): Promise<unknown>
              focus(): Promise<unknown>
              dismissSync(): void
            }
          }
        }
        fixture.focusEvidence = []
        const record = (kind: string, detail: unknown): void => {
          fixture.focusEvidence.push({ at: performance.now(), kind, detail })
        }
        for (const kind of ['focusin', 'focusout', 'keydown'])
          document.addEventListener(
            kind,
            (event) => {
              const target = event.target as HTMLElement
              record(kind, {
                tag: target.tagName,
                role: target.getAttribute('role'),
                key: event instanceof KeyboardEvent ? event.key : undefined,
              })
            },
            true
          )
        const bridge = fixture.scholarseed.browserOverlay
        const publish = bridge.publish.bind(bridge)
        const focus = bridge.focus.bind(bridge)
        const dismiss = bridge.dismissSync.bind(bridge)
        bridge.publish = (model) => {
          record('publish', model)
          return publish(model)
        }
        bridge.focus = () => {
          record('focus-request', null)
          return focus()
        }
        bridge.dismissSync = () => {
          record('dismiss', null)
          dismiss()
        }
      })
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      const frame = page.locator('[data-suggestions-fixture]')
      const option = page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
      await address.fill('Paper')
      await option.waitFor()
      await expect(address).toBeFocused()
      const revision = await page.evaluate(() => {
        const fixture = window as unknown as {
          overlayModels: { revision: number }[]
          emitOverlayEvent(event: { kind: 'dismiss'; revision: number }): void
          scholarseed: { browserOverlay: { dismissSync(): void } }
        }
        const revision = fixture.overlayModels.at(-1)!.revision
        fixture.scholarseed.browserOverlay.dismissSync()
        fixture.emitOverlayEvent({ kind: 'dismiss', revision })
        return revision
      })
      await expect(frame).toBeHidden()
      await expect(address).toBeFocused()
      await address.click()
      await expect(frame).toBeVisible()
      const reopenedPage = page
      await expect
        .poll(() =>
          reopenedPage.evaluate(() => {
            const model = (
              window as unknown as { overlayModels: { revision: number; status: string }[] }
            ).overlayModels.at(-1)
            return model?.status === 'ready' ? model.revision : 0
          })
        )
        .toBeGreaterThan(revision)
      await option.waitFor()
      await address.press('ArrowDown')
      await expect(option).toBeFocused()
      await option.press('Escape')
      await expect(address).toBeFocused()
      await expect(frame).toBeHidden()
      await address.click()
      await expect(frame).toBeVisible()
      await address.press('Escape')
      await expect(frame).toBeHidden()
      await expect(address).toBeFocused()
      await address.click()
      await expect(frame).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    } catch (error) {
      try {
        if (page) {
          await page.screenshot({ path: path.join(evidence, 'failure.png') })
          writeFileSync(
            path.join(evidence, 'failure.json'),
            JSON.stringify(
              {
                error: String(error),
                frames: await Promise.all(
                  page.frames().map((frame) =>
                    frame.evaluate(() => ({
                      url: location.href,
                      focused: document.hasFocus(),
                      active: document.activeElement?.outerHTML,
                      models: (window as unknown as { overlayModels?: unknown[] }).overlayModels,
                      events: (window as unknown as { focusEvidence?: unknown[] }).focusEvidence,
                    }))
                  )
                ),
              },
              null,
              2
            )
          )
        }
      } catch (diagnosticError) {
        t.diagnostic(`Evidence capture failed: ${String(diagnosticError)}`)
      }
      throw error
    } finally {
      try {
        if (page)
          writeFileSync(
            path.join(evidence, 'state.json'),
            JSON.stringify(
              await page.evaluate(() => ({
                active: document.activeElement?.outerHTML,
                events: (window as unknown as { focusEvidence?: unknown[] }).focusEvidence,
              })),
              null,
              2
            )
          )
        await context?.tracing.stop({ path: path.join(evidence, 'trace.zip') })
      } finally {
        await browser.close()
        await server.close()
      }
      t.diagnostic(`Focus trace: ${evidence}`)
    }
  }
)

test(
  'explicit current-revision focus request focuses DOM without relying on window focus events',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      const overlay = page.frameLocator('[data-suggestions-fixture]')
      const option = overlay.getByRole('option', { name: /Paper Example/ })
      await option.waitFor()
      assert.equal(
        await option.evaluate(
          () => (window as unknown as { fixtureWindowFocusEvents: number }).fixtureWindowFocusEvents
        ),
        0
      )
      await expect(address).toBeFocused()
      await page.evaluate(() => {
        const fixture = window as unknown as {
          overlayModels: { revision: number }[]
          emitSuggestionsFocus(revision: number): void
        }
        fixture.emitSuggestionsFocus(fixture.overlayModels.at(-1)!.revision)
      })
      await expect(option).toBeFocused()
      await option.press('Escape')
      await expect(address).toBeFocused()
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'stale focus requests and model updates never steal focus while repeated current requests remain explicit',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      const overlay = page.frameLocator('[data-suggestions-fixture]')
      const option = overlay.getByRole('option', { name: /Paper Example/ })
      const search = overlay.getByRole('button', { name: /Google/ })
      await option.waitFor()
      const revision = await page.evaluate(
        () =>
          (window as unknown as { overlayModels: { revision: number }[] }).overlayModels.at(-1)!
            .revision
      )
      await page.evaluate(
        (current) =>
          (
            window as unknown as { emitSuggestionsFocus(revision: number): void }
          ).emitSuggestionsFocus(current - 1),
        revision
      )
      await expect(address).toBeFocused()
      await address.press('ArrowDown')
      await expect(option).toBeFocused()
      await option.press('ArrowDown')
      await expect(search).toBeFocused()
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { overlayModels: { revision: number }[] }).overlayModels.at(-1)!
                .revision
          )
        )
        .toBeGreaterThan(revision)
      await expect(search).toBeFocused()
      await page.evaluate(
        (current) =>
          (
            window as unknown as { emitSuggestionsFocus(revision: number): void }
          ).emitSuggestionsFocus(current),
        revision
      )
      await expect(search).toBeFocused()
      await page.evaluate(() => {
        const fixture = window as unknown as {
          overlayModels: { revision: number }[]
          emitSuggestionsFocus(revision: number): void
        }
        fixture.emitSuggestionsFocus(fixture.overlayModels.at(-1)!.revision)
      })
      await expect(option).toBeFocused()
      await option.press('ArrowDown')
      await expect(search).toBeFocused()
      await page.evaluate(() => {
        const fixture = window as unknown as {
          overlayModels: { revision: number }[]
          emitSuggestionsFocus(revision: number): void
        }
        fixture.emitSuggestionsFocus(fixture.overlayModels.at(-1)!.revision)
      })
      await expect(option).toBeFocused()
      await option.press('Enter')
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) => command.kind === 'navigate' && command.input === 'https://example.org/paper'
        )
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'suggestions preserve the DOM viewport and publish measured anchor geometry',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      await expect(address).toHaveValue('https://example.com/')
      const before = await page.getByTestId('browser-viewport').boundingBox()
      await address.fill('Paper')
      await page.waitForFunction(
        () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length > 0
      )
      assert.deepEqual(await page.getByTestId('browser-viewport').boundingBox(), before)
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .waitFor()
      const published = await page.evaluate(() =>
        (
          window as unknown as {
            overlayModels: BrowserOverlayModel[]
          }
        ).overlayModels.at(-1)!
      )
      const anchor = (await address.boundingBox())!
      assert.equal(published.bounds.x, anchor.x)
      assert.equal(published.bounds.y, anchor.y + anchor.height)
      assert.equal(published.bounds.width, anchor.width)
      assert.ok(published.bounds.height > 0)
      assert.ok(published.revision > 100)
      assert.equal(await address.getAttribute('aria-controls'), null)
      assert.equal(await address.evaluate((element) => element === document.activeElement), true)
      assert.equal(await page.getByTestId('browser-workspace').getByRole('option').count(), 0)
      await address.press('Escape')
      assert.deepEqual(await page.getByTestId('browser-viewport').boundingBox(), before)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'overlay loading empty error and locale/theme states are explicit',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?slow-history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      const overlay = page.frameLocator('[data-suggestions-fixture]')
      await address.fill('Paper')
      await expect(overlay.getByRole('status')).toHaveText('正在搜索本机浏览历史…')
      await address.fill('unmatched')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { overlayModels: BrowserOverlayModel[] }).overlayModels.at(-1)
                ?.status
          )
        )
        .toBe('empty')
      await expect(
        overlay.getByRole('button', {
          name: browserZh.searchWeb.replace('{{query}}', 'unmatched'),
          exact: true,
        })
      ).toBeVisible()
      await expect(overlay.getByRole('option')).toHaveCount(0)
      await expect(overlay.getByRole('status')).toHaveCount(0)
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { overlayModels: { theme: string }[] }).overlayModels.at(-1)
                ?.theme
          )
        )
        .toBe('dark')
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await page.getByRole('textbox', { name: 'Address' }).fill('unmatched ')
      await expect(
        overlay.getByRole('button', {
          name: browserEn.searchWeb.replace('{{query}}', 'unmatched'),
          exact: true,
        })
      ).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { overlayModels: { language: string }[] }).overlayModels.at(-1)
                ?.language
          )
        )
        .toBe('en')
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?history-query-error',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('textbox', { name: '网址' }).fill('Paper')
      await expect(overlay.getByRole('status')).toHaveText('暂时无法读取本机浏览历史。')
      const longAddress = 'https://example.com/?q=' + 'x'.repeat(234)
      await address.fill(longAddress)
      await expect(address).toHaveValue(longAddress)
      await expect(overlay.getByRole('status')).not.toHaveText('暂时无法读取本机浏览历史。')
      await address.fill(longAddress.slice(0, -1))
      await expect(overlay.getByRole('status')).toHaveText('暂时无法读取本机浏览历史。')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'closed revisions and late queries cannot navigate or reopen suggestions',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?slow-history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      await page.waitForFunction(
        () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length > 0
      )
      await expect(
        page.frameLocator('[data-suggestions-fixture]').getByRole('button', {
          name: /在 Google 搜索“Paper”/,
        })
      ).toBeVisible()
      const revision = await page.evaluate(
        () =>
          (window as unknown as { overlayModels: { revision: number }[] }).overlayModels.at(-1)!
            .revision
      )
      await address.press('Escape')
      await page.evaluate((current) => {
        const fixture = window as unknown as {
          finishHistory(): void
          emitOverlayEvent(event: unknown): void
        }
        fixture.finishHistory()
        fixture.emitOverlayEvent({ kind: 'select', revision: current, itemId: 'search' })
      }, revision)
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { commands: { kind: string }[] }).commands.filter(
              (command) => command.kind === 'navigate'
            ).length
        ),
        0
      )
      await address.fill('unmatched')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /Google/ })
        .waitFor()
      await page.evaluate(() =>
        (window as unknown as { selectBrowserTab(tabId: string): void }).selectBrowserTab('second')
      )
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      await address.fill('unmatched ')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /Google/ })
        .waitFor()
      await page.evaluate(() => (window as unknown as { unmountBrowser(): void }).unmountBrowser())
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-suggestions-fixture]')),
        null
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'overlay Tab returns to the next toolbar control and cross-document blur does not dismiss selection',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      const option = page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
      await option.waitFor()
      await address.evaluate((element) =>
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      )
      await expect(page.locator('[data-suggestions-fixture]')).toBeVisible()
      await address.press('ArrowDown')
      await option.press('Tab')
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      await expect(page.getByRole('button', { name: '更多浏览器功能', exact: true })).toBeFocused()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'priority dialog first click dismisses suggestions before interaction and revokes old callbacks',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .waitFor()
      const revision = await page.evaluate(
        () =>
          (window as unknown as { overlayModels: { revision: number }[] }).overlayModels.at(-1)!
            .revision
      )
      await page.getByRole('button', { name: 'Open priority dialog', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Priority dialog', exact: true })).toBeVisible()
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      await page.evaluate(
        (current) =>
          (window as unknown as { emitOverlayEvent(event: unknown): void }).emitOverlayEvent({
            kind: 'select',
            revision: current,
            itemId: 'search',
          }),
        revision
      )
      await page.getByRole('button', { name: 'Confirm priority action', exact: true }).click()
      await expect(page.getByTestId('modal-actions')).toHaveText('1')
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { commands: { kind: string }[] }).commands.filter(
              (command) => command.kind === 'navigate'
            ).length
        ),
        0
      )
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await address.fill('Paper ')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .waitFor()
      await page.evaluate(() =>
        (window as unknown as { setModalOpen(open: boolean): void }).setModalOpen(true)
      )
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'empty browser shows localized guidance without a tab bar or a native target',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?empty-tabs',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await expect(page.getByText('在任务中浏览网页', { exact: true })).toBeVisible()
      await expect(page.getByPlaceholder('搜索或输入网址', { exact: true })).toBeVisible()
      await expect(page.getByTestId('browser-address-icon')).toBeVisible()
      const viewportBounds = await page.getByTestId('browser-viewport').boundingBox()
      const emptyBounds = await page
        .getByTestId('browser-start-page')
        .locator('[data-variant="panel"]')
        .boundingBox()
      assert.ok(viewportBounds && emptyBounds)
      assert.ok(
        Math.abs(
          emptyBounds.y + emptyBounds.height / 2 - viewportBounds.y - viewportBounds.height / 2
        ) < 1
      )
      assert.ok(
        Math.abs(
          emptyBounds.x + emptyBounds.width / 2 - viewportBounds.x - viewportBounds.width / 2
        ) < 1
      )
      await expect(page.getByTestId('browser-start-page').getByRole('button')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '关闭 新标签页', exact: true })).toHaveCount(0)
      await page.getByRole('textbox', { name: '网址', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '网址', exact: true })).toBeFocused()
      assert.deepEqual(
        await page.evaluate(() =>
          (window as unknown as { commands: BrowserCommand[] }).commands.filter(
            (command) => command.kind !== 'bounds'
          )
        ),
        []
      )
      await page.getByRole('button', { name: 'English', exact: true }).click()
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await expect(page.getByText('Browse the web in your task', { exact: true })).toBeVisible()
      await expect(page.getByText('CDP automation', { exact: true })).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'blank webpage tabs share the start page without a native viewport covering it',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
      await page.evaluate(() =>
        (window as unknown as { emitBrowserSnapshot(url: string): void }).emitBrowserSnapshot(
          'about:blank'
        )
      )
      await expect(page.getByTestId('browser-start-page')).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commands: BrowserCommand[] }).commands
                .filter((command) => command.kind === 'bounds')
                .at(-1)?.visible
          )
        )
        .toBe(false)
      await page.evaluate(() =>
        (window as unknown as { emitBrowserSnapshot(url: string): void }).emitBrowserSnapshot(
          'https://example.org/'
        )
      )
      await expect(page.getByTestId('browser-start-page')).toHaveCount(0)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commands: BrowserCommand[] }).commands
                .filter((command) => command.kind === 'bounds')
                .at(-1)?.visible
          )
        )
        .toBe(true)
      await page.evaluate(() =>
        (window as unknown as { emitBrowserSnapshot(url: string): void }).emitBrowserSnapshot('')
      )
      await expect(page.getByTestId('browser-start-page')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'an empty active webpage returns to guidance without page tab controls',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByTestId('browser-start-page')).toHaveCount(0)
      await page.evaluate(() =>
        (window as unknown as { emitBrowserSnapshot(url: string): void }).emitBrowserSnapshot('')
      )
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await expect(page.getByTestId('browser-start-page')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'sidecar tab switch resizes the new target even at unchanged viewport dimensions',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?sidecar',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.waitForFunction(
        () => (window as unknown as { frameResizes?: unknown[] }).frameResizes?.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as { selectBrowserTab(tabId: string): void }).selectBrowserTab('second')
      )
      await page.waitForFunction(
        () => (window as unknown as { frameResizes: unknown[] }).frameResizes.length === 2
      )
      assert.deepEqual(
        await page.evaluate(() =>
          (window as unknown as { frameResizes: Array<{ tabId: string }> }).frameResizes.map(
            (item) => item.tabId
          )
        ),
        ['first', 'second']
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'sidecar tab switch does not forward the previous tab key release or composition commit',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?sidecar',
          server.resolvedUrls!.local[0]
        ).href
      )
      const editable = page.locator('[data-browser-viewport] [contenteditable]')
      await editable.focus()
      await page.keyboard.down('Shift')
      await page.waitForFunction(
        () => (window as unknown as { frameInputs: unknown[] }).frameInputs.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as { selectBrowserTab(tabId: string): void }).selectBrowserTab('second')
      )
      await expect(editable).toBeVisible()
      await page.keyboard.up('Shift')
      assert.deepEqual(
        await page.evaluate(() =>
          (
            window as unknown as { frameInputs: Array<{ tabId: string; input: { type?: string } }> }
          ).frameInputs.filter((item) => item.tabId === 'second' && item.input.type === 'keyUp')
        ),
        []
      )
      await page.evaluate(() =>
        (window as unknown as { selectBrowserTab(tabId: string): void }).selectBrowserTab('first')
      )
      await expect(editable).toBeVisible()
      await editable.focus()
      await editable.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        element.dispatchEvent(
          new CompositionEvent('compositionupdate', { bubbles: true, data: '文' })
        )
      })
      await page.waitForFunction(() =>
        (
          window as unknown as { frameInputs: Array<{ input: { kind: string; phase?: string } }> }
        ).frameInputs.some(
          (item) => item.input.kind === 'composition' && item.input.phase === 'begin'
        )
      )
      await page.evaluate(() =>
        (window as unknown as { selectBrowserTab(tabId: string): void }).selectBrowserTab('second')
      )
      await expect(editable).toBeVisible()
      await editable.evaluate((element) =>
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '文' }))
      )
      assert.deepEqual(
        await page.evaluate(() =>
          (
            window as unknown as {
              frameInputs: Array<{ tabId: string; input: { kind: string; phase?: string } }>
            }
          ).frameInputs.filter(
            (item) => item.tabId === 'second' && item.input.kind === 'composition'
          )
        ),
        []
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'sidecar image decode failure remains user-visible after frame acknowledgement',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?sidecar',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.waitForFunction(
        () => (window as unknown as { frameResizes: unknown[] }).frameResizes.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as { emitBrowserFrame(frame: unknown): void }).emitBrowserFrame({
          tabId: 'first',
          sequence: 1,
          data: 'not-an-image',
          format: 'jpeg',
          width: 800,
          height: 600,
        })
      )
      await page.waitForFunction(
        () => (window as unknown as { frameAcks: unknown[] }).frameAcks.length === 1
      )
      await page.locator('.vds-toaster').getByRole('alert').waitFor()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'blank Electron target uses localized guidance instead of a tab label',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?blank-title',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByTestId('browser-start-page')).toBeVisible()
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await page.getByRole('button', { name: 'English' }).click()
      await expect(page.getByText('Browse the web in your task', { exact: true })).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'first navigation keeps the typed address while its new native tab has not committed',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?pending-open',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('example.com')
      await address.press('Enter')
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      assert.equal(await address.inputValue(), 'example.com')
      await page.evaluate(() => (window as unknown as { finishOpen(): void }).finishOpen())
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('input[aria-label="网址"]')?.value ===
          'https://example.com/'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'editing the address during a first navigation survives its completion',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?pending-open',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('example.com')
      await address.press('Enter')
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await address.fill('another.example')
      await page.evaluate(() => (window as unknown as { finishOpen(): void }).finishOpen())
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string }[] }).commands.some(
          (command) => command.kind === 'open'
        )
      )
      assert.equal(await address.inputValue(), 'another.example')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser contribution and controls project Main snapshots in both languages',
  { timeout: 60_000 },
  async () => {
    assert.ok(existsSync(path.join(ROOT, 'features/browser/Browser.tsx')), 'browser UI must exist')
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      assert.equal(await page.getByTestId('contribution').textContent(), '')
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
      await page.getByTestId('browser-viewport').evaluate((element) => {
        element.style.height = '300px'
      })
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands.some(
          (command) => command.kind === 'bounds' && command.visible
        )
      )
      await page.evaluate(() => {
        const overlay = document.createElement('div')
        overlay.id = 'test-overlay'
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:20px;height:20px;background:white'
        document.body.append(overlay)
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === false
      )
      await page.evaluate(() => document.getElementById('test-overlay')!.remove())
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === true
      )
      await page.evaluate(() => {
        const portal = document.createElement('div')
        portal.id = 'test-portal'
        portal.style.cssText = 'position:fixed;inset:0;pointer-events:none'
        const control = document.createElement('button')
        const bounds = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        control.style.cssText = `position:fixed;pointer-events:auto;left:${bounds.right - 30}px;top:${bounds.bottom - 30}px;width:20px;height:20px`
        portal.append(control)
        document.body.append(portal)
      })
      await page.waitForFunction(() => {
        const bounds = (
          window as unknown as {
            commands: { kind: string; visible?: boolean; height: number; width: number }[]
          }
        ).commands
          .filter((command) => command.kind === 'bounds')
          .at(-1)
        const rect = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        return bounds?.visible && (bounds.height < rect.height || bounds.width < rect.width)
      })
      await page.evaluate(() => document.getElementById('test-portal')!.remove())
      await page.evaluate(() =>
        (window as unknown as { setTooltipOpen(open: boolean): void }).setTooltipOpen(true)
      )
      const tooltip = page.getByRole('tooltip', { name: 'Animated browser tooltip' })
      await tooltip.waitFor({ state: 'attached' })
      await tooltip.evaluate((element) => {
        const rect = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        Object.assign((element as HTMLElement).style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          position: 'fixed',
        })
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === false
      )
      await tooltip.evaluate(async (element) => {
        const animation = element.getAnimations()[0]
        animation.play()
        await animation.finished
      })
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { commands: { visible?: boolean }[] }).commands.at(-1)?.visible
        ),
        false
      )
      await tooltip.evaluate((element) => {
        ;(element as HTMLElement).style.top = '0px'
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { visible?: boolean }[] }).commands.at(-1)?.visible ===
          true
      )
      await tooltip.evaluate((element) => {
        const content = element as HTMLElement
        content.style.transition = 'top var(--vds-duration-fast) linear'
        content.getBoundingClientRect()
        content.style.top = `${document.querySelector('[data-browser-viewport]')!.getBoundingClientRect().top}px`
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { visible?: boolean }[] }).commands.at(-1)?.visible ===
          false
      )
      await tooltip.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      await tooltip.evaluate((element) => {
        ;(element as HTMLElement).style.top = '0px'
      })
      await tooltip.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { visible?: boolean }[] }).commands.at(-1)?.visible ===
          true
      )
      await tooltip.evaluate((element) => {
        const content = element as HTMLElement
        content.style.transition = 'none'
        content.style.height = `${document.querySelector('[data-browser-viewport]')!.getBoundingClientRect().bottom}px`
      })
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { visible?: boolean }[] }).commands.at(-1)?.visible ===
          false
      )
      await page.evaluate(() =>
        (window as unknown as { setTooltipOpen(open: boolean): void }).setTooltipOpen(false)
      )
      await page.waitForFunction(
        () =>
          (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands
            .filter((command) => command.kind === 'bounds')
            .at(-1)?.visible === true
      )
      await expect(page.getByTestId('browser-workspace').getByRole('tablist')).toHaveCount(0)
      await page.getByRole('textbox', { name: '网址' }).fill('example.com')
      await page.getByRole('textbox', { name: '网址' }).press('Enter')
      await page.getByRole('button', { name: '后退', exact: true }).click()
      await page.getByRole('button', { name: '前进', exact: true }).click()
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(
        page.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toHaveAttribute('aria-expanded', 'true')
      await page.evaluate(() =>
        (window as unknown as { menuAction(actionId: string): void }).menuAction('browser.devtools')
      )
      assert.equal(await page.getByTestId('browser-workspace').getByRole('switch').count(), 0)
      await expect(page.getByRole('button', { name: '打开新的标签页' })).toHaveCount(0)
      const commands = await page.evaluate(() =>
        (window as unknown as { commands: { kind: string }[] }).commands.filter(
          (command) => command.kind !== 'bounds'
        )
      )
      assert.deepEqual(commands, [
        { kind: 'navigate', tabId: 'first', input: 'example.com' },
        { kind: 'back', tabId: 'first' },
        { kind: 'forward', tabId: 'first' },
        { kind: 'reload', tabId: 'first' },
        { kind: 'devtools', tabId: 'first', open: true },
      ])
      await page.getByRole('button', { name: 'English' }).click()
      assert.equal(await page.getByTestId('contribution').textContent(), '')
      await page.getByRole('textbox', { name: 'Address' }).waitFor()
      await page.getByRole('button', { name: 'Reload', exact: true }).waitFor()
      assert.equal(
        await page.getByTestId('browser-workspace').locator('iframe, webview').count(),
        0
      )
      await page.getByRole('textbox', { name: 'Address' }).fill('bad:address')
      await page.getByRole('textbox', { name: 'Address' }).press('Enter')
      await page
        .getByRole('alert')
        .filter({ hasText: 'Enter a valid HTTP or HTTPS address.' })
        .waitFor()
      await page.evaluate(() => (window as unknown as { unmountBrowser(): void }).unmountBrowser())
      const unmounted = await page.evaluate(() =>
        (window as unknown as { commands: { kind: string; visible?: boolean }[] }).commands.at(-1)
      )
      assert.equal(unmounted?.kind, 'bounds')
      assert.equal(unmounted?.visible, false)
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?pending-open',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('textbox', { name: '网址' }).fill('example.org')
      await page.getByRole('textbox', { name: '网址' }).press('Enter')
      await expect(page.getByRole('button', { name: '更多浏览器功能' })).toBeDisabled()
      await page.evaluate(() => (window as unknown as { finishOpen(): void }).finishOpen())
      await expect(page.getByRole('button', { name: '更多浏览器功能' })).toBeEnabled()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html?web', server.resolvedUrls!.local[0])
          .href
      )
      await page
        .getByTestId('browser-workspace')
        .getByRole('alert')
        .filter({ hasText: '内置浏览器仅在桌面端可用。' })
        .waitFor()
      await expect(page.getByRole('button', { name: '更多浏览器功能' })).toBeDisabled()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'address navigation can replace a pending request without stale completion resetting it',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?slow-navigation',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('https://example.com/stall')
      await address.press('Enter')
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) => command.kind === 'navigate' && command.input?.endsWith('/stall')
        )
      )
      assert.equal(await address.isEnabled(), true)
      await address.fill('https://example.com/next')
      await address.press('Enter')
      await page.getByRole('textbox', { name: '网址' }).waitFor()
      await page.evaluate(() =>
        (window as unknown as { finishNavigation(): void }).finishNavigation()
      )
      await page.waitForTimeout(100)
      assert.equal(await address.inputValue(), 'https://example.com/next')
      const navigations = await page.evaluate(() =>
        (window as unknown as { commands: { kind: string }[] }).commands.filter(
          (command) => command.kind === 'navigate'
        )
      )
      assert.equal(navigations.length, 2)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'incoming page snapshots do not overwrite an address being edited',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?slow-navigation',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('https://example.com/stall')
      await address.press('Enter')
      await address.fill('https://example.com/next')
      await page.evaluate(() =>
        (window as unknown as { emitBrowserSnapshot(url: string): void }).emitBrowserSnapshot(
          'https://example.com/stall'
        )
      )
      await page.waitForTimeout(100)
      assert.equal(await address.inputValue(), 'https://example.com/next')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'address bar suggests local history and requires explicit consent before web search',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .waitFor()
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /在 Google 搜索“Paper”/ })
        .waitFor()
      assert.ok(
        await page.evaluate(() =>
          (
            window as unknown as {
              historyRequests: { kind: string; query?: { search?: string } }[]
            }
          ).historyRequests.some(
            (request) => request.kind === 'query' && request.query?.search === 'Paper'
          )
        )
      )
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .click()
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) => command.kind === 'navigate' && command.input === 'https://example.org/paper'
        )
      )
      await expect(address).toHaveValue('https://example.com/')
      await address.fill('private research phrase')
      await expect(address).toHaveValue('private research phrase')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /在 Google 搜索/ })
        .waitFor()
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { commands: { kind: string; input?: string }[] }).commands.filter(
              (command) => command.kind === 'navigate'
            ).length
        ),
        1
      )
      await address.press('Enter')
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) => command.kind === 'navigate' && command.input === 'private research phrase'
        )
      )
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { commands: { kind: string; input?: string }[] }).commands.filter(
              (command) => command.kind === 'navigate' && command.input?.includes('google')
            ).length
        ),
        0
      )
      await address.fill('private research phrase')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /在 Google 搜索/ })
        .click()
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) =>
            command.kind === 'navigate' &&
            command.input === 'https://www.google.com/search?q=private%20research%20phrase'
        )
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'address suggestions support Escape and ArrowDown plus Enter without submitting the typed query',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      const option = page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
      const fillSuggestions = async (query: string): Promise<void> => {
        const revision = await page.evaluate(
          () => Reflect.get(window, 'overlayModels').at(-1)?.revision ?? 0
        )
        await address.fill(query)
        await page.waitForFunction((previous) => {
          const current = Reflect.get(window, 'overlayModels').at(-1)
          return current?.revision > previous && current.status === 'ready'
        }, revision)
        await option.waitFor()
      }
      await fillSuggestions('Paper')
      await address.press('Escape')
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      assert.equal(await address.inputValue(), 'Paper')
      await fillSuggestions('Paper ')
      await address.press('ArrowDown')
      await expect(
        page
          .frameLocator('[data-suggestions-fixture]')
          .getByRole('option', { name: /Paper Example/ })
      ).toBeFocused()
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .press('Escape')
      await expect(address).toBeFocused()
      await expect(page.locator('[data-suggestions-fixture]')).toBeHidden()
      await fillSuggestions('Paper')
      await address.press('ArrowDown')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('option', { name: /Paper Example/ })
        .press('Enter')
      await page.waitForFunction(() =>
        (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
          (command) => command.kind === 'navigate' && command.input === 'https://example.org/paper'
        )
      )
      assert.equal(
        await page.evaluate(() =>
          (window as unknown as { commands: { kind: string; input?: string }[] }).commands.some(
            (command) => command.kind === 'navigate' && command.input === 'Paper'
          )
        ),
        false
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'late history results never replace suggestions for a newer address query',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?slow-history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const address = page.getByRole('textbox', { name: '网址' })
      await address.fill('Paper')
      await page.waitForFunction(() =>
        (
          window as unknown as { historyRequests: { kind: string; query?: { search?: string } }[] }
        ).historyRequests.some(
          (request) => request.kind === 'query' && request.query?.search === 'Paper'
        )
      )
      await address.fill('unmatched')
      await page
        .frameLocator('[data-suggestions-fixture]')
        .getByRole('button', { name: /在 Google 搜索“unmatched”/ })
        .waitFor()
      await page.evaluate(() => (window as unknown as { finishHistory(): void }).finishHistory())
      await page.waitForTimeout(100)
      assert.equal(
        await page
          .frameLocator('[data-suggestions-fixture]')
          .getByRole('option', { name: /Paper Example/ })
          .count(),
        0
      )
      assert.equal(await address.inputValue(), 'unmatched')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'history no-param menu action opens its own section even with no active webpage',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?empty-tabs',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '更多浏览器功能', exact: true }).click()
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await page.getByRole('button', { name: '更多浏览器功能', exact: true }).waitFor()
      await page.waitForFunction(() =>
        (window as unknown as { menuModels: { items: { actionId?: string }[] }[] }).menuModels
          .at(-1)
          ?.items.some((item) => item.actionId === 'browser.history')
      )
      await page.evaluate(() =>
        (window as unknown as { menuAction(action: string): void }).menuAction('browser.history')
      )
      await expect(page.getByTestId('account-settings-browser-history')).toBeVisible()
      await expect(page.getByRole('navigation', { name: '面包屑导航', exact: true })).toContainText(
        '浏览历史'
      )
      await expect(page.getByTestId('browser-settings-cdp')).toHaveCount(0)
      await expect(page.getByTestId('browser-settings-history')).toHaveCount(1)
      await expect(page.getByText('Paper Example')).toBeVisible()
      await page.getByRole('button', { name: 'English' }).click()
      await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toContainText(
        'Browsing history'
      )
      await page.getByRole('link', { name: 'Browser settings', exact: true }).click()
      await expect(page.getByTestId('browser-history-management')).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Advanced settings', exact: true })
      ).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings control the Main-owned CDP endpoint without rendering its secret',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&advanced',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      const settings = page.getByTestId('account-settings-browser')
      await settings
        .getByText(
          '允许产品 Agent 在授权后读取内置浏览器网页。与外部 Playwright/CDP 访问不同，不影响手动浏览。首次配置默认开启并允许 Bing 读取和导航；已有设置保持不变。'
        )
        .waitFor()
      await expect(settings.getByText('外部浏览器自动化（CDP）', { exact: true })).toBeVisible()
      await settings.getByRole('switch', { name: '启用浏览器自动化' }).click()
      await settings.getByText('127.0.0.1:1234').waitFor()
      assert.equal(await settings.getByText('ws://127.0.0.1:1234', { exact: false }).count(), 0)
      await settings.getByRole('button', { name: '复制 CDP 地址' }).click()
      await settings.getByText('CDP 地址已复制', { exact: false }).waitFor()
      await settings.getByRole('switch', { name: '停用浏览器自动化' }).click()
      await settings.getByText('CDP 访问已关闭', { exact: false }).waitFor()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { commands: { kind: string }[] }).commands),
        [
          { kind: 'automation', enabled: true },
          { kind: 'copy-endpoint' },
          { kind: 'automation', enabled: false },
        ]
      )
      await page.getByRole('button', { name: 'English' }).click()
      await expect(
        settings.getByText('External browser automation (CDP)', { exact: true })
      ).toBeVisible()
      await settings.getByRole('switch', { name: 'Enable browser automation' }).waitFor()
      await settings
        .getByText(
          'Allow the product Agent to read built-in browser pages after authorization. Separate from external Playwright/CDP access; manual browsing is unchanged. Initially enabled with Bing reading and navigation allowed; existing settings are preserved.'
        )
        .waitFor()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings reopen returns to the browser only after the typed bridge succeeds',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser-history')
      await settings.getByText('Paper Example').waitFor()
      await settings.getByRole('button', { name: '更多历史记录操作' }).click()
      await page.getByRole('menuitem', { name: '打开页面', exact: true }).click()
      await expect(settings).toHaveCount(0)
      await expect(page.getByTestId('browser-workspace')).toBeVisible()
      const requests = await page.evaluate(
        () => (window as unknown as { historyRequests: { kind: string }[] }).historyRequests
      )
      assert.ok(requests.some((request) => request.kind === 'reopen'))
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'late history reopen does not replace a settings page selected after the request',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history&pending-history-reopen',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '更多历史记录操作' }).click()
      await page.getByRole('menuitem', { name: '打开页面', exact: true }).click()
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { finishHistoryReopen?: () => void }).finishHistoryReopen ===
          'function'
      )
      await page.evaluate(() =>
        (window as unknown as { dismissSettings(): void }).dismissSettings()
      )
      await expect(page.getByTestId('other-settings-page')).toBeVisible()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
      await page.evaluate(() =>
        (window as unknown as { finishHistoryReopen(): void }).finishHistoryReopen()
      )
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { getHistoryReopenReplyCount(): number }
            ).getHistoryReopenReplyCount()
          )
        )
        .toBe(1)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { getReopenNavigationCount(): number }).getReopenNavigationCount()
          )
        )
        .toBe(0)
      await expect(page.getByTestId('other-settings-page')).toBeVisible()
      await expect(page.getByTestId('browser-workspace')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings search, delete and clear through the typed bridge',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser-history')
      await settings.getByText('Paper Example').waitFor()
      await settings.getByRole('searchbox', { name: '搜索标题或网址' }).fill('paper')
      await settings.getByRole('button', { name: '更多历史记录操作' }).click()
      await page.getByRole('menuitem', { name: '删除记录' }).click()
      await expect(
        settings.getByText(browserZh.settings.historyEmpty, { exact: true })
      ).toBeVisible()
      await expect(settings.getByRole('searchbox', { name: '搜索标题或网址' })).toHaveValue('paper')
      await expect(settings.getByTestId('browser-history-list')).toHaveCount(0)
      await openClearDialog(page)
      await page.getByRole('combobox', { name: '历史记录时间范围', exact: true }).click()
      await page.getByRole('option', { name: '全部历史', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除所选数据' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: browserZh.settings.clearDone })
      ).toBeVisible()
      const requests = await page.evaluate(() => ({
        history: (window as unknown as { historyRequests: unknown[] }).historyRequests,
        data: (window as unknown as { dataRequests: unknown[] }).dataRequests,
      }))
      assert.ok(
        requests.history.some((request: unknown) => (request as { kind: string }).kind === 'delete')
      )
      assert.deepEqual(requests.data[0], { kind: 'clear-selected', types: ['history'] })
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings select data categories without a time range for site data',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '清除浏览数据', exact: true }).click()
      const data = page.getByRole('alertdialog')
      await expect(data.getByRole('combobox', { name: '历史记录时间范围' })).toBeVisible()
      assert.equal(await data.getByRole('button', { name: '清除所选数据' }).isDisabled(), true)
      await data.getByRole('checkbox', { name: 'Cookie 和网站存储' }).click()
      await data.getByRole('checkbox', { name: '缓存' }).click()
      await data.getByRole('button', { name: '清除所选数据' }).click()
      const requests = await page.evaluate(
        () => (window as unknown as { dataRequests: unknown[] }).dataRequests
      )
      assert.deepEqual(requests.at(-1), {
        kind: 'clear-selected',
        types: ['cookies', 'storage', 'cache'],
      })
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings show history and clear failures beside their controls',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history&history-query-error&data-error',
          server.resolvedUrls!.local[0]
        ).href
      )
      const history = page.getByTestId('browser-settings-history')
      await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      await openClearDialog(page)
      await page.getByRole('alertdialog').getByRole('button', { name: '清除所选数据' }).click()
      await expect(page.getByTestId('browser-clear-error')).toHaveText('浏览器操作失败，请重试。')
      assert.equal(await page.getByTestId('browser-settings-cdp').getByRole('alert').count(), 0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test('browser history action failure stays in the history card', { timeout: 60_000 }, async () => {
  const server = await servers.create({
    cacheKey: 'browser',
    configFile: false,
    root: ROOT,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(
      new URL(
        '/features/browser/browser.render.fixture.html?settings&history&history-action-error',
        server.resolvedUrls!.local[0]
      ).href
    )
    const history = page.getByTestId('browser-settings-history')
    await history.getByRole('button', { name: '更多历史记录操作' }).click()
    await page.getByRole('menuitem', { name: '打开页面', exact: true }).click()
    await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
    await expect(page.getByTestId('account-settings-browser-history')).toBeVisible()
    await expect(page.getByTestId('browser-workspace')).toHaveCount(0)
    assert.equal(await page.getByTestId('browser-settings-cdp').getByRole('alert').count(), 0)
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'failed history search hides records from the previous query',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history&history-query-error-after-search',
          server.resolvedUrls!.local[0]
        ).href
      )
      const history = page.getByTestId('browser-settings-history')
      await history.getByText('Paper Example').waitFor()
      await history.getByRole('searchbox', { name: '搜索标题或网址' }).fill('bad')
      await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      await expect(history.getByTestId('browser-history-list')).toHaveCount(0)
      await history.getByRole('searchbox', { name: '搜索标题或网址' }).fill('Paper')
      await expect(history.getByText('Paper Example')).toBeVisible()
      await expect(history.getByRole('alert')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'returning to a prior history query does not reuse a successful stale result',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history&history-repeat-error',
          server.resolvedUrls!.local[0]
        ).href
      )
      const history = page.getByTestId('browser-settings-history')
      const search = history.getByRole('searchbox', { name: '搜索标题或网址' })
      await search.fill('Paper')
      await history.getByText('Paper Example').waitFor()
      await search.fill('bad')
      await expect(history.getByTestId('browser-history-list')).toHaveCount(0)
      await search.fill('Paper')
      await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      await expect(history.getByTestId('browser-history-list')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings manage Agent-only exact-origin rules without a persistent submit grant',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&advanced',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      const rules = page.getByTestId('browser-settings-agent-sites')
      await rules.getByText('暂无 Agent 网站规则。').waitFor()
      const agentUse = rules.getByRole('switch', { name: 'Agent Browser Use' })
      assert.equal(await agentUse.getAttribute('aria-checked'), 'false')
      await rules
        .getByText('Agent Browser Use 已关闭，以下站点规则不会授权 Agent 读取网页。')
        .waitFor()
      await agentUse.click()
      assert.equal(await agentUse.getAttribute('aria-checked'), 'true')
      await rules.getByRole('textbox', { name: '精确网站来源地址' }).fill('https://example.org')
      await rules.getByRole('button', { name: '添加规则' }).click()
      await rules.getByTestId('browser-agent-site-list').getByText('https://example.org').waitFor()
      assert.equal(
        await rules.getByRole('combobox', { name: 'https://example.org · 读取' }).textContent(),
        '允许'
      )
      await rules.getByRole('combobox', { name: 'https://example.org · 交互' }).click()
      await page.getByRole('option', { name: '阻止' }).click()
      assert.equal(
        await rules.getByRole('combobox', { name: 'https://example.org · 交互' }).textContent(),
        '阻止'
      )
      assert.equal(await rules.getByRole('combobox', { name: /提交/ }).count(), 0)
      await rules
        .getByText(
          '普通提交及其他可能产生后果的操作仍需单独确认；受限公开搜索表单仅在该站点的读取和交互规则均为“允许”时可自动提交。'
        )
        .waitFor()
      await rules.getByRole('button', { name: /移除/ }).click()
      await rules.getByText('暂无 Agent 网站规则。').waitFor()
      const requests = await page.evaluate(
        () =>
          (window as unknown as { policyRequests: Array<{ kind: string; action?: string }> })
            .policyRequests
      )
      assert.deepEqual(
        requests.map((request) => [request.kind, request.action]),
        [
          ['read', undefined],
          ['set-agent-use', undefined],
          ['set', 'read'],
          ['set', 'interact'],
          ['remove', undefined],
        ]
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'failed Agent Browser Use disable refreshes the authoritative off state',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'browser',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&advanced&pending-agent-disable',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      const rules = page.getByTestId('browser-settings-agent-sites')
      const agentUse = rules.getByRole('switch', { name: 'Agent Browser Use' })
      await agentUse.click()
      await agentUse.waitFor({ state: 'visible' })
      await agentUse.click()
      await rules
        .getByText('浏览器历史结果仍在发送中，设置变更尚未确认。请稍后刷新并重试。')
        .waitFor()
      assert.equal(await agentUse.getAttribute('aria-checked'), 'false')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
