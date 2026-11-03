import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Request, type Response } from './testing'
import type { HistoryResult } from '../src/renderer/src/api'
import layoutZh from '../src/localization/locales/zh/layout.json'
import layoutEn from '../src/localization/locales/en/layout.json'
import uiZh from '../src/localization/locales/zh/ui.json'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'
import previewZh from './locales/zh.json'
import { PREVIEW_ARTIFACTS } from './publications'

const PAGE_ID = 'viewer-outputs'
const CATALOG_PATH = '/api/serve/sessions'
const HISTORY_PREFIX = '/api/serve/history/'
const FAILURE_STATUS = 503
const RAW_PATH = /^\/api\/serve\/sessions\/[^/]+\/artifacts\/[^/]+\/raw$/u
const NO_MATCH = 'preview-no-matching-publication'
type Failure = { method: string; path: string; status: number; scope?: string; project?: boolean }
interface Observation {
  scene: string
  requests: { method: string; path: string; scope?: string; project?: boolean }[]
  failures: Failure[]
  externalOrigins: string[]
  pageErrors: string[]
  pageErrorStacks: string[]
  requestFailures: { path: string; error: string | null }[]
  recoveries: number[]
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

function projectCatalog(input: string): boolean {
  const url = new URL(input)
  return url.pathname === CATALOG_PATH && url.searchParams.get('scope') === 'project' && Boolean(url.searchParams.get('project_path'))
}

function declaredFailure(observation: Observation, failure: Failure): boolean {
  if (failure.status !== FAILURE_STATUS || failure.method !== 'GET') return false
  if (observation.scene === 'outputs-catalog-failed') return failure.path === CATALOG_PATH && failure.scope === 'project' && failure.project === true
  if (observation.scene === 'outputs-history-failed') return failure.path.startsWith(HISTORY_PREFIX)
  if (observation.scene === 'outputs-content-failed') return RAW_PATH.test(failure.path)
  return false
}

test.beforeEach(({ page }) => {
  const observation: Observation = { scene: '', requests: [], failures: [], externalOrigins: [], pageErrors: [], pageErrorStacks: [], requestFailures: [], recoveries: [] }
  OBSERVATIONS.set(page, observation)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observation.externalOrigins.includes(url.origin)) observation.externalOrigins.push(url.origin)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview/')) observation.requests.push({ method: request.method(), path: url.pathname,
      ...(url.pathname === CATALOG_PATH ? { scope: url.searchParams.get('scope') ?? '', project: Boolean(url.searchParams.get('project_path')) } : {}) })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview/')) && response.status() >= 400) observation.failures.push({
      method: response.request().method(), path: url.pathname, status: response.status(),
      ...(url.pathname === CATALOG_PATH ? { scope: url.searchParams.get('scope') ?? '', project: Boolean(url.searchParams.get('project_path')) } : {}),
    })
    if (url.pathname === PREVIEW_ARTIFACTS.recoveryPath) observation.recoveries.push(response.status())
  })
  page.on('pageerror', error => {
    observation.pageErrors.push(error.message)
    observation.pageErrorStacks.push(error.stack ?? error.message)
  })
  page.on('requestfailed', request => observation.requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null }))
})

test.afterEach(async ({ page }, testInfo) => {
  const observation = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('outputs-http-summary.json')
  await writeFile(path, JSON.stringify(observation, null, 2))
  await testInfo.attach('outputs-http-summary', { path, contentType: 'application/json' })
  expect(observation.failures.filter(failure => !declaredFailure(observation, failure))).toEqual([])
  expect(observation.externalOrigins).toEqual([])
  expect(observation.pageErrors).toEqual([])
})

async function selectScene(page: Page, sceneId: string): Promise<void> {
  OBSERVATIONS.get(page)!.scene = sceneId
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('project-library')).toBeVisible()
}

async function enterOutputs(page: Page, label = layoutZh.outputs): Promise<void> {
  await previewSurface(page).getByTestId('project-library').click()
  const library = previewSurface(page).getByTestId('project-library-content')
  await expect(library).toBeVisible()
  await library.getByRole('tab', { name: label, exact: true }).click()
  await expect(previewSurface(page).getByTestId('project-outputs')).toBeVisible()
}

function rows(page: Page) {
  return previewSurface(page).getByTestId('project-outputs').locator('tr[data-testid^="output-"]:not([data-testid^="output-group-"])')
}

function outputSearch(page: Page) {
  return previewSurface(page).getByTestId('project-library-content').getByRole('searchbox', { name: layoutZh.searchOutputs, exact: true })
}

async function loaded(page: Page): Promise<void> {
  await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions * PREVIEW_ARTIFACTS.sample.length)
  const outputs = previewSurface(page).getByTestId('project-outputs')
  await expect(outputs.getByRole('button', { name: layoutZh.readFailed, exact: true })).toHaveCount(0)
  for (const file of PREVIEW_ARTIFACTS.sample) await expect(outputs.getByRole('button', { name: file.path, exact: true })).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
}

async function filter(page: Page, label: string, choice: string): Promise<void> {
  await previewSurface(page).getByTestId('project-outputs').getByRole('button', { name: label, exact: true }).click()
  await previewSurface(page).getByRole('menuitemradio', { name: choice, exact: true }).click()
}

async function recover(page: Page): Promise<void> {
  const instance = new URL(page.url()).searchParams.get('previewInstance')
  await page.keyboard.press('F8')
  const recovery = page.waitForResponse(response => new URL(response.url()).pathname === PREVIEW_ARTIFACTS.recoveryPath && response.request().method() === 'POST')
  await page.getByTestId('preview-artifacts-recover').click()
  expect((await recovery).status()).toBe(200)
  expect(new URL(page.url()).searchParams.get('previewInstance')).toBe(instance)
  await page.getByRole('button', { name: previewZh.close, exact: true }).click()
  expect(OBSERVATIONS.get(page)!.recoveries).toEqual([200])
}

function rawResponse(page: Page): Promise<Response> {
  return page.waitForResponse(response => response.request().method() === 'GET' && RAW_PATH.test(new URL(response.url()).pathname))
}

async function markdown(page: Page): Promise<void> {
  await expect(previewSurface(page).getByTestId('document-load-error')).toHaveCount(0)
  await previewSurface(page).getByTestId('markdown-open-preview').click()
  await expect(previewSurface(page).getByTestId('markdown-preview')).toContainText('Minimal Project')
}

test('published outputs browse all stages, types, session groups and real snapshot viewers across reload', {
  annotation: previewConsumption(PAGE_ID, 'outputs-published', ['loaded', 'searched', 'filtered', 'collapsed', 'opened', 'reloaded']),
}, async ({ page }, testInfo) => {
  await selectScene(page, 'outputs-published')
  await enterOutputs(page)
  await loaded(page)
  const outputs = previewSurface(page).getByTestId('project-outputs')
  const identities = await rows(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')).sort())
  const sessionIds = await outputs.locator('tr[data-testid^="output-group-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.slice('output-group-'.length)))
  const previewInstance = new URL(page.url()).searchParams.get('previewInstance')!
  const historyIdentities: string[] = []
  for (const session of sessionIds) {
    const response = await page.request.get(`/api/serve/history/${encodeURIComponent(session)}?previewInstance=${encodeURIComponent(previewInstance)}`)
    expect(response.status()).toBe(200)
    expect(new URL(response.url()).pathname).toBe(`/api/serve/history/${encodeURIComponent(session)}`)
    const history = await response.json() as HistoryResult
    expect(history.artifacts.map(artifact => ({ path: artifact.path, role: artifact.role })).sort((left, right) => left.path.localeCompare(right.path)))
      .toEqual([...PREVIEW_ARTIFACTS.sample].sort((left, right) => left.path.localeCompare(right.path)))
    for (const artifact of history.artifacts) {
      historyIdentities.push(`output-${artifact.artifact_id}`)
    }
  }
  expect(historyIdentities.sort()).toEqual(identities)
  await capturePreview(page, testInfo.outputPath('outputs-published.png'))
  await outputs.getByRole('button', { name: `${layoutZh.fileName} · ${layoutZh.descending}`, exact: true }).click()
  await expect(outputs.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending')
  await outputs.getByRole('button', { name: `${layoutZh.fileName} · ${layoutZh.ascending}`, exact: true }).click()
  await expect(outputs.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'descending')
  for (const stage of [
    { label: layoutZh.final, roles: ['final', 'supporting'] },
    { label: layoutZh.intermediate, roles: ['intermediate'] },
  ]) {
    await filter(page, layoutZh.outputStage, stage.label)
    const files = PREVIEW_ARTIFACTS.sample.filter(file => stage.roles.includes(file.role))
    await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions * files.length)
    for (const file of PREVIEW_ARTIFACTS.sample) {
      await expect(outputs.getByRole('button', { name: file.path, exact: true }))
        .toHaveCount(stage.roles.includes(file.role) ? PREVIEW_ARTIFACTS.sampleSessions : 0)
    }
  }
  await filter(page, layoutZh.outputStage, layoutZh.all)
  await filter(page, layoutZh.fileType, 'PDF')
  await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
  await expect(outputs.getByRole('button', { name: 'sample.pdf', exact: true })).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
  await capturePreview(page, testInfo.outputPath('outputs-type-filter.png'))
  await filter(page, layoutZh.fileType, layoutZh.all)
  const groups = outputs.locator('tr[data-testid^="output-group-"] button[aria-expanded]')
  await expect(groups).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
  const title = await groups.first().getAttribute('aria-label')
  expect(title).toBeTruthy()
  const search = outputSearch(page)
  await expect(search).toBeVisible()
  await search.fill(title!)
  await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sample.length)
  await search.clear()
  await groups.first().press('Enter')
  await expect(groups.first()).toHaveAttribute('aria-expanded', 'false')
  await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sample.length)
  await capturePreview(page, testInfo.outputPath('outputs-group-collapsed.png'))
  await groups.first().press('Enter')
  await expect(groups.first()).toHaveAttribute('aria-expanded', 'true')
  await loaded(page)
  await search.fill(NO_MATCH)
  await expect(rows(page)).toHaveCount(0)
  await expect(outputs.getByText(layoutZh.noMatchingOutputs, { exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('outputs-no-match.png'))
  await search.fill('readme')
  await expect(rows(page)).toHaveCount(PREVIEW_ARTIFACTS.sampleSessions)
  const read = rawResponse(page)
  await outputs.getByRole('button', { name: 'readme.md', exact: true }).first().click()
  expect((await read).status()).toBe(200)
  await markdown(page)
  await capturePreview(page, testInfo.outputPath('outputs-markdown-snapshot.png'))
  await enterOutputs(page)
  const retainedSearch = outputSearch(page)
  await expect(retainedSearch).toBeVisible()
  await retainedSearch.clear()
  await loaded(page)
  const pdf = rawResponse(page)
  await outputs.getByRole('button', { name: 'sample.pdf', exact: true }).first().click()
  expect((await pdf).status()).toBe(200)
  await expect(previewSurface(page).getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
  await capturePreview(page, testInfo.outputPath('outputs-pdf-snapshot.png'))
  const instance = new URL(page.url()).searchParams.get('previewInstance')
  await page.reload()
  await enterOutputs(page)
  await loaded(page)
  expect(new URL(page.url()).searchParams.get('previewInstance')).toBe(instance)
  expect(await rows(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')).sort())).toEqual(identities)
  await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
  await page.keyboard.press('F8')
  await openPreviewTools(page)
  await page.locator('#preview-theme').click()
  await page.getByRole('option', { name: previewZh.dark, exact: true }).click()
  await openPreviewTools(page)
  await page.locator('#preview-language').click()
  await page.getByRole('option', { name: previewZh.english, exact: true }).click()
  await page.getByRole('button', { name: previewZh.save, exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await enterOutputs(page, layoutEn.outputs)
  await expect(rows(page)).toHaveCount(identities.length)
  await expect(outputs.getByRole('button', { name: layoutEn.outputStage, exact: true })).toBeVisible()
  await capturePreview(page, testInfo.outputPath('outputs-dark-english-minimum.png'))
})

for (const kind of ['catalog', 'history'] as const) {
  const sceneId = kind === 'catalog' ? 'outputs-pending' : 'outputs-history-pending'
  test(`outputs ${kind} delay shows the actual list spinner while its request is outstanding`, {
    annotation: previewConsumption(PAGE_ID, sceneId, ['loading', 'loaded']),
  }, async ({ page }, testInfo) => {
    await selectScene(page, sceneId)
    let request: Request | undefined
    let completed = false
    const started = page.waitForRequest(candidate => candidate.method() === 'GET'
      && (kind === 'catalog' ? projectCatalog(candidate.url()) : new URL(candidate.url()).pathname.startsWith(HISTORY_PREFIX))).then(candidate => { request = candidate; return candidate })
    page.on('response', response => { if (response.request() === request) completed = true })
    await enterOutputs(page)
    await started
    const spinner = previewSurface(page).getByTestId('project-outputs').locator(':scope > div[tabindex="0"]').getByRole('status', { name: uiZh.loading, exact: true })
    await expect(spinner).toBeVisible()
    expect(completed).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`outputs-${kind}-loading.png`) })
    await expect(spinner).toBeVisible()
    expect(completed).toBe(false)
    await loaded(page)
    expect(completed).toBe(true)
    await capturePreview(page, testInfo.outputPath(`outputs-${kind}-loaded.png`))
  })
}

test('published output raw content waits without inventing a viewer loading control', {
  annotation: previewConsumption(PAGE_ID, 'outputs-content-pending', ['request-pending', 'opened']),
}, async ({ page }, testInfo) => {
  await selectScene(page, 'outputs-content-pending')
  await enterOutputs(page)
  await loaded(page)
  let received = false
  const pending = rawResponse(page).then(response => { received = true; return response })
  const started = page.waitForRequest(request => request.method() === 'GET' && RAW_PATH.test(new URL(request.url()).pathname))
  await previewSurface(page).getByTestId('project-outputs').getByRole('button', { name: 'readme.md', exact: true }).first().click()
  await started
  expect(received).toBe(false)
  await expect(previewSurface(page).getByTestId('project-outputs')).toBeVisible()
  await expect(previewSurface(page).getByTestId('markdown-preview')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('outputs-content-request-pending.png') })
  expect(received).toBe(false)
  await expect(previewSurface(page).getByTestId('project-outputs')).toBeVisible()
  expect((await pending).status()).toBe(200)
  await markdown(page)
  await capturePreview(page, testInfo.outputPath('outputs-content-opened.png'))
})

for (const kind of ['catalog', 'history'] as const) {
  test(`outputs ${kind} persistent failure requires original retry and explicit preview recovery`, {
    annotation: previewConsumption(PAGE_ID, `outputs-${kind}-failed`, ['error', 'retry-failed', 'recovered']),
  }, async ({ page }, testInfo) => {
    await selectScene(page, `outputs-${kind}-failed`)
    await enterOutputs(page)
    const retry = previewSurface(page).getByTestId('project-outputs').getByRole('button', { name: layoutZh.readFailed, exact: true })
    await expect(retry).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    const failed = page.waitForResponse(response => response.status() === FAILURE_STATUS && response.request().method() === 'GET'
      && (kind === 'catalog' ? projectCatalog(response.url()) : new URL(response.url()).pathname.startsWith(HISTORY_PREFIX)))
    await retry.click()
    await failed
    await expect(retry).toBeVisible()
    await capturePreview(page, testInfo.outputPath(`outputs-${kind}-retry-failed.png`))
    await recover(page)
    await expect(retry).toBeVisible()
    await retry.click()
    await loaded(page)
    await capturePreview(page, testInfo.outputPath(`outputs-${kind}-recovered.png`))
    expect(OBSERVATIONS.get(page)!.failures.length).toBeGreaterThanOrEqual(2)
  })
}

test('published output content stays failed until explicit recovery and the original viewer retry', {
  annotation: previewConsumption(PAGE_ID, 'outputs-content-failed', ['loaded', 'error', 'retry-failed', 'recovered', 'opened']),
}, async ({ page }, testInfo) => {
  await selectScene(page, 'outputs-content-failed')
  await enterOutputs(page)
  await loaded(page)
  const initial = rawResponse(page)
  await previewSurface(page).getByTestId('project-outputs').getByRole('button', { name: 'readme.md', exact: true }).first().click()
  expect((await initial).status()).toBe(FAILURE_STATUS)
  const error = previewSurface(page).getByTestId('document-load-error')
  const retry = previewSurface(page).getByTestId('document-load-retry')
  await expect(error).toBeVisible()
  await expect(error).toContainText(PREVIEW_ARTIFACTS.readFailed)
  await expect(retry).toBeEnabled()
  const failed = rawResponse(page)
  await retry.click()
  expect((await failed).status()).toBe(FAILURE_STATUS)
  await expect(error).toBeVisible()
  await expect(retry).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('outputs-content-retry-failed.png'))
  await recover(page)
  const recovered = rawResponse(page)
  await retry.click()
  expect((await recovered).status()).toBe(200)
  await markdown(page)
  await capturePreview(page, testInfo.outputPath('outputs-content-recovered.png'))
  expect(OBSERVATIONS.get(page)!.failures).toHaveLength(2)
})
