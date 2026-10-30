import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { block } from '../../test-helpers/source-contract.ts'

/**
 * 「AI 改了产品数据 → 界面按数据域失效重取」这条接线的契约测试。
 *
 * live.ts 的事件分发只有真实会话流才跑得到, 所以与 store.test.ts 同一做法: 把接线当
 * 源码契约钉住。钉接线而不是钉行为, 是因为 onEvent 用的是位置参数 —— 少传一个或者顺序
 * 错位时, 两个箭头函数的类型仍然兼容, TypeScript 会放行, 症状却是新事件永远不生效。
 */
const liveSource = readFileSync(new URL('./live.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

const INVALIDATION_EVENT = 'product_data_changed'

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
  const state = { runtimeQuiescing: false, backendReady: true, workspaceLoadState: 'ready' }
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
    detachers: { current: {} },
    resumeRetryTimers: { current: {} },
    resumeInFlight: { current: new Map() },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => fn(),
    set: (value: unknown) => updates.push(value),
    listProjects: async () => [],
    loadSessionCatalog: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
    projectCatalogFailure: () => ({ retry: true, workspaceLoadState: 'ready' }),
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
  run(refresh)
  return {
    state,
    updates,
    refresh: (context as typeof context & { refresh: () => Promise<void> }).refresh,
    fail: () => resolve({ ok: false, failure: { retryable: true } }),
    lifecycle: () => run(lifecycle),
    calls: () => calls,
    retries: () => retries,
  }
}

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

test('visible home refreshes the catalog before a background running event is known', () => {
  const refresh = block(liveSource, 'const catalogRefreshNeeded =', 'useEffect(() => {')
  assert.match(refresh, /state\.mainView === 'home' \|\|/)
  assert.match(
    refresh,
    /sessionCatalogNeedsRefresh\(state.sessions, state.activeSession, state.threads\)/
  )
})

test('resuming a terminal conversation preserves the durable failed or interrupted outcome', () => {
  const resumed = block(liveSource, 'const base = {', '...projectSessionRecovery(base,')
  assert.match(resumed, /opened\.last_turn_status === 'failed'/)
  assert.match(resumed, /opened\.last_turn_status === 'interrupted'/)
  assert.doesNotMatch(
    resumed,
    /status: opened\.running \? \('running' as const\) : \('done' as const\)/
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
  assert.match(call, /act\.invalidateResources,\n {14}\(scopes\) => \{/)
  assert.match(
    liveSource,
    /act\.invalidateLiterature,\n\s+act\.invalidateResources,\n\s+act\.loadAiContext,\n\s+act\.reloadArtifactLinks,\n\s+patchThread,\n\s+set,\n\s+\]/
  )
})
