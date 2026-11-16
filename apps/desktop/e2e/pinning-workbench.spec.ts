import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { LOCALES } from '../src/localization/catalog'
import { apiBase, DesktopSession } from './fixtures/electron'
import type { ServeSession, ServeSessionCatalog } from '../src/renderer/src/api'
import {
  assertRuntimeSourceOwnership,
  seedRendererPreferences,
  type RuntimePaths,
} from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => {
  skipQuarantined(testInfo)
})

const PREFERENCES_FILE = 'renderer-preferences.json'
const HOME = process.env.SCHOLARSEED_PIN_ACCEPTANCE_HOME
const WORKSPACE = process.env.SCHOLARSEED_PIN_ACCEPTANCE_WORKSPACE
const PROJECT = process.env.SCHOLARSEED_PIN_ACCEPTANCE_PROJECT
const SESSION = process.env.SCHOLARSEED_PIN_ACCEPTANCE_SESSION

test('real pinned task survives restart and unpins in the native minimum window', async ({}, testInfo) => {
  test.skip(
    !HOME || !WORKSPACE || !PROJECT || !SESSION,
    'Requires an explicitly supplied isolated real-conversation acceptance home and task'
  )
  const root = testInfo.outputPath('runtime')
  const runtime: RuntimePaths = {
    root,
    home: HOME!,
    workspace: WORKSPACE!,
    userData: join(root, 'profile'),
    drive: join(root, 'drive'),
    artifacts: join(root, 'artifacts'),
  }
  assertRuntimeSourceOwnership(runtime.home, runtime.workspace)
  for (const directory of [root, runtime.userData, runtime.drive, runtime.artifacts])
    mkdirSync(directory, { recursive: true })
  seedRendererPreferences(runtime.userData)
  const preferences = JSON.parse(readFileSync(join(runtime.userData, PREFERENCES_FILE), 'utf8'))
  writeFileSync(
    join(runtime.userData, PREFERENCES_FILE),
    JSON.stringify({ ...preferences, theme: 'dark', language: 'en' })
  )
  const desktop = new DesktopSession(runtime, testInfo, {
    preserveNavigation: true,
    preserveRuntime: true,
    nativeWindowLifecycle: true,
    recordTrace: false,
  })
  const openTask = async (page: Page): Promise<void> => {
    const project = page.getByTestId(`home-project-${PROJECT}`)
    if (await page.getByTestId('project-center').isVisible()) {
      await expect(project).toBeVisible()
      await project.click()
    }
    await expect(page.getByTestId('project-navigation')).toBeVisible()
    await page.getByTestId(`project-task-${SESSION}`).locator('button[aria-current]').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
    const native = await desktop.browserWindow(page)
    await native.evaluate(
      (window, size) => window.setSize(size.width, size.height),
      WORKSPACE_WINDOW_MINIMUM
    )
    await expect
      .poll(() => native.evaluate((window) => window.getSize()))
      .toEqual([WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height])
    expect(await native.evaluate((window) => window.getMinimumSize())).toEqual([
      WORKSPACE_WINDOW_MINIMUM.width,
      WORKSPACE_WINDOW_MINIMUM.height,
    ])
    await expect(
      page.getByRole('status').filter({ hasText: 'Assistant response completed' })
    ).toHaveText('Assistant response completed')
    await expect(page.getByTestId('ai-context-loading')).toHaveCount(0)
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('composer-input')).toBeEnabled()
  }
  const readCatalog = async (page: Page, projectPath?: string): Promise<ServeSession[]> => {
    const url = new URL('/api/serve/sessions', await apiBase(page))
    url.search = new URLSearchParams(
      projectPath ? { scope: 'project', project_path: projectPath } : { scope: 'all' }
    ).toString()
    const rows: ServeSession[] = []
    const cursors = new Set<string>()
    const identities = new Set<string>()
    while (true) {
      const response = await page.request.get(url.href)
      expect(response.status()).toBe(200)
      const catalog = (await response.json()) as ServeSessionCatalog
      expect(Array.isArray(catalog.sessions)).toBe(true)
      for (const session of catalog.sessions) {
        expect(typeof session.session_id).toBe('string')
        expect(identities.has(session.session_id)).toBe(false)
        identities.add(session.session_id)
        rows.push(session)
      }
      if (!catalog.next_cursor) return rows
      expect(typeof catalog.next_cursor).toBe('string')
      expect(catalog.sessions.length).toBeGreaterThan(0)
      expect(cursors.has(catalog.next_cursor)).toBe(false)
      cursors.add(catalog.next_cursor)
      url.searchParams.set('cursor', catalog.next_cursor)
    }
  }
  const inspectInput = async (page: Page): Promise<{ projectPath: string; task: ServeSession }> => {
    const response = await page.request.get(
      new URL('/api/content/projects', await apiBase(page)).href
    )
    expect(response.status()).toBe(200)
    const listing = (await response.json()) as {
      workspaceRoot: string
      projects: { id: string; root: string; available: boolean }[]
    }
    expect(realpathSync.native(listing.workspaceRoot)).toBe(realpathSync.native(WORKSPACE!))
    const project = listing.projects.find((item) => item.id === PROJECT)
    expect(project).toBeDefined()
    expect(project!.available).toBe(true)
    const projectPath = realpathSync.native(project!.root)
    const location = relative(realpathSync.native(WORKSPACE!), projectPath)
    expect(location === '..' || location.startsWith('..' + sep) || isAbsolute(location)).toBe(false)
    const all = await readCatalog(page)
    for (const session of all) {
      expect(session.running ?? false).toBe(false)
      expect(session.waiting ?? false).toBe(false)
      expect(session.recovery_blocked ?? false).toBe(false)
      expect(session.recovery_pending ?? false).toBe(false)
      expect(['running', 'waiting']).not.toContain(session.last_turn_status)
    }
    const rows = await readCatalog(page, projectPath)
    expect(rows.length).toBeGreaterThan(1)
    const selected = rows.filter((session) => session.session_id === SESSION)
    expect(selected).toHaveLength(1)
    const task = selected[0]
    expect(realpathSync.native(task.project_path!)).toBe(projectPath)
    expect(task.last_turn_status).toBe('completed')
    expect(task.turns).toBeGreaterThan(0)
    expect(task.archived ?? false).toBe(false)
    expect(task.display_parent_session_id ?? null).toBeNull()
    expect(rows.filter((session) => session.session_id !== SESSION && session.pinned)).toHaveLength(
      0
    )
    return { projectPath, task }
  }
  const assertPinned = async (page: Page, projectPath: string, pinned: boolean) => {
    const matches = (await readCatalog(page, projectPath)).filter(
      (session) => session.session_id === SESSION
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].pinned).toBe(pinned)
    const row = page.getByTestId('project-task-' + SESSION)
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await expect(
      page.getByRole('menuitem', { name: pinned ? 'Unpin' : 'Pin', exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: pinned ? 'Pin' : 'Unpin', exact: true })
    ).toHaveCount(0)
    return row
  }
  const changePin = async (page: Page, pinned: boolean): Promise<void> => {
    const pathname = '/api/serve/sessions/' + encodeURIComponent(SESSION!) + '/pin'
    const [response] = await Promise.all([
      page.waitForResponse(
        (value) => new URL(value.url()).pathname === pathname && value.request().method() === 'PUT'
      ),
      page.getByRole('menuitem', { name: pinned ? 'Pin' : 'Unpin', exact: true }).click(),
    ])
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ pinned })
    expect(await response.json()).toMatchObject({ ok: true, session_id: SESSION, pinned })
    await expect(page.getByTestId('project-task-list')).toHaveAttribute('aria-busy', 'false')
  }
  try {
    let page = await desktop.launch()
    let input = await inspectInput(page)
    const projectPath = input.projectPath
    const originalTitle = input.task.title
    await openTask(page)
    if (!input.task.pinned) {
      await assertPinned(page, projectPath, false)
      await changePin(page, true)
    }
    await desktop.close()
    page = await desktop.launch()
    input = await inspectInput(page)
    expect(input.projectPath).toBe(projectPath)
    expect(input.task.pinned).toBe(true)
    await openTask(page)
    let row = await assertPinned(page, projectPath, true)
    const requiredActions = [
      'Unpin',
      'Create branch conversation',
      'Rename',
      'Archive task',
      'Delete task',
    ]
    await expect(page.getByRole('menuitem')).toContainText(requiredActions)
    const alignment = await page.getByRole('menuitem').evaluateAll((items) =>
      items.map((item) => {
        const icon = item.querySelector('svg')
        const text = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
        let label = text.nextNode()
        while (label && !label.textContent?.trim()) label = text.nextNode()
        if (!icon || !label) throw new Error('Task action must expose its icon and label')
        const range = document.createRange()
        range.selectNodeContents(label)
        const bounds = icon.getBoundingClientRect()
        return {
          iconLeft: bounds.left,
          iconWidth: bounds.width,
          labelLeft: range.getBoundingClientRect().left,
        }
      })
    )
    expect(alignment.length).toBeGreaterThanOrEqual(requiredActions.length)
    expect(new Set(alignment.map((item) => JSON.stringify(item))).size).toBe(1)
    await page.screenshot({ path: join(runtime.artifacts, '07-restart-dark-minimum.png') })
    await page.keyboard.press('Escape')
    await expect(row.getByRole('button', { name: 'Task actions', exact: true })).toBeFocused()
    await row.getByRole('button', { name: 'Task actions', exact: true }).click()
    await changePin(page, false)
    row = await assertPinned(page, projectPath, false)
    await page.keyboard.press('Escape')
    await expect(row.getByRole('button', { name: 'Task actions', exact: true })).toBeFocused()
    await page.screenshot({ path: join(runtime.artifacts, '08-unpin-dark-minimum.png') })
    await desktop.close()
    page = await desktop.launch()
    input = await inspectInput(page)
    expect(input.projectPath).toBe(projectPath)
    expect(input.task.pinned).toBe(false)
    await openTask(page)
    row = await assertPinned(page, projectPath, false)
    await page.screenshot({ path: join(runtime.artifacts, '09-unpinned-restart.png') })
    await changePin(page, true)
    row = await assertPinned(page, projectPath, true)
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const editor = page.getByTestId('sidebar-session-title-input-' + SESSION)
    await expect(editor).toBeVisible()
    await editor.fill('Cancelled integration rename')
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    expect(
      (await readCatalog(page, projectPath)).find((session) => session.session_id === SESSION)!
        .title
    ).toBe(originalTitle)
    row = await assertPinned(page, projectPath, true)
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const title = 'Task pinning integration ' + Date.now()
    await editor.fill(title)
    await editor.press('Enter')
    await expect(row.locator('button[aria-current]')).toBeVisible()
    await expect(row.locator('button[aria-current]')).toHaveText(title)
    row = await assertPinned(page, projectPath, true)
    expect((await readCatalog(page)).find((session) => session.session_id === SESSION)!.title).toBe(
      title
    )
    const catalogUrl = new URL('/api/serve/sessions', await apiBase(page))
    catalogUrl.search = new URLSearchParams({
      scope: 'project',
      project_path: projectPath,
      limit: '1',
    }).toString()
    const firstResponse = await page.request.get(catalogUrl.href)
    expect(firstResponse.status()).toBe(200)
    const firstPage = (await firstResponse.json()) as ServeSessionCatalog
    expect(firstPage.sessions).toHaveLength(1)
    expect(firstPage.sessions[0].session_id).toBe(SESSION)
    expect(firstPage.next_cursor).toEqual(expect.any(String))
    expect(firstPage.next_cursor!.length).toBeGreaterThan(0)
    catalogUrl.searchParams.set('cursor', firstPage.next_cursor!)
    const nextResponse = await page.request.get(catalogUrl.href)
    expect(nextResponse.status()).toBe(200)
    const nextPage = (await nextResponse.json()) as ServeSessionCatalog
    expect(nextPage.sessions).toHaveLength(1)
    expect(nextPage.sessions[0].session_id).not.toBe(SESSION)
    await expect(page.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, '16-rename-pinned-integration.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
