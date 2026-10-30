import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Request, type TestInfo } from './testing'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'
import {
  PREVIEW_STORAGE_READ,
  type PreviewStorageRead,
  type PreviewStorageReadPolicy,
} from './directory'
import { PREVIEW_STORAGE } from './storage'

const PAGE_ID = 'settings-storage'
const FAILURE_STATUS = 503
const OFFICE_NAVIGATION_ASSETS = new Set([
  '/office/zeta-20250513/soffice.wasm',
  '/office/zeta-20250513/soffice.data',
])
const SOURCES = ['home', 'workspace'] as const
const PATHS = { home: PREVIEW_STORAGE_READ.configPath, workspace: PREVIEW_STORAGE.path }
const CONTROLS = { home: 'storage-data-home', workspace: 'storage-container-root' }
const CASES = [
  {
    id: 'settings-storage-home-read-pending',
    home: 'delayed',
    workspace: 'normal',
    states: ['loading', 'loaded'],
  },
  {
    id: 'settings-storage-workspace-read-pending',
    home: 'normal',
    workspace: 'delayed',
    states: ['loading', 'loaded'],
  },
  {
    id: 'settings-storage-home-read-failed',
    home: 'failed',
    workspace: 'normal',
    states: ['error', 'retry-failed', 'recovered'],
  },
  {
    id: 'settings-storage-workspace-read-failed',
    home: 'normal',
    workspace: 'failed',
    states: ['error', 'retry-failed', 'recovered'],
  },
  {
    id: 'settings-storage-both-read-failed',
    home: 'failed',
    workspace: 'failed',
    states: ['error', 'retry-failed', 'recovered'],
  },
  {
    id: 'settings-storage-read-required',
    home: 'failed',
    workspace: 'delayed',
    states: ['loading', 'error', 'recovered'],
  },
] as const satisfies readonly {
  id: string
  home: PreviewStorageReadPolicy
  workspace: PreviewStorageReadPolicy
  states: readonly string[]
}[]

type HttpFailure = { method: string; path: string; status: number }
type RequestFailure = {
  path: string
  error: string | null
  referer: string | null
  duringNavigation: boolean
}
type ReadTrace = {
  sequence: number
  source: PreviewStorageRead
  path: string
  scene: string | null
  referer: string | null
  requestedAt: number
  requestTiming: ReturnType<Request['timing']>
  headersAt?: number
  status?: number
  headersTiming?: ReturnType<Request['timing']>
  bodyCompleteAt?: number
  completeTiming?: ReturnType<Request['timing']>
  failedAt?: number
  failure?: string | null
}
type Observation = {
  failures: HttpFailure[]
  reads: { source: PreviewStorageRead; status: number; scene: string | null }[]
  externalOrigins: string[]
  pageErrors: string[]
  requestFailures: RequestFailure[]
  expectedNavigationAborts: RequestFailure[]
  navigating: boolean
  scene: string
  instance: string
  writes: number
  active: Set<Request>
  readRequests: Map<Request, ReadTrace>
  allowed: string[]
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

function sourceOf(input: string): PreviewStorageRead | undefined {
  const path = new URL(input).pathname
  return SOURCES.find((source) => PATHS[source] === path)
}

function requestScene(request: Request): URL | null {
  const referer = request.headers().referer
  if (!referer) return null
  try {
    const url = new URL(referer)
    return url.origin === PREVIEW_ORIGIN ? url : null
  } catch {
    return null
  }
}

function belongsToScene(page: Page, request: Request, source: PreviewStorageRead): boolean {
  const observation = OBSERVATIONS.get(page)!
  const referer = requestScene(request)
  return (
    request.method() === 'GET' &&
    sourceOf(request.url()) === source &&
    referer?.searchParams.get('scene') === observation.scene &&
    referer.searchParams.get('previewInstance') === observation.instance
  )
}

test.beforeEach(({ page }) => {
  const observation: Observation = {
    failures: [],
    reads: [],
    externalOrigins: [],
    pageErrors: [],
    requestFailures: [],
    expectedNavigationAborts: [],
    navigating: false,
    scene: '',
    instance: '',
    writes: 0,
    active: new Set(),
    readRequests: new Map(),
    allowed: [],
  }
  OBSERVATIONS.set(page, observation)
  page.on('pageerror', (error) => observation.pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin !== PREVIEW_ORIGIN &&
      !observation.externalOrigins.includes(url.origin)
    )
      observation.externalOrigins.push(url.origin)
    const source = sourceOf(request.url())
    if (request.method() === 'GET' && source) {
      observation.active.add(request)
      observation.readRequests.set(request, {
        sequence: observation.readRequests.size + 1,
        source,
        path: url.pathname + url.search,
        scene: requestScene(request)?.searchParams.get('scene') ?? null,
        referer: request.headers().referer ?? null,
        requestedAt: Date.now(),
        requestTiming: request.timing(),
      })
    }
    if (request.method() === 'PUT' && url.pathname === PREVIEW_STORAGE.path) observation.writes += 1
  })
  page.on('response', (response) => {
    const request = response.request()
    const url = new URL(response.url())
    const source = sourceOf(response.url())
    if (request.method() === 'GET' && source) {
      observation.active.delete(request)
      const trace = observation.readRequests.get(request)
      if (trace) {
        trace.headersAt = Date.now()
        trace.status = response.status()
        trace.headersTiming = request.timing()
      }
      observation.reads.push({
        source,
        status: response.status(),
        scene: requestScene(request)?.searchParams.get('scene') ?? null,
      })
    }
    if (
      (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview/')) &&
      response.status() >= 400
    )
      observation.failures.push({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
      })
  })
  page.on('requestfinished', (request) => {
    const trace = observation.readRequests.get(request)
    if (trace) {
      trace.bodyCompleteAt = Date.now()
      trace.completeTiming = request.timing()
    }
  })
  page.on('requestfailed', (request) => {
    observation.active.delete(request)
    const trace = observation.readRequests.get(request)
    if (trace) {
      trace.failedAt = Date.now()
      trace.failure = request.failure()?.errorText ?? null
      trace.completeTiming = request.timing()
    }
    const url = new URL(request.url())
    const failure = {
      path: url.pathname,
      error: request.failure()?.errorText ?? null,
      referer: request.headers().referer ?? null,
      duringNavigation: observation.navigating,
    }
    observation.requestFailures.push(failure)
    if (
      observation.navigating &&
      url.origin === PREVIEW_ORIGIN &&
      OFFICE_NAVIGATION_ASSETS.has(url.pathname) &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedNavigationAborts.push(failure)
  })
})

test.afterEach(async ({ page, request }, testInfo) => {
  const { active, readRequests, ...observation } = OBSERVATIONS.get(page)!
  let stateDiagnostics: unknown = null
  let diagnosticReadError: string | null = null
  let diagnosticStatus: number | null = null
  try {
    const query = new URLSearchParams({
      previewInstance: observation.instance,
      scene: observation.scene,
    })
    const response = await request.get(`/__preview/state?${query}`)
    diagnosticStatus = response.status()
    if (!response.ok()) throw new Error(`Preview diagnostics HTTP ${response.status()}`)
    const state = (await response.json()) as { diagnostics?: unknown }
    if (!state.diagnostics) throw new Error('Preview state diagnostics missing')
    stateDiagnostics = state.diagnostics
  } catch (error) {
    diagnosticReadError = error instanceof Error ? error.message : String(error)
  }
  const path = testInfo.outputPath('storage-read-http-summary.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        ...observation,
        readTimings: [...readRequests.values()],
        stateDiagnostics,
        diagnosticStatus,
        diagnosticReadError,
        activeReads: [...active].map((request) => new URL(request.url()).pathname),
      },
      null,
      2
    )
  )
  await testInfo.attach('storage-read-http-summary', { path, contentType: 'application/json' })
  expect(diagnosticReadError).toBeNull()
  expect(observation.pageErrors).toEqual([])
  expect(observation.externalOrigins).toEqual([])
  expect(
    observation.requestFailures.filter(
      (failure) => !observation.expectedNavigationAborts.includes(failure)
    )
  ).toEqual([])
  expect(observation.writes).toBe(0)
  expect(
    observation.failures.every(
      (failure) =>
        failure.method === 'GET' &&
        failure.status === FAILURE_STATUS &&
        observation.allowed.includes(failure.path)
    )
  ).toBe(true)
})

async function selectScene(page: Page, id: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find((candidate) => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find((candidate) => candidate.id === id)!
  await page.keyboard.press('F8')
  OBSERVATIONS.get(page)!.navigating = true
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(page).toHaveURL((url) => url.searchParams.get('scene') === id)
  await page.waitForLoadState('domcontentloaded')
  await expect(previewSurface(page).getByTestId('account-settings-storage')).toBeVisible()
  OBSERVATIONS.get(page)!.navigating = false
}

function nextRead(page: Page, source: PreviewStorageRead) {
  return page.waitForResponse((response) => belongsToScene(page, response.request(), source))
}

async function loading(
  page: Page,
  source: PreviewStorageRead,
  testInfo: TestInfo,
  phase: string,
  request: Promise<Request>
): Promise<void> {
  const pending = await request
  await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-loading`)).toBeVisible()
  if (source === 'workspace')
    await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeDisabled()
  expect(OBSERVATIONS.get(page)!.active.has(pending)).toBe(true)
  await capturePreview(page, testInfo.outputPath(`storage-${source}-${phase}-loading.png`))
  expect(OBSERVATIONS.get(page)!.active.has(pending)).toBe(true)
}

async function ready(page: Page, source: PreviewStorageRead): Promise<void> {
  await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-loading`)).not.toBeVisible()
  await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).not.toBeVisible()
  await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-value`)).toContainText('/preview/')
}

async function cancelSelection(page: Page): Promise<void> {
  await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeEnabled()
  await previewSurface(page).getByTestId('storage-container-root-change').click()
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).toBeVisible()
  await previewSurface(page).getByTestId(`preview-directory-choice-${PREVIEW_STORAGE.choiceIds[0]}`).click()
  await expect(previewSurface(page).getByTestId('preview-directory-confirm')).toBeEnabled()
  await previewSurface(page).getByTestId('preview-directory-cancel').click()
  await expect(previewSurface(page).getByTestId('preview-directory-dialog')).not.toBeVisible()
  expect(OBSERVATIONS.get(page)!.writes).toBe(0)
}

async function leave(page: Page): Promise<void> {
  const dialog = previewSurface(page).getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(previewSurface(page).getByTestId('account-settings-storage')).not.toBeVisible()
}

async function returnToStorage(page: Page): Promise<void> {
  await previewSurface(page).getByTestId('activity-account').click()
  await previewSurface(page).getByTestId('account-menu-settings').click()
  await previewSurface(page).getByTestId('account-settings-nav-storage').click()
}

for (const policy of CASES) {
  test(
    `${policy.id} consumes independent reads, original retry and public reentry`,
    { annotation: previewConsumption(PAGE_ID, policy.id, policy.states) },
    async ({ page }, testInfo) => {
      const failures = SOURCES.filter((source) => policy[source] === 'failed')
      const delayed = SOURCES.find((source) => policy[source] === 'delayed')
      OBSERVATIONS.get(page)!.allowed = failures.map((source) => PATHS[source])
      OBSERVATIONS.get(page)!.scene = policy.id
      OBSERVATIONS.get(page)!.instance = randomUUID()
      await page.goto(`/?previewInstance=${OBSERVATIONS.get(page)!.instance}&scene=page-home`)
      const delayedRequest = delayed
        ? page.waitForRequest((request) => belongsToScene(page, request, delayed))
        : undefined
      const completed = delayed ? nextRead(page, delayed) : undefined
      await selectScene(page, policy.id)
      await expect(previewSurface(page).getByTestId('account-settings-storage')).toBeVisible()
      if (delayed && delayedRequest)
        await loading(page, delayed, testInfo, 'initial', delayedRequest)
      if (completed) expect((await completed).status()).toBe(200)
      for (const source of SOURCES) {
        if (policy[source] === 'failed') {
          await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
          await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-value`)).not.toBeVisible()
        } else await ready(page, source)
      }
      if (failures.includes('home')) {
        await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toBeAttached()
        await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toHaveText(
          '无法读取当前数据位置'
        )
      }
      await capturePreview(page, testInfo.outputPath('storage-initial-settled.png'))
      if (failures.includes('workspace'))
        await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeDisabled()
      else await cancelSelection(page)
      for (const source of failures) {
        const response = nextRead(page, source)
        await previewSurface(page).getByTestId(`${CONTROLS[source]}-retry`).click()
        expect((await response).status()).toBe(FAILURE_STATUS)
        await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
      }
      if (failures.length)
        await capturePreview(page, testInfo.outputPath('storage-original-retry-failed.png'))
      await leave(page)
      if (failures.includes('home')) {
        await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toBeVisible()
        const firstLaunchFailed = nextRead(page, 'home')
        await previewSurface(page).getByTestId('storage-first-launch-read-retry').click()
        expect((await firstLaunchFailed).status()).toBe(FAILURE_STATUS)
        await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toBeVisible()
        await capturePreview(page, testInfo.outputPath('storage-first-launch-retry-failed.png'))
      }
      const repeatedRequest = delayed
        ? page.waitForRequest((request) => belongsToScene(page, request, delayed))
        : undefined
      const repeated = delayed ? nextRead(page, delayed) : undefined
      await returnToStorage(page)
      if (delayed && repeatedRequest)
        await loading(page, delayed, testInfo, 'reentered', repeatedRequest)
      if (repeated) expect((await repeated).status()).toBe(200)
      for (const source of SOURCES) {
        if (failures.includes(source))
          await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
        else await ready(page, source)
      }
      await capturePreview(page, testInfo.outputPath('storage-reentered.png'))
      if (failures.length) {
        await page.keyboard.press('F8')
        const recovered = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === PREVIEW_STORAGE_READ.recoveryPath &&
            response.request().method() === 'POST'
        )
        await page.getByTestId('preview-storage-recover').click()
        expect((await recovered).status()).toBe(200)
        await page.keyboard.press('Escape')
        for (const source of failures) {
          await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
          const retried = nextRead(page, source)
          await previewSurface(page).getByTestId(`${CONTROLS[source]}-retry`).click()
          expect((await retried).status()).toBe(200)
          await ready(page, source)
        }
        await capturePreview(page, testInfo.outputPath('storage-original-retry-recovered.png'))
        if (failures.includes('home')) {
          await leave(page)
          await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toBeVisible()
          const firstLaunchRecovered = nextRead(page, 'home')
          await previewSurface(page).getByTestId('storage-first-launch-read-retry').click()
          expect((await firstLaunchRecovered).status()).toBe(200)
          await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).not.toBeAttached()
          await expect(previewSurface(page).getByTestId('storage-first-launch-read-retry')).not.toBeAttached()
          await capturePreview(
            page,
            testInfo.outputPath('storage-first-launch-retry-recovered.png')
          )
          await returnToStorage(page)
          for (const source of SOURCES) await ready(page, source)
        }
      }
      await cancelSelection(page)
      for (const source of SOURCES) await ready(page, source)
    }
  )
}

test(
  'storage double read failure supports keyboard recovery in dark English at the minimum window',
  {
    annotation: previewConsumption(PAGE_ID, 'settings-storage-both-read-failed', [
      'error',
      'retry-failed',
      'recovered',
    ]),
  },
  async ({ page }, testInfo) => {
    const observation = OBSERVATIONS.get(page)!
    observation.scene = 'settings-storage-both-read-failed'
    observation.instance = randomUUID()
    observation.allowed = SOURCES.map((source) => PATHS[source])
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await page.goto(`/?previewInstance=${observation.instance}&scene=page-home`)
    await selectScene(page, observation.scene)
    await page.keyboard.press('F8')
    await openPreviewTools(page)
    await page.locator('#preview-theme').click()
    await page.getByRole('option', { name: '深色', exact: true }).click()
    await openPreviewTools(page)
    await page.locator('#preview-language').click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    const reloaded = page.waitForEvent('domcontentloaded')
    observation.navigating = true
    await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
    await reloaded
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('heading', { name: 'PDFE Workbench', exact: true })).toBeVisible()
    observation.navigating = false
    if (!(await previewSurface(page).getByTestId('account-settings-storage').isVisible()))
      await returnToStorage(page)
    const geometry: {
      stage: string
      source: PreviewStorageRead
      viewport: typeof WORKSPACE_WINDOW_MINIMUM
      box: Awaited<ReturnType<ReturnType<Page['getByTestId']>['boundingBox']>>
    }[] = []
    const keyboardRetry = async (
      source: PreviewStorageRead,
      status: number,
      stage: string
    ): Promise<void> => {
      const retry = previewSurface(page).getByTestId(`${CONTROLS[source]}-retry`)
      await retry.scrollIntoViewIfNeeded()
      const box = await retry.boundingBox()
      geometry.push({ stage, source, viewport: WORKSPACE_WINDOW_MINIMUM, box })
      const path = testInfo.outputPath('storage-dark-narrow-geometry.json')
      await writeFile(path, JSON.stringify(geometry, null, 2))
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
      expect(box!.y + box!.height).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.height)
      await retry.focus()
      await expect(retry).toBeFocused()
      const response = nextRead(page, source)
      await page.keyboard.press('Enter')
      expect((await response).status()).toBe(status)
    }
    for (const source of SOURCES) {
      await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
      await keyboardRetry(source, FAILURE_STATUS, 'persistent-error')
      await expect(previewSurface(page).getByTestId(`${CONTROLS[source]}-error`)).toBeVisible()
    }
    await expect(previewSurface(page).getByTestId('storage-container-root-change')).toBeDisabled()
    await capturePreview(page, testInfo.outputPath('storage-dark-narrow-error.png'))
    await page.keyboard.press('F8')
    const recovered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === PREVIEW_STORAGE_READ.recoveryPath &&
        response.request().method() === 'POST'
    )
    await page.getByTestId('preview-storage-recover').click()
    expect((await recovered).status()).toBe(200)
    await page.keyboard.press('Escape')
    for (const source of SOURCES) {
      await keyboardRetry(source, 200, 'recovered-policy')
      await ready(page, source)
    }
    await capturePreview(page, testInfo.outputPath('storage-dark-narrow-recovered.png'))
    await page.keyboard.press('Escape')
    await expect(previewSurface(page).getByTestId('account-settings-storage')).not.toBeVisible()
    await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).toBeVisible()
    const firstLaunchRecovered = nextRead(page, 'home')
    await previewSurface(page).getByTestId('storage-first-launch-read-retry').focus()
    await page.keyboard.press('Enter')
    expect((await firstLaunchRecovered).status()).toBe(200)
    await expect(previewSurface(page).getByTestId('storage-first-launch-read-error')).not.toBeAttached()
    await returnToStorage(page)
    for (const source of SOURCES) await ready(page, source)
    await cancelSelection(page)
  }
)
