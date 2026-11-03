import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_CDP_STATUS, BROWSER_ERROR, type BrowserReply, type BrowserSnapshot } from '../src/browser.ts'
import { PREVIEW_BROWSER, PreviewBrowser, type PreviewBrowserPolicy } from './browser.ts'

const QUERY = { kind: 'query', query: { offset: 0, limit: 20 } } as const
const ORIGIN = 'https://research.example.org'

function surface(reply: BrowserReply): BrowserSnapshot {
  assert.ok(reply.ok)
  return reply.snapshot
}

test('unconfigured browser surfaces remain unavailable even for malformed commands', async () => {
  const owner = new PreviewBrowser({ seed: 'sample' })
  const unavailable = { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
  assert.deepEqual(await owner.snapshotRequest(), unavailable)
  for (const request of [{ kind: 'open' }, null, { kind: 'automation', enabled: true }]) assert.deepEqual(await owner.commandRequest(request), unavailable)
})

test('blank surfaces own coherent independent snapshots and close the last tab back to the start page', async () => {
  const owner = new PreviewBrowser({ seed: 'sample', surface: { seed: 'empty' } })
  assert.deepEqual(surface(await owner.snapshotRequest()), { tabs: [], activeTabId: null, automation: { enabled: false, port: null } })
  const first = surface(await owner.commandRequest({ kind: 'open' }))
  assert.equal(first.tabs.length, 1)
  const firstId = first.tabs[0].tabId
  assert.equal(first.activeTabId, firstId)
  assert.deepEqual(first.tabs[0], { tabId: firstId, url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, navigationError: null, devtoolsOpen: false, cdpStatus: BROWSER_CDP_STATUS.disabled })
  const second = surface(await owner.commandRequest({ kind: 'open', input: 'about:blank' }))
  const secondId = second.activeTabId
  assert.notEqual(secondId, firstId)
  assert.equal(second.tabs.length, 2)
  second.tabs.length = 0
  assert.equal(surface(await owner.snapshotRequest()).tabs.length, 2)
  assert.equal(surface(await owner.commandRequest({ kind: 'select', tabId: firstId })).activeTabId, firstId)
  assert.equal(surface(await owner.commandRequest({ kind: 'close', tabId: secondId })).activeTabId, firstId)
  const closed = surface(await owner.commandRequest({ kind: 'close', tabId: firstId }))
  assert.equal(closed.activeTabId, null)
  assert.deepEqual(closed.tabs, [])
  assert.deepEqual(await owner.commandRequest({ kind: 'select', tabId: firstId }), { ok: false, error: BROWSER_ERROR.targetClosed })
  assert.equal(surface(await owner.commandRequest({ kind: 'open' })).tabs.length, 1)
})

test('sample blank identities are owner-local and reset cannot reuse captured tab IDs', async () => {
  const owner = new PreviewBrowser({ seed: 'empty', surface: { seed: 'sample' } })
  const other = new PreviewBrowser({ seed: 'empty', surface: { seed: 'sample' } })
  const snapshot = surface(await owner.snapshotRequest())
  assert.equal(snapshot.tabs.length, PREVIEW_BROWSER.surfaceSampleCount)
  assert.ok(snapshot.tabs.some(tab => tab.tabId === snapshot.activeTabId))
  for (const tab of snapshot.tabs) {
    assert.equal(tab.url, PREVIEW_BROWSER.blankPage)
    assert.deepEqual(await other.commandRequest({ kind: 'close', tabId: tab.tabId }), { ok: false, error: BROWSER_ERROR.targetClosed })
  }
  owner.dispose()
  await assert.rejects(owner.commandRequest({ kind: 'open' }), { status: 410 })
  const reset = new PreviewBrowser({ seed: 'empty', surface: { seed: 'sample' } })
  assert.deepEqual(await reset.commandRequest({ kind: 'select', tabId: snapshot.activeTabId }), { ok: false, error: BROWSER_ERROR.targetClosed })
  assert.equal(surface(await reset.snapshotRequest()).tabs.length, PREVIEW_BROWSER.surfaceSampleCount)
})

test('native and external commands are explicit denials and cannot mutate any browser ledger', async () => {
  const owner = new PreviewBrowser({ seed: 'sample', surface: { seed: 'sample' } })
  const initial = surface(await owner.snapshotRequest())
  const history = await owner.historyRequest(QUERY)
  const policy = await owner.policyRequest({ kind: 'read' })
  const tabId = initial.activeTabId
  const requests = [
    ...['https://example.invalid', 'file:///private', 'javascript:alert(1)', 'about:blank#fragment', ' about:blank ', 'research query'].map(input => ({ kind: 'open', input })),
    { kind: 'navigate', tabId, input: 'https://example.invalid' }, { kind: 'navigate', tabId, input: 'about:blank' },
    ...['back', 'forward', 'reload'].map(kind => ({ kind, tabId })),
    { kind: 'devtools', tabId, open: true }, { kind: 'bounds', tabId, visible: true, x: 0, y: 0, width: 100, height: 100 },
    { kind: 'automation', enabled: true }, { kind: 'copy-endpoint' },
  ]
  for (const request of requests) assert.deepEqual(await owner.commandRequest(request), { ok: false, error: BROWSER_ERROR.permissionDenied })
  for (const request of [null, [], { kind: 'open', extra: true }, { kind: 'open', input: '' }, { kind: 'close' }, { kind: 'unknown' }]) assert.deepEqual(await owner.commandRequest(request), { ok: false, error: BROWSER_ERROR.invalidCommand })
  assert.deepEqual(surface(await owner.snapshotRequest()), initial)
  assert.deepEqual(await owner.historyRequest(QUERY), history)
  assert.deepEqual(await owner.policyRequest({ kind: 'read' }), policy)
})

test('surface write failures are independent and only valid supported commands consume the failure', async () => {
  const owner = new PreviewBrowser({ seed: 'empty', write: 'fail-once', surface: { seed: 'empty', write: 'fail-once' } })
  assert.equal((await owner.commandRequest({ kind: 'open', input: 'https://example.invalid' })).ok, false)
  assert.deepEqual(await owner.commandRequest({ kind: 'close', tabId: 'unknown' }), { ok: false, error: BROWSER_ERROR.targetClosed })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(owner.commandRequest({ kind: 'open' }, aborted.signal), { status: 410 })
  assert.deepEqual(await owner.commandRequest({ kind: 'open' }), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.deepEqual(surface(await owner.snapshotRequest()).tabs, [])
  assert.equal(surface(await owner.commandRequest({ kind: 'open' })).tabs.length, 1)
  assert.deepEqual(await owner.policyRequest({ kind: 'set-agent-use', enabled: true }), { ok: false, error: BROWSER_ERROR.policyUnavailable })
})

test('surface reads expose persistent failure or bounded loading independently from settings', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const failed = new PreviewBrowser({ seed: 'sample', surface: { seed: 'empty', read: 'failed' } })
  for (let index = 0; index < 2; index++) assert.deepEqual(await failed.snapshotRequest(), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.ok((await failed.policyRequest({ kind: 'read' })).ok)
  const delayed = new PreviewBrowser({ seed: 'empty', surface: { seed: 'sample', read: 'delayed' } })
  let completed = false
  const reading = delayed.snapshotRequest().then(value => { completed = true; return value })
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs - 1)
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  assert.equal(surface(await reading).tabs.length, PREVIEW_BROWSER.surfaceSampleCount)
})

test('surface mutation leases reject concurrent commands without exposing partial state', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewBrowser({ seed: 'empty', surface: { seed: 'empty', write: 'delayed' } })
  const opening = owner.commandRequest({ kind: 'open' })
  assert.deepEqual(await owner.commandRequest({ kind: 'open' }), { ok: false, error: BROWSER_ERROR.cdpBusy })
  assert.deepEqual(surface(await owner.snapshotRequest()).tabs, [])
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  const opened = surface(await opening)
  assert.equal(opened.tabs.length, 1)
  const closing = owner.commandRequest({ kind: 'close', tabId: opened.activeTabId })
  const rejected = assert.rejects(closing, { status: 410 })
  owner.dispose()
  await rejected
})

test('surface read and write receipts reject abort and disposal at await boundaries', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const kind of ['read', 'write'] as const) for (const cancellation of ['abort', 'dispose'] as const) {
    const owner = new PreviewBrowser({ seed: 'empty', surface: { seed: 'empty', read: 'delayed', write: 'delayed' } })
    const controller = new AbortController()
    const pending = kind === 'read' ? owner.snapshotRequest(controller.signal) : owner.commandRequest({ kind: 'open' }, controller.signal)
    const rejected = assert.rejects(pending, { status: 410 })
    context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
    await Promise.resolve()
    if (cancellation === 'abort') controller.abort('private cancellation reason')
    else owner.dispose()
    await rejected
  }
  for (const cancellation of ['abort', 'dispose'] as const) {
    const owner = new PreviewBrowser({ seed: 'empty', surface: { seed: 'empty' } })
    const controller = new AbortController()
    const rejected = assert.rejects(owner.commandRequest({ kind: 'open' }, controller.signal), { status: 410 })
    if (cancellation === 'abort') controller.abort()
    else owner.dispose()
    await rejected
  }
})

test('surface capacity is bounded without borrowing caller policy objects', async () => {
  const policy = { seed: 'empty', surface: { seed: 'empty', write: 'normal' } } as const
  const owner = new PreviewBrowser(policy)
  const mutable: PreviewBrowserPolicy = { seed: 'empty', surface: { seed: 'empty', read: 'normal' } }
  const copied = new PreviewBrowser(mutable)
  mutable.surface!.read = 'failed'
  assert.ok((await copied.snapshotRequest()).ok)
  for (let index = 0; index < PREVIEW_BROWSER.maxSurfaceTabs; index++) assert.ok((await owner.commandRequest({ kind: 'open' })).ok)
  assert.deepEqual(await owner.commandRequest({ kind: 'open' }), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.equal(surface(await owner.snapshotRequest()).tabs.length, PREVIEW_BROWSER.maxSurfaceTabs)
})

test('blank mutations preserve settings ledgers and copy commands across delayed commits', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewBrowser({ seed: 'sample', surface: { seed: 'sample', write: 'delayed' } })
  const initial = surface(await owner.snapshotRequest())
  const history = await owner.historyRequest(QUERY)
  const policy = await owner.policyRequest({ kind: 'read' })
  const request = { kind: 'close', tabId: initial.activeTabId }
  const closing = owner.commandRequest(request)
  request.tabId = initial.tabs[1].tabId
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  const closed = surface(await closing)
  assert.equal(closed.activeTabId, initial.tabs[1].tabId)
  assert.deepEqual(closed.tabs.map(tab => tab.tabId), [initial.tabs[1].tabId])
  const selected = owner.commandRequest({ kind: 'select', tabId: closed.activeTabId })
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  assert.deepEqual(surface(await selected), closed)
  assert.deepEqual(await owner.historyRequest(QUERY), history)
  assert.deepEqual(await owner.policyRequest({ kind: 'read' }), policy)
})

test('surface cancellation releases the lease without consuming one-shot failure or leaving stale timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewBrowser({ seed: 'empty', surface: { seed: 'empty', write: 'fail-once' } })
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.commandRequest({ kind: 'open' }, controller.signal), { status: 410 })
  controller.abort()
  await cancelled
  assert.deepEqual(await owner.commandRequest({ kind: 'open' }), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.equal(surface(await owner.commandRequest({ kind: 'open' })).tabs.length, 1)
  const delayed = new PreviewBrowser({ seed: 'empty', surface: { seed: 'empty', write: 'delayed' } })
  const aborting = new AbortController()
  const aborted = assert.rejects(delayed.commandRequest({ kind: 'open' }, aborting.signal), { status: 410 })
  aborting.abort()
  await aborted
  const retry = delayed.commandRequest({ kind: 'open' })
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  assert.equal(surface(await retry).tabs.length, 1)
})

test('delayed read receipts reject revocation between wait completion and outer read continuation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const kind of ['policy', 'history'] as const) {
    for (const cancellation of ['abort', 'dispose'] as const) {
      const owner = new PreviewBrowser({ seed: 'sample', policyRead: 'delayed', historyRead: 'delayed' })
      const controller = new AbortController()
      const pending = kind === 'policy' ? owner.policyRequest({ kind: 'read' }, controller.signal) : owner.historyRequest(QUERY, controller.signal)
      const rejected = assert.rejects(pending, { status: 410 })
      context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
      await Promise.resolve()
      if (cancellation === 'abort') controller.abort()
      else owner.dispose()
      await rejected
    }
  }
})

test('explicit policy recovery is idempotent, isolated and resets without modifying policy or history', async () => {
  const owner = new PreviewBrowser({ seed: 'sample', policyRead: 'failed', historyRead: 'failed' })
  const other = new PreviewBrowser({ seed: 'sample', policyRead: 'failed' })
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await owner.policyRequest({ kind: 'read' }), { ok: false, error: BROWSER_ERROR.policyUnavailable })
  owner.recoverPolicy()
  owner.recoverPolicy()
  const policy = await owner.policyRequest({ kind: 'read' })
  assert.ok(policy.ok)
  assert.equal(policy.policy.revision, 0)
  assert.equal(policy.policy.agentBrowserUseEnabled, false)
  assert.equal(policy.policy.sites.length, 1)
  assert.deepEqual(await owner.historyRequest(QUERY), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.deepEqual(await other.policyRequest({ kind: 'read' }), { ok: false, error: BROWSER_ERROR.policyUnavailable })
  assert.throws(() => new PreviewBrowser({ seed: 'empty' }).recoverPolicy(), { status: 409 })
  owner.dispose()
  assert.throws(() => owner.recoverPolicy(), { status: 410 })
})

test('history sample identities belong to exactly one owner and cannot delete another instance or reset generation', async () => {
  const owner = new PreviewBrowser({ seed: 'sample' })
  const other = new PreviewBrowser({ seed: 'sample' })
  const original = await owner.historyRequest(QUERY)
  assert.ok(original.ok && original.page)
  const id = original.page.items[0].id
  assert.deepEqual(await other.historyRequest({ kind: 'delete', id }), { ok: true, deleted: false })
  owner.dispose()
  const reset = new PreviewBrowser({ seed: 'sample' })
  assert.deepEqual(await reset.historyRequest({ kind: 'delete', id }), { ok: true, deleted: false })
  const current = await reset.historyRequest(QUERY)
  assert.ok(current.ok && current.page)
  assert.equal(current.page.total, PREVIEW_BROWSER.sampleCount)
  assert.ok(current.page.items.every(visit => visit.id !== id))
})

test('delayed writes cannot commit when cancellation follows timer completion but precedes the commit continuation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const kind of ['policy', 'delete', 'clear'] as const) {
    const owner = new PreviewBrowser({ seed: 'sample', write: 'delayed' })
    const initial = await owner.historyRequest(QUERY)
    assert.ok(initial.ok && initial.page)
    const controller = new AbortController()
    const pending = kind === 'policy' ? owner.policyRequest({ kind: 'set-agent-use', enabled: true }, controller.signal)
      : kind === 'delete' ? owner.historyRequest({ kind: 'delete', id: initial.page.items[0].id }, controller.signal)
        : owner.dataRequest({ kind: 'clear-history' }, controller.signal)
    const rejected = assert.rejects(pending, { status: 410 })
    context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
    controller.abort()
    await rejected
    const history = await owner.historyRequest(QUERY)
    assert.ok(history.ok && history.page)
    assert.equal(history.page.total, PREVIEW_BROWSER.sampleCount)
  }
})

test('normal browser writes cannot commit after abort or disposal at the awaited commit boundary', async () => {
  for (const kind of ['policy', 'delete', 'clear'] as const) {
    for (const cancellation of ['abort', 'dispose'] as const) {
      const owner = new PreviewBrowser({ seed: 'sample' })
      const initial = await owner.historyRequest(QUERY)
      assert.ok(initial.ok && initial.page)
      const id = initial.page.items[0].id
      const controller = new AbortController()
      const pending = kind === 'policy' ? owner.policyRequest({ kind: 'set-agent-use', enabled: true }, controller.signal)
        : kind === 'delete' ? owner.historyRequest({ kind: 'delete', id }, controller.signal)
          : owner.dataRequest({ kind: 'clear-history' }, controller.signal)
      const rejected = assert.rejects(pending, { status: 410 })
      if (cancellation === 'abort') controller.abort()
      else owner.dispose()
      await rejected
      if (cancellation === 'abort') {
        const policy = await owner.policyRequest({ kind: 'read' })
        assert.ok(policy.ok)
        assert.equal(policy.policy.agentBrowserUseEnabled, false)
        const history = await owner.historyRequest(QUERY)
        assert.ok(history.ok && history.page)
        assert.equal(history.page.total, PREVIEW_BROWSER.sampleCount)
      }
    }
  }
})

test('history deletion holds the same read and mutation exclusion lease as history clearing', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewBrowser({ seed: 'sample', write: 'delayed' })
  const initial = await owner.historyRequest(QUERY)
  assert.ok(initial.ok && initial.page)
  const request = { kind: 'delete', id: initial.page.items[0].id }
  const pending = owner.historyRequest(request)
  assert.deepEqual(await owner.historyRequest(QUERY), { ok: false, error: BROWSER_ERROR.cdpBusy })
  assert.deepEqual(await owner.historyRequest(request), { ok: false, error: BROWSER_ERROR.cdpBusy })
  assert.deepEqual(await owner.dataRequest({ kind: 'clear-history' }), { ok: false, error: BROWSER_ERROR.cdpBusy })
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  assert.deepEqual(await pending, { ok: true, deleted: true })
  assert.equal((await owner.historyRequest(QUERY)).ok, true)
})

test('browser policy follows real origin and decision contracts, owns copies and stays instance isolated', async () => {
  const owner = new PreviewBrowser({ seed: 'sample' })
  const other = new PreviewBrowser({ seed: 'empty' })
  const original = await owner.policyRequest({ kind: 'read' })
  assert.ok(original.ok)
  assert.deepEqual(await owner.policyRequest({ kind: 'set-agent-use', enabled: false }), original)
  assert.deepEqual(await owner.policyRequest({ kind: 'remove', origin: ORIGIN }), original)
  original.policy.sites.length = 0
  assert.equal((await owner.policyRequest({ kind: 'read' })).ok, true)
  const added = await owner.policyRequest({ kind: 'set', origin: ORIGIN, action: 'interact', decision: 'block' })
  assert.ok(added.ok)
  assert.deepEqual(added.policy.sites.find(site => site.origin === ORIGIN), { origin: ORIGIN, read: 'ask', interact: 'block' })
  await owner.policyRequest({ kind: 'set', origin: ORIGIN, action: 'interact', decision: 'ask' })
  const removed = await owner.policyRequest({ kind: 'remove', origin: PREVIEW_BROWSER.sampleOrigin })
  assert.ok(removed.ok)
  assert.deepEqual(removed.policy.sites, [])
  const enabled = await owner.policyRequest({ kind: 'set-agent-use', enabled: true })
  assert.ok(enabled.ok)
  assert.equal(enabled.policy.agentBrowserUseEnabled, true)
  const isolated = await other.policyRequest({ kind: 'read' })
  assert.ok(isolated.ok)
  assert.equal(isolated.policy.agentBrowserUseEnabled, false)
  for (const origin of ['file:///private', ORIGIN + '/path', ORIGIN + '/', 'null']) assert.deepEqual(await owner.policyRequest({ kind: 'set', origin, action: 'read', decision: 'allow' }), { ok: false, error: BROWSER_ERROR.invalidCommand })
})

test('browser history search and pagination share one ledger; deletion and time-scoped clearing do not touch policy', async () => {
  const now = 2_000_000_000_000
  const owner = new PreviewBrowser({ seed: 'sample' }, now)
  const first = await owner.historyRequest(QUERY)
  assert.ok(first.ok && first.page)
  assert.equal(first.page.items.length, 20)
  assert.equal(first.page.total, PREVIEW_BROWSER.sampleCount)
  const last = await owner.historyRequest({ kind: 'query', query: { offset: 20, limit: 20 } })
  assert.ok(last.ok && last.page)
  assert.equal(last.page.items.length, 4)
  const id = first.page.items[0].id
  first.page.items[0].title = 'changed outside'
  const search = await owner.historyRequest({ kind: 'query', query: { search: 'NOTES/1', offset: 0, limit: 50 } })
  assert.ok(search.ok && search.page)
  assert.equal(search.page.items.length, 11)
  assert.notEqual(search.page.items[0].title, 'changed outside')
  assert.deepEqual(await owner.historyRequest({ kind: 'reopen', id }), { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable })
  assert.deepEqual(await owner.historyRequest({ kind: 'delete', id }), { ok: true, deleted: true })
  assert.deepEqual(await owner.historyRequest({ kind: 'delete', id }), { ok: true, deleted: false })
  assert.deepEqual(await owner.dataRequest({ kind: 'clear-history', since: now - PREVIEW_BROWSER.visitIntervalMs }), { ok: true, deleted: 1 })
  for (const value of [{ kind: 'clear-all' }, { kind: 'clear-selected', types: ['history', 'cookies'] }, { kind: 'clear-site-data', origin: ORIGIN }]) assert.deepEqual(await owner.dataRequest(value), { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable })
  assert.deepEqual(await owner.dataRequest({ kind: 'clear-selected', types: ['history'] }), { ok: true, deleted: 22 })
  assert.deepEqual(await owner.dataRequest({ kind: 'clear-history' }), { ok: true, deleted: 0 })
  const policy = await owner.policyRequest({ kind: 'read' })
  assert.ok(policy.ok)
  assert.equal(policy.policy.sites.length, 1)
})

test('invalid requests do not consume failures; read and write failures retain state and are independent', async () => {
  const owner = new PreviewBrowser({ seed: 'sample', policyRead: 'fail-once', historyRead: 'failed', write: 'fail-once' })
  assert.deepEqual(await owner.policyRequest({ kind: 'read', extra: true }), { ok: false, error: BROWSER_ERROR.invalidCommand })
  assert.deepEqual(await owner.policyRequest({ kind: 'read' }), { ok: false, error: BROWSER_ERROR.policyUnavailable })
  const snapshot = await owner.policyRequest({ kind: 'read' })
  assert.ok(snapshot.ok)
  assert.deepEqual(await owner.policyRequest({ kind: 'remove', origin: PREVIEW_BROWSER.sampleOrigin }), { ok: false, error: BROWSER_ERROR.policyUnavailable })
  assert.deepEqual(await owner.policyRequest({ kind: 'read' }), snapshot)
  assert.deepEqual(await owner.historyRequest(QUERY), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.deepEqual(await owner.historyRequest(QUERY), { ok: false, error: BROWSER_ERROR.operationFailed })
  assert.equal((await owner.policyRequest({ kind: 'remove', origin: PREVIEW_BROWSER.sampleOrigin })).ok, true)
})

test('abort and dispose fence delayed browser reads and writes before commit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewBrowser({ seed: 'sample', policyRead: 'delayed', historyRead: 'delayed', write: 'delayed' })
  const read = owner.historyRequest(QUERY)
  context.mock.timers.tick(PREVIEW_BROWSER.delayMs)
  assert.equal((await read).ok, true)
  const controller = new AbortController()
  const aborted = assert.rejects(owner.policyRequest({ kind: 'set-agent-use', enabled: true }, controller.signal), { status: 410 })
  controller.abort()
  await aborted
  const pendingRead = assert.rejects(owner.policyRequest({ kind: 'read' }), { status: 410 })
  const pendingDelete = assert.rejects(owner.dataRequest({ kind: 'clear-history' }), { status: 410 })
  assert.deepEqual(await owner.historyRequest(QUERY), { ok: false, error: BROWSER_ERROR.cdpBusy })
  assert.deepEqual(await owner.historyRequest({ kind: 'delete', id: '00000000-0000-4000-8000-000000000001' }), { ok: false, error: BROWSER_ERROR.cdpBusy })
  assert.deepEqual(await owner.dataRequest({ kind: 'clear-history' }), { ok: false, error: BROWSER_ERROR.cdpBusy })
  owner.dispose()
  await Promise.all([pendingRead, pendingDelete])
  await assert.rejects(owner.historyRequest(QUERY), { status: 410 })
  const reset = new PreviewBrowser({ seed: 'sample' })
  const snapshot = await reset.policyRequest({ kind: 'read' })
  assert.ok(snapshot.ok)
  assert.equal(snapshot.policy.agentBrowserUseEnabled, false)
  const restored = await reset.historyRequest(QUERY)
  assert.ok(restored.ok && restored.page)
  assert.equal(restored.page.total, PREVIEW_BROWSER.sampleCount)
})
