import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import type { FileVersionSettings } from '../src/renderer/src/features/resources/settings'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'

const PAGE_ID = 'settings-files'
const SETTINGS_PATH = '/api/serve/settings/file-versions'
const OBSERVATIONS = new WeakMap<Page, { writes: number; failures: { path: string; method: string; status: number }[]; externalOrigins: string[] }>()

test.beforeEach(({ page }) => {
  const observations = { writes: 0, failures: [] as { path: string; method: string; status: number }[], externalOrigins: [] as string[] }
  OBSERVATIONS.set(page, observations)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observations.externalOrigins.includes(url.origin)) observations.externalOrigins.push(url.origin)
    if (url.pathname === SETTINGS_PATH && request.method() === 'POST') observations.writes += 1
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path === '/__preview/state') && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('configuration-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('configuration-http-summary', { path, contentType: 'application/json' })
  expect(observations.externalOrigins).toEqual([])
  const failed = new URL(page.url()).searchParams.get('scene') === 'settings-files-save-failed'
  expect(observations.failures).toEqual(failed ? [{ path: SETTINGS_PATH, method: 'POST', status: 503 }] : [])
})

async function openConfiguration(page: Page, sceneId: string): Promise<FileVersionSettings> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  const reading = page.waitForResponse(response => new URL(response.url()).pathname === SETTINGS_PATH && response.request().method() === 'GET')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('account-settings-files')).toBeVisible()
  const response = await reading
  expect(response.status()).toBe(200)
  const settings = await response.json() as FileVersionSettings
  await expect(previewSurface(page).getByTestId('file-version-limit')).toHaveValue(String(settings.max_versions_per_file))
  await expect(previewSurface(page).getByTestId('file-version-limit')).toBeEnabled()
  return settings
}

function writing(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === SETTINGS_PATH && response.request().method() === 'POST')
}

test('file settings validate and save through the original automatic form and restore preferences after reload', { annotation: previewConsumption(PAGE_ID, 'settings-files-states', ['loaded', 'invalid', 'editing', 'saved', 'reloaded']) }, async ({ page }, testInfo) => {
  const settings = await openConfiguration(page, 'settings-files-states')
  const limit = previewSurface(page).getByTestId('file-version-limit')
  await previewSurface(page).locator('body').evaluate(() => {
    const events: { type: string; key?: string; target: string | null; role: string | null; prevented: boolean }[] = []
    const snapshot = window as unknown as { fileSettingsKeyboard: typeof events }
    snapshot.fileSettingsKeyboard = events
    for (const type of ['keydown', 'keyup', 'focusin', 'click']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null
      events.push({ type: event.type, ...(event instanceof KeyboardEvent ? { key: event.key } : {}), target: target?.getAttribute('data-testid') ?? target?.tagName ?? null, role: target?.getAttribute('aria-label') ?? null, prevented: event.defaultPrevented })
    })
  })
  await limit.fill('0')
  await limit.press('Enter')
  const keyboardPath = testInfo.outputPath('configuration-keyboard.json')
  await writeFile(keyboardPath, JSON.stringify(await previewSurface(page).locator('body').evaluate(() => (window as unknown as { fileSettingsKeyboard: unknown }).fileSettingsKeyboard), null, 2))
  await testInfo.attach('configuration-keyboard', { path: keyboardPath, contentType: 'application/json' })
  await expect(previewSurface(page).getByTestId('account-settings-files')).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-notifications')).not.toBeVisible()
  await expect(limit).toHaveAttribute('aria-invalid', 'true')
  await expect(previewSurface(page).getByText('每个文件可保留 1–1000 个版本', { exact: true })).toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(0)
  const next = String(settings.max_versions_per_file + 1)
  await limit.fill(next)
  const saved = writing(page)
  await limit.press('Enter')
  expect((await saved).status()).toBe(200)
  await expect(previewSurface(page).getByText('文件版本设置已保存', { exact: true })).toBeVisible()
  await expect(limit).toHaveValue(next)
  const size = previewSurface(page).getByTestId('file-version-max-size')
  await size.fill('0')
  await size.press('Enter')
  await expect(size).toHaveAttribute('aria-invalid', 'true')
  await expect(previewSurface(page).getByText('最大文件大小需为 1–2048 MB', { exact: true })).toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(1)
  const nextSize = String(Math.floor(settings.max_file_size_kb / 1024) + 1)
  await size.fill(nextSize)
  const resized = writing(page)
  await size.press('Enter')
  expect((await resized).status()).toBe(200)
  await expect(size).toBeEnabled()
  const autoSave = previewSurface(page).getByTestId('file-version-auto-save')
  const format = previewSurface(page).getByTestId('file-version-format-on-save')
  const expectedAutoSave = !(await autoSave.isChecked())
  const expectedFormat = !(await format.isChecked())
  const autoSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/__preview/state' && response.request().method() === 'POST')
  await autoSave.click()
  expect((await autoSaved).status()).toBe(200)
  const formatted = page.waitForResponse(response => new URL(response.url()).pathname === '/__preview/state' && response.request().method() === 'POST')
  await format.click()
  expect((await formatted).status()).toBe(200)
  await capturePreview(page, testInfo.outputPath('configuration-saved.png'))
  await page.reload()
  await expect(limit).toHaveValue(next)
  await expect(limit).toBeEnabled()
  await expect(size).toHaveValue(nextSize)
  await expect(autoSave).toBeChecked({ checked: expectedAutoSave })
  await expect(format).toBeChecked({ checked: expectedFormat })
  await capturePreview(page, testInfo.outputPath('configuration-reloaded.png'))
})

test('file settings delayed save disables the real inputs until the single response completes', { annotation: previewConsumption(PAGE_ID, 'settings-files-save-pending', ['editing', 'saving', 'saved']) }, async ({ page }, testInfo) => {
  const settings = await openConfiguration(page, 'settings-files-save-pending')
  const limit = previewSurface(page).getByTestId('file-version-limit')
  await limit.fill(String(settings.max_versions_per_file + 1))
  const saved = writing(page)
  await limit.press('Enter')
  await expect(limit).toBeDisabled()
  await expect(previewSurface(page).getByTestId('file-version-max-size')).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('configuration-saving.png'))
  await expect(limit).toBeDisabled()
  expect((await saved).status()).toBe(200)
  await expect(limit).toBeEnabled()
  expect(OBSERVATIONS.get(page)!.writes).toBe(1)
  await capturePreview(page, testInfo.outputPath('configuration-save-completed.png'))
})

test('file settings failed save preserves the input and retries using the actual error toast action', { annotation: previewConsumption(PAGE_ID, 'settings-files-save-failed', ['editing', 'error', 'retried', 'saved']) }, async ({ page }, testInfo) => {
  const settings = await openConfiguration(page, 'settings-files-save-failed')
  const next = String(settings.max_versions_per_file + 1)
  const limit = previewSurface(page).getByTestId('file-version-limit')
  await limit.fill(next)
  const failed = writing(page)
  await limit.press('Enter')
  expect((await failed).status()).toBe(503)
  await expect(previewSurface(page).getByText('文件版本设置请求失败', { exact: true })).toBeVisible()
  await expect(limit).toHaveValue(next)
  await expect(limit).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('configuration-save-failed.png'))
  const retried = writing(page)
  await previewSurface(page).getByRole('button', { name: '重试', exact: true }).click()
  expect((await retried).status()).toBe(200)
  await expect(previewSurface(page).getByText('文件版本设置已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(limit).toHaveValue(next)
  await expect(limit).toBeEnabled()
  expect(OBSERVATIONS.get(page)!.writes).toBe(2)
  await capturePreview(page, testInfo.outputPath('configuration-retry-reloaded.png'))
})
