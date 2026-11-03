import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page } from './testing'
import type { WorkspaceRootState } from '../src/renderer/src/features/project/api'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'
import type { PreviewStorageBootstrap } from './directory'
import { PREVIEW_STORAGE } from './storage'

const PAGE_ID = 'settings-storage'
const ROOT_PATH = PREVIEW_STORAGE.path
const STATE_PATH = '/__preview/state'
const CHOICE_ID = PREVIEW_STORAGE.choiceIds[0]
const WRITE_FAILURE_STATUS = 503
type Snapshot = { storage: PreviewStorageBootstrap; projects: { id: string; root: string }[] }
type Observation = { writes: number; failures: { path: string; method: string; status: number }[]; externalOrigins: string[]; failed: boolean }
const OBSERVATIONS = new WeakMap<Page, Observation>()

test.beforeEach(({ page }) => {
  const observations: Observation = { writes: 0, failures: [], externalOrigins: [], failed: false }
  OBSERVATIONS.set(page, observations)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observations.externalOrigins.includes(url.origin)) observations.externalOrigins.push(url.origin)
    if (url.pathname === ROOT_PATH && request.method() === 'PUT') observations.writes += 1
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path === STATE_PATH) && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('storage-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('storage-http-summary', { path, contentType: 'application/json' })
  expect(observations.externalOrigins).toEqual([])
  expect(observations.failures).toEqual(observations.failed ? [{ path: ROOT_PATH, method: 'PUT', status: WRITE_FAILURE_STATUS }] : [])
})

async function snapshot(page: Page): Promise<Snapshot> {
  const parameters = new URL(page.url()).searchParams
  const response = await page.request.get(`${STATE_PATH}?${parameters}`)
  expect(response.status()).toBe(200)
  return await response.json() as Snapshot
}

async function effectiveRoot(page: Page): Promise<WorkspaceRootState> {
  const response = await page.request.get(`${ROOT_PATH}?previewInstance=${new URL(page.url()).searchParams.get('previewInstance')}`)
  expect(response.status()).toBe(200)
  return await response.json() as WorkspaceRootState
}

async function openStorage(page: Page, sceneId: string): Promise<{ initial: Snapshot; root: WorkspaceRootState; chosen: string }> {
  OBSERVATIONS.get(page)!.failed = sceneId === 'settings-storage-save-failed'
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('account-settings-storage')).toBeVisible()
  const initial = await snapshot(page)
  const root = await effectiveRoot(page)
  const chosen = initial.storage.choices.find(choice => choice.id === CHOICE_ID)!.path
  await expect(previewSurface(page).getByTestId('storage-data-home-value')).toHaveText(initial.storage.config.home)
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(root.configured || root.root)
  return { initial, root, chosen }
}

async function choose(page: Page): Promise<void> {
  await page.getByTestId('storage-container-root-change').click()
  const dialog = page.getByTestId('preview-directory-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('preview-directory-confirm')).toBeDisabled()
  await page.getByTestId(`preview-directory-choice-${CHOICE_ID}`).click()
  await expect(page.getByTestId(`preview-directory-choice-${CHOICE_ID}`)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('preview-directory-confirm')).toBeEnabled()
}

function writing(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === ROOT_PATH && response.request().method() === 'PUT')
}

test('storage displays virtual paths, cancels its explicit simulated picker and preserves only the configured root across reload', { annotation: previewConsumption(PAGE_ID, 'settings-storage-states', ['loaded', 'cancelled', 'saved', 'restart-required', 'reloaded']) }, async ({ page }, testInfo) => {
  const { initial, root, chosen } = await openStorage(page, 'settings-storage-states')
  await capturePreview(page, testInfo.outputPath('storage-overview.png'))
  await choose(page)
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).toContainText('不访问本机文件系统')
  await capturePreview(page, testInfo.outputPath('storage-virtual-picker.png'))
  await previewSurface(page).getByTestId('preview-directory-cancel').click()
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).not.toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(0)
  await choose(page)
  await page.keyboard.press('Escape')
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).not.toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(0)
  await choose(page)
  const saved = writing(page)
  await previewSurface(page).getByTestId('preview-directory-confirm').click()
  const response = await saved
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ root: root.root, configured: chosen, restartRequired: true })
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(chosen)
  await expect(previewSurface(page).getByTestId('storage-container-root-restart')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('storage-configured.png'))
  await page.reload()
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(chosen)
  await expect(previewSurface(page).getByTestId('storage-data-home-value')).toHaveText(initial.storage.config.home)
  expect(await effectiveRoot(page)).toEqual({ root: root.root, configured: chosen })
  await expect(previewSurface(page).getByTestId('storage-container-root-restart')).not.toBeVisible()
  expect((await snapshot(page)).projects).toEqual(initial.projects)
  expect(OBSERVATIONS.get(page)!.writes).toBe(1)
  await capturePreview(page, testInfo.outputPath('storage-reloaded.png'))
  const settings = previewSurface(page).getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
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
  await previewSurface(page).getByTestId('activity-account').click()
  await previewSurface(page).getByTestId('account-menu-settings').click()
  await previewSurface(page).getByTestId('account-settings-nav-storage').click()
  await expect(previewSurface(page).getByTestId('account-settings-storage')).toBeVisible()
  await choose(page)
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).toContainText('does not access local files')
  await capturePreview(page, testInfo.outputPath('storage-picker-dark-english.png'))
  await page.keyboard.press('Escape')
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).not.toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(1)
})

test('storage prevents duplicate changes while the original workspace-root save is pending', { annotation: previewConsumption(PAGE_ID, 'settings-storage-save-pending', ['loaded', 'saving', 'saved', 'restart-required']) }, async ({ page }, testInfo) => {
  const { chosen } = await openStorage(page, 'settings-storage-save-pending')
  await choose(page)
  let settled = false
  const saved = writing(page).then(response => { settled = true; return response })
  await previewSurface(page).getByTestId('preview-directory-confirm').click()
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeDisabled()
  expect(settled).toBe(false)
  await capturePreview(page, testInfo.outputPath('storage-save-pending.png'))
  expect(settled).toBe(false)
  expect((await saved).status()).toBe(200)
  await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(chosen)
  await expect(previewSurface(page).getByTestId('storage-container-root-restart')).toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(1)
  await capturePreview(page, testInfo.outputPath('storage-save-completed.png'))
})

test('storage keeps the old root after a failed save and retries through real directory selection', { annotation: previewConsumption(PAGE_ID, 'settings-storage-save-failed', ['loaded', 'error', 'retried', 'saved']) }, async ({ page }, testInfo) => {
  const { root, chosen, initial } = await openStorage(page, 'settings-storage-save-failed')
  await choose(page)
  const failed = writing(page)
  await previewSurface(page).getByTestId('preview-directory-confirm').click()
  expect((await failed).status()).toBe(WRITE_FAILURE_STATUS)
  await expect(previewSurface(page).getByTestId('storage-container-root-failed')).toBeVisible()
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(root.configured || root.root)
  await capturePreview(page, testInfo.outputPath('storage-save-failed.png'))
  await choose(page)
  const retried = writing(page)
  await previewSurface(page).getByTestId('preview-directory-confirm').click()
  expect((await retried).status()).toBe(200)
  await expect(previewSurface(page).getByTestId('storage-container-root-failed')).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('storage-container-root-value')).toHaveText(chosen)
  await expect(previewSurface(page).getByTestId('storage-container-root-restart')).toBeVisible()
  expect(await effectiveRoot(page)).toMatchObject({ root: root.root, configured: chosen })
  expect((await snapshot(page)).projects).toEqual(initial.projects)
  expect(OBSERVATIONS.get(page)!.writes).toBe(2)
  await capturePreview(page, testInfo.outputPath('storage-save-retried.png'))
})
