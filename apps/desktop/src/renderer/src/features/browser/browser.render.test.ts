import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { BrowserCommand } from '../../../../browser.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'browser tab drag activates the pressed tab and preserves it through reorder and snapshot updates while keyboard navigation follows visual order',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
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
      const bar = workspace.getByRole('tablist')
      await expect(bar.getByRole('tab', { selected: true })).toContainText('First')
      await bar
        .getByRole('tab', { name: /Second/ })
        .dragTo(bar.getByRole('tab', { name: /First/ }), { targetPosition: { x: 2, y: 16 } })
      await expect(bar.getByRole('tab')).toHaveText(['Second', 'First'])
      await expect(bar.getByRole('tab', { selected: true })).toContainText('Second')
      await workspace.getByRole('button', { name: '刷新', exact: true }).click()
      await expect(bar.getByRole('tab')).toHaveText(['Second', 'First'])
      await expect(bar.getByRole('tab', { selected: true })).toContainText('Second')
      await bar.getByRole('tab', { selected: true }).press('Home')
      await expect(bar.getByRole('tab', { selected: true })).toContainText('Second')
      await bar.getByRole('tab', { selected: true }).press('End')
      await expect(bar.getByRole('tab', { selected: true })).toContainText('First')
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      for (const name of ['打开新的标签页', '浏览器提示与状态', '更多浏览器功能']) {
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      const more = workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      const help = workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      const tooltip = page.getByRole('tooltip')
      for (const width of [1280, 480]) {
        await page.setViewportSize({ width, height: 800 })
        for (const trigger of ['hover', 'keyboard']) {
          if (trigger === 'hover') await more.hover()
          else {
            await page.mouse.move(0, 0)
            await help.focus()
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
  'compact toolbar keeps loading and feedback geometry stable and exposes help on hover and focus',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      const help = workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      const viewport = workspace.getByTestId('browser-viewport')
      const address = workspace.getByRole('textbox', { name: '网址', exact: true })
      await expect(reload).toBeEnabled()
      const original = await viewport.boundingBox()
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ loading: true })
      )
      await expect(reload).toBeDisabled()
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
      await expect(help).not.toHaveAttribute('title')
      await help.hover()
      await expect(page.getByRole('tooltip')).toContainText('输入网址后按 Enter')
      assert.deepEqual(await viewport.boundingBox(), original)
      await address.fill('bad:address')
      await address.press('Enter')
      await expect(workspace.getByRole('alert')).toHaveText('请输入有效的 HTTP 或 HTTPS 网址。')
      assert.deepEqual(await viewport.boundingBox(), original)
      await help.focus()
      await expect(help).toBeFocused()
      await expect(page.getByRole('tooltip')).toHaveText('请输入有效的 HTTP 或 HTTPS 网址。')
      await expect(help).toHaveAccessibleDescription(/请输入有效的 HTTP 或 HTTPS 网址/)
      await page.getByRole('button', { name: 'English', exact: true }).click()
      const englishHelp = workspace.getByRole('button', {
        name: 'Browser help and status',
        exact: true,
      })
      const englishAddress = workspace.getByRole('textbox', { name: 'Address', exact: true })
      await englishHelp.focus()
      await expect(page.getByRole('tooltip')).toHaveText('Enter a valid HTTP or HTTPS address.')
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ navigationError: null, cdpStatus: 'connected' })
      )
      await englishAddress.fill('https://example.org')
      await englishAddress.press('Enter')
      await englishHelp.focus()
      await expect(page.getByRole('tooltip')).toHaveText(
        'This page is controlled by an external program'
      )
      await page.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: object): void }
        ).updateActiveBrowserTab({ cdpStatus: 'devtools_conflict' })
      )
      await expect(page.getByRole('tooltip')).toHaveText(
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
      await englishHelp.hover()
      await expect(
        page.getByRole('tooltip').filter({ hasText: 'Developer tools now control' })
      ).toHaveCount(0)
      assert.deepEqual(await viewport.boundingBox(), original)
      await page.evaluate(() => (window as unknown as { menuFailure(): void }).menuFailure())
      await englishHelp.focus()
      await expect(page.getByRole('tooltip')).toContainText(
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      for (const displayed of [false, true]) {
        const page = await browser.newPage()
        await page.goto(
          new URL(
            '/features/browser/browser.render.fixture.html?native-tooltip',
            server.resolvedUrls!.local[0]
          ).href
        )
        await page.getByRole('tab', { name: 'First' }).waitFor()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('tab', { name: 'First' }).waitFor()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      const tooltip = page.getByRole('tooltip', { name: 'Animated browser tooltip' })
      await tooltip.evaluate((element) => {
        const bounds = document.querySelector('[data-browser-viewport]')!.getBoundingClientRect()
        Object.assign((element as HTMLElement).style, {
          animation: 'none',
          position: 'fixed',
          left: `${bounds.left}px`,
          top: `${bounds.top - element.getBoundingClientRect().height + 3}px`,
        })
      })
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
  'browser toolbar icons retain accessible actions and new tab follows the tab track',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const workspace = page.getByTestId('browser-workspace')
      const add = workspace.getByRole('button', { name: '打开新的标签页', exact: true })
      await expect(add).toBeVisible()
      const followsLastTab = async (): Promise<void> => {
        const last = await workspace.getByRole('tab').last().boundingBox()
        const button = await add.boundingBox()
        assert.ok(last && button)
        assert.ok(button.x >= last.x + last.width)
        assert.ok(button.x - last.x - last.width <= 24)
        assert.equal(button.width, button.height)
        assert.equal(await add.evaluate((element) => getComputedStyle(element).borderRadius), '50%')
      }
      await followsLastTab()
      await add.hover()
      const addTooltip = page.getByRole('tooltip').filter({ hasText: '打开新的标签页' })
      await expect(addTooltip).toBeVisible()
      await expect(addTooltip).toHaveAttribute('data-side', 'bottom')
      await workspace.getByRole('tab', { name: 'Second' }).hover()
      await workspace.getByRole('button', { name: '关闭 Second' }).click()
      await followsLastTab()
      const help = workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      const tools = workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      assert.equal((await help.textContent())?.trim(), '')
      assert.equal((await tools.textContent())?.trim(), '')
      await expect(help.locator('svg')).toHaveCount(1)
      await expect(tools.locator('svg.lucide-ellipsis')).toHaveCount(1)
      await expect(help).toHaveAttribute('type', 'button')
      await expect(tools).toHaveAttribute('type', 'button')
      await expect(tools).toHaveAttribute('aria-expanded', 'false')
      await expect(tools).toHaveAttribute('aria-haspopup', 'menu')
      await tools.click()
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(tools).toHaveAttribute('aria-expanded', 'true')
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
      await expect(workspace.getByRole('button', { name: 'Open a new tab' })).toBeVisible()
      await expect(workspace.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0)
      await expect(
        workspace.getByRole('button', { name: 'Browser help and status', exact: true })
      ).toBeEnabled()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
  'new tab remains visible beside overflowing tabs and toolbar disabled states are preserved',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 660 } })
      const fixture = new URL(
        '/features/browser/browser.render.fixture.html',
        server.resolvedUrls!.local[0]
      )
      await page.goto(`${fixture.href}?many-tabs`)
      const workspace = page.getByTestId('browser-workspace')
      const add = workspace.getByRole('button', { name: '打开新的标签页', exact: true })
      await expect(add).toBeInViewport()
      const track = workspace.getByRole('tablist')
      await expect
        .poll(() => track.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true)
      const button = await add.boundingBox()
      assert.ok(button && button.x + button.width <= 480)
      await workspace.getByRole('tab').first().press('End')
      await expect(workspace.getByRole('tab').last()).toBeInViewport()
      await expect(add).toBeInViewport()
      await add.click()
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { commands: BrowserCommand[] }).commands.some(
              (command) => command.kind === 'open'
            )
          )
        )
        .toBe(true)
      await page.goto(`${fixture.href}?empty-tabs`)
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toBeEnabled()
      await expect(
        workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toBeEnabled()
      await expect(add).toBeEnabled()
      await page.goto(`${fixture.href}?slow`)
      await add.click()
      await expect(add).toBeDisabled()
      await expect(
        workspace.getByRole('button', { name: '更多浏览器功能', exact: true })
      ).toBeDisabled()
      await page.goto(`${fixture.href}?web`)
      await expect(add).toBeDisabled()
      await expect(
        workspace.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toBeEnabled()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const address = page.getByRole('textbox', { name: '网址', exact: true })
      await expect(page.getByRole('tab', { name: 'First', selected: true })).toBeVisible()
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
            overlayModels: import('../../../../overlay').BrowserOverlayModel[]
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await expect(overlay.getByRole('status')).toHaveText('没有匹配的浏览历史。')
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
      await expect(overlay.getByRole('status')).toHaveText('No matching browsing history.')
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await page.getByRole('tab', { name: 'Second' }).click()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await expect(
        page.getByRole('button', { name: '浏览器提示与状态', exact: true })
      ).toBeFocused()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
  'empty browser shows a localized start tab without creating a native target',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?empty-tabs',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(
        page.getByRole('tab', { name: '新标签页', exact: true, selected: true })
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: '欢迎使用内置浏览器' })).toBeVisible()
      await expect(page.getByRole('button', { name: '关闭 新标签页', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '输入网址开始浏览', exact: true }).click()
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
      await expect(
        page.getByRole('tab', { name: 'New tab', exact: true, selected: true })
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'Welcome to the built-in browser' })
      ).toBeVisible()
      await expect(page.getByText('CDP automation', { exact: true })).toBeVisible()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('tab', { name: 'First' }).waitFor()
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
  'closing the last webpage returns to the browser start page',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByTestId('browser-start-page')).toHaveCount(0)
      await page.getByRole('tab', { name: 'First' }).hover()
      await page.getByRole('button', { name: '关闭 First', exact: true }).click()
      await page.getByRole('tab', { name: 'Second' }).hover()
      await page.getByRole('button', { name: '关闭 Second', exact: true }).click()
      await expect(
        page.getByRole('tab', { name: '新标签页', exact: true, selected: true })
      ).toBeVisible()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await page.getByRole('tab', { name: 'Second', selected: true }).waitFor()
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
      await page.getByRole('tab', { name: 'First', selected: true }).waitFor()
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
      await page.getByRole('tab', { name: 'Second', selected: true }).waitFor()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await page.getByTestId('browser-workspace').getByRole('alert').waitFor()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test('blank Electron tab title uses localized new-tab label', { timeout: 60_000 }, async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(
      new URL(
        '/features/browser/browser.render.fixture.html?blank-title',
        server.resolvedUrls!.local[0]
      ).href
    )
    const tab = page.getByTestId('browser-workspace').getByRole('tab', { selected: true })
    await tab.getByText('新标签页').waitFor()
    await page.getByRole('button', { name: 'English' }).click()
    await tab.getByText('New tab').waitFor()
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'first navigation keeps the typed address while its new native tab has not committed',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await page.getByTestId('browser-workspace').getByRole('tab', { selected: true }).waitFor()
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      assert.equal(await address.inputValue(), 'example.com')
      await page.evaluate(() => (window as unknown as { finishOpen(): void }).finishOpen())
      await page.getByTestId('browser-workspace').getByRole('tab', { selected: true }).waitFor()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await page.getByTestId('browser-workspace').getByRole('tab', { selected: true }).waitFor()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      assert.equal(await page.getByTestId('contribution').textContent(), '')
      await page.getByRole('tab', { name: 'First' }).waitFor()
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
      await page.getByRole('tab', { name: 'First' }).focus()
      await page.getByRole('tab', { name: 'First' }).press('ArrowRight')
      await page.waitForFunction(() => document.activeElement?.textContent?.includes('Second'))
      await page.getByRole('tab', { name: 'Second' }).press('ArrowLeft')
      await page.waitForFunction(() => document.activeElement?.textContent?.includes('First'))
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
      await page.getByRole('tab', { name: 'Second' }).click()
      await page.getByRole('button', { name: '关闭 Second' }).click()
      await page.getByRole('button', { name: '打开新的标签页' }).click()
      const commands = await page.evaluate(() =>
        (window as unknown as { commands: { kind: string }[] }).commands.filter(
          (command) => command.kind !== 'bounds'
        )
      )
      assert.deepEqual(commands, [
        { kind: 'select', tabId: 'second' },
        { kind: 'select', tabId: 'first' },
        { kind: 'navigate', tabId: 'first', input: 'example.com' },
        { kind: 'back', tabId: 'first' },
        { kind: 'forward', tabId: 'first' },
        { kind: 'reload', tabId: 'first' },
        { kind: 'devtools', tabId: 'first', open: true },
        { kind: 'select', tabId: 'second' },
        { kind: 'close', tabId: 'second' },
        { kind: 'open' },
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
        new URL('/features/browser/browser.render.fixture.html?slow', server.resolvedUrls!.local[0])
          .href
      )
      await page.getByRole('button', { name: '打开新的标签页' }).click()
      assert.equal(await page.getByRole('button', { name: '关闭 First' }).isDisabled(), true)
      assert.equal(await page.getByRole('tab', { name: 'Second' }).isDisabled(), true)
      await page.evaluate(() => (window as unknown as { finishOpen(): void }).finishOpen())
      await page.getByRole('tab', { name: 'First' }).hover()
      await page.getByRole('button', { name: '关闭 First' }).click()
      await page.getByRole('tab', { name: 'First' }).waitFor({ state: 'detached' })
      await page.goto(
        new URL('/features/browser/browser.render.fixture.html?web', server.resolvedUrls!.local[0])
          .href
      )
      await page
        .getByTestId('browser-workspace')
        .getByRole('alert')
        .filter({ hasText: '内置浏览器仅在桌面端可用。' })
        .waitFor()
      assert.equal(await page.getByRole('button', { name: '打开新的标签页' }).isDisabled(), true)
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await address.fill('private research phrase')
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await expect(option).toBeFocused()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
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
      await expect(page.getByRole('heading', { name: '历史记录', exact: true })).toBeVisible()
      await expect(page.getByTestId('browser-settings-cdp')).toHaveCount(0)
      await expect(page.getByTestId('browser-settings-history')).toHaveCount(1)
      await expect(page.getByText('Paper Example')).toBeVisible()
      await page.getByRole('button', { name: 'English' }).click()
      await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Back to browser settings' }).click()
      await expect(page.getByTestId('browser-settings-cdp')).toBeVisible()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser')
      await settings
        .getByText(
          'Agent 导航的网页使用独立会话，禁止下载且不继承手动浏览的登录状态；其他手动标签的下载不受影响。'
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
          'Pages navigated by Agent use a separate session that blocks downloads and does not inherit manual browsing sign-ins. Downloads in other manual tabs are unaffected.'
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser')
      await settings.getByText('Paper Example').waitFor()
      await settings.getByRole('button', { name: '重新打开' }).click()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&pending-history-reopen',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page
        .getByTestId('browser-settings-history')
        .getByRole('button', { name: '重新打开' })
        .click()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const settings = page.getByTestId('account-settings-browser')
      await settings.getByText('Paper Example').waitFor()
      await settings.getByRole('searchbox', { name: '搜索标题或网址' }).fill('paper')
      await settings.getByRole('button', { name: '删除记录' }).click()
      await settings.getByText('没有浏览记录。').waitFor()
      await settings.getByRole('button', { name: '清除' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除' }).click()
      await settings.getByText('浏览数据已清除。').waitFor()
      const requests = await page.evaluate(() => ({
        history: (window as unknown as { historyRequests: unknown[] }).historyRequests,
        data: (window as unknown as { dataRequests: unknown[] }).dataRequests,
      }))
      assert.ok(
        requests.history.some((request: unknown) => (request as { kind: string }).kind === 'delete')
      )
      assert.equal((requests.data[0] as { kind: string }).kind, 'clear-history')
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
      const data = page.getByTestId('browser-settings-data')
      await data.getByRole('combobox', { name: '清除范围' }).click()
      await page.getByRole('option', { name: '按类型清除（全部时间）' }).click()
      await data
        .getByText(
          '按站点或类型清理只作用于手动浏览的持久会话，但会关闭该会话中的全部网页标签。本地临时网页和 Agent 独立会话不受影响。'
        )
        .waitFor()
      assert.equal(await data.getByRole('button', { name: '清除' }).isDisabled(), true)
      await data.getByRole('checkbox', { name: 'Cookie' }).click()
      await data.getByRole('checkbox', { name: '缓存' }).click()
      await data.getByRole('button', { name: '清除' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除' }).click()
      const requests = await page.evaluate(
        () => (window as unknown as { dataRequests: unknown[] }).dataRequests
      )
      assert.deepEqual(requests.at(-1), { kind: 'clear-selected', types: ['cookies', 'cache'] })
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history-query-error&data-error',
          server.resolvedUrls!.local[0]
        ).href
      )
      const history = page.getByTestId('browser-settings-history')
      const data = page.getByTestId('browser-settings-data')
      await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      await data.getByRole('button', { name: '清除' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '清除' }).click()
      await expect(data.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
      assert.equal(await page.getByTestId('browser-settings-cdp').getByRole('alert').count(), 0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test('browser history action failure stays in the history card', { timeout: 60_000 }, async () => {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(
      new URL(
        '/features/browser/browser.render.fixture.html?settings&history-action-error',
        server.resolvedUrls!.local[0]
      ).href
    )
    const history = page.getByTestId('browser-settings-history')
    await history.getByRole('button', { name: '重新打开' }).click()
    await expect(history.getByRole('alert')).toHaveText('浏览器操作失败，请重试。')
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history-query-error-after-search',
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&history-repeat-error',
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings',
          server.resolvedUrls!.local[0]
        ).href
      )
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
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/features/browser/browser.render.fixture.html?settings&pending-agent-disable',
          server.resolvedUrls!.local[0]
        ).href
      )
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
