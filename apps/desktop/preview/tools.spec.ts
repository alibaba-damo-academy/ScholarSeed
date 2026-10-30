import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { CDPSession } from '@playwright/test'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Request, type Response, type TestInfo } from './testing'
import type { HistoryResult, OpenResp, ProductEvent } from '../src/renderer/src/api'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import componentsZh from '../src/localization/locales/zh/components.json'
import componentsEn from '../src/localization/locales/en/components.json'
import conversationZh from '../src/localization/locales/zh/conversation.json'
import conversationEn from '../src/localization/locales/en/conversation.json'
import { PREVIEW_CATALOG } from './catalog'
import { PREVIEW_CONVERSATION } from './conversation'
import { PREVIEW_ORIGIN, PREVIEW_PROJECT_ID } from './constants'
import { capturePreview } from './capture'
import { previewConsumption } from './coverage'

const PAGE_ID = 'page-conversation'
const SESSION_ROUTE = /^\/api\/serve\/sessions\/([^/]+)\/(events|turns|interrupt|hil\/[^/]+)$/
const OFFICE_ASSETS = ['/office/zeta-20250513/soffice.wasm', '/office/zeta-20250513/soffice.data']
const ANSWER = '.answer-annotation-root'
type Http = {
  method: string
  path: string
  query: string
  referer: string | null
  owned: boolean
  requestedAt: number
  timing: ReturnType<Request['timing']>
  input?: unknown
  status?: number
  headersAt?: number
  bodyCompleteAt?: number
  completedTiming?: ReturnType<Request['timing']>
  abortedAt?: number
  body?: unknown
  error?: string
}
type Stream = {
  requestId: string
  sessionId: string
  fromSeq: number
  referer: string | null
  owned: boolean
}
type Wire = Stream & {
  eventName: string
  eventId: string
  data: string
  timestamp: number
  event?: ProductEvent
}
type Failure = {
  path: string
  query: string
  method: string
  error: string | null
  resourceType: string
  referer: string | null
  status: number | null
  contentType: string | null
  duringNavigation: boolean
}
type Observation = {
  instance: string
  scene: string
  navigating: boolean
  sessionId?: string
  http: Map<Request, Http>
  headers: Map<Request, { status: number; contentType: string }>
  streams: Map<string, Stream>
  wire: Wire[]
  rawFailures: Failure[]
  expectedOfficeAborts: Failure[]
  expectedStreamCloses: Failure[]
  expectedFinalizationAborts: Failure[]
  externalOrigins: string[]
  pageErrors: string[]
  collecting: Promise<void>[]
  snapshots: { stage: string; history: HistoryResult; snapshot: OpenResp }[]
  cdp: CDPSession
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

function reference(input: string | undefined): URL | null {
  try {
    return new URL(input ?? '')
  } catch {
    return null
  }
}
function owned(page: Page, ref: URL | null): boolean {
  const observation = OBSERVATIONS.get(page)!
  return (
    ref?.origin === PREVIEW_ORIGIN &&
    ref.searchParams.get('previewInstance') === observation.instance &&
    ref.searchParams.get('scene') === observation.scene
  )
}
function action(page: Page, request: Request, kind: string): boolean {
  const url = new URL(request.url())
  const match = url.pathname.match(SESSION_ROUTE)
  return (
    url.origin === PREVIEW_ORIGIN &&
    request.method() === 'POST' &&
    match?.[2] === kind &&
    owned(page, reference(request.headers().referer))
  )
}
function responseFor(page: Page, kind: string): Promise<Response> {
  return page.waitForResponse((response) => action(page, response.request(), kind))
}
async function receipt(response: Response): Promise<{ sessionId: string; turnId: string }> {
  expect(await response.finished()).toBeNull()
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    ok: boolean
    accepted: boolean
    disposition: string
    turn_id: string
  }
  expect(body).toMatchObject({ ok: true, accepted: true, disposition: 'direct' })
  expect(body.turn_id).toBeTruthy()
  return {
    sessionId: decodeURIComponent(new URL(response.url()).pathname.match(SESSION_ROUTE)![1]),
    turnId: body.turn_id,
  }
}

test.beforeEach(async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  const observation: Observation = {
    instance: randomUUID(),
    scene: '',
    navigating: false,
    http: new Map(),
    headers: new Map(),
    streams: new Map(),
    wire: [],
    rawFailures: [],
    expectedOfficeAborts: [],
    expectedStreamCloses: [],
    expectedFinalizationAborts: [],
    externalOrigins: [],
    pageErrors: [],
    collecting: [],
    snapshots: [],
    cdp,
  }
  OBSERVATIONS.set(page, observation)
  cdp.on('Network.requestWillBeSent', (entry) => {
    const url = new URL(entry.request.url)
    const match = url.pathname.match(SESSION_ROUTE)
    if (url.origin !== PREVIEW_ORIGIN || match?.[2] !== 'events') return
    const ref = Object.entries(entry.request.headers).find(
      ([name]) => name.toLowerCase() === 'referer'
    )?.[1]
    observation.streams.set(entry.requestId, {
      requestId: entry.requestId,
      sessionId: decodeURIComponent(match[1]),
      fromSeq: Number(url.searchParams.get('from_seq')),
      referer: typeof ref === 'string' ? ref : null,
      owned: owned(page, reference(typeof ref === 'string' ? ref : undefined)),
    })
  })
  cdp.on('Network.eventSourceMessageReceived', (message) => {
    const stream = observation.streams.get(message.requestId)
    if (!stream) {
      observation.pageErrors.push('unattributed-eventsource-message')
      return
    }
    let event: ProductEvent | undefined
    if (message.eventName !== 'heartbeat') {
      try {
        event = JSON.parse(message.data) as ProductEvent
      } catch {
        observation.pageErrors.push('invalid-product-event-json')
      }
    }
    observation.wire.push({
      ...stream,
      eventName: message.eventName,
      eventId: message.eventId,
      data: message.data,
      timestamp: message.timestamp,
      ...(event ? { event } : {}),
    })
  })
  await cdp.send('Network.enable')
  page.on('pageerror', (error) => observation.pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin !== PREVIEW_ORIGIN &&
      !observation.externalOrigins.includes(url.origin)
    )
      observation.externalOrigins.push(url.origin)
    if (url.origin !== PREVIEW_ORIGIN || !url.pathname.startsWith('/api/')) return
    let input: unknown
    if (request.postData()) {
      try {
        input = request.postDataJSON()
      } catch {
        input = request.postData()
      }
    }
    observation.http.set(request, {
      method: request.method(),
      path: url.pathname,
      query: url.search,
      referer: request.headers().referer ?? null,
      owned: owned(page, reference(request.headers().referer)),
      requestedAt: Date.now(),
      timing: request.timing(),
      ...(input === undefined ? {} : { input }),
    })
  })
  page.on('response', (response) => {
    const request = response.request()
    observation.headers.set(request, {
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    })
    const entry = observation.http.get(request)
    if (!entry) return
    entry.status = response.status()
    entry.headersAt = Date.now()
    if (entry.path.startsWith('/api/serve/') && !entry.path.endsWith('/events'))
      observation.collecting.push(
        response
          .json()
          .then((body) => {
            entry.body = body
          })
          .catch((error: Error) => {
            entry.error = error.message
          })
      )
  })
  page.on('requestfinished', (request) => {
    const entry = observation.http.get(request)
    if (entry) {
      entry.bodyCompleteAt = Date.now()
      entry.completedTiming = request.timing()
    }
  })
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    const header = observation.headers.get(request)
    const failure: Failure = {
      path: url.pathname,
      query: url.search,
      method: request.method(),
      error: request.failure()?.errorText ?? null,
      resourceType: request.resourceType(),
      referer: request.headers().referer ?? null,
      status: header?.status ?? null,
      contentType: header?.contentType ?? null,
      duringNavigation: observation.navigating,
    }
    observation.rawFailures.push(failure)
    const entry = observation.http.get(request)
    if (entry) entry.abortedAt = Date.now()
    if (
      url.origin === PREVIEW_ORIGIN &&
      observation.navigating &&
      OFFICE_ASSETS.includes(url.pathname) &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedOfficeAborts.push(failure)
    const sessionStream = url.pathname.match(SESSION_ROUTE)?.[2] === 'events'
    const contentStream =
      url.pathname === '/api/content/events' &&
      url.searchParams.get('project') === PREVIEW_PROJECT_ID
    if (
      url.origin === PREVIEW_ORIGIN &&
      (sessionStream || contentStream) &&
      request.method() === 'GET' &&
      request.resourceType() === 'eventsource' &&
      owned(page, reference(request.headers().referer)) &&
      header?.status === 200 &&
      header.contentType.split(';')[0] === 'text/event-stream' &&
      failure.error === 'net::ERR_ABORTED'
    )
      observation.expectedStreamCloses.push(failure)
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const current = OBSERVATIONS.get(page)!
  current.expectedFinalizationAborts = current.rawFailures.filter((failure) => {
    const query = new URLSearchParams(failure.query)
    return (
      failure.duringNavigation &&
      failure.path === '/api/resource/finalizations' &&
      query.get('project') === PREVIEW_PROJECT_ID &&
      query.get('session_id') === current.sessionId &&
      failure.method === 'GET' &&
      failure.resourceType === 'fetch' &&
      owned(page, reference(failure.referer ?? undefined)) &&
      failure.error === 'net::ERR_ABORTED' &&
      (failure.status === null ||
        (failure.status === 200 && failure.contentType?.split(';')[0] === 'application/json'))
    )
  })
  const { http, headers, streams, cdp, collecting, ...observation } = OBSERVATIONS.get(page)!
  await Promise.all(collecting)
  await cdp.detach()
  const path = testInfo.outputPath('tools-http-sse-summary.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        ...observation,
        http: [...http.values()],
        streams: [...streams.values()],
        headers: [...headers.values()],
      },
      null,
      2
    )
  )
  await testInfo.attach('tools-http-sse-summary', { path, contentType: 'application/json' })
  expect(observation.pageErrors).toEqual([])
  expect(observation.externalOrigins).toEqual([])
  expect(
    observation.rawFailures.filter(
      (failure) =>
        !observation.expectedOfficeAborts.includes(failure) &&
        !observation.expectedStreamCloses.includes(failure) &&
        !observation.expectedFinalizationAborts.includes(failure)
    )
  ).toEqual([])
  for (const entry of http.values()) {
    if (entry.status !== undefined) expect(entry.status).toBeLessThan(400)
    expect(entry.error).toBeUndefined()
    if (entry.method === 'GET') continue
    expect(entry.owned).toBe(true)
    if (entry.path === '/api/serve/sessions/open') {
      expect(entry.input).toMatchObject({ resume_session_id: observation.sessionId })
      continue
    }
    const route = entry.path.match(SESSION_ROUTE)
    expect(route).not.toBeNull()
    expect(decodeURIComponent(route![1])).toBe(observation.sessionId)
    expect(route![2] === 'turns' || route![2] === 'interrupt' || route![2].startsWith('hil/')).toBe(
      true
    )
    expect(entry.bodyCompleteAt).toBeDefined()
  }
  for (const stream of streams.values()) {
    if (!stream.owned) continue
    const events = observation.wire
      .filter((message) => message.requestId === stream.requestId && message.event)
      .map((message) => message.event!)
    for (const [index, event] of events.entries()) {
      expect(event.session_id).toBe(stream.sessionId)
      expect(event.seq).toBeGreaterThan(index ? events[index - 1].seq : stream.fromSeq)
    }
  }
})

async function openScene(page: Page, sceneId: string): Promise<void> {
  const observation = OBSERVATIONS.get(page)!
  observation.scene = sceneId
  const entry = PREVIEW_CATALOG.find((candidate) => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find((candidate) => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${observation.instance}&scene=page-home`)
  await page.keyboard.press('F8')

  observation.navigating = true
  await openPreviewScenario(page, entry.id, scene.id, true)
  await expect(page).toHaveURL((url) => url.searchParams.get('scene') === sceneId)
  await page.waitForLoadState('domcontentloaded')
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
  await expect
    .poll(
      () =>
        [...observation.http.values()].filter(
          (entry) => entry.path === '/api/serve/sessions/open' && entry.body
        ).length
    )
    .toBeGreaterThan(0)
  observation.sessionId = (
    [...observation.http.values()]
      .filter((entry) => entry.path === '/api/serve/sessions/open' && entry.owned)
      .at(-1)!.body as OpenResp
  ).session_id
  await settledFinalizations(page)
  observation.navigating = false
}
async function settledFinalizations(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        [...OBSERVATIONS.get(page)!.http.values()].filter(
          (entry) =>
            entry.owned &&
            entry.path === '/api/resource/finalizations' &&
            entry.bodyCompleteAt === undefined &&
            entry.abortedAt === undefined
        ).length
    )
    .toBe(0)
}
async function send(page: Page, question: string): Promise<{ sessionId: string; turnId: string }> {
  await previewSurface(page).getByTestId('composer-input').fill(question)
  await expect(previewSurface(page).getByTestId('composer-send')).toBeEnabled()
  const response = responseFor(page, 'turns')
  await previewSurface(page).getByTestId('composer-send').click()
  return receipt(await response)
}
async function inspect(
  page: Page,
  stage: string
): Promise<{ history: HistoryResult; snapshot: OpenResp }> {
  const observation = OBSERVATIONS.get(page)!
  const query = `?previewInstance=${encodeURIComponent(observation.instance)}`
  const history = await page.request.get(
    `${PREVIEW_ORIGIN}/api/serve/history/${encodeURIComponent(observation.sessionId!)}${query}`
  )
  const snapshot = await page.request.get(
    `${PREVIEW_ORIGIN}/api/serve/sessions/${encodeURIComponent(observation.sessionId!)}/navigation${query}`
  )
  expect(history.status()).toBe(200)
  expect(snapshot.status()).toBe(200)
  const result = {
    history: (await history.json()) as HistoryResult,
    snapshot: (await snapshot.json()) as OpenResp,
  }
  observation.snapshots.push({ stage, ...result })
  return result
}
function wireEvents(page: Page, turnId: string): ProductEvent[] {
  return OBSERVATIONS.get(page)!
    .wire.filter((message) => message.owned && message.event?.turn_id === turnId)
    .map((message) => message.event!)
}
async function toolCard(page: Page) {
  const activity = previewSurface(page).getByTestId('turn-activity-trigger')
  await expect(activity).toBeVisible()
  if ((await activity.getAttribute('aria-expanded')) !== 'true') await activity.click()
  const tool = previewSurface(page).getByTestId('tool-run-step')
  await expect(tool).toHaveCount(1)
  const trigger = tool.getByRole('button').first()
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  return tool
}
async function runningTool(
  page: Page,
  turnId: string,
  label = componentsZh.stream.toolStatus.running
) {
  const tool = await toolCard(page)
  await expect(tool.getByRole('button').first()).toContainText(label)
  await expect(tool.locator('[aria-hidden="false"]')).toContainText(
    PREVIEW_CONVERSATION.toolInput.path
  )
  await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
  expect(wireEvents(page, turnId).some((event) => event.type === 'tool_started')).toBe(true)
  expect(wireEvents(page, turnId).some((event) => event.type === 'tool_completed')).toBe(false)
  return tool
}
async function pendingTool(
  page: Page,
  turnId: string,
  output: string | null,
  stage: string
): Promise<string> {
  const { history, snapshot } = await inspect(page, stage)
  expect(snapshot).toMatchObject({ active_turn_id: turnId, running: true })
  const tools = history.turns.filter((turn) => turn.kind === 'tool' && turn.turn_id === turnId)
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({
    tool: PREVIEW_CONVERSATION.toolName,
    input: PREVIEW_CONVERSATION.toolInput,
    status: 'pending',
    output,
  })
  expect(tools[0].item_id).toBeTruthy()
  const events = history.activity_events.filter((event) => event.turn_id === turnId)
  const started = events.filter((event) => event.type === 'tool_started')
  expect(started).toHaveLength(1)
  expect(started[0]).toMatchObject({
    item_id: tools[0].item_id,
    data: { tool_id: tools[0].item_id },
  })
  expect(
    events.filter((event) =>
      ['tool_completed', 'turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)
    )
  ).toEqual([])
  expect(history.turn_activity.find((turn) => turn.turn_id === turnId)?.outcome).toBeUndefined()
  return tools[0].item_id!
}
function assertToolHistory(
  history: HistoryResult,
  turnId: string,
  outcome: 'done' | 'error' | 'cancelled',
  output: string,
  itemId?: string
): void {
  const tools = history.turns.filter((turn) => turn.turn_id === turnId && turn.kind === 'tool')
  expect(tools).toHaveLength(1)
  if (itemId !== undefined) expect(tools[0].item_id).toBe(itemId)
  expect(tools[0]).toMatchObject({
    tool: PREVIEW_CONVERSATION.toolName,
    input: PREVIEW_CONVERSATION.toolInput,
    output,
    status: outcome,
  })
  const events = history.activity_events.filter((event) => event.turn_id === turnId)
  const started = events.filter((event) => event.type === 'tool_started')
  expect(started).toHaveLength(1)
  expect(started[0].item_id).toBe(tools[0].item_id)
  if (started[0].type !== 'tool_started') throw new Error('Missing tool start')
  expect(started[0].data.tool_id).toBe(tools[0].item_id)
  const terminal = events.filter((event) => event.type === 'tool_completed')
  if (outcome === 'cancelled') expect(terminal).toEqual([])
  else {
    expect(terminal).toHaveLength(1)
    expect(terminal[0].data).toMatchObject({
      tool_id: tools[0].item_id,
      success: outcome === 'done',
      output,
    })
  }
  const turnTerminal = events.filter((event) =>
    ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)
  )
  expect(turnTerminal).toHaveLength(1)
  expect(turnTerminal[0].type).toBe(outcome === 'cancelled' ? 'turn_interrupted' : 'turn_completed')
  expect(history.turn_activity.find((turn) => turn.turn_id === turnId)?.outcome).toBe(
    outcome === 'cancelled' ? 'interrupted' : 'completed'
  )
  expect(
    events.filter(
      (event) =>
        event.seq > turnTerminal[0].seq &&
        ['tool_output_delta', 'tool_completed', 'message_delta'].includes(event.type)
    )
  ).toEqual([])
}
async function reenter(page: Page, question: string): Promise<void> {
  OBSERVATIONS.get(page)!.navigating = true
  const home = previewSurface(page).getByRole('button', { name: '返回首页', exact: true })
  if (await home.isVisible()) await home.click()
  else await previewSurface(page).getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId('project-center')).toBeVisible()
  await previewSurface(page).getByTestId('home-task-preview-session').click()
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  await settledFinalizations(page)
  OBSERVATIONS.get(page)!.navigating = false
}
async function completed(page: Page, answer: string): Promise<void> {
  await expect(previewSurface(page).locator(ANSWER).filter({ hasText: answer })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
}

test(
  'Composer submission stays busy before admission and repeated Enter cannot submit a second turn',
  {
    annotation: previewConsumption(PAGE_ID, 'conversation-submit-pending', [
      'submitting',
      'completed',
    ]),
  },
  async ({ page }, testInfo) => {
    await openScene(page, 'conversation-submit-pending')
    const before = await inspect(page, 'submission-before')
    const question = `受审提交-${randomUUID()}`
    await previewSurface(page).getByTestId('composer-input').fill(question)
    const requested = page.waitForRequest((request) => action(page, request, 'turns'))
    const response = responseFor(page, 'turns')
    await previewSurface(page).getByTestId('composer-send').click()
    const request = await requested
    const button = previewSurface(page).getByTestId('composer-send')
    await expect(button).toHaveAttribute('data-state', 'submitting')
    await expect(button).toHaveAttribute('aria-busy', 'true')
    await expect(button).toBeDisabled()
    await previewSurface(page).getByTestId('composer-input').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    expect(OBSERVATIONS.get(page)!.http.get(request)?.headersAt).toBeUndefined()
    const pending = await inspect(page, 'submission-before-admission')
    expect(pending.snapshot).toMatchObject({ active_turn_id: null, running: false })
    expect(pending.history.turns).toEqual(before.history.turns)
    expect(pending.history.turn_activity).toEqual(before.history.turn_activity)
    expect(pending.history.activity_events).toEqual(before.history.activity_events)
    expect(
      pending.history.turns.some((item) => item.role === 'user' && item.text === question)
    ).toBe(false)
    await capturePreview(page, testInfo.outputPath('composer-submitting.png'))
    expect(OBSERVATIONS.get(page)!.http.get(request)?.headersAt).toBeUndefined()
    const turn = await receipt(await response)
    await completed(page, '这里复用真实产品组件与事件投影。')
    const { history, snapshot } = await inspect(page, 'submission-completed')
    expect(
      history.turns.filter((item) => item.turn_id === turn.turnId && item.role === 'user')
    ).toHaveLength(1)
    expect(snapshot.active_turn_id).toBeNull()
    expect(
      [...OBSERVATIONS.get(page)!.http.keys()].filter((request) => action(page, request, 'turns'))
    ).toHaveLength(1)
    await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(
      1
    )
    await capturePreview(page, testInfo.outputPath('composer-admitted-completed.png'))
  }
)

for (const failed of [false, true])
  test(
    `tool ${failed ? 'failure' : 'success'} exposes live input and output and restores one consistent completed history`,
    {
      annotation: previewConsumption(
        PAGE_ID,
        failed ? 'conversation-tool-failed' : 'conversation-tool-running',
        failed
          ? ['running', 'failed', 'completed', 'reentered']
          : ['running', 'completed', 'reentered']
      ),
    },
    async ({ page }, testInfo) => {
      await openScene(page, failed ? 'conversation-tool-failed' : 'conversation-tool-running')
      const question = `受审工具-${randomUUID()}`
      const turn = await send(page, question)
      const tool = await runningTool(page, turn.turnId)
      await capturePreview(page, testInfo.outputPath('tool-running-input.png'))
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(
        (failed
          ? PREVIEW_CONVERSATION.toolFailedOutputChunks
          : PREVIEW_CONVERSATION.toolOutputChunks)[0]
      )
      await expect(tool.getByRole('button').first()).toContainText(
        componentsZh.stream.toolStatus.running
      )
      const chunks = failed
        ? PREVIEW_CONVERSATION.toolFailedOutputChunks
        : PREVIEW_CONVERSATION.toolOutputChunks
      const itemId = await pendingTool(page, turn.turnId, chunks[0], 'tool-running-partial')
      expect(
        wireEvents(page, turn.turnId)
          .filter((event) => event.type === 'tool_output_delta')
          .map((event) => event.data.delta)
      ).toEqual([chunks[0]])
      await capturePreview(page, testInfo.outputPath('tool-running-partial.png'))
      await completed(
        page,
        failed ? PREVIEW_CONVERSATION.toolFailureAnswer : PREVIEW_CONVERSATION.toolSuccessAnswer
      )
      await toolCard(page)
      if (failed) {
        await expect(tool.getByRole('button').first()).toContainText(
          componentsZh.stream.toolStatus.error
        )
        await tool
          .getByRole('button', { name: conversationZh.toolOutcome.technicalDetails, exact: true })
          .click()
      }
      const output = failed
        ? PREVIEW_CONVERSATION.toolFailedOutput
        : PREVIEW_CONVERSATION.toolOutput
      await expect(tool.locator('[aria-hidden="false"]')).toContainText(output)
      const { history, snapshot } = await inspect(page, 'tool-completed')
      assertToolHistory(history, turn.turnId, failed ? 'error' : 'done', output, itemId)
      expect(snapshot.active_turn_id).toBeNull()
      expect(snapshot.running).toBe(false)
      const live = wireEvents(page, turn.turnId)
      expect(
        live.filter((event) => event.type === 'tool_output_delta').map((event) => event.data.delta)
      ).toEqual([
        ...(failed
          ? PREVIEW_CONVERSATION.toolFailedOutputChunks
          : PREVIEW_CONVERSATION.toolOutputChunks),
      ])
      expect(live.filter((event) => event.type === 'tool_completed')).toHaveLength(1)
      await capturePreview(page, testInfo.outputPath('tool-terminal-expanded.png'))
      await reenter(page, question)
      const restored = await toolCard(page)
      if (failed)
        await restored
          .getByRole('button', { name: conversationZh.toolOutcome.technicalDetails, exact: true })
          .click()
      await expect(restored.locator('[aria-hidden="false"]')).toContainText(output)
      assertToolHistory(
        (await inspect(page, 'tool-reentered')).history,
        turn.turnId,
        failed ? 'error' : 'done',
        output,
        itemId
      )
      await capturePreview(page, testInfo.outputPath('tool-history-reentered.png'))
    }
  )

test(
  'Stop during the first live tool delta preserves a cancelled prefix without a later completion',
  {
    annotation: previewConsumption(PAGE_ID, 'conversation-tool-running', [
      'running',
      'cancelled',
      'reentered',
    ]),
  },
  async ({ page }, testInfo) => {
    await openScene(page, 'conversation-tool-running')
    const question = `受审取消工具-${randomUUID()}`
    const turn = await send(page, question)
    const tool = await runningTool(page, turn.turnId)
    const prefix = PREVIEW_CONVERSATION.toolOutputChunks[0]
    await expect(tool.locator('[aria-hidden="false"]')).toContainText(prefix)
    await expect(tool.getByRole('button').first()).toContainText(
      componentsZh.stream.toolStatus.running
    )
    const itemId = await pendingTool(page, turn.turnId, prefix, 'tool-before-stop')
    await page.screenshot({ path: testInfo.outputPath('tool-before-stop.png') })
    const stopping = responseFor(page, 'interrupt')
    await previewSurface(page).getByTestId('composer-stop').click()
    expect((await stopping).status()).toBe(200)
    await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
    const cancelled = await toolCard(page)
    await expect(cancelled.getByRole('button').first()).toContainText(
      componentsZh.stream.toolStatus.cancelled
    )
    await reenter(page, question)
    const restored = await toolCard(page)
    await expect(restored.locator('[aria-hidden="false"]')).toContainText(prefix)
    await expect(
      previewSurface(page).locator(ANSWER).filter({ hasText: PREVIEW_CONVERSATION.toolSuccessAnswer })
    ).toHaveCount(0)
    const { history, snapshot } = await inspect(page, 'tool-cancelled-reentered')
    assertToolHistory(history, turn.turnId, 'cancelled', prefix, itemId)
    expect(snapshot.active_turn_id).toBeNull()
    expect(wireEvents(page, turn.turnId).some((event) => event.type === 'tool_completed')).toBe(
      false
    )
    await capturePreview(page, testInfo.outputPath('tool-cancelled-reentered.png'))
  }
)

test(
  'Allow resumes the original HIL request and turn before one completion without another submission',
  {
    annotation: previewConsumption(PAGE_ID, 'conversation-approval-resume', [
      'waiting',
      'approved',
      'resumed',
      'completed',
    ]),
  },
  async ({ page }, testInfo) => {
    await openScene(page, 'conversation-approval-resume')
    const question = `受审同回合审批-${randomUUID()}`
    const turn = await send(page, question)
    await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toBeVisible()
    const waiting = await inspect(page, 'hil-waiting')
    expect(waiting.snapshot.active_turn_id).toBe(turn.turnId)
    expect(waiting.snapshot.pending_hil).toHaveLength(1)
    const requestId = waiting.snapshot.pending_hil![0].request_id
    await reenter(page, question)
    await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).toHaveCount(1)
    expect((await inspect(page, 'hil-waiting-reentered')).snapshot.pending_hil![0].request_id).toBe(
      requestId
    )
    await capturePreview(page, testInfo.outputPath('hil-waiting-reentered.png'))
    const allowing = responseFor(page, `hil/${requestId}`)
    await previewSurface(page).locator('[data-hil-decision="allow-once"]').click()
    const response = await allowing
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      request_id: requestId,
      interaction: {
        request_id: requestId,
        turn_id: turn.turnId,
        session_id: turn.sessionId,
        state: 'resolved',
        decision: 'allow_once',
      },
    })
    await expect(previewSurface(page).locator('[data-hil-decision="allow-once"]')).not.toBeVisible()
    await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
    await expect(
      previewSurface(page).locator(ANSWER).filter({ hasText: PREVIEW_CONVERSATION.approvalAnswer })
    ).toHaveCount(0)
    const resumed = await inspect(page, 'hil-resumed')
    expect(resumed.snapshot).toMatchObject({
      active_turn_id: turn.turnId,
      running: true,
      pending_hil: [],
    })
    expect(
      resumed.history.activity_events.filter(
        (event) =>
          event.turn_id === turn.turnId &&
          ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)
      )
    ).toEqual([])
    expect(
      wireEvents(page, turn.turnId).some(
        (event) =>
          event.type === 'session_state' &&
          event.data.state === 'running' &&
          event.seq > waiting.snapshot.last_seq!
      )
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('hil-resumed-same-turn.png') })
    await completed(page, PREVIEW_CONVERSATION.approvalAnswer)
    await reenter(page, question)
    const final = await inspect(page, 'hil-completed-reentered')
    expect(final.snapshot).toMatchObject({
      active_turn_id: null,
      running: false,
      pending_hil: [],
      last_turn_id: turn.turnId,
    })
    expect(
      final.history.activity_events.filter(
        (event) => event.turn_id === turn.turnId && event.type === 'turn_completed'
      )
    ).toHaveLength(1)
    expect(
      final.history.activity_events.filter(
        (event) => event.turn_id === turn.turnId && event.type === 'hil_requested'
      )
    ).toHaveLength(1)
    expect(
      final.history.activity_events.filter(
        (event) => event.turn_id === turn.turnId && event.type === 'hil_resolved'
      )
    ).toHaveLength(1)
    expect(
      [...OBSERVATIONS.get(page)!.http.keys()].filter((request) => action(page, request, 'turns'))
    ).toHaveLength(1)
    await capturePreview(page, testInfo.outputPath('hil-completed-history.png'))
  }
)

test(
  'tool failure expands through focused Enter in dark English at the minimum window',
  {
    annotation: previewConsumption(PAGE_ID, 'conversation-tool-failed', [
      'running',
      'failed',
      'completed',
    ]),
  },
  async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await openScene(page, 'conversation-tool-failed')
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
    await settledFinalizations(page)
    OBSERVATIONS.get(page)!.navigating = false
    const turn = await send(page, `受审英文工具-${randomUUID()}`)
    const running = await runningTool(page, turn.turnId, componentsEn.stream.toolStatus.running)
    await expect(running.locator('[aria-hidden="false"]')).toContainText(
      PREVIEW_CONVERSATION.toolFailedOutputChunks[0]
    )
    await expect(running.getByRole('button').first()).toContainText(
      componentsEn.stream.toolStatus.running
    )
    const itemId = await pendingTool(
      page,
      turn.turnId,
      PREVIEW_CONVERSATION.toolFailedOutputChunks[0],
      'dark-tool-partial'
    )
    await page.screenshot({ path: testInfo.outputPath('tool-dark-narrow-running.png') })
    await completed(page, PREVIEW_CONVERSATION.toolFailureAnswer)
    const activity = previewSurface(page).getByTestId('turn-activity-trigger')
    if ((await activity.getAttribute('aria-expanded')) !== 'true') await activity.click()
    const tool = previewSurface(page).getByTestId('tool-run-step')
    const toggle = tool.getByRole('button').first()
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
    await toggle.scrollIntoViewIfNeeded()
    await toggle.focus()
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const details = tool.getByRole('button', {
      name: conversationEn.toolOutcome.technicalDetails,
      exact: true,
    })
    await details.scrollIntoViewIfNeeded()
    await details.focus()
    await expect(details).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    await expect(tool.locator('[aria-hidden="false"]')).toContainText(
      PREVIEW_CONVERSATION.toolFailedOutput
    )
    const geometry = await details.boundingBox()
    await writeFile(
      testInfo.outputPath('tool-keyboard-geometry.json'),
      JSON.stringify(
        {
          viewport: WORKSPACE_WINDOW_MINIMUM,
          details: geometry,
          method: 'focus+Enter, not Tab traversal',
        },
        null,
        2
      )
    )
    await capturePreview(page, testInfo.outputPath('tool-dark-narrow-error-expanded.png'))
    expect(geometry).not.toBeNull()
    expect(geometry!.x).toBeGreaterThanOrEqual(0)
    expect(geometry!.y).toBeGreaterThanOrEqual(0)
    expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.width)
    expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(WORKSPACE_WINDOW_MINIMUM.height)
    assertToolHistory(
      (await inspect(page, 'dark-tool-completed')).history,
      turn.turnId,
      'error',
      PREVIEW_CONVERSATION.toolFailedOutput,
      itemId
    )
  }
)
