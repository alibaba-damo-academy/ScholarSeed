import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import type { RendererPreferences } from '../src/preferences'
import { DEFAULT_SELECTION_PROMPTS } from '../src/prompts'
import { PREVIEW_CATALOG } from './catalog'
import { previewConsumption } from './coverage'
import { capturePreview } from './capture'

const FAILURES = new WeakMap<Page, { method: string; path: string; status: number }[]>()
const STATE_PATH = '/__preview/state'
const SHORTCUT_ID = 'markdown.bold'
const SHORTCUT_SELECTOR = `[data-shortcut-id="${SHORTCUT_ID}"]`

test.beforeEach(async ({ page }) => {
  const failures: { method: string; path: string; status: number }[] = []
  FAILURES.set(page, failures)
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path === STATE_PATH) && response.status() >= 400) failures.push({ method: response.request().method(), path, status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const failures = FAILURES.get(page) ?? []
  const path = testInfo.outputPath('settings-api-failures.json')
  await writeFile(path, JSON.stringify(failures, null, 2))
  await testInfo.attach('settings-api-failures', { path, contentType: 'application/json' })
  expect(failures, 'Settings must use the real preference bridge without unhandled mock contracts').toEqual([])
})

async function openSettings(page: Page, id: string, surface?: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === id)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')

  await openPreviewScenario(page, entry.id, entry.scenarios[0].id)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId(surface ?? `account-settings-${entry.entry}`)).toBeVisible()
}

async function savePreferences(page: Page, matches: (preferences: RendererPreferences) => boolean, action: () => Promise<void>): Promise<void> {
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === STATE_PATH && response.request().method() === 'POST' && matches(response.request().postDataJSON().preferences as RendererPreferences))
  await action()
  const response = await saved
  expect(response.status()).toBe(200)
  expect(matches((await response.json()).preferences as RendererPreferences)).toBe(true)
}

test('preferences page uses real controls and persists appearance, auto-save and language after reload', { annotation: previewConsumption('settings-preferences', 'settings-preferences-states', ['loaded', 'editing']) }, async ({ page }, testInfo) => {
  await openSettings(page, 'settings-preferences')
  const preferences = previewSurface(page).getByTestId('account-settings-preferences')
  await preferences.getByRole('combobox', { name: '外观', exact: true }).click()
  await savePreferences(page, value => value.theme === 'dark', async () => { await previewSurface(page).getByRole('option', { name: '深色', exact: true }).click() })
  await expect(previewSurface(page).locator('html')).toHaveAttribute('data-theme', 'dark')
  const autoSave = preferences.getByTestId('preferences-auto-save')
  const initial = await autoSave.isChecked()
  await savePreferences(page, value => value.autoSave === !initial, async () => { await autoSave.click() })
  await preferences.getByRole('combobox', { name: '语言', exact: true }).click()
  await savePreferences(page, value => value.language === 'en', async () => { await previewSurface(page).getByRole('option', { name: 'English', exact: true }).click() })
  await page.reload()
  await expect(preferences).toBeVisible()
  await expect(previewSurface(page).locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(preferences.getByRole('combobox', { name: 'Language', exact: true })).toContainText('English')
  await expect(preferences.getByRole('combobox', { name: 'Appearance', exact: true })).toContainText('Dark')
  await expect(autoSave).toBeChecked({ checked: !initial })
  await page.screenshot({ path: testInfo.outputPath('settings-preferences-dark-english.png'), fullPage: true })
})

test('shortcuts page filters, rejects conflicts, records a real key combination and restores its persisted default', { annotation: previewConsumption('settings-shortcuts', 'settings-shortcuts-states', ['loaded', 'editing', 'error']) }, async ({ page }, testInfo) => {
  await openSettings(page, 'settings-shortcuts')
  const settings = previewSurface(page).getByTestId('account-settings-shortcuts')
  const row = settings.locator(SHORTCUT_SELECTOR)
  const original = await row.locator('kbd').innerText()
  const search = settings.getByTestId('shortcut-search')
  await search.fill('preview-no-matching-shortcut')
  await expect(settings.getByText('未找到快捷键', { exact: true })).toBeVisible()
  await search.fill('切换粗体')
  await expect(settings.locator('[data-shortcut-id]')).toHaveCount(1)
  await row.getByTestId(`shortcut-edit-${SHORTCUT_ID}`).click()
  const dialog = previewSurface(page).getByTestId('shortcut-editor-dialog')
  const recorder = dialog.getByTestId('shortcut-recorder')
  await recorder.press('ControlOrMeta+s')
  await expect(dialog.getByRole('alert')).toContainText('冲突')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('settings-shortcuts-conflict.png'), fullPage: true })
  await recorder.press('ControlOrMeta+Alt+Shift+y')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  const changed = await recorder.innerText()
  expect(changed).not.toBe(original)
  await savePreferences(page, value => Boolean(value.shortcutOverrides[SHORTCUT_ID]), async () => { await dialog.getByRole('button', { name: '保存', exact: true }).click() })
  await expect(dialog).not.toBeVisible()
  await expect(row.locator('kbd')).toHaveText(changed)
  await page.reload()
  await expect(settings).toBeVisible()
  await expect(row.locator('kbd')).toHaveText(changed)
  await page.screenshot({ path: testInfo.outputPath('settings-shortcuts-saved.png'), fullPage: true })
  await row.getByTestId(`shortcut-edit-${SHORTCUT_ID}`).click()
  await savePreferences(page, value => !Object.prototype.hasOwnProperty.call(value.shortcutOverrides, SHORTCUT_ID), async () => { await dialog.getByRole('button', { name: '恢复默认', exact: true }).click() })
  await page.reload()
  await expect(row.locator('kbd')).toHaveText(original)
  await page.screenshot({ path: testInfo.outputPath('settings-shortcuts-restored.png'), fullPage: true })
})

test('selection prompts page validates empty drafts, saves through the actual form and restores the persisted default', { annotation: previewConsumption('settings-prompts', 'settings-prompts-states', ['loaded', 'editing']) }, async ({ page }, testInfo) => {
  await openSettings(page, 'settings-prompts')
  const settings = previewSurface(page).getByTestId('account-settings-prompts')
  const explain = settings.getByTestId('selection-prompt-explain')
  const save = settings.getByTestId('selection-prompts-save')
  await expect(explain).toHaveValue(DEFAULT_SELECTION_PROMPTS.explain)
  await expect(save).toBeDisabled()
  await explain.fill('')
  await expect(save).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('settings-prompts-invalid.png'), fullPage: true })
  const revised = 'Reviewed preview selection instruction: explain the selected text clearly.'
  await explain.fill(revised)
  await expect(save).toBeEnabled()
  await savePreferences(page, value => value.selectionPrompts.explain === revised, async () => { await save.click() })
  await expect(save).toBeDisabled()
  await page.reload()
  await expect(explain).toHaveValue(revised)
  await page.screenshot({ path: testInfo.outputPath('settings-prompts-saved.png'), fullPage: true })
  await settings.getByTestId('selection-prompt-restore-explain').click()
  await expect(explain).toHaveValue(DEFAULT_SELECTION_PROMPTS.explain)
  await savePreferences(page, value => value.selectionPrompts.explain === DEFAULT_SELECTION_PROMPTS.explain, async () => { await save.click() })
  await page.reload()
  await expect(explain).toHaveValue(DEFAULT_SELECTION_PROMPTS.explain)
  await expect(save).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('settings-prompts-restored.png'), fullPage: true })
})

test('notification settings preserve the real sound preference without invoking native notification controls', { annotation: previewConsumption('settings-notifications', 'settings-notifications-states', ['loaded', 'editing']) }, async ({ page }, testInfo) => {
  await openSettings(page, 'settings-notifications')
  const settings = previewSurface(page).getByTestId('account-settings-notifications')
  const sound = settings.getByTestId('notification-sound')
  const initial = await sound.isChecked()
  await expect(settings.getByTestId('notification-desktop')).toBeVisible()
  await expect(settings.getByTestId('notification-mark-read')).toBeVisible()
  await savePreferences(page, value => value.soundAlerts === !initial, async () => { await sound.click() })
  await page.reload()
  await expect(settings).toBeVisible()
  await expect(sound).toBeChecked({ checked: !initial })
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('settings-notifications-sound-saved.png'), fullPage: true })
  await savePreferences(page, value => value.soundAlerts === initial, async () => { await sound.click() })
  await page.reload()
  await expect(sound).toBeChecked({ checked: initial })
  await page.screenshot({ path: testInfo.outputPath('settings-notifications-sound-restored.png'), fullPage: true })
})

test('about settings display the real preview information, persist an update preference and block external link actions', { annotation: previewConsumption('settings-about', 'settings-about-states', ['loaded', 'editing']) }, async ({ page, context }, testInfo) => {
  await openSettings(page, 'settings-about', 'about-settings-page')
  const about = previewSurface(page).getByTestId('about-settings-page')
  await expect(about.getByTestId('version-current')).toHaveText('当前版本：preview')
  await expect(about.getByTestId('version-status')).toBeVisible()
  await expect(about.getByTestId('about-copyright')).toContainText('书深')
  await expect(about.getByTestId('about-guide')).toHaveCount(0)
  const automatic = about.getByTestId('update-auto-download')
  const initial = await automatic.isChecked()
  await savePreferences(page, value => value.autoDownloadUpdates === !initial, async () => { await automatic.click() })
  await page.reload()
  await expect(about).toBeVisible()
  await expect(automatic).toBeChecked({ checked: !initial })
  await page.screenshot({ path: testInfo.outputPath('settings-about-preference-saved.png'), fullPage: true })
  const originalUrl = page.url()
  const originalPages = context.pages().length
  const popups: string[] = []
  const externalRequests: string[] = []
  page.on('popup', popup => popups.push(popup.url()))
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(originalUrl).origin) externalRequests.push(url.origin)
  })
  for (const action of ['about-site', 'about-community', 'about-manual']) await about.getByTestId(action).click()
  const dialog = previewSurface(page).getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.keyboard.press('F8')
  const diagnostics = previewSurface(page).locator('pre').filter({ hasText: 'external-navigation-blocked' })
  await expect(diagnostics).toHaveCount(1)
  const events = JSON.parse(await diagnostics.innerText()) as { kind?: string }[]
  expect(events.filter(event => event.kind === 'external-navigation-blocked')).toHaveLength(3)
  expect(popups).toEqual([])
  expect(externalRequests).toEqual([])
  expect(context.pages()).toHaveLength(originalPages)
  expect(page.url()).toBe(originalUrl)
  await capturePreview(page, testInfo.outputPath('settings-about-external-blocked.png'))
})
