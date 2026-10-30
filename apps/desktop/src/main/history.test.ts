import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { BrowserPageCommand, BrowserSnapshot } from '../browser.ts'
import { createBrowserHistory, createChromiumHistoryOwner, createHistoryAgentAuthority } from './history.ts'
import type { ChromiumHistoryEvent } from './chromiumregistry.ts'

const scope = { sessionId: 'session', instanceId: 'instance', productTurnId: 'product-turn',
  turnId: 'turn', generation: 1, interruptGeneration: 0, lifecycleEpoch: 1 }

function historyStream() {
  const listeners = new Set<(event: ChromiumHistoryEvent) => void>()
  return {
    async dispatch(_command: BrowserPageCommand): Promise<BrowserSnapshot> {
      throw new Error('Unexpected sidecar dispatch')
    },
    onHistoryEvent(listener: (event: ChromiumHistoryEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event: ChromiumHistoryEvent) { for (const listener of listeners) listener(event) }
  }
}

test('sidecar history owner queries, deletes and reopens through the registry command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-history-operations-'))
  try {
    const history = createBrowserHistory(directory)
    const commands: BrowserPageCommand[] = []
    const snapshot: BrowserSnapshot = { tabs: [], activeTabId: null, engine: 'chromium-sidecar',
      automation: { enabled: false, port: null } }
    const registry = { ...historyStream(), async dispatch(command: BrowserPageCommand) {
      commands.push(command)
      return snapshot
    } }
    const owner = createChromiumHistoryOwner(history, registry, createHistoryAgentAuthority(history, () => 1))
    const visitId = history.record('https://example.org/path', 'Page', 1_000)
    assert.deepEqual(owner.queryHistory({ search: 'example.org', offset: 0, limit: 10 }).items.map(visit => visit.id), [visitId])
    assert.equal(owner.queryHistory({ search: 'missing', offset: 0, limit: 10 }).total, 0)
    assert.equal(await owner.reopenHistory(visitId), snapshot)
    assert.deepEqual(commands, [{ kind: 'open', input: 'https://example.org/path' }])
    const unsafeId = history.record('file:///private/secret', 'Unsafe')
    await assert.rejects(owner.reopenHistory(unsafeId), /invalid_url/)
    assert.equal(commands.length, 1)
    assert.equal(await owner.deleteHistory(visitId), true)
    assert.equal(await owner.deleteHistory(visitId), false)
    await assert.rejects(owner.reopenHistory(visitId), /target_closed/)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar delete drains Agent leases and fences query and reopen during clear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-history-delete-'))
  try {
    const history = createBrowserHistory(directory)
    const authority = createHistoryAgentAuthority(history, () => 1)
    const commands: BrowserPageCommand[] = []
    const registry = { ...historyStream(), async dispatch(command: BrowserPageCommand): Promise<BrowserSnapshot> {
      commands.push(command)
      return { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
    } }
    const owner = createChromiumHistoryOwner(history, registry, authority)
    const visitId = history.record('https://example.org/', 'Page')
    const reader = {}
    authority.watchOwner(reader, new Promise<void>(() => {}))
    const proof = authority.prepare({ scope, requestId: 'sidecar-delete', search: 'example.org', offset: 0,
      limit: 1, intent: 'Read visit before deletion' })
    authority.grant({ scope, requestId: 'sidecar-delete', proofId: proof.proofId,
      queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
    authority.execute({ scope, requestId: 'sidecar-delete', proofId: proof.proofId, owner: reader })
    const pendingDelete = owner.deleteHistory(visitId)
    assert.ok(history.get(visitId))
    assert.throws(() => owner.queryHistory({ offset: 0, limit: 10 }), /history_clearing/)
    await assert.rejects(owner.reopenHistory(visitId), /history_clearing/)
    await assert.rejects(owner.deleteHistory(visitId), /history_clearing/)
    assert.equal(commands.length, 0)
    authority.complete({ scope, requestId: 'sidecar-delete', proofId: proof.proofId })
    assert.equal(await pendingDelete, true)
    assert.equal(history.get(visitId), null)
    assert.equal(owner.queryHistory({ offset: 0, limit: 10 }).total, 0)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar clearHistory removes only the selected time range and reconciles surviving titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-clear-history-'))
  try {
    const history = createBrowserHistory(directory)
    const record = history.record.bind(history)
    const timedHistory = { ...history, record(url: string, title: string) {
      return record(url, title, url.endsWith('/old') ? 1_000 : 2_000)
    } }
    const stream = historyStream()
    const owner = createChromiumHistoryOwner(timedHistory, stream, createHistoryAgentAuthority(timedHistory, () => 1))
    stream.emit({ kind: 'visit', tabId: 'old', visitSequence: 1, url: 'https://example.org/old', title: 'Old' })
    stream.emit({ kind: 'visit', tabId: 'recent', visitSequence: 1, url: 'https://example.org/recent', title: 'Recent' })
    const deleted = await owner.clearHistory({ since: 1_500 })
    assert.equal(deleted, 1)
    stream.emit({ kind: 'title', tabId: 'old', visitSequence: 1, url: 'https://example.org/old', title: 'Retained title' })
    stream.emit({ kind: 'title', tabId: 'recent', visitSequence: 1, url: 'https://example.org/recent', title: 'Must not return' })
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(visit => visit.title), ['Retained title'])
    stream.emit({ kind: 'visit', tabId: 'other-site', visitSequence: 1, url: 'https://other.org/', title: 'Other site' })
    assert.equal(await owner.clearHistory({ origin: 'https://example.org' }), 1)
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(visit => visit.title), ['Other site'])
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar clearHistory reports SQLite failure and releases the fence for later titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-clear-history-failure-'))
  try {
    const history = createBrowserHistory(directory)
    let fail = true
    const failingHistory = { ...history, clear(options: { since?: number; origin?: string }) {
      if (fail) throw new Error('SQLite clear failed')
      return history.clear(options)
    } }
    const stream = historyStream()
    const authority = createHistoryAgentAuthority(failingHistory, () => 1)
    const owner = createChromiumHistoryOwner(failingHistory, stream, authority)
    stream.emit({ kind: 'visit', tabId: 'tab', visitSequence: 1, url: 'https://example.org/', title: 'Before' })
    await assert.rejects(owner.clearHistory({}), /SQLite clear failed/)
    stream.emit({ kind: 'title', tabId: 'tab', visitSequence: 1, url: 'https://example.org/', title: 'After failed clear' })
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(visit => visit.title), ['After failed clear'])
    fail = false
    assert.equal(await owner.clearHistory({}), 1)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar clearHistory fences Agent reads and waits for queued reopen and approved lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-clear-history-race-'))
  try {
    const history = createBrowserHistory(directory)
    const visitId = history.record('https://example.org/', 'Page')
    const authority = createHistoryAgentAuthority(history, () => 1)
    const reader = {}
    authority.watchOwner(reader, new Promise<void>(() => {}))
    const proof = authority.prepare({ scope, requestId: 'sidecar-clear-history', search: 'example.org', offset: 0,
      limit: 1, intent: 'Read before clear' })
    authority.grant({ scope, requestId: 'sidecar-clear-history', proofId: proof.proofId,
      queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
    authority.execute({ scope, requestId: 'sidecar-clear-history', proofId: proof.proofId, owner: reader })
    let releaseOpen!: (value: BrowserSnapshot) => void
    const queuedOpen = new Promise<BrowserSnapshot>(resolve => { releaseOpen = resolve })
    const registry = { ...historyStream(), dispatch: (_command: BrowserPageCommand) => queuedOpen }
    const owner = createChromiumHistoryOwner(history, registry, authority)
    const reopening = owner.reopenHistory(visitId)
    const clearing = owner.clearHistory({})
    assert.throws(() => authority.prepare({ scope, requestId: 'late-clear-reader', search: 'Page', offset: 0,
      limit: 1, intent: 'Read during clear' }), /history_clearing/)
    assert.throws(() => owner.queryHistory({ offset: 0, limit: 10 }), /history_clearing/)
    releaseOpen({ tabs: [], activeTabId: null, automation: { enabled: false, port: null } })
    await reopening
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(history.get(visitId), 'active Agent lease must still block deletion')
    authority.complete({ scope, requestId: 'sidecar-clear-history', proofId: proof.proofId })
    assert.equal(await clearing, 1)
    assert.equal(history.get(visitId), null)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar delete waits for an already queued reopen before deleting its visit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-history-reopen-race-'))
  try {
    const history = createBrowserHistory(directory)
    const visitId = history.record('https://example.org/', 'Page')
    const snapshot: BrowserSnapshot = { tabs: [], activeTabId: null,
      automation: { enabled: false, port: null } }
    let releaseOpen!: (value: BrowserSnapshot) => void
    const queuedOpen = new Promise<BrowserSnapshot>(resolve => { releaseOpen = resolve })
    const commands: BrowserPageCommand[] = []
    const registry = { ...historyStream(), dispatch(command: BrowserPageCommand) {
      commands.push(command)
      return queuedOpen
    } }
    const authority = createHistoryAgentAuthority(history, () => 1)
    const owner = createChromiumHistoryOwner(history, registry, authority)
    const reopening = owner.reopenHistory(visitId)
    const deleting = owner.deleteHistory(visitId)
    assert.throws(() => authority.prepare({ scope, requestId: 'late-reader', search: 'Page', offset: 0,
      limit: 1, intent: 'Read during queued reopen' }), /history_clearing/)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(history.get(visitId), 'a clear must not overtake an approved queued open')
    assert.deepEqual(commands, [{ kind: 'open', input: 'https://example.org/' }])
    assert.throws(() => owner.queryHistory({ offset: 0, limit: 10 }), /history_clearing/)
    releaseOpen(snapshot)
    assert.equal(await reopening, snapshot)
    assert.equal(await deleting, true)
    assert.equal(history.get(visitId), null)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar disposal retains the clear fence until a queued reopen settles after authority failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-history-dispose-race-'))
  try {
    const history = createBrowserHistory(directory)
    const visitId = history.record('https://example.org/', 'Page')
    let releaseOpen!: (value: BrowserSnapshot) => void
    const queuedOpen = new Promise<BrowserSnapshot>(resolve => { releaseOpen = resolve })
    let failDrain!: (error: Error) => void
    let beginCalls = 0
    let endCalls = 0
    const authority = {
      beginClear() { beginCalls++; return new Promise<void>((_resolve, reject) => { failDrain = reject }) },
      endClear() { endCalls++ }
    }
    const registry = { ...historyStream(), dispatch: (_command: BrowserPageCommand) => queuedOpen }
    const owner = createChromiumHistoryOwner(history, registry, authority)
    const reopening = owner.reopenHistory(visitId)
    const clearing = owner.beginClear()
    assert.equal(beginCalls, 1, 'Agent authority must fence before awaiting a queued reopen')
    owner.dispose()
    failDrain(new Error('history_busy'))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(endCalls, 0, 'authority fence must remain held while the reopen is pending')
    releaseOpen({ tabs: [], activeTabId: null, automation: { enabled: false, port: null } })
    await reopening
    await assert.rejects(clearing, /history_busy/)
    assert.equal(endCalls, 1)
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar visits persist in the existing database and titles bind to one tab sequence and URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-history-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    const authority = createHistoryAgentAuthority(history, () => 1)
    const owner = createChromiumHistoryOwner(history, stream, authority)
    const event = (kind: ChromiumHistoryEvent['kind'], tabId: string, visitSequence: number,
      url: string, title: string): ChromiumHistoryEvent => ({ kind, tabId, visitSequence, url, title })
    stream.emit(event('visit', 'tab-a', 1, 'https://example.org/a', 'A'))
    stream.emit(event('title', 'tab-a', 1, 'https://example.org/a', 'A titled'))
    stream.emit(event('visit', 'tab-a', 2, 'https://example.org/a', 'Reloaded'))
    stream.emit(event('title', 'tab-a', 1, 'https://example.org/a', 'Stale'))
    stream.emit(event('title', 'tab-a', 2, 'https://example.org/other', 'Wrong URL'))
    stream.emit(event('visit', 'tab-a', 2, 'https://example.org/a', 'Duplicate'))
    stream.emit(event('visit', 'tab-b', 1, 'https://example.org/a', 'Other tab'))
    stream.emit(event('title', 'tab-b', 1, 'https://example.org/a', 'Other titled'))
    stream.emit(event('closed', 'tab-b', 1, 'https://example.org/a', 'Other titled'))
    stream.emit(event('title', 'tab-b', 1, 'https://example.org/a', 'Late closed title'))
    const items = history.query({ offset: 0, limit: 10 }).items
    assert.equal(items.length, 3)
    assert.deepEqual(items.map(item => item.title).sort(), ['A titled', 'Other titled', 'Reloaded'])
    assert.equal(new Set(items.map(item => item.id)).size, 3)
    owner.dispose()
    stream.emit(event('visit', 'tab-a', 3, 'https://example.org/late', 'Late'))
    assert.equal(history.query({ offset: 0, limit: 10 }).total, 3)
    history.close()
    const reopened = createBrowserHistory(directory)
    assert.equal(reopened.query({ offset: 0, limit: 10 }).total, 3)
    reopened.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed sidecar clear releases only its own authority fence and resumes later visits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-clear-failure-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    let endCalls = 0
    let failure = 'history_busy'
    const authority = {
      async beginClear() { throw new Error(failure) },
      endClear() { endCalls++ }
    }
    const owner = createChromiumHistoryOwner(history, stream, authority)
    stream.emit({ kind: 'visit', tabId: 'existing', visitSequence: 1,
      url: 'https://example.org/existing', title: 'Before failed clear' })
    const failedDrain = owner.beginClear()
    stream.emit({ kind: 'title', tabId: 'existing', visitSequence: 1,
      url: 'https://example.org/existing', title: 'Only title during failed clear' })
    await assert.rejects(failedDrain, /history_busy/)
    assert.equal(endCalls, 1)
    assert.equal(history.query({ search: 'existing', offset: 0, limit: 10 }).items[0].title,
      'Only title during failed clear')
    stream.emit({ kind: 'title', tabId: 'existing', visitSequence: 1,
      url: 'https://example.org/existing', title: 'After failed clear' })
    assert.equal(history.query({ search: 'existing', offset: 0, limit: 10 }).items[0].title, 'After failed clear')
    const secondFailure = owner.beginClear()
    stream.emit({ kind: 'visit', tabId: 'existing', visitSequence: 2,
      url: 'https://example.org/existing', title: 'Skipped during clear' })
    await assert.rejects(secondFailure, /history_busy/)
    stream.emit({ kind: 'title', tabId: 'existing', visitSequence: 1,
      url: 'https://example.org/existing', title: 'Stale after new sequence' })
    assert.equal(history.query({ search: 'existing', offset: 0, limit: 10 }).items[0].title, 'After failed clear')
    stream.emit({ kind: 'visit', tabId: 'tab', visitSequence: 1, url: 'https://example.org/', title: 'After failure' })
    failure = 'history_clearing'
    const conflict = owner.beginClear()
    stream.emit({ kind: 'title', tabId: 'tab', visitSequence: 1,
      url: 'https://example.org/', title: 'Only title during conflict' })
    await assert.rejects(conflict, /history_clearing/)
    assert.equal(endCalls, 2)
    assert.equal(history.query({ search: 'Only title during conflict', offset: 0, limit: 10 }).total, 1)
    stream.emit({ kind: 'visit', tabId: 'tab', visitSequence: 2, url: 'https://example.org/', title: 'After conflict' })
    assert.equal(history.query({ offset: 0, limit: 10 }).total, 3)
    owner.endClear()
    assert.equal(endCalls, 2)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar owner disposal releases an acquired authority clear fence once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-dispose-clear-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    const agentAuthority = createHistoryAgentAuthority(history, () => 1)
    let endCalls = 0
    const authority = {
      beginClear: () => agentAuthority.beginClear(),
      endClear: () => { endCalls++; agentAuthority.endClear() }
    }
    const owner = createChromiumHistoryOwner(history, stream, authority)
    await owner.beginClear()
    owner.dispose()
    owner.dispose()
    owner.endClear()
    assert.equal(endCalls, 1)
    await agentAuthority.beginClear()
    agentAuthority.endClear()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar disposal while authority drain is pending releases the later fence once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-pending-dispose-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    let finishDrain!: () => void
    let endCalls = 0
    const authority = {
      beginClear: () => new Promise<void>(resolve => { finishDrain = resolve }),
      endClear: () => { endCalls++ }
    }
    const owner = createChromiumHistoryOwner(history, stream, authority)
    const pending = owner.beginClear()
    assert.throws(() => owner.endClear(), /history_busy/)
    owner.dispose()
    finishDrain()
    await assert.rejects(pending, /closed/)
    owner.endClear()
    assert.equal(endCalls, 1)
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar clear fence blocks visits immediately and prevents old titles after draining', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-clear-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    const authority = createHistoryAgentAuthority(history, () => 1)
    const owner = createChromiumHistoryOwner(history, stream, authority)
    const event = (kind: ChromiumHistoryEvent['kind'], visitSequence: number, title: string): ChromiumHistoryEvent =>
      ({ kind, tabId: 'tab', visitSequence, url: 'https://example.org/', title })
    stream.emit(event('visit', 1, 'Before'))
    const reader = {}
    authority.watchOwner(reader, new Promise<void>(() => {}))
    const proof = authority.prepare({ scope, requestId: 'sidecar-clear', search: 'Before', offset: 0,
      limit: 1, intent: 'Read prior history' })
    authority.grant({ scope, requestId: 'sidecar-clear', proofId: proof.proofId,
      queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
    authority.execute({ scope, requestId: 'sidecar-clear', proofId: proof.proofId, owner: reader })
    const drain = owner.beginClear()
    stream.emit(event('visit', 2, 'During'))
    stream.emit(event('title', 1, 'Old title'))
    assert.equal(history.query({ offset: 0, limit: 10 }).total, 1)
    authority.complete({ scope, requestId: 'sidecar-clear', proofId: proof.proofId })
    await drain
    assert.equal(history.clear({}), 1)
    owner.endClear()
    stream.emit(event('title', 1, 'After clear'))
    stream.emit(event('title', 2, 'After clear'))
    stream.emit(event('visit', 2, 'Replay'))
    assert.equal(history.query({ offset: 0, limit: 10 }).total, 0)
    stream.emit(event('visit', 3, 'New'))
    stream.emit(event('title', 3, 'New title'))
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['New title'])
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('selective sidecar clears retain title binding only for visits still in history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-selective-clear-'))
  try {
    const history = createBrowserHistory(directory)
    const record = history.record.bind(history)
    const timedHistory = { ...history, record(url: string, title: string) {
      return record(url, title, url.includes('/old') ? 1_000 : url.includes('/recent') ? 2_000 : 3_000)
    } }
    const stream = historyStream()
    const owner = createChromiumHistoryOwner(timedHistory, stream, createHistoryAgentAuthority(timedHistory, () => 1))
    const emit = (kind: ChromiumHistoryEvent['kind'], tabId: string, url: string, title: string): void =>
      stream.emit({ kind, tabId, visitSequence: 1, url, title })
    emit('visit', 'site-clear', 'https://example.org/recent', 'Site removed')
    emit('visit', 'survivor', 'https://other.org/recent', 'Other')
    await owner.beginClear()
    emit('title', 'site-clear', 'https://example.org/recent', 'Deleted title during clear')
    emit('title', 'survivor', 'https://other.org/recent', 'Earlier title during site clear')
    emit('title', 'survivor', 'https://other.org/recent', 'Only title during site clear')
    assert.equal(history.clear({ origin: 'https://example.org' }), 1)
    owner.endClear()
    emit('title', 'site-clear', 'https://example.org/recent', 'Should not return')
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['Only title during site clear'])

    emit('visit', 'time-survivor', 'https://example.org/old', 'Old')
    await owner.beginClear()
    emit('title', 'time-survivor', 'https://example.org/old', 'Only title during time clear')
    assert.equal(history.clear({ since: 1_500 }), 1)
    owner.endClear()
    emit('title', 'survivor', 'https://other.org/recent', 'Should stay deleted')
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['Only title during time clear'])
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('selective clear preserves unrelated visits committed while Agent leases drain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-selective-live-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    let releaseDrain!: () => void
    const authority = {
      beginClear: () => new Promise<void>(resolve => { releaseDrain = resolve }),
      endClear: () => undefined
    }
    const owner = createChromiumHistoryOwner(history, stream, authority)
    const clearing = owner.clearHistory({ origin: 'https://example.org' })
    stream.emit({ kind: 'visit', tabId: 'other', visitSequence: 1,
      url: 'https://other.org/page', title: 'Other' })
    stream.emit({ kind: 'title', tabId: 'other', visitSequence: 1,
      url: 'https://other.org/page', title: 'Other titled' })
    stream.emit({ kind: 'visit', tabId: 'selected', visitSequence: 1,
      url: 'https://example.org/page', title: 'Selected' })
    releaseDrain()
    assert.equal(await clearing, 0)
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['Other titled'])
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('closing a tab during clear drops its queued title without changing the retained visit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-closed-title-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    const owner = createChromiumHistoryOwner(history, stream, createHistoryAgentAuthority(history, () => 1))
    const url = 'https://example.org/'
    stream.emit({ kind: 'visit', tabId: 'closed', visitSequence: 1, url, title: 'Original' })
    await owner.beginClear()
    stream.emit({ kind: 'title', tabId: 'closed', visitSequence: 1, url, title: 'Queued' })
    stream.emit({ kind: 'closed', tabId: 'closed', visitSequence: 1, url, title: 'Queued' })
    owner.endClear()
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['Original'])
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sidecar history capacity fails explicitly and closed tabs release their slot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-sidecar-capacity-'))
  try {
    const history = createBrowserHistory(directory)
    const stream = historyStream()
    const owner = createChromiumHistoryOwner(history, stream, createHistoryAgentAuthority(history, () => 1))
    for (let index = 0; index < 1024; index++) {
      stream.emit({ kind: 'visit', tabId: `tab-${index}`, visitSequence: 1,
        url: 'https://example.org/', title: '' })
    }
    assert.throws(() => stream.emit({ kind: 'visit', tabId: 'overflow', visitSequence: 1,
      url: 'https://example.org/', title: '' }), /capacity/i)
    stream.emit({ kind: 'closed', tabId: 'tab-0', visitSequence: 1,
      url: 'https://example.org/', title: '' })
    stream.emit({ kind: 'visit', tabId: 'overflow', visitSequence: 1,
      url: 'https://example.org/', title: '' })
    assert.equal(history.query({ offset: 0, limit: 1 }).total, 1025)
    owner.dispose()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Agent history proof binds full scope and one query, consumes once, and never survives mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-agent-history-'))
  try {
    const history = createBrowserHistory(directory)
    history.record('https://example.org/secret', 'Secret')
    let policyRevision: number | null = 1
    const authority = createHistoryAgentAuthority(history, () => policyRevision)
    const owner = {}
    authority.watchOwner(owner, new Promise<void>(() => {}))
    const proof = authority.prepare({ scope, requestId: 'approval-1', search: 'Secret', offset: 0,
      limit: 1, intent: 'Find a prior page' })
    assert.equal(proof.queryDigest.length, 64)
    assert.equal(proof.historyRevision, history.revision())
    assert.throws(() => authority.execute({ scope, requestId: 'approval-1', proofId: proof.proofId, owner }), /approval_required/)
    authority.grant({ scope, requestId: 'approval-1', proofId: proof.proofId,
      queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
    const result = authority.execute({ scope, requestId: 'approval-1', proofId: proof.proofId, owner })
    assert.deepEqual(result.items.map(item => item.title), ['Secret'])
    assert.throws(() => authority.execute({ scope, requestId: 'approval-1', proofId: proof.proofId, owner }), /approval_required/)
    const changed = authority.prepare({ scope, requestId: 'approval-2', search: 'Secret', offset: 0,
      limit: 1, intent: 'Find again' })
    assert.throws(() => authority.grant({ scope: { ...scope, lifecycleEpoch: 2 }, requestId: 'approval-2',
      proofId: changed.proofId, queryDigest: changed.queryDigest,
      historyRevision: changed.historyRevision, expiresAt: changed.expiresAt }), /stale_scope/)
    history.clear({})
    assert.throws(() => authority.grant({ scope, requestId: 'approval-2', proofId: changed.proofId,
      queryDigest: changed.queryDigest, historyRevision: changed.historyRevision,
      expiresAt: changed.expiresAt }), /history_changed/)
    const afterClear = authority.prepare({ scope, requestId: 'approval-3', search: 'Secret', offset: 0,
      limit: 1, intent: 'Find after clear' })
    authority.grant({ scope, requestId: 'approval-3', proofId: afterClear.proofId,
      queryDigest: afterClear.queryDigest, historyRevision: afterClear.historyRevision,
      expiresAt: afterClear.expiresAt })
    policyRevision = null
    assert.throws(() => authority.execute({ scope, requestId: 'approval-3', proofId: afterClear.proofId, owner }), /browser_unavailable/)
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('history clear waits for approved response lease and blocks new preparations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-history-lease-'))
  try {
    const history = createBrowserHistory(directory)
    history.record('https://example.org/private', 'Private')
    const authority = createHistoryAgentAuthority(history, () => 1)
    const owner = {}
    authority.watchOwner(owner, new Promise<void>(() => {}))
    const proof = authority.prepare({ scope, requestId: 'approval', search: 'Private', offset: 0,
      limit: 1, intent: 'Find a visit' })
    authority.grant({ scope, requestId: 'approval', proofId: proof.proofId,
      queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
    assert.equal(authority.execute({ scope, requestId: 'approval', proofId: proof.proofId, owner }).total, 1)
    let drained = false
    const barrier = authority.beginClear().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false)
    assert.throws(() => authority.prepare({ scope, requestId: 'blocked', search: 'Private', offset: 0,
      limit: 1, intent: 'Find a visit' }), /history_clearing/)
    assert.throws(() => authority.complete({ scope, requestId: 'approval', proofId: 'forged' }), /approval_required/)
    assert.throws(() => authority.complete({ scope: { ...scope, generation: 2 }, requestId: 'approval',
      proofId: proof.proofId }), /approval_required/)
    assert.equal(drained, false)
    authority.complete({ scope, requestId: 'approval', proofId: proof.proofId })
    await barrier
    assert.equal(drained, true)
    history.clear({})
    authority.endClear()
    assert.equal(history.query({ offset: 0, limit: 10 }).total, 0)
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('confirmed old backend exit releases only old-owner leases across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-history-owner-'))
  try {
    const history = createBrowserHistory(directory)
    const authority = createHistoryAgentAuthority(history, () => 1)
    const oldOwner = {}
    const newOwner = {}
    let oldExit!: () => void
    let newExit!: () => void
    authority.watchOwner(oldOwner, new Promise<void>(resolve => { oldExit = resolve }))
    authority.watchOwner(newOwner, new Promise<void>(resolve => { newExit = resolve }))
    for (const [requestId, owner] of [['old', oldOwner], ['new', newOwner]] as const) {
      const proof = authority.prepare({ scope, requestId, search: 'private', offset: 0,
        limit: 1, intent: 'Find a visit' })
      authority.grant({ scope, requestId, proofId: proof.proofId,
        queryDigest: proof.queryDigest, historyRevision: proof.historyRevision, expiresAt: proof.expiresAt })
      authority.execute({ scope, requestId, proofId: proof.proofId, owner })
    }
    let drained = false
    const barrier = authority.beginClear().then(() => { drained = true })
    await Promise.resolve()
    oldExit()
    await Promise.resolve()
    assert.equal(drained, false)
    newExit()
    await barrier
    assert.equal(drained, true)
    authority.endClear()
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('browser visits persist, page, search, delete, and clear by time without affecting older visits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-browser-history-'))
  try {
    const history = createBrowserHistory(directory)
    const first = history.record('https://example.org/first', 'First', 1_000)
    history.record('https://example.org/second', 'Second', 2_000)
    history.close()

    const reopened = createBrowserHistory(directory)
    assert.deepEqual(reopened.query({ search: 'second', offset: 0, limit: 10 }).items.map(item => item.title), ['Second'])
    assert.equal(reopened.query({ offset: 0, limit: 1 }).total, 2)
    assert.deepEqual(reopened.query({ offset: 1, limit: 1 }).items.map(item => item.id), [first])
    assert.equal(reopened.clear({ since: 1_500 }), 1)
    assert.deepEqual(reopened.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['First'])
    assert.equal(reopened.delete(first), true)
    assert.equal(reopened.query({ offset: 0, limit: 10 }).total, 0)
    reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('clearing one site removes only its history across paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-browser-site-history-'))
  try {
    const history = createBrowserHistory(directory)
    history.record('https://example.org/first', 'First')
    history.record('https://example.org/second', 'Second')
    history.record('https://iana.org/', 'IANA')
    assert.equal(history.clear({ origin: 'https://example.org' }), 2)
    assert.deepEqual(history.query({ offset: 0, limit: 10 }).items.map(item => item.title), ['IANA'])
    history.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
