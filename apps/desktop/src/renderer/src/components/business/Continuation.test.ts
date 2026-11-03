import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { createInstance } from 'i18next'
import ts from 'typescript'
import zh from '../../../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../../../localization/locales/en/conversation.json' with { type: 'json' }

const sourcePath = new URL('./Continuation.tsx', import.meta.url)
const failure = {
  kind: 'error',
  turnId: 'failed-turn',
  failure: { kind: 'capability' },
}

function stateFixture() {
  return {
    backendReady: true,
    serviceInstanceId: 'service-one',
    modelCatalogInstanceId: 'service-one',
    activeSession: 'source-thread',
    model: 'subscription/model',
    modelSelectionGeneration: 1,
    modelSelectionPending: 0,
    draftGeneration: 2,
    navigationObservation: { generation: 3 },
    mainView: 'resource',
    activeTab: 'overview',
    homeSelectedProjectId: 'project-one',
    composerRefs: [],
    aiPanel: { revision: 1, sessionId: 'source-session' },
    projects: [{ id: 'project-one', path: '/workspace/project', available: true }],
    catalog: { models: [{ key: 'subscription/model' }] },
    threads: {
      'source-thread': {
        id: 'source-thread',
        sessionId: 'source-session',
        status: 'failed',
        lastSeq: 9,
        runtime: { model_id: 'subscription/model' },
        conversation: [failure],
        turnOutcomes: { 'failed-turn': 'failed' },
      },
    },
  }
}

function previewFixture() {
  return {
    source_session_id: 'source-session',
    source_product_seq: 9,
    source_title: 'Original task',
    project_path: '/workspace/project',
    model_id: 'subscription/model',
    messages: [
      { role: 'user', text: 'Original request' },
      { role: 'assistant', text: 'Visible answer' },
    ],
    included_messages: 2,
    omitted_messages: 1,
    omitted_characters: 12,
    truncated: true,
    excluded_categories: [
      'attachments',
      'encrypted_content',
      'tools',
      'subagents',
      'authorization',
    ],
  }
}

async function createHarness(language = 'zh') {
  const locale = createInstance()
  await locale.init({
    lng: language,
    fallbackLng: false,
    resources: { zh: { conversation: zh }, en: { conversation: en } },
  })
  const translator = locale.getFixedT(null, 'conversation')
  let state = stateFixture()
  let draft = ''
  let revision = 0
  const slots: unknown[] = []
  const effects = new Map<number, { dependencies?: unknown[]; cleanup?: () => void }>()
  let cursor = 0
  let preview = async (_sessionId: string, _turnId: string, _signal?: AbortSignal) =>
    previewFixture()
  const requests: Array<{ sessionId: string; turnId: string; signal?: AbortSignal }> = []
  const starts: unknown[] = []
  const components = Object.fromEntries(
    [
      'Alert',
      'AlertDescription',
      'Button',
      'Dialog',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogPortal',
      'DialogTitle',
      'Spinner',
      'Textarea',
    ].map((name) => [name, name])
  )
  const effect = (callback: () => (() => void) | void, dependencies?: unknown[]) => {
    const index = cursor++
    const previous = effects.get(index)
    if (
      dependencies &&
      previous?.dependencies &&
      dependencies.every((value, position) => Object.is(value, previous.dependencies?.[position]))
    )
      return
    previous?.cleanup?.()
    effects.set(index, { dependencies, cleanup: callback() || undefined })
  }
  const react = {
    ...React,
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (update: unknown) => {
          slots[index] = typeof update === 'function' ? update(slots[index]) : update
        },
      ]
    },
    useRef: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useId: () => `continuation-${cursor++}`,
    useLayoutEffect: effect,
    useEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => {
      cursor++
      return snapshot()
    },
  }
  const store = {
    get state() {
      return state
    },
    getSnapshot: () => state,
    composerDraft: {
      getSnapshot: () => draft,
      getRevision: () => revision,
      subscribe: () => () => {},
    },
    act: {
      startDraft: (seed: unknown) => {
        starts.push(seed)
      },
    },
  }
  const module = { exports: {} as Record<string, any> }
  const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    AbortController,
    require: (name: string) => {
      if (name === 'react') return react
      if (name === 'react-i18next') return { useTranslation: () => ({ t: translator }) }
      if (name === '../../store')
        return {
          useApp: () => store,
          activeThread: (current: typeof state) =>
            current.threads[current.activeSession as keyof typeof current.threads],
        }
      if (name === '../../api')
        return {
          getSessionContinuation: (sessionId: string, turnId: string, signal?: AbortSignal) => {
            requests.push({ sessionId, turnId, signal })
            return preview(sessionId, turnId, signal)
          },
        }
      if (name === '../ui') return components
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  const render = () => {
    cursor = 0
    return module.exports.Continuation({ item: failure }) as React.ReactElement
  }
  return {
    render,
    requests,
    starts,
    translator,
    get state() {
      return state
    },
    setState: (update: (current: typeof state) => typeof state) => {
      state = update(state)
    },
    setDraft: (text: string) => {
      draft = text
      revision++
    },
    setPreview: (read: typeof preview) => {
      preview = read
    },
    unmount: () => {
      for (const current of effects.values()) current.cleanup?.()
    },
  }
}

function find(element: React.ReactNode, testId: string): React.ReactElement<any> | undefined {
  if (!React.isValidElement<any>(element)) return undefined
  if (element.type === 'Dialog' && !element.props.open) return undefined
  if (element.props['data-testid'] === testId) return element
  for (const child of React.Children.toArray(element.props.children)) {
    const match = find(child, testId)
    if (match) return match
  }
  return undefined
}

test('compatible continuation prepares a localized editable draft without executing a turn', async () => {
  for (const language of ['zh', 'en']) {
    const harness = await createHarness(language)
    await find(harness.render(), 'turn-compatible-continuation')!.props.onClick()
    assert.equal(harness.requests.length, 1)
    assert.equal(harness.starts.length, 0)
    const dialog = harness.render()
    const confirm = find(dialog, 'continuation-confirm')!
    assert.equal(confirm.props.disabled, false)
    const text = find(dialog, 'continuation-preview')!.props.value
    assert.ok(text.includes('Original request'))
    assert.ok(text.includes('Visible answer'))
    assert.ok(text.includes(harness.translator('continuation.draftWarning')))
    confirm.props.onClick()
    assert.equal(harness.starts.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(harness.starts[0])), {
      composerText: text,
      projectId: 'project-one',
      modelId: 'subscription/model',
      submit: false,
    })
  }
})

test('only the latest stable writable capability failure offers compatible continuation', async () => {
  for (const patch of [
    { readOnly: true },
    { terminated: true },
    { running: true },
    { interrupting: true },
    { recoveryPending: true },
    { resumeState: 'pending' },
    { activeTurnId: 'active' },
    { conversation: [failure, { kind: 'user', turnId: 'later-turn' }] },
    { turnOutcomes: { 'failed-turn': 'completed' } },
    { queuedMessages: [{ state: 'outcome_unknown' }] },
  ]) {
    const harness = await createHarness()
    harness.setState(
      (current) =>
        ({
          ...current,
          threads: { 'source-thread': { ...current.threads['source-thread'], ...patch } },
        }) as typeof current
    )
    assert.equal(
      find(harness.render(), 'turn-compatible-continuation'),
      undefined,
      JSON.stringify(patch)
    )
  }
})

test('existing or newly edited drafts and references are never overwritten', async () => {
  const existing = await createHarness()
  existing.setDraft('Unsent input')
  await find(existing.render(), 'turn-compatible-continuation')!.props.onClick()
  assert.equal(existing.requests.length, 0)
  assert.ok(find(existing.render(), 'continuation-draft-conflict'))
  assert.equal(find(existing.render(), 'continuation-confirm')!.props.disabled, true)
  const changed = await createHarness()
  await find(changed.render(), 'turn-compatible-continuation')!.props.onClick()
  changed.setDraft('New unsent input')
  find(changed.render(), 'continuation-confirm')!.props.onClick()
  assert.equal(changed.starts.length, 0)
  const references = await createHarness()
  await find(references.render(), 'turn-compatible-continuation')!.props.onClick()
  references.setState(
    (current) => ({ ...current, composerRefs: [{ type: 'file' }] }) as typeof current
  )
  find(references.render(), 'continuation-confirm')!.props.onClick()
  assert.equal(references.starts.length, 0)
})

test('closing or superseding a preview rejects late responses and duplicate requests', async () => {
  const harness = await createHarness()
  let resolve!: (value: ReturnType<typeof previewFixture>) => void
  harness.setPreview(
    () =>
      new Promise((settle) => {
        resolve = settle
      })
  )
  const trigger = find(harness.render(), 'turn-compatible-continuation')!
  const pending = trigger.props.onClick()
  await trigger.props.onClick()
  assert.equal(harness.requests.length, 1)
  find(harness.render(), 'continuation-cancel')!.props.onClick()
  assert.equal(harness.requests[0].signal?.aborted, true)
  resolve(previewFixture())
  await pending
  assert.equal(find(harness.render(), 'continuation-confirm'), undefined)
  assert.equal(harness.starts.length, 0)
})

test('service, navigation, source turn and model changes invalidate an open preview', async () => {
  const updates = [
    (current: ReturnType<typeof stateFixture>) => ({
      ...current,
      serviceInstanceId: 'service-two',
    }),
    (current: ReturnType<typeof stateFixture>) => ({
      ...current,
      navigationObservation: { generation: 4 },
    }),
    (current: ReturnType<typeof stateFixture>) => ({ ...current, modelSelectionGeneration: 2 }),
    (current: ReturnType<typeof stateFixture>) => ({ ...current, model: 'other/model' }),
    (current: ReturnType<typeof stateFixture>) => ({
      ...current,
      threads: { 'source-thread': { ...current.threads['source-thread'], lastSeq: 10 } },
    }),
  ]
  for (const update of updates) {
    const harness = await createHarness()
    await find(harness.render(), 'turn-compatible-continuation')!.props.onClick()
    const confirm = find(harness.render(), 'continuation-confirm')!
    harness.setState(update)
    confirm.props.onClick()
    assert.equal(harness.starts.length, 0)
    assert.equal(find(harness.render(), 'continuation-confirm'), undefined)
  }
})

test('unavailable models, unknown projects and failed previews remain explicit and do not switch sources', async () => {
  for (const variant of ['model', 'project', 'failure', 'source']) {
    const harness = await createHarness()
    if (variant === 'model')
      harness.setState((current) => ({ ...current, catalog: { models: [] } }))
    if (variant === 'project')
      harness.setPreview(async () => ({ ...previewFixture(), project_path: '/unknown' }))
    if (variant === 'failure')
      harness.setPreview(async () => {
        throw new Error('private upstream detail')
      })
    if (variant === 'source')
      harness.setPreview(async () => ({ ...previewFixture(), source_session_id: 'other-session' }))
    await find(harness.render(), 'turn-compatible-continuation')!.props.onClick()
    const element = harness.render()
    assert.equal(find(element, 'continuation-confirm')!.props.disabled, true)
    assert.ok(find(element, 'continuation-error'))
    assert.equal(harness.starts.length, 0)
    assert.equal(harness.state.model, 'subscription/model')
  }
})
