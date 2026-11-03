import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Request, type Response } from './testing'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN, PREVIEW_PROJECT_ID } from './constants'
import { previewConsumption } from './coverage'
import { PREVIEW_BROWSING } from './listing'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'

const LISTING_PAGE = 'viewer-material-list'
const EXPLORER_PAGE = 'viewer-explorer'
const LISTING_PATH = '/api/resource/list'
const EXPLORER_PATH = `/api/content/projects/${PREVIEW_PROJECT_ID}/tree`
const FAILURE_STATUS = 503
const ROOT_DIRECTORY = '/'
const NO_MATCH = 'reviewed-browsing-no-match'
const OFFICE_ASSETS = ['/office/zeta-20250513/soffice.wasm', '/office/zeta-20250513/soffice.data']
type Source = 'listing' | 'explorer'
type Failure = { method: string; path: string; status: number }
type Trace = {
  sequence: number
  source: Source
  path: string
  scene: string | null
  referer: string | null
  requestedAt: number
  requestedTiming: ReturnType<Request['timing']>
  headersAt?: number
  status?: number
  headersTiming?: ReturnType<Request['timing']>
  bodyCompleteAt?: number
  completedTiming?: ReturnType<Request['timing']>
  failure?: string | null
}
type Aborted = {
  path: string
  query: string
  method: string
  resourceType: string
  referer: string | null
  openedStatus: number | null
  openedContentType: string | null
  error: string | null
  duringNavigation: boolean
}
type Observation = {
  instance: string
  scene: string
  navigating: boolean
  failures: Failure[]
  allowed: string[]
  writes: { path: string; method: string }[]
  externalOrigins: string[]
  pageErrors: string[]
  requestFailures: Aborted[]
  expectedNavigationAborts: Aborted[]
  expectedStreamCloses: Aborted[]
  streams: Map<Request, { status: number; contentType: string }>
  requests: Map<Request, Trace>
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

function sourceOf(url: URL): Source | undefined {
  return url.pathname === LISTING_PATH
    ? 'listing'
    : url.pathname === EXPLORER_PATH
      ? 'explorer'
      : undefined
}

function referer(request: Request): URL | null {
  try {
    return new URL(request.headers().referer)
  } catch {
    return null
  }
}

function matches(page: Page, request: Request, source: Source, offset = 0): boolean {
  const observation = OBSERVATIONS.get(page)!
  const ref = referer(request)
  const url = new URL(request.url())
  return (
    request.method() === 'GET' &&
    sourceOf(url) === source &&
    ref?.origin === PREVIEW_ORIGIN &&
    ref.searchParams.get('scene') === observation.scene &&
    ref.searchParams.get('previewInstance') === observation.instance &&
    (source === 'listing' ||
      (url.searchParams.get('path') === '' &&
        Number(url.searchParams.get('offset') ?? 0) === offset))
  )
}

test.beforeEach(({ page }) => {
  const observation: Observation = {
    instance: randomUUID(),
    scene: '',
    navigating: false,
    failures: [],
    allowed: [],
    writes: [],
    externalOrigins: [],
    pageErrors: [],
    requestFailures: [],
    expectedNavigationAborts: [],
    expectedStreamCloses: [],
    streams: new Map(),
    requests: new Map(),
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
      observation.writes.push({ path: url.pathname, method: request.method() })
    const source = sourceOf(url)
    if (source && request.method() === 'GET')
      observation.requests.set(request, {
        sequence: observation.requests.size + 1,
        source,
        path: url.pathname + url.search,
        scene: referer(request)?.searchParams.get('scene') ?? null,
        referer: request.headers().referer ?? null,
        requestedAt: Date.now(),
        requestedTiming: request.timing(),
      })
  })
  page.on('response', (response) => {
    const request = response.request()
    const url = new URL(response.url())
    const trace = observation.requests.get(request)
    if (url.pathname === '/api/content/events')
      observation.streams.set(request, {
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      })
    if (trace) {
      trace.headersAt = Date.now()
      trace.status = response.status()
      trace.headersTiming = request.timing()
    }
    if (
      (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview/')) &&
      response.status() >= 400
    )
      observation.failures.push({
        path: url.pathname,
        method: request.method(),
        status: response.status(),
      })
  })
  page.on('requestfinished', (request) => {
    const trace = observation.requests.get(request)
    if (trace) {
      trace.bodyCompleteAt = Date.now()
      trace.completedTiming = request.timing()
    }
  })
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    const stream = observation.streams.get(request)
    const failure = {
      path: url.pathname,
      query: url.search,
      method: request.method(),
      resourceType: request.resourceType(),
      referer: request.headers().referer ?? null,
      openedStatus: stream?.status ?? null,
      openedContentType: stream?.contentType ?? null,
      error: request.failure()?.errorText ?? null,
      duringNavigation: observation.navigating,
    }
    observation.requestFailures.push(failure)
    if (
      observation.navigating &&
      url.origin === PREVIEW_ORIGIN &&
      OFFICE_ASSETS.includes(url.pathname) &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedNavigationAborts.push(failure)
    const ref = referer(request)
    if (
      url.origin === PREVIEW_ORIGIN &&
      url.pathname === '/api/content/events' &&
      request.method() === 'GET' &&
      request.resourceType() === 'eventsource' &&
      url.searchParams.get('project') === PREVIEW_PROJECT_ID &&
      ref?.origin === PREVIEW_ORIGIN &&
      ref.searchParams.get('previewInstance') === observation.instance &&
      ref.searchParams.get('scene') === observation.scene &&
      stream?.status === 200 &&
      stream.contentType.split(';')[0] === 'text/event-stream' &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedStreamCloses.push(failure)
    const trace = observation.requests.get(request)
    if (trace) {
      trace.failure = failure.error
      trace.completedTiming = request.timing()
    }
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const { requests, streams, ...observation } = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('browsing-http-summary.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        ...observation,
        streamHeaders: [...streams.values()],
        requestTimings: [...requests.values()],
      },
      null,
      2
    )
  )
  await testInfo.attach('browsing-http-summary', { path, contentType: 'application/json' })
  expect(observation.writes).toEqual([])
  expect(observation.pageErrors).toEqual([])
  expect(observation.externalOrigins).toEqual([])
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
        failure.method === 'GET' &&
        failure.status === FAILURE_STATUS &&
        observation.allowed.includes(failure.path)
    )
  ).toBe(true)
})

async function launch(page: Page, pageId: string, sceneId: string): Promise<void> {
  const observation = OBSERVATIONS.get(page)!
  observation.scene = sceneId
  const entry = PREVIEW_CATALOG.find((candidate) => candidate.id === pageId)!
  const scene = entry.scenarios.find((candidate) => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${observation.instance}&scene=page-home`)
  await page.keyboard.press('F8')

  observation.navigating = true
  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('scene') === sceneId && url.searchParams.get('page') === pageId
  )
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('heading', { name: 'PDFE 工作台', exact: true })).toBeVisible()
  observation.navigating = false
}

async function showListing(page: Page): Promise<void> {
  await previewSurface(page).getByTestId('project-library').click()
  await previewSurface(page)
    .getByTestId('project-library-content')
    .getByRole('tab', { name: '资料', exact: true })
    .click()
  await expect(previewSurface(page).getByTestId('material-list')).toBeVisible()
}

async function showExplorer(page: Page): Promise<void> {
  await previewSurface(page).getByTestId('project-library').click()
  await previewSurface(page)
    .getByTestId('project-library-content')
    .getByRole('button', { name: '项目资源管理器', exact: true })
    .click()
  await expect(previewSurface(page).getByTestId('project-explorer')).toBeVisible()
}

function nextResponse(page: Page, source: Source, offset = 0) {
  return page.waitForResponse((response) => matches(page, response.request(), source, offset))
}

async function complete(response: Response, status = 200): Promise<void> {
  expect(await response.finished()).toBeNull()
  expect(response.status()).toBe(status)
}

async function recover(page: Page): Promise<void> {
  await page.keyboard.press('F8')
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === PREVIEW_BROWSING.recoveryPath &&
      response.request().method() === 'POST'
  )
  await page.getByTestId('preview-browsing-recover').click()
  await complete(await response)
  await page.keyboard.press('Escape')
}

function rootNodes(page: Page) {
  return previewSurface(page).getByTestId('project-explorer').locator('[data-testid^="explorer-node-"]')
}
function more(page: Page) {
  return previewSurface(page).getByTestId(`explorer-more-${ROOT_DIRECTORY}`)
}
function listingRetry(page: Page) {
  return previewSurface(page)
    .getByTestId('material-list')
    .getByRole('button', { name: '读取失败，点击重试', exact: true })
}
async function rootReady(page: Page): Promise<void> {
  await expect(previewSurface(page).getByTestId('explorer-directory-loading-/')).not.toBeVisible()
  await expect(rootNodes(page)).toHaveCount(PREVIEW_BROWSING.pageSize)
}
async function paginated(page: Page, response: Response): Promise<void> {
  await complete(response)
  const payload = (await response.json()) as {
    total: number
    offset: number
    nodes: { path: string }[]
  }
  expect(payload.offset).toBe(PREVIEW_BROWSING.pageSize)
  expect(payload.total).toBeGreaterThan(PREVIEW_BROWSING.pageSize)
  await expect(rootNodes(page)).toHaveCount(payload.total)
  const paths = await rootNodes(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-testid'))
  )
  expect(new Set(paths).size).toBe(paths.length)
  await expect(more(page)).not.toBeVisible()
}

test(
  'paged resources expose the same nested VFS files in Listing and Explorer without confusing no-match with empty',
  {
    annotation: [
      previewConsumption(LISTING_PAGE, 'browsing-paged', [
        'loaded',
        'nested',
        'filtered',
        'no-match',
        'opened',
      ]),
      previewConsumption(EXPLORER_PAGE, 'browsing-paged', [
        'loaded',
        'nested',
        'opened',
        'paginated',
      ]),
    ],
  },
  async ({ page }, testInfo) => {
    await launch(page, LISTING_PAGE, 'browsing-paged')
    const listed = nextResponse(page, 'listing')
    await showListing(page)
    await complete(await listed)
    const listing = previewSurface(page).getByTestId('material-list')
    await listing.getByTestId('material-preview-docs').getByRole('button', { name: 'preview-docs', exact: true }).click()
    await listing.getByTestId('material-preview-docs/nested').getByRole('button', { name: 'nested', exact: true }).click()
    for (const sample of PREVIEW_BROWSING.seed.nested)
      await expect(previewSurface(page).getByTestId(`material-${sample.path}`)).toBeVisible()
    const search = previewSurface(page).getByRole('searchbox', { name: '搜索文件', exact: true })
    if (!await search.isVisible())
      await previewSurface(page).getByTestId('project-library-content').getByRole('button', { name: '搜索文件', exact: true }).click()
    await expect(search).toBeVisible()
    await search.fill('overview.md')
    await expect(previewSurface(page).getByTestId(`material-${PREVIEW_BROWSING.seed.nested[0].path}`)).toBeVisible()
    await search.fill(NO_MATCH)
    await expect(listing.getByText('没有符合条件的文件', { exact: true })).toBeVisible()
    await expect(listing.getByText('暂无资料', { exact: true })).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath('browsing-listing-no-match.png'))
    await search.fill('')
    await previewSurface(page)
      .getByTestId(`material-${PREVIEW_BROWSING.seed.nested[0].path}`)
      .getByRole('button', { name: 'overview.md', exact: true })
      .click()
    await expect(previewSurface(page).getByRole('heading', { name: '模拟目录概览', exact: true })).toBeVisible()
    await previewSurface(page).getByTestId('project-library').click()
    await showExplorer(page)
    await rootReady(page)
    const next = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
    await more(page).click()
    await paginated(page, await next)
    await previewSurface(page)
      .getByTestId('explorer-node-preview-docs')
      .getByRole('button', { name: '展开 preview-docs', exact: true })
      .click()
    await expect(
      previewSurface(page).getByTestId(`explorer-node-${PREVIEW_BROWSING.seed.nested[0].path}`)
    ).toBeVisible()
    await previewSurface(page)
      .getByTestId('explorer-node-preview-docs/nested')
      .getByRole('button', { name: '展开 nested', exact: true })
      .click()
    await previewSurface(page).getByTestId(`explorer-select-${PREVIEW_BROWSING.seed.nested[1].path}`).click()
    await writeFile(testInfo.outputPath('browsing-explorer-selection-geometry.json'), JSON.stringify({
      renderer: await page.locator('#scholarseed-preview-viewport').boundingBox(),
      explorer: await previewSurface(page).getByTestId('project-explorer').boundingBox(),
      preview: await previewSurface(page).getByTestId('explorer-preview').boundingBox(),
    }, null, 2))
    await capturePreview(page, testInfo.outputPath('browsing-explorer-selection-before-toggle.png'))
    const document = previewSurface(page).getByRole('heading', { name: '模拟嵌套资料', exact: true })
    const originalDocument = await document.elementHandle()
    await previewSurface(page).getByTestId('explorer-toggle-tree').click()
    await expect(previewSurface(page).getByTestId('explorer-toggle-tree')).toHaveAttribute('aria-expanded', 'false')
    await expect(document).toBeVisible()
    expect(await document.evaluate((node, original) => node === original, originalDocument)).toBe(true)
    await previewSurface(page).getByTestId('explorer-toggle-tree').click()
    await expect(previewSurface(page).getByTestId(`explorer-select-${PREVIEW_BROWSING.seed.nested[1].path}`)).toBeVisible()
    await previewSurface(page).getByTestId('explorer-toggle-tree').click()
    await expect(document).toBeVisible()
    expect(await document.evaluate((node, original) => node === original, originalDocument)).toBe(true)
    await capturePreview(page, testInfo.outputPath('browsing-nested-shared-vfs.png'))
    await originalDocument!.dispose()
  }
)

test(
  'empty VFS produces both actual empty surfaces without a search filter',
  {
    annotation: [
      previewConsumption(LISTING_PAGE, 'browsing-empty', ['empty']),
      previewConsumption(EXPLORER_PAGE, 'browsing-empty', ['empty']),
    ],
  },
  async ({ page }, testInfo) => {
    await launch(page, LISTING_PAGE, 'browsing-empty')
    const listed = nextResponse(page, 'listing')
    await showListing(page)
    const response = await listed
    await complete(response)
    expect((await response.json()).items).toEqual([])
    await expect(
      previewSurface(page).getByTestId('material-list').getByText('暂无资料', { exact: true })
    ).toBeVisible()
    await capturePreview(page, testInfo.outputPath('browsing-listing-empty.png'))
    const tree = nextResponse(page, 'explorer')
    await showExplorer(page)
    const root = await tree
    await complete(root)
    expect(await root.json()).toMatchObject({ nodes: [], total: 0, offset: 0 })
    await expect(previewSurface(page).getByTestId('explorer-root').locator('[aria-expanded]')).toHaveAttribute('aria-expanded', 'true')
    await expect(rootNodes(page)).toHaveCount(0)
    await expect(previewSurface(page).getByTestId('explorer-directory-loading-/')).not.toBeVisible()
    await expect(previewSurface(page).getByTestId('explorer-directory-error-/')).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath('browsing-explorer-empty.png'))
  }
)

for (const source of ['listing', 'explorer'] as const) {
  const pageId = source === 'listing' ? LISTING_PAGE : EXPLORER_PAGE
  const show = source === 'listing' ? showListing : showExplorer
  const loading = (page: Page) =>
    source === 'listing'
      ? previewSurface(page)
          .getByTestId('material-list')
          .getByRole('region', { name: '资料', exact: true })
          .getByRole('status')
      : previewSurface(page).getByTestId('explorer-directory-loading-/')
  test(
    `${source} initial read is visibly pending and refetched on public reentry`,
    {
      annotation: previewConsumption(
        pageId,
        `browsing-${source === 'listing' ? 'listing' : 'explorer'}-pending`,
        ['loading', 'loaded', 'reentered']
      ),
    },
    async ({ page }, testInfo) => {
      await launch(page, pageId, `browsing-${source}-pending`)
      for (const phase of ['initial', 'reentered']) {
        const requested = page.waitForRequest((request) => matches(page, request, source))
        const response = nextResponse(page, source)
        await show(page)
        const request = await requested
        await expect(loading(page)).toBeVisible()
        expect(OBSERVATIONS.get(page)!.requests.get(request)?.bodyCompleteAt).toBeUndefined()
        await capturePreview(page, testInfo.outputPath(`browsing-${source}-${phase}-loading.png`))
        expect(OBSERVATIONS.get(page)!.requests.get(request)?.bodyCompleteAt).toBeUndefined()
        await complete(await response)
        await expect(loading(page)).not.toBeVisible()
        await expect(
          previewSurface(page).getByTestId(source === 'listing' ? 'material-readme.md' : 'explorer-node-readme.md')
        ).toBeVisible()
        await capturePreview(page, testInfo.outputPath(`browsing-${source}-${phase}-loaded.png`))
        if (phase === 'initial') {
          const close = previewSurface(page).getByRole('button', {
            name: source === 'listing' ? '关闭 项目文件' : '关闭 项目资源管理器',
            exact: true,
          })
          await previewSurface(page).getByRole('tab').filter({ has: close }).hover()
          await close.click()
        }
      }
    }
  )
  test(
    `${source} failure stays distinct from empty and recovers only through the declared control and original retry`,
    {
      annotation: previewConsumption(pageId, `browsing-${source}-failed`, [
        'error',
        'retry-failed',
        'recovered',
        'independent',
      ]),
    },
    async ({ page }, testInfo) => {
      OBSERVATIONS.get(page)!.allowed = [source === 'listing' ? LISTING_PATH : EXPLORER_PATH]
      await launch(page, pageId, `browsing-${source}-failed`)
      const failed = nextResponse(page, source)
      await show(page)
      await complete(await failed, FAILURE_STATUS)
      const retry =
        source === 'listing' ? listingRetry(page) : previewSurface(page).getByTestId('explorer-directory-retry-/')
      await expect(retry).toBeVisible()
      await capturePreview(page, testInfo.outputPath(`browsing-${source}-failed.png`))
      const failedAgain = nextResponse(page, source)
      await retry.click()
      await complete(await failedAgain, FAILURE_STATUS)
      await expect(retry).toBeVisible()
      if (source === 'listing') {
        await showExplorer(page)
        await expect(previewSurface(page).getByTestId('explorer-node-readme.md')).toBeVisible()
      } else {
        await showListing(page)
        await expect(previewSurface(page).getByTestId('material-readme.md')).toBeVisible()
      }
      await show(page)
      await expect(retry).toBeVisible()
      await recover(page)
      const recovered = nextResponse(page, source)
      await retry.click()
      await complete(await recovered)
      await expect(retry).not.toBeVisible()
      await expect(
        previewSurface(page).getByTestId(source === 'listing' ? 'material-readme.md' : 'explorer-node-readme.md')
      ).toBeVisible()
      await capturePreview(page, testInfo.outputPath(`browsing-${source}-recovered.png`))
    }
  )
}

test(
  'Explorer next page failure retains the first page and retries the identical offset',
  {
    annotation: previewConsumption(EXPLORER_PAGE, 'browsing-more-failed', [
      'loaded',
      'error',
      'retained',
      'retried',
      'paginated',
    ]),
  },
  async ({ page }, testInfo) => {
    OBSERVATIONS.get(page)!.allowed = [EXPLORER_PATH]
    await launch(page, EXPLORER_PAGE, 'browsing-more-failed')
    await showExplorer(page)
    await rootReady(page)
    const failed = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
    await more(page).click()
    await complete(await failed, FAILURE_STATUS)
    await expect(previewSurface(page).getByTestId('explorer-more-error-/')).toBeVisible()
    await expect(rootNodes(page)).toHaveCount(PREVIEW_BROWSING.pageSize)
    await capturePreview(page, testInfo.outputPath('browsing-more-failed-retained.png'))
    const retry = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
    await more(page).click()
    await paginated(page, await retry)
    await expect(previewSurface(page).getByTestId('explorer-more-error-/')).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath('browsing-more-retried.png'))
  }
)

for (const action of ['complete', 'refresh', 'remount'] as const) {
  const states =
    action === 'complete'
      ? ['loaded', 'loading', 'paginated', 'retained']
      : [
          'loaded',
          'loading',
          'retained',
          'superseded',
          action === 'refresh' ? 'refreshed' : 'remounted',
        ]
  test(
    `Explorer pending next page ${action} keeps generation boundaries and no duplicated nodes`,
    { annotation: previewConsumption(EXPLORER_PAGE, 'browsing-more-pending', states) },
    async ({ page }, testInfo) => {
      await launch(page, EXPLORER_PAGE, 'browsing-more-pending')
      await showExplorer(page)
      await rootReady(page)
      const requested = page.waitForRequest((request) =>
        matches(page, request, 'explorer', PREVIEW_BROWSING.pageSize)
      )
      const response = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
      await more(page).click()
      const request = await requested
      await expect(more(page)).toBeDisabled()
      await expect(rootNodes(page)).toHaveCount(PREVIEW_BROWSING.pageSize)
      expect(OBSERVATIONS.get(page)!.requests.get(request)?.bodyCompleteAt).toBeUndefined()
      await capturePreview(page, testInfo.outputPath(`browsing-more-${action}-pending.png`))
      expect(OBSERVATIONS.get(page)!.requests.get(request)?.bodyCompleteAt).toBeUndefined()
      if (action !== 'complete') {
        const current = nextResponse(page, 'explorer')
        if (action === 'refresh') await previewSurface(page).getByTestId('explorer-refresh').click()
        else {
          await previewSurface(page)
            .getByTestId('explorer-root')
            .getByRole('button', { name: '收起 设计协作项目', exact: true })
            .click()
          await previewSurface(page)
            .getByTestId('explorer-root')
            .getByRole('button', { name: '展开 设计协作项目', exact: true })
            .click()
        }
        await complete(await current)
        await rootReady(page)
        await complete(await response)
        await capturePreview(
          page,
          testInfo.outputPath(`browsing-more-${action}-old-body-finished.png`)
        )
        await expect(rootNodes(page)).toHaveCount(PREVIEW_BROWSING.pageSize)
        await expect(more(page)).toBeEnabled()
        const next = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
        await more(page).click()
        await paginated(page, await next)
      } else await paginated(page, await response)
      await capturePreview(page, testInfo.outputPath(`browsing-more-${action}-completed.png`))
    }
  )
}

test(
  'Explorer next page failure supports keyboard retry in dark English at the minimum window',
  {
    annotation: previewConsumption(EXPLORER_PAGE, 'browsing-more-failed', [
      'loaded',
      'error',
      'retained',
      'retried',
      'paginated',
    ]),
  },
  async ({ page }, testInfo) => {
    const observation = OBSERVATIONS.get(page)!
    observation.allowed = [EXPLORER_PATH]
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await launch(page, EXPLORER_PAGE, 'browsing-more-failed')
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
    await previewSurface(page).getByTestId('project-library').click()
    await previewSurface(page)
      .getByTestId('project-library-content')
      .getByRole('button', { name: 'Project explorer', exact: true })
      .click()
    await rootReady(page)
    const failed = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
    await more(page).click()
    await complete(await failed, FAILURE_STATUS)
    await expect(previewSurface(page).getByTestId('explorer-more-error-/')).toBeVisible()
    await expect(rootNodes(page)).toHaveCount(PREVIEW_BROWSING.pageSize)
    await more(page).scrollIntoViewIfNeeded()
    await more(page).focus()
    await expect(more(page)).toBeFocused()
    const box = await more(page).boundingBox()
    await writeFile(
      testInfo.outputPath('browsing-dark-narrow-geometry.json'),
      JSON.stringify({ viewport: WORKSPACE_WINDOW_MINIMUM, retry: box }, null, 2)
    )
    await capturePreview(page, testInfo.outputPath('browsing-dark-narrow-error.png'))
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.height)
    const retried = nextResponse(page, 'explorer', PREVIEW_BROWSING.pageSize)
    await page.keyboard.press('Enter')
    await paginated(page, await retried)
    await expect(previewSurface(page).getByTestId('explorer-more-error-/')).not.toBeVisible()
    await capturePreview(page, testInfo.outputPath('browsing-dark-narrow-recovered.png'))
  }
)
