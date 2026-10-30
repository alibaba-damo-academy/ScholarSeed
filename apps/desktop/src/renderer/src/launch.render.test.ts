import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const INSTANCE = 'launch-instance'
const SESSION = 'd'.repeat(32)
const CONTINUE_TASK_PROMPT = JSON.parse(
  readFileSync(new URL('../../localization/locales/zh/components.json', import.meta.url), 'utf8')
).stream.continueTaskPrompt as string
const MODELS = ['model-a', 'model-b'].map((key) => ({
  key,
  label: key,
  model_name: key,
  source: 'builtin',
  reasoning_efforts: ['low', 'high'],
}))

async function fixture(run: (page: Page) => Promise<void>): Promise<void> {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    plugins: [react()],
    define: { __SCHOLARSEED_WEB_VERSION__: JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, json: { error: 'fixture_unavailable' } })
    )
    await page.goto(new URL('/launch.render.fixture.html', server.resolvedUrls!.local[0]).href)
    await expect(page.getByTestId('composer-input'))
      .toBeVisible()
      .catch(async (error) => {
        throw new Error(
          JSON.stringify({
            errors,
            body: await page.locator('body').innerText(),
            failure: String(error),
          })
        )
      })
    await page.evaluate(
      ({ models, instance }) =>
        Reflect.get(window, 'launchProbe').patch({
          model: 'model-a',
          serviceInstanceId: instance,
          runtimeReadiness: { ready: true },
          backendReady: false,
          workbenchReady: true,
          catalog: { models, hiddenModels: [], subscriptionGroups: [], personalProfiles: [] },
        }),
      { models: MODELS, instance: INSTANCE }
    )
    await run(page).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          errors,
          body: await page.locator('body').innerText(),
          failure: String(error),
        })
      )
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
  }
}

async function preparation(page: Page) {
  let state = 'accepted'
  let terminalObserved = false
  let request: { request_id: string; model_id: string } | null = null
  const receipt = () => ({
    ...request,
    session_id: null,
    state,
    error: state === 'rejected' ? 'test_preparation_failed' : '',
    service_instance_id: INSTANCE,
  })
  await page.route('**/api/serve/runtime/reconfiguration', (route) =>
    route.fulfill({ json: { state: null, service_instance_id: INSTANCE } })
  )
  await page.route('**/api/serve/runtime/prepare**', (route) => {
    if (route.request().method() === 'POST') request = route.request().postDataJSON()
    if (state !== 'accepted') terminalObserved = true
    return route.fulfill({ json: receipt() })
  })
  return {
    finish: (next = 'applied') => {
      state = next
    },
    terminalObserved: () => terminalObserved,
  }
}

function opened() {
  return {
    session_id: SESSION,
    runtime_id: 'codex',
    runtime: { name: 'codex', model_id: 'model-b' },
    readiness: { ready: true },
    capabilities: {},
    uncertain_operations: [],
    unknown_outcome: false,
    active_turn_id: null,
    running: false,
    project_path: null,
  }
}

async function chooseAndSend(page: Page): Promise<void> {
  await page.getByTestId('model-selector-toggle').click()
  await page.getByTestId('model-option-model-b').click()
  await page.getByTestId('composer-input').fill('first prepared message')
  await page.getByTestId('composer-send').click()
}

async function chooseEffort(page: Page, effort: string): Promise<void> {
  await page.getByTestId('model-selector-toggle').click()
  await page.getByTestId('model-effort-row').click()
  await page.getByTestId(`model-effort-option-${effort}`).click()
  await page.keyboard.press('Escape')
}

for (const outcome of ['accepted', 'not_applied', 'preparation_rejected', 'unknown']) {
  test(
    `plan continuation ${outcome} preserves the draft and references without duplicate submission or prompt restoration`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const references = [
          { type: 'file', id: 'draft-reference', title: 'draft.txt', path: '/tmp/draft.txt' },
        ]
        await page.evaluate(
          ({ session, references }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({
              composerRefs: references,
              threads: {
                ...probe.state.threads,
                [session]: {
                  ...probe.state.threads[session],
                  running: false,
                  status: 'abandon',
                  queuedMessages: [],
                  conversation: [{ kind: 'user', text: 'original task', turnId: 'paused-plan' }],
                  todoTurnId: 'paused-plan',
                  todos: [
                    { content: 'already completed', status: 'completed' },
                    { content: 'remaining work', status: 'in_progress' },
                  ],
                  turnOutcomes: { 'paused-plan': 'interrupted' },
                  turnTimings: { 'paused-plan': { startedAt: 1000, completedAt: 61000 } },
                },
              },
            })
          },
          { session: SESSION, references }
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        let reconciliations = 0
        await page.route('**/api/serve/sessions/*/turns', async (route) => {
          turns.push(route.request().postDataJSON())
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill(
            outcome === 'accepted'
              ? {
                  json: {
                    ok: true,
                    accepted: true,
                    disposition: 'direct',
                    turn_id: 'continued-plan',
                  },
                }
              : {
                  status: 409,
                  json: {
                    error: 'test_continuation_rejected',
                    ...(outcome === 'preparation_rejected' ? { preparation_error: true } : {}),
                  },
                }
          )
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill(
            outcome === 'unknown'
              ? { status: 503, json: { error: 'test_queue_unavailable' } }
              : { json: { messages: [] } }
          )
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) => {
          reconciliations += 1
          return route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        })
        const draft = '  unsent draft\nkeep exact whitespace \t'
        const input = page.getByTestId('composer-input')
        const continuation = page.getByTestId('todo-continue')
        await input.fill(draft)
        await expect(continuation).toBeEnabled()
        const elapsed = await page.getByTestId('todo-elapsed').innerText()
        assert.notEqual(elapsed, '')
        await continuation.evaluate((element) => {
          const button = element as HTMLButtonElement
          button.click()
          button.click()
        })
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(continuation).toBeDisabled()
        await expect(page.getByTestId('todo-elapsed')).toHaveText(elapsed)
        await expect(input).toHaveValue(draft)
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          references
        )
        assert.deepEqual(turns[0].input, [{ type: 'text', text: CONTINUE_TASK_PROMPT }])
        const edited = outcome === 'accepted' || outcome === 'not_applied'
        const expectedDraft = edited ? 'new draft typed during continuation' : draft
        const expectedReferences = edited
          ? [{ type: 'file', id: 'new-draft-reference', title: 'next.txt', path: '/tmp/next.txt' }]
          : references
        if (edited) {
          await input.fill(expectedDraft)
          await page.evaluate(
            (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
            expectedReferences
          )
        }
        release!()
        if (outcome === 'accepted') {
          await expect(page.getByTestId('todo-continue')).toHaveCount(0)
        } else {
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
        }
        await expect(input).toHaveValue(expectedDraft)
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          expectedReferences
        )
        await settleStartup(page)
        assert.equal(turns.length, 1)
        assert.equal(reconciliations, outcome === 'not_applied' ? 1 : 0)
      })
    }
  )
}

for (const { editing, outcome } of [
  'unchanged',
  'replaced',
  'retyped',
  'same-reference-id',
  'text-only',
  'references-only',
].flatMap((editing) => ['accepted', 'not_applied'].map((outcome) => ({ editing, outcome })))) {
  test(
    `successful registration then ${outcome} keeps ${editing} edits and consumes only unchanged snapshot fields`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const originalReferences = [
          {
            type: 'file',
            id: 'original-file',
            title: 'original.txt',
            path: '/tmp/original.txt',
            registrationRequired: true,
          },
        ]
        await page.evaluate(
          ({ session, references }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({
              composerRefs: references,
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], running: true },
              },
            })
          },
          { session: SESSION, references: originalReferences }
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/file-references', async (route) => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill({
            json: {
              references: [
                {
                  reference_id: 'registered-original',
                  path: '/tmp/original.txt',
                  name: 'original.txt',
                  kind: 'file',
                  media_type: 'text/plain',
                },
              ],
            },
          })
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          const request = route.request().postDataJSON()
          turns.push(request)
          return route.fulfill(
            outcome === 'accepted'
              ? {
                  json: {
                    ok: true,
                    accepted: true,
                    disposition: 'queued',
                    queued_message_id: request.client_user_message_id,
                  },
                }
              : { status: 409, json: { error: 'test_submission_rejected' } }
          )
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill({ json: { messages: [] } })
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) =>
          route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        )
        const submitted = 'original message'
        const nextDraft = editing === 'retyped' ? submitted : '  next draft\nnew content \t'
        const nextReferences = [
          {
            type: 'file',
            id: editing === 'same-reference-id' ? 'original-file' : 'next-file',
            title: 'next.txt',
            path: '/tmp/next.txt',
          },
        ]
        const input = page.getByTestId('composer-input')
        const textEdited = editing !== 'unchanged' && editing !== 'references-only'
        const referencesEdited = editing !== 'unchanged' && editing !== 'text-only'
        await input.fill(submitted)
        await input.press('Enter')
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(input).toHaveValue(submitted)
        if (textEdited) {
          await expect(input).toBeEnabled()
          await input.fill('')
          await input.fill(nextDraft)
        }
        if (referencesEdited) {
          await page.evaluate(
            (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
            nextReferences
          )
        }
        release!()
        await expect.poll(() => turns.length).toBe(1)
        assert.deepEqual(turns[0].input, [
          { type: 'text', text: submitted },
          {
            type: 'file',
            reference_id: 'registered-original',
            name: 'original.txt',
            media_type: 'text/plain',
          },
        ])
        if (outcome === 'not_applied') {
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
        }
        await expect(input).toHaveValue(
          textEdited ? nextDraft : outcome === 'accepted' ? '' : submitted
        )
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          referencesEdited ? nextReferences : outcome === 'accepted' ? [] : originalReferences
        )
      })
    }
  )
}

for (const sameIdentity of [false, true]) {
  test(
    `postclear rejection restores consumed references without losing ${sameIdentity ? 'a replacement of the same identity' : 'a newly added reference'}`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const original = {
          type: 'file',
          id: 'original-file',
          title: 'original.txt',
          path: '/tmp/original.txt',
        }
        const next = {
          type: 'file',
          id: sameIdentity ? original.id : 'next-file',
          title: 'next.txt',
          path: '/tmp/next.txt',
        }
        await page.evaluate(
          (reference) => Reflect.get(window, 'launchProbe').patch({ composerRefs: [reference] }),
          original
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/turns', async (route) => {
          turns.push(route.request().postDataJSON())
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill({ status: 409, json: { error: 'test_submission_rejected' } })
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill({ json: { messages: [] } })
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) =>
          route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        )
        const input = page.getByTestId('composer-input')
        await input.fill('submitted message')
        await page.getByTestId('composer-send').click()
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(input).toHaveValue('')
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          []
        )
        await input.fill('new draft')
        await page.evaluate(
          (reference) => Reflect.get(window, 'launchProbe').patch({ composerRefs: [reference] }),
          next
        )
        release!()
        await expect(input).toHaveValue('submitted message\nnew draft')
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          sameIdentity ? [next] : [original, next]
        )
        assert.equal(turns.length, 1)
      })
    }
  )
}

for (const failure of ['open', 'authorization', 'context', 'registration', 'input']) {
  test(
    `preclear ${failure} failure preserves the exact assistant draft and references`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        control.finish()
        let opens = 0
        let turns = 0
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill(
            failure === 'open'
              ? { status: 503, json: { error: 'test_open_unavailable' } }
              : {
                  json: {
                    ...opened(),
                    ...(failure === 'authorization'
                      ? { runtime_workdir: '/tmp/session-root' }
                      : {}),
                  },
                }
          )
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true, accepted: true, turn_id: 'unexpected-turn' } })
        })
        if (failure === 'registration' || failure === 'input') await restoreSession(page)
        const references = [
          {
            type: 'file',
            id: 'draft-file',
            title: 'draft.txt',
            path: failure === 'input' ? 'relative.txt' : '/tmp/draft.txt',
            registrationRequired: failure === 'registration',
            mediaType: 'text/plain',
          },
        ]
        await page.evaluate(
          ({ references, failure }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({ model: 'model-b', composerRefs: references })
            if (failure === 'authorization')
              Object.assign(window.scholarseed, { addAuthorizedRoot: async () => false })
          },
          { references, failure }
        )
        const draft = ' \t repeat\nrepeat \n'
        await page.getByTestId('composer-input').fill(draft)
        for (let attempt = 0; attempt < (failure === 'open' ? 2 : 1); attempt += 1) {
          await page.getByTestId('composer-send').click()
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
          await expect(page.getByTestId('composer-send')).toBeEnabled()
          await expect(page.getByTestId('composer-input')).toHaveValue(draft)
          assert.deepEqual(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
            references
          )
        }
        assert.equal(
          opens,
          failure === 'open' ? 2 : ['registration', 'input'].includes(failure) ? 0 : 1
        )
        assert.equal(turns, 0)
      })
    }
  )
}

test(
  'preclear registration failure preserves edits made while a running-session send waits',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      control.finish()
      await restoreSession(page)
      let release: (() => void) | undefined
      let turns = 0
      await page.route('**/api/serve/sessions/*/file-references', async (route) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        await route.fulfill({ status: 503, json: { error: 'test_registration_unavailable' } })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true, accepted: true, turn_id: 'unexpected-turn' } })
      })
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.surface('assistant')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: { ...probe.state.threads[session], running: true },
          },
          composerRefs: [
            {
              type: 'file',
              id: 'original-file',
              title: 'original.txt',
              path: '/tmp/original.txt',
              registrationRequired: true,
            },
          ],
        })
      }, SESSION)
      await page.getByTestId('composer-input').fill('original message')
      await page.getByTestId('composer-input').press('Enter')
      await expect.poll(() => Boolean(release)).toBe(true)
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      const edited = '  edited\nedited \t'
      await page.getByTestId('composer-input').fill(edited)
      const references = [{ type: 'file', id: 'new-file', title: 'new.txt', path: '/tmp/new.txt' }]
      await page.evaluate(
        (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
        references
      )
      release!()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError))
        .not.toBe(null)
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      await expect(page.getByTestId('composer-input')).toHaveValue(edited)
      assert.deepEqual(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
        references
      )
      assert.equal(turns, 0)
    })
  }
)

for (const outcome of ['preparation_rejected', 'not_applied', 'unknown']) {
  for (const repeated of outcome === 'unknown' ? [true] : [false, true]) {
    test(
      `postclear ${outcome} ${repeated ? 'retains identical new input' : 'merges new input'} without replay`,
      { timeout: 60000 },
      async () => {
        await fixture(async (page) => {
          const control = await preparation(page)
          control.finish()
          await restoreSession(page)
          await page.evaluate(() => Reflect.get(window, 'launchProbe').surface('assistant'))
          let release: (() => void) | undefined
          let turns = 0
          let reconciliations = 0
          await page.route('**/api/serve/sessions/*/turns', async (route) => {
            turns += 1
            await new Promise<void>((resolve) => {
              release = resolve
            })
            await route.fulfill({
              status: 409,
              json: {
                error: 'test_admission_rejected',
                ...(outcome === 'preparation_rejected' ? { preparation_error: true } : {}),
              },
            })
          })
          await page.route('**/api/serve/sessions/*/queue', (route) =>
            route.fulfill(
              outcome === 'unknown'
                ? { status: 503, json: { error: 'test_queue_unavailable' } }
                : { json: { messages: [] } }
            )
          )
          await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) => {
            reconciliations += 1
            return route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
          })
          const submitted = 'submitted message'
          const nextDraft = repeated ? submitted : '  next message \n'
          await page.getByTestId('composer-input').fill(submitted)
          await page.getByTestId('composer-send').click()
          await expect.poll(() => Boolean(release)).toBe(true)
          await expect(page.getByTestId('composer-input')).toHaveValue('')
          await expect(page.getByTestId('composer-input')).toBeEnabled()
          await page.getByTestId('composer-input').fill(nextDraft)
          release!()
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
          await expect(page.getByTestId('composer-input')).toHaveValue(
            outcome === 'unknown' ? nextDraft : `${submitted}\n${nextDraft}`
          )
          if (outcome === 'unknown') {
            await expect
              .poll(() =>
                page.evaluate(
                  (session) =>
                    Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.some(
                      (message: { state: string }) => message.state === 'outcome_unknown'
                    ),
                  SESSION
                )
              )
              .toBe(true)
          }
          await settleStartup(page)
          assert.equal(turns, 1)
          assert.equal(reconciliations, outcome === 'not_applied' ? 1 : 0)
        })
      }
    )
  }
}

test(
  'changing draft effort while preparation waits invalidates only the old send',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const opens: Record<string, unknown>[] = []
      const turns: unknown[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        opens.push(route.request().postDataJSON())
        return route.fulfill({
          json: { ...opened(), runtime: { ...opened().runtime, reasoning_effort: 'high' } },
        })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await chooseAndSend(page)
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await chooseEffort(page, 'high')
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, 'launchProbe').state.reasoningPreferences['model-b']
          )
        )
        .toBe('high')
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.modelSelectionPending)
        )
        .toBe(0)
      assert.equal(opens.length, 0)
      assert.deepEqual(turns, [])
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(1)
      assert.equal(opens.length, 1)
      assert.equal(opens[0].reasoning_effort, 'high')
    })
  }
)

test(
  'restored-session effort selection fences waiting sends until the selected tuple is saved',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      let selectedEffort = 'low'
      let release: (() => void) | undefined
      let turns = 0
      let mutations = 0
      const snapshot = () => ({
        session_id: SESSION,
        model_id: 'model-b',
        reasoning_effort: selectedEffort,
        runtime: { name: 'codex', model_id: 'model-b', reasoning_effort: selectedEffort },
      })
      await page.route('**/api/serve/sessions/*/model', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: snapshot() })
        const body = route.request().postDataJSON()
        mutations += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        selectedEffort = body.reasoning_effort
        return route.fulfill({ json: { ok: true, ...snapshot() } })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await restoreSession(page)
      await page.getByTestId('composer-input').fill('retained effort change')
      await page.getByTestId('composer-send').click()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await chooseEffort(page, 'high')
      assert.equal(mutations, 0)
      control.finish()
      await expect.poll(() => Boolean(release)).toBe(true)
      assert.equal(turns, 0)
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      release?.()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.modelSelectionPending)
        )
        .toBe(0)
      await expect(page.getByTestId('composer-input')).toHaveValue('retained effort change')
      assert.equal(turns, 0)
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
          SESSION
        ),
        1
      )
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns).toBe(1)
      assert.equal(mutations, 1)
    })
  }
)

test(
  'first send waits before session/outbox/turn and submits once after target readiness',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const opens: unknown[] = []
      const turns: unknown[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        opens.push(route.request().postDataJSON())
        return route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await chooseAndSend(page)
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.deepEqual(opens, [])
      assert.deepEqual(turns, [])
      assert.equal(
        await page.evaluate(() =>
          Object.values(Reflect.get(window, 'launchProbe').state.threads).some(
            (thread) => (thread as { queuedMessages?: unknown[] }).queuedMessages?.length
          )
        ),
        false
      )
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(opens.length, 1)
      assert.equal((opens[0] as { prepare_runtime: boolean }).prepare_runtime, true)
      assert.equal((turns[0] as { expected_model_id: string }).expected_model_id, 'model-b')
      assert.equal((turns[0] as { service_instance_id: string }).service_instance_id, INSTANCE)
    })
  }
)

for (const matchingInstance of [true, false]) {
  test(
    `maintenance health 503 ${matchingInstance ? 'preserves' : 'invalidates'} first-send waiting by service identity`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        let opens = 0
        let turns = 0
        await page.route('**/api/healthz/backend', (route) =>
          route.fulfill({
            status: 503,
            json: { error: 'runtime_host_draining' },
          })
        )
        await page.route('**/api/serve/runtime/reconfiguration', (route) =>
          route.fulfill({
            json: {
              state: 'accepted',
              service_instance_id: matchingInstance ? INSTANCE : 'replacement',
            },
          })
        )
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill({ json: opened() })
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
        })
        await page.evaluate(() => Reflect.get(window, 'launchProbe').patch({ backendReady: true }))
        await chooseAndSend(page)
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate(() => Reflect.get(window, 'launchProbe').health())
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.serviceInstanceId)
          )
          .toBe(matchingInstance ? INSTANCE : null)
        if (matchingInstance) {
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase),
            'preparing'
          )
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.workbenchReady),
            true
          )
        }
        assert.equal(opens, 0)
        assert.equal(turns, 0)
        control.finish()
        if (matchingInstance) {
          await expect.poll(() => turns).toBe(1)
          assert.equal(opens, 1)
          await page.waitForTimeout(600)
          assert.equal(turns, 1)
        } else {
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch))
            .toBe(null)
          await page.waitForTimeout(600)
          assert.equal(opens, 0)
          assert.equal(turns, 0)
        }
      })
    }
  )
}

for (const panel of [false, true]) {
  test(
    `new ${panel ? 'panel' : 'conversation'} draft invalidates a waiting first send`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        let opens = 0
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill({ json: opened() })
        })
        await chooseAndSend(page)
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate((value) => Reflect.get(window, 'launchProbe').draft(value), panel)
        await page.getByTestId('composer-input').fill('new draft remains')
        control.finish()
        await expect.poll(control.terminalObserved).toBe(true)
        await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
        assert.equal(opens, 0)
        await expect(page.getByTestId('composer-input')).toHaveValue('new draft remains')
      })
    }
  )
}

test(
  'preparation rejection preserves text without creating a failed queue item',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      let opens = 0
      await page.route('**/api/serve/sessions/open', (route) => {
        opens += 1
        return route.fulfill({ json: opened() })
      })
      await chooseAndSend(page)
      control.finish('rejected')
      await expect(page.getByTestId('runtime-preparation')).toContainText('消息尚未提交')
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      assert.equal(opens, 0)
      await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
    })
  }
)

test(
  'normal runtime preparation stays silent while terminal failures remain visible',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.getByTestId('composer-input').fill('draft stays available')
      for (const state of ['accepted', 'applied', 'rejected', 'restart_required', 'unsupported']) {
        await page.evaluate(
          ({ state, instance }) =>
            Reflect.get(window, 'launchProbe').patch({
              runtimePreparationTarget: state === 'accepted' ? 'model-a' : null,
              runtimePreparation: {
                request_id: '12345678-1234-4234-8234-123456789abc',
                session_id: null,
                model_id: 'model-a',
                state,
                error: '',
                service_instance_id: instance,
              },
            }),
          { state, instance: INSTANCE }
        )
        if (state === 'accepted' || state === 'applied') {
          await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
        } else {
          await expect(page.getByTestId('runtime-preparation')).toBeVisible()
          await expect(page.getByTestId('runtime-preparation')).toHaveAttribute('role', 'alert')
        }
        await expect(page.getByTestId('composer-input')).toHaveValue('draft stays available')
      }
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({ runtimePreparationTarget: 'model-a' })
      )
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
    })
  }
)

test(
  'unmount during session opening cannot submit a late first message',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      let releaseOpen: (() => void) | undefined
      let turns = 0
      await page.route('**/api/serve/sessions/open', async (route) => {
        await new Promise<void>((resolve) => {
          releaseOpen = resolve
        })
        await route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true } })
      })
      await chooseAndSend(page)
      control.finish()
      await expect.poll(() => Boolean(releaseOpen)).toBe(true)
      await page.evaluate(() => Reflect.get(window, 'launchProbe').hide())
      releaseOpen!()
      await expect(page.getByTestId('composer-hidden')).toBeAttached()
      await page.waitForTimeout(300)
      assert.equal(turns, 0)
    })
  }
)

test(
  'prequeue preparation rejection stays unsubmitted and an explicit retry retains target admission',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const turns: { expected_model_id?: string }[] = []
      let opens = 0
      await page.route('**/api/serve/sessions/open', (route) => {
        opens += 1
        return route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill(
          turns.length === 1
            ? {
                status: 409,
                json: {
                  ok: false,
                  error: 'runtime_reconfiguration_stale',
                  preparation_error: true,
                },
              }
            : { json: { ok: true, accepted: true, disposition: 'direct' } }
        )
      })
      await chooseAndSend(page)
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          aiPanel: { ...probe.state.aiPanel, sessionId: session, contextState: 'ready' },
        })
      }, SESSION)
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(2)
      assert.equal(turns[1].expected_model_id, 'model-b')
      assert.equal(opens, 1)
    })
  }
)

async function restoreSession(page: Page): Promise<void> {
  await page.route('**/api/assistant/sessions/*/context', (route) =>
    route.fulfill({
      json: {
        session_id: SESSION,
        revision: 0,
        project_policy: 'explicit_only',
        search_scope: 'web',
        refs: [],
        capabilities: [],
        updated_at: 0,
      },
    })
  )
  await page.evaluate((session) => {
    const probe = Reflect.get(window, 'launchProbe')
    probe.patch({
      activeSession: session,
      threads: {
        [session]: {
          id: session,
          sessionId: session,
          title: 'restored',
          conversation: [],
          lastSeq: 0,
          runtime: { name: 'codex', model_id: 'model-b' },
          readiness: { ready: true },
          resumeState: 'ready',
          queuedMessages: [
            {
              queuedMessageId: 'old-failure',
              enqueueSeq: 1,
              state: 'failed',
              input: [{ type: 'text', text: 'do not replay' }],
              text: 'do not replay',
              assistantReferences: [],
              submissionMode: 'direct',
              safeErrorCode: 'runtime_host_configuration_conflict',
            },
          ],
        },
      },
      aiPanel: { ...probe.state.aiPanel, sessionId: session, contextState: 'ready' },
    })
  }, SESSION)
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 2000 })
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.aiPanel.contextState))
    .toBe('ready')
}

async function settleStartup(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function startupReady(page: Page): Promise<void> {
  await page.evaluate(
    (instance) =>
      Reflect.get(window, 'launchProbe').patch({
        backendReady: true,
        workbenchReady: true,
        navigationRestored: true,
        projectsLoaded: true,
        workspaceLoadState: 'ready',
        modelCatalogInstanceId: instance,
      }),
    INSTANCE
  )
  await settleStartup(page)
}

test(
  'startup prepares only the restored session target after current-instance hydration',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const requests: Record<string, unknown>[] = []
      const mutations: string[] = []
      page.on('request', (request) => {
        if (request.method() !== 'POST') return
        if (new URL(request.url()).pathname === '/api/serve/runtime/prepare')
          requests.push(request.postDataJSON())
        else mutations.push(new URL(request.url()).pathname)
      })
      await restoreSession(page)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        const thread = probe.state.threads[session]
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...thread,
              queuedMessages: [
                ...thread.queuedMessages,
                {
                  ...thread.queuedMessages[0],
                  queuedMessageId: 'old-unknown',
                  enqueueSeq: 2,
                  state: 'outcome_unknown',
                },
              ],
            },
          },
        })
      }, SESSION)
      await startupReady(page)
      assert.equal(requests.length, 0)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              resumeServiceInstanceId: 'retired-instance',
            },
          },
        })
      }, SESSION)
      await settleStartup(page)
      assert.equal(requests.length, 0)
      await page.evaluate(
        ({ session, instance }) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: {
                ...probe.state.threads[session],
                resumeServiceInstanceId: instance,
              },
            },
          })
        },
        { session: SESSION, instance: INSTANCE }
      )
      await expect.poll(() => requests.length).toBe(1)
      assert.equal(requests[0].model_id, 'model-b')
      assert.equal(requests[0].persist_default, false)
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.runtimePreparation?.state)
        )
        .toBe('applied')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
        'model-a'
      )
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          catalog: { ...probe.state.catalog, models: [...probe.state.catalog.models] },
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              runtime: { name: 'codex', model_id: 'model-a' },
            },
          },
        })
      }, SESSION)
      await settleStartup(page)
      assert.equal(requests.length, 1)
      assert.deepEqual(mutations, [])
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[1].state,
          SESSION
        ),
        'outcome_unknown'
      )
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[0].state,
          SESSION
        ),
        'failed'
      )
    })
  }
)

test(
  'startup new draft waits for catalogue identity and does not prepare on later navigation',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const requests: Record<string, unknown>[] = []
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/serve/runtime/prepare'
        )
          requests.push(request.postDataJSON())
      })
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({
          backendReady: true,
          projectsLoaded: true,
          workspaceLoadState: 'ready',
          navigationRestored: true,
        })
      )
      await settleStartup(page)
      assert.equal(requests.length, 0)
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: probe.state.serviceInstanceId,
          current_model: 'model-a',
          available_models: probe.state.catalog.models,
        })
      })
      await expect.poll(() => requests.length).toBe(1)
      assert.equal(requests[0].model_id, 'model-a')
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.runtimePreparation?.state)
        )
        .toBe('applied')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      await restoreSession(page)
      await settleStartup(page)
      assert.equal(requests.length, 1)
    })
  }
)

for (const unavailable of ['missing', 'disabled']) {
  test(
    `startup never falls back from an ${unavailable} persisted session model`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        let prepares = 0
        await preparation(page)
        page.on('request', (request) => {
          if (request.method() === 'POST') prepares += 1
        })
        await restoreSession(page)
        await page.evaluate(
          ({ session, instance, unavailable }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], resumeServiceInstanceId: instance },
              },
              catalog: {
                ...probe.state.catalog,
                models:
                  unavailable === 'missing'
                    ? probe.state.catalog.models.filter(
                        (model: { key: string }) => model.key !== 'model-b'
                      )
                    : probe.state.catalog.models.map((model: { key: string }) => ({
                        ...model,
                        disabled: model.key === 'model-b',
                      })),
              },
            })
          },
          { session: SESSION, instance: INSTANCE, unavailable }
        )
        await startupReady(page)
        assert.equal(prepares, 0)
        assert.notEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
          null
        )
        assert.equal(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
          'model-a'
        )
      })
    }
  )
}

test(
  'service replacement waits for both new catalogue and new session recovery',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const requests: Record<string, unknown>[] = []
      await page.route('**/api/serve/runtime/prepare**', (route) => {
        const request = route.request().postDataJSON()
        requests.push(request)
        return route.fulfill({
          json: { ...request, state: 'applied', session_id: null, error: '' },
        })
      })
      await restoreSession(page)
      await page.evaluate(
        ({ session, instance }) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: { ...probe.state.threads[session], resumeServiceInstanceId: instance },
            },
          })
        },
        { session: SESSION, instance: INSTANCE }
      )
      await startupReady(page)
      await expect.poll(() => requests.length).toBe(1)
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({ serviceInstanceId: 'replacement' })
      )
      const priorCatalog = await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        return {
          model: probe.state.model,
          catalog: probe.state.catalog,
          instance: probe.state.modelCatalogInstanceId,
        }
      })
      await page.evaluate((instance) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: instance,
          current_model: 'stale-model',
          available_models: [],
        })
        probe.catalog({ current_model: 'unidentified-model', available_models: [] })
      }, INSTANCE)
      await settleStartup(page)
      assert.equal(requests.length, 1)
      assert.deepEqual(
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'launchProbe')
          return {
            model: probe.state.model,
            catalog: probe.state.catalog,
            instance: probe.state.modelCatalogInstanceId,
          }
        }),
        priorCatalog
      )
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: 'replacement',
          current_model: 'model-a',
          available_models: probe.state.catalog.models,
        })
      })
      await settleStartup(page)
      assert.equal(requests.length, 1)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: { ...probe.state.threads[session], resumeServiceInstanceId: 'replacement' },
          },
        })
      }, SESSION)
      await expect.poll(() => requests.length).toBe(2)
      assert.deepEqual(
        requests.map((request) => [request.model_id, request.service_instance_id]),
        [
          ['model-b', INSTANCE],
          ['model-b', 'replacement'],
        ]
      )
    })
  }
)

for (const change of ['session', 'draft', 'project']) {
  test(
    `startup hydration cannot prepare a late target after ${change} changes`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        let prepares = 0
        await preparation(page)
        page.on('request', (request) => {
          if (request.method() === 'POST') prepares += 1
        })
        await restoreSession(page)
        await startupReady(page)
        assert.equal(prepares, 0)
        await page.evaluate(
          ({ session, instance, change }) => {
            const probe = Reflect.get(window, 'launchProbe')
            if (change === 'session') probe.patch({ activeSession: 'other-session' })
            if (change === 'draft') probe.draft()
            if (change === 'project') probe.patch({ homeSelectedProjectId: 'other-project' })
            probe.patch({
              threads: {
                ...probe.state.threads,
                [session]: {
                  ...probe.state.threads[session],
                  resumeServiceInstanceId: instance,
                },
              },
            })
          },
          { session: SESSION, instance: INSTANCE, change }
        )
        await settleStartup(page)
        assert.equal(prepares, 0)
      })
    }
  )
}

test(
  'restored session prepares its own model on every explicit send without replaying failures',
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const control = await preparation(page)
      const turns: Record<string, unknown>[] = []
      const forbidden: string[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        forbidden.push('open')
        return route.fulfill({ status: 500 })
      })
      await page.route('**/api/serve/sessions/*/queue/**', (route) => {
        forbidden.push(route.request().method())
        return route.fulfill({ status: 500 })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({
          json: {
            ok: true,
            accepted: true,
            disposition: 'direct',
            turn_id: `continued-${turns.length}`,
          },
        })
      })
      await restoreSession(page)
      await page.getByTestId('composer-input').fill('continued message')
      await page.getByTestId('composer-send').click()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(turns.length, 0)
      await expect(page.getByTestId('composer-input')).toHaveValue('continued message')
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
          SESSION
        ),
        1
      )
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      assert.equal(turns[0].expected_model_id, 'model-b')
      assert.equal(turns[0].service_instance_id, INSTANCE)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
        'model-a'
      )
      await expect
        .poll(() =>
          page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe')
                .state.threads[session].queuedMessages.filter(
                  (message: { queuedMessageId: string }) =>
                    message.queuedMessageId !== 'old-failure'
                )
                .map((message: { state: string }) => message.state),
            SESSION
          )
        )
        .toEqual(['queued'])
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
        null
      )
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              queuedMessages: probe.state.threads[session].queuedMessages.filter(
                (message: { queuedMessageId: string }) => message.queuedMessageId === 'old-failure'
              ),
            },
          },
        })
      }, SESSION)
      await page.getByTestId('composer-input').fill('another explicit message')
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(2)
      assert.equal(turns[1].expected_model_id, 'model-b')
      assert.deepEqual(forbidden, [])
      await expect
        .poll(() =>
          page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe')
                .state.threads[session].queuedMessages.filter(
                  (message: { queuedMessageId: string }) =>
                    message.queuedMessageId !== 'old-failure'
                )
                .every(
                  (message: { state: string; serverPresent: boolean }) =>
                    message.state === 'queued' && message.serverPresent
                ),
            SESSION
          )
        )
        .toBe(true)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
        null
      )
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[0].state,
          SESSION
        ),
        'failed'
      )
    })
  }
)

for (const change of ['session', 'model', 'instance', 'context', 'unmount', 'rejection']) {
  test(
    `restored send remains unsubmitted after ${change} during preparation`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        const control = await preparation(page)
        let turns = 0
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true } })
        })
        await restoreSession(page)
        await page.getByTestId('composer-input').fill('retained continuation')
        await page.getByTestId('composer-send').click()
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate(
          ({ change, session }) => {
            const probe = Reflect.get(window, 'launchProbe')
            if (change === 'session') probe.draft()
            if (change === 'model')
              probe.patch({
                threads: {
                  ...probe.state.threads,
                  [session]: {
                    ...probe.state.threads[session],
                    runtime: { name: 'codex', model_id: 'model-a' },
                  },
                },
              })
            if (change === 'instance') probe.patch({ serviceInstanceId: 'replacement' })
            if (change === 'context')
              probe.patch({
                aiPanel: { ...probe.state.aiPanel, revision: probe.state.aiPanel.revision + 1 },
              })
            if (change === 'unmount') probe.hide()
          },
          { change, session: SESSION }
        )
        control.finish(change === 'rejection' ? 'rejected' : 'applied')
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch))
          .toBe(null)
        assert.equal(turns, 0)
        assert.equal(
          await page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
            SESSION
          ),
          1
        )
        if (['model', 'instance', 'context', 'rejection'].includes(change))
          await expect(page.getByTestId('composer-input')).toHaveValue('retained continuation')
      })
    }
  )
}
