import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, openPreviewTools, previewSurface, expect, test, type Page, type Response } from './testing'
import { BROWSER_ERROR, type BrowserCommand, type BrowserReply, type BrowserSnapshot } from '../src/browser'
import { WORKSPACE_WINDOW_MINIMUM } from '../src/window'
import browserZh from '../src/localization/locales/zh/browser.json'
import browserEn from '../src/localization/locales/en/browser.json'
import uiZh from '../src/localization/locales/zh/ui.json'
import previewZh from './locales/zh.json'
import { PREVIEW_BROWSER } from './browser'
import { PREVIEW_CATALOG } from './catalog'
import { capturePreview } from './capture'
import { PREVIEW_ORIGIN } from './constants'
import { previewConsumption } from './coverage'

const SNAPSHOT_PATH = `${PREVIEW_BROWSER.path}/snapshot`
const COMMAND_PATH = `${PREVIEW_BROWSER.path}/command`
const STATE_PATH = '/__preview/state'
const BLOCKED_ADDRESS = 'https://example.invalid/preview-blocked'
const ENTRIES = [{ pageId: 'page-browser', prefix: 'browser' }, { pageId: 'viewer-browser', prefix: 'viewer-browser' }] as const
interface Observation {
  requests: { path: string; method: string; kind?: string }[]
  replies: { path: string; status: number; ok?: boolean; error?: string; tabs?: number; activeTabId?: string | null }[]
  failures: { path: string; status: number }[]
  externalOrigins: string[]
  pageErrors: string[]
  requestFailures: { path: string; error: string | null }[]
  collecting: Promise<void>[]
}
const OBSERVATIONS = new WeakMap<Page, Observation>()

test.beforeEach(({ page }) => {
  const observation: Observation = { requests: [], replies: [], failures: [], externalOrigins: [], pageErrors: [], requestFailures: [], collecting: [] }
  OBSERVATIONS.set(page, observation)
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN && !observation.externalOrigins.includes(url.origin)) observation.externalOrigins.push(url.origin)
    if ([SNAPSHOT_PATH, COMMAND_PATH].includes(url.pathname)) {
      const body = request.postDataJSON() as Partial<BrowserCommand> | null
      observation.requests.push({ path: url.pathname, method: request.method(), ...(body?.kind ? { kind: body.kind } : {}) })
    }
  })
  page.on('pageerror', error => observation.pageErrors.push(error.message))
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.origin === PREVIEW_ORIGIN) observation.requestFailures.push({ path: url.pathname, error: request.failure()?.errorText ?? null })
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path.startsWith(PREVIEW_BROWSER.path) || path === STATE_PATH) && response.status() >= 400) observation.failures.push({ path, status: response.status() })
    if ([SNAPSHOT_PATH, COMMAND_PATH].includes(path)) observation.collecting.push((async () => {
      const reply = await response.json() as BrowserReply
      observation.replies.push({ path, status: response.status(), ok: reply.ok, ...(reply.ok ? { tabs: reply.snapshot.tabs.length, activeTabId: reply.snapshot.activeTabId } : { error: reply.error }) })
    })().catch(() => { observation.replies.push({ path, status: response.status() }) }))
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const observation = OBSERVATIONS.get(page)!
  await Promise.all(observation.collecting)
  const summary = {
    requests: observation.requests, replies: observation.replies, failures: observation.failures,
    externalOrigins: observation.externalOrigins, pageErrors: observation.pageErrors, requestFailures: observation.requestFailures,
  }
  const path = testInfo.outputPath('tabs-http-summary.json')
  await writeFile(path, JSON.stringify(summary, null, 2))
  await testInfo.attach('tabs-http-summary', { path, contentType: 'application/json' })
  expect(observation.externalOrigins).toEqual([])
  expect(observation.failures).toEqual([])
  expect(observation.pageErrors).toEqual([])
})

function responseFor(page: Page, path: string, kind?: BrowserCommand['kind']): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST'
    && (!kind || (response.request().postDataJSON() as BrowserCommand).kind === kind))
}

async function snapshot(response: Response): Promise<BrowserSnapshot> {
  expect(response.status()).toBe(200)
  const reply = await response.json() as BrowserReply
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error(`Unexpected browser reply: ${reply.error}`)
  expect(reply.snapshot.automation).toEqual({ enabled: false, port: null })
  expect(reply.snapshot.engine).toBeUndefined()
  for (const tab of reply.snapshot.tabs) expect(tab.url).toBe(PREVIEW_BROWSER.blankPage)
  return reply.snapshot
}

async function openScene(page: Page, entry: typeof ENTRIES[number], suffix: string): Promise<{ received: () => boolean; response: Promise<Response> }> {
  const target = PREVIEW_CATALOG.find(candidate => candidate.id === entry.pageId)!
  const scene = target.scenarios.find(candidate => candidate.id === `${entry.prefix}-${suffix}`)!
  await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
  await page.keyboard.press('F8')
  let received = false
  const response = responseFor(page, SNAPSHOT_PATH).then(result => { received = true; return result })
  await openPreviewScenario(page, target.id, scene.id)
  await expect(previewSurface(page).getByTestId('browser-workspace')).toBeVisible()
  return { received: () => received, response }
}

async function command(page: Page, kind: BrowserCommand['kind'], action: () => Promise<unknown>): Promise<Response> {
  const response = responseFor(page, COMMAND_PATH, kind)
  await action()
  return await response
}

function newTab(page: Page) {
  return previewSurface(page).getByTestId('browser-workspace').getByRole('button', { name: browserZh.newTabAction, exact: true })
}

async function showError(page: Page, error: keyof typeof browserZh.errors): Promise<void> {
  const workspace = previewSurface(page).getByTestId('browser-workspace')
  await expect(workspace.getByRole('alert')).toHaveText(browserZh.errors[error])
  await previewSurface(page).getByTestId('browser-start-page').getByRole('heading', { name: browserZh.start.title, exact: true }).hover()
  await workspace.getByRole('button', { name: browserZh.help.label, exact: true }).hover()
  await expect(previewSurface(page).getByRole('tooltip', { name: browserZh.errors[error], exact: true })).toBeVisible()
}

async function closeTab(page: Page): Promise<BrowserSnapshot> {
  const workspace = previewSurface(page).getByTestId('browser-workspace')
  const label = uiZh.navigation.closeNamed.replace('{{label}}', browserZh.newTab)
  return await snapshot(await command(page, 'close', () => workspace.getByRole('button', { name: label, exact: true }).first().click()))
}

for (const entry of ENTRIES) {
  test(`${entry.prefix} blank tabs use original controls, block navigation and persist in dark English`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-blank`, ['start', 'opened', 'selected', 'closed', 'reloaded', 'blocked']),
  }, async ({ page }, testInfo) => {
    const initial = await openScene(page, entry, 'blank')
    expect((await snapshot(await initial.response)).tabs).toEqual([])
    const workspace = previewSurface(page).getByTestId('browser-workspace')
    await expect(previewSurface(page).getByTestId('browser-start-page')).toContainText(browserZh.start.title)
    await capturePreview(page, testInfo.outputPath('tabs-start.png'))
    const first = await snapshot(await command(page, 'open', () => newTab(page).click()))
    expect(first.tabs).toHaveLength(1)
    const address = workspace.getByRole('textbox', { name: browserZh.address, exact: true })
    await page.keyboard.press('Control+l')
    await expect(address).toBeFocused()
    await page.keyboard.press('Meta+l')
    await expect(address).toBeFocused()
    await address.fill(BLOCKED_ADDRESS)
    const blocked = await command(page, 'navigate', () => address.press('Enter'))
    expect(await blocked.json()).toEqual({ ok: false, error: BROWSER_ERROR.permissionDenied })
    await showError(page, 'permission_denied')
    await capturePreview(page, testInfo.outputPath('tabs-navigation-blocked.png'))
    const opened = await snapshot(await command(page, 'open', () => newTab(page).click()))
    expect(opened.tabs).toHaveLength(2)
    const selected = await snapshot(await command(page, 'select', () => workspace.getByRole('tab').first().click()))
    expect(selected.activeTabId).toBe(first.tabs[0].tabId)
    await expect(workspace.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
    const keyboard = await snapshot(await command(page, 'select', () => workspace.getByRole('tab').first().press('End')))
    expect(keyboard.activeTabId).toBe(opened.tabs[1].tabId)
    await expect(workspace.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
    const restored = responseFor(page, SNAPSHOT_PATH)
    const instance = new URL(page.url()).searchParams.get('previewInstance')
    await page.reload()
    const reloaded = await snapshot(await restored)
    expect(reloaded.tabs.map(tab => tab.tabId)).toEqual(opened.tabs.map(tab => tab.tabId))
    expect(reloaded.activeTabId).toBe(keyboard.activeTabId)
    expect(new URL(page.url()).searchParams.get('previewInstance')).toBe(instance)
    await expect(workspace.getByRole('tab')).toHaveCount(2)
    await expect(workspace.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
    expect((await closeTab(page)).tabs).toHaveLength(1)
    expect((await closeTab(page)).tabs).toHaveLength(0)
    await expect(workspace.getByRole('tab')).toHaveCount(1)
    await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
    await page.keyboard.press('F8')
    await openPreviewTools(page)
    await page.locator('#preview-theme').click()
    await page.getByRole('option', { name: previewZh.dark, exact: true }).click()
    await openPreviewTools(page)
    await page.locator('#preview-language').click()
    await page.getByRole('option', { name: previewZh.english, exact: true }).click()
    const appearance = responseFor(page, SNAPSHOT_PATH)
    await page.getByRole('button', { name: previewZh.save, exact: true }).click()
    expect((await snapshot(await appearance)).tabs).toEqual([])
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(previewSurface(page).getByTestId('browser-start-page')).toContainText(browserEn.start.title)
    await expect(workspace.getByRole('textbox', { name: browserEn.address, exact: true })).toBeVisible()
    await capturePreview(page, testInfo.outputPath('tabs-dark-english-minimum.png'))
  })

  test(`${entry.prefix} existing blank tabs support pointer and keyboard selection and closing`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-tabs`, ['populated', 'selected', 'closed']),
  }, async ({ page }, testInfo) => {
    const initial = await openScene(page, entry, 'tabs')
    const seeded = await snapshot(await initial.response)
    expect(seeded.tabs).toHaveLength(PREVIEW_BROWSER.surfaceSampleCount)
    expect(new Set(seeded.tabs.map(tab => tab.tabId)).size).toBe(PREVIEW_BROWSER.surfaceSampleCount)
    const tabs = previewSurface(page).getByTestId('browser-workspace').getByRole('tab')
    await expect(tabs).toHaveCount(PREVIEW_BROWSER.surfaceSampleCount)
    const selected = await snapshot(await command(page, 'select', () => tabs.last().click()))
    expect(selected.activeTabId).toBe(seeded.tabs[1].tabId)
    const keyboard = await snapshot(await command(page, 'select', () => tabs.last().press('Home')))
    expect(keyboard.activeTabId).toBe(seeded.tabs[0].tabId)
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
    await capturePreview(page, testInfo.outputPath('tabs-seeded.png'))
    expect((await closeTab(page)).tabs).toHaveLength(1)
    expect((await closeTab(page)).tabs).toHaveLength(0)
    await expect(previewSurface(page).getByTestId('browser-start-page')).toBeVisible()
    await capturePreview(page, testInfo.outputPath('tabs-closed.png'))
  })

  test(`${entry.prefix} delayed snapshot preserves the real start surface until tabs arrive`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-pending`, ['request-pending', 'loaded']),
  }, async ({ page }, testInfo) => {
    const pending = await openScene(page, entry, 'pending')
    expect(pending.received()).toBe(false)
    await expect(previewSurface(page).getByTestId('browser-start-page')).toBeVisible()
    await expect(previewSurface(page).getByTestId('browser-workspace').getByRole('tab')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('tabs-snapshot-pending.png') })
    expect(pending.received()).toBe(false)
    expect((await snapshot(await pending.response)).tabs).toHaveLength(PREVIEW_BROWSER.surfaceSampleCount)
    await expect(previewSurface(page).getByTestId('browser-workspace').getByRole('tab')).toHaveCount(PREVIEW_BROWSER.surfaceSampleCount)
    await capturePreview(page, testInfo.outputPath('tabs-snapshot-loaded.png'))
  })

  test(`${entry.prefix} persistent snapshot failure uses the original help and remains failed after reload`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-failed`, ['error', 'retry-failed']),
  }, async ({ page }, testInfo) => {
    const initial = await openScene(page, entry, 'failed')
    expect(await (await initial.response).json()).toEqual({ ok: false, error: BROWSER_ERROR.operationFailed })
    await showError(page, 'operation_failed')
    await capturePreview(page, testInfo.outputPath('tabs-snapshot-failed.png'))
    const retried = responseFor(page, SNAPSHOT_PATH)
    await page.reload()
    expect(await (await retried).json()).toEqual({ ok: false, error: BROWSER_ERROR.operationFailed })
    await showError(page, 'operation_failed')
    await capturePreview(page, testInfo.outputPath('tabs-snapshot-retry-failed.png'))
  })

  test(`${entry.prefix} delayed new tab disables repeated commands until its real receipt`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-write-pending`, ['submitting', 'opened']),
  }, async ({ page }, testInfo) => {
    const initial = await openScene(page, entry, 'write-pending')
    await snapshot(await initial.response)
    let received = false
    const pending = responseFor(page, COMMAND_PATH, 'open').then(response => { received = true; return response })
    await newTab(page).click()
    await expect(previewSurface(page).getByTestId('browser-workspace')).toHaveAttribute('aria-busy', 'true')
    await expect(newTab(page)).toBeDisabled()
    expect(received).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('tabs-write-pending.png') })
    expect(received).toBe(false)
    expect((await snapshot(await pending)).tabs).toHaveLength(1)
    await expect(newTab(page)).toBeEnabled()
    expect(OBSERVATIONS.get(page)!.requests.filter(request => request.kind === 'open')).toHaveLength(1)
    await capturePreview(page, testInfo.outputPath('tabs-write-completed.png'))
  })

  test(`${entry.prefix} failed new tab leaves no partial tab and the original action can retry`, {
    annotation: previewConsumption(entry.pageId, `${entry.prefix}-write-failed`, ['error', 'retried', 'opened']),
  }, async ({ page }, testInfo) => {
    const initial = await openScene(page, entry, 'write-failed')
    expect((await snapshot(await initial.response)).tabs).toEqual([])
    const failed = await command(page, 'open', () => newTab(page).click())
    expect(await failed.json()).toEqual({ ok: false, error: BROWSER_ERROR.operationFailed })
    await showError(page, 'operation_failed')
    await expect(previewSurface(page).getByTestId('browser-workspace').getByRole('button', { name: uiZh.navigation.closeNamed.replace('{{label}}', browserZh.newTab), exact: true })).toHaveCount(0)
    await capturePreview(page, testInfo.outputPath('tabs-write-failed.png'))
    const recovered = await snapshot(await command(page, 'open', () => newTab(page).click()))
    expect(recovered.tabs).toHaveLength(1)
    await expect(previewSurface(page).getByTestId('browser-workspace').getByRole('alert')).toHaveCount(0)
    expect(OBSERVATIONS.get(page)!.requests.filter(request => request.kind === 'open')).toHaveLength(2)
    await capturePreview(page, testInfo.outputPath('tabs-write-retried.png'))
  })
}
