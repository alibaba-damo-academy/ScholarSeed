import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { MenuModel } from '../../../../menu.ts'
import type { FindState } from '../../../../browser.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'actual Browser zoom model renders three horizontal menuitems, preserves keep-open focus and disables noisy endpoints',
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
      const product = await browser.newPage({ viewport: { width: 1280, height: 680 } })
      const scene = await browser.newPage({ viewport: { width: 1280, height: 680 } })
      await product.goto(
        new URL('/features/browser/browser.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await product.getByRole('button', { name: 'English', exact: true }).click()
      await product.evaluate(() =>
        (
          window as unknown as { updateActiveBrowserTab(changes: { zoomFactor: number }): void }
        ).updateActiveBrowserTab({ zoomFactor: 1.7499999999999998 })
      )
      await product.getByRole('button', { name: 'More browser features', exact: true }).click()
      await product.waitForFunction(
        () => (window as unknown as { menuModels: MenuModel[] }).menuModels.length > 0
      )
      let model = await product.evaluate(() =>
        (window as unknown as { menuModels: MenuModel[] }).menuModels.at(-1)!
      )
      assert.deepEqual(
        model.items.slice(0, 3).map((item) => item.id),
        ['browser.find', 'browser.print', 'browser.zoom']
      )
      await product.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await scene.goto(
        new URL('/features/browser/menu.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await expect(scene.getByRole('menu')).toBeVisible()
      await scene.evaluate(
        (next) => (window as unknown as { presentMenu(model: MenuModel): void }).presentMenu(next),
        model
      )
      const group = scene.getByRole('group', { name: 'Zoom', exact: true })
      await expect(group.getByText('Zoom', { exact: true })).toBeVisible()
      await expect(group.getByRole('menuitem')).toHaveCount(3)
      await expect(group.getByText('175%', { exact: true })).toBeVisible()
      const controls = [
        group.getByRole('menuitem', { name: 'Zoom out', exact: true }),
        group.getByRole('menuitem', { name: 'Zoom in', exact: true }),
        group.getByRole('menuitem', { name: 'Reset zoom', exact: true }),
      ]
      const bounds = await Promise.all(controls.map((control) => control.boundingBox()))
      assert.ok(
        bounds.every(
          (bound) =>
            bound &&
            Math.abs(bound.y + bound.height / 2 - (bounds[0]!.y + bounds[0]!.height / 2)) < 1
        )
      )
      assert.ok(bounds[0]!.x < bounds[1]!.x && bounds[1]!.x < bounds[2]!.x)
      const repaint = async (factor: number): Promise<void> => {
        const revision = model.revision
        await product.evaluate(
          (zoomFactor) =>
            (
              window as unknown as { updateActiveBrowserTab(changes: { zoomFactor: number }): void }
            ).updateActiveBrowserTab({ zoomFactor }),
          factor
        )
        await product.waitForFunction(
          (previous) =>
            (window as unknown as { menuModels: MenuModel[] }).menuModels.at(-1)!.revision >
            previous,
          revision
        )
        model = await product.evaluate(() =>
          (window as unknown as { menuModels: MenuModel[] }).menuModels.at(-1)!
        )
        await product.evaluate(() =>
          (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
        )
        await scene.evaluate(
          (next) =>
            (window as unknown as { presentMenu(model: MenuModel): void }).presentMenu(next),
          model
        )
        await expect(group.getByText(`${Math.round(factor * 100)}%`, { exact: true })).toBeVisible()
      }
      for (const [index, factor] of [1.5, 1.75, 1].entries()) {
        await controls[index].focus()
        await controls[index].press('Enter')
        await expect
          .poll(() =>
            scene.evaluate(() => (window as unknown as { menuEvents: unknown[] }).menuEvents.length)
          )
          .toBe(index + 1)
        const event = await scene.evaluate(() =>
          (
            window as unknown as {
              menuEvents: { kind: string; actionId: string; value: unknown }[]
            }
          ).menuEvents.at(-1)!
        )
        assert.equal(event.kind, 'action')
        assert.equal(event.actionId, 'browser.zoom')
        assert.deepEqual(event.value, { kind: 'number', value: factor })
        await repaint(Math.pow(1.2, Math.log(factor) / Math.log(1.2)))
        await expect(scene.getByRole('menu')).toBeVisible()
        if (index < 2) await expect(controls[index]).toBeFocused()
      }
      await expect(controls[2]).toBeDisabled()
      await repaint(4.999999999999999)
      await expect(controls[1]).toBeDisabled()
      await expect(controls[0]).toBeEnabled()
      await repaint(0.2500000000000001)
      await expect(controls[0]).toBeDisabled()
      await expect(controls[1]).toBeEnabled()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'native find React scene uses Popover positioning and shared focus, preserves selection on repaint, and suppresses IME submission',
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 680 } })
      await page.goto(
        new URL('/features/browser/menu.render.fixture.html?find', server.resolvedUrls!.local[0])
          .href
      )
      const input = page.getByRole('textbox', { name: 'Find in page' })
      await expect(input).toBeFocused()
      await expect(page.getByRole('menu')).toHaveCount(0)
      const bounds = await page.getByTestId('browser-find').boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1280 && bounds.y >= 72)
      await input.fill('needle')
      await page.evaluate(() =>
        (window as unknown as { emitFound(state: FindState): void }).emitFound({
          querySequence: 1,
          requestId: 1,
          phase: 'ready',
          ordinal: 1,
          count: 3,
          final: true,
        })
      )
      await expect(page.getByRole('status')).toHaveText('1 of 3')
      await input.evaluate((element) => (element as HTMLInputElement).setSelectionRange(1, 3))
      await page.evaluate(() =>
        (window as unknown as { updateMenu(revision: number): void }).updateMenu(2)
      )
      await expect
        .poll(() =>
          input.evaluate((element) => [
            (element as HTMLInputElement).selectionStart,
            (element as HTMLInputElement).selectionEnd,
          ])
        )
        .toEqual([1, 3])
      await expect(page.getByRole('status')).toHaveText('1 of 3')
      const before = await page.evaluate(
        () => (window as unknown as { menuEvents: unknown[] }).menuEvents.length
      )
      await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { menuEvents: unknown[] }).menuEvents.length
        ),
        before
      )
      await input.press('Shift+Enter')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { menuEvents: { direction?: string }[] }).menuEvents.at(-1)
                ?.direction
          )
        )
        .toBe('backward')
      await page.getByRole('button', { name: 'Close find' }).focus()
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await page.keyboard.press('Escape')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { menuEvents: { reason?: string }[] }).menuEvents.at(-1)?.reason
          )
        )
        .toBe('escape')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser tab bar extends the owning gray seam through trailing action without height or active-opening changes',
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
      for (const variation of [
        { query: '', width: 1280 },
        { query: '?empty-tabs', width: 1280 },
        { query: '', width: 1280, single: true },
        { query: '?many-tabs', width: 520 },
      ]) {
        const page = await browser.newPage({ viewport: { width: variation.width, height: 680 } })
        await page.goto(
          new URL(
            `/features/browser/browser.render.fixture.html${variation.query}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        const workspace = page.getByTestId('browser-workspace')
        await expect(workspace).toBeVisible()
        if (variation.single) {
          await page.getByRole('tab', { name: 'Second' }).hover()
          await page.getByRole('button', { name: '关闭 Second' }).click()
        }
        const bar = workspace.locator('.vds-navigation-tabs__bar')
        await expect(bar).toBeVisible({ timeout: 2000 })
        const geometry = await bar.evaluate((element) => {
          const list = element.querySelector('[role="tablist"]') as HTMLElement
          const action = element.querySelector('button[aria-label="打开新的标签页"]') as HTMLElement
          const bounds = element.getBoundingClientRect()
          const listBounds = list.getBoundingClientRect()
          return {
            right: bounds.right,
            bottom: bounds.bottom,
            height: bounds.height,
            listRight: listBounds.right,
            listBottom: listBounds.bottom,
            actionLeft: action.getBoundingClientRect().left,
            actionRight: action.getBoundingClientRect().right,
            background: getComputedStyle(element).backgroundImage,
            divider: getComputedStyle(
              list.querySelector('[aria-selected="true"] [class*="border-b-0"]')!
            ).borderTopColor,
            expectedHeight: parseFloat(
              getComputedStyle(element).getPropertyValue('--vds-workbench-header-height')
            ),
            activeBackground: getComputedStyle(list.querySelector('[aria-selected="true"]')!)
              .backgroundColor,
          }
        })
        const workspaceBounds = await workspace.boundingBox()
        assert.equal(geometry.right, workspaceBounds!.x + workspaceBounds!.width)
        assert.equal(geometry.height, geometry.expectedHeight)
        assert.equal(geometry.bottom, geometry.listBottom)
        assert.equal(geometry.actionLeft, geometry.listRight)
        assert.ok(geometry.actionRight <= geometry.right)
        assert.match(geometry.background, /linear-gradient/)
        assert.ok(geometry.background.includes(geometry.divider))
        assert.notEqual(geometry.activeBackground, 'rgba(0, 0, 0, 0)')
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser more menu entrance awaits native paint without duplicate DOM or webpage layout change',
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
      const more = page.getByRole('button', { name: '更多浏览器功能', exact: true })
      await expect(more).toBeVisible({ timeout: 2000 })
      const before = await page.locator('[data-browser-viewport]').boundingBox()
      await more.click()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('menu')).toHaveCount(0)
      assert.deepEqual(await page.locator('[data-browser-viewport]').boundingBox(), before)
      await page.waitForFunction(
        () => (window as unknown as { menuModels: unknown[] }).menuModels.length === 1
      )
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('menu')).toHaveCount(0)
      assert.deepEqual(await page.locator('[data-browser-viewport]').boundingBox(), before)
      await page.evaluate(() =>
        (window as unknown as { revokeMenu(reason: string): void }).revokeMenu('escape')
      )
      await expect(more).toBeFocused()
      await page.setViewportSize({ width: 920, height: 680 })
      const resized = await page.locator('[data-browser-viewport]').boundingBox()
      await more.click()
      await page.waitForFunction(
        () => (window as unknown as { menuModels: unknown[] }).menuModels.length === 2
      )
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { menuModels: MenuModel[] }).menuModels[1].viewport
        ),
        { width: 920, height: 680 }
      )
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(false)
      )
      await expect(page.getByText('浏览器操作失败，请重试。', { exact: true })).toBeVisible()
      assert.deepEqual(await page.locator('[data-browser-viewport]').boundingBox(), resized)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'browser settings consumes exact revoked action lease into existing settings entry',
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
      const more = page.getByRole('button', { name: '更多浏览器功能', exact: true })
      await more.click()
      await page.waitForFunction(
        () => (window as unknown as { menuModels: unknown[] }).menuModels.length === 1
      )
      assert.equal(
        await page.evaluate(() =>
          (window as unknown as { menuModels: MenuModel[] }).menuModels[0].items.some(
            (item) =>
              item.kind === 'action' && item.actionId === 'browser.devtools' && item.disabled
          )
        ),
        true
      )
      await page.evaluate(() =>
        (window as unknown as { finishMenu(ok: boolean): void }).finishMenu(true)
      )
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await page.evaluate(() =>
        (window as unknown as { menuAction(actionId: string): void }).menuAction('browser.settings')
      )
      await expect(page.getByTestId('browser-workspace')).toHaveCount(0)
      await expect(page.getByRole('switch')).not.toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'actual React menu skips disabled items, submenu Escape precedes root Escape and keeps update focus',
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
        new URL('/features/browser/menu.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const tools = page.getByRole('menuitem', { name: 'Tools' })
      await expect(tools).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitemcheckbox', { name: 'Developer tools' })).toHaveAttribute(
        'aria-checked',
        'true',
        { timeout: 2000 }
      )
      await page.keyboard.press('Escape')
      await expect(tools).toBeFocused()
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { menuEvents: unknown[] }).menuEvents.length
        ),
        0
      )
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitemcheckbox', { name: 'Developer tools' })).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(tools).toBeFocused()
      await expect(page.getByRole('menuitemcheckbox', { name: 'Developer tools' })).toHaveCount(0)
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('menuitem', { name: 'Browser settings' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(tools).toBeFocused({ timeout: 2000 })
      await page.keyboard.press('Shift+Tab')
      await expect(page.getByRole('menuitem', { name: 'Browser settings' })).toBeFocused()
      await page.evaluate(() =>
        (window as unknown as { updateMenu(revision: number): void }).updateMenu(2)
      )
      await expect(page.getByRole('menuitem', { name: 'Browser settings 2' })).toBeFocused()
      await page.evaluate(() => (document.activeElement as HTMLElement).blur())
      await page.keyboard.press('Escape')
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { menuEvents: unknown[] }).menuEvents)
        )
        .toEqual([{ kind: 'dismiss', sessionId: 'fixture', revision: 2, reason: 'escape' }])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'outside first click only dismisses actual React menu and never replays it',
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
        new URL('/features/browser/menu.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('menuitem', { name: 'Tools' }).waitFor()
      await page.evaluate(() => {
        Object.assign(window, { outsideClicks: 0 })
        document.body.addEventListener('click', () => {
          ;(window as unknown as { outsideClicks: number }).outsideClicks += 1
        })
      })
      await page.mouse.click(10, 300)
      assert.equal(
        await page.evaluate(() => (window as unknown as { outsideClicks: number }).outsideClicks),
        0
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { menuEvents: unknown[] }).menuEvents),
        [{ kind: 'dismiss', sessionId: 'fixture', revision: 1, reason: 'outside' }]
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
