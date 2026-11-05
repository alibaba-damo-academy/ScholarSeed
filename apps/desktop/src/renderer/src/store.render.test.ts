import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect, type Page } from '@playwright/test'
import { renderFixture } from '../../test-helpers/render.ts'

import type { ModelInfo } from './api'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

test(
  'message dismissals wait for persistence, survive unrelated updates and recover through retry',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const key = JSON.stringify(['imports', 'old-task'])
      await page.evaluate((key) => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = true
        void probe.clearMessages({ [key]: 7 })
      }, key)
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending === 1)
      assert.deepEqual(
        await page.evaluate(
          () => Reflect.get(window, 'preferenceProbe').state.taskMessageDismissals
        ),
        {}
      )
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.patch({ theme: 'dark' })
        probe.release()
        probe.hold = false
      })
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.taskMessageDismissals)
        )
        .toEqual({ [key]: 7 })
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.taskMessageDismissals)
        )
        .toEqual({ [key]: 7 })
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = true
        void probe.clearMessages({ failed: 9 })
      })
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending === 1)
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').fail())
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      assert.deepEqual(
        await page.evaluate(
          () => Reflect.get(window, 'preferenceProbe').state.taskMessageDismissals
        ),
        { [key]: 7 }
      )
      await page.evaluate(() => {
        Reflect.get(window, 'preferenceProbe').hold = false
      })
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.taskMessageDismissals)
        )
        .toEqual({ [key]: 7, failed: 9 })
    })
)

for (const target of ['project', 'session', 'document']) {
  test(
    `missing restored ${target} returns home and saves a clean location`,
    { timeout: 60_000 },
    async () =>
      fixture(
        async (page) => {
          await page.evaluate(() =>
            Reflect.get(window, 'preferenceProbe').patch({
              workspaceLoadState: 'ready',
              projectsLoaded: true,
            })
          )
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.lastLocation)
            )
            .toEqual({
              view: 'home',
              projectId: null,
              sessionId: null,
              sessionProjectId: null,
              settingsPage: null,
              browserSettingsSection: null,
              aiPanelOpen: false,
              aiPanelCover: false,
              target: null,
            })
        },
        async (page) => {
          await page.addInitScript((target) => {
            localStorage.setItem(
              'scholarseed.web.preferences',
              JSON.stringify({
                lastLocation: {
                  view: 'resource',
                  projectId: target === 'project' ? 'removed-project' : null,
                  sessionId: target === 'session' ? 'removed-session' : null,
                  settingsPage: 'skills',
                  aiPanelOpen: true,
                  target:
                    target === 'document'
                      ? {
                          kind: 'document',
                          viewKind: 'edit',
                          title: 'Missing',
                          source: { kind: 'project', project: null, path: 'missing.md' },
                        }
                      : null,
                },
              })
            )
          }, target)
          await page.route('**/api/serve/sessions/removed-session/navigation', (route) =>
            route.fulfill({
              status: 404,
              json: { detail: { code: 'session_not_found', message: 'missing' } },
            })
          )
          await page.route('**/api/workbench/open?**', (route) =>
            route.fulfill({ status: 404, json: { detail: 'missing' } })
          )
        }
      )
  )
}

for (const target of ['current', 'other']) {
  for (const floating of ['minimized', 'compact', 'expanded']) {
    test(
      `opening ${target} task restores only minimized conversation (${floating})`,
      { timeout: 60_000 },
      async () =>
        fixture(async (page) => {
          const result = await page.evaluate(
            async ({ target, floating }) => {
              const probe = Reflect.get(window, 'preferenceProbe')
              const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
              probe.patch({
                activeSession: 'current',
                mainView: 'conversation',
                workbenchLayout: {
                  ...probe.state.workbenchLayout,
                  open: true,
                  full: floating === 'minimized',
                  floating,
                  floatingRestore: 'expanded',
                },
              })
              await frame()
              const before = structuredClone({
                layout: probe.state.workbenchLayout,
                tabs: probe.state.tabs,
                activeTab: probe.state.activeTab,
              })
              probe.openSession(target)
              await frame()
              return {
                before,
                layout: probe.state.workbenchLayout,
                tabs: probe.state.tabs,
                activeTab: probe.state.activeTab,
                activeSession: probe.state.activeSession,
                mainView: probe.state.mainView,
                panelOpen: probe.state.aiPanel.open,
              }
            },
            { target, floating }
          )
          assert.equal(result.activeSession, target)
          assert.equal(result.mainView, 'resource')
          assert.equal(result.panelOpen, true)
          assert.deepEqual(result.layout, {
            ...result.before.layout,
            floating: floating === 'minimized' ? 'expanded' : floating,
          })
          assert.deepEqual(result.tabs, result.before.tabs)
          assert.equal(result.activeTab, result.before.activeTab)
        })
    )
  }
}

for (const panel of [false, true]) {
  test(
    `new ${panel ? 'panel' : 'global'} draft leaves the legacy conversation shell`,
    { timeout: 60_000 },
    async () =>
      fixture(async (page) => {
        await page.evaluate(() =>
          Reflect.get(window, 'preferenceProbe').patch({
            mainView: 'conversation',
            activeSession: 'current',
          })
        )
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.mainView))
          .toBe('conversation')
        await page.evaluate((panel) => Reflect.get(window, 'preferenceProbe').draft(panel), panel)
        await expect
          .poll(() =>
            page.evaluate(() => {
              const { mainView, activeSession, aiPanel } = Reflect.get(
                window,
                'preferenceProbe'
              ).state
              return { mainView, activeSession, panelOpen: aiPanel.open }
            })
          )
          .toEqual({ mainView: 'resource', activeSession: null, panelOpen: true })
      })
  )
}

const CONVERSATION_MODELS = ['model-a', 'model-b'].map((key) => ({
  key,
  label: key,
  model_name: key,
  source: 'builtin',
  reasoning_efforts: ['low'],
}))
const CONVERSATION_SESSION = 'c'.repeat(32)
const HISTORICAL_SESSION = 'd'.repeat(32)
const REASONING_MODELS: ModelInfo[] = ['model-a', 'model-b'].map((key) => ({
  key,
  label: key,
  model_name: key,
  source: 'builtin',
  reasoning_efforts: ['low', 'medium', 'high'],
  reasoning_options: [{ kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' }],
}))

interface ConversationOptions {
  failure?: string
  persisted?: boolean
  save?: boolean
  deferred?: boolean
  models?: ModelInfo[]
  initialEffort?: string
}

async function conversationFixture(
  page: Page,
  {
    failure = '',
    persisted = true,
    save = true,
    deferred = false,
    models = CONVERSATION_MODELS,
    initialEffort = 'low',
  }: ConversationOptions = {}
) {
  let selected = 'model-a'
  let selectedEffort = initialEffort
  let defaultModel = 'model-a'
  let allowSave = save
  const choices: string[] = []
  const defaults: string[] = []
  const modelRequests: Array<{
    model_id: string
    reasoning_effort: string
    remember_default?: boolean
  }> = []
  const reads: string[] = []
  const snapshot = (sessionId = CONVERSATION_SESSION) => ({
    session_id: sessionId,
    model_id: selected,
    reasoning_effort: selectedEffort,
    default_model_id: defaultModel === selected ? selected : '',
    runtime: {
      name: 'codex',
      model_id: selected,
      reasoning_effort: selectedEffort,
      active_reasoning_effort: failure ? initialEffort : selectedEffort,
    },
  })
  await page.route('**/api/serve/sessions/*/model', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/').at(-2)!
    if (route.request().method() === 'GET') {
      reads.push(sessionId)
      return route.fulfill({ json: snapshot(sessionId) })
    }
    const request = route.request().postDataJSON()
    const target = request.model_id
    if (target !== selected) assert.equal(request.remember_default, true)
    choices.push(target)
    modelRequests.push(request)
    if (persisted) {
      selected = target
      selectedEffort = request.reasoning_effort ?? selectedEffort
      if (request.remember_default) {
        defaults.push(target)
        if (allowSave) defaultModel = target
      }
    }
    return route.fulfill(
      failure
        ? { status: 409, json: { ok: false, error: failure } }
        : { json: { ok: true, ...snapshot(sessionId), deferred } }
    )
  })
  await page.route('**/api/serve/models/default', (route) => {
    const request = route.request().postDataJSON()
    assert.equal(request.persist, true)
    defaults.push(request.model_key)
    return route.fulfill(
      allowSave
        ? {
            json: {
              configured: true,
              service_instance_id: 'instance',
              current_model: request.model_key,
              available_models: models,
            },
          }
        : { status: 503 }
    )
  })
  await page.route('**/api/serve/sessions/*/runtime/reconfigure', (route) =>
    route.fulfill({
      json: {
        session_id: CONVERSATION_SESSION,
        request_id: '12345678-1234-1234-1234-123456789abc',
        model_id: selected,
        state: 'accepted',
        error: '',
      },
    })
  )
  await page.evaluate(
    ({ models, session, effort }) => {
      Reflect.get(window, 'preferenceProbe').patch({
        model: 'model-a',
        activeSession: session,
        serviceInstanceId: 'instance',
        catalog: { models, hiddenModels: [], subscriptionGroups: [], personalProfiles: [] },
        threads: {
          [session]: { runtime: { name: 'codex', model_id: 'model-a', reasoning_effort: effort } },
        },
      })
    },
    { models, session: CONVERSATION_SESSION, effort: initialEffort }
  )
  await expect(page.getByTestId('model-selector-toggle')).toContainText('model-a')
  return {
    choices,
    defaults,
    modelRequests,
    reads,
    restore: (model: string, effort: string) => {
      selected = model
      selectedEffort = effort
    },
    allowSave: () => {
      allowSave = true
    },
  }
}

async function chooseConversationModel(page: Page, key: string): Promise<void> {
  await page.getByTestId('model-selector-toggle').click()
  await page.getByTestId(`model-option-${key}`).click()
  await expect(page.getByTestId('model-selector-toggle')).toBeEnabled()
}

async function waitForEffortSelection(page: Page): Promise<void> {
  await expect(page.getByTestId('model-selector-toggle')).toHaveAttribute('aria-busy', 'false')
  await page.waitForFunction(
    () => Reflect.get(window, 'preferenceProbe').state.modelSelectionPending === 0
  )
}

for (const target of ['current', 'other']) {
  test(
    `foreground task navigation reveals ${target} task without replacing document tabs`,
    { timeout: 60_000 },
    async () =>
      fixture(async (page) => {
        for (const floating of ['minimized', 'compact', 'expanded']) {
          const result = await page.evaluate(
            async ({ target, floating }) => {
              const probe = Reflect.get(window, 'preferenceProbe')
              const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
              probe.patch({
                activeSession: 'current',
                mainView: 'resource',
                activeTab: 'document-tab',
                workbenchLayout: {
                  ...probe.state.workbenchLayout,
                  open: true,
                  full: true,
                  taskTab: false,
                  floating,
                  floatingRestore: 'expanded',
                },
              })
              await frame()
              const before = structuredClone(probe.state.workbenchLayout)
              probe.openSession(target, 'assistant')
              await frame()
              const assistantLayout = structuredClone(probe.state.workbenchLayout)
              probe.patch({ activeSession: 'current' })
              await frame()
              probe.openSession(target, 'task')
              await frame()
              return {
                before,
                assistantLayout,
                layout: probe.state.workbenchLayout,
                activeTab: probe.state.activeTab,
                activeSession: probe.state.activeSession,
              }
            },
            { target, floating }
          )
          assert.equal(result.activeSession, target)
          assert.equal(result.activeTab, 'document-tab')
          assert.equal(result.assistantLayout.taskTab, false)
          assert.deepEqual(result.layout, {
            ...result.before,
            taskTab: true,
            floating: floating === 'minimized' ? 'expanded' : floating,
          })
        }
      })
  )
}

test(
  'controlled model menu publishes only changed choices without session or default mutations',
  { timeout: 60_000 },
  async () =>
    fixture(
      async (page) => {
        const conversation = await conversationFixture(page)
        await chooseConversationModel(page, 'model-a')
        await expect(page.getByTestId('controlled-choices')).toHaveText('[]')
        await chooseConversationModel(page, 'model-b')
        await expect(page.getByTestId('controlled-choices')).toHaveText('["model-b"]')
        await expect(page.getByTestId('model-selector-toggle')).toContainText('model-b')
        await expect(page.getByTestId('default-model')).toHaveText('model-a')
        assert.deepEqual(conversation.choices, [])
        assert.deepEqual(conversation.defaults, [])
      },
      async (page) => {
        await page.addInitScript(() => Reflect.set(window, 'controlledModelFixture', true))
      }
    )
)

test(
  'choosing the same session model retries only failed default persistence',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const conversation = await conversationFixture(page, { save: false })
      await chooseConversationModel(page, 'model-a')
      await waitForEffortSelection(page)
      await expect(page.getByTestId('model-error')).toContainText('models.defaultFailed')
      conversation.allowSave()
      await chooseConversationModel(page, 'model-a')
      await waitForEffortSelection(page)
      await expect(page.getByTestId('model-error')).toHaveText('null')
      assert.deepEqual(conversation.choices, [])
      assert.deepEqual(conversation.defaults, ['model-a', 'model-a'])
    })
)

test(
  'pending model selection cannot disable another session effort control',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await conversationFixture(page, { models: REASONING_MODELS })
      let release = () => {}
      let entered = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      await page.route('**/api/serve/sessions/*/model', async (route) => {
        if (route.request().method() === 'POST') {
          entered()
          await pending
        }
        await route.fallback()
      })
      try {
        await page.getByTestId('model-selector-toggle').click()
        await page.getByTestId('model-option-model-b').click()
        await started
        await expect(page.getByTestId('model-selector-toggle')).toBeDisabled()
        await page.evaluate((session) => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.patch({
            activeSession: session,
            threads: {
              ...probe.state.threads,
              [session]: {
                runtime: { name: 'codex', model_id: 'model-a', reasoning_effort: 'low' },
              },
            },
          })
        }, HISTORICAL_SESSION)
        await expect(page.getByTestId('model-selector-toggle')).toBeEnabled()
        await page.getByTestId('model-selector-toggle').click()
        await expect(page.getByTestId('model-effort-row')).toBeEnabled()
        await page.keyboard.press('Escape')
      } finally {
        release()
      }
      await waitForEffortSelection(page)
    })
)

async function fixture(
  run: (page: Page) => Promise<void>,
  prepare?: (page: Page) => Promise<void>
): Promise<void> {
  const rendered = await renderFixture(ROOT)
  try {
    const page = await rendered.browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await prepare?.(page)
    await page.goto(new URL('/store.render.fixture.html', rendered.url).href)
    await expect(page.getByTestId('model')).toBeAttached()
    await page.waitForTimeout(200)
    await run(page)
    assert.deepEqual(
      errors.filter((message) => message !== 'navigation recovery test crash'),
      []
    )
  } finally {
    await rendered.close()
  }
}

test('render failure can return home without reloading the store', { timeout: 60_000 }, async () =>
  fixture(async (page) => {
    await page.evaluate(() =>
      Reflect.get(window, 'preferenceProbe').patch({
        mainView: 'writing',
        accountSettingsPage: 'skills',
        homeSelectedProjectId: 'unavailable-project',
        activeSession: 'unavailable-session',
        workspaceLoadState: 'error',
        navigationRestored: false,
      })
    )
    await expect(page.getByRole('button', { name: '返回项目中心', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
    await expect(page.getByTestId('model')).toBeAttached()
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.lastLocation?.view)
      )
      .toBe('home')
    const state = await page.evaluate(() => {
      const probe = Reflect.get(window, 'preferenceProbe')
      return {
        view: probe.state.mainView,
        project: probe.state.homeSelectedProjectId,
        session: probe.state.activeSession,
        settings: probe.state.accountSettingsPage,
        load: probe.state.workspaceLoadState,
      }
    })
    assert.deepEqual(state, {
      view: 'home',
      project: null,
      session: null,
      settings: null,
      load: 'error',
    })
  })
)

for (const scenario of [
  {
    target: 'session',
    outcome: 'success',
    route: '/api/serve/sessions/restore-session/navigation',
  },
  {
    target: 'session',
    outcome: 'missing',
    route: '/api/serve/sessions/restore-session/navigation',
  },
  {
    target: 'session',
    outcome: 'failure',
    route: '/api/serve/sessions/restore-session/navigation',
  },
  { target: 'document', outcome: 'missing', route: '/api/workbench/open' },
  { target: 'document', outcome: 'failure', route: '/api/workbench/open' },
  { target: 'tab', outcome: 'failure', route: '/api/literature/searches' },
]) {
  const { outcome, target } = scenario
  test(
    `return home persists and rejects a late ${target} restoration ${outcome}`,
    { timeout: 60_000 },
    async () => {
      let release!: () => void
      let requested!: () => void
      let requestCount = 0
      const arrived = new Promise<void>((resolve) => {
        requested = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await fixture(
        async (page) => {
          await page.evaluate(() => {
            Reflect.get(window, 'preferenceProbe').patch({
              workspaceLoadState: 'ready',
              projectsLoaded: true,
            })
          })
          await arrived
          await page.evaluate(() => Reflect.get(window, 'preferenceProbe').returnHome())
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.lastLocation)
            )
            .toEqual({
              view: 'home',
              projectId: null,
              sessionId: null,
              sessionProjectId: null,
              settingsPage: null,
              browserSettingsSection: null,
              aiPanelOpen: false,
              aiPanelCover: false,
              target: null,
            })
          release()
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'restoreResponseReceived')))
            .toBe(true)
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )
          const state = await page.evaluate(() => {
            const probe = Reflect.get(window, 'preferenceProbe')
            return {
              view: probe.state.mainView,
              session: probe.state.activeSession,
              restored: probe.state.navigationRestored,
              load: probe.state.workspaceLoadState,
              location: probe.disk.lastLocation,
            }
          })
          assert.equal(state.view, 'home')
          assert.equal(state.session, null)
          assert.equal(state.restored, true)
          assert.equal(state.load, 'ready')
          assert.equal(state.location.view, 'home')
        },
        async (page) => {
          await page.addInitScript(
            ({ target, route }) => {
              localStorage.setItem(
                'scholarseed.web.preferences',
                JSON.stringify({
                  lastLocation: {
                    view: target === 'session' ? 'conversation' : 'resource',
                    sessionId: target === 'session' ? 'restore-session' : null,
                    target:
                      target === 'document'
                        ? {
                            kind: 'document',
                            viewKind: 'edit',
                            title: 'Missing',
                            source: { kind: 'project', project: null, path: 'missing.md' },
                          }
                        : target === 'tab'
                          ? { kind: 'tab', id: 'explorer' }
                          : null,
                    aiPanelOpen: true,
                    settingsPage: 'skills',
                  },
                })
              )
              const original = window.fetch
              window.fetch = async (...args) => {
                const response = await original(...args)
                if (String(args[0]).includes(route)) {
                  Reflect.set(window, 'restoreResponseReceived', true)
                }
                return response
              }
            },
            { target, route: scenario.route }
          )
          await page.route(`**${scenario.route}*`, async (route) => {
            requestCount += 1
            if (target !== 'tab' || requestCount >= 2) requested()
            await held
            await route.fulfill({
              status: outcome === 'success' ? 200 : outcome === 'missing' ? 404 : 503,
              json:
                outcome === 'success'
                  ? { session_id: 'restore-session', running: false, title: 'Restored' }
                  : {
                      detail: {
                        code: outcome === 'missing' ? 'session_not_found' : 'unavailable',
                        message: 'unavailable',
                      },
                    },
            })
          })
        }
      )
    }
  )
}

for (const field of ['models', 'recentFiles', 'recentSessions', 'combined']) {
  test(
    `old save receipts cannot roll back newer ${field} or restart automatic saving`,
    { timeout: 60_000 },
    async () =>
      fixture(async (page) => {
        const result = await page.evaluate(async (field) => {
          const probe = Reflect.get(window, 'preferenceProbe')
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
          const update = (stamp: number) => {
            if (field === 'models' || field === 'combined') probe.model(`model-${stamp}`)
            if (field === 'recentFiles' || field === 'combined')
              probe.patch({
                recentFiles: [{ projectId: 'project', path: 'paper.pdf', openedAt: stamp }],
              })
            if (field === 'recentSessions' || field === 'combined')
              probe.patch({ recentSessions: [{ id: 'session', openedAt: stamp }] })
            if (field === 'combined')
              probe.patch({
                recentLiterature: [{ id: 'paper', openedAt: stamp }],
                editorWordWrap: stamp === 2,
              })
            if (field === 'combined') probe.optimistic(stamp)
          }
          probe.hold = true
          update(1)
          await frame()
          await frame()
          update(2)
          await frame()
          await frame()
          const latest = JSON.stringify({
            models: probe.state.literatureAiModels,
            files: probe.state.recentFiles,
            sessions: probe.state.recentSessions,
            literature: probe.state.recentLiterature,
            wrap: probe.state.editorWordWrap,
          })
          const projections = probe.projections.length
          const saves = probe.saves.length
          for (let step = 0; step < 6 && probe.pending; step += 1) {
            probe.release()
            await frame()
            await frame()
          }
          if (field === 'combined') {
            if (
              probe.state.onboarding.recentProjectId !== 'project-2' ||
              probe.disk.onboarding.recentProjectId !== 'project-2'
            )
              throw new Error('onboarding intent lost')
            if (
              probe.shortcut[0]?.key !== 'y' ||
              probe.disk.shortcutOverrides['code.save']?.key !== 'y'
            )
              throw new Error('shortcut intent lost')
          }
          return {
            latest,
            current: JSON.stringify({
              models: probe.state.literatureAiModels,
              files: probe.state.recentFiles,
              sessions: probe.state.recentSessions,
              literature: probe.state.recentLiterature,
              wrap: probe.state.editorWordWrap,
            }),
            disk: JSON.stringify({
              models: probe.disk.literatureAiModels,
              files: probe.disk.recentFiles,
              sessions: probe.disk.recentSessions,
              literature: probe.disk.recentLiterature,
              wrap: probe.disk.editorWordWrap,
            }),
            projections,
            after: probe.projections.length,
            pending: probe.pending,
            saves,
            saved: probe.saves.length,
          }
        }, field)
        assert.equal(result.current, result.latest)
        assert.equal(result.disk, result.latest)
        const latest = JSON.parse(result.latest)
        if (field === 'models' || field === 'combined')
          assert.equal(latest.models.selection_translation, 'model-2')
        if (field === 'recentFiles' || field === 'combined')
          assert.deepEqual(latest.files, [{ projectId: 'project', path: 'paper.pdf', openedAt: 2 }])
        if (field === 'recentSessions' || field === 'combined')
          assert.deepEqual(latest.sessions, [{ id: 'session', openedAt: 2 }])
        assert.equal(result.after, result.projections)
        assert.equal(result.pending, 0)
        assert.ok(result.saved <= result.saves + 1)
        const stable = await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          return [probe.saves.length, probe.projections.length]
        })
        await page.waitForTimeout(300)
        assert.deepEqual(
          await page.evaluate(() => {
            const probe = Reflect.get(window, 'preferenceProbe')
            return [probe.saves.length, probe.projections.length]
          }),
          stable
        )
      })
  )
}

test(
  'failed model save retains local intent and explicit retry persists it without rollback',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = true
        probe.model('latest-model')
        probe.optimistic(2)
      })
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending === 1)
      await page.evaluate(async () => {
        const probe = Reflect.get(window, 'preferenceProbe')
        for (let step = 0; step < 3 && probe.pending; step += 1) {
          probe.fail()
          await new Promise((resolve) => requestAnimationFrame(resolve))
          await new Promise((resolve) => requestAnimationFrame(resolve))
        }
      })
      assert.equal(await page.evaluate(() => Reflect.get(window, 'preferenceProbe').pending), 0)
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      await expect(page.getByTestId('model')).toHaveText('latest-model')
      await page.evaluate(() => {
        Reflect.get(window, 'preferenceProbe').hold = false
      })
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'preferenceProbe').disk.literatureAiModels.selection_translation ===
          'latest-model'
      )
      await expect(page.getByTestId('model')).toHaveText('latest-model')
      assert.deepEqual(
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          return [
            probe.state.onboarding.recentProjectId,
            probe.disk.onboarding.recentProjectId,
            probe.shortcut[0].key,
            probe.disk.shortcutOverrides['code.save'].key,
          ]
        }),
        ['project-2', 'project-2', 'y', 'y']
      )
    })
)

test(
  'language and selection prompts still change only after persistence confirmation',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const initial = await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = true
        void probe.prompts('confirmed instruction')
        return { prompt: probe.state.selectionPrompts.translate, language: probe.state.lang }
      })
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending === 1)
      assert.equal(
        await page.evaluate(
          () => Reflect.get(window, 'preferenceProbe').state.selectionPrompts.translate
        ),
        initial.prompt
      )
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').release())
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'preferenceProbe').state.selectionPrompts.translate ===
          'confirmed instruction'
      )
      const targetLanguage = initial.language === 'zh' ? 'en' : 'zh'
      await page.evaluate((language) => {
        void Reflect.get(window, 'preferenceProbe').language(language)
      }, targetLanguage)
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending === 1)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.lang),
        initial.language
      )
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').release())
      await page.waitForFunction(
        (language) => Reflect.get(window, 'preferenceProbe').state.lang === language,
        targetLanguage
      )
    })
)
