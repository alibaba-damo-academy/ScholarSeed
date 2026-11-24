import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect, type Page, chromium } from '@playwright/test'
import { renderFixture } from '../../test-helpers/render.ts'
import type { ModelInfo } from './api.ts'
import type { AppState } from './store'
import { STARTUP_TASK_RECOVERY_MS } from './startup.ts'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

test(
  'project menu batched navigation preserves draft text, references and persisted owners',
  { timeout: 60_000 },
  async () =>
    fixture(
      async (page) => {
        await page.evaluate(() => {
          Reflect.get(window, 'preferenceProbe').patch({
            projects: [
              { id: 'project-a', path: '/project-a', name: 'A' },
              { id: 'project-b', path: '/project-b', name: 'B' },
              { id: 'project-c', path: '/project-c', name: 'C' },
            ],
            projectsLoaded: true,
            workspaceLoadState: 'ready',
            workbenchReady: true,
            navigationRestored: true,
          })
        })
        const selectProject = (name: string): Promise<void> =>
          page.getByTestId(`project-menu-option-${name}`).click()
        const text = (): Promise<string> =>
          page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft())
        const saved = (projectId: string): Promise<{ text: string; refs: { id: string }[] }> =>
          page.evaluate((projectId) => {
            const probe = Reflect.get(window, 'preferenceProbe')
            return JSON.parse(probe.disk.composerDrafts || '[]').find(
              ([key]: [string]) => key === JSON.stringify(['scope', projectId])
            )?.[1]
          }, projectId)
        await selectProject('A')
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.draft('Project A unsent')
          probe.patch({
            composerRefs: [
              { type: 'file', id: 'red', title: 'red.png', path: '', localSource: {} },
              { type: 'file', id: 'notes', title: 'notes.txt', path: '', localSource: {} },
            ],
          })
        })
        await expect.poll(async () => (await saved('project-a'))?.text).toBe('Project A unsent')
        await selectProject('B')
        await expect.poll(text).toBe('')
        await expect.poll(async () => (await saved('project-a'))?.text).toBe('Project A unsent')
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft('Project B unsent'))
        await selectProject('C')
        await expect.poll(text).toBe('')
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft('Project C unsent'))
        await selectProject('A')
        await expect.poll(text).toBe('Project A unsent')
        assert.deepEqual(
          await page.evaluate(() =>
            Reflect.get(window, 'preferenceProbe').state.composerRefs.map(
              (reference: { id: string }) => reference.id
            )
          ),
          ['red', 'notes']
        )
        assert.deepEqual(
          (await saved('project-a')).refs.map((reference) => reference.id),
          ['red', 'notes']
        )
        await page.getByTestId('project-menu-home').click()
        await selectProject('A')
        await expect.poll(text).toBe('Project A unsent')
        for (const project of ['A', 'B', 'C', 'A']) {
          await selectProject(project)
          await expect.poll(text).toBe(`Project ${project} unsent`)
        }
        await selectProject('A')
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft(''))
        await expect.poll(async () => (await saved('project-a'))?.text).toBe('')
        await selectProject('B')
        await expect.poll(text).toBe('Project B unsent')
        await selectProject('A')
        await expect.poll(text).toBe('')
        assert.equal((await saved('project-a')).refs.length, 2)
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.draft('')
          probe.draft('New input')
          probe.patch({ composerRefs: probe.state.composerRefs.slice(1) })
        })
        await selectProject('B')
        await selectProject('A')
        await expect.poll(text).toBe('New input')
        await expect.poll(async () => (await saved('project-a'))?.text).toBe('New input')
        assert.deepEqual(
          (await saved('project-a')).refs.map((reference) => reference.id),
          ['notes']
        )
      },
      async (page) => {
        await page.addInitScript(() => Reflect.set(window, 'draftNavigationFixture', true))
      }
    )
)

test(
  'project center return and unchanged background patches preserve drafts',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.patch({
          projects: [{ id: 'project-a', path: '/project-a', name: 'A' }],
          projectsLoaded: true,
          workspaceLoadState: 'ready',
          workbenchReady: true,
          navigationRestored: true,
        })
      })
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-a'))
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').center())
      for (const view of ['literature', 'skills']) {
        await page.evaluate((view) => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.draft(`Unsent before ${view}`)
        }, view)
        await page.evaluate((view) => Reflect.get(window, 'preferenceProbe').view(view), view)
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').center())
        await page.evaluate(() =>
          Reflect.get(window, 'preferenceProbe').patch((current: AppState) => current)
        )
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft()))
          .toBe(`Unsent before ${view}`)
        await expect
          .poll(() =>
            page.evaluate(() => {
              const probe = Reflect.get(window, 'preferenceProbe')
              return JSON.parse(probe.disk.composerDrafts).find(
                ([key]: [string, { text: string }]) =>
                  key === JSON.stringify(['scope', 'project-a'])
              )?.[1].text
            })
          )
          .toBe(`Unsent before ${view}`)
      }
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').patch({ composerText: '' }))
      assert.equal(await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft()), '')
      await page.evaluate(() =>
        Reflect.get(window, 'preferenceProbe').draft('New input after clearing')
      )
      await page.evaluate(() =>
        Reflect.get(window, 'preferenceProbe').patch((current: AppState) => current)
      )
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft()),
        'New input after clearing'
      )
    })
)

test(
  'new project drafts retain text and explicit context across navigation, other projects and renderer reopening',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const initialize = async (): Promise<void> => {
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.patch({
            projects: [
              { id: 'project-a', path: '/project-a', name: 'A' },
              { id: 'project-b', path: '/project-b', name: 'B' },
            ],
            projectsLoaded: true,
            workspaceLoadState: 'ready',
            workbenchReady: true,
            navigationRestored: true,
          })
        })
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-a'))
      }
      const text = (): Promise<string> =>
        page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft())
      await initialize()
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.composerDrafts ?? ''),
        ''
      )
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.draft('Project A unsent')
        probe.patch({
          composerRefs: [
            {
              type: 'file',
              id: 'local-a',
              title: 'a.md',
              path: '/project-a/a.md',
              localSource: {},
            },
          ],
          aiPanel: {
            ...probe.state.aiPanel,
            refs: [
              {
                ref_id: 'selection-a',
                kind: 'selection',
                source_id: 'a.md',
                label: 'A selection',
                retention: 'next_turn',
                origin: 'explicit',
              },
            ],
          },
        })
      })
      for (const view of ['literature', 'skills']) {
        await page.evaluate((view) => Reflect.get(window, 'preferenceProbe').view(view), view)
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-a'))
        await expect.poll(text).toBe('Project A unsent')
        const snapshot = await page.evaluate(() => {
          const state = Reflect.get(window, 'preferenceProbe').state
          return {
            session: state.activeSession,
            file: state.composerRefs[0]?.id,
            context: state.aiPanel.refs[0]?.ref_id,
            submit: state.composerSubmitRequested,
          }
        })
        assert.deepEqual(snapshot, {
          session: null,
          file: 'local-a',
          context: 'selection-a',
          submit: false,
        })
      }
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-b'))
      await expect.poll(text).toBe('')
      assert.deepEqual(
        await page.evaluate(() => {
          const state = Reflect.get(window, 'preferenceProbe').state
          return [state.composerRefs.length, state.aiPanel.refs.length]
        }),
        [0, 0]
      )
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft('Project B unsent'))
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-a'))
      await expect.poll(text).toBe('Project A unsent')
      await page.reload()
      await expect(page.getByTestId('model')).toBeAttached()
      assert.match(
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.composerDrafts),
        /Project A unsent/
      )
      await initialize()
      await expect.poll(text).toBe('Project A unsent')
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-b'))
      await expect.poll(text).toBe('Project B unsent')
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = true
        probe.draft('Write failure retains memory')
      })
      await page.waitForFunction(() => Reflect.get(window, 'preferenceProbe').pending > 0)
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').fail())
      await expect.poll(text).toBe('Write failure retains memory')
      assert.doesNotMatch(
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.composerDrafts),
        /Write failure retains memory/
      )
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.hold = false
        probe.draft('Project B unsent')
      })
      await page.evaluate(() => {
        Reflect.get(window, 'preferenceProbe').openDraftSession(
          'promoted-session',
          'First task',
          '/project-b',
          '/project-b',
          {
            runtimeId: 'codex',
            runtime: { name: 'codex', model_id: '' },
            readiness: {},
            capabilities: {},
          },
          'assistant'
        )
      })
      await expect.poll(text).toBe('Project B unsent')
      const drafts = (): Promise<Array<[string, { text: string }]>> =>
        page.evaluate(() =>
          JSON.parse(Reflect.get(window, 'preferenceProbe').disk.composerDrafts || '[]')
        )
      assert.equal(
        (await drafts()).some(([key]) => key === JSON.stringify(['scope', 'project-b'])),
        false
      )
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft(''))
      await expect
        .poll(
          async () =>
            (await drafts()).find(
              ([key]) => key === JSON.stringify(['session', 'promoted-session'])
            )?.[1].text
        )
        .toBe('')
      await page.evaluate(() =>
        Reflect.get(window, 'preferenceProbe').draft('Rejected request restored')
      )
      await page.evaluate(() => Reflect.get(window, 'preferenceProbe').view('literature'))
      await page.evaluate(() =>
        Reflect.get(window, 'preferenceProbe').openSession('promoted-session')
      )
      await expect.poll(text).toBe('Rejected request restored')
    })
)

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

for (const [target, status] of [
  ['project', 404],
  ['session', 404],
  ['session', 503],
  ['document', 404],
  ['document', 403],
  ['tab', 200],
  ['tab', 503],
] as const) {
  test(
    `unavailable restored ${target} (${status}) returns home and saves a clean location`,
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
                      : target === 'tab'
                        ? { kind: 'tab', id: 'literature-search:removed-search' }
                        : null,
                },
              })
            )
          }, target)
          await page.route('**/api/serve/sessions/removed-session/navigation', (route) =>
            route.fulfill({
              status,
              json: {
                detail: { code: status === 404 ? 'session_not_found' : 'unavailable' },
              },
            })
          )
          await page.route('**/api/workbench/open?**', (route) =>
            route.fulfill({ status, json: { detail: 'unavailable' } })
          )
          await page.route('**/api/literature/searches', (route) =>
            target === 'tab'
              ? route.fulfill({
                  status,
                  json: status === 200 ? { items: [] } : { detail: 'unavailable' },
                })
              : route.fallback()
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
        await page.evaluate(
          (panel) => Reflect.get(window, 'preferenceProbe').startDraft(panel),
          panel
        )
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
    deferred,
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

const MENU_GROUP_MODELS: ModelInfo[] = [
  {
    key: 'qwen3.8-max',
    label: 'Qwen 3.8 Max',
    source: 'builtin',
    billing: 'api',
    disabled: true,
    disabled_reason_code: 'gateway_credential_required',
    disabled_reason: '登录后可使用内置模型',
  },
  {
    key: 'qwen3.8-flash-preview',
    label: 'Qwen 3.8 Flash Preview',
    source: 'builtin',
    billing: 'api',
  },
  {
    key: 'personal-aa:liquid/lfm-2.5-1b-instruct',
    label: 'liquid/lfm-2.5-1b-instruct',
    provider_label: 'OpenRouter',
    source: 'personal',
    billing: 'api',
  },
  {
    key: 'personal-bb:qwen2.5-coder-14b-instruct-q5_K_M',
    label: 'qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental',
    provider_label: 'Local Ollama / vLLM',
    source: 'personal',
    billing: 'api',
    reasoning_efforts: ['low', 'medium', 'high'],
  },
  {
    key: 'personal-bb:glm-4.6v-flash-free',
    label: 'glm-4.6v-flash-free',
    provider_label: 'Local Ollama / vLLM',
    source: 'personal',
    billing: 'api',
  },
  {
    key: 'personal-bb:qwen3-vl-235b-a22b-thinking',
    label: 'qwen3-vl-235b-a22b-thinking',
    provider_label: 'Local Ollama / vLLM',
    source: 'personal',
    billing: 'api',
  },
  {
    key: 'personal-cc:gemini-2.5-flash-lite',
    label: 'gemini-2.5-flash-lite',
    provider_label: 'Gemini Direct',
    source: 'personal',
    billing: 'api',
  },
]

test(
  'model menus fit content within bounds and animate without moving the main menu',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.setViewportSize({ width: 1280, height: 840 })
      await page.evaluate((models) => {
        const probe = Reflect.get(window, 'preferenceProbe')
        probe.patch({
          model: 'personal-bb:qwen2.5-coder-14b-instruct-q5_K_M',
          catalog: { models, hiddenModels: [], subscriptionGroups: [], personalProfiles: [] },
        })
      }, MENU_GROUP_MODELS)
      await page.getByTestId('model-selector-toggle').focus()
      await page.getByTestId('model-selector-toggle').press('Enter')
      const menu = page.getByTestId('model-selector-menu')
      await expect(menu).toBeVisible()
      for (const header of [
        /内置模型|Built-in model/,
        'OpenRouter',
        'Local Ollama / vLLM',
        'Gemini Direct',
      ]) {
        await expect(menu.getByText(header, { exact: true })).toHaveCount(1)
      }
      await expect(
        menu.getByTestId('model-option-personal-bb:qwen2.5-coder-14b-instruct-q5_K_M')
      ).toHaveAttribute('data-selected', 'true')
      const truncated = await menu.locator('[data-testid^="model-option-"]').evaluateAll((rows) =>
        rows
          .map((row) => {
            const name = row.querySelector('[data-slot="ellipsis-text"]')
            return name && name.scrollWidth > name.clientWidth ? name.textContent : null
          })
          .filter(Boolean)
      )
      expect(truncated).toContain('qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental')
      await menu
        .getByText('qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental', { exact: true })
        .hover()
      await expect(page.getByRole('tooltip')).toHaveText(
        'qwen2.5-coder-14b-instruct-q5_K_M-long-context-experimental'
      )
      await page.mouse.move(0, 0)
      const boxOf = async (locator: ReturnType<typeof page.getByTestId>) => {
        const box = await locator.boundingBox()
        return (
          box && {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          }
        )
      }
      await expect(page.getByTestId('model-option-qwen3.8-max')).toContainText('登录可用')
      await expect(menu.getByText(/切换后/)).toHaveCount(0)
      const menuBox = await boxOf(menu)
      expect(menuBox?.width).toBe(320)
      const samples = await page.evaluate(async () => {
        const trigger = document.querySelector<HTMLElement>('[data-testid="model-effort-row"]')!
        const main = document.querySelector<HTMLElement>('[data-testid="model-selector-menu"]')!
        const frames: { width: number; right: number; gap: number | null }[] = []
        trigger.click()
        await new Promise<void>((resolve) => {
          const start = performance.now()
          const sample = () => {
            const effort = document.querySelector<HTMLElement>('[data-testid="model-effort-menu"]')
            const effortBox = effort?.getBoundingClientRect()
            const mainBox = main.getBoundingClientRect()
            frames.push({
              width: effortBox?.width ?? 0,
              right: mainBox.right,
              gap: effortBox ? mainBox.left - effortBox.right : null,
            })
            if (performance.now() - start < 500) requestAnimationFrame(sample)
            else resolve()
          }
          requestAnimationFrame(sample)
        })
        return frames
      })
      const effortMenu = page.getByTestId('model-effort-menu')
      await expect(effortMenu).toBeVisible()
      const effortBox = await boxOf(effortMenu)
      expect(effortBox?.width).toBe(200)
      expect(samples.some(({ width }) => width > 0 && width < 199)).toBe(true)
      expect(
        Math.max(...samples.map(({ right }) => right)) -
          Math.min(...samples.map(({ right }) => right))
      ).toBeLessThanOrEqual(1)
      expect(samples.filter(({ width }) => width > 0).every(({ gap }) => gap === 8)).toBe(true)
      expect(await boxOf(menu)).toEqual(menuBox)
      expect(effortBox && menuBox && effortBox.x + effortBox.width <= menuBox.x + 1).toBe(true)
      expect(menuBox!.x - effortBox!.x - effortBox!.width).toBe(8)
      await page.screenshot({
        path: path.resolve(ROOT, '../../../test-results/model-menu-groups.png'),
      })
      await page.setViewportSize({ width: 480, height: 800 })
      await expect.poll(async () => (await boxOf(menu))!.width).toBeLessThanOrEqual(224)
      const narrowMain = (await boxOf(menu))!
      const narrowEffort = (await boxOf(effortMenu))!
      expect(narrowEffort.x).toBeGreaterThanOrEqual(0)
      expect(narrowMain.x + narrowMain.width).toBeLessThanOrEqual(480)
      expect(narrowMain.x - narrowEffort.x - narrowEffort.width).toBe(8)
      await page.setViewportSize({ width: 1280, height: 840 })
      await page.getByTestId('model-effort-row').click()
      await expect(effortMenu).not.toBeVisible()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByTestId('model-effort-row').click()
      await expect(effortMenu).toBeVisible()
      await expect(effortMenu).toHaveCSS('transition-property', 'none')
      await page.keyboard.press('Escape')
      await expect(menu).not.toBeVisible()
      await expect(page.getByTestId('model-selector-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      )

      for (const [label, minimum, maximum] of [
        ['Qwen', 200, 200],
        ['Medium length model name', 201, 319],
      ] as const) {
        await page.evaluate((label) => {
          Reflect.get(window, 'preferenceProbe').patch({
            model: 'qwen',
            catalog: {
              models: [{ key: 'qwen', label, source: 'builtin', billing: 'api' }],
              hiddenModels: [],
              subscriptionGroups: [],
              personalProfiles: [],
            },
          })
        }, label)
        await page.getByTestId('model-selector-toggle').click()
        await expect(menu).toBeVisible()
        const width = (await boxOf(menu))!.width
        expect(width).toBeGreaterThanOrEqual(minimum)
        expect(width).toBeLessThanOrEqual(maximum)
        await page.keyboard.press('Escape')
        await expect(menu).not.toBeVisible()
      }
    })
)

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

for (const failure of ['', 'session_model_switch_failed']) {
  test(
    `deferred model selection only announces success when the switch succeeds (${failure || 'success'})`,
    { timeout: 60_000 },
    async () =>
      fixture(async (page) => {
        await conversationFixture(page, { failure, deferred: true })
        await chooseConversationModel(page, 'model-b')
        await waitForEffortSelection(page)
        const feedback = await page.evaluate(() => {
          const state = Reflect.get(window, 'preferenceProbe').state
          return { error: state.foregroundError, notice: state.foregroundNotice }
        })
        if (failure) {
          assert.ok(feedback.error)
          assert.equal(feedback.notice, null)
        } else {
          assert.equal(feedback.error, null)
          assert.ok(feedback.notice)
        }
        await expect(page.getByTestId('model-selector-toggle')).toContainText('model-b')
      })
  )
}

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
  const rendered = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  try {
    const page = await rendered.browser.newPage()
    const errors: string[] = []
    const pendingRequests = new Set<string>()
    page.on('request', (request) => pendingRequests.add(request.url()))
    page.on('requestfinished', (request) => pendingRequests.delete(request.url()))
    page.on('requestfailed', (request) => pendingRequests.delete(request.url()))
    page.on('pageerror', (error) => errors.push(error.message))
    await prepare?.(page)
    await page.goto(new URL('/store.render.fixture.html', rendered.url).href).catch((error) => {
      console.error({ errors, pendingRequests: [...pendingRequests] })
      throw error
    })
    await expect(page.getByTestId('model'), errors.join('\n')).toBeAttached()
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

const MANUAL_RECOVERY_SESSIONS = ['ordinary-first', 'ordinary-second', 'recovery-target']

async function installRecoveryBridge(
  page: Page,
  marker: {
    status: 'eligible' | 'home'
    skippedSessionId: string | null
    needsManualAcknowledgement: boolean
  },
  holdClaim = false
): Promise<void> {
  await page.addInitScript(
    ({ marker, holdClaim }) => {
      const calls: [string, string | null, string?][] = []
      const claim = Promise.withResolvers<string>()
      const finished = Promise.withResolvers<boolean>()
      Reflect.set(window, 'manualRecoveryCalls', calls)
      Reflect.set(window, 'releaseRecoveryClaim', () => claim.resolve('token-from-main'))
      Reflect.set(window, 'releaseRecoveryFinish', () => finished.resolve(true))
      if (holdClaim) {
        localStorage.setItem(
          'scholarseed.web.preferences',
          JSON.stringify({ lastLocation: { view: 'conversation', sessionId: 'recovery-target' } })
        )
      }
      Reflect.set(window, 'taskRecoveryBridgeFixture', {
        getTaskRecoveryStatus: async (sessionId: string | null) => {
          calls.push(['status', sessionId])
          return marker
        },
        beginTaskRecovery: async (sessionId: string) => {
          calls.push(['begin', sessionId])
          return claim.promise
        },
        finishTaskRecovery: async (token: string, outcome: string) => {
          calls.push(['finish', token, outcome])
          return finished.promise
        },
        clearTaskRecoveryOnManualOpen: async (sessionId: string) => {
          const confirmed = Reflect.get(window, 'preferenceProbe').disk.lastLocation?.sessionId
          calls.push(['manual-open', sessionId, confirmed])
          return true
        },
      })
    },
    { marker, holdClaim }
  )
}

async function readyForRecovery(page: Page): Promise<void> {
  await page.evaluate((sessions) => {
    const probe = Reflect.get(window, 'preferenceProbe')
    probe.patch({
      workspaceLoadState: 'ready',
      projectsLoaded: true,
      sessions: sessions.map((id) => ({ id, title: `Renamed ${id}`, status: 'dormant' })),
    })
  }, MANUAL_RECOVERY_SESSIONS)
}

async function openReadyRecoverySession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const probe = Reflect.get(window, 'preferenceProbe')
    probe.openSession(id)
    probe.patch((state: AppState) => ({
      ...state,
      threads: {
        ...state.threads,
        [id]: { ...state.threads[id], resumeState: 'ready' },
      },
    }))
  }, sessionId)
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.lastLocation?.sessionId)
    )
    .toBe(sessionId)
}

const manualRecoveryCalls = (page: Page): Promise<[string, string | null, string?][]> =>
  page.evaluate(() => Reflect.get(window, 'manualRecoveryCalls'))

for (const scope of ['project', 'literature'] as const) {
  test(
    `${scope} continuity cannot reopen or acknowledge the skipped startup task`,
    { timeout: 60_000 },
    async () => {
      await fixture(
        async (page) => {
          await page.evaluate((scope) => {
            const probe = Reflect.get(window, 'preferenceProbe')
            localStorage.setItem(
              'scholarseed.lastConversations',
              JSON.stringify({
                [scope === 'project' ? 'project-a' : 'literature']: 'recovery-target',
                'project-b': 'ordinary-first',
              })
            )
            probe.patch({
              workbenchReady: true,
              workspaceLoadState: 'ready',
              projectsLoaded: true,
              projects: [
                { id: 'project-a', path: '/project-a', name: 'Project A' },
                { id: 'project-b', path: '/project-b', name: 'Project B' },
              ],
              sessions: [
                {
                  id: 'recovery-target',
                  title: 'Prior task',
                  projectPath: scope === 'project' ? '/project-a' : null,
                  status: 'dormant',
                },
                {
                  id: 'ordinary-first',
                  title: 'Unrelated project task',
                  projectPath: '/project-b',
                  status: 'dormant',
                },
              ],
            })
          }, scope)
          await expect.poll(() => manualRecoveryCalls(page)).toEqual([['status', null]])
          await page.evaluate((scope) => {
            const probe = Reflect.get(window, 'preferenceProbe')
            if (scope === 'project') probe.project('project-a')
            probe.view(scope === 'project' ? 'resource' : 'literature')
          }, scope)
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.activeSession),
            null
          )
          assert.deepEqual(await manualRecoveryCalls(page), [['status', null]])
          await page.evaluate(() => Reflect.get(window, 'preferenceProbe').project('project-b'))
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.activeSession),
            'ordinary-first'
          )
          await page.evaluate(() => {
            const probe = Reflect.get(window, 'preferenceProbe')
            probe.patch((state: AppState) => ({
              ...state,
              threads: {
                ...state.threads,
                'ordinary-first': { ...state.threads['ordinary-first'], resumeState: 'ready' },
              },
            }))
          })
          await expect
            .poll(() =>
              page.evaluate(
                () => Reflect.get(window, 'preferenceProbe').disk.lastLocation?.sessionId
              )
            )
            .toBe('ordinary-first')
          assert.deepEqual(await manualRecoveryCalls(page), [['status', null]])
          await openReadyRecoverySession(page, 'recovery-target')
          await expect
            .poll(() => manualRecoveryCalls(page))
            .toEqual([
              ['status', null],
              ['manual-open', 'recovery-target', 'recovery-target'],
            ])
        },
        (page) =>
          installRecoveryBridge(page, {
            status: scope === 'project' ? 'eligible' : 'home',
            skippedSessionId: 'recovery-target',
            needsManualAcknowledgement: scope === 'literature',
          })
      )
    }
  )
}

for (const needsManualAcknowledgement of [false, true]) {
  test(
    `persisted task recovery follows the session ID after other opens and dismissal (forced Home=${needsManualAcknowledgement})`,
    { timeout: 60_000 },
    async () => {
      await fixture(
        async (page) => {
          await readyForRecovery(page)
          await expect.poll(() => manualRecoveryCalls(page)).toEqual([['status', null]])
          await openReadyRecoverySession(page, 'ordinary-first')
          if (needsManualAcknowledgement) {
            await expect
              .poll(() => manualRecoveryCalls(page))
              .toEqual([
                ['status', null],
                ['manual-open', 'ordinary-first', 'ordinary-first'],
              ])
          } else {
            assert.deepEqual(await manualRecoveryCalls(page), [['status', null]])
          }
          await page.evaluate(() => Reflect.get(window, 'preferenceProbe').dismissStartupRecovery())
          await openReadyRecoverySession(page, 'ordinary-second')
          await openReadyRecoverySession(page, 'recovery-target')
          const initialCalls = needsManualAcknowledgement
            ? [
                ['status', null],
                ['manual-open', 'ordinary-first', 'ordinary-first'],
              ]
            : [['status', null]]
          await expect
            .poll(() => manualRecoveryCalls(page))
            .toEqual([...initialCalls, ['manual-open', 'recovery-target', 'recovery-target']])
          await openReadyRecoverySession(page, 'ordinary-second')
          await openReadyRecoverySession(page, 'recovery-target')
          assert.deepEqual(await manualRecoveryCalls(page), [
            ...initialCalls,
            ['manual-open', 'recovery-target', 'recovery-target'],
          ])
        },
        (page) =>
          installRecoveryBridge(page, {
            status: needsManualAcknowledgement ? 'home' : 'eligible',
            skippedSessionId: 'recovery-target',
            needsManualAcknowledgement,
          })
      )
    }
  )
}

test(
  'normal manual sessions never requery startup task recovery',
  { timeout: 60_000 },
  async () => {
    await fixture(
      async (page) => {
        await readyForRecovery(page)
        const startupCalls = await manualRecoveryCalls(page)
        await openReadyRecoverySession(page, 'ordinary-first')
        await openReadyRecoverySession(page, 'ordinary-second')
        assert.deepEqual(await manualRecoveryCalls(page), startupCalls)
      },
      (page) =>
        installRecoveryBridge(page, {
          status: 'eligible',
          skippedSessionId: null,
          needsManualAcknowledgement: false,
        })
    )
  }
)

test(
  'a late startup claim can be acknowledged only after its skip and a matching manual open',
  { timeout: 60_000 },
  async () => {
    await fixture(
      async (page) => {
        await readyForRecovery(page)
        await expect
          .poll(() => manualRecoveryCalls(page))
          .toEqual([
            ['status', 'recovery-target'],
            ['begin', 'recovery-target'],
          ])
        await openReadyRecoverySession(page, 'ordinary-first')
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.dismissStartupRecovery()
          Reflect.get(window, 'releaseRecoveryClaim')()
        })
        const skipped = [
          ['status', 'recovery-target'],
          ['begin', 'recovery-target'],
          ['finish', 'token-from-main', 'skipped'],
        ]
        await expect.poll(() => manualRecoveryCalls(page)).toEqual(skipped)
        await openReadyRecoverySession(page, 'recovery-target')
        assert.deepEqual(await manualRecoveryCalls(page), skipped)
        await page.evaluate(() => Reflect.get(window, 'releaseRecoveryFinish')())
        await expect
          .poll(() => manualRecoveryCalls(page))
          .toEqual([...skipped, ['manual-open', 'recovery-target', 'recovery-target']])
      },
      (page) =>
        installRecoveryBridge(
          page,
          { status: 'eligible', skippedSessionId: null, needsManualAcknowledgement: false },
          true
        )
    )
  }
)

test(
  'startup document body times out without opening a late document tab',
  { timeout: 60_000 },
  async () => {
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      await fixture(
        async (page) => {
          await page.evaluate(() =>
            Reflect.get(window, 'preferenceProbe').patch({
              workspaceLoadState: 'ready',
              projectsLoaded: true,
            })
          )
          await requested.promise
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.startupTaskRecovery)
            )
            .toBe('waiting')
          assert.deepEqual(
            await page.evaluate(() => Reflect.get(window, 'preferenceProbe').documentTabs()),
            []
          )
          await page.clock.fastForward(STARTUP_TASK_RECOVERY_MS)
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'restoreReadAborted')))
            .toBe(true)
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.startupTaskRecovery)
            )
            .toBe('skipped')
          await page.evaluate(() => {
            const probe = Reflect.get(window, 'preferenceProbe')
            probe.openSettings()
            probe.draft('New home draft')
          })
          release.resolve()
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'lateDocumentRead')))
            .toBe(true)
          assert.deepEqual(
            await page.evaluate(() => {
              const probe = Reflect.get(window, 'preferenceProbe')
              return [
                probe.state.mainView,
                probe.state.accountSettingsPage,
                probe.draft(),
                probe.documentTabs(),
              ]
            }),
            ['home', 'preferences', 'New home draft', []]
          )
        },
        async (page) => {
          await page.clock.install()
          await page.addInitScript(() => {
            localStorage.setItem(
              'scholarseed.web.preferences',
              JSON.stringify({
                lastLocation: {
                  view: 'resource',
                  target: {
                    kind: 'document',
                    viewKind: 'edit',
                    title: 'Previous Markdown',
                    source: { kind: 'project', project: null, path: 'previous.md' },
                  },
                },
              })
            )
            const original = window.fetch
            window.fetch = async (input, init) => {
              if (!String(input).includes('/api/workbench/content?')) return original(input, init)
              init?.signal?.addEventListener('abort', () =>
                Reflect.set(window, 'restoreReadAborted', true)
              )
              const response = await original(input, { ...init, signal: undefined })
              Reflect.set(window, 'lateDocumentRead', true)
              return response
            }
          })
          await page.route('**/api/workbench/open?**', (route) =>
            route.fulfill({
              json: {
                project_id: null,
                viewer: 'markdown',
                capabilities: { can_edit: true },
                revision: 'test-revision',
                media_type: 'text/markdown',
                content_kind: 'text',
              },
            })
          )
          await page.route('**/api/workbench/content?**', async (route) => {
            requested.resolve()
            await release.promise
            await route.fulfill({ body: '# Old document' })
          })
        }
      )
    } finally {
      release.resolve()
    }
  }
)

test(
  'a skipped search restore can reload the search list when the user enters Literature',
  { timeout: 60_000 },
  async () => {
    let reads = 0
    await fixture(
      async (page) => {
        await page.evaluate(() =>
          Reflect.get(window, 'preferenceProbe').patch({
            workspaceLoadState: 'ready',
            projectsLoaded: true,
          })
        )
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.startupTaskRecovery)
          )
          .toBe('skipped')
        assert.equal(reads, 1)
        await page.evaluate(() => Reflect.get(window, 'preferenceProbe').view('literature'))
        await expect
          .poll(() =>
            page.evaluate(() =>
              Reflect.get(window, 'preferenceProbe').state.tabs.some(
                (tab: { id: string }) => tab.id === 'literature-search:previous-search'
              )
            )
          )
          .toBe(true)
        assert.equal(reads, 2)
        assert.equal(
          await page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.activeTab),
          'literature'
        )
      },
      async (page) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            'scholarseed.web.preferences',
            JSON.stringify({
              lastLocation: {
                view: 'literature',
                target: { kind: 'tab', id: 'literature-search:previous-search' },
              },
            })
          )
        })
        await page.route('**/api/literature/searches', (route) => {
          reads += 1
          return reads === 1
            ? route.fulfill({ status: 503, json: { detail: 'unavailable' } })
            : route.fulfill({
                json: {
                  items: [{ id: 'previous-search', query: 'Previous search', created_at: 1 }],
                },
              })
        })
      }
    )
  }
)

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
  {
    target: 'session',
    outcome: 'success',
    intervention: 'settings',
    route: '/api/serve/sessions/restore-session/navigation',
  },
  {
    target: 'session',
    outcome: 'success',
    intervention: 'typing',
    route: '/api/serve/sessions/restore-session/navigation',
  },
  { target: 'document', outcome: 'missing', route: '/api/workbench/open' },
  { target: 'document', outcome: 'failure', route: '/api/workbench/open' },
  { target: 'tab', outcome: 'failure', route: '/api/literature/searches' },
]) {
  const { outcome, target, intervention = 'return home' } = scenario
  const expectedSettings = intervention === 'settings' ? 'preferences' : null
  test(
    `${intervention} persists and rejects a late ${target} restoration ${outcome}`,
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
          await page.evaluate((intervention) => {
            const probe = Reflect.get(window, 'preferenceProbe')
            if (intervention === 'settings') probe.openSettings()
            else if (intervention === 'typing') probe.draft('New startup draft')
            else probe.returnHome()
          }, intervention)
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').disk.lastLocation)
            )
            .toEqual({
              view: 'home',
              projectId: null,
              sessionId: null,
              sessionProjectId: null,
              settingsPage: expectedSettings,
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
              recovery: probe.state.startupTaskRecovery,
              settings: probe.state.accountSettingsPage,
              draft: probe.draft(),
              load: probe.state.workspaceLoadState,
              location: probe.disk.lastLocation,
            }
          })
          assert.equal(state.view, 'home')
          assert.equal(state.session, null)
          assert.equal(state.restored, true)
          assert.equal(state.recovery, 'skipped')
          assert.equal(state.settings, expectedSettings)
          assert.equal(state.draft, intervention === 'typing' ? 'New startup draft' : '')
          assert.equal(state.load, 'ready')
          assert.equal(state.location.view, 'home')
          assert.equal(await page.evaluate(() => Reflect.get(window, 'restoreReadAborted')), true)
          assert.equal(requestCount, 1)
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
                          ? { kind: 'tab', id: 'literature-search:removed-search' }
                          : null,
                    aiPanelOpen: true,
                    settingsPage: 'skills',
                  },
                })
              )
              const original = window.fetch
              window.fetch = async (input, init) => {
                if (String(input).includes(route)) {
                  init?.signal?.addEventListener('abort', () => {
                    Reflect.set(window, 'restoreReadAborted', true)
                  })
                  // Deliver a late response even after cancellation to exercise the navigation fence.
                  const response = await original(input, { ...init, signal: undefined })
                  Reflect.set(window, 'restoreResponseReceived', true)
                  return response
                }
                return original(input, init)
              }
            },
            { target, route: scenario.route }
          )
          await page.route(`**${scenario.route}*`, async (route) => {
            requestCount += 1
            requested()
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

test(
  'context refresh retains refs and draft, then settles an older response',
  { timeout: 60_000 },
  async () => {
    let refresh = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await fixture(
      async (page) => {
        await page.evaluate(() =>
          Reflect.get(window, 'preferenceProbe').patch({ activeSession: 'context-session' })
        )
        await page.waitForFunction(
          () => Reflect.get(window, 'preferenceProbe').state.aiPanel.contextState === 'ready'
        )
        refresh = true
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.draft('keep this draft')
          void probe.loadContext('context-session')
        })
        await page.waitForFunction(
          () => Reflect.get(window, 'preferenceProbe').state.aiPanel.contextState === 'refreshing'
        )
        const snapshot = () =>
          page.evaluate(() => {
            const probe = Reflect.get(window, 'preferenceProbe')
            return {
              refs: probe.state.aiPanel.refs,
              revision: probe.state.aiPanel.revision,
              draft: probe.draft(),
            }
          })
        const pending = await snapshot()
        assert.equal(pending.revision, 3)
        assert.equal(pending.refs[0].ref_id, 'retained')
        assert.equal(pending.draft, 'keep this draft')
        release()
        await page.waitForFunction(
          () => Reflect.get(window, 'preferenceProbe').state.aiPanel.contextState === 'ready'
        )
        assert.deepEqual(await snapshot(), pending)
      },
      async (page) => {
        await page.route('**/api/assistant/sessions/context-session/context', async (route) => {
          const refreshing = refresh
          if (refreshing) await held
          await route.fulfill({
            json: {
              session_id: 'context-session',
              revision: refreshing ? 2 : 3,
              project_policy: 'explicit_only',
              search_scope: 'web',
              capabilities: [],
              updated_at: 0,
              refs: refreshing
                ? []
                : [
                    {
                      ref_id: 'retained',
                      kind: 'file',
                      source_id: 'retained.pdf',
                      source_revision: '1',
                      label: 'retained.pdf',
                      retention: 'next_turn',
                      origin: 'explicit',
                    },
                  ],
            },
          })
        })
        await page.route('**/api/assistant/sessions/context-session/annotations', (route) =>
          route.fulfill({ json: { annotations: [] } })
        )
        await page.route('**/api/serve/sessions/context-session/queue', (route) =>
          route.fulfill({ json: { messages: [] } })
        )
      }
    )
  }
)

test(
  'queued context stays in its draft and project but ordinary typing and panel actions remain allowed',
  { timeout: 60_000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const probe = Reflect.get(window, 'preferenceProbe')
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const candidate = (source_id: string) => ({
          kind: 'pdf_comment',
          source_id,
          source_revision: 'revision',
          label: source_id,
          origin: 'explicit',
          retention: 'next_turn',
        })
        probe.patch({
          projects: [
            { id: 'project-a', name: 'A', path: '/project-a' },
            { id: 'project-b', name: 'B', path: '/project-b' },
          ],
        })
        await frame()
        probe.newDraft('project-a')
        await frame()
        const allowed = probe.addContexts([candidate('allowed')])
        probe.draft('typed while queued')
        probe.panel()
        const normal = await allowed
        await frame()
        const text = probe.draft()
        const originalDraft = probe.captureContextTarget()
        probe.newDraft('project-a')
        const sameProject = await probe.addContexts([candidate('old-draft')], originalDraft)
        await frame()
        const originalProject = probe.captureContextTarget()
        probe.project('project-b')
        const switchedProject = await probe.addContexts([candidate('old-project')], originalProject)
        await frame()
        return {
          normal,
          text,
          sameProject,
          switchedProject,
          project: probe.state.homeSelectedProjectId,
          refs: probe.state.aiPanel.refs.map((ref: { source_id: string }) => ref.source_id),
        }
      })
      assert.equal(result.normal.accepted_ref_ids.length, 1)
      assert.equal(result.text, 'typed while queued')
      assert.equal(result.sameProject.accepted_ref_ids.length, 0)
      assert.equal(result.sameProject.rejected.length, 1)
      assert.equal(result.switchedProject.accepted_ref_ids.length, 0)
      assert.equal(result.switchedProject.rejected.length, 1)
      assert.equal(result.project, 'project-b')
      assert.equal(result.refs.includes('old-draft') || result.refs.includes('old-project'), false)
    })
  }
)

for (const scenario of [
  'single',
  'mixed',
  'rejected',
  'patch-rejected',
  'ordinary',
  'late-input',
] as const) {
  test(
    `context removal preserves annotation entities and endpoint ownership: ${scenario}`,
    {
      timeout: 60_000,
    },
    async () => {
      const references = (
        scenario === 'ordinary'
          ? ['file']
          : ['first', 'second', ...(scenario === 'single' ? [] : ['file'])]
      ).map((name) => ({
        ref_id: `ref-${name}`,
        kind: name === 'file' ? 'file' : 'note',
        source_id: name,
        source_revision: '1',
        label: name,
        retention: 'next_turn',
        origin: 'explicit',
      }))
      let selection = {
        session_id: 'annotation-session',
        revision: 5,
        project_policy: 'explicit_only',
        search_scope: 'web',
        capabilities: [],
        updated_at: 0,
        refs: references,
      }
      const annotations = references
        .filter((reference) => reference.kind === 'note')
        .map((reference) => ({
          annotation_id: reference.source_id,
          client_annotation_id: reference.source_id,
          session_id: selection.session_id,
          answer_id: 'answer',
          source_product_seq: 1,
          source_turn_id: 'turn',
          source_item_id: 'answer',
          answer_revision: 'sha256:answer',
          start_utf16: reference.source_id === 'first' ? 0 : 10,
          end_utf16: reference.source_id === 'first' ? 5 : 15,
          selected_text_hash: `sha256:${reference.source_id}`,
          preview_text: reference.label,
          comment: `comment ${reference.source_id}`,
          revision: 1,
          created_at: 0,
          updated_at: 0,
        }))
      const mutations: Array<{ method: string; path: string; revision: number }> = []
      let releaseRemoval!: () => void
      const heldRemoval = new Promise<void>((resolve) => {
        releaseRemoval = resolve
      })
      let removalStarted!: () => void
      const removalArrived = new Promise<void>((resolve) => {
        removalStarted = resolve
      })
      await fixture(
        async (page) => {
          await page.evaluate((withAttachment) => {
            const probe = Reflect.get(window, 'preferenceProbe')
            probe.patch({
              activeSession: 'annotation-session',
              composerRefs: withAttachment
                ? [{ type: 'file', id: 'original', title: 'original.md', path: 'original.md' }]
                : [],
            })
            probe.draft('keep unsent text')
          }, scenario === 'late-input')
          await page.waitForFunction(
            () => Reflect.get(window, 'preferenceProbe').state.aiPanel.contextState === 'ready'
          )
          if (
            scenario === 'mixed' ||
            scenario === 'patch-rejected' ||
            scenario === 'rejected' ||
            scenario === 'late-input'
          ) {
            const settled = page.waitForResponse(
              (response) =>
                response.request().method() !== 'GET' &&
                response
                  .url()
                  .endsWith(
                    scenario === 'rejected'
                      ? '/annotations/first/context'
                      : '/annotation-session/context'
                  )
            )
            const input = page.getByTestId('composer-input')
            await input.press('Meta+a')
            await input.press('Backspace')
            if (scenario === 'late-input') {
              await removalArrived
              await input.fill('new text while saving')
              await page.evaluate(() => {
                const probe = Reflect.get(window, 'preferenceProbe')
                probe.patch((state: { composerRefs: object[] }) => ({
                  composerRefs: [
                    ...state.composerRefs,
                    { type: 'file', id: 'late', title: 'late.md', path: 'late.md' },
                  ],
                }))
              })
              releaseRemoval()
            }
            await settled
          } else {
            const removed = await page.evaluate(
              async (ids) => Reflect.get(window, 'preferenceProbe').detachContext(ids),
              scenario === 'single' ? 'ref-second' : references.map((reference) => reference.ref_id)
            )
            assert.equal(removed, true)
          }
          const expected =
            scenario === 'rejected'
              ? references
              : scenario === 'patch-rejected'
                ? references.filter((reference) => reference.kind === 'file')
                : scenario === 'single'
                  ? references.slice(0, 1)
                  : []
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'preferenceProbe').state.aiPanel.refs)
            )
            .toEqual(expected)
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'preferenceProbe').draft()))
            .toBe(
              scenario === 'mixed'
                ? ''
                : scenario === 'late-input'
                  ? 'new text while saving'
                  : 'keep unsent text'
            )
          if (scenario === 'late-input') {
            await expect
              .poll(() =>
                page.evaluate(() =>
                  Reflect.get(window, 'preferenceProbe').state.composerRefs.map(
                    (reference: { id: string }) => reference.id
                  )
                )
              )
              .toEqual(['late'])
          }
          assert.deepEqual(
            await page.evaluate(
              () => Reflect.get(window, 'preferenceProbe').state.aiPanel.annotations
            ),
            annotations
          )
          if (scenario === 'patch-rejected') {
            assert.equal(
              await page.evaluate(
                () => Reflect.get(window, 'preferenceProbe').state.aiPanel.contextError.key
              ),
              'contextErrors.saveFailed'
            )
            assert.deepEqual(selection.refs, expected)
          }
          assert.deepEqual(
            mutations.map((entry) => entry.path),
            scenario === 'single'
              ? ['/annotations/second/context']
              : scenario === 'rejected'
                ? ['/annotations/first/context']
                : scenario === 'ordinary'
                  ? ['/context']
                  : ['/annotations/first/context', '/annotations/second/context', '/context']
          )
          assert.deepEqual(
            mutations.map((entry) => entry.revision),
            scenario === 'mixed' || scenario === 'patch-rejected' || scenario === 'late-input'
              ? [5, 6, 7]
              : [5]
          )
          assert.equal(
            mutations.every((entry) => entry.path.endsWith('/context')),
            true
          )
        },
        async (page) => {
          if (
            scenario === 'mixed' ||
            scenario === 'patch-rejected' ||
            scenario === 'rejected' ||
            scenario === 'late-input'
          ) {
            await page.addInitScript(() => Reflect.set(window, 'composerRemovalFixture', true))
          }
          await page.route('**/api/assistant/sessions/annotation-session/**', async (route) => {
            const request = route.request()
            const path = new URL(request.url()).pathname.split('/annotation-session')[1]
            if (request.method() === 'GET') {
              await route.fulfill({ json: path === '/context' ? selection : { annotations } })
              return
            }
            const body = request.postDataJSON()
            if (scenario === 'late-input' && path === '/annotations/first/context') {
              removalStarted()
              await heldRemoval
            }
            const revision = body.expected_context_revision ?? body.expected_revision
            mutations.push({ method: request.method(), path, revision })
            if (revision !== selection.revision || scenario === 'rejected') {
              await route.fulfill({
                status: 409,
                json: { detail: { error: 'answer_annotation_claimed', latest: selection } },
              })
              return
            }
            if (path === '/context') {
              if (scenario === 'patch-rejected') {
                await route.fulfill({
                  status: 500,
                  json: { detail: { error: 'ordinary context save failed', latest: selection } },
                })
                return
              }
              const currentNotes = selection.refs.filter((reference) => reference.kind === 'note')
              const incomingNotes = body.refs.filter(
                (reference: { kind: string }) => reference.kind === 'note'
              )
              if (JSON.stringify(currentNotes) !== JSON.stringify(incomingNotes)) {
                await route.fulfill({
                  status: 409,
                  json: {
                    detail: {
                      error: 'answer annotation refs require the annotation context endpoint',
                      latest: selection,
                    },
                  },
                })
                return
              }
              selection = { ...selection, revision: selection.revision + 1, refs: body.refs }
            } else {
              assert.equal(request.method(), 'DELETE')
              assert.match(path, /^\/annotations\/(first|second)\/context$/)
              const annotationId = path.split('/')[2]
              selection = {
                ...selection,
                revision: selection.revision + 1,
                refs: selection.refs.filter((reference) => reference.source_id !== annotationId),
              }
            }
            await route.fulfill({ json: selection })
          })
          await page.route('**/api/serve/sessions/annotation-session/queue', (route) =>
            route.fulfill({ json: { messages: [] } })
          )
        }
      )
    }
  )
}

test(
  'context batch and single additions serialize without losing refs or draft, and retries deduplicate',
  { timeout: 60_000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const probe = Reflect.get(window, 'preferenceProbe')
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const candidate = (source_id: string) => ({
          kind: 'pdf_comment',
          source_id,
          source_revision: 'revision',
          label: source_id,
          origin: 'explicit',
          retention: 'next_turn',
        })
        probe.patch((state: { aiPanel: object }) => ({
          activeSession: null,
          aiPanel: {
            ...state.aiPanel,
            refs: [{ ...candidate('existing'), ref_id: 'existing' }],
            submittedRefIds: [],
            capabilities: [],
            contextState: 'ready',
          },
        }))
        await frame()
        probe.draft('unsent draft')
        await frame()
        const outcomes = await Promise.all([
          probe.addContexts([candidate('first'), candidate('second')]),
          probe.addContext(candidate('third')),
        ])
        await frame()
        const beforeRetry = probe.state.aiPanel.refs.map(
          (ref: { source_id: string }) => ref.source_id
        )
        await probe.addContexts([candidate('first'), candidate('second')])
        await frame()
        const rejected = await probe.addContexts([
          { ...candidate('rejected'), unavailable_reason: 'not_available' },
        ])
        await frame()
        return {
          outcomes,
          beforeRetry,
          rejected,
          draft: probe.draft(),
          refs: probe.state.aiPanel.refs.map((ref: { source_id: string }) => ref.source_id),
        }
      })
      assert.deepEqual(
        result.beforeRetry,
        ['existing', 'first', 'second', 'third'],
        JSON.stringify(result)
      )
      assert.deepEqual(result.refs, ['existing', 'first', 'second', 'third'])
      assert.equal(result.draft, 'unsent draft')
      assert.equal(
        result.outcomes.every((outcome: { rejected: unknown[] }) => !outcome.rejected.length),
        true
      )
      assert.equal(result.rejected.rejected.length, 1)
    })
  }
)

test(
  'fork menu stays pending and closes after successful navigation',
  { timeout: 60_000 },
  async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await fixture(
      async (page) => {
        await page.getByRole('button', { name: '任务菜单' }).click()
        await page.getByTestId('session-fork-menu').click()
        await expect(page.getByTestId('session-fork-menu')).toBeDisabled()
        release()
        await expect(page.getByTestId('session-context-menu')).toBeHidden()
        await page.waitForFunction(
          () => Reflect.get(window, 'preferenceProbe').state.activeSession === 'child'
        )
      },
      async (page) => {
        await page.route('**/api/serve/sessions/open', async (route) => {
          await held
          await route.fulfill({
            json: {
              session_id: 'child',
              title: 'Branch',
              project_path: null,
              runtime_id: 'codex',
              running: false,
              active_turn_id: null,
              uncertain_operations: [],
              unknown_outcome: false,
            },
          })
        })
      }
    )
  }
)

test(
  'forks the selected session once and preserves the previous composer draft',
  { timeout: 60_000 },
  async () => {
    const requests: unknown[] = []
    await fixture(
      async (page) => {
        const result = await page.evaluate(async () => {
          const probe = Reflect.get(window, 'preferenceProbe')
          const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          probe.patch({
            activeSession: 'current',
            sessions: [{ id: 'other', title: 'Parent', status: 'dormant' }],
            collapsedSessionIds: { other: true },
            composerRefs: [{ type: 'file', id: 'draft-ref', title: 'draft' }],
          })
          probe.draft('unsent draft')
          await frame()
          const outcomes = await Promise.all([
            probe.forkSession('other'),
            probe.forkSession('other'),
          ])
          await frame()
          const child = {
            session: probe.state.activeSession,
            text: probe.draft(),
            refs: probe.state.composerRefs,
            collapsed: probe.state.collapsedSessionIds.other,
            parent: probe.state.sessions.find(
              (node: { id: string; displayParentSessionId?: string }) => node.id === 'child'
            )?.displayParentSessionId,
          }
          probe.openSession('current')
          await frame()
          return {
            outcomes,
            child,
            restored: { text: probe.draft(), refs: probe.state.composerRefs },
          }
        })
        assert.deepEqual(result.outcomes, [true, false])
        assert.deepEqual(result.child, {
          session: 'child',
          text: '',
          refs: [],
          collapsed: false,
          parent: 'other',
        })
        assert.equal(result.restored.text, 'unsent draft')
        assert.equal(result.restored.refs[0].id, 'draft-ref')
        assert.deepEqual(requests, [{ fork_session_id: 'other' }])
      },
      async (page) => {
        await page.route('**/api/serve/sessions/open', async (route) => {
          requests.push(route.request().postDataJSON())
          await route.fulfill({
            json: {
              session_id: 'child',
              display_parent_session_id: 'other',
              title: 'Branch',
              project_path: null,
              runtime_id: 'codex',
              running: false,
              active_turn_id: null,
              uncertain_operations: [],
              unknown_outcome: false,
            },
          })
        })
      }
    )
  }
)

test(
  'failed fork preserves selection and collapsed display parent',
  { timeout: 60_000 },
  async () => {
    await fixture(
      async (page) => {
        const result = await page.evaluate(async () => {
          const probe = Reflect.get(window, 'preferenceProbe')
          probe.patch({ activeSession: 'current', collapsedSessionIds: { parent: true } })
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const opened = await probe.forkSession('existing-child')
          return {
            opened,
            activeSession: probe.state.activeSession,
            collapsed: probe.state.collapsedSessionIds.parent,
          }
        })
        assert.deepEqual(result, { opened: false, activeSession: 'current', collapsed: true })
      },
      async (page) => {
        await page.route('**/api/serve/sessions/open', (route) =>
          route.fulfill({ status: 409, json: { error: 'session_fork_unavailable' } })
        )
      }
    )
  }
)
