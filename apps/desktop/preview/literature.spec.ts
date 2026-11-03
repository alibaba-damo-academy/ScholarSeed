import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Response } from './testing'
import type { LiteratureDetail, LiteratureNote, LiteraturePage } from '../src/renderer/src/contracts/literature'
import literatureZh from '../src/localization/locales/zh/literature.json'
import literatureEn from '../src/localization/locales/en/literature.json'
import uiZh from '../src/localization/locales/zh/ui.json'
import uiEn from '../src/localization/locales/en/ui.json'
import { LOCALES } from '../src/localization/catalog'
import previewEn from './locales/en.json'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'

const PAGE_ID = 'page-literature'
const LIST_PATH = '/api/v1/literatures'
const PAPER_TITLE = '模拟文献：可复现研究流程'
const MISSING_TITLE = '模拟文献：缺失全文附件'
const NO_ATTACHMENT_TITLE = '模拟文献：协作设计笔记'
const NOTE_TITLE = '模拟消费笔记'
const NOTE_TEXT = '受审模拟笔记：通过真实编辑器保存，不代表用户资料。'
const UPDATED_NOTE_TEXT = `${NOTE_TEXT}\n\n## 模拟修订\n真实自动保存。`
const UPDATED_TITLE = `${PAPER_TITLE} · 受审修订`
const FAILURE_STATUS = 503
const FAILURE_SCENES = new Set(['library-failed', 'detail-failed', 'metadata-failed'])
type RequestSummary = { method: string; path: string; status?: number }
type Observations = { requests: RequestSummary[]; failures: RequestSummary[]; externalOrigins: string[]; pageErrors: string[] }
const OBSERVATIONS = new WeakMap<Page, Observations>()

test.beforeEach(({ page }) => {
  const observations: Observations = { requests: [], failures: [], externalOrigins: [], pageErrors: [] }
  OBSERVATIONS.set(page, observations)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observations.externalOrigins.includes(url.origin)) observations.externalOrigins.push(url.origin)
    if (url.pathname.startsWith('/api/')) observations.requests.push({ method: request.method(), path: url.pathname })
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (!path.startsWith('/api/') && path !== '/__preview/state') return
    const entry = { method: response.request().method(), path, status: response.status() }
    observations.requests.push(entry)
    if (entry.status >= 400) observations.failures.push(entry)
  })
  page.on('pageerror', error => observations.pageErrors.push(error.name))
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('literature-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('literature-http-summary', { path, contentType: 'application/json' })
  expect(observations.externalOrigins).toEqual([])
  expect(observations.pageErrors).toEqual([])
  const scene = new URL(page.url()).searchParams.get('scene') ?? ''
  for (const failure of observations.failures) {
    expect(FAILURE_SCENES.has(scene)).toBe(true)
    expect(failure.status).toBe(FAILURE_STATUS)
    if (scene === 'metadata-failed') {
      expect(failure.method).toBe('PATCH')
      expect(failure.path).toMatch(/^\/api\/v1\/literatures\/[^/]+$/)
    } else if (scene === 'detail-failed') {
      expect(failure.method).toBe('GET')
      expect(failure.path).toMatch(/^\/api\/v1\/literatures\/[^/]+$/)
    } else {
      expect(failure.method).toBe('GET')
      expect([LIST_PATH, `${LIST_PATH}/counts`, `${LIST_PATH}/facets`, `${LIST_PATH}/tag-facets`, `${LIST_PATH}/projects`, '/api/v1/collections']).toContain(failure.path)
    }
  }
  if (scene === 'metadata-failed') expect(observations.failures).toHaveLength(1)
})

function responseFor(page: Page, path: string, method = 'GET'): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
}

function row(page: Page, title = PAPER_TITLE) {
  return previewSurface(page).locator(`.lit-row[aria-label="${title}"]`)
}

async function openLibrary(page: Page, sceneId: string): Promise<{ reading: Promise<Response> }> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  const reading = responseFor(page, LIST_PATH)
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('literature-overview')).toBeVisible()
  return { reading }
}

async function readCatalogue(reading: Promise<Response>): Promise<LiteraturePage> {
  const response = await reading
  expect(response.status()).toBe(200)
  return await response.json() as LiteraturePage
}

async function openDetail(page: Page, itemId: string, title = PAPER_TITLE): Promise<{ reading: Promise<Response> }> {
  const reading = responseFor(page, `${LIST_PATH}/${encodeURIComponent(itemId)}`)
  await row(page, title).click()
  await expect(previewSurface(page).getByRole('button', { name: literatureZh.detail.close, exact: true })).toBeVisible()
  return { reading }
}

async function loadedDetail(reading: Promise<Response>): Promise<LiteratureDetail> {
  const response = await reading
  expect(response.status()).toBe(200)
  return await response.json() as LiteratureDetail
}

async function editTitle(page: Page, original: string): Promise<void> {
  await previewSurface(page).getByRole('button', { name: original, exact: true }).click()
  const input = previewSurface(page).getByRole('textbox', { name: literatureZh.detail.edit.replace('{{label}}', literatureZh.columns.title), exact: true })
  await expect(input).toHaveValue(original)
  await input.fill(UPDATED_TITLE)
  await input.press('Tab')
}

test('populated literature uses the original catalogue, filters, detail, notes and PDF attachment', { annotation: previewConsumption(PAGE_ID, 'library-populated', ['populated', 'filtered', 'sorted', 'detail', 'attachment', 'notes', 'reloaded']) }, async ({ page }, testInfo) => {
  const { reading } = await openLibrary(page, 'library-populated')
  const catalogue = await readCatalogue(reading)
  expect(catalogue.total).toBe(3)
  const paper = catalogue.items.find(item => item.title === PAPER_TITLE)!
  expect(paper.id).toBeTruthy()
  for (const title of [PAPER_TITLE, MISSING_TITLE, NO_ATTACHMENT_TITLE]) await expect(row(page, title)).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-populated.png'))
  const search = previewSurface(page).getByPlaceholder(literatureZh.list.searchPlaceholder, { exact: true })
  const filtered = page.waitForResponse(response => new URL(response.url()).pathname === LIST_PATH && new URL(response.url()).searchParams.get('q') === '协作设计笔记')
  await search.fill('协作设计笔记')
  const filteredPage = await readCatalogue(filtered)
  expect(filteredPage.items.map(item => item.title)).toEqual([NO_ATTACHMENT_TITLE])
  await expect(row(page, PAPER_TITLE)).toHaveCount(0)
  await expect(row(page, NO_ATTACHMENT_TITLE)).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-filtered.png'))
  const unfiltered = page.waitForResponse(response => new URL(response.url()).pathname === LIST_PATH && !new URL(response.url()).searchParams.get('q'))
  await search.fill('')
  await readCatalogue(unfiltered)
  const sorted = page.waitForResponse(response => new URL(response.url()).pathname === LIST_PATH && new URL(response.url()).searchParams.get('sort') === 'title')
  await previewSurface(page).getByRole('button', { name: literatureZh.columns.title, exact: true }).click()
  const sortedResponse = await sorted
  const sortOrder = new URL(sortedResponse.url()).searchParams.get('order')
  expect(['asc', 'desc']).toContain(sortOrder)
  const sortedPage = await readCatalogue(Promise.resolve(sortedResponse))
  await expect(previewSurface(page).locator('.lit-row')).toHaveCount(sortedPage.items.length)
  expect(await previewSurface(page).locator('.lit-row').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(sortedPage.items.map(item => item.title))
  await capturePreview(page, testInfo.outputPath('literature-sorted.png'))
  const detail = await loadedDetail((await openDetail(page, paper.id)).reading)
  expect(detail.id).toBe(paper.id)
  await expect(previewSurface(page).getByRole('button', { name: PAPER_TITLE, exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-detail.png'))
  await previewSurface(page).getByRole('tab', { name: /^笔记 / }).click()
  await expect(previewSurface(page).getByRole('button', { name: '模拟阅读笔记', exact: true })).toBeVisible()
  await previewSurface(page).getByRole('button', { name: literatureZh.relations.addNote, exact: true }).click()
  await previewSurface(page).getByRole('textbox', { name: literatureZh.notes.title, exact: true }).fill(NOTE_TITLE)
  const createdResponse = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}/notes`, 'POST')
  await previewSurface(page).getByRole('textbox', { name: literatureZh.notes.bodyPlaceholder, exact: true }).fill(NOTE_TEXT)
  const created = await createdResponse
  expect(created.status()).toBe(200)
  const note = await created.json() as LiteratureNote
  expect(note).toMatchObject({ title: NOTE_TITLE, text: NOTE_TEXT })
  await expect(previewSurface(page).getByRole('status')).toHaveText(literatureZh.notes.statusSaved)
  const updatedResponse = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}/notes/${encodeURIComponent(note.id)}`, 'PATCH')
  await previewSurface(page).getByRole('textbox', { name: literatureZh.notes.bodyPlaceholder, exact: true }).fill(UPDATED_NOTE_TEXT)
  const updated = await updatedResponse
  expect(updated.status()).toBe(200)
  const updatedNote = await updated.json() as LiteratureNote
  expect(updatedNote.text).toBe(UPDATED_NOTE_TEXT)
  expect(updatedNote.version).toBeGreaterThan(note.version)
  await expect(previewSurface(page).getByRole('status')).toHaveText(literatureZh.notes.statusSaved)
  await previewSurface(page).getByRole('tab', { name: literatureZh.notes.modePreview, exact: true }).click()
  await expect(previewSurface(page).getByRole('heading', { name: '模拟修订', exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-note-saved.png'))
  await page.reload()
  await expect(row(page)).toBeVisible()
  const reloaded = await loadedDetail((await openDetail(page, paper.id)).reading)
  expect(reloaded.notes?.find(candidate => candidate.id === note.id)).toMatchObject({ title: NOTE_TITLE, text: UPDATED_NOTE_TEXT, version: updatedNote.version })
  await previewSurface(page).getByRole('tab', { name: /^笔记 / }).click()
  await previewSurface(page).getByRole('button', { name: NOTE_TITLE, exact: true }).click()
  await expect(previewSurface(page).getByRole('textbox', { name: literatureZh.notes.bodyPlaceholder, exact: true })).toHaveValue(UPDATED_NOTE_TEXT)
  await capturePreview(page, testInfo.outputPath('literature-note-reloaded.png'))
  await previewSurface(page).getByRole('button', { name: literatureZh.notes.deleteNamed.replace('{{title}}', NOTE_TITLE), exact: true }).click()
  const confirmation = previewSurface(page).getByRole('alertdialog')
  await expect(confirmation.getByText(literatureZh.notes.deleteDescription)).toBeVisible()
  await confirmation.getByRole('button', { name: literatureZh.notes.cancel, exact: true }).click()
  expect(OBSERVATIONS.get(page)!.requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
  await previewSurface(page).getByRole('button', { name: literatureZh.notes.deleteNamed.replace('{{title}}', NOTE_TITLE), exact: true }).click()
  const deleted = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}/notes/${encodeURIComponent(note.id)}`, 'DELETE')
  await confirmation.getByRole('button', { name: literatureZh.notes.delete, exact: true }).click()
  expect((await deleted).ok()).toBe(true)
  await expect(previewSurface(page).getByRole('button', { name: NOTE_TITLE, exact: true })).toHaveCount(0)
  await expect(previewSurface(page).getByRole('button', { name: '模拟阅读笔记', exact: true })).toBeVisible()
  await previewSurface(page).getByRole('button', { name: literatureZh.detail.close, exact: true }).click()
  await row(page).dblclick()
  await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-attachment-pdf.png'))
  await page.reload()
  await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-attachment-reloaded.png'))
})

test('literature catalogue delayed reads display the original loading state before real rows', { annotation: previewConsumption(PAGE_ID, 'library-pending', ['loading', 'loaded']) }, async ({ page }, testInfo) => {
  const { reading } = await openLibrary(page, 'library-pending')
  const spinner = previewSurface(page).getByLabel(literatureZh.list.loading, { exact: true })
  await expect(spinner).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('literature-list-loading.png') })
  await expect(spinner).toBeVisible()
  await readCatalogue(reading)
  await expect(row(page)).toBeVisible()
  await expect(spinner).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-list-loaded.png'))
})

test('literature catalogue failed reads keep their real error after public retry', { annotation: previewConsumption(PAGE_ID, 'library-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  const { reading } = await openLibrary(page, 'library-failed')
  expect((await reading).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByTestId('literature-overview').locator('.lit-error')).toBeVisible()
  await expect(previewSurface(page).getByTestId('literature-panel').getByText(literatureZh.panel.readFailed, { exact: true })).toBeVisible()
  await expect(row(page)).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('literature-list-failed.png'))
  const retry = responseFor(page, LIST_PATH)
  await previewSurface(page).getByTestId('literature-overview').getByRole('button', { name: uiZh.retry, exact: true }).last().click()
  expect((await retry).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByTestId('literature-overview').locator('.lit-error')).toBeVisible()
  await expect(previewSurface(page).getByTestId('literature-panel').getByText(literatureZh.panel.readFailed, { exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-list-retry-failed.png'))
})

test('literature detail delayed reads display its original loading state before fields', { annotation: previewConsumption(PAGE_ID, 'detail-pending', ['loading', 'loaded']) }, async ({ page }, testInfo) => {
  const catalogue = await readCatalogue((await openLibrary(page, 'detail-pending')).reading)
  const paper = catalogue.items.find(item => item.title === PAPER_TITLE)!
  const { reading } = await openDetail(page, paper.id)
  const spinner = previewSurface(page).getByLabel(literatureZh.detail.loading, { exact: true })
  await expect(spinner).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('literature-detail-loading.png') })
  await expect(spinner).toBeVisible()
  await loadedDetail(reading)
  await expect(previewSurface(page).getByRole('button', { name: PAPER_TITLE, exact: true })).toBeVisible()
  await expect(spinner).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-detail-loaded.png'))
})

test('literature initial detail failure shows a real error and remains failed after retry', { annotation: previewConsumption(PAGE_ID, 'detail-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  const catalogue = await readCatalogue((await openLibrary(page, 'detail-failed')).reading)
  const paper = catalogue.items.find(item => item.title === PAPER_TITLE)!
  expect((await (await openDetail(page, paper.id)).reading).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByLabel(literatureZh.detail.loading, { exact: true })).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-detail-failed.png'))
  const retry = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}`)
  await previewSurface(page).getByRole('button', { name: uiZh.retry, exact: true }).click()
  expect((await retry).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByLabel(literatureZh.detail.loading, { exact: true })).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-detail-retry-failed.png'))
  for (const tab of [literatureZh.detail.tabs.attachments, literatureZh.detail.tabs.notes]) {
    await previewSurface(page).getByRole('tab', { name: `${tab} 0`, exact: true }).click()
    const panel = previewSurface(page).getByRole('tabpanel').filter({ visible: true })
    await expect(panel.getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
    await expect(previewSurface(page).getByText(literatureZh.detail.loadFailed, { exact: true })).toHaveCount(1)
    await expect(panel.getByRole('button', { name: uiZh.retry, exact: true })).toBeVisible()
    const retried = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}`)
    await panel.getByRole('button', { name: uiZh.retry, exact: true }).click()
    expect((await retried).status()).toBe(FAILURE_STATUS)
    await expect(panel.getByText(literatureZh.detail.loadFailed, { exact: true })).toBeVisible()
    await expect(panel.getByLabel(literatureZh.detail.loading, { exact: true })).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath(`literature-detail-${tab === literatureZh.detail.tabs.attachments ? 'attachments' : 'notes'}-failed.png`))
  }
})

test('literature detail failure remains keyboard operable in dark English at the Web minimum viewport', { annotation: previewConsumption(PAGE_ID, 'detail-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
  const catalogue = await readCatalogue((await openLibrary(page, 'detail-failed')).reading)
  const paper = catalogue.items.find(item => item.title === PAPER_TITLE)!
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await openPreviewTools(page)
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('lang', LOCALES.en.tag)
  await page.keyboard.press('F8')
  await page.getByRole('button', { name: previewEn.close, exact: true }).click()
  await expect(page.getByRole('heading', { name: previewEn.title, exact: true })).not.toBeVisible()
  await expect(row(page)).toBeVisible()
  const reading = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}`)
  await row(page).click()
  expect((await reading).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByText(literatureEn.detail.loadFailed, { exact: true })).toBeVisible()
  const retry = previewSurface(page).getByRole('button', { name: uiEn.retry, exact: true })
  await expect(retry).toBeVisible()
  for (let step = 0; step < 12 && !(await retry.evaluate(element => element === document.activeElement)); step += 1) await page.keyboard.press('Tab')
  await expect(retry).toBeFocused()
  const retried = responseFor(page, `${LIST_PATH}/${encodeURIComponent(paper.id)}`)
  await page.keyboard.press('Enter')
  expect((await retried).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByText(literatureEn.detail.loadFailed, { exact: true })).toBeVisible()
  await expect(previewSurface(page).getByLabel(literatureEn.detail.loading, { exact: true })).not.toBeVisible()
  await expect(retry).toBeVisible()
  await capturePreview(page, testInfo.outputPath('literature-detail-dark-english-minimum.png'))
  await previewSurface(page).getByRole('button', { name: literatureEn.detail.close, exact: true }).click()
  await expect(row(page)).toBeVisible()
  await expect(previewSurface(page).getByText(literatureEn.detail.loadFailed, { exact: true })).not.toBeVisible()
})

for (const scene of ['metadata-pending', 'metadata-failed'] as const) {
  const states = scene === 'metadata-pending' ? ['editing', 'pending', 'saved'] : ['editing', 'error', 'retried', 'saved']
  test(`literature ${scene} consumes the original inline field editor and persisted HTTP receipt`, { annotation: previewConsumption(PAGE_ID, scene, states) }, async ({ page }, testInfo) => {
    const catalogue = await readCatalogue((await openLibrary(page, scene)).reading)
    const paper = catalogue.items.find(item => item.title === PAPER_TITLE)!
    await loadedDetail((await openDetail(page, paper.id)).reading)
    const path = `${LIST_PATH}/${encodeURIComponent(paper.id)}`
    let responded = false
    const saving = responseFor(page, path, 'PATCH').then(response => { responded = true; return response })
    await editTitle(page, PAPER_TITLE)
    if (scene === 'metadata-pending') {
      await expect.poll(() => OBSERVATIONS.get(page)!.requests.some(request => request.method === 'PATCH' && request.path === path)).toBe(true)
      expect(responded).toBe(false)
      await expect(previewSurface(page).getByRole('button', { name: PAPER_TITLE, exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('literature-metadata-pending.png') })
      expect(responded).toBe(false)
    } else {
      expect((await saving).status()).toBe(FAILURE_STATUS)
      await expect(previewSurface(page).getByText(literatureZh.detail.saveFailed, { exact: true })).toBeVisible()
      await expect(previewSurface(page).getByRole('button', { name: PAPER_TITLE, exact: true })).toBeVisible()
      await capturePreview(page, testInfo.outputPath('literature-metadata-failed.png'))
    }
    const successful = scene === 'metadata-pending' ? saving : responseFor(page, path, 'PATCH')
    if (scene === 'metadata-failed') await editTitle(page, PAPER_TITLE)
    const response = await successful
    expect(response.status()).toBe(200)
    expect(await response.json() as LiteratureDetail).toMatchObject({ id: paper.id, title: UPDATED_TITLE })
    await expect(previewSurface(page).getByRole('button', { name: UPDATED_TITLE, exact: true })).toBeVisible()
    await capturePreview(page, testInfo.outputPath('literature-metadata-saved.png'))
    await page.reload()
    await expect(row(page, UPDATED_TITLE)).toBeVisible()
    const reloaded = await loadedDetail((await openDetail(page, paper.id, UPDATED_TITLE)).reading)
    expect(reloaded).toMatchObject({ id: paper.id, title: UPDATED_TITLE })
    await expect(previewSurface(page).getByRole('button', { name: UPDATED_TITLE, exact: true })).toBeVisible()
    await capturePreview(page, testInfo.outputPath('literature-metadata-reloaded.png'))
  })
}
