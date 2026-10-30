import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewTools, previewSurface, expect, test, type Page } from './testing'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window.ts'
import resourcesZh from '../src/localization/locales/zh/resources.json'
import { PREVIEW_ORIGIN } from './constants'
import { PREVIEW_SEARCH } from './searches'

const ROOTS_PATH = '/api/content/roots'
type Diagnostic = { apiFailures: { path: string; method: string; status: number }[]; roots: { method: string; path: string; query: string; status: number; payload?: unknown; error?: string }[]; consoleErrors: string[]; externalOrigins: string[] }
const DIAGNOSTICS = new WeakMap<Page, { value: Diagnostic; pending: Promise<void>[] }>()

test.beforeEach(({ page }) => {
  const value: Diagnostic = { apiFailures: [], roots: [], consoleErrors: [], externalOrigins: [] }
  const pending: Promise<void>[] = []
  DIAGNOSTICS.set(page, { value, pending })
  page.on('console', message => { if (message.type() === 'error') value.consoleErrors.push(message.text()) })
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !value.externalOrigins.includes(url.origin)) value.externalOrigins.push(url.origin)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== PREVIEW_ORIGIN) return
    const method = response.request().method()
    const status = response.status()
    if (url.pathname.startsWith('/api/') && status >= 400) value.apiFailures.push({ path: url.pathname, method, status })
    if (url.pathname === ROOTS_PATH) pending.push(response.json().then(payload => { value.roots.push({ method, path: url.pathname, query: url.search, status, payload }) }, error => { value.roots.push({ method, path: url.pathname, query: url.search, status, error: error instanceof Error ? error.message : String(error) }) }))
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const diagnostic = DIAGNOSTICS.get(page)!
  await Promise.all(diagnostic.pending)
  const path = testInfo.outputPath('chrome-http-summary.json')
  await writeFile(path, JSON.stringify(diagnostic.value, null, 2))
  await testInfo.attach('chrome-http-summary', { path, contentType: 'application/json' })
  expect(diagnostic.value.apiFailures).toEqual([])
  expect(diagnostic.value.externalOrigins).toEqual([])
})

test('preview controls dock on the right without a bottom launcher', async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&page=viewer-literature_search&scene=viewer-literature_search-states`)
  await previewSurface(page).getByRole('tab', { name: new RegExp(PREVIEW_SEARCH.literatureQuery) }).click()
  await expect(previewSurface(page).getByTestId('literature-search-tab')).toBeVisible()
  const console = page.getByRole('dialog', { name: 'PDFE 工作台', exact: true })
  for (const viewport of [page.viewportSize()!, WORKSPACE_WINDOW_MINIMUM]) {
    await page.setViewportSize(viewport)
    await expect(console).toBeVisible()
    await expect(page.getByTestId('preview-console-trigger')).toHaveCount(0)
    const renderer = await page.locator('#scholarseed-preview-viewport').boundingBox()
    const panel = await console.boundingBox()
    expect(panel!.x).toBeGreaterThanOrEqual(renderer!.x + renderer!.width)
    expect(panel!.y).toBe(0)
    expect(panel!.height).toBe(viewport.height)
    await page.screenshot({ path: testInfo.outputPath(`preview-dock-${viewport.width}.png`) })
    await console.getByRole('button', { name: '关闭预览控制台', exact: true }).click()
    await expect(console).not.toBeVisible()
    await expect.poll(async () => (await page.locator('#scholarseed-preview-viewport').boundingBox())!.width).toBe(viewport.width)
    await page.keyboard.press('F8')
  }
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await openPreviewTools(page)
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('dialog', { name: 'PDFE Workbench', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('preview-dock-dark-english.png') })
})

test('the hidden-module trigger uses the same reserved toolbar and remains operable', async ({ page }, testInfo) => {
  await page.goto(`/?previewInstance=${randomUUID()}&page=viewer-web_search&scene=viewer-web_search-states`)
  const launcher = previewSurface(page).getByTestId('preview-panel-open')
  await expect(launcher).toBeVisible()
  const renderer = await previewSurface(page).locator('#root').boundingBox()
  const trigger = await launcher.boundingBox()
  expect(trigger!.y).toBeGreaterThanOrEqual(renderer!.y + renderer!.height)
  await launcher.click()
  await expect(previewSurface(page).getByTestId('preview-panel-sheet')).toBeVisible()
  await expect(previewSurface(page).getByTestId('preview-panel-sheet').getByTestId('tree-readme.md')).toBeVisible()
  await expect(previewSurface(page).getByText(resourcesZh.panel.loadFailed, { exact: true })).not.toBeVisible()
  await previewSurface(page).getByTestId('preview-panel-close').click()
  await expect(previewSurface(page).getByTestId('preview-panel-sheet')).not.toBeVisible()
  await expect(launcher).toBeFocused()
  await expect(previewSurface(page).getByText(resourcesZh.panel.loadFailed, { exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('preview-toolbar-panel.png') })
})
