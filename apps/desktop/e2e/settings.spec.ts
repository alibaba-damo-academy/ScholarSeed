import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../src/window'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const SETTINGS_PAGES = [
  { tab: 'notifications', page: 'notifications' },
  { tab: 'prompts', page: 'prompts' },
  { tab: 'models', page: 'model-configuration' },
  { tab: 'developer', page: 'developer' },
  { tab: 'browser', page: 'browser' },
  { tab: 'files', page: 'files' },
  // { tab: 'shortcuts', page: 'shortcuts' }, // 暂时随「键盘快捷键」页面隐藏。
  { tab: 'archives', page: 'archives' },
  { tab: 'about', page: 'about' }
] as const
const SETTINGS_VIEWPORTS = [
  WORKSPACE_WINDOW_SIZE,
  WORKSPACE_WINDOW_MINIMUM,
] as const
const SCROLL_DISTANCE = 1200
const GEOMETRY_TOLERANCE = 1
const PREFERENCES_FILE = 'renderer-preferences.json'
const VERSION_SCREENSHOTS = resolve('../../tmp/test_snapshot/desktop/about-version')
const SELECTION_INSET = 2
const SELECTION_STEPS = 20

test('about version copies native system information and supports mouse text selection', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
  writeFileSync(preferencesPath, JSON.stringify({ ...preferences, theme: 'system' }))
  const desktop = new DesktopSession(runtime, testInfo, { nativeWindowLifecycle: true })
  mkdirSync(VERSION_SCREENSHOTS, { recursive: true })
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(({ app, BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('menu.html'))!
      main.setSize(size.width, size.height)
      main.show()
      main.focus()
      app.focus({ steal: true })
    }, WORKSPACE_WINDOW_SIZE)
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await page.getByTestId('activity-account').evaluate(element => (element as HTMLElement).click())
    await expect.poll(async () => {
      for (const window of desktop.app!.windows()) {
        if (await window.getByTestId('account-menu-settings').isVisible().catch(() => false)) return true
      }
      return false
    }).toBe(true)
    for (const window of desktop.app!.windows()) {
      const settings = window.getByTestId('account-menu-settings')
      if (await settings.isVisible().catch(() => false)) {
        await settings.evaluate((element: HTMLElement) => element.click())
        break
      }
    }
    await page.getByTestId('account-settings-nav-about').click()
    const version = page.getByTestId('version-current')
    const copy = page.getByTestId('version-copy')
    await expect(version).toBeVisible()
    const identity = await page.evaluate(() => ({
      version: `${window.scholarseed.version}-${window.scholarseed.buildNumber}`,
      system: window.scholarseed.systemVersion,
    }))
    await expect(version).toContainText(identity.version)
    const native = await desktop.app!.evaluate(() => ({
      version: process.getSystemVersion(),
      architecture: process.arch,
    }))
    expect(identity.system).toContain(native.version)
    expect(identity.system).toContain(native.architecture)
    const expected = `${await version.innerText()}\n${identity.system}`
    await copy.click()
    await expect(copy).toHaveAttribute('aria-label', '已复制')
    expect(await desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected)
    await page.screenshot({ path: join(VERSION_SCREENSHOTS, 'copied.png') })
    await expect(version).toHaveCSS('user-select', 'text')
    const textBounds = await version.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return Array.from(range.getClientRects(), rectangle => ({
        x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
      }))
    })
    const firstLine = textBounds[0]
    const lastLine = textBounds[textBounds.length - 1]
    await page.mouse.move(firstLine.x + SELECTION_INSET, firstLine.y + firstLine.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastLine.x + lastLine.width + SELECTION_INSET, lastLine.y + lastLine.height / 2, { steps: SELECTION_STEPS })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain(identity.version)
    await page.screenshot({ path: join(VERSION_SCREENSHOTS, 'selected.png') })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain(identity.version)
    await copy.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected)
    await desktop.app!.evaluate(({ BrowserWindow }, minimum) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('menu.html'))!
      main.setSize(minimum.width, minimum.height)
    }, WORKSPACE_WINDOW_MINIMUM)
    await expect(copy).toBeVisible()
    await copy.click()
    await expect(copy).toHaveAttribute('aria-label', '已复制')
    await page.screenshot({ path: join(VERSION_SCREENSHOTS, 'minimum.png') })
    await page.evaluate(async () => {
      const current = await window.scholarseed.reconcilePreferences()
      await window.scholarseed.savePreferences({ ...current, theme: 'dark' })
    })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('version-copy')).toBeVisible()
    await page.screenshot({ path: join(VERSION_SCREENSHOTS, 'dark.png') })
  } finally {
    await desktop.app?.evaluate(({ app }) => app.exit())
    await desktop.attachArtifacts()
  }
})

test('settings keep titles and descriptions fixed while only their content scrolls', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
  writeFileSync(preferencesPath, JSON.stringify({
    ...preferences,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    const shell = page.getByTestId('account-settings-shell')
    await expect(shell).toBeVisible()
    await expect(shell.getByTestId('account-settings-nav-mcp')).toHaveCount(0)
    await expect(shell.getByTestId('mcp-settings')).toHaveCount(0)
    for (const viewport of SETTINGS_VIEWPORTS) {
      await page.setViewportSize(viewport)
      for (const entry of SETTINGS_PAGES) {
        await page.getByTestId(`account-settings-nav-${entry.tab}`).click()
        const surface = page.getByTestId(entry.tab === 'about' ? 'about-settings-page' : `account-settings-${entry.page}`)
        const header = surface.locator(':scope > [data-slot="page-header"]')
        const body = surface.locator(':scope > [data-slot="page-body"]')
        await expect(header).toBeVisible()
        await expect(body).toBeVisible()
        const before = await header.boundingBox()
        expect(before).not.toBeNull()
        await body.hover()
        await page.mouse.wheel(0, SCROLL_DISTANCE)
        await expect.poll(async () => {
          const after = await header.boundingBox()
          return Math.abs((after?.y ?? Infinity) - before!.y)
        }).toBeLessThan(GEOMETRY_TOLERANCE)
        await expect(header.locator('h1')).toBeVisible()
        await expect(header.locator('p')).toBeVisible()
        expect(await shell.locator('main').evaluate(element => element.scrollTop)).toBe(0)
        if (entry.tab === 'prompts') {
          await page.screenshot({ path: join(runtime.artifacts, `settings-${entry.tab}-${viewport.width}.png`) })
        }
      }
      await page.getByTestId('account-settings-nav-skills').click()
      await expect(page.getByTestId('account-settings-skills')).toBeVisible()
      const catalog = JSON.parse(readFileSync(
        join(__dirname, '../../serve/service/capabilities/catalog.json'), 'utf8'
      ))
      for (const name of catalog.surfaces.settings.skills) {
        await expect(page.getByTestId(`skill-card-${name}`)).toBeVisible()
      }
      await page.screenshot({ path: join(runtime.artifacts, `settings-skills-${viewport.width}.png`) })
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
