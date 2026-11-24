import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { block } from '../../test-helpers/source-contract.ts'
import { openedSessionTitle } from './session.ts'
import {
  projectCatalogFailure,
  pruneMissingCatalogThreads,
  sameSessionCatalog,
  sessionSummaryNeedsCatalog,
} from './catalog.ts'
import type { AspEnvelope, ServeSession, SessionStatusSnapshot } from './api.ts'
import type { Thread } from './model.ts'
import { catalogRunStateIsCurrent, projectSessionState, recoveryCheckIsCurrent } from './runtime.ts'
import { projectContextCompaction } from './transcript.ts'
import { activityRows, hasVisibleTurnProgress, workingIndicatorVisible } from './activity.ts'

/**
 * 「AI 改了产品数据 → 界面按数据域失效重取」这条接线的契约测试。
 *
 * live.ts 的事件分发只有真实会话流才跑得到, 所以与 store.test.ts 同一做法: 把接线当
 * 源码契约钉住。钉接线而不是钉行为, 是因为 onEvent 用的是位置参数 —— 少传一个或者顺序
 * 错位时, 两个箭头函数的类型仍然兼容, TypeScript 会放行, 症状却是新事件永远不生效。
 */
const liveSource = readFileSync(new URL('./live.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')

test('native compaction establishes active turn progress before any answer or tool event', () => {
  let current: Thread = {
    id: 'thread',
    title: 'Task',
    sessionId: 'session',
    conversation: [],
    lastSeq: 0,
  }
  const branch = block(liveSource, "case 'context_compacted':", "case 'turn_completed':")
  const apply = runInNewContext(
    ts.transpileModule(
      `${block(liveSource, 'function turnOutcomes(', 'function productEventTime(')}
      (event) => { switch (event.type) { ${branch} } }`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }
    ).outputText,
    {
      threadId: current.id,
      projectContextCompaction,
      patchThread: (_id: string, update: (thread: Thread) => Partial<Thread>) => {
        current = { ...current, ...update(current) }
      },
    }
  ) as (event: Extract<AspEnvelope, { type: 'context_compacted' }>) => void
  const event: Extract<AspEnvelope, { type: 'context_compacted' }> = {
    v: 2,
    seq: 1,
    ts: 1,
    session_id: 'session',
    turn_id: 'native-turn',
    item_id: 'compact',
    type: 'context_compacted',
    data: { phase: 'started' },
  }
  apply(event)
  const active = Object.entries(current.turnOutcomes ?? {})
    .filter(([, v]) => v === 'running')
    .at(-1)?.[0]
  assert.equal(active, 'native-turn')
  assert.equal(current.running, true)
  assert.equal(
    workingIndicatorVisible(
      true,
      false,
      0,
      hasVisibleTurnProgress(activityRows(current.conversation), active)
    ),
    false
  )
  apply({ ...event, seq: 2, data: { phase: 'completed' } })
  assert.equal(
    workingIndicatorVisible(
      true,
      false,
      0,
      hasVisibleTurnProgress(activityRows(current.conversation), active)
    ),
    true
  )
})

function liveSessionStateProjector(initial: Thread) {
  let current = initial
  const branch = block(liveSource, "case 'session_state': {", "case 'session_title_updated':")
  const apply = runInNewContext(
    ts.transpileModule(`(event) => { switch (event.type) { ${branch} } }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      threadId: current.id,
      projectSessionState,
      patchThread: (_id: string, update: (thread: Thread) => Partial<Thread>) => {
        current = { ...current, ...update(current) }
      },
      turnTimings: (thread: Thread) => thread.turnTimings,
      productEventTime: () => 0,
      set: () => {},
      refreshMeta: { current: () => {} },
    }
  ) as (
    event: Pick<Extract<AspEnvelope, { type: 'session_state' }>, 'type' | 'data' | 'seq'>
  ) => void
  return (event: Parameters<typeof apply>[0]): Thread => {
    apply(event)
    return current
  }
}

test('live recovery incidents supply the identity used to reject a superseded check', () => {
  const apply = liveSessionStateProjector({
    id: 'thread',
    title: 'Task',
    sessionId: 'session',
    conversation: [],
    lastSeq: 0,
  })
  const blocked = {
    state: 'failed',
    runtime_id: 'codex',
    recovery_blocked: true,
    recovery_pending: true,
    incident_id: 'incident-1',
  } as const
  const requested = apply({ type: 'session_state', seq: 10, data: blocked })
  assert.equal(requested.recoveryIncidentId, 'incident-1')
  assert.equal(requested.recoverySourceSeq, 10)
  const current = apply({
    type: 'session_state',
    seq: 12,
    data: { ...blocked, incident_id: 'incident-2' },
  })
  assert.equal(current.recoveryIncidentId, 'incident-2')
  assert.equal(current.recoverySourceSeq, 12)
  assert.equal(recoveryCheckIsCurrent(current, requested), false)
})

test('a new active turn supersedes settlement while blocked recovery remains pending', () => {
  const thread: Thread = {
    id: 'thread',
    title: 'Task',
    sessionId: 'session',
    conversation: [],
    lastSeq: 20,
    activeTurnId: 'completed-turn',
    recoveryPending: true,
    resourceFinalizing: true,
  }
  const active = {
    type: 'session_state',
    seq: 21,
    data: { state: 'running', runtime_id: 'codex', active_turn_id: 'next-turn' },
  } as const
  const next = liveSessionStateProjector(thread)(active)
  assert.equal(next.running, true)
  assert.equal(next.activeTurnId, 'next-turn')
  assert.equal(next.recoveryPending, false)
  assert.equal(next.resourceFinalizing, false)

  for (const data of [
    { ...active.data, active_turn_id: undefined },
    { ...active.data, active_turn_id: 'completed-turn' },
    { ...active.data, recovery_pending: true },
  ]) {
    const unchanged = liveSessionStateProjector(thread)({ ...active, data })
    assert.equal(unchanged.recoveryPending, true)
    assert.equal(unchanged.resourceFinalizing, true)
  }
  const blocked = liveSessionStateProjector(thread)({
    ...active,
    data: { ...active.data, recovery_blocked: true },
  })
  assert.equal(blocked.recoveryPending, true)
  assert.equal(blocked.resourceFinalizing, false)
})

test('shared notifications forward subjects without changing legacy record reset delivery', () => {
  const source = readFileSync(new URL('./app/notifications.ts', import.meta.url), 'utf8')
  const frames: unknown[] = []
  const records: boolean[] = []
  const context = {
    current: undefined,
    subscriptions: new Set([
      {
        topics: ['sessions'],
        listener: (reset: boolean, changes: unknown) => frames.push({ reset, changes }),
      },
      { topics: ['records'], listener: (reset: boolean) => records.push(reset) },
    ]),
    publish: undefined as unknown as (frame: unknown) => void,
  }
  runInNewContext(
    ts.transpileModule(block(source, 'function publish(', 'function connect('), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  const changes = [{ topic: 'sessions', subject: 'background' }]
  context.publish({ reset: false, changes })
  assert.deepEqual(frames, [{ reset: false, changes }])
  assert.deepEqual(records, [])
  context.publish({ reset: false, changes: [{ topic: 'records', subject: 'annotation' }] })
  context.publish({ reset: true, changes: [] })
  assert.deepEqual(records, [false, true])
})

test('thread status snapshots invalidate the catalog only for an actual title change', () => {
  let state = {
    activeSession: null,
    sessionCatalogRevision: 0,
    sessions: [{ id: 'background', title: 'Task', status: 'running' }],
    threads: {
      background: {
        id: 'background',
        sessionId: 'background',
        title: 'Task',
        title_fallback: null,
        running: true,
        status: 'running',
      },
    },
  }
  const context = {
    useCallback: (callback: unknown) => callback,
    setState: (update: (current: typeof state) => typeof state) => {
      state = update(state)
    },
    findSessionNode: (nodes: typeof state.sessions, id: string) =>
      nodes.find((node) => node.id === id),
    upsertSessionNode: (nodes: typeof state.sessions, changed: (typeof state.sessions)[number]) =>
      nodes.map((node) => (node.id === changed.id ? changed : node)),
    patchThread: undefined as unknown as (id: string, patch: unknown) => void,
  }
  const source = block(storeSource, 'const patchThread = useCallback', 'const appendThread =')
  runInNewContext(
    transformSync(`${source}; globalThis.patchThread = patchThread`, { loader: 'ts' }).code,
    context
  )
  context.patchThread('background', {
    ...state.threads.background,
    running: false,
    status: 'waiting',
  })
  assert.equal(state.sessionCatalogRevision, 0)
  assert.equal(state.sessions[0].status, 'waiting')
  context.patchThread('background', { title: 'Renamed', title_fallback: null })
  assert.equal(state.sessionCatalogRevision, 1)
  context.patchThread('background', { ...state.threads.background })
  assert.equal(state.sessionCatalogRevision, 1)
  context.patchThread('background', { title_fallback: 'new_session' })
  assert.equal(state.sessionCatalogRevision, 2)
  const before = state
  context.patchThread('background', (thread: unknown) => thread)
  assert.equal(state, before)
})

const INVALIDATION_EVENT = 'product_data_changed'

test('history replacement cannot permanently erase an unknown-model warning', () => {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let callback = ''
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'markUnknownModel') {
      const call = node.initializer
      if (call && ts.isCallExpression(call)) callback = call.arguments[0].getText(parsed)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(callback)
  const state = { threads: { thread: { resumeState: 'pending', conversation: [] as unknown[] } } }
  let patches = 0
  const context = {
    getSnapshot: () => state,
    resumeUnknownModels: { current: new Set<string>() },
    resumeStopped: { current: new Set<string>() },
    resumeDeferredRetries: { current: new Set<string>() },
    resumeRetryTimers: { current: {} },
    window: { clearTimeout: () => {} },
    reportSessionResume: () => ({
      conversation: [
        {
          kind: 'status',
          incidentId: 'session-resume:session',
          text: { key: 'resume.modelSelectionUnknown' },
        },
      ],
    }),
    patchThread: (_id: string, update: (thread: unknown) => object) => {
      patches++
      Object.assign(state.threads.thread, update(state.threads.thread))
    },
  }
  const js = ts.transpileModule(`globalThis.mark = ${callback}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mark = runInNewContext(`${js}; globalThis.mark`, context) as (
    id: string,
    sid: string
  ) => void
  mark('thread', 'session')
  mark('thread', 'session')
  assert.equal(patches, 1)
  state.threads.thread.conversation = [] // a late history snapshot replaces the notice
  mark('thread', 'session')
  assert.equal(patches, 2)
})

test('resume cleanup keeps a terminal result and requeues only a superseded attempt', () => {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let cleanup = ''
  function visit(node: ts.Node): void {
    if (ts.isTryStatement(node) && node.finallyBlock?.getText(parsed).includes('ownsAttempt'))
      cleanup = node.finallyBlock.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(cleanup)
  for (const [superseded, unknown] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const attempt = {}
    const inFlight = new Map([['thread', attempt]])
    const patches: unknown[] = []
    const thread = { sessionId: 'session', readOnly: false }
    const state = {
      threads: { thread },
      activeSession: 'thread',
      backendReady: true,
      runtimeQuiescing: false,
    }
    const context = {
      threadId: 'thread',
      attempt,
      generation: 1,
      resumeInFlight: { current: inFlight },
      current: () => !superseded && inFlight.get('thread') === attempt,
      stateRef: { current: state },
      startupSnapshot: () => ({ generation: 1 }),
      disposed: { current: false },
      resumeUnknownModels: { current: new Set(unknown ? ['thread'] : []) },
      detachers: { current: {} },
      patchThread: (_id: string, value: unknown) => patches.push(value),
    }
    runInNewContext(
      ts.transpileModule(cleanup, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
    assert.equal(inFlight.has('thread'), false)
    assert.deepEqual(
      patches.map((value) => JSON.stringify(value)),
      superseded && !unknown ? ['{"resumeState":"pending"}'] : []
    )
  }
})

test('model selection supersedes a delayed resume response and requeues after selection', () => {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let currentSource = ''
  let cleanup = ''
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      (node.name.getText(parsed) === 'streamCurrent' ||
        (node.name.getText(parsed) === 'current' &&
          node.getText(parsed).includes('modelSelectionSessions')))
    ) {
      const name = node.name.getText(parsed)
      currentSource += `const ${node.getText(parsed)}; globalThis.${name} = ${name};`
    }
    if (ts.isTryStatement(node) && node.finallyBlock?.getText(parsed).includes('ownsAttempt'))
      cleanup = node.finallyBlock.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(currentSource && cleanup)
  const attempt = {}
  const inFlight = new Map([['thread', attempt]])
  const patches: unknown[] = []
  const snapshot = {
    threads: { thread: { sessionId: 'session', readOnly: false } },
    activeSession: 'thread',
    backendReady: true,
    workbenchReady: true,
    runtimeQuiescing: false,
    serviceInstanceId: 'instance',
    modelSelectionSessions: {
      thread: { generation: 4, pending: 0 },
      other: { generation: 0, pending: 0 },
    },
  }
  const context = {
    threadId: 'thread',
    sessionId: 'session',
    attempt,
    generation: 1,
    instance: 'instance',
    modelGeneration: 4,
    lease: { current: () => true },
    resumeInFlight: { current: inFlight },
    stateRef: { current: snapshot },
    getSnapshot: () => snapshot,
    startupSnapshot: () => ({ generation: 1, phase: 'ready' }),
    STARTUP_PHASE: { ready: 'ready' },
    disposed: { current: false },
    resumeUnknownModels: { current: new Set() },
    detachers: { current: {} },
    patchThread: (_id: string, value: unknown) => patches.push(value),
  }
  const run = (source: string) =>
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
  run(currentSource)
  const current = (context as typeof context & { current: () => boolean }).current
  assert.equal(current(), true)
  snapshot.modelSelectionSessions.other = { generation: 1, pending: 1 }
  assert.equal(current(), true, 'another session selection must not invalidate this attempt')
  snapshot.modelSelectionSessions.thread = { generation: 5, pending: 1 }
  assert.equal(current(), false, 'old 409 must not be applied while the selection is pending')
  snapshot.modelSelectionSessions.thread.pending = 0
  assert.equal(current(), false, 'old 409 must remain stale after the selection completes')
  run(cleanup)
  assert.deepEqual(
    patches.map((value) => JSON.stringify(value)),
    ['{"resumeState":"pending"}']
  )
})

test('attached session stream keeps applying events across model selection', () => {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  const declarations: Record<string, string> = {}
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(parsed)
      if (
        (name === 'current' && node.getText(parsed).includes('modelSelectionSessions')) ||
        name === 'streamCurrent' ||
        (name === 'attach' && node.getText(parsed).includes('streamEvents'))
      )
        declarations[name] = `const ${node.getText(parsed)}; globalThis.${name} = ${name};`
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(declarations.current && declarations.attach)
  const snapshot = {
    threads: { thread: { sessionId: 'session', readOnly: false } },
    activeSession: 'thread',
    backendReady: true,
    workbenchReady: true,
    runtimeQuiescing: false,
    serviceInstanceId: 'instance',
    modelSelectionSessions: { thread: { generation: 0, pending: 0 } },
  }
  const applied: string[] = []
  let consume: ((event: { type: string; seq: number }) => void) | undefined
  const context = {
    threadId: 'thread',
    sessionId: 'session',
    generation: 1,
    instance: 'instance',
    modelGeneration: 0,
    lease: { current: () => true, attach: (open: () => unknown) => open() },
    stateRef: { current: snapshot },
    getSnapshot: () => snapshot,
    startupSnapshot: () => ({ generation: 1, phase: 'ready' }),
    STARTUP_PHASE: { ready: 'ready' },
    disposed: { current: false },
    resumeUnknownModels: { current: new Set<string>() },
    detachers: { current: {} },
    streamEvents: (_sessionId: string, _fromSeq: number, callback: NonNullable<typeof consume>) => {
      consume = callback
      return () => undefined
    },
    onEvent: (_threadId: string, event: { type: string }) => applied.push(event.type),
    patchThread: () => undefined,
    set: () => undefined,
    liveIndex: { current: {} },
    refreshMetaRef: { current: () => undefined },
    act: { invalidateResources: () => undefined },
    bodySequences: { current: new Map() },
    acceptedQueueSequences: { current: new Map() },
  }
  for (const name of ['streamCurrent', 'current', 'attach']) {
    if (!declarations[name]) continue
    runInNewContext(
      ts.transpileModule(declarations[name], {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
  }
  ;(context as typeof context & { attach: (sequence: number) => void }).attach(0)
  assert.ok(consume)
  consume({ type: 'turn_completed', seq: 1 })
  snapshot.modelSelectionSessions.thread = { generation: 1, pending: 1 }
  consume({ type: 'session_state', seq: 2 })
  snapshot.modelSelectionSessions.thread.pending = 0
  consume({ type: 'turn_completed', seq: 3 })
  assert.deepEqual(applied, ['turn_completed', 'session_state', 'turn_completed'])
  snapshot.activeSession = 'other'
  consume({ type: 'turn_completed', seq: 4 })
  snapshot.activeSession = 'thread'
  snapshot.serviceInstanceId = 'replacement'
  consume({ type: 'turn_completed', seq: 5 })
  snapshot.serviceInstanceId = 'instance'
  context.resumeUnknownModels.current.add('thread')
  consume({ type: 'turn_completed', seq: 6 })
  assert.equal(applied.length, 3)
})

test('retry due during model selection preserves its attempt count and resumes after selection', () => {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let timer = ''
  let effect = ''
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'window.setTimeout' &&
      node.arguments[0]?.getText(parsed).includes('resumeDeferredRetries.current.add')
    )
      timer = `(${node.arguments[0].getText(parsed)})()`
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'useEffect' &&
      node.getText(parsed).includes('resumeDeferredRetries.current.delete(threadId)') &&
      node.getText(parsed).includes('targets.forEach')
    )
      effect = node.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(timer && effect)
  const attempts = new Map([['session', 3]])
  const deferred = new Set<string>()
  let calls = 0
  let unknown = false
  let marked = 0
  const state = {
    activeSession: 'thread',
    backendReady: true,
    workbenchReady: true,
    runtimeQuiescing: false,
    serviceInstanceId: 'instance',
    modelSelectionSessions: { thread: { pending: 1, generation: 1 } },
    threads: { thread: { sessionId: 'session', resumeState: 'pending', readOnly: false } },
  }
  const context = {
    threadId: 'thread',
    sessionId: 'session',
    state,
    getSnapshot: () => state,
    resumeRetryTimers: { current: { thread: 42 } },
    resumeDeferredRetries: { current: deferred },
    resumeAttempts: { current: attempts },
    resumeStopped: { current: new Set() },
    resumeUnknownModels: { current: new Set() },
    resumeInFlight: { current: new Map() },
    subscriptions: { current: { retain: () => {} } },
    window: { clearTimeout: () => {} },
    detachers: { current: {} },
    liveIndex: { current: {} },
    hasUnknownModel: () => unknown,
    markUnknownModel: () => {
      marked++
    },
    patchThread: () => {},
    ensure: () => {
      calls++
    },
    useEffect: (callback: () => void) => callback(),
  }
  const run = (source: string) =>
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
  run(timer)
  assert.equal(calls, 0)
  run(effect)
  assert.equal(attempts.get('session'), 3)
  state.modelSelectionSessions.thread.pending = 0
  run(effect)
  assert.equal(calls, 1)
  assert.equal(attempts.get('session'), 3)
  assert.equal(deferred.size, 0)
  // A restored ledger entry must win over a pending automatic retry.
  unknown = true
  run(effect)
  assert.equal(calls, 1)
  assert.equal(marked, 1)
})

// Run the production refresh callback and lifecycle effect with controlled I/O.
// These are deterministic race tests, not real Desktop acceptance.
function metadataHarness() {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let refresh = ''
  let lifecycle = ''
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'refreshMeta')
      refresh = `const ${node.getText(parsed)}; globalThis.refresh = refreshMeta;`
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'useEffect' &&
      node.getText(parsed).includes('metadataRequest.current += 1')
    )
      lifecycle = node.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(refresh && lifecycle)
  const state = {
    runtimeQuiescing: false,
    backendReady: true,
    workspaceLoadState: 'ready',
    projectsLoaded: false,
    projects: [],
    defaultWorkspacePath: '',
    threads: {},
    sessions: [],
    activeSession: null,
    sessionActivitySeen: {},
    sessionActivityInitialized: false,
    sessionCatalogRevision: 0,
    foregroundError: null,
  }
  let committed = state
  const queued: ((current: typeof state) => typeof state)[] = []
  const reductions: (typeof state)[] = []
  let applyPatch!: (value: unknown) => void
  let calls = 0
  let retries = 0
  const updates: unknown[] = []
  let resolve!: (value: unknown) => void
  const context = {
    state,
    stateRef: { current: state },
    startupSnapshot: () => ({ phase: 'ready', generation: 1 }),
    STARTUP_PHASE: { ready: 'ready' },
    metadataRequest: { current: 0 },
    metadataRetryAttempt: { current: 0 },
    metadataPollInFlight: { current: null },
    metadataSessions: { current: [] },
    refreshMetaRef: { current: () => undefined },
    detachers: { current: {} },
    subscriptions: { current: { clear: () => undefined } },
    resumeRetryTimers: { current: {} },
    resumeInFlight: { current: new Map() },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => fn(),
    set: (value: unknown) => {
      updates.push(value)
      applyPatch(value)
    },
    setState: (update: (current: typeof state) => typeof state) => queued.push(update),
    settingsSurface: { current: { project: () => ({}) } },
    availabilityPolicy: { navigationPatch: (_current: unknown, delta: unknown) => delta },
    projectCatalogFailure,
    pruneMissingCatalogThreads,
    sameSessionCatalog,
    SESSION_CATALOG_APPEARANCE_GRACE_SECONDS: 5,
    SESSION_CATALOG_RECOVERY_NOTICE: 'retrying',
    SESSION_CATALOG_UNAVAILABLE_NOTICE: 'unavailable',
    listProjects: async () => ({ projects: [], default: '' }),
    loadSessionCatalog: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
    scheduleMetadataRetry: () => {
      retries++
    },
    cancelMetadataRetry: () => {
      retries = 0
    },
  }
  const run = (source: string) =>
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context
    )
  applyPatch = run(`(() => {
    ${block(storeSource, 'const set = useCallback((patch:', 'const closeMenus =')}
    return set
  })()`)
  run(block(liveSource, 'function mergeLocalThreads(', 'export function useLiveSession'))
  run(refresh)
  context.refreshMetaRef.current = () => {
    void (context as typeof context & { refresh: () => Promise<void> }).refresh()
  }
  return {
    state,
    updates,
    reductions,
    committed: () => committed,
    flush: () => {
      for (const update of queued.splice(0)) {
        committed = update(committed)
        reductions.push(committed)
      }
      context.stateRef.current = committed
      return committed
    },
    refresh: (context as typeof context & { refresh: () => Promise<void> }).refresh,
    fail: (retryable = true) => resolve({ ok: false, failure: { retryable } }),
    succeed: () => resolve({ ok: true, catalog: { sessions: [] } }),
    lifecycle: () => run(lifecycle),
    calls: () => calls,
    retries: () => retries,
  }
}

test('queued catalog success cannot be downgraded by its dirty follow-up before commit', async () => {
  const harness = metadataHarness()
  harness.state.workspaceLoadState = 'loading'
  const first = harness.refresh()
  void harness.refresh()
  void harness.refresh()
  assert.equal(harness.calls(), 1)
  harness.succeed()
  await first
  assert.equal(harness.calls(), 2)
  assert.equal(harness.state.workspaceLoadState, 'loading')
  const committed = harness.flush()
  assert.equal(committed.workspaceLoadState, 'ready')
  assert.equal(committed.projectsLoaded, true)
  assert.equal(harness.reductions.at(-1), harness.reductions.at(-2))
  assert.equal(harness.calls(), 2)
  const lastUpdate = harness.updates.at(-1)
  assert.ok(typeof lastUpdate === 'function')
  assert.deepEqual(Object.keys(lastUpdate(committed)), [])
  harness.succeed()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.calls(), 2)
  assert.equal(harness.flush().workspaceLoadState, 'ready')
})

test('catalog refresh still loads initial and errored workspaces and preserves ready identity', async () => {
  for (const initial of ['loading', 'error', 'ready']) {
    const harness = metadataHarness()
    harness.state.workspaceLoadState = initial
    const first = harness.refresh()
    const before = harness.committed()
    const loading = harness.flush()
    assert.equal(loading.workspaceLoadState, initial === 'ready' ? 'ready' : 'loading')
    if (initial === 'ready') assert.equal(loading, before)
    harness.succeed()
    await first
    assert.equal(harness.flush().workspaceLoadState, 'ready')
  }
})

for (const retryable of [true, false]) {
  test(`queued catalog success survives a dirty ${retryable ? 'retryable' : 'non-retryable'} failure before commit`, async () => {
    const harness = metadataHarness()
    harness.state.workspaceLoadState = 'loading'
    const first = harness.refresh()
    void harness.refresh()
    harness.succeed()
    await first
    assert.equal(harness.calls(), 2)
    harness.fail(retryable)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.state.workspaceLoadState, 'loading')
    const committed = harness.flush()
    assert.equal(committed.workspaceLoadState, 'ready')
    assert.equal(committed.projectsLoaded, true)
    assert.equal(committed.foregroundError, retryable ? 'retrying' : 'unavailable')
    assert.equal(harness.retries(), Number(retryable))
    assert.equal(harness.calls(), 2)
  })
}

test('initial and errored workspace catalog failures stay errored with the original retry policy', async () => {
  for (const initial of ['loading', 'error']) {
    for (const retryable of [true, false]) {
      const harness = metadataHarness()
      harness.state.workspaceLoadState = initial
      const first = harness.refresh()
      harness.fail(retryable)
      await first
      const committed = harness.flush()
      assert.equal(committed.workspaceLoadState, 'error')
      assert.equal(committed.projectsLoaded, false)
      assert.equal(committed.foregroundError, null)
      assert.equal(harness.retries(), Number(retryable))
      assert.equal(harness.calls(), 1)
    }
  }
})

test('all catalog refresh entry points share one request and one dirty follow-up', async () => {
  const harness = metadataHarness()
  const first = harness.refresh()
  void harness.refresh()
  void harness.refresh()
  assert.equal(harness.calls(), 1)
  harness.fail()
  await first
  assert.equal(harness.calls(), 2)
  harness.fail()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.calls(), 2)
})

function catalogThreadReconciler() {
  const source = block(
    liveSource,
    'function reconcileThreadRuntime(',
    'export function useLiveSession'
  )
  const context = {
    openedSessionTitle,
    catalogRunStateIsCurrent,
    reconcileThreadRuntime: undefined as unknown as (
      threads: Record<string, Thread>,
      sessions: (Partial<ServeSession> & Pick<ServeSession, 'session_id'>)[]
    ) => Record<string, Thread>,
  }
  runInNewContext(
    ts.transpileModule(`${source}; globalThis.reconcileThreadRuntime = reconcileThreadRuntime`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  return context.reconcileThreadRuntime
}

test('authoritative catalog titles replace stale background titles before status patches', () => {
  const result = catalogThreadReconciler()(
    {
      background: {
        id: 'background',
        sessionId: 'background',
        lastSeq: 0,
        conversation: [],
        title: 'New task',
        title_fallback: 'new_session',
      },
    },
    [{ session_id: 'background', title: 'Authoritative title', title_fallback: null }]
  )
  assert.equal(result.background.title, 'Authoritative title')
  assert.equal(result.background.title_fallback, null)
})

test('only current sequenced catalog state can clear pending resource settlement', () => {
  const reconcile = catalogThreadReconciler()
  const thread: Thread = {
    id: 'thread',
    sessionId: 'session',
    title: 'Task',
    conversation: [],
    lastSeq: 20,
    status: 'done',
    running: false,
    recoveryPending: true,
    recoveryBlocked: false,
    resourceFinalizing: true,
  }
  const settled = { session_id: 'session', recovery_pending: false, resource_finalizing: false }
  for (const snapshot of [settled, { ...settled, last_seq: 19 }]) {
    const next = reconcile({ thread }, [snapshot]).thread
    assert.equal(next.recoveryPending, true)
    assert.equal(next.resourceFinalizing, true)
    assert.equal(next.lastSeq, 20)
  }

  const completed = reconcile({ thread }, [{ ...settled, last_seq: 21 }]).thread
  assert.equal(completed.recoveryPending, false)
  assert.equal(completed.resourceFinalizing, false)
  assert.equal(completed.lastSeq, 20)

  const blocked = reconcile({ thread }, [
    { session_id: 'session', last_seq: 21, recovery_pending: true, recovery_blocked: true },
  ]).thread
  assert.equal(blocked.recoveryPending, true)
  assert.equal(blocked.recoveryBlocked, true)
  assert.equal(blocked.resourceFinalizing, false)
})

function sessionStatusHarness() {
  const parsed = ts.createSourceFile('live.ts', liveSource, ts.ScriptTarget.Latest, true)
  let effect = ''
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'useEffect' &&
      node.getText(parsed).includes('summarySequences.current.clear()')
    )
      effect = node.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(effect)
  let catalogReads = 0
  let statusReads = 0
  let beforePatch: (() => void) | undefined
  const scheduled: { callback: () => void; delay: number }[] = []
  const patched: string[] = []
  const acknowledgements: string[] = []
  const queuesAtRequest = new Map<string, Thread['queuedMessages']>()
  let accept!: (value: {
    sessionIds: string[]
    snapshots: SessionStatusSnapshot[]
    queuesAtRequest: typeof queuesAtRequest
  }) => void
  let notify!: (reset: boolean, changes: { topic: string; subject: string }[]) => void
  const background = {
    session_id: 'background',
    title: 'Task',
    running: true,
    turns: 1,
  } as SessionStatusSnapshot
  const state = {
    backendReady: true,
    workbenchReady: true,
    runtimeQuiescing: false,
    activeSession: 'foreground',
    threads: {
      background: {
        id: 'background',
        sessionId: 'background',
        title: 'Task',
        conversation: [],
        lastSeq: 0,
      } as Thread,
      foreground: {
        id: 'foreground',
        sessionId: 'foreground',
        title: 'Current',
        conversation: [],
        lastSeq: 0,
      } as Thread,
    },
  }
  runInNewContext(
    ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      state,
      stateRef: { current: state },
      metadataSessions: { current: [background] },
      getSnapshot: () => state,
      summarySequences: { current: new Map() },
      bodySequences: { current: new Map() },
      refreshStatusRef: { current: () => undefined },
      sessionSummaryNeedsCatalog,
      useEffect: (callback: () => unknown) => callback(),
      flushSync: (callback: () => unknown) => callback(),
      setTimeout: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
      clearTimeout: () => {},
      QUEUE_SNAPSHOT_RETRY_MS: 500,
      pollMetadata: () => {
        catalogReads++
      },
      patchThread: (
        id: keyof typeof state.threads,
        update: (thread: Thread) => Partial<Thread>
      ) => {
        beforePatch?.()
        // StrictMode replays the projection without committing its first invocation.
        const current = state.threads[id]
        update(current)
        const delta = update(current)
        if (delta !== current) state.threads[id] = { ...current, ...delta }
        patched.push(id)
      },
      queuedMessageFromPayload: (message: unknown) => message,
      mergeQueuedOutbox: (_session: string, messages: unknown[]) => messages,
      reconcileThreadRuntime: (threads: unknown) => threads,
      projectSessionRecovery: () => ({}),
      releaseQueuedOutbox: (_sessionId: string, identity: string) => {
        acknowledgements.push(identity)
      },
      act: { invalidateResources: () => undefined, invalidateLiterature: () => undefined },
      DirtyRefresh: class {
        constructor(_load: unknown, apply: typeof accept) {
          accept = apply
        }
        invalidate() {
          statusReads++
        }
      },
      subscribeChanges: (topics: string[], callback: typeof notify) => {
        if (topics.includes('sessions')) notify = callback
        return () => undefined
      },
    }
  )
  return {
    background,
    state,
    queuesAtRequest,
    accept,
    notify,
    acknowledgements,
    patched,
    scheduled,
    catalogReads: () => catalogReads,
    statusReads: () => statusReads,
    changeBeforePatch: (change: () => void) => {
      beforePatch = change
    },
  }
}

test('summary invalidation preserves status delivery and catalog catch-up for reset, removal and rename', () => {
  const {
    background,
    statusReads,
    catalogReads,
    accept,
    notify,
    queuesAtRequest,
    patched,
    acknowledgements,
    state,
  } = sessionStatusHarness()
  assert.equal(statusReads(), 1)
  notify(false, [{ topic: 'sessions', subject: 'background' }])
  assert.equal(catalogReads(), 0)
  assert.equal(statusReads(), 2)
  const waiting = {
    ...background,
    waiting: true,
    summary_seq: 10,
    acknowledged_queue_ids: ['queued'],
    queued_messages: [],
  }
  accept({ sessionIds: ['background'], snapshots: [waiting], queuesAtRequest })
  assert.equal(catalogReads(), 0)
  assert.deepEqual(patched, ['background'])
  assert.deepEqual(acknowledgements, ['queued'])
  assert.equal(state.threads.background.queueSnapshotSeq, 10)
  queuesAtRequest.set('background', state.threads.background.queuedMessages)
  accept({
    sessionIds: ['background'],
    snapshots: [{ ...waiting, summary_seq: 9, title: 'Stale' }],
    queuesAtRequest,
  })
  assert.equal(catalogReads(), 0)
  assert.equal(patched.length, 1)
  accept({
    sessionIds: ['background'],
    snapshots: [{ ...waiting, title: 'Renamed' }],
    queuesAtRequest,
  })
  assert.equal(catalogReads(), 1)
  accept({ sessionIds: ['background'], snapshots: [], queuesAtRequest })
  assert.equal(catalogReads(), 2)
  notify(false, [{ topic: 'sessions', subject: 'new-session' }])
  notify(false, [{ topic: 'projects', subject: 'project' }])
  notify(true, [])
  assert.equal(catalogReads(), 5)
})

test('a queue snapshot rejected during React publication cannot acknowledge the durable outbox and retries at most once per delay', () => {
  const h = sessionStatusHarness()
  h.changeBeforePatch(() => {
    h.state.threads.background = { ...h.state.threads.background, queuedMessages: [] }
  })
  const requested = {
    sessionIds: ['background'],
    queuesAtRequest: h.queuesAtRequest,
    snapshots: [
      {
        ...h.background,
        summary_seq: 10,
        acknowledged_queue_ids: ['queued'],
        queued_messages: [],
      },
    ],
  }
  h.accept(requested)
  assert.deepEqual(h.acknowledgements, [])
  assert.equal(h.state.threads.background.queueSnapshotSeq, undefined)
  h.accept(requested)
  h.accept(requested)
  assert.equal(h.statusReads(), 1)
  assert.deepEqual(
    h.scheduled.map((item) => item.delay),
    [500]
  )
  h.scheduled[0].callback()
  assert.equal(h.statusReads(), 2)
})

test('a terminal queue event releases its outbox once even without a thread to patch', () => {
  for (const withThread of [true, false]) {
    const thread: Thread | undefined = withThread
      ? { id: 'thread', sessionId: 'session', title: 'Task', conversation: [], lastSeq: 0 }
      : undefined
    const acknowledgements: string[] = []
    const branch = block(liveSource, "case 'message_removed':", "case 'subagent_spawned':")
    const apply = runInNewContext(`(event) => { switch (event.type) { ${branch} } }`, {
      threadId: 'thread',
      threadAtReceipt: thread,
      acknowledgeOutbox: true,
      releaseQueuedOutbox: (_session: string, id: string) => acknowledgements.push(id),
      refreshAssistantContext: () => {},
      patchThread: (_id: string, update: (current: Thread) => Partial<Thread>) => {
        if (!thread) return
        update(thread)
        update(thread)
      },
    }) as (event: unknown) => void
    apply({
      type: 'message_removed',
      seq: 1,
      session_id: 'session',
      data: { queued_message_id: 'message' },
    })
    assert.deepEqual(acknowledgements, ['message'])
  }
})

test('shutdown prevents a new catalog request', async () => {
  const h = metadataHarness()
  h.state.runtimeQuiescing = true
  const request = h.refresh()
  if (h.calls()) h.fail()
  await request
  assert.equal(h.calls(), 0)
})

test('catalog failure arriving during shutdown cannot publish or retry', async () => {
  const h = metadataHarness()
  const request = h.refresh()
  h.state.runtimeQuiescing = true
  h.fail()
  await request
  assert.equal(h.retries(), 0)
  assert.equal(h.updates.length, 0)
})

test('shutdown invalidates pending catalog results even after cancellation resumes reads', async () => {
  const h = metadataHarness()
  const request = h.refresh()
  h.state.runtimeQuiescing = true
  h.lifecycle()
  h.state.runtimeQuiescing = false
  h.fail()
  await request
  assert.equal(h.retries(), 0)
  assert.equal(h.updates.length, 0)
  const resumed = h.refresh()
  h.fail()
  await resumed
  assert.equal(h.calls(), 2)
  assert.equal(h.retries(), 1, 'normal transport failures still retry after resume')
})

test('recorded tool recovery preserves terminal turn lifecycle and source identity', () => {
  const started = block(liveSource, "case 'tool_started':", "case 'tool_output_delta':")
  assert.match(started, /running: event\.data\.retry_of \? thread\.running : true/)
  assert.match(started, /status: event\.data\.retry_of \? thread\.status : 'running'/)
  assert.match(started, /batchId: event\.data\.batch_id/)
  assert.match(started, /retryOf: event\.data\.retry_of/)
  assert.match(started, /turnOutcomes: event\.data\.retry_of\s+\?\s+thread\.turnOutcomes/)
  assert.match(started, /turnTimings: event\.data\.retry_of\s+\?\s+thread\.turnTimings/)
})

test('visible home refreshes the catalog before a background running event is known', () => {
  const refresh = block(liveSource, 'const catalogRefreshNeeded =', 'useEffect(() => {')
  assert.match(refresh, /state\.mainView === 'home' \|\|/)
  assert.match(
    refresh,
    /sessionCatalogNeedsRefresh\(state.sessions, state.activeSession, state.threads\)/
  )
})

test('the protocol carries a coarse invalidation event with a data scope vocabulary', () => {
  assert.match(apiSource, /export const PRODUCT_DATA_SCOPE_LITERATURE = 'literature'/)
  assert.match(apiSource, /export const PRODUCT_DATA_SCOPE_RESOURCES = 'resources'/)
  assert.match(apiSource, /export interface ProductDataChangedData \{\n {2}scopes: string\[\]\n\}/)
  assert.match(
    apiSource,
    new RegExp(`\\| ProductEventBase<'${INVALIDATION_EVENT}', ProductDataChangedData>`)
  )
})

test('onEvent takes the scope invalidator right after the resource invalidator', () => {
  const signature = block(liveSource, 'function onEvent(', '): void {')
  assert.match(
    signature,
    /invalidateResources: \(\) => void,\n {2}invalidateScopes: \(scopes: string\[\]\) => void,/
  )
})

test('the event is dispatched by data scope and never by item identity', () => {
  const dispatch = block(
    liveSource,
    `case '${INVALIDATION_EVENT}':`,
    "case 'artifact_library_linked'"
  )
  assert.match(dispatch, /invalidateScopes\(event\.data\.scopes\)/)
  // 粗失效的全部要点: 事件里没有条目身份, 消费方也就无从做半吊子的局部更新。
  assert.doesNotMatch(dispatch, /literature_id|item_id|target_ids/)
})

test('one table maps a data scope to its store invalidation', () => {
  const table = block(
    liveSource,
    'const invalidators: Record<string, () => void> = {',
    'for (const scope of scopes)'
  )
  assert.match(table, /\[PRODUCT_DATA_SCOPE_LITERATURE\]: act\.invalidateLiterature/)
  assert.match(table, /\[PRODUCT_DATA_SCOPE_RESOURCES\]: act\.invalidateResources/)
  // 没登记的域用可选调用忽略: 既不抛错, 也不退化成「所有域都刷」。
  assert.match(liveSource, /for \(const scope of scopes\) invalidators\[scope\]\?\.\(\)/)
})

test('the invalidator is threaded into the stream and pinned in the callback deps', () => {
  const call = block(liveSource, 'refreshMetaRef,', '(activeSessionId) => {')
  assert.match(call, /act\.invalidateResources,\n\s+\(scopes\) => \{/)
  assert.match(
    liveSource,
    /act\.invalidateLiterature,\n\s+act\.invalidateResources,\n\s+act\.loadAiContext,\n\s+act\.reloadArtifactLinks,\n\s+patchThread,\n\s+set,\n\s+getSnapshot,\n\s+\]/
  )
})
