import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Response } from './testing'
import type { ApiKeyCreated, ApiKeySummary } from '../src/renderer/src/account'
import { PREVIEW_CATALOG } from './catalog'
import { PREVIEW_ORIGIN } from './constants'
import { capturePreview } from './capture'
import { previewConsumption } from './coverage'
import componentsZh from '../src/localization/locales/zh/components.json'
import componentsEn from '../src/localization/locales/en/components.json'
import accountZh from '../src/localization/locales/zh/account.json'
import accountEn from '../src/localization/locales/en/account.json'

const PAGE_ID = 'settings-developer'
const KEYS_PATH = '/api/account/api-keys'
const ENSURE_PATH = '/api/serve/skill-credential'
const REFRESH_PATH = `${ENSURE_PATH}/refresh`
const STATE_PATH = '/__preview/state'
const FAILURE_STATUS = 503
const CREATED_NAME = '模拟外部协作 · 非真实凭据'
const SYNTHETIC_TOKEN_PREFIX = 'preview-only:'
type RequestEntry = { method: string; path: string }
type FailureEntry = RequestEntry & { status: number }
type Observation = { requests: RequestEntry[]; responses: FailureEntry[]; failures: FailureEntry[]; failureMode: 'read' | 'write' | null; externalOrigins: string[] }
const OBSERVATIONS = new WeakMap<Page, Observation>()

test.beforeEach(({ page }) => {
  const observation: Observation = { requests: [], responses: [], failures: [], failureMode: null, externalOrigins: [] }
  OBSERVATIONS.set(page, observation)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observation.externalOrigins.includes(url.origin)) observation.externalOrigins.push(url.origin)
    if (url.origin === PREVIEW_ORIGIN && url.pathname.startsWith('/api/')) observation.requests.push({ method: request.method(), path: url.pathname })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== PREVIEW_ORIGIN || (!url.pathname.startsWith('/api/') && url.pathname !== STATE_PATH)) return
    const entry = { method: response.request().method(), path: url.pathname, status: response.status() }
    observation.responses.push(entry)
    if (entry.status >= 400) observation.failures.push(entry)
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observation = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('developer-http-summary.json')
  await writeFile(path, JSON.stringify(observation, null, 2))
  await testInfo.attach('developer-http-summary', { path, contentType: 'application/json' })
  expect(observation.externalOrigins).toEqual([])
  if (observation.failureMode === 'read') {
    for (const failure of observation.failures) expect(failure).toEqual({ method: 'GET', path: KEYS_PATH, status: FAILURE_STATUS })
  } else expect(observation.failures).toEqual(observation.failureMode === 'write' ? [{ method: 'POST', path: KEYS_PATH, status: FAILURE_STATUS }] : [])
})

function responseFor(page: Page, method: string, path = KEYS_PATH): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).origin === PREVIEW_ORIGIN && new URL(response.url()).pathname === path && response.request().method() === method)
}

function requestsFor(page: Page, method: string, path = KEYS_PATH): RequestEntry[] {
  return OBSERVATIONS.get(page)!.requests.filter(request => request.method === method && request.path === path)
}

async function readKeys(reading: Promise<Response>): Promise<ApiKeySummary[]> {
  const response = await reading
  expect(response.status()).toBe(200)
  const payload = await response.json() as { keys: ApiKeySummary[] }
  expect(Array.isArray(payload.keys)).toBe(true)
  for (const key of payload.keys) {
    expect(key).not.toHaveProperty('token')
    expect(typeof key.key_id).toBe('string')
  }
  expect(payload.keys.filter(key => key.managed).length).toBeLessThanOrEqual(1)
  return payload.keys
}

async function openDeveloper(page: Page, sceneId: string): Promise<{ reading: Promise<Response> }> {
  OBSERVATIONS.get(page)!.failureMode = sceneId === 'settings-developer-failed' ? 'read' : sceneId === 'settings-developer-save-failed' ? 'write' : null
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  const reading = responseFor(page, 'GET')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('account-settings-developer')).toBeVisible()
  return { reading }
}

async function createdKey(response: Response): Promise<ApiKeyCreated> {
  expect(response.status()).toBe(200)
  const created = await response.json() as ApiKeyCreated
  expect(created.name).toBe(CREATED_NAME)
  expect(created.managed).toBe(false)
  expect(created.token.startsWith(SYNTHETIC_TOKEN_PREFIX)).toBe(true)
  expect(created.key_id).not.toBe('')
  return created
}

test('developer uses the original key controls with idempotent managed setup and one-time simulated secrets', { annotation: previewConsumption(PAGE_ID, 'settings-developer-states', ['loaded', 'editing', 'created', 'secret-hidden', 'revoked', 'rotated', 'reloaded']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-states')
  const initial = await readKeys(reading)
  const managed = initial.find(key => key.managed)!
  expect(managed).toBeDefined()
  const managedRow = previewSurface(page).getByTestId(`api-key-row-${managed.key_id}`)
  await expect(managedRow).toContainText(accountZh.accountExtra.managedName)
  await expect(previewSurface(page).getByTestId(`api-key-rotate-${managed.key_id}`)).toBeEnabled()
  await expect(previewSurface(page).getByTestId(`api-key-revoke-${managed.key_id}`)).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('api-key-fresh')).toHaveCount(0)
  expect(requestsFor(page, 'POST', ENSURE_PATH).length).toBeGreaterThan(0)
  await capturePreview(page, testInfo.outputPath('developer-key-list.png'))
  const reloading = responseFor(page, 'GET')
  await page.reload()
  const reloaded = await readKeys(reloading)
  expect(reloaded.map(key => key.key_id).sort()).toEqual(initial.map(key => key.key_id).sort())
  expect(reloaded.filter(key => key.managed)).toHaveLength(1)
  await previewSurface(page).getByTestId('api-key-name').fill(CREATED_NAME)
  const creating = responseFor(page, 'POST')
  const listingCreated = responseFor(page, 'GET')
  await previewSurface(page).getByTestId('api-key-create').click()
  const created = await createdKey(await creating)
  const afterCreation = await readKeys(listingCreated)
  expect(afterCreation).toHaveLength(initial.length + 1)
  expect(afterCreation.filter(key => key.managed).map(key => key.key_id)).toEqual([managed.key_id])
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveText(created.token)
  await expect(previewSurface(page).getByTestId(`api-key-row-${created.key_id}`)).toContainText(CREATED_NAME)
  await capturePreview(page, testInfo.outputPath('developer-created-once.png'))
  await previewSurface(page).getByTestId('api-key-fresh-close').click()
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  const rereading = responseFor(page, 'GET')
  await page.reload()
  expect((await readKeys(rereading)).some(key => key.key_id === created.key_id)).toBe(true)
  await expect(previewSurface(page).getByTestId('api-key-fresh')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('developer-secret-hidden-reloaded.png'))
  const revoking = responseFor(page, 'DELETE', `${KEYS_PATH}/${encodeURIComponent(created.key_id)}`)
  const afterRevoking = responseFor(page, 'GET')
  await previewSurface(page).getByTestId(`api-key-revoke-${created.key_id}`).click()
  expect((await revoking).status()).toBe(200)
  expect((await readKeys(afterRevoking)).some(key => key.key_id === created.key_id)).toBe(false)
  await expect(previewSurface(page).getByTestId(`api-key-row-${created.key_id}`)).toHaveCount(0)
  const rotating = responseFor(page, 'POST', `${KEYS_PATH}/${encodeURIComponent(managed.key_id)}/rotate`)
  const refreshing = responseFor(page, 'POST', REFRESH_PATH)
  const afterRotating = responseFor(page, 'GET')
  await previewSurface(page).getByTestId(`api-key-rotate-${managed.key_id}`).click()
  expect(await (await rotating).json()).toEqual({ rotated: true })
  expect((await refreshing).status()).toBe(200)
  const rotated = (await readKeys(afterRotating)).filter(key => key.managed)
  expect(rotated).toHaveLength(1)
  expect(rotated[0].key_id).not.toBe(managed.key_id)
  await expect(previewSurface(page).getByTestId(`api-key-row-${managed.key_id}`)).toHaveCount(0)
  await expect(previewSurface(page).getByTestId(`api-key-rotate-${rotated[0].key_id}`)).toBeEnabled()
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  expect(requestsFor(page, 'POST')).toHaveLength(1)
  await capturePreview(page, testInfo.outputPath('developer-rotated-no-secret.png'))
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
  const englishReading = responseFor(page, 'GET')
  await previewSurface(page).getByTestId('account-settings-nav-developer').click()
  const englishKeys = await readKeys(englishReading)
  expect(englishKeys.filter(key => key.managed).map(key => key.key_id)).toEqual([rotated[0].key_id])
  await expect(previewSurface(page).getByTestId('account-settings-developer').getByRole('heading', { name: componentsEn.accountPanel.developer.title, exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId(`api-key-row-${rotated[0].key_id}`)).toContainText(accountEn.accountExtra.managedName)
  await expect(previewSurface(page).getByTestId(`api-key-rotate-${rotated[0].key_id}`)).toHaveText(accountEn.actions.rotate)
  await expect(previewSurface(page).getByTestId('api-key-create')).toHaveText(componentsEn.accountPanel.developer.generate)
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('developer-dark-english.png'))
})

test('developer empty scene renders the real empty list and available creation control', { annotation: previewConsumption(PAGE_ID, 'settings-developer-empty', ['empty']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-empty')
  expect(await readKeys(reading)).toEqual([])
  await expect(previewSurface(page).getByTestId('account-settings-developer').getByText(componentsZh.accountPanel.developer.none, { exact: true })).toBeVisible()
  await expect(previewSurface(page).locator('[data-testid^="api-key-row-"]')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('developer-empty.png'))
})

test('developer delayed list shows original loading before the managed key list', { annotation: previewConsumption(PAGE_ID, 'settings-developer-pending', ['loading', 'loaded']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-pending')
  const loading = previewSurface(page).getByTestId('account-settings-developer').getByText(componentsZh.accountPanel.developer.loadingDesc, { exact: true })
  await expect(loading).toBeVisible()
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('developer-loading.png') })
  await expect(loading).toBeVisible()
  const keys = await readKeys(reading)
  expect(keys.length).toBeGreaterThan(0)
  await expect(previewSurface(page).getByTestId(`api-key-row-${keys[0].key_id}`)).toBeVisible()
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('developer-loaded.png'))
})

test('developer list failure preserves its original retry and remains a declared failure', { annotation: previewConsumption(PAGE_ID, 'settings-developer-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-failed')
  expect((await reading).status()).toBe(FAILURE_STATUS)
  const error = previewSurface(page).getByTestId('account-settings-developer').getByRole('alert')
  await expect(error).toContainText('503')
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('developer-read-failed.png'))
  const retrying = responseFor(page, 'GET')
  await previewSurface(page).getByTestId('api-key-retry').click()
  expect((await retrying).status()).toBe(FAILURE_STATUS)
  await expect(error).toContainText('503')
  await expect(previewSurface(page).getByTestId('api-key-retry')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('developer-read-retry-failed.png'))
})

test('developer pending create disables mutation buttons and issues only one create', { annotation: previewConsumption(PAGE_ID, 'settings-developer-save-pending', ['editing', 'saving', 'created']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-save-pending')
  const initial = await readKeys(reading)
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await previewSurface(page).getByTestId('api-key-name').fill(CREATED_NAME)
  let settled = false
  const creating = responseFor(page, 'POST').then(response => { settled = true; return response })
  const listing = responseFor(page, 'GET')
  await previewSurface(page).getByTestId('api-key-create').click()
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeDisabled()
  for (const key of initial) await expect(previewSurface(page).getByTestId(`api-key-${key.managed ? 'rotate' : 'revoke'}-${key.key_id}`)).toBeDisabled()
  expect(requestsFor(page, 'POST')).toHaveLength(1)
  expect(settled).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('developer-create-pending.png') })
  expect(settled).toBe(false)
  const created = await createdKey(await creating)
  expect((await readKeys(listing)).some(key => key.key_id === created.key_id)).toBe(true)
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveText(created.token)
  await previewSurface(page).getByTestId('api-key-fresh-close').click()
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  expect(requestsFor(page, 'POST')).toHaveLength(1)
  await capturePreview(page, testInfo.outputPath('developer-create-completed.png'))
})

test('developer failed create retains the name and retries through the same original form', { annotation: previewConsumption(PAGE_ID, 'settings-developer-save-failed', ['editing', 'error', 'retried', 'created']) }, async ({ page }, testInfo) => {
  const { reading } = await openDeveloper(page, 'settings-developer-save-failed')
  const initial = await readKeys(reading)
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await previewSurface(page).getByTestId('api-key-name').fill(CREATED_NAME)
  const failed = responseFor(page, 'POST')
  await previewSurface(page).getByTestId('api-key-create').click()
  expect((await failed).status()).toBe(FAILURE_STATUS)
  await expect(previewSurface(page).getByTestId('account-settings-developer').getByRole('alert')).toContainText('503')
  await expect(previewSurface(page).getByTestId('api-key-name')).toHaveValue(CREATED_NAME)
  await expect(previewSurface(page).getByTestId('api-key-create')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('api-key-fresh')).toHaveCount(0)
  await expect(previewSurface(page).locator('[data-testid^="api-key-row-"]')).toHaveCount(initial.length)
  await capturePreview(page, testInfo.outputPath('developer-create-failed.png'))
  const retrying = responseFor(page, 'POST')
  const listing = responseFor(page, 'GET')
  await previewSurface(page).getByTestId('api-key-create').click()
  const created = await createdKey(await retrying)
  const keys = await readKeys(listing)
  expect(keys).toHaveLength(initial.length + 1)
  expect(keys.filter(key => key.key_id === created.key_id)).toHaveLength(1)
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveText(created.token)
  await expect(previewSurface(page).getByTestId('account-settings-developer').getByRole('alert')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('api-key-name')).toHaveValue('')
  await previewSurface(page).getByTestId('api-key-fresh-close').click()
  await expect(previewSurface(page).getByTestId('api-key-secret')).toHaveCount(0)
  expect(requestsFor(page, 'POST')).toHaveLength(2)
  await capturePreview(page, testInfo.outputPath('developer-create-retried.png'))
})
