import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page, type Response } from './testing'
import type { PersonalApiProfilesResp } from '../src/renderer/src/api'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'

const PAGE_ID = 'settings-models'
const PROFILES_PATH = '/api/serve/model-profiles'
const READ_FAILURE_STATUS = 503
const OBSERVATIONS = new WeakMap<Page, { requests: { path: string; method: string }[]; failures: { path: string; method: string; status: number }[]; externalOrigins: string[] }>()

test.beforeEach(({ page }) => {
  const observations = { requests: [] as { path: string; method: string }[], failures: [] as { path: string; method: string; status: number }[], externalOrigins: [] as string[] }
  OBSERVATIONS.set(page, observations)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observations.externalOrigins.includes(url.origin)) observations.externalOrigins.push(url.origin)
    if (url.pathname.startsWith('/api/')) observations.requests.push({ path: url.pathname, method: request.method() })
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path === '/__preview/state') && response.status() >= 400) observations.failures.push({ path, method: response.request().method(), status: response.status() })
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observations = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('models-http-summary.json')
  await writeFile(path, JSON.stringify(observations, null, 2))
  await testInfo.attach('models-http-summary', { path, contentType: 'application/json' })
  expect(observations.externalOrigins).toEqual([])
  expect(observations.requests.filter(request => request.path.startsWith(PROFILES_PATH) && request.method !== 'GET')).toEqual([])
  for (const failure of observations.failures) {
    expect(new URL(page.url()).searchParams.get('scene')).toBe('settings-models-failed')
    expect(failure).toEqual({ path: PROFILES_PATH, method: 'GET', status: READ_FAILURE_STATUS })
  }
})

async function openModels(page: Page, sceneId: string): Promise<{ reading: Promise<Response> }> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  const reading = page.waitForResponse(response => new URL(response.url()).pathname === PROFILES_PATH && response.request().method() === 'GET')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  await expect(previewSurface(page).getByTestId('account-settings-models')).toBeVisible()
  await expect(previewSurface(page).getByRole('tab', { name: '模型服务', exact: true })).toHaveAttribute('aria-selected', 'true')
  return { reading }
}

async function profileResponse(reading: Promise<Response>): Promise<PersonalApiProfilesResp> {
  const response = await reading
  expect(response.status()).toBe(200)
  return await response.json() as PersonalApiProfilesResp
}

test('model service displays the reviewed credential-free connection, filters and reads its selected models', { annotation: previewConsumption(PAGE_ID, 'settings-models-states', ['loaded', 'filtered', 'details']) }, async ({ page }, testInfo) => {
  const { reading } = await openModels(page, 'settings-models-states')
  const payload = await profileResponse(reading)
  expect(payload.profiles).toHaveLength(1)
  const profile = payload.profiles[0]
  expect(profile.enabled).toBe(false)
  expect(profile.has_api_key).toBe(false)
  expect(profile).not.toHaveProperty('api_key')
  expect(profile.authentication).not.toBe('oauth')
  expect(new URL(profile.base_url).hostname).toBe('example.invalid')
  expect(profile.selected_models.length).toBeGreaterThan(0)
  const settings = previewSurface(page).getByTestId('account-settings-models')
  const pick = previewSurface(page).getByTestId(`model-connection-pick-${profile.id}`)
  await expect(pick).toContainText(profile.name)
  await expect(pick).toContainText('未设密钥')
  await expect(previewSurface(page).getByTestId(`model-connection-enabled-${profile.id}`)).not.toBeChecked()
  await capturePreview(page, testInfo.outputPath('models-readonly-list.png'))
  const search = previewSurface(page).getByTestId('model-connection-search')
  await search.fill('no-reviewed-model-connection-matches')
  await expect(settings.getByText('没有匹配的连接。', { exact: true })).toBeVisible()
  await expect(pick).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('models-filter-empty.png'))
  await search.fill(new URL(profile.base_url).hostname)
  await expect(pick).toBeVisible()
  await expect(settings.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(1)
  await pick.click()
  await expect(previewSurface(page).getByTestId('model-endpoint-form')).toBeVisible()
  await expect(previewSurface(page).getByTestId('model-endpoint-name')).toHaveValue(profile.preview_name)
  await expect(previewSurface(page).getByTestId('model-endpoint-base-url')).toHaveValue(profile.base_url)
  await expect(previewSurface(page).getByTestId('model-endpoint-api-key')).toHaveValue('')
  for (const model of profile.selected_models) await expect(previewSurface(page).getByTestId(`model-endpoint-model-${model.id}`)).toBeChecked()
  const modelSearch = previewSurface(page).getByTestId('model-endpoint-model-search')
  await modelSearch.fill(profile.selected_models[0].id)
  await expect(previewSurface(page).getByTestId(`model-endpoint-model-${profile.selected_models[0].id}`)).toBeChecked()
  await modelSearch.scrollIntoViewIfNeeded()
  await capturePreview(page, testInfo.outputPath('models-selected-details.png'))
  await page.reload()
  await expect(pick).toBeVisible()
  await expect(previewSurface(page).getByTestId('model-endpoint-base-url')).toHaveValue(profile.base_url)
  await expect(previewSurface(page).getByTestId('model-endpoint-api-key')).toHaveValue('')
  await capturePreview(page, testInfo.outputPath('models-readonly-reloaded.png'))
})

test('model service empty scene retains real unconfigured vendor entries without inventing a saved profile', { annotation: previewConsumption(PAGE_ID, 'settings-models-empty', ['empty']) }, async ({ page }, testInfo) => {
  const { reading } = await openModels(page, 'settings-models-empty')
  expect((await profileResponse(reading)).profiles).toEqual([])
  const settings = previewSurface(page).getByTestId('account-settings-models')
  await expect(settings.locator('[data-testid^="model-connection-pick-"]')).toHaveCount(0)
  await expect(settings.getByText('未添加', { exact: true }).first()).toBeVisible()
  await expect(previewSurface(page).getByTestId('model-endpoint-form')).toHaveCount(0)
  await expect(previewSurface(page).getByTestId('model-connection-add')).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('models-no-saved-connections.png'))
})

test('model service delayed profiles preserve the original loading state before showing reviewed data', { annotation: previewConsumption(PAGE_ID, 'settings-models-pending', ['loading', 'loaded']) }, async ({ page }, testInfo) => {
  const { reading } = await openModels(page, 'settings-models-pending')
  const loading = previewSurface(page).getByTestId('account-settings-models').getByText('正在读取…', { exact: true })
  await expect(loading).toBeVisible()
  await expect(previewSurface(page).getByTestId('model-connection-add')).toBeDisabled()
  await capturePreview(page, testInfo.outputPath('models-profile-loading.png'))
  await expect(loading).toBeVisible()
  const payload = await profileResponse(reading)
  expect(payload.profiles).toHaveLength(1)
  await expect(previewSurface(page).getByTestId(`model-connection-pick-${payload.profiles[0].id}`)).toBeVisible()
  await expect(previewSurface(page).getByTestId('model-connection-add')).toBeEnabled()
  await capturePreview(page, testInfo.outputPath('models-profile-loaded.png'))
})

test('model service profile failures remain errors after the real retry action', { annotation: previewConsumption(PAGE_ID, 'settings-models-failed', ['error', 'retry-failed']) }, async ({ page }, testInfo) => {
  const { reading } = await openModels(page, 'settings-models-failed')
  expect((await reading).status()).toBe(READ_FAILURE_STATUS)
  const settings = previewSurface(page).getByTestId('account-settings-models')
  await expect(settings.getByRole('alert')).toContainText('模型服务加载失败，请重试。')
  await expect(previewSurface(page).getByTestId('model-connection-add')).toBeDisabled()
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === PROFILES_PATH && response.request().method() === 'GET')
  await previewSurface(page).getByTestId('model-endpoint-retry').click()
  expect((await retried).status()).toBe(READ_FAILURE_STATUS)
  await expect(settings.getByRole('alert')).toContainText('模型服务加载失败，请重试。')
  await expect(previewSurface(page).getByTestId('model-endpoint-form')).toHaveCount(0)
  await capturePreview(page, testInfo.outputPath('models-read-retry-failed.png'))
})
