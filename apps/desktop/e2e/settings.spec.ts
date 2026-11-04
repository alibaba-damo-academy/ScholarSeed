import { openAccountMenu, openAccountSettings } from './fixtures/menu'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { defaultSelectionPrompts, SELECTION_PROMPT_ACTIONS } from '../src/prompts'
import type { PreferenceLanguage } from '../src/preferences'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../src/window'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => {
  skipQuarantined(testInfo)
})

const SETTINGS_PAGES = [
  { tab: 'notifications', page: 'notifications' },
  { tab: 'prompts', page: 'prompts' },
  { tab: 'models', page: 'model-configuration' },
  { tab: 'developer', page: 'developer' },
  { tab: 'browser', page: 'browser' },
  { tab: 'files', page: 'files' },
  // { tab: 'shortcuts', page: 'shortcuts' }, // 暂时随「键盘快捷键」页面隐藏。
  { tab: 'archives', page: 'archives' },
  { tab: 'about', page: 'about' },
] as const
const SETTINGS_VIEWPORTS = [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM] as const
const SCROLL_DISTANCE = 1200
const GEOMETRY_TOLERANCE = 1
const PREFERENCES_FILE = 'renderer-preferences.json'
const VERSION_SCREENSHOTS = resolve('../../tmp/test_snapshot/desktop/about-version')
const SELECTION_INSET = 2
const SELECTION_STEPS = 20
const PROMPT_SNAPSHOTS = resolve('../../tmp/test_snapshot/ai-prompts')
const PROMPT_LIFECYCLE_TIMEOUT_MS = 180_000

async function openPromptSettings(page: Page): Promise<void> {
  await openAccountSettings(page)
  await page.getByTestId('account-settings-nav-prompts').click()
  await expect(page.getByTestId('selection-prompt-explain')).toBeVisible()
}

async function changePromptLanguage(page: Page, language: PreferenceLanguage): Promise<void> {
  const settings = page.getByRole('dialog', { name: /设置|Settings/, exact: true })
  if (await settings.isVisible())
    await settings.getByRole('button', { name: /关闭|Close/, exact: true }).click()
  const menu = await openAccountMenu(page)
  await menu.getByTestId('account-menu-language').click()
  await menu
    .getByRole('menuitemradio', { name: language === 'en' ? 'English' : '简体中文', exact: true })
    .click()
  await expect(page.locator('html')).toHaveAttribute('lang', language === 'en' ? 'en-US' : 'zh-CN')
}

for (const scenario of [
  {
    name: 'English',
    language: 'en' as const,
    timeZone: 'Europe/London',
    resetLanguage: 'zh' as const,
  },
  {
    name: 'Chinese',
    language: 'zh' as const,
    timeZone: 'Asia/Shanghai',
    resetLanguage: 'en' as const,
  },
]) {
  test(`AI prompts initialize in ${scenario.name} and only an explicitly saved reset survives restart`, async ({}, testInfo) => {
    test.setTimeout(PROMPT_LIFECYCLE_TIMEOUT_MS)
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
    rmSync(preferencesPath)
    mkdirSync(PROMPT_SNAPSHOTS, { recursive: true })
    const originalTimeZone = process.env.TZ
    process.env.TZ = scenario.timeZone
    const desktop = new DesktopSession(runtime, testInfo, {
      nativeWindowLifecycle: true,
      preserveNavigation: true,
      recordTrace: false,
    })
    const readPreferences = () =>
      existsSync(preferencesPath) ? JSON.parse(readFileSync(preferencesPath, 'utf8')) : null
    try {
      let page = await desktop.launch()
      const landing = page.getByTestId('landing-dialog')
      await expect(landing).toBeVisible()
      await page.getByTestId('landing-skip').click()
      await expect(landing).toHaveCount(0)
      const guide = page.locator('[data-ob="guide-home"]')
      await expect(guide).toBeVisible()
      await guide.getByRole('button', { name: /跳过引导|Skip the guide/, exact: true }).click()
      await expect(guide).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        scenario.language === 'en' ? 'en-US' : 'zh-CN'
      )
      await openPromptSettings(page)
      const initial = defaultSelectionPrompts(scenario.language)
      for (const action of SELECTION_PROMPT_ACTIONS)
        await expect(page.getByTestId(`selection-prompt-${action}`)).toHaveValue(initial[action])
      await page.screenshot({ path: join(PROMPT_SNAPSHOTS, `${scenario.language}-initial.png`) })
      await changePromptLanguage(page, scenario.resetLanguage)
      await openPromptSettings(page)
      for (const action of SELECTION_PROMPT_ACTIONS)
        await expect(page.getByTestId(`selection-prompt-${action}`)).toHaveValue(initial[action])
      await expect.poll(() => readPreferences()?.selectionPrompts).toEqual(initial)
      await page.getByTestId('selection-prompt-restore-explain').click()
      const reset = defaultSelectionPrompts(scenario.resetLanguage).explain
      await expect(page.getByTestId('selection-prompt-explain')).toHaveValue(reset)
      expect(readPreferences().selectionPrompts).toEqual(initial)
      const nativeWindow = await desktop.browserWindow(page)
      await nativeWindow.evaluate(
        (window, size) => window.setSize(size.width, size.height),
        WORKSPACE_WINDOW_MINIMUM
      )
      await page.screenshot({
        path: join(PROMPT_SNAPSHOTS, `${scenario.language}-reset-draft.png`),
      })
      await page
        .getByRole('dialog', { name: /设置|Settings/, exact: true })
        .getByRole('button', { name: /关闭|Close/, exact: true })
        .click()
      await openPromptSettings(page)
      await expect(page.getByTestId('selection-prompt-explain')).toHaveValue(initial.explain)
      await page.getByTestId('selection-prompt-restore-explain').click()
      await page.getByTestId('selection-prompts-save').click()
      const saved = { ...initial, explain: reset }
      await expect.poll(() => readPreferences()?.selectionPrompts).toEqual(saved)
      await expect(page.getByTestId('selection-prompts-save')).toBeDisabled()
      await page.getByTestId('selection-prompt-explain').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(PROMPT_SNAPSHOTS, `${scenario.language}-saved.png`) })
      writeFileSync(
        join(PROMPT_SNAPSHOTS, `${scenario.language}-saved.json`),
        JSON.stringify(
          {
            language: readPreferences().language,
            selectionPrompts: readPreferences().selectionPrompts,
          },
          null,
          2
        )
      )
      await desktop.close()
      process.env.TZ = scenario.resetLanguage === 'en' ? 'Europe/London' : 'Asia/Shanghai'
      page = await desktop.launch()
      await openPromptSettings(page)
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        scenario.resetLanguage === 'en' ? 'en-US' : 'zh-CN'
      )
      for (const action of SELECTION_PROMPT_ACTIONS)
        await expect(page.getByTestId(`selection-prompt-${action}`)).toHaveValue(saved[action])
      expect(readPreferences().selectionPrompts).toEqual(saved)
      await page.screenshot({ path: join(PROMPT_SNAPSHOTS, `${scenario.language}-restart.png`) })
      desktop.assertNoPageErrors()
    } catch (error) {
      const page = desktop.page
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(PROMPT_SNAPSHOTS, `${scenario.language}-failure.png`) })
        writeFileSync(
          join(PROMPT_SNAPSHOTS, `${scenario.language}-failure.txt`),
          await page.locator('[role="dialog"]').allTextContents().then((dialogs) => dialogs.join('\n'))
        )
      }
      throw error
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimeZone
      await desktop.attachArtifacts()
    }
  })
}

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
    await openAccountSettings(page)
    const shell = page.getByTestId('account-settings-shell')
    await expect(shell).toBeVisible()
    await expect(shell.getByTestId('account-settings-nav-mcp')).toHaveCount(0)
    await expect(shell.getByTestId('mcp-settings')).toHaveCount(0)
    await expect(shell.getByTestId('account-settings-nav-skills')).toHaveCount(0)
    for (const viewport of SETTINGS_VIEWPORTS) {
      await page.setViewportSize(viewport)
      if (!(await shell.isVisible())) await openAccountSettings(page)
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
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByTestId('activity-skills').click()
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByTestId('skills-page')).toBeVisible()
      const catalog = JSON.parse(readFileSync(
        join(__dirname, '../../serve/service/capabilities/catalog.json'), 'utf8'
      ))
      for (const name of catalog.surfaces.settings.skills) {
        const card = page.getByTestId(`skill-card-${name}`)
        // The internal authoring dependency is intentionally absent from user inventory.
        if (name === 'plugin-create') await expect(card).toHaveCount(0)
        else await expect(card).toBeVisible()
      }
      await page.screenshot({ path: join(runtime.artifacts, `settings-skills-${viewport.width}.png`) })
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
