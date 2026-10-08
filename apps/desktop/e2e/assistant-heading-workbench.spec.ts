import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const PROJECT_NAME = '审核标签验收20260922'
const TRUNCATED_PROJECT_NAME = '审核标签验收2026...'
const PREFERENCES_FILE = 'renderer-preferences.json'
const NARROW_WINDOW_WIDTH = 1040
const NARROW_WINDOW_HEIGHT = 720

for (const { theme, language } of [
  { theme: 'light', language: 'zh' },
  { theme: 'dark', language: 'zh' },
  { theme: 'light', language: 'en' },
] as const) {
  test(`assistant heading combines fullscreen and sidebar visibility (${theme}, ${language})`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferences = join(runtime.userData, PREFERENCES_FILE)
    writeFileSync(
      preferences,
      JSON.stringify({
        ...JSON.parse(readFileSync(preferences, 'utf8')),
        theme,
        language,
        onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
      })
    )
    const desktop = new DesktopSession(runtime, testInfo)
    const evidence = resolve(
      '../../tmp/test_snapshot/desktop/assistant-heading',
      `${theme}-${language}`
    )
    const conversationTitle = language === 'zh' ? '新对话' : 'New conversation'
    const literatureTitle = language === 'zh' ? '文献全览' : 'Literature'
    mkdirSync(evidence, { recursive: true })
    try {
      const page = await desktop.launch()
      const base = await apiBase(page)
      const projectResponse = await page.request.post(`${base}/api/content/projects`, {
        data: { name: PROJECT_NAME },
      })
      expect(projectResponse.ok(), await projectResponse.text()).toBe(true)
      await page.reload()
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
      if (!(await page.getByTestId('ai-panel').isVisible())) {
        await page.getByTestId('topbar-ai').click()
      }
      const breadcrumb = page.getByTestId('ai-scope-breadcrumb')
      await expect(page.getByTestId('ai-session-title')).toHaveText(conversationTitle)
      await expect(breadcrumb).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'docked-sidebar-visible.png') })

      await page.getByTestId('ai-toggle-cover').click()
      await expect(page.getByTestId('ai-panel')).toHaveClass(/is-cover/)
      await expect(breadcrumb).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'fullscreen-sidebar-visible.png') })

      await page.getByTestId('topbar-panel-toggle').click()
      await expect(page.getByTestId('ai-scope-name')).toHaveText(TRUNCATED_PROJECT_NAME)
      await expect(breadcrumb.getByText(conversationTitle, { exact: true })).toBeVisible()
      await page.screenshot({ path: join(evidence, 'fullscreen-project.png') })
      await page.getByTestId('ai-scope-name').hover()
      await expect(page.getByRole('tooltip').filter({ hasText: PROJECT_NAME })).toBeVisible()
      await page.screenshot({ path: join(evidence, 'fullscreen-project-hover.png') })
      await page.mouse.move(0, 0)
      await page.getByTestId('ai-scope-name').focus()
      await expect(page.getByRole('tooltip').filter({ hasText: PROJECT_NAME })).toBeVisible()
      await page.keyboard.press('Tab')

      await desktop.app!.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
        },
        { width: NARROW_WINDOW_WIDTH, height: NARROW_WINDOW_HEIGHT }
      )
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(NARROW_WINDOW_WIDTH)
      await expect(breadcrumb).toBeVisible()
      const heading = await breadcrumb.boundingBox()
      const actions = await page.getByTestId('ai-toggle-cover').boundingBox()
      expect(heading).not.toBeNull()
      expect(actions).not.toBeNull()
      expect(heading!.x + heading!.width).toBeLessThanOrEqual(actions!.x)
      await page.screenshot({ path: join(evidence, 'fullscreen-project-narrow.png') })

      await page.getByTestId('ai-toggle-cover').click()
      await expect(breadcrumb).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'docked-sidebar-hidden.png') })
      await page.getByTestId('ai-toggle-dock').click()
      await expect(page.getByTestId('ai-panel')).toHaveClass(/is-floating/)
      await expect(breadcrumb).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'floating-sidebar-hidden.png') })
      await page.getByTestId('ai-toggle-dock').click()

      await page.getByTestId('topbar-project').click()
      await page.getByTestId('project-menu-literature').click()
      await page.getByTestId('ai-toggle-cover').click()
      await expect(breadcrumb).toHaveCount(0)
      await page.getByTestId('topbar-panel-toggle').click()
      await expect(page.getByTestId('ai-scope-name')).toHaveText(literatureTitle)
      await expect(breadcrumb.getByText(conversationTitle, { exact: true })).toBeVisible()
      await page.screenshot({ path: join(evidence, 'fullscreen-literature.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
