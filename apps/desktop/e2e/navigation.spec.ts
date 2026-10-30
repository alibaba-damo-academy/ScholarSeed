import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import type { NavigationLocation } from '../src/navigation'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { MARKDOWN_SOURCE, openFile, seedProject } from './fixtures/workbench'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PREFERENCES_FILE = 'renderer-preferences.json'
const DOCUMENT_NAME = 'acceptance.md'
const DOCUMENT_PARAGRAPH = MARKDOWN_SOURCE.split('\n\n')[1]

async function persistedLocation(desktop: DesktopSession): Promise<NavigationLocation | null> {
  return JSON.parse(readFileSync(join(desktop.runtime.userData, PREFERENCES_FILE), 'utf8')).lastLocation ?? null
}

async function initialize(page: Page): Promise<void> {
  if (await page.getByTestId('account-settings-shell').isVisible()) return
  const skip = page.getByTestId('landing-skip')
  if (await skip.isVisible()) await skip.click()
}

test('退出重开恢复文献页、项目文档和设置子页，不恢复临时菜单', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
  writeFileSync(preferencesPath, JSON.stringify({
    language: 'zh', storageFirstLaunchSeen: true,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
  try {
    let page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('workbench-home-space')).toBeVisible()
    await page.getByTestId('activity-literature').click()
    await expect.poll(async () => (await persistedLocation(desktop))?.view).toBe('literature')
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('workbench-home-space')).toHaveCount(0)
    await expect(page.getByTestId('activity-literature')).toHaveAttribute('aria-current', 'true')
    await page.screenshot({ path: join(runtime.artifacts, 'restored-literature.png') })

    const resources = await seedProject(page, runtime)
    await openFile(page, DOCUMENT_NAME)
    await expect(page.locator('[data-testid^="document-tab-"]').filter({ hasText: DOCUMENT_NAME })).toBeVisible()
    await expect.poll(async () => (await persistedLocation(desktop))?.target?.kind).toBe('document')
    const savedProject = (await persistedLocation(desktop))?.projectId
    expect(savedProject).toBeTruthy()
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('activity-resource')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-testid^="document-tab-"]').filter({ hasText: DOCUMENT_NAME })).toBeVisible()
    await expect(page.getByTestId('markdown-visual-editor')).toContainText(DOCUMENT_PARAGRAPH)
    expect((await persistedLocation(desktop))?.projectId).toBe(savedProject)
    await page.screenshot({ path: join(runtime.artifacts, 'restored-project-document.png'), animations: 'disabled' })

    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-skills').click()
    await expect.poll(async () => (await persistedLocation(desktop))?.settingsPage).toBe('skills')
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('account-settings-skills')).toBeVisible()
    await expect(page.getByTestId('account-menu-settings')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'restored-settings-skills.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)

    unlinkSync(join(resources, DOCUMENT_NAME))
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('activity-resource')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-testid^="document-tab-"]').filter({ hasText: DOCUMENT_NAME })).toHaveCount(0)
    await expect.poll(async () => (await persistedLocation(desktop))?.target).toBeNull()
    await page.screenshot({ path: join(runtime.artifacts, 'deleted-document-fallback.png') })

    await page.getByTestId('activity-home').click()
    await expect.poll(async () => (await persistedLocation(desktop))?.view).toBe('home')
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('workbench-home-space')).toBeVisible()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('已删除项目和会话的启动记录回退，不覆盖尚未恢复的记录', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
  writeFileSync(preferencesPath, JSON.stringify({
    language: 'zh', storageFirstLaunchSeen: true,
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    lastLocation: { view: 'literature', sessionId: 'deleted-session', aiPanelOpen: true }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true, nativeWindowLifecycle: true })
  try {
    let page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('activity-literature')).toHaveAttribute('aria-current', 'true')
    await expect.poll(async () => (await persistedLocation(desktop))?.sessionId).toBeNull()
    await expect(page.getByText('对话暂时没有加载完成', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'deleted-session-fallback.png') })
    await seedProject(page, runtime)
    const projectId = (await persistedLocation(desktop))?.projectId
    expect(projectId).toBeTruthy()
    const removed = await page.request.delete(`${await apiBase(page)}/api/content/projects/${encodeURIComponent(projectId!)}`)
    expect(removed.ok()).toBe(true)
    await desktop.close()
    page = await desktop.launch()
    await initialize(page)
    await expect(page.getByTestId('workbench-home-space')).toBeVisible()
    await expect.poll(async () => (await persistedLocation(desktop))?.projectId).toBeNull()
    await page.screenshot({ path: join(runtime.artifacts, 'deleted-project-fallback.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
