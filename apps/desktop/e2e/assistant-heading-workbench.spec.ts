import { createReadyProject, openProjectMenu } from './fixtures/projects'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = '审核标签验收20260922'
const TRUNCATED_PROJECT_NAME = '审核标签验收2026...'
const PREFERENCES_FILE = 'renderer-preferences.json'

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
    const conversationTitle = language === 'zh' ? '新任务' : 'New task'
    mkdirSync(evidence, { recursive: true })
    try {
      const page = await desktop.launch()
      await createReadyProject(page, PROJECT_NAME)
      await page.reload()
      await openProjectMenu(page)
      await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
      if (!(await page.getByTestId('ai-panel').isVisible())) {
        await page.getByTestId('topbar-ai').click()
      }
      const breadcrumb = page.getByTestId('ai-scope-breadcrumb')
      await expect(page.getByTestId('ai-session-title')).toHaveText(conversationTitle)
      await expect(breadcrumb).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'docked-sidebar-visible.png') })

      await page.getByTestId('project-sidebar-collapse').click()
      const scope = page.getByTestId('ai-scope-name')
      await expect(scope).toHaveText(TRUNCATED_PROJECT_NAME)
      await expect(breadcrumb).toContainText(conversationTitle)
      const nativeWindow = await desktop.browserWindow(page)
      const tooltipVisible = async () => {
        if (await page.getByRole('tooltip').filter({ hasText: PROJECT_NAME }).isVisible()) return true
        return nativeWindow.evaluate(async (native, label) => {
          const views = native.contentView.children.filter(child => child.getVisible()) as Electron.WebContentsView[]
          const visible = await Promise.all(views.map(view => view.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('[role="tooltip"]')).some(element => element.textContent === ${JSON.stringify(label)})`
          )))
          return visible.some(Boolean)
        }, PROJECT_NAME)
      }
      await scope.hover()
      await expect.poll(tooltipVisible).toBe(true)
      await scope.focus()
      await expect.poll(tooltipVisible).toBe(true)
      await page.keyboard.press('Tab')
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_MINIMUM)
      const heading = (await breadcrumb.boundingBox())!
      const actions = (await page.getByTestId('workspace-conversation-menu').boundingBox())!
      expect(heading.x + heading.width).toBeLessThanOrEqual(actions.x)
      await page.screenshot({ path: join(evidence, 'project-heading-minimum.png') })
      await page.getByTestId('project-sidebar-expand').click()
      await expect(breadcrumb).toHaveCount(0)
      await page.getByTestId('workspace-open').click()
      await page.getByTestId('workspace-full').click()
      await page.getByTestId('composer-input').focus()
      await expect(page.getByTestId('ai-session-title')).toContainText(conversationTitle)
      await page.screenshot({ path: join(evidence, 'floating-heading-sidebar-visible.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
