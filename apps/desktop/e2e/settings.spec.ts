import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const SETTINGS_PAGES = [
  { tab: 'notifications', page: 'notifications' },
  { tab: 'prompts', page: 'prompts' },
  { tab: 'models', page: 'model-configuration' },
  { tab: 'developer', page: 'developer' },
  { tab: 'files', page: 'files' },
  // { tab: 'shortcuts', page: 'shortcuts' }, // 暂时随「键盘快捷键」页面隐藏。
  { tab: 'archives', page: 'archives' },
  { tab: 'about', page: 'about' }
] as const
const SETTINGS_VIEWPORTS = [
  { width: 960, height: 640 },
  { width: 600, height: 500 }
] as const
const SCROLL_DISTANCE = 1200
const GEOMETRY_TOLERANCE = 1
const PREFERENCES_FILE = 'renderer-preferences.json'

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
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
