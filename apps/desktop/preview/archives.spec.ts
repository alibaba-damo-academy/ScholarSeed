import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import componentsEn from '../src/localization/locales/en/components.json'
import componentsZh from '../src/localization/locales/zh/components.json'
import layoutZh from '../src/localization/locales/zh/layout.json'
import shellZh from '../src/localization/locales/zh/shell.json'
import assistantZh from '../src/localization/locales/zh/assistant.json'
import { openPreviewScenario, openPreviewTools, expect, test, previewSurface, type Page, type Response } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'
import previewEn from './locales/en.json'
import previewZh from './locales/zh.json'

const PAGE_ID = 'settings-archives'
const TASK_PAGE_ID = 'page-resource'
const STATE_PATH = '/__preview/state'
const RECOVER_PATH = '/__preview/archives/recover'
const PROJECTS_PATH = '/api/content/projects'
const SESSIONS_PATH = '/api/serve/sessions'
const HISTORY_PATH = '/api/serve/history/'
const FAILURE_STATUS = 503
const TASK_PAGE = 'archived-conversation'
const TASK_LIST = 'project-archived-list'
const PROJECT_PAGE = 'account-settings-archives'
const ARCHIVED_QUERY = 'includeArchived'
const ARCHIVED_QUERY_VALUE = 'true'
const PROJECT_READ_FAILURE_SCENES = ['settings-archives-required', 'settings-archives-project-read-failed']
type Project = { id: string; name: string; root: string; archived_at?: number | null }
type Session = { session_id: string; title: string; project_path: string | null; archived: boolean }
type WireTurn = { kind: string; role?: string; text?: string; output?: string }
type Snapshot = { projects: Project[]; sessions: Session[] }
type Failure = { path: string; query: string; method: string; status: number }
type ReadEvent = { phase: 'request' | 'response' | 'failed'; path: string; query: string; timeMs: number; status?: number; error?: string }
type Observation = { requests: { path: string; method: string; resumeSessionId?: string }[]; readonly: { sessionId: string; start: number; end?: number }[]; pageErrors: string[]; failures: Failure[]; externalOrigins: string[]; reads: ReadEvent[]; navigations: { path: string; query: string; timeMs: number }[]; expectedFailure?: 'read' | 'project-read' | 'history' | 'write' }
const OBSERVATIONS = new WeakMap<Page, Observation>()

test.beforeEach(({ page }) => {
  const startedAt = Date.now()
  const observation: Observation = { requests: [], readonly: [], pageErrors: [], failures: [], externalOrigins: [], reads: [], navigations: [] }
  OBSERVATIONS.set(page, observation)
  page.on('pageerror', error => observation.pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observation.externalOrigins.includes(url.origin)) observation.externalOrigins.push(url.origin)
    if (url.pathname.startsWith('/api/') || url.pathname === RECOVER_PATH) observation.requests.push({ path: url.pathname, method: request.method(), ...(url.pathname === `${SESSIONS_PATH}/open` && request.method() === 'POST' ? { resumeSessionId: request.postDataJSON()?.resume_session_id } : {}) })
    if (url.origin === PREVIEW_ORIGIN && request.method() === 'GET' && [SESSIONS_PATH, PROJECTS_PATH].includes(url.pathname)) observation.reads.push({ phase: 'request', path: url.pathname, query: url.search, timeMs: Date.now() - startedAt })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    const path = url.pathname
    if ((path.startsWith('/api/') || path === STATE_PATH || path === RECOVER_PATH) && response.status() >= 400) observation.failures.push({ path, query: url.search, method: response.request().method(), status: response.status() })
    if (url.origin === PREVIEW_ORIGIN && response.request().method() === 'GET' && [SESSIONS_PATH, PROJECTS_PATH].includes(path)) observation.reads.push({ phase: 'response', path, query: url.search, timeMs: Date.now() - startedAt, status: response.status() })
  })
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.origin === PREVIEW_ORIGIN && request.method() === 'GET' && [SESSIONS_PATH, PROJECTS_PATH].includes(url.pathname)) observation.reads.push({ phase: 'failed', path: url.pathname, query: url.search, timeMs: Date.now() - startedAt, error: request.failure()?.errorText ?? 'unknown' })
  })
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    const url = new URL(frame.url())
    if (url.origin === PREVIEW_ORIGIN) observation.navigations.push({ path: url.pathname, query: url.search, timeMs: Date.now() - startedAt })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observation = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('archives-http-summary.json')
  await writeFile(path, JSON.stringify(observation, null, 2))
  await testInfo.attach('archives-http-summary', { path, contentType: 'application/json' })
  expect(observation.pageErrors).toEqual([])
  for (const window of observation.readonly) {
    const requests = observation.requests.slice(window.start, window.end)
    expect(requests.filter(request => request.resumeSessionId === window.sessionId)).toEqual([])
    const sessionPath = `${SESSIONS_PATH}/${encodeURIComponent(window.sessionId)}/`
    expect(requests.filter(request => request.path.startsWith(sessionPath) && (request.path === `${sessionPath}events` || request.method !== 'GET'))).toEqual([])
  }
  expect(observation.externalOrigins).toEqual([])
  if (!observation.expectedFailure) expect(observation.failures).toEqual([])
  else {
    expect(observation.failures.length).toBeGreaterThan(0)
    for (const failure of observation.failures) {
      expect(failure.status).toBe(FAILURE_STATUS)
      if (observation.expectedFailure === 'read') {
        expect(failure.method).toBe('GET')
        expect([SESSIONS_PATH, PROJECTS_PATH]).toContain(failure.path)
      }
      else if (observation.expectedFailure === 'project-read') {
        expect(failure.method).toBe('GET')
        expect(failure.path).toBe(PROJECTS_PATH)
        expect(new URLSearchParams(failure.query).get(ARCHIVED_QUERY)).toBe(ARCHIVED_QUERY_VALUE)
      }
      else if (observation.expectedFailure === 'history') {
        expect(failure.method).toBe('GET')
        expect(failure.path.startsWith(HISTORY_PATH)).toBe(true)
      } else {
        expect(['POST', 'PUT', 'DELETE']).toContain(failure.method)
        expect(failure.path.startsWith(`${SESSIONS_PATH}/`) || failure.path.startsWith(`${PROJECTS_PATH}/`)).toBe(true)
      }
    }
    if (observation.expectedFailure === 'write') expect(observation.failures).toHaveLength(1)
  }
})

async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get(`${STATE_PATH}?${new URL(page.url()).searchParams}`)
  expect(response.status()).toBe(200)
  return await response.json() as Snapshot
}

async function openArchives(page: Page, sceneId: string, beforeLaunch?: () => void): Promise<void> {
  const taskScene = sceneId.startsWith('project-archives-')
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === (taskScene ? TASK_PAGE_ID : PAGE_ID))!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  const observation = OBSERVATIONS.get(page)!
  observation.expectedFailure = PROJECT_READ_FAILURE_SCENES.includes(sceneId) ? 'project-read' : scene.simulation?.archives?.read === 'failed' ? 'read' : scene.simulation?.archives?.history === 'failed' ? 'history' : scene.simulation?.archives?.write === 'fail-once' ? 'write' : undefined
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  beforeLaunch?.()
  await openPreviewScenario(page, entry.id, scene.id)
  if (taskScene) {
    await expect(previewSurface(page).getByTestId('project-archive-toggle')).toBeVisible()
    await previewSurface(page).getByTestId('project-archive-toggle').click()
    await expect(previewSurface(page).getByTestId(TASK_LIST)).toBeVisible()
  } else await expect(previewSurface(page).getByTestId(PROJECT_PAGE)).toBeVisible()
}

async function tasks(page: Page): Promise<Session[]> {
  const current = await snapshot(page)
  const all = current.sessions.filter(session => session.archived)
  expect(all).toHaveLength(2)
  const project = current.projects.find(project => project.archived_at == null)!
  const rows = all.filter(session => session.project_path === project.root)
  expect(rows).toHaveLength(1)
  for (const row of rows) await expect(previewSurface(page).getByTestId(`project-archived-task-${row.session_id}`)).toBeVisible()
  for (const row of all.filter(session => session.project_path !== project.root)) await expect(previewSurface(page).getByTestId(`project-archived-task-${row.session_id}`)).toHaveCount(0)
  return rows
}

async function projects(page: Page): Promise<Project[]> {
  const rows = (await snapshot(page)).projects.filter(project => project.archived_at != null)
  expect(rows).toHaveLength(2)
  for (const row of rows) await expect(previewSurface(page).getByTestId(`account-archived-${row.id}`)).toBeVisible()
  return rows
}

function responseFor(page: Page, path: string, method: string): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
}

async function openDetails(page: Page, row: Session): Promise<Response> {
  watchReadonly(page, row)
  const reading = responseFor(page, `${HISTORY_PATH}${row.session_id}`, 'GET')
  await previewSurface(page).getByTestId(`project-archived-task-${row.session_id}`).getByRole('button', { name: row.title }).click()
  return reading
}

function watchReadonly(page: Page, row: Session): void {
  const observation = OBSERVATIONS.get(page)!
  observation.readonly.push({ sessionId: row.session_id, start: observation.requests.length })
}

function endReadonly(page: Page, row: Session): void {
  const observation = OBSERVATIONS.get(page)!
  for (const window of observation.readonly) if (window.sessionId === row.session_id && window.end === undefined) window.end = observation.requests.length
}

async function assertReadonly(page: Page): Promise<void> {
  await expect(previewSurface(page).getByTestId(TASK_PAGE).getByTestId('composer-input')).toBeDisabled()
  await expect(previewSurface(page).getByTestId(TASK_PAGE).getByTestId('composer-send')).toBeDisabled()
  await expect(previewSurface(page).getByTestId(TASK_PAGE).getByTestId('composer-stop')).toHaveCount(0)
}

async function assertHistoryRoles(page: Page, turns: WireTurn[]): Promise<void> {
  const history = previewSurface(page).getByTestId(TASK_PAGE)
  for (const turn of turns) {
    const body = turn.text || turn.output
    if (!body || turn.kind === 'thinking') continue
    if (turn.role === 'user') {
      await expect(history.getByTestId('user-bubble').getByText(body, { exact: true })).toBeVisible()
      await expect(history.locator('.answer-annotation-root').filter({ hasText: body })).toHaveCount(0)
    } else if (turn.kind === 'tool') {
      const group = history.getByTestId('turn-activity-trigger')
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()
      const tool = history.getByTestId('tool-run-step')
      await expect(tool).toHaveCount(1)
      const trigger = tool.getByRole('button').first()
      if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
      await expect(tool.getByText(body, { exact: true })).toBeVisible()
    } else if (turn.role === 'assistant') {
      await expect(history.locator('.answer-annotation-root').getByText(body, { exact: true })).toBeVisible()
      await expect(history.getByTestId('user-bubble').getByText(body, { exact: true })).toHaveCount(0)
    }
  }
}

function deleteCount(page: Page): number {
  return OBSERVATIONS.get(page)!.requests.filter(request => request.method === 'DELETE').length
}

function archivedProjectResponse(page: Page, status?: number): Promise<Response> {
  return page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === PREVIEW_ORIGIN && response.request().method() === 'GET' && url.pathname === PROJECTS_PATH && url.searchParams.get(ARCHIVED_QUERY) === ARCHIVED_QUERY_VALUE && (status === undefined || response.status() === status)
  })
}

test('archives project read failure recovers through the public retry and single restore stays busy until its receipt', { annotation: previewConsumption(PAGE_ID, 'settings-archives-required', ['project-read-error', 'project-read-retried', 'project-read-recovered', 'project-single-restore-busy']) }, async ({ page }, testInfo) => {
  let failed!: Promise<Response>
  await openArchives(page, 'settings-archives-required', () => { failed = archivedProjectResponse(page, FAILURE_STATUS) })
  const initial = (await snapshot(page)).projects.filter(project => project.archived_at != null)
  expect(initial).toHaveLength(2)
  expect((await failed).status()).toBe(FAILURE_STATUS)
  const content = previewSurface(page).getByTestId(PROJECT_PAGE)
  await expect(content.getByRole('alert')).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).not.toBeVisible()
  const retry = content.getByRole('button', { name: componentsZh.taskArchive.retry, exact: true })
  await expect(retry).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-read-failed.png'))
  const instance = new URL(page.url()).searchParams.get('previewInstance')
  await page.keyboard.press('F8')
  const console = page.getByRole('dialog', { name: previewZh.title, exact: true })
  await expect(console).toBeVisible()
  const recovering = responseFor(page, RECOVER_PATH, 'POST')
  await console.getByTestId('preview-archive-recover').click()
  const recovered = await recovering
  expect(new URL(recovered.url()).origin).toBe(PREVIEW_ORIGIN)
  expect(recovered.status()).toBe(200)
  await console.getByRole('button', { name: previewZh.close, exact: true }).click()
  await expect(console).not.toBeVisible()
  expect(new URL(page.url()).searchParams.get('previewInstance')).toBe(instance)
  expect(OBSERVATIONS.get(page)!.requests.filter(request => request.path === RECOVER_PATH && request.method === 'POST')).toHaveLength(1)
  await expect(content.getByRole('alert')).toBeVisible()
  await expect(retry).toBeEnabled()
  const reading = archivedProjectResponse(page)
  await retry.click()
  expect((await reading).status()).toBe(200)
  for (const project of initial) await expect(previewSurface(page).getByTestId(`account-archived-${project.id}`)).toBeVisible()
  await expect(content.getByRole('alert')).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-read-recovered.png'))
  await previewSurface(page).getByTestId(`account-archived-select-${initial[1].id}`).click()
  const restore = previewSurface(page).getByTestId(`account-archived-restore-${initial[0].id}`)
  const path = `${PROJECTS_PATH}/${initial[0].id}/archive`
  let received = false
  const completed = responseFor(page, path, 'POST').then(response => { received = true; return response })
  await restore.click()
  await expect(restore).toBeDisabled()
  await expect(previewSurface(page).getByTestId('account-archived-select-all')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('account-archived-batch-unarchive')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('account-archived-batch-delete')).toBeDisabled()
  for (const project of initial) {
    await expect(previewSurface(page).getByTestId(`account-archived-select-${project.id}`)).toBeDisabled()
    await expect(previewSurface(page).getByTestId(`account-archived-restore-${project.id}`)).toBeDisabled()
    await expect(previewSurface(page).getByTestId(`account-archived-delete-${project.id}`)).toBeDisabled()
  }
  expect(received).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('archives-project-single-restore-pending.png') })
  expect(received).toBe(false)
  await expect(restore).toBeDisabled()
  expect((await completed).status()).toBe(200)
  await expect(previewSurface(page).getByTestId(`account-archived-${initial[0].id}`)).toHaveCount(0)
  await expect(previewSurface(page).getByTestId(`account-archived-${initial[1].id}`)).toBeVisible()
  expect(OBSERVATIONS.get(page)!.requests.filter(request => request.path === path && request.method === 'POST')).toHaveLength(1)
  expect((await snapshot(page)).projects.find(project => project.id === initial[0].id)?.archived_at).toBeNull()
  await page.reload()
  await expect(previewSurface(page).getByTestId(`account-archived-${initial[0].id}`)).toHaveCount(0)
  await expect(previewSurface(page).getByTestId(`account-archived-${initial[1].id}`)).toBeVisible()
  await previewSurface(page).getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: componentsZh.accountPanel.common.close, exact: true }).click()
  await expect(previewSurface(page).getByTestId(`home-project-${initial[0].name}`)).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-single-restored.png'))
})

test('archives project listing exposes its actual loading state before archived rows', { annotation: previewConsumption(PAGE_ID, 'settings-archives-project-read-pending', ['project-read-loading', 'project-read-loaded']) }, async ({ page }, testInfo) => {
  let reading!: Promise<Response>
  await openArchives(page, 'settings-archives-project-read-pending', () => { reading = archivedProjectResponse(page) })
  const content = previewSurface(page).getByTestId(PROJECT_PAGE)
  await expect(content.getByRole('status')).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('archives-project-list-loading.png') })
  await expect(content.getByRole('status')).toBeVisible()
  expect((await reading).status()).toBe(200)
  await projects(page)
  await expect(content.getByRole('status')).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('archives-project-list-loaded.png'))
})

test('archives project persistent read failure retries the exact archived query without claiming empty success', { annotation: previewConsumption(PAGE_ID, 'settings-archives-project-read-failed', ['project-read-error', 'project-read-retried']) }, async ({ page }, testInfo) => {
  let failed!: Promise<Response>
  await openArchives(page, 'settings-archives-project-read-failed', () => { failed = archivedProjectResponse(page, FAILURE_STATUS) })
  expect((await failed).status()).toBe(FAILURE_STATUS)
  const content = previewSurface(page).getByTestId(PROJECT_PAGE)
  await expect(content.getByRole('alert')).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).not.toBeVisible()
  const retry = content.getByRole('button', { name: componentsZh.taskArchive.retry, exact: true })
  await expect(retry).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-persistent-read-failed.png'))
  const reading = archivedProjectResponse(page)
  await retry.click()
  expect((await reading).status()).toBe(FAILURE_STATUS)
  await expect(content.getByRole('alert')).toBeVisible()
  await expect(retry).toBeEnabled()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-persistent-retry-failed.png'))
})

test('archives default tasks show real readonly history and agree with the project archive tree after restore', { annotation: previewConsumption(TASK_PAGE_ID, 'project-archives-states', ['populated', 'details', 'readonly', 'tree', 'restored']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'project-archives-states')
  const initial = await snapshot(page)
  const active = initial.projects.find(project => project.archived_at == null)!
  const rows = await tasks(page)
  const task = rows.find(row => row.project_path === active.root)!
  expect(task).toBeTruthy()
  const history = await openDetails(page, task)
  expect(history.status()).toBe(200)
  const payload = await history.json() as { turns: WireTurn[] }
  expect(payload.turns.some(turn => turn.kind === 'text' && turn.role === 'user')).toBe(true)
  expect(payload.turns.some(turn => turn.kind === 'text' && turn.role === 'assistant')).toBe(true)
  expect(payload.turns.some(turn => turn.kind === 'tool')).toBe(true)
  await assertReadonly(page)
  await assertHistoryRoles(page, payload.turns)
  await capturePreview(page, testInfo.outputPath('archives-task-details.png'))
  await previewSurface(page).getByTestId('project-archive-toggle').click()
  await expect(previewSurface(page).getByTestId(TASK_LIST)).not.toBeVisible()
  await previewSurface(page).getByTestId('project-archive-toggle').click()
  const treeRow = previewSurface(page).getByTestId(`project-archived-task-${task.session_id}`)
  await expect(treeRow).toContainText(task.title)
  await treeRow.getByRole('button', { name: task.title, exact: true }).click()
  await expect(previewSurface(page).getByTestId('archived-conversation')).toBeVisible()
  await expect(previewSurface(page).getByTestId('archived-conversation').getByRole('textbox')).toBeDisabled()
  await assertHistoryRoles(page, payload.turns)
  await capturePreview(page, testInfo.outputPath('archives-project-task-tree.png'))
  const restoring = responseFor(page, `${SESSIONS_PATH}/${task.session_id}/archive`, 'PUT')
  await treeRow.hover()
  endReadonly(page, task)
  await treeRow.getByRole('button', { name: componentsZh.taskArchive.restoreTask, exact: true }).click()
  expect((await restoring).status()).toBe(200)
  await expect(treeRow).toHaveCount(0)
  await expect(previewSurface(page).getByTestId(`project-task-${task.session_id}`)).toBeVisible()
  await expect(previewSurface(page).getByTestId('archived-conversation')).not.toBeVisible()
  expect((await snapshot(page)).sessions.find(row => row.session_id === task.session_id)?.archived).toBe(false)
  await capturePreview(page, testInfo.outputPath('archives-task-restored.png'))
})

test('archives projects support mixed selection, single restore and batch restore with active catalogue synchronization', { annotation: previewConsumption(PAGE_ID, 'settings-archives-states', ['populated', 'selected', 'mixed', 'restored']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-states')
  const rows = await projects(page)
  const all = previewSurface(page).getByTestId('account-archived-select-all')
  await expect(previewSurface(page).getByTestId('account-archived-batch-unarchive')).toBeDisabled()
  await previewSurface(page).getByTestId(`account-archived-select-${rows[0].id}`).click()
  await expect(all).toHaveAttribute('aria-checked', 'mixed')
  await expect(previewSurface(page).getByTestId('account-archived-selected-count')).toContainText('1')
  await capturePreview(page, testInfo.outputPath('archives-project-mixed.png'))
  await all.click()
  await expect(all).toHaveAttribute('aria-checked', 'true')
  await all.click()
  await expect(previewSurface(page).getByTestId('account-archived-batch-delete')).toBeDisabled()
  const single = responseFor(page, `${PROJECTS_PATH}/${rows[0].id}/archive`, 'POST')
  await previewSurface(page).getByTestId(`account-archived-restore-${rows[0].id}`).click()
  expect((await single).status()).toBe(200)
  await expect(previewSurface(page).getByTestId(`account-archived-${rows[0].id}`)).toHaveCount(0)
  await all.click()
  await previewSurface(page).getByTestId('account-archived-batch-unarchive').click()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  await expect(previewSurface(page).getByText('成功 1 项，失败 0 项', { exact: true })).toBeVisible()
  await page.reload()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  await previewSurface(page).getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  for (const project of rows) await expect(previewSurface(page).getByTestId(`home-project-${project.name}`)).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-projects-restored.png'))
})

test('archives project single and batch deletion confirm registration-only asynchronous operations and allow cancellation', { annotation: previewConsumption(PAGE_ID, 'settings-archives-states', ['selected', 'cancelled', 'deleted']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-states')
  const rows = await projects(page)
  await previewSurface(page).getByTestId(`account-archived-delete-${rows[0].id}`).click()
  const dialog = previewSurface(page).getByRole('alertdialog')
  await expect(dialog).toContainText('项目目录与文件会保留在本机原位置。')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(deleteCount(page)).toBe(0)
  await previewSurface(page).getByTestId(`account-archived-delete-${rows[0].id}`).click()
  const deleting = responseFor(page, `${PROJECTS_PATH}/${rows[0].id}`, 'DELETE')
  await previewSurface(page).getByTestId('account-archived-delete-confirm').click()
  const accepted = await deleting
  expect(accepted.status()).toBe(202)
  const { operation } = await accepted.json() as { operation: string }
  const terminal = await page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== `/api/content/operations/${operation}` || response.request().method() !== 'GET') return false
    return (await response.json() as { state: string }).state === 'succeeded'
  })
  expect(await terminal.json()).toMatchObject({ state: 'succeeded', result: { id: rows[0].id, removed: true, files_kept: true } })
  await expect(previewSurface(page).getByTestId(`account-archived-${rows[0].id}`)).toHaveCount(0)
  await previewSurface(page).getByTestId('account-archived-select-all').click()
  await previewSurface(page).getByTestId('account-archived-batch-delete').click()
  await expect(dialog).toContainText(rows[1].name)
  await capturePreview(page, testInfo.outputPath('archives-project-delete-confirm.png'))
  await previewSurface(page).getByTestId('account-archived-delete-confirm').click()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  expect(deleteCount(page)).toBe(2)
  await capturePreview(page, testInfo.outputPath('archives-projects-deleted.png'))
})

test('archives empty policy shows the genuine project settings empty state', { annotation: previewConsumption(PAGE_ID, 'settings-archives-empty', ['empty']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-empty')
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-projects-empty.png'))
})

test('archives empty policy shows the genuine project task archive empty state', { annotation: previewConsumption(TASK_PAGE_ID, 'project-archives-empty', ['empty']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'project-archives-empty')
  await expect(previewSurface(page).getByTestId(TASK_LIST)).toContainText(layoutZh.emptyArchivedTasks)
  expect((await snapshot(page)).sessions.filter(session => session.archived)).toHaveLength(0)
  await capturePreview(page, testInfo.outputPath('archives-tasks-empty.png'))
})

test('archives task list exposes real in-flight loading before the populated catalogue', { annotation: previewConsumption(TASK_PAGE_ID, 'project-archives-read-pending', ['loading', 'loaded']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'project-archives-read-pending')
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByRole('status')).toBeVisible()
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByRole('status')).toHaveCount(0)
  await tasks(page)
  await previewSurface(page).locator('body').evaluate(() => document.fonts.ready.then(() => undefined))
  await page.reload()
  await previewSurface(page).getByTestId('project-archive-toggle').click()
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByRole('status')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('archives-task-list-loading-reentry.png') })
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByRole('status')).toBeVisible()
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByRole('status')).toHaveCount(0)
  await tasks(page)
  await capturePreview(page, testInfo.outputPath('archives-task-list-loaded.png'))
})

test('archives task list failure retries the real request without manufacturing recovery', { annotation: previewConsumption(TASK_PAGE_ID, 'project-archives-read-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'project-archives-read-failed')
  const retry = previewSurface(page).getByTestId(TASK_LIST).getByRole('button', { name: layoutZh.loadFailed, exact: true })
  await expect(retry).toBeVisible()
  const reading = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === SESSIONS_PATH && url.searchParams.get('archived') === 'true' && url.searchParams.get('scope') === 'project' && response.request().method() === 'GET'
  })
  await retry.click()
  expect((await reading).status()).toBe(FAILURE_STATUS)
  await expect(retry).toBeVisible()
  await expect(previewSurface(page).getByTestId(TASK_LIST).getByText(layoutZh.emptyArchivedTasks, { exact: true })).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-task-list-failed.png'))
})

for (const mode of ['pending', 'failed', 'empty'] as const) {
  const sceneId = `project-archives-history-${mode}`
  const states = mode === 'pending' ? ['loading', 'loaded', 'readonly'] : mode === 'failed' ? ['error', 'retry-failed'] : ['empty', 'readonly']
  test(`archives readonly history consumes its ${mode} response through the original detail view`, { annotation: previewConsumption(TASK_PAGE_ID, sceneId, states) }, async ({ page }, testInfo) => {
    await openArchives(page, sceneId)
    const [row] = await tasks(page)
    watchReadonly(page, row)
    const reading = responseFor(page, `${HISTORY_PATH}${row.session_id}`, 'GET')
    await previewSurface(page).getByTestId(`project-archived-task-${row.session_id}`).getByRole('button', { name: row.title }).click()
    if (mode === 'pending') {
      await expect(previewSurface(page).getByTestId(TASK_PAGE).getByRole('status')).toBeVisible()
      await capturePreview(page, testInfo.outputPath('archives-history-loading.png'))
    }
    expect((await reading).status()).toBe(mode === 'failed' ? FAILURE_STATUS : 200)
    if (mode === 'failed') {
      const retry = previewSurface(page).getByTestId(TASK_PAGE).getByRole('button', { name: componentsZh.taskArchive.retry, exact: true })
      await expect(retry).toBeVisible()
      const retried = responseFor(page, `${HISTORY_PATH}${row.session_id}`, 'GET')
      await retry.click()
      expect((await retried).status()).toBe(FAILURE_STATUS)
      await expect(retry).toBeVisible()
      await expect(previewSurface(page).getByText('暂无历史消息', { exact: true })).not.toBeVisible()
    } else {
      const payload = await (await reading).json() as { turns: WireTurn[] }
      await expect(previewSurface(page).getByTestId(TASK_PAGE)).toBeVisible()
      if (mode === 'empty') {
        expect(payload.turns).toEqual([])
        await expect(previewSurface(page).getByTestId(TASK_PAGE).getByTestId('user-bubble')).toHaveCount(0)
        await expect(previewSurface(page).getByTestId(TASK_PAGE).locator('.answer-annotation-root')).toHaveCount(0)
        await expect(previewSurface(page).getByTestId(TASK_PAGE).getByTestId('turn-activity-trigger')).toHaveCount(0)
      } else {
        expect(payload.turns.length).toBeGreaterThan(0)
        await assertHistoryRoles(page, payload.turns)
      }
      await assertReadonly(page)
    }
    await capturePreview(page, testInfo.outputPath(`archives-history-${mode}.png`))
  })
}

for (const mode of ['pending', 'failed'] as const) {
  test(`archives task deletion ${mode} keeps its original confirmation and supports only the appropriate real action`, { annotation: previewConsumption(TASK_PAGE_ID, `project-archives-write-${mode}`, mode === 'pending' ? ['pending', 'deleted'] : ['error', 'retried', 'deleted']) }, async ({ page }, testInfo) => {
    await openArchives(page, `project-archives-write-${mode}`)
    const [task] = await tasks(page)
    const row = previewSurface(page).getByTestId(`project-archived-task-${task.session_id}`)
    await row.hover()
    await row.getByRole('button', { name: assistantZh.panel.delete, exact: true }).click()
    const dialog = previewSurface(page).getByTestId('session-delete-confirm')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(deleteCount(page)).toBe(0)
    await row.hover()
    await row.getByRole('button', { name: assistantZh.panel.delete, exact: true }).click()
    const deleting = responseFor(page, `${SESSIONS_PATH}/${task.session_id}`, 'DELETE')
    await dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true }).click()
    if (mode === 'pending') {
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: shellZh.delete.deleting, exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await capturePreview(page, testInfo.outputPath('archives-task-delete-pending.png'))
      expect((await deleting).status()).toBe(200)
    } else {
      expect((await deleting).status()).toBe(FAILURE_STATUS)
      await expect(dialog).toContainText(shellZh.delete.failed)
      await expect(dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true })).toBeEnabled()
      await expect(row).toBeVisible()
      await capturePreview(page, testInfo.outputPath('archives-task-delete-failed.png'))
      const retried = responseFor(page, `${SESSIONS_PATH}/${task.session_id}`, 'DELETE')
      await dialog.getByRole('button', { name: shellZh.delete.confirm, exact: true }).click()
      expect((await retried).status()).toBe(200)
    }
    await expect(dialog).not.toBeVisible()
    await expect(row).toHaveCount(0)
    expect((await snapshot(page)).sessions.some(session => session.session_id === task.session_id)).toBe(false)
    expect(deleteCount(page)).toBe(mode === 'pending' ? 1 : 2)
    await capturePreview(page, testInfo.outputPath(`archives-task-deleted-${mode}.png`))
  })
}

test('archives project batch restore reports partial failure and retries the retained item through real selection', { annotation: previewConsumption(PAGE_ID, 'settings-archives-write-failed', ['partial', 'error', 'retried', 'restored']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-write-failed')
  const rows = await projects(page)
  await previewSurface(page).getByTestId('account-archived-select-all').click()
  await previewSurface(page).getByTestId('account-archived-batch-unarchive').click()
  await expect(previewSurface(page).getByText('成功 1 项，失败 1 项', { exact: true })).toBeVisible()
  const remaining = (await snapshot(page)).projects.filter(project => project.archived_at != null)
  expect(remaining).toHaveLength(1)
  await expect(previewSurface(page).getByTestId(`account-archived-${remaining[0].id}`)).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-archived-batch-unarchive')).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('archives-project-partial-failure.png'))
  await previewSurface(page).getByTestId(`account-archived-select-${remaining[0].id}`).click()
  await previewSurface(page).getByTestId('account-archived-batch-unarchive').click()
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  const current = await snapshot(page)
  for (const project of rows) expect(current.projects.find(row => row.id === project.id)?.archived_at).toBeNull()
  await capturePreview(page, testInfo.outputPath('archives-project-partial-retried.png'))
})

test('archives project batch restore disables selection and actions while the real request is pending', { annotation: previewConsumption(PAGE_ID, 'settings-archives-write-pending', ['pending', 'restored']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-write-pending')
  const rows = await projects(page)
  await previewSurface(page).getByTestId('account-archived-select-all').click()
  await previewSurface(page).getByTestId('account-archived-batch-unarchive').click()
  await expect(previewSurface(page).getByTestId('account-archived-select-all')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('account-archived-batch-unarchive')).toBeDisabled()
  await expect(previewSurface(page).getByTestId('account-archived-batch-delete')).toBeDisabled()
  for (const project of rows) await expect(previewSurface(page).getByTestId(`account-archived-select-${project.id}`)).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('archives-project-batch-pending.png'))
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-batch-completed.png'))
})

test('archives project batch deletion keeps the real asynchronous confirmation busy and preserves virtual files', { annotation: previewConsumption(PAGE_ID, 'settings-archives-write-pending', ['pending', 'deleted']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-write-pending')
  const rows = await projects(page)
  await previewSurface(page).getByTestId('account-archived-select-all').click()
  await previewSurface(page).getByTestId('account-archived-batch-delete').click()
  const dialog = previewSurface(page).getByRole('alertdialog')
  await expect(dialog).toContainText('永久删除选中的 2 个项目？')
  await expect(dialog).toContainText('项目目录与文件会保留在本机原位置。')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(deleteCount(page)).toBe(0)
  await previewSurface(page).getByTestId('account-archived-batch-delete').click()
  const completed: { state: string; result?: { id: string; removed: boolean; files_kept: boolean } }[] = []
  page.on('response', async response => {
    if (!new URL(response.url()).pathname.startsWith('/api/content/operations/') || response.status() !== 200) return
    const payload = await response.json() as typeof completed[number]
    if (payload.state === 'succeeded') completed.push(payload)
  })
  await previewSurface(page).getByTestId('account-archived-delete-confirm').click()
  await expect(previewSurface(page).getByTestId('account-archived-delete-confirm')).toHaveAttribute('aria-disabled', 'true')
  await expect(previewSurface(page).getByTestId('account-archived-select-all')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await capturePreview(page, testInfo.outputPath('archives-project-delete-pending.png'))
  await expect(previewSurface(page).getByTestId('account-settings-archives-empty')).toBeVisible()
  await expect(dialog).not.toBeVisible()
  await expect(previewSurface(page).getByText('成功 2 项，失败 0 项', { exact: true })).toBeVisible()
  for (const row of rows) expect(completed.some(payload => payload.result?.id === row.id && payload.result.removed && payload.result.files_kept)).toBe(true)
  expect(deleteCount(page)).toBe(2)
  await capturePreview(page, testInfo.outputPath('archives-project-batch-deleted.png'))
})

test('archives dark English project navigation preserves readonly roles through public controls', { annotation: previewConsumption(TASK_PAGE_ID, 'project-archives-states', ['details', 'readonly']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'project-archives-states')
  const [task] = await tasks(page)
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await openPreviewTools(page)
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('F8')
  await page.getByRole('button', { name: previewEn.close, exact: true }).click()
  await expect(page.getByRole('heading', { name: previewEn.title, exact: true })).not.toBeVisible()
  await previewSurface(page).getByTestId('project-archive-toggle').click()
  const history = await openDetails(page, task)
  expect(history.status()).toBe(200)
  const payload = await history.json() as { turns: WireTurn[] }
  await assertHistoryRoles(page, payload.turns)
  await assertReadonly(page)
  await capturePreview(page, testInfo.outputPath('archives-dark-english-history.png'))
})

test('archives dark English project settings cancel deletion through public controls', { annotation: previewConsumption(PAGE_ID, 'settings-archives-states', ['selected', 'cancelled']) }, async ({ page }, testInfo) => {
  await openArchives(page, 'settings-archives-states')
  const settings = previewSurface(page).getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: componentsZh.accountPanel.common.close, exact: true }).click()
  await expect(settings).not.toBeVisible()
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await openPreviewTools(page)
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('F8')
  await page.getByRole('button', { name: previewEn.close, exact: true }).click()
  await previewSurface(page).getByTestId('activity-account').click()
  await previewSurface(page).getByTestId('account-menu-settings').click()
  await previewSurface(page).getByTestId('account-settings-nav-archives').click()
  await expect(previewSurface(page).getByTestId(PROJECT_PAGE)).toBeVisible()
  const [project] = (await snapshot(page)).projects.filter(project => project.archived_at != null)
  expect(project).toBeTruthy()
  await previewSurface(page).getByTestId(`account-archived-select-${project.id}`).click()
  await expect(previewSurface(page).getByTestId('account-archived-select-all')).toHaveAttribute('aria-checked', 'mixed')
  await previewSurface(page).getByTestId('account-archived-batch-delete').click()
  const confirmation = previewSurface(page).getByRole('alertdialog')
  await expect(confirmation).toContainText(componentsEn.accountPanel.archives.deleteFilesNote)
  await expect(confirmation.getByRole('button', { name: componentsEn.accountPanel.archives.delete, exact: true })).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('archives-dark-english-delete-confirm.png'))
  await confirmation.getByRole('button', { name: componentsEn.accountPanel.archives.cancel, exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  await expect(previewSurface(page).getByTestId(`account-archived-${project.id}`)).toBeVisible()
  expect(deleteCount(page)).toBe(0)
})
