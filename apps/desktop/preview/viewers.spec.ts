import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Request, type Response } from './testing'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_CONTENT } from './content'
import { PREVIEW_ORIGIN, PREVIEW_PROJECT_ID } from './constants'
import { previewConsumption } from './coverage'
import { PREVIEW_DOCUMENTS } from './documents'

const CONTENT_PATH = '/api/workbench/content'
const LOCATION_PATH = '/api/resource/reveal'
const FAILURE_STATUS = 503
const OFFICE_ASSETS = ['/office/zeta-20250513/soffice.wasm', '/office/zeta-20250513/soffice.data']
const VIEWERS = ['code', 'image', 'office'] as const
type Viewer = (typeof VIEWERS)[number]
type Read = {
  sequence: number
  path: string
  referer: string | null
  requestedAt: number
  timing: ReturnType<Request['timing']>
  headersAt?: number
  status?: number
  bodyCompleteAt?: number
  completedTiming?: ReturnType<Request['timing']>
  failure?: string | null
}
type Failure = { path: string; method: string; status: number; owned: boolean }
type LocationRead = Read & {
  owned: boolean
  contentType: string
  body: unknown
  absolute?: unknown
  collectionError?: string
}
type Abort = {
  path: string
  query: string
  referer: string | null
  error: string | null
  duringNavigation: boolean
  resourceType: string
  openedStatus: number | null
  openedContentType: string | null
}
type Observation = {
  instance: string
  scene: string
  viewer: Viewer
  navigating: boolean
  allowFailure: boolean
  reads: Map<Request, Read>
  locationReads: Map<Request, LocationRead>
  collecting: Promise<void>[]
  streams: Map<Request, { status: number; contentType: string }>
  failures: Failure[]
  writes: string[]
  externalOrigins: string[]
  pageErrors: string[]
  requestFailures: Abort[]
  expectedNavigationAborts: Abort[]
  expectedStreamCloses: Abort[]
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

function sample(viewer: Viewer) {
  return PREVIEW_DOCUMENTS.find(
    (document) =>
      document.viewer === viewer && (viewer !== 'office' || document.path.endsWith('.docx'))
  )!
}
function referer(request: Request): URL | null {
  try {
    return new URL(request.headers().referer)
  } catch {
    return null
  }
}
function owned(page: Page, request: Request): boolean {
  const observation = OBSERVATIONS.get(page)!
  const ref = referer(request)
  return (
    ref?.origin === PREVIEW_ORIGIN &&
    ref.searchParams.get('previewInstance') === observation.instance &&
    ref.searchParams.get('scene') === observation.scene
  )
}
function matches(page: Page, request: Request): boolean {
  const observation = OBSERVATIONS.get(page)!
  const url = new URL(request.url())
  return (
    owned(page, request) &&
    request.method() === 'GET' &&
    url.origin === PREVIEW_ORIGIN &&
    url.pathname === CONTENT_PATH &&
    url.searchParams.get('project') === PREVIEW_PROJECT_ID &&
    url.searchParams.get('path') === sample(observation.viewer).path
  )
}
function nextRead(page: Page) {
  return page.waitForResponse((response) => matches(page, response.request()))
}
async function complete(response: Response, status = 200): Promise<void> {
  expect(await response.finished()).toBeNull()
  expect(response.status()).toBe(status)
}

test.beforeEach(({ page }) => {
  const observation: Observation = {
    instance: randomUUID(),
    scene: '',
    viewer: 'code',
    navigating: false,
    allowFailure: false,
    reads: new Map(),
    locationReads: new Map(),
    collecting: [],
    streams: new Map(),
    failures: [],
    writes: [],
    externalOrigins: [],
    pageErrors: [],
    requestFailures: [],
    expectedNavigationAborts: [],
    expectedStreamCloses: [],
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
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET')
      observation.writes.push(`${request.method()} ${url.pathname}`)
    if (
      url.origin === PREVIEW_ORIGIN &&
      url.pathname === LOCATION_PATH &&
      request.method() === 'POST'
    ) {
      let body: unknown
      try {
        body = JSON.parse(request.postData() ?? '')
      } catch {
        body = null
      }
      observation.locationReads.set(request, {
        sequence: observation.locationReads.size + 1,
        path: url.pathname + url.search,
        referer: request.headers().referer ?? null,
        requestedAt: Date.now(),
        timing: request.timing(),
        owned: owned(page, request),
        contentType: request.headers()['content-type'] ?? '',
        body,
      })
    }
    if (url.pathname === CONTENT_PATH && request.method() === 'GET')
      observation.reads.set(request, {
        sequence: observation.reads.size + 1,
        path: url.pathname + url.search,
        referer: request.headers().referer ?? null,
        requestedAt: Date.now(),
        timing: request.timing(),
      })
  })
  page.on('response', (response) => {
    const request = response.request()
    const url = new URL(response.url())
    if (url.pathname === '/api/content/events')
      observation.streams.set(request, {
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      })
    const read = observation.reads.get(request)
    if (read) {
      read.headersAt = Date.now()
      read.status = response.status()
    }
    const location = observation.locationReads.get(request)
    if (location) {
      location.headersAt = Date.now()
      location.status = response.status()
      observation.collecting.push(
        (async () => {
          const failure = await response.finished()
          if (failure) throw failure
          const body = (await response.json()) as { absolute?: unknown }
          location.absolute = body.absolute
        })().catch((error: Error) => {
          location.collectionError = error.message
        })
      )
    }
    if (
      (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview/')) &&
      response.status() >= 400
    )
      observation.failures.push({
        path: url.pathname,
        method: request.method(),
        status: response.status(),
        owned: matches(page, request),
      })
  })
  page.on('requestfinished', (request) => {
    const read = observation.reads.get(request)
    if (read) {
      read.bodyCompleteAt = Date.now()
      read.completedTiming = request.timing()
    }
    const location = observation.locationReads.get(request)
    if (location) {
      location.bodyCompleteAt = Date.now()
      location.completedTiming = request.timing()
    }
  })
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    const stream = observation.streams.get(request)
    const failure: Abort = {
      path: url.pathname,
      query: url.search,
      referer: request.headers().referer ?? null,
      error: request.failure()?.errorText ?? null,
      duringNavigation: observation.navigating,
      resourceType: request.resourceType(),
      openedStatus: stream?.status ?? null,
      openedContentType: stream?.contentType ?? null,
    }
    observation.requestFailures.push(failure)
    if (
      url.origin === PREVIEW_ORIGIN &&
      observation.navigating &&
      OFFICE_ASSETS.includes(url.pathname) &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedNavigationAborts.push(failure)
    if (
      url.origin === PREVIEW_ORIGIN &&
      url.pathname === '/api/content/events' &&
      url.searchParams.get('project') === PREVIEW_PROJECT_ID &&
      request.method() === 'GET' &&
      owned(page, request) &&
      request.resourceType() === 'eventsource' &&
      stream?.status === 200 &&
      stream.contentType.split(';')[0] === 'text/event-stream' &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedStreamCloses.push(failure)
    const read = observation.reads.get(request)
    if (read) {
      read.failure = failure.error
      read.completedTiming = request.timing()
    }
  })
})

test.afterEach(async ({ page, request }, testInfo) => {
  const { reads, streams, locationReads, collecting, ...observation } = OBSERVATIONS.get(page)!
  await Promise.all(collecting)
  let projectRoot: string | undefined
  let bootstrapError: string | null = null
  if (locationReads.size) {
    try {
      const response = await request.get(
        `${PREVIEW_ORIGIN}/__preview/state?previewInstance=${observation.instance}`
      )
      if (response.status() !== 200) throw new Error(`Location bootstrap HTTP ${response.status()}`)
      const state = (await response.json()) as { projects: { id: string; root: string }[] }
      projectRoot = state.projects.find((project) => project.id === PREVIEW_PROJECT_ID)?.root
      if (!projectRoot?.startsWith('/preview/')) throw new Error('Missing virtual project root')
    } catch (error) {
      bootstrapError = error instanceof Error ? error.message : String(error)
    }
  }
  const path = testInfo.outputPath('viewers-http-summary.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        ...observation,
        reads: [...reads.values()],
        locationReads: [...locationReads.values()],
        bootstrapError,
        streamHeaders: [...streams.values()],
      },
      null,
      2
    )
  )
  await testInfo.attach('viewers-http-summary', { path, contentType: 'application/json' })
  expect(bootstrapError).toBeNull()
  expect(observation.writes).toEqual([...locationReads.values()].map(() => `POST ${LOCATION_PATH}`))
  for (const location of locationReads.values()) {
    expect(location.owned).toBe(true)
    expect(location.contentType.split(';')[0]).toBe('application/json')
    expect(location.body).toEqual({
      project: PREVIEW_PROJECT_ID,
      path: sample(observation.viewer).path,
    })
    expect(location.status).toBe(200)
    expect(location.bodyCompleteAt).toBeDefined()
    expect(location.collectionError).toBeUndefined()
    expect(location.absolute).toBe(`${projectRoot}/${sample(observation.viewer).path}`)
  }
  expect(observation.externalOrigins).toEqual([])
  expect(observation.pageErrors).toEqual([])
  expect(
    observation.requestFailures.filter(
      (failure) =>
        !observation.expectedNavigationAborts.includes(failure) &&
        !observation.expectedStreamCloses.includes(failure)
    )
  ).toEqual([])
  expect(
    observation.failures.every(
      (failure) =>
        observation.allowFailure &&
        failure.owned &&
        failure.method === 'GET' &&
        failure.path === CONTENT_PATH &&
        failure.status === FAILURE_STATUS
    )
  ).toBe(true)
  expect([...reads.values()].filter((read) => !read.bodyCompleteAt)).toEqual([])
})

async function selectScene(page: Page, viewer: Viewer, mode: string): Promise<void> {
  const observation = OBSERVATIONS.get(page)!
  observation.viewer = viewer
  observation.scene = `viewer-${viewer}-${mode}`
  observation.allowFailure = mode !== 'pending'
  const entry = PREVIEW_CATALOG.find((candidate) => candidate.id === `viewer-${viewer}`)!
  const scene = entry.scenarios.find((candidate) => candidate.id === observation.scene)!
  await page.goto(`/?previewInstance=${observation.instance}&scene=page-home`)
  await page.keyboard.press('F8')

  observation.navigating = true
  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('scene') === observation.scene &&
      url.searchParams.get('page') === entry.id
  )
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  observation.navigating = false
}
async function loaded(page: Page, viewer: Viewer): Promise<void> {
  if (viewer === 'code')
    await expect(
      previewSurface(page).getByTestId('monaco-editor').contentFrame().locator('.view-lines')
    ).toContainText('hello from minimal project')
  else if (viewer === 'image') {
    const image = previewSurface(page)
      .getByTestId('image-viewer')
      .getByRole('img', { name: 'sample.png', exact: true })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => ({
          complete: element.complete,
          width: element.naturalWidth,
          height: element.naturalHeight,
        }))
      )
      .toEqual({ complete: true, width: 200, height: 200 })
    await expect(previewSurface(page).getByTestId('image-dimensions')).toHaveText('200 × 200')
  } else {
    await expect(previewSurface(page).getByTestId('office-preview')).toHaveAttribute(
      'data-office-title',
      'sample.docx'
    )
    await expect(previewSurface(page).getByTestId('office-preview-content')).toContainText('Normal + Courier New')
    await expect(previewSurface(page).getByTestId('office-preview').getByRole('status')).toHaveCount(0)
  }
  await expect(previewSurface(page).getByTestId('document-load-error')).toHaveCount(0)
  await expect(
    previewSurface(page)
      .getByTestId(
        viewer === 'image'
          ? 'image-viewer'
          : viewer === 'office'
            ? 'office-preview'
            : 'document-load-error'
      )
      .getByRole('alert')
  ).toHaveCount(0)
}
async function recover(page: Page): Promise<void> {
  await page.keyboard.press('F8')
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === PREVIEW_CONTENT.recoveryPath &&
      response.request().method() === 'POST'
  )
  await page.getByTestId('preview-content-recover').click()
  await complete(await response)
  await page.keyboard.press('Escape')
}
async function reenter(page: Page, viewer: Viewer): Promise<void> {
  await previewSurface(page).getByRole('button', { name: `关闭 ${sample(viewer).path}`, exact: true }).click()
  await previewSurface(page).getByTestId('project-library').click()
  await previewSurface(page)
    .getByTestId('project-library-content')
    .getByRole('tab', { name: '资料', exact: true })
    .click()
  const response = nextRead(page)
  await previewSurface(page).getByTestId(`material-${sample(viewer).path}`).click()
  await complete(await response)
  await loaded(page, viewer)
}

for (const viewer of VIEWERS)
  for (const mode of ['pending', 'failed', 'retry'] as const) {
    const states =
      mode === 'pending'
        ? ['loading', 'loaded']
        : mode === 'failed'
          ? ['error', 'retry-failed', 'recovered']
          : ['error', 'retried', 'loaded']
    test(
      `${viewer} ${mode} reads the same reviewed document through the Console and original retry`,
      { annotation: previewConsumption(`viewer-${viewer}`, `viewer-${viewer}-${mode}`, states) },
      async ({ page }, testInfo) => {
        const request =
          mode === 'pending' ? page.waitForRequest((request) => matches(page, request)) : null
        const response = nextRead(page)
        await selectScene(page, viewer, mode)
        if (mode === 'pending') {
          const pending = await request!
          await expect(previewSurface(page).getByTestId('progress-screen')).toBeVisible()
          await expect(previewSurface(page).getByTestId('progress-screen')).toHaveAttribute('aria-busy', 'true')
          await expect(
            previewSurface(page).getByTestId(
              viewer === 'code'
                ? 'monaco-editor'
                : viewer === 'image'
                  ? 'image-viewer'
                  : 'office-preview'
            )
          ).toHaveCount(0)
          expect(OBSERVATIONS.get(page)!.reads.get(pending)?.headersAt).toBeUndefined()
          await capturePreview(page, testInfo.outputPath('viewer-app-loading.png'))
          expect(OBSERVATIONS.get(page)!.reads.get(pending)?.headersAt).toBeUndefined()
          await complete(await response)
        } else {
          await complete(await response, FAILURE_STATUS)
          await expect(previewSurface(page).getByTestId('document-load-error')).toContainText(
            PREVIEW_CONTENT.failureCode
          )
          await capturePreview(page, testInfo.outputPath('viewer-read-failed.png'))
          const retry = nextRead(page)
          await previewSurface(page).getByTestId('document-load-retry').click()
          await complete(await retry, mode === 'failed' ? FAILURE_STATUS : 200)
          if (mode === 'failed') {
            await expect(previewSurface(page).getByTestId('document-load-error')).toBeVisible()
            await capturePreview(page, testInfo.outputPath('viewer-retry-failed.png'))
            await recover(page)
            const recovered = nextRead(page)
            await previewSurface(page).getByTestId('document-load-retry').click()
            await complete(await recovered)
          }
        }
        await loaded(page, viewer)
        await capturePreview(page, testInfo.outputPath('viewer-loaded.png'))
        await reenter(page, viewer)
        await capturePreview(page, testInfo.outputPath('viewer-reentered.png'))
      }
    )
  }

test(
  'DOCX persistent failure supports focused Enter retry and full view in dark English at the minimum window',
  {
    annotation: previewConsumption('viewer-office', 'viewer-office-failed', [
      'error',
      'retry-failed',
      'recovered',
    ]),
  },
  async ({ page }, testInfo) => {
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await selectScene(page, 'office', 'failed')
    await expect(previewSurface(page).getByTestId('document-load-error')).toBeVisible()
    await page.keyboard.press('F8')
    await openPreviewTools(page)
    await page.locator('#preview-theme').click()
    await page.getByRole('option', { name: '深色', exact: true }).click()
    await openPreviewTools(page)
    await page.locator('#preview-language').click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    const reloaded = page.waitForEvent('domcontentloaded')
    OBSERVATIONS.get(page)!.navigating = true
    await page.getByRole('button', { name: '保存外观并重新加载', exact: true }).click()
    await reloaded
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('heading', { name: 'PDFE Workbench', exact: true })).toBeVisible()
    OBSERVATIONS.get(page)!.navigating = false
    await expect(previewSurface(page).getByTestId('document-load-error')).toBeVisible()
    const retry = previewSurface(page).getByTestId('document-load-retry')
    await retry.scrollIntoViewIfNeeded()
    await retry.focus()
    await expect(retry).toBeFocused()
    const geometry = await retry.boundingBox()
    await writeFile(
      testInfo.outputPath('viewer-keyboard-geometry.json'),
      JSON.stringify(
        {
          viewport: WORKSPACE_WINDOW_MINIMUM,
          retry: geometry,
          method: 'focus+Enter, not Tab traversal',
        },
        null,
        2
      )
    )
    await capturePreview(page, testInfo.outputPath('viewer-dark-narrow-error.png'))
    expect(geometry).not.toBeNull()
    expect(geometry!.x).toBeGreaterThanOrEqual(0)
    expect(geometry!.y).toBeGreaterThanOrEqual(0)
    expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
    expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.height)
    const failed = nextRead(page)
    await page.keyboard.press('Enter')
    await complete(await failed, FAILURE_STATUS)
    await expect(previewSurface(page).getByTestId('document-load-error')).toBeVisible()
    await recover(page)
    await retry.focus()
    await expect(retry).toBeFocused()
    const recovered = nextRead(page)
    await page.keyboard.press('Enter')
    await complete(await recovered)
    await loaded(page, 'office')
    await previewSurface(page).getByRole('button', { name: 'Enter full view', exact: true }).click()
    await expect(previewSurface(page).getByRole('button', { name: 'Exit full view', exact: true })).toBeVisible()
    await loaded(page, 'office')
    await capturePreview(page, testInfo.outputPath('viewer-dark-narrow-fullview-recovered.png'))
  }
)
