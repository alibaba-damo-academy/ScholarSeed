import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page, type Response } from './testing'
import type { HistoryResult } from '../src/renderer/src/api'
import { PREVIEW_CATALOG } from './catalog'
import { PREVIEW_ORIGIN } from './constants'
import { capturePreview } from './capture'
import { previewConsumption } from './coverage'
import componentsZh from '../src/localization/locales/zh/components.json'
import conversationZh from '../src/localization/locales/zh/conversation.json'

const PAGE_ID = 'page-conversation'
const CANCEL_SCENE = 'conversation-cancel'
const RECOVERY_SCENE = 'conversation-recovery'
const CANCEL_PREFIX = '开始模拟长回答。'
const CANCEL_SUFFIX = '模拟长回答已完成。'
const RECOVERY_ANSWER = '这里复用真实产品组件与事件投影。'
const ANSWER_SELECTOR = '.answer-annotation-root'
const SESSION_PATH = /^\/api\/serve\/sessions\/([^/]+)\/(events|turns|interrupt)$/
type HttpEntry = { method: string; path: string; status?: number }
type StreamEntry = { sessionId: string; fromSeq: number; stage: 'request' | 'finished' | 'failed'; error?: string }
type StreamDiagnostic = { stage: string; sessionId: string; sequence: number; reason?: string; attempt?: number; delayMs?: number }
type Observation = { http: HttpEntry[]; failures: HttpEntry[]; streams: StreamEntry[]; diagnostics: StreamDiagnostic[]; terminals: { turnId: string; outcome: string; sequence: number }[]; externalOrigins: string[]; pageErrors: string[] }
const OBSERVATIONS = new WeakMap<Page, Observation>()

function streamIdentity(input: string): { sessionId: string; fromSeq: number } | null {
  const url = new URL(input)
  if (url.origin !== PREVIEW_ORIGIN) return null
  const match = url.pathname.match(SESSION_PATH)
  if (match?.[2] !== 'events') return null
  return { sessionId: decodeURIComponent(match[1]), fromSeq: Number(url.searchParams.get('from_seq')) }
}

test.beforeEach(({ page }) => {
  const observation: Observation = { http: [], failures: [], streams: [], diagnostics: [], terminals: [], externalOrigins: [], pageErrors: [] }
  OBSERVATIONS.set(page, observation)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observation.externalOrigins.includes(url.origin)) observation.externalOrigins.push(url.origin)
    if (url.origin === PREVIEW_ORIGIN && url.pathname.startsWith('/api/')) observation.http.push({ method: request.method(), path: url.pathname })
    const stream = streamIdentity(request.url())
    if (stream) observation.streams.push({ ...stream, stage: 'request' })
  })
  page.on('requestfinished', request => {
    const stream = streamIdentity(request.url())
    if (stream) observation.streams.push({ ...stream, stage: 'finished' })
  })
  page.on('requestfailed', request => {
    const stream = streamIdentity(request.url())
    if (stream) observation.streams.push({ ...stream, stage: 'failed', error: request.failure()?.errorText })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== PREVIEW_ORIGIN || (!url.pathname.startsWith('/api/') && url.pathname !== '/__preview/state')) return
    const entry = { method: response.request().method(), path: url.pathname, status: response.status() }
    observation.http.push(entry)
    if (response.status() >= 400) observation.failures.push(entry)
  })
  page.on('console', message => {
    if (!message.text().startsWith('[session-stream] ')) return
    try {
      const value = JSON.parse(message.text().slice('[session-stream] '.length)) as StreamDiagnostic
      observation.diagnostics.push({ stage: value.stage, sessionId: value.sessionId, sequence: value.sequence, ...(value.reason ? { reason: value.reason } : {}), ...(value.attempt === undefined ? {} : { attempt: value.attempt }), ...(value.delayMs === undefined ? {} : { delayMs: value.delayMs }) })
    } catch { observation.pageErrors.push('invalid-session-stream-diagnostic') }
  })
  page.on('pageerror', error => observation.pageErrors.push(error.name))
})

test.afterEach(async ({ page }, testInfo) => {
  const observation = OBSERVATIONS.get(page)!
  const path = testInfo.outputPath('conversation-http-summary.json')
  await writeFile(path, JSON.stringify(observation, null, 2))
  await testInfo.attach('conversation-http-summary', { path, contentType: 'application/json' })
  expect(observation.externalOrigins).toEqual([])
  expect(observation.failures).toEqual([])
  expect(observation.pageErrors).toEqual([])
})

async function openConversation(page: Page, sceneId: string): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === PAGE_ID)!
  const scene = entry.scenarios.find(candidate => candidate.id === sceneId)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  await openPreviewScenario(page, entry.id, scene.id)
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
}

function responseFor(page: Page, action: 'turns' | 'interrupt'): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).pathname.match(SESSION_PATH)?.[2] === action && response.request().method() === 'POST')
}

async function acceptedTurn(response: Response): Promise<{ sessionId: string; turnId: string }> {
  expect(response.status()).toBe(200)
  const receipt = await response.json() as { ok: boolean; accepted: boolean; turn_id: string }
  expect(receipt).toMatchObject({ ok: true, accepted: true })
  expect(receipt.turn_id).toBeTruthy()
  return { sessionId: decodeURIComponent(new URL(response.url()).pathname.match(SESSION_PATH)![1]), turnId: receipt.turn_id }
}

async function send(page: Page, question: string): Promise<{ sessionId: string; turnId: string }> {
  await previewSurface(page).getByTestId('composer-input').fill(question)
  await expect(previewSurface(page).getByTestId('composer-send')).toBeEnabled()
  const sending = responseFor(page, 'turns')
  await previewSurface(page).getByTestId('composer-send').click()
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  return acceptedTurn(await sending)
}

async function reenter(page: Page, sessionId: string): Promise<HistoryResult> {
  const home = previewSurface(page).getByRole('button', { name: '返回首页', exact: true })
  if (await home.isVisible()) await home.click()
  else await previewSurface(page).getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(previewSurface(page).getByTestId('project-center')).toBeVisible()
  const reading = page.waitForResponse(response => new URL(response.url()).pathname === `/api/serve/history/${encodeURIComponent(sessionId)}` && response.request().method() === 'GET')
  await previewSurface(page).getByTestId('home-task-preview-session').click()
  expect((await reading).status()).toBe(200)
  const history = await (await reading).json() as HistoryResult
  await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
  recordTerminals(page, history)
  return history
}

function recordTerminals(page: Page, history: HistoryResult): void {
  for (const event of history.activity_events) {
    if (!event.turn_id || !['turn_completed', 'turn_interrupted', 'turn_failed'].includes(event.type)) continue
    OBSERVATIONS.get(page)!.terminals.push({ turnId: event.turn_id, outcome: event.type, sequence: event.seq })
  }
}

function assertInterrupted(history: HistoryResult, turnId: string): string {
  expect(history.turn_activity.find(turn => turn.turn_id === turnId)?.outcome).toBe('interrupted')
  const terminal = history.activity_events.filter(event => event.turn_id === turnId && event.type === 'turn_interrupted')
  expect(terminal).toHaveLength(1)
  expect(history.activity_events.filter(event => event.turn_id === turnId && event.type === 'turn_completed')).toEqual([])
  expect(history.activity_events.filter(event => event.turn_id === turnId && event.type === 'message_delta' && event.seq > terminal[0].seq)).toEqual([])
  const answer = history.turns.filter(turn => turn.turn_id === turnId && turn.role === 'assistant' && turn.kind === 'text')
  expect(answer).toHaveLength(1)
  expect(answer[0].text).toContain(CANCEL_PREFIX)
  expect(answer[0].text).not.toContain(CANCEL_SUFFIX)
  return answer[0].text!
}

async function stop(page: Page): Promise<void> {
  await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
  const interrupting = responseFor(page, 'interrupt')
  await previewSurface(page).getByTestId('composer-stop').click()
  const response = await interrupting
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expect(previewSurface(page).getByText(componentsZh.stream.stopped, { exact: true }).first()).toBeVisible()
}

test('long simulated stream stops through the original control and preserves interrupted prefixes after reentry', { annotation: previewConsumption(PAGE_ID, CANCEL_SCENE, ['streaming', 'cancelling', 'cancelled']) }, async ({ page }, testInfo) => {
  await openConversation(page, CANCEL_SCENE)
  const firstQuestion = `停止真实流消费-${randomUUID()}`
  const first = await send(page, firstQuestion)
  const answers = previewSurface(page).locator(ANSWER_SELECTOR).filter({ hasText: CANCEL_PREFIX })
  await expect(answers).toHaveCount(1)
  await expect(answers.first()).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
  await expect(previewSurface(page).getByText(CANCEL_SUFFIX, { exact: false })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('conversation-long-streaming.png') })
  await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
  await stop(page)
  const firstPrefix = await answers.first().innerText()
  await capturePreview(page, testInfo.outputPath('conversation-cancelled.png'))
  const firstHistory = await reenter(page, first.sessionId)
  expect(assertInterrupted(firstHistory, first.turnId).trim()).toBe(firstPrefix.trim())
  await expect(answers).toHaveCount(1)
  await expect(answers.first()).toHaveText(firstPrefix)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(firstQuestion, { exact: true })).toHaveCount(1)
  const secondQuestion = `中断后第二轮-${randomUUID()}`
  const second = await send(page, secondQuestion)
  expect(second.sessionId).toBe(first.sessionId)
  expect(second.turnId).not.toBe(first.turnId)
  await expect(answers).toHaveCount(2)
  await expect(answers.first()).toHaveText(firstPrefix)
  await stop(page)
  const secondPrefix = await answers.nth(1).innerText()
  const reloadedHistory = page.waitForResponse(response => new URL(response.url()).pathname === `/api/serve/history/${encodeURIComponent(first.sessionId)}`)
  await page.reload()
  const history = await (await reloadedHistory).json() as HistoryResult
  recordTerminals(page, history)
  expect(assertInterrupted(history, first.turnId).trim()).toBe(firstPrefix.trim())
  expect(assertInterrupted(history, second.turnId).trim()).toBe(secondPrefix.trim())
  await expect(answers).toHaveCount(2)
  await expect(answers.first()).toHaveText(firstPrefix)
  await expect(answers.nth(1)).toHaveText(secondPrefix)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(firstQuestion, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(secondQuestion, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  expect(OBSERVATIONS.get(page)!.http.filter(entry => entry.method === 'POST' && entry.path.endsWith('/interrupt') && entry.status === 200)).toHaveLength(2)
  await capturePreview(page, testInfo.outputPath('conversation-cancelled-reloaded.png'))
})

test('failed simulated turn retries through the original action and reconnects its server-closed stream without duplication', { annotation: previewConsumption(PAGE_ID, RECOVERY_SCENE, ['disconnected', 'reconnecting', 'failed', 'recovered']) }, async ({ page }, testInfo) => {
  await openConversation(page, RECOVERY_SCENE)
  const question = `真实断流恢复-${randomUUID()}`
  const first = await send(page, question)
  await expect(previewSurface(page).getByTestId('turn-recoverable-notice')).toContainText(conversationZh.failure.interrupted.message)
  await expect(previewSurface(page).getByTestId('turn-continue')).toBeEnabled()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('conversation-failed-before-retry.png'))
  const observation = OBSERVATIONS.get(page)!
  const previousRequests = observation.streams.filter(entry => entry.stage === 'request' && entry.sessionId === first.sessionId).length
  const retrying = responseFor(page, 'turns')
  await previewSurface(page).getByTestId('turn-continue').click()
  const retried = await acceptedTurn(await retrying)
  expect(retried.sessionId).toBe(first.sessionId)
  const reconnecting = previewSurface(page).getByText(conversationZh.runtime.transportRetrying, { exact: true })
  await expect(reconnecting).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('conversation-reconnecting.png') })
  await expect(reconnecting).toBeVisible()
  await expect.poll(() => observation.diagnostics.filter(entry => entry.sessionId === first.sessionId && entry.stage === 'retry' && entry.reason === 'transport').length).toBe(1)
  await expect.poll(() => observation.streams.filter(entry => entry.stage === 'request' && entry.sessionId === first.sessionId).length).toBeGreaterThan(previousRequests)
  const answer = previewSurface(page).locator(ANSWER_SELECTOR).filter({ hasText: RECOVERY_ANSWER })
  await expect(answer).toHaveCount(1)
  await expect(answer).toBeVisible()
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expect(reconnecting).not.toBeVisible()
  const retryDiagnostic = observation.diagnostics.find(entry => entry.sessionId === first.sessionId && entry.stage === 'retry' && entry.reason === 'transport')!
  const requests = observation.streams.filter(entry => entry.sessionId === first.sessionId && entry.stage === 'request')
  expect(requests.at(-1)!.fromSeq).toBeGreaterThan(requests[0].fromSeq)
  expect(requests.at(-1)!.fromSeq).toBe(retryDiagnostic.sequence)
  expect(observation.diagnostics.some(entry => entry.sessionId === first.sessionId && entry.stage === 'live' && entry.sequence >= retryDiagnostic.sequence)).toBe(true)
  const visibleAnswer = await answer.innerText()
  const assertConsistentHistory = (history: HistoryResult): void => {
    expect(history.turn_activity.find(turn => turn.turn_id === first.turnId)?.outcome).toBe('failed')
    expect(history.turn_activity.find(turn => turn.turn_id === retried.turnId)?.outcome).toBe('completed')
    const original = history.turns.filter(turn => turn.role === 'user' && turn.text === question)
    const continued = history.turns.filter(turn => turn.role === 'user' && turn.text === componentsZh.stream.continueTaskPrompt)
    expect(original).toHaveLength(1)
    expect(continued).toHaveLength(1)
    const answers = history.turns.filter(turn => turn.role === 'assistant' && turn.kind === 'text' && turn.turn_id === retried.turnId)
    expect(answers).toHaveLength(1)
    const deltas = history.activity_events.filter(event => event.turn_id === retried.turnId && event.type === 'message_delta')
    expect(deltas.length).toBeGreaterThan(1)
    const sequences = deltas.map(event => event.seq)
    expect(new Set(sequences).size).toBe(sequences.length)
    const snapshots = deltas.map(event => event.type === 'message_delta' ? event.data.delta : '')
    for (const [index, text] of snapshots.entries()) {
      if (index > 0) expect(text.startsWith(snapshots[index - 1])).toBe(true)
    }
    expect(snapshots.at(-1)).toBe(answers[0].text)
    expect(history.activity_events.filter(event => event.turn_id === retried.turnId && event.type === 'turn_completed')).toHaveLength(1)
  }
  assertConsistentHistory(await reenter(page, first.sessionId))
  await expect(answer).toHaveCount(1)
  await expect(answer).toHaveText(visibleAnswer)
  const reloading = page.waitForResponse(response => new URL(response.url()).pathname === `/api/serve/history/${encodeURIComponent(first.sessionId)}`)
  await page.reload()
  const history = await (await reloading).json() as HistoryResult
  recordTerminals(page, history)
  assertConsistentHistory(history)
  await expect(answer).toHaveCount(1)
  await expect(answer).toHaveText(visibleAnswer)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(question, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('user-bubble').getByText(componentsZh.stream.continueTaskPrompt, { exact: true })).toHaveCount(1)
  await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
  await expect(previewSurface(page).getByTestId('turn-continue-error')).not.toBeVisible()
  await expect(reconnecting).not.toBeVisible()
  await capturePreview(page, testInfo.outputPath('conversation-recovered-reloaded.png'))
})
