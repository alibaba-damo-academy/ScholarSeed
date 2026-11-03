import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { LOCALES } from '../src/localization/catalog'
import { DesktopSession } from './fixtures/electron'
import type { RuntimePaths } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PREFERENCES_FILE = 'renderer-preferences.json'
const HOME = process.env.SCHOLARSEED_PIN_ACCEPTANCE_HOME
const WORKSPACE = process.env.SCHOLARSEED_PIN_ACCEPTANCE_WORKSPACE
const PROFILE = process.env.SCHOLARSEED_PIN_ACCEPTANCE_PROFILE
const PROJECT = process.env.SCHOLARSEED_PIN_ACCEPTANCE_PROJECT
const SESSION = process.env.SCHOLARSEED_PIN_ACCEPTANCE_SESSION
const ARTIFACTS = process.env.SCHOLARSEED_PIN_ACCEPTANCE_ARTIFACTS

test('real pinned task survives restart and unpins in the native minimum window', async ({}, testInfo) => {
  test.skip(!HOME || !WORKSPACE || !PROFILE || !PROJECT || !SESSION || !ARTIFACTS,
    'Requires an explicitly supplied isolated real-conversation acceptance home and task')
  const root = testInfo.outputPath('runtime')
  const runtime: RuntimePaths = {
    root,
    home: HOME!,
    workspace: WORKSPACE!,
    userData: join(root, 'profile'),
    drive: join(root, 'drive'),
    artifacts: ARTIFACTS!,
  }
  for (const directory of [root, runtime.userData, runtime.drive, runtime.artifacts]) mkdirSync(directory, { recursive: true })
  const preferences = JSON.parse(readFileSync(join(PROFILE!, PREFERENCES_FILE), 'utf8'))
  writeFileSync(join(runtime.userData, PREFERENCES_FILE), JSON.stringify({ ...preferences, theme: 'dark', language: 'en' }))
  const desktop = new DesktopSession(runtime, testInfo, {
    preserveNavigation: true, preserveRuntime: true, nativeWindowLifecycle: true, recordTrace: false,
  })
  const openTask = async (page: Page): Promise<void> => {
    const project = page.getByTestId(`home-project-${PROJECT}`)
    if (await page.getByTestId('project-center').isVisible()) {
      await expect(project).toBeVisible()
      await project.click()
    }
    await expect(page.getByTestId('project-navigation')).toBeVisible()
    await page.getByTestId(`project-task-${SESSION}`).getByRole('button').first().click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
    const native = await desktop.browserWindow(page)
    await native.evaluate((window, size) => window.setSize(size.width, size.height), WORKSPACE_WINDOW_MINIMUM)
    await expect.poll(() => native.evaluate(window => window.getSize())).toEqual([
      WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height,
    ])
    expect(await native.evaluate(window => window.getMinimumSize())).toEqual([
      WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height,
    ])
    await expect(page.getByRole('status').filter({ hasText: 'Assistant response completed' })).toHaveText('Assistant response completed')
    await expect(page.getByTestId('ai-context-loading')).toHaveCount(0)
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('composer-input')).toBeEnabled()
  }
  try {
    let page = await desktop.launch()
    await openTask(page)
    let row = page.getByTestId(`project-task-${SESSION}`)
    if (!await row.getByRole('img', { name: 'Pinned', exact: true }).count()) {
      await row.getByRole('button', { name: 'Task actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
      await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible()
      await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
      await desktop.close()
      page = await desktop.launch()
      await openTask(page)
      row = page.getByTestId(`project-task-${SESSION}`)
    }
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
    const alignment = await page.getByRole('menuitem').evaluateAll((items) => items.map((item) => {
      const icon = item.firstElementChild!.getBoundingClientRect()
      const label = document.createRange()
      label.selectNodeContents(item.lastChild!)
      return { iconLeft: icon.left, iconWidth: icon.width, labelLeft: label.getBoundingClientRect().left }
    }))
    expect(alignment).toHaveLength(3)
    expect(new Set(alignment.map((item) => JSON.stringify(item))).size).toBe(1)
    await page.screenshot({ path: join(runtime.artifacts, '07-restart-dark-minimum.png') })
    await page.keyboard.press('Escape')
    await expect(row.getByRole('button', { name: 'Task actions', exact: true })).toBeFocused()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(row.getByRole('button', { name: 'Task actions', exact: true })).toBeFocused()
    await page.screenshot({ path: join(runtime.artifacts, '08-unpin-dark-minimum.png') })
    await desktop.close()
    page = await desktop.launch()
    await openTask(page)
    row = page.getByTestId(`project-task-${SESSION}`)
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toHaveCount(0)
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Pin', exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, '09-unpinned-restart.png') })
    const pinResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/serve/sessions/${SESSION}/pin`) && response.request().method() === 'PUT'
    )
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    expect(await (await pinResponse).json()).toMatchObject({ ok: true, session_id: SESSION, pinned: true })
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const editor = page.getByTestId(`sidebar-session-title-input-${SESSION}`)
    await expect(editor).toBeVisible()
    await editor.fill('Cancelled integration rename')
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const title = `Task pinning integration ${Date.now()}`
    await editor.fill(title)
    await editor.press('Enter')
    await expect(row.getByRole('button').first()).toBeVisible()
    await expect(row.getByRole('button').first()).toHaveText(title)
    await expect(row.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible()
    const catalogUrl = new URL('/api/serve/sessions', page.url())
    const catalog = await (await page.request.get(catalogUrl.href)).json()
    expect(catalog.sessions.find((session: { session_id: string }) => session.session_id === SESSION).title).toBe(title)
    const projectPath = catalog.sessions.find((session: { session_id: string }) => session.session_id === SESSION).project_path
    catalogUrl.search = new URLSearchParams({ scope: 'project', project_path: projectPath, limit: '1' }).toString()
    const firstPage = await (await page.request.get(catalogUrl.href)).json()
    expect(firstPage.sessions[0].session_id).toBe(SESSION)
    expect(firstPage.next_cursor).toEqual(expect.any(String))
    catalogUrl.searchParams.set('cursor', firstPage.next_cursor)
    const nextPage = await (await page.request.get(catalogUrl.href)).json()
    expect(nextPage.sessions).toHaveLength(1)
    expect(nextPage.sessions[0].session_id).not.toBe(SESSION)
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, '16-rename-pinned-integration.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
