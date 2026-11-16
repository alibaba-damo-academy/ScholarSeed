import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { chromium, expect, type Browser, type Page, type Request } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformSync } from 'esbuild'
import { RENDERER_SHARED_DEPENDENCIES } from '../../../../../renderer.ts'
import { renderServers } from '../../../../test-helpers/render.ts'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const servers = renderServers({ after })
const STORE = '\0history-store'
const ENTRY = '\0history-entry'
const CHILDREN = '\0history-children'
const HISTORY_PATH = '/api/serve/sessions'
interface HistoryRequest {
  url: URL
  response: ServerResponse
}
const childrenSource = `
import React from 'react'
export const Composer = ({ inputBoxRef }) => React.createElement('div', { ref: inputBoxRef })
export const ConversationControls = ({ children }) => children
export const PendingHilDock = () => null
export const Stream = () => null
export const TodoPanel = () => null
export const LoginPrompt = () => null
export const Translation = () => null
`
const store = `
import React from 'react'
import { INITIAL_AI_PANEL_STATE } from '/src/renderer/src/features/assistant/state.ts'
const Context = React.createContext(null)
export const useApp = () => React.useContext(Context)
export const assistantProject = state => ({ projectPath: state.projectPath })
export const activeThread = () => ({ items: [], todos: [] })
export function Provider({ children }) {
  const [mounted, setMounted] = React.useState(true)
  const [state, update] = React.useState({
    aiPanel: { ...INITIAL_AI_PANEL_STATE, open: true, sessionMenuOpen: false },
    projectPath: '/project-a', projects: [], lang: 'zh', threads: {},
    sessionActivitySeen: {}, activeSession: null, turnLaunch: null, composerRefs: []
  })
  const set = patch => update(current => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }))
  window.historyProbe = {
    patch: set,
    menu: open => set(current => ({ aiPanel: { ...current.aiPanel, sessionMenuOpen: open } })),
    unmount: () => setMounted(false),
    opened: window.historyProbe?.opened ?? [],
  }
  const act = new Proxy({}, { get: (_, key) => key === 'openPanelSession'
    ? node => window.historyProbe.opened.push(node.id) : () => undefined })
  return React.createElement(Context.Provider, { value: { state, set, act, composerDraft: { getSnapshot: () => '' } } }, mounted ? children : null)
}
`
const entry = `
import '/src/renderer/src/browser.ts'
import '/src/renderer/src/styles.css'
import '/src/renderer/src/shell/workbench.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '/src/localization/engine.ts'
import { resources } from '/src/localization/resources.ts'
import { AiPanel } from '/src/renderer/src/features/assistant/AiPanel.tsx'
import { Provider } from 'history-store'
const localization = createLocalization('zh', resources, { report: () => undefined })
createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(I18nextProvider, { i18n: localization },
    React.createElement(Provider, null, React.createElement(AiPanel)))))
`

async function fixture(
  run: (page: Page, pending: HistoryRequest[], requests: URL[]) => Promise<void>
): Promise<void> {
  const startedAt = performance.now()
  const navigation: { stage: string; elapsedMs: number; error?: string }[] = []
  const recordNavigation = (stage: string, error?: unknown): void => {
    const event = {
      stage,
      elapsedMs: performance.now() - startedAt,
      ...(error === undefined ? {} : { error: String(error) }),
    }
    navigation.push(event)
    console.info('[history-navigation]', JSON.stringify(event))
  }
  transformSync(childrenSource, { loader: 'js' })
  const pending: HistoryRequest[] = []
  const requests: URL[] = []
  const server = await servers.create({
    cacheKey: 'history',
    configFile: false,
    root: DESKTOP,
    optimizeDeps: {
      entries: ['src/renderer/src/features/assistant/AiPanel.tsx'],
      include: [...RENDERER_SHARED_DEPENDENCIES, 'react-dom/client'],
    },
    resolve: { dedupe: RENDERER_SHARED_DEPENDENCIES },
    plugins: [
      {
        name: 'history-fixture',
        enforce: 'pre',
        resolveId(source, importer) {
          if (
            source === 'history-store' ||
            (source === '../../store' && importer?.endsWith('/AiPanel.tsx'))
          )
            return STORE
          if (source === 'history-entry') return ENTRY
          if (
            importer?.endsWith('/AiPanel.tsx') &&
            [
              '../../components/business/Composer',
              '../../components/business/Stream',
              '../../components/business/TodoPanel',
              '../../components/business/LoginPrompt',
              './Translation',
            ].includes(source)
          )
            return CHILDREN
        },
        load(id) {
          if (id === STORE) return store
          if (id === ENTRY) return entry
          if (id === CHILDREN) return childrenSource
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
            if (url.pathname !== HISTORY_PATH) return next()
            requests.push(url)
            pending.push({ url, response })
          })
          server.middlewares.use('/history-fixture.html', async (_request, response, next) => {
            recordNavigation('request')
            response.once('finish', () => recordNavigation('response-finished'))
            response.once('close', () => recordNavigation('response-closed'))
            response.setHeader('Content-Type', 'text/html')
            try {
              const html = await server.transformIndexHtml(
                '/history-fixture.html',
                '<div id="root"></div><script type="module" src="/@id/__x00__history-entry"></script>'
              )
              recordNavigation('html-ready')
              response.end(html)
            } catch (error) {
              recordNavigation('html-failed', error)
              next(error)
            }
          })
        },
      },
      react(),
    ],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  let browser: Browser | undefined
  server.httpServer?.prependListener('request', (request) => {
    if (request.url?.startsWith('/history-fixture.html')) recordNavigation('http-request')
  })
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    const errors: string[] = []
    const diagnostics: string[] = []
    const loading = new Set<Request>()
    const documents: Request[] = []
    page.on('domcontentloaded', () => recordNavigation('domcontentloaded'))
    page.on('load', () => recordNavigation('load'))
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
    page.on('request', (request) => {
      loading.add(request)
      if (request.isNavigationRequest()) {
        documents.push(request)
        recordNavigation('browser-request')
      }
    })
    page.on('requestfinished', (request) => loading.delete(request))
    page.on('requestfailed', (request) => {
      loading.delete(request)
      diagnostics.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    const navigationCpu = process.cpuUsage()
    const eventLoop = monitorEventLoopDelay()
    eventLoop.enable()
    try {
      recordNavigation('goto')
      await page.goto(new URL('/history-fixture.html', server.resolvedUrls!.local[0]).href)
      await expect(page.getByTestId('ai-session-toggle')).toBeVisible()
      await expect.poll(() => pending.length).toBe(2)
      await reply(pending.shift()!, 0, 0, null)
      const prewarm = pending.shift()!
      recordNavigation('open-menu')
      await page.getByTestId('ai-session-toggle').click()
      await expect(page.getByTestId('ai-session-search')).toBeFocused()
      await expect.poll(() => pending.length).toBe(1)
      await reply(prewarm, 0, 0, null)
      recordNavigation('case')
      await run(page, pending, requests)
      assert.deepEqual(errors, [])
    } catch (error) {
      recordNavigation('fixture-failed', error)
      const runtime = {
        cpu: process.cpuUsage(navigationCpu),
        eventLoopMaxMs: eventLoop.max / 1e6,
        timeOrigin: performance.timeOrigin,
        startedAt,
      }
      const document = await page
        .evaluate(() => {
          const toggle = globalThis.document.querySelector('[data-testid="ai-session-toggle"]')
          const style = toggle && getComputedStyle(toggle)
          return {
            url: location.href,
            rootChildren: globalThis.document.getElementById('root')?.childElementCount,
            scripts: Array.from(globalThis.document.scripts, (script) => script.src),
            visibility: globalThis.document.visibilityState,
            focused: globalThis.document.hasFocus(),
            fonts: globalThis.document.fonts.status,
            toggle: toggle && {
              rect: toggle.getBoundingClientRect().toJSON(),
              disabled: toggle instanceof HTMLButtonElement && toggle.disabled,
              display: style?.display,
              visibility: style?.visibility,
              animation: style?.animationName,
            },
            animations: globalThis.document.getAnimations().map((animation) => ({
              state: animation.playState,
              time: animation.currentTime,
              target:
                animation.effect instanceof KeyframeEffect &&
                animation.effect.target instanceof Element
                  ? (animation.effect.target.getAttribute('data-testid') ??
                    animation.effect.target.tagName)
                  : null,
            })),
          }
        })
        .catch((failure) => ({ error: String(failure) }))
      let screenshot: string
      try {
        const parent = path.join(DESKTOP, 'test-results')
        await mkdir(parent, { recursive: true })
        const directory = await mkdtemp(path.join(parent, 'history-'))
        screenshot = path.join(directory, 'failure.png')
        await page.screenshot({ path: screenshot })
      } catch (failure) {
        screenshot = `capture failed: ${String(failure)}`
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRenderer errors: ${errors.join('; ')}\nDiagnostics: ${diagnostics.join('; ')}\nLoading: ${JSON.stringify([...loading].map((request) => request.url()))}\nDocument: ${JSON.stringify(document)}\nNetwork: ${JSON.stringify(documents.map((request) => ({ url: request.url(), timing: request.timing() })))}\nNavigation: ${JSON.stringify(navigation)}\nRuntime: ${JSON.stringify(runtime)}\nScreenshot: ${screenshot}`,
        { cause: error }
      )
    } finally {
      eventLoop.disable()
    }
  } finally {
    await browser?.close()
    await server.close()
  }
}

const rows = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) => ({
    session_id: 'saved-' + (start + index),
    title: 'Saved ' + (start + index),
    workdir: '/project-a',
    runtime_id: 'codex',
    turns: 1,
    live: false,
    mtime: 100,
    last_agent_reply_at: 1_000 - (start + index),
  }))

function respond(request: HistoryRequest, payload: unknown, status = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    request.response.once('error', reject)
    request.response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    request.response.end(JSON.stringify(payload), resolve)
  })
}

const reply = (request: HistoryRequest, start: number, end: number, next: number | null) =>
  respond(request, {
    sessions: rows(start, end),
    total: 65,
    next_cursor: next === null ? null : 'page-' + next,
  })

const items = (page: Page) => page.locator('[data-testid^="ai-session-saved-"]')

async function nextRequest(pending: HistoryRequest[]): Promise<HistoryRequest> {
  await expect.poll(() => pending.length).toBe(1)
  return pending.shift()!
}

function assertCursor(requests: URL[], cursor: string | null): void {
  assert.equal(requests.at(-1)!.searchParams.get('cursor'), cursor)
  assert.equal(requests.at(-1)!.searchParams.has('offset'), false)
  assert.equal(requests.at(-1)!.searchParams.get('include_last_agent_reply'), 'true')
}

async function refresh(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('scholarseed:refresh-session-list')))
}

test(
  'unassigned history keeps committed rows while reopening waits for fresh results',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending) => {
      const initial = pending.shift()!
      await page.evaluate(() => Reflect.get(window, 'historyProbe').patch({ projectPath: null }))
      await reply(await nextRequest(pending), 60, 61, null)
      await reply(initial, 0, 30, 30)
      await expect(page.getByTestId('ai-session-saved-60')).toBeVisible()
      await page.keyboard.press('Escape')
      const prewarm = await nextRequest(pending)
      await page.getByTestId('ai-session-toggle').click()
      const reopened = await nextRequest(pending)
      await expect(page.getByTestId('ai-session-saved-60')).toBeVisible()
      await reply(prewarm, 40, 41, null)
      await reply(reopened, 60, 61, null)
      await expect(items(page)).toHaveCount(1)
    })
)

test(
  'unmount discards an in-flight history page before following its continuation cursor',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      const initial = pending.shift()!
      const requestCount = requests.length
      await page.evaluate(() => Reflect.get(window, 'historyProbe').unmount())
      await expect(page.getByTestId('ai-session-toggle')).toHaveCount(0)
      const responseReady = page.waitForResponse((response) => response.url() === initial.url.href)
      await reply(initial, 0, 30, 30)
      await (await responseReady).finished()
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      assert.equal(requests.length, requestCount)
      assert.equal(pending.length, 0)
    })
)

test(
  'history traverses 30 → 60 → 65 with cursors, deduplicates and globally orders Agent replies',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      assertCursor(requests, null)
      await reply(pending.shift()!, 0, 30, 30)
      const second = await nextRequest(pending)
      assertCursor(requests, 'page-30')
      await expect(items(page)).toHaveCount(0)
      await reply(second, 30, 60, 60)
      const last = await nextRequest(pending)
      assertCursor(requests, 'page-60')
      await expect(items(page)).toHaveCount(0)
      const lastRows = rows(59, 65)
      lastRows.at(-1)!.last_agent_reply_at = 2_000
      await respond(last, { sessions: lastRows, total: 65, next_cursor: null })
      await expect(items(page)).toHaveCount(65)
      assert.deepEqual(
        await items(page).evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-testid'))
        ),
        ['saved-64', ...rows(0, 64).map((row) => row.session_id)].map(
          (sessionId) => 'ai-session-' + sessionId
        )
      )
      await page.getByTestId('ai-session-saved-64').focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('ai-session-flyout')).toHaveCount(0)
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'historyProbe').opened), [
        'saved-64',
      ])
    })
)

test(
  'first, continuation and refresh failures retain committed rows and retry a complete cursor traversal',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      await respond(pending.shift()!, {}, 503)
      await page.getByTestId('ai-session-retry').click()
      await reply(await nextRequest(pending), 0, 30, 30)
      assertCursor(requests, null)
      const continuation = await nextRequest(pending)
      assertCursor(requests, 'page-30')
      await respond(continuation, {}, 503)
      await expect(page.getByTestId('ai-session-retry')).toBeVisible()
      await expect(items(page)).toHaveCount(0)
      await page.getByTestId('ai-session-retry').click()
      const restarted = await nextRequest(pending)
      assertCursor(requests, null)
      await reply(restarted, 0, 30, 30)
      await reply(await nextRequest(pending), 30, 65, null)
      await expect(items(page)).toHaveCount(65)

      await refresh(page)
      await respond(await nextRequest(pending), {}, 503)
      await expect(items(page)).toHaveCount(65)
      await page.getByTestId('ai-session-retry').click()
      await reply(await nextRequest(pending), 0, 30, 30)
      await respond(await nextRequest(pending), {}, 503)
      await expect(items(page)).toHaveCount(65)
      await page.getByTestId('ai-session-retry').click()
      const replacement = await nextRequest(pending)
      assertCursor(requests, null)
      await reply(replacement, 0, 10, null)
      await expect(items(page)).toHaveCount(10)
    })
)

test(
  'keyboard retry and automatic continuation retain search focus until Escape restores the trigger',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending) => {
      const search = page.getByTestId('ai-session-search')
      await respond(pending.shift()!, {}, 503)
      const retry = page.getByTestId('ai-session-retry')
      await retry.focus()
      await page.keyboard.press('Enter')
      const restarted = await nextRequest(pending)
      await expect(search).toBeFocused()
      await reply(restarted, 0, 30, 30)
      const second = await nextRequest(pending)
      await expect(search).toBeFocused()
      await reply(second, 30, 60, 60)
      const last = await nextRequest(pending)
      await expect(search).toBeFocused()
      await reply(last, 60, 65, null)
      await expect(items(page)).toHaveCount(65)
      await expect(search).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('ai-session-flyout')).toHaveCount(0)
      await expect(page.getByTestId('ai-session-toggle')).toBeFocused()
    })
)

test(
  'clearing search restores complete cursor history and retries a failed traversal',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      await reply(pending.shift()!, 0, 30, null)
      await expect(items(page)).toHaveCount(30)
      const search = page.getByTestId('ai-session-search')
      await search.fill('needle')
      await reply(await nextRequest(pending), 64, 65, null)
      await expect(items(page)).toHaveCount(1)
      await search.fill('')
      const first = await nextRequest(pending)
      assert.equal(requests.at(-1)!.searchParams.has('query'), false)
      assertCursor(requests, null)
      await reply(first, 0, 30, 30)
      const second = await nextRequest(pending)
      assertCursor(requests, 'page-30')
      await respond(second, {}, 503)
      await expect(page.getByTestId('ai-session-retry')).toBeVisible()
      await page.getByTestId('ai-session-retry').click()
      const restarted = await nextRequest(pending)
      assertCursor(requests, null)
      await reply(restarted, 0, 30, 30)
      await reply(await nextRequest(pending), 30, 60, 60)
      await reply(await nextRequest(pending), 59, 65, null)
      await expect(items(page)).toHaveCount(65)
      await expect(search).toBeFocused()
    })
)

test(
  'Escape during automatic continuation rejects the late page and restores trigger focus',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      await reply(pending.shift()!, 0, 30, 30)
      const continuation = await nextRequest(pending)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('ai-session-flyout')).toHaveCount(0)
      await expect(page.getByTestId('ai-session-toggle')).toBeFocused()
      await reply(await nextRequest(pending), 40, 41, null)
      const requestCount = requests.length
      await reply(continuation, 30, 60, 60)
      await page.getByTestId('ai-session-toggle').press('Enter')
      const reopened = await nextRequest(pending)
      assert.equal(requests.length, requestCount + 1)
      await reply(reopened, 40, 41, null)
      await expect(items(page)).toHaveCount(1)
      await expect(page.getByTestId('ai-session-saved-40')).toBeVisible()
    })
)

for (const change of ['project', 'query', 'close'] as const) {
  test(
    'cleared-search cursor traversal is invalidated when ' + change + ' changes',
    { timeout: 60_000 },
    async () =>
      fixture(async (page, pending, requests) => {
        await reply(pending.shift()!, 0, 30, null)
        const search = page.getByTestId('ai-session-search')
        await search.fill('needle')
        await reply(await nextRequest(pending), 64, 65, null)
        await expect(items(page)).toHaveCount(1)
        await search.fill('')
        await reply(await nextRequest(pending), 0, 30, 30)
        const oldPage = await nextRequest(pending)
        if (change === 'project') {
          await page.evaluate(() =>
            Reflect.get(window, 'historyProbe').patch({ projectPath: null })
          )
        } else if (change === 'query') {
          await search.fill('another')
        } else {
          await page.keyboard.press('Escape')
          await expect(page.getByTestId('ai-session-toggle')).toBeFocused()
        }
        await reply(await nextRequest(pending), 40, 41, null)
        const requestCount = requests.length
        await reply(oldPage, 30, 60, 60)
        if (change === 'close') {
          await page.getByTestId('ai-session-toggle').press('Enter')
          await reply(await nextRequest(pending), 40, 41, null)
        }
        await expect(items(page)).toHaveCount(1)
        await expect(page.getByTestId('ai-session-saved-40')).toBeVisible()
        assert.equal(requests.length, requestCount + (change === 'close' ? 1 : 0))
        assert.equal(pending.length, 0)
      })
  )
}

test(
  'scope and immediate query changes hide stale rows and reject late responses',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      const oldProject = pending.shift()!
      await page.evaluate(() =>
        Reflect.get(window, 'historyProbe').patch({ projectPath: '/project-b' })
      )
      await reply(await nextRequest(pending), 40, 41, null)
      await reply(oldProject, 0, 30, 30)
      await expect(items(page)).toHaveCount(1)
      await expect(page.getByTestId('ai-session-saved-40')).toBeVisible()
      const search = page.getByTestId('ai-session-search')
      await search.fill('needle')
      await expect(items(page)).toHaveCount(0)
      const oldSearch = await nextRequest(pending)
      await search.fill('new needle')
      const currentSearch = await nextRequest(pending)
      assert.equal(requests.at(-1)!.searchParams.get('query'), 'new needle')
      await reply(currentSearch, 50, 51, null)
      await reply(oldSearch, 40, 41, 41)
      await expect(page.getByTestId('ai-session-saved-50')).toBeVisible()
      await expect(items(page)).toHaveCount(1)
      await page.evaluate(() => Reflect.get(window, 'historyProbe').patch({ projectPath: null }))
      const unassigned = await nextRequest(pending)
      assert.equal(requests.at(-1)!.searchParams.get('scope'), 'unassigned')
      assert.equal(requests.at(-1)!.searchParams.has('project_path'), false)
      await reply(unassigned, 60, 61, null)
      await expect(page.getByTestId('ai-session-saved-60')).toBeVisible()
      assert.equal(pending.length, 0)
    })
)

test(
  'close and prewarm cannot overwrite reopened results or let hidden rows end cursor traversal',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      const initial = pending.shift()!
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('ai-session-flyout')).toHaveCount(0)
      const prewarm = await nextRequest(pending)
      await page.getByTestId('ai-session-toggle').click()
      const reopened = await nextRequest(pending)
      await page.evaluate(() =>
        Reflect.get(window, 'historyProbe').patch({
          threads: Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => ['saved-' + index, { surface: 'workbench' }])
          ),
        })
      )
      await reply(reopened, 0, 30, 30)
      const continuation = await nextRequest(pending)
      assertCursor(requests, 'page-30')
      await reply(initial, 40, 41, 41)
      await reply(prewarm, 50, 51, 51)
      await reply(continuation, 30, 31, null)
      await expect(items(page)).toHaveCount(1)
      await expect(page.getByTestId('ai-session-saved-30')).toBeVisible()
      await page.getByTestId('ai-session-saved-30').focus()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('ai-session-toggle')).toBeFocused()
    })
)

test(
  'a repeated continuation cursor fails without looping and can be retried from the first page',
  { timeout: 60_000 },
  async () =>
    fixture(async (page, pending, requests) => {
      await reply(pending.shift()!, 0, 30, 30)
      await reply(await nextRequest(pending), 30, 60, 30)
      await expect(page.getByTestId('ai-session-retry')).toBeVisible()
      await expect(items(page)).toHaveCount(0)
      assert.equal(pending.length, 0)
      await page.getByTestId('ai-session-retry').click()
      const restarted = await nextRequest(pending)
      assertCursor(requests, null)
      await reply(restarted, 0, 65, null)
      await expect(items(page)).toHaveCount(65)
    })
)
