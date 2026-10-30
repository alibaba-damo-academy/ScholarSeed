import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChromiumMessage, ChromiumPipe } from './chromium.ts'
import { ChromiumProtocolError } from './chromium.ts'
import { ChromiumTargets } from './chromiumtarget.ts'

class FixturePipe {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  navigationError?: string
  closeError?: Error
  navigationReply: { frameId?: string; loaderId?: string } = { frameId: 'main-frame', loaderId: 'loader-1' }
  closeFailuresRemaining = 0
  closeResponseSuccess: boolean | undefined = true
  ackFailuresRemaining = 0
  destroyWhileClosing = false
  pipeClosed = false
  pageFocused = true
  editableFocused = true
  focusedObjectId = 'focused-1'
  insertTextFailuresRemaining = 0
  keyReleaseFailuresRemaining = 0
  detachFailuresRemaining = 0
  private readonly listeners = new Set<(message: ChromiumMessage) => void>()
  private nextTarget = 1
  readonly discovered: Array<Record<string, unknown>> = []
  onCreateTarget?: (targetId: string) => void
  onGetTargets?: () => void
  onAttachTarget?: (targetId: string) => void
  navigationHistory = { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] }
  frameTreeReply: unknown = {}
  onFrameTree?: () => void
  readyState?: string
  onReadinessProbe?: () => void
  historyError?: Error
  onHistoryCommand?: () => void

  onEvent(listener: (message: ChromiumMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId })
    if (method === 'Target.createTarget') {
      const targetId = `target-${this.nextTarget++}`
      this.onCreateTarget?.(targetId)
      return { targetId }
    }
    if (method === 'Target.getTargets') {
      const targetInfos = [...this.discovered]
      this.onGetTargets?.()
      return { targetInfos }
    }
    if (method === 'Target.attachToTarget') {
      this.onAttachTarget?.(String(params.targetId))
      return { sessionId: `session-${params.targetId}` }
    }
    if (method === 'Page.navigate' && this.navigationError) return { errorText: this.navigationError }
    if (method === 'Page.navigate') return this.navigationReply
    if (method === 'Page.getFrameTree') {
      this.onFrameTree?.()
      return this.frameTreeReply
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
    if (method === 'Runtime.evaluate' && params.expression === 'document.readyState') {
      this.onReadinessProbe?.()
      return { result: { type: 'string', value: this.readyState } }
    }
    if ((method === 'Page.navigateToHistoryEntry' || method === 'Page.reload') && this.historyError) {
      this.onHistoryCommand?.()
      throw this.historyError
    }
    if (method === 'Page.getNavigationHistory') return this.navigationHistory
    if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: this.focusedObjectId } }
    if (method === 'Runtime.callFunctionOn') return {
      result: { type: 'boolean', value: this.pageFocused && this.editableFocused && params.objectId === this.focusedObjectId }
    }
    if (method === 'Input.insertText' && this.insertTextFailuresRemaining-- > 0) throw new Error('commit timeout')
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && this.keyReleaseFailuresRemaining-- > 0) {
      throw new Error('key release failed')
    }
    if (method === 'Target.closeTarget' && this.destroyWhileClosing) {
      this.emit({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } })
      throw new Error('target already destroyed')
    }
    if (method === 'Target.closeTarget' && this.closeFailuresRemaining-- > 0) throw new Error('close target failed')
    if (method === 'Target.closeTarget') return { success: this.closeResponseSuccess }
    if (method === 'Target.detachFromTarget' && this.detachFailuresRemaining-- > 0) throw new Error('detach failed')
    if (method === 'Page.screencastFrameAck' && this.ackFailuresRemaining-- > 0) throw new Error('frame ack failed')
    return {}
  }

  async close(): Promise<void> {
    this.pipeClosed = true
    if (this.closeError) throw this.closeError
  }

  emit(message: ChromiumMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

function manager(fixture: FixturePipe): ChromiumTargets {
  return new ChromiumTargets(fixture as Pick<ChromiumPipe, 'command' | 'onEvent' | 'close'>)
}

const jpegFrame = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 2, 88, 3, 32]).toString('base64')

test('Agent page commands and events stay on one managed target session with a strict method allowlist', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', url: 'about:blank' } } }
  const targets = manager(fixture)
  const first = await targets.create()
  const second = await targets.create()
  const events: Array<{ targetId: string; method: string }> = []
  const unsubscribe = targets.onAgentPageEvent(event => events.push({ targetId: event.targetId, method: event.method }))
  await targets.agentCommand(first, 'DOM.getDocument', { depth: 1 })
  assert.deepEqual(fixture.calls.at(-1), { method: 'DOM.getDocument', params: { depth: 1 }, sessionId: `session-${first}` })
  for (const method of ['Target.getTargets', 'Browser.getVersion', 'Runtime.evaluate', 'Page.navigate']) {
    await assert.rejects(targets.agentCommand(first, method, {}), /not allowed/)
  }
  fixture.emit({ method: 'Network.requestWillBeSent', sessionId: `session-${first}`, params: { requestId: 'request' } })
  fixture.emit({ method: 'Network.requestWillBeSent', sessionId: `session-${second}`, params: { requestId: 'other' } })
  fixture.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'other' } } })
  assert.deepEqual(events, [
    { targetId: first, method: 'Network.requestWillBeSent' },
    { targetId: second, method: 'Network.requestWillBeSent' }
  ])
  unsubscribe()
  await targets.close()
})

test('Agent AX read stays bound to its page and rejects unrelated protocol methods', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  try {
    const targetId = await targets.create()
    const sessionId = targets.agentPageSession(targetId)
    await targets.agentCommand(targetId, 'Accessibility.getFullAXTree', { frameId: 'main-frame' })
    assert.ok(fixture.calls.some(call => call.method === 'Accessibility.getFullAXTree'
      && call.sessionId === sessionId && call.params.frameId === 'main-frame'))
    await assert.rejects(targets.agentCommand(targetId, 'Runtime.evaluate', { expression: 'document.title' }), /not allowed/)
  } finally { await targets.close() }
})

test('Agent page loading tracks main-frame starts, matching stops, commits, and BFCache without subframe or stale clears', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.emit({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'child-frame' } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.emit({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'main-frame' } })
  fixture.emit({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'main-frame' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.frameStoppedLoading', sessionId, params: { frameId: 'child-frame' } })
  fixture.emit({ method: 'Page.frameStoppedLoading', sessionId, params: { frameId: 'main-frame' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.frameStoppedLoading', sessionId, params: { frameId: 'main-frame' } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.emit({ method: 'Page.frameNavigated', sessionId, params: { type: 'Navigation', frame: {
    id: 'main-frame', loaderId: 'loader-new', url: 'https://example.org/' } } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-old', name: 'load', timestamp: 10 } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-new', name: 'load', timestamp: 10 } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-new', name: 'init', timestamp: 11 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-new', name: 'load', timestamp: 12 } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  await targets.goBack(targetId)
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'main-frame' } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId, params: { type: 'BackForwardCacheRestore', frame: {
    id: 'main-frame', loaderId: 'loader-restored', url: 'https://example.org/back' } } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.emit({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'main-frame' } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId, params: { type: 'Navigation', frame: {
    id: 'main-frame', loaderId: 'loader-later', url: 'https://example.org/later' } } })
  fixture.emit({ method: 'Page.frameStoppedLoading', sessionId, params: { frameId: 'main-frame' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  await targets.close()
})

test('main-frame document request marks loading before frameStartedLoading while subframe requests do not', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  fixture.emit({ method: 'Network.requestWillBeSent', sessionId, params: {
    requestId: 'child-request', frameId: 'child-frame', loaderId: 'child-loader', type: 'Document' } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.emit({ method: 'Network.requestWillBeSent', sessionId, params: {
    requestId: 'main-request', frameId: 'main-frame', loaderId: 'new-loader', type: 'Document' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Network.loadingFailed', sessionId, params: { requestId: 'child-request' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Network.loadingFailed', sessionId, params: { requestId: 'main-request' } })
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.emit({ method: 'Page.frameNavigated', sessionId, params: { type: 'Navigation', frame: {
    id: 'main-frame', loaderId: 'new-loader', url: 'https://example.org/' } } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'new-loader', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'new-loader', name: 'load', timestamp: 11 } })
  assert.equal(targets.agentPageState(targetId).loading, false)
  await targets.close()
})

test('duplicate completed main-frame commit does not restart loading or advance navigation epoch', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  const commit = { method: 'Page.frameNavigated', sessionId, params: { type: 'Navigation', frame: {
    id: 'main-frame', loaderId: 'loader-new', url: 'https://example.org/' } } }
  fixture.emit(commit)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-new', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId, params: {
    frameId: 'main-frame', loaderId: 'loader-new', name: 'load', timestamp: 11 } })
  const completed = targets.agentPageState(targetId)
  assert.equal(completed.loading, false)
  fixture.emit(commit)
  assert.deepEqual(targets.agentPageState(targetId), completed)
  await targets.close()
})

test('already loaded discovered page needs isolated-world readiness and stable frame identity', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'loaded-page', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('loaded-page').loading, false)
  assert.ok(fixture.calls.some(call => call.method === 'Page.createIsolatedWorld' && call.sessionId === 'session-loaded-page'))
  assert.ok(fixture.calls.some(call => call.method === 'Runtime.evaluate'
    && call.params.expression === 'document.readyState' && call.params.contextId === 17
    && call.sessionId === 'session-loaded-page'))
  await targets.close()
})

test('readiness probe stays unknown when navigation starts during attach', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'racing-page', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onReadinessProbe = () => fixture.emit({ method: 'Page.frameStartedLoading',
    sessionId: 'session-racing-page', params: { frameId: 'main-frame' } })
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('racing-page').loading, true)
  await targets.close()
})

test('attach captures main-frame navigation before the first frame tree', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'early-navigation', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onFrameTree = () => {
    fixture.onFrameTree = undefined
    fixture.emit({ method: 'Page.frameStartedLoading', sessionId: 'session-early-navigation',
      params: { frameId: 'main-frame' } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('early-navigation').loading, true)
  await targets.close()
})

test('attach captures loading before its session ID is returned', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'early-session', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onAttachTarget = targetId => fixture.emit({ method: 'Page.frameStartedLoading',
    sessionId: `session-${targetId}`, params: { frameId: 'old-main-frame' } })
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('early-session').loading, true)
  await targets.close()
})

test('known child-frame loading before the first tree does not block an already loaded main frame', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'early-child', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: {
    frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' },
    childFrames: [{ frame: { id: 'child-frame', loaderId: 'child-1', url: 'https://example.org/child' } }]
  } }
  fixture.readyState = 'complete'
  fixture.onFrameTree = () => {
    fixture.onFrameTree = undefined
    fixture.emit({ method: 'Page.frameStartedLoading', sessionId: 'session-early-child',
      params: { frameId: 'child-frame' } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('early-child').loading, false)
  await targets.close()
})

test('another busy session cannot exhaust the attaching page event buffer', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'quiet-page', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onAttachTarget = () => {
    for (let index = 0; index < 1100; index++) fixture.emit({ method: 'Page.frameStartedLoading',
      sessionId: 'session-other-busy-page', params: { frameId: 'other-main-frame' } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('quiet-page').loading, false)
  await targets.close()
})

test('attach still preserves its own early navigation among another session’s noise', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'navigating-page', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onAttachTarget = targetId => {
    for (let index = 0; index < 1100; index++) fixture.emit({ method: 'Page.frameStartedLoading',
      sessionId: 'session-other-busy-page', params: { frameId: 'other-main-frame' } })
    fixture.emit({ method: 'Page.frameStartedLoading', sessionId: `session-${targetId}`,
      params: { frameId: 'main-frame' } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('navigating-page').loading, true)
  await targets.close()
})

test('main-frame document request during readiness probe remains loading despite old readyState', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'document-request', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onReadinessProbe = () => fixture.emit({ method: 'Network.requestWillBeSent',
    sessionId: 'session-document-request', params: {
      requestId: 'navigation-1', frameId: 'main-frame', loaderId: 'next-loader', type: 'Document'
    } })
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('document-request').loading, true)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId: 'session-document-request', params: {
    frameId: 'main-frame', loaderId: 'loaded-1', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId: 'session-document-request', params: {
    frameId: 'main-frame', loaderId: 'loaded-1', name: 'load', timestamp: 11 } })
  assert.equal(targets.agentPageState('document-request').loading, true)
  await targets.close()
})

test('unrelated XHR and subframe events do not invalidate a stable main-frame readiness probe', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'background-network', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onReadinessProbe = () => {
    fixture.emit({ method: 'Network.requestWillBeSent', sessionId: 'session-background-network',
      params: { requestId: 'xhr-1', frameId: 'main-frame', type: 'XHR' } })
    fixture.emit({ method: 'Page.frameStartedLoading', sessionId: 'session-background-network',
      params: { frameId: 'child-frame' } })
    fixture.emit({ method: 'Page.lifecycleEvent', sessionId: 'session-background-network',
      params: { frameId: 'child-frame', loaderId: 'child-loader', name: 'init', timestamp: 10 } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('background-network').loading, false)
  await targets.close()
})

test('replayed lifecycle events for the current loader do not imply a new navigation', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'lifecycle-replay', type: 'page', url: 'https://example.org/', title: 'Loaded' })
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'loaded-1', url: 'https://example.org/' } } }
  fixture.readyState = 'complete'
  fixture.onFrameTree = () => {
    fixture.onFrameTree = undefined
    fixture.emit({ method: 'Page.lifecycleEvent', sessionId: 'session-lifecycle-replay', params: {
      frameId: 'main-frame', loaderId: 'loaded-1', name: 'commit', timestamp: 10 } })
    fixture.emit({ method: 'Page.lifecycleEvent', sessionId: 'session-lifecycle-replay', params: {
      frameId: 'main-frame', loaderId: 'loaded-1', name: 'load', timestamp: 11 } })
  }
  const targets = manager(fixture)
  await targets.discover()
  assert.equal(targets.agentPageState('lifecycle-replay').loading, false)
  await targets.close()
})

test('known history and reload refusal releases pending state; uncertain command does not', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  fixture.historyError = new ChromiumProtocolError('History denied', -32000)
  await assert.rejects(targets.goBack(targetId), /History denied/)
  assert.equal(targets.agentPageState(targetId).loading, false)
  await assert.rejects(targets.goForward(targetId), /History denied/)
  assert.equal(targets.agentPageState(targetId).loading, false)
  await assert.rejects(targets.reload(targetId), /History denied/)
  assert.equal(targets.agentPageState(targetId).loading, false)
  fixture.onHistoryCommand = () => {
    fixture.emit({ method: 'Page.frameStartedLoading', sessionId: `session-${targetId}`, params: { frameId: 'main-frame' } })
    fixture.emit({ method: 'Page.frameStoppedLoading', sessionId: `session-${targetId}`, params: { frameId: 'main-frame' } })
  }
  await assert.rejects(targets.reload(targetId), /History denied/)
  assert.equal(targets.agentPageState(targetId).loading, true)
  fixture.onHistoryCommand = undefined
  fixture.historyError = new Error('Command timed out')
  await assert.rejects(targets.reload(targetId), /timed out/)
  assert.equal(targets.agentPageState(targetId).loading, true)
  await targets.close()
})

function frame(sessionId: string, chromeSessionId: number, data = jpegFrame): ChromiumMessage {
  return {
    method: 'Page.screencastFrame', sessionId,
    params: { data, metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: chromeSessionId }
  }
}

test('history navigation and reload address the existing page session', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  assert.deepEqual(await targets.navigationState(targetId), { canGoBack: true, canGoForward: true })
  await targets.goBack(targetId)
  await targets.goForward(targetId)
  await targets.reload(targetId)
  assert.deepEqual(fixture.calls.filter(call => ['Page.navigateToHistoryEntry', 'Page.reload'].includes(call.method)), [
    { method: 'Page.navigateToHistoryEntry', params: { entryId: 10 }, sessionId: `session-${targetId}` },
    { method: 'Page.navigateToHistoryEntry', params: { entryId: 12 }, sessionId: `session-${targetId}` },
    { method: 'Page.reload', params: {}, sessionId: `session-${targetId}` }
  ])
  await targets.close()
})

test('main-frame lifecycle readiness retains loader identity and excludes subframes', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const events: Array<{ kind: string; frameId?: string; loaderId?: string }> = []
  targets.onTarget(event => events.push(event))
  const targetId = await targets.create()
  assert.ok(fixture.calls.some(call => call.method === 'Page.setLifecycleEventsEnabled' &&
    call.sessionId === `session-${targetId}` && call.params.enabled === true))
  fixture.emit({ method: 'Page.frameNavigated', sessionId: `session-${targetId}`,
    params: { frame: { id: 'main-frame', loaderId: 'loader-1', url: 'https://example.com/' } } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId: `session-${targetId}`,
    params: { frameId: 'main-frame', loaderId: 'loader-1', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId: `session-${targetId}`,
    params: { frameId: 'child-frame', loaderId: 'loader-1', name: 'DOMContentLoaded', timestamp: 11 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId: `session-${targetId}`,
    params: { frameId: 'main-frame', loaderId: 'loader-1', name: 'DOMContentLoaded', timestamp: 12 } })
  assert.deepEqual(events.filter(event => event.kind === 'ready'), [
    { kind: 'ready', info: { targetId, url: 'https://example.com/', title: '' }, frameId: 'main-frame',
      loaderId: 'loader-1', documentEpoch: 1 }
  ])
  await targets.close()
})

test('negative target close reply keeps the page registered for fail-closed ownership', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  fixture.closeResponseSuccess = false
  await assert.rejects(targets.closeTarget(targetId), /did not close/)
  assert.equal(targets.listTargets().some(target => target.targetId === targetId), true)
  fixture.closeResponseSuccess = undefined
  await assert.rejects(targets.closeTarget(targetId), /did not close/)
  fixture.closeResponseSuccess = true
  await targets.close()
})

test('normal target shutdown closes its underlying Chromium transport', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  await targets.create()
  await targets.close()
  assert.equal(fixture.pipeClosed, true)
})

test('main-frame commit publishes navigation without relying on targetInfoChanged', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; info: { url: string } }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.frameNavigated', sessionId: `session-${targetId}`,
    params: { frame: { id: 'main-frame', loaderId: 'loader-1', url: 'https://example.com/' } } })
  assert.equal(events.at(-1)?.kind, 'navigated')
  assert.equal(events.at(-1)?.info.url, 'https://example.com/')
  assert.equal((events.at(-1) as { loaderId?: string })?.loaderId, 'loader-1')
  await targets.close()
})

test('BFCache restore marks the main-frame navigation without synthesizing readiness', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; navigationType?: string }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.frameNavigated', sessionId: `session-${targetId}`,
    params: { type: 'BackForwardCacheRestore', frame: {
      id: 'main-frame', loaderId: 'prior-loader', url: 'https://example.com/cached'
    } } })
  assert.deepEqual(events.map(event => [event.kind, event.navigationType]), [
    ['navigated', 'BackForwardCacheRestore']
  ])
  await targets.close()
})

test('stale lifecycle ready cannot be projected onto a same-loader new document', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  const events: Array<{ kind: string; info: { url: string }; documentEpoch?: number }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'reused', url: 'https://example.com/a' } } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'DOMContentLoaded', timestamp: 11 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 20 } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'reused', url: 'https://example.com/b' } } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'load', timestamp: 12 } })
  assert.equal(events.filter(event => event.kind === 'ready').length, 1)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'DOMContentLoaded', timestamp: 21 } })
  assert.deepEqual(events.filter(event => event.kind === 'ready').map(event => [event.info.url, event.documentEpoch]), [
    ['https://example.com/a', 1], ['https://example.com/b', 2]
  ])
  await targets.close()
})

test('ordinary main-frame commit waits for a matching init when frameNavigated arrives first', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  const events: Array<{ kind: string; documentEpoch?: number; info: { url: string } }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'new-loader', url: 'https://example.com/' } } })
  assert.equal(events.length, 0)
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'new-loader', name: 'init', timestamp: 10 } })
  assert.deepEqual(events.map(event => [event.kind, event.documentEpoch, event.info.url]), [
    ['navigated', 1, 'https://example.com/']
  ])
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'new-loader', name: 'DOMContentLoaded', timestamp: 11 } })
  assert.equal(events.at(-1)?.kind, 'ready')
  await targets.close()
})

test('early lifecycle ready retains document epoch despite projecting the previous target URL', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  const events: Array<{ kind: string; info: { url: string }; documentEpoch?: number }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'new-loader', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'new-loader', name: 'DOMContentLoaded', timestamp: 11 } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'new-loader', url: 'https://example.com/' } } })
  assert.deepEqual(events.map(event => [event.kind, event.info.url, event.documentEpoch]), [
    ['ready', 'about:blank', 1], ['navigated', 'https://example.com/', 1]
  ])
  await targets.close()
})

test('ordinary commit without a matching init closes the isolated target after a bounded deadline', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = new ChromiumTargets(fixture as Pick<ChromiumPipe, 'command' | 'onEvent' | 'close'>,
    { documentInitTimeoutMs: 20 })
  const targetId = await targets.create()
  const events: string[] = []
  targets.onTarget(event => events.push(event.kind))
  fixture.emit({ method: 'Page.frameNavigated', sessionId: `session-${targetId}`,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'new-loader', url: 'https://example.com/' } } })
  assert.equal(events.includes('navigated'), false)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(fixture.pipeClosed, true)
  assert.ok(events.includes('destroyed'))
})

test('late duplicate init cannot release a same-loader pending new URL', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const sessionId = `session-${targetId}`
  const commits: Array<{ url: string; documentEpoch?: number }> = []
  targets.onTarget(event => { if (event.kind === 'navigated') commits.push({ url: event.info.url, documentEpoch: event.documentEpoch }) })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'reused', url: 'https://example.com/a' } } })
  fixture.emit({ method: 'Page.frameNavigated', sessionId,
    params: { type: 'Navigation', frame: { id: 'main-frame', loaderId: 'reused', url: 'https://example.com/b' } } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 10 } })
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 9 } })
  assert.deepEqual(commits, [{ url: 'https://example.com/a', documentEpoch: 1 }])
  fixture.emit({ method: 'Page.lifecycleEvent', sessionId,
    params: { frameId: 'main-frame', loaderId: 'reused', name: 'init', timestamp: 20 } })
  assert.deepEqual(commits, [
    { url: 'https://example.com/a', documentEpoch: 1 },
    { url: 'https://example.com/b', documentEpoch: 2 }
  ])
  await targets.close()
})

test('attached page advertises a committed frame-tree identity for initial history', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: {
    id: 'main-frame', loaderId: 'initial-loader', url: 'https://external.example/', urlFragment: '#loaded'
  } } }
  fixture.discovered.push({ type: 'page', targetId: 'external', url: 'https://external.example/#loaded', title: 'Loaded' })
  const targets = manager(fixture)
  const events: Array<{ kind: string; info: { url: string }; frameId?: string; loaderId?: string }> = []
  targets.onTarget(event => events.push(event))
  await targets.discover()
  assert.ok(events.some(event => event.kind === 'created' && event.info.url === 'https://external.example/#loaded' &&
    event.frameId === 'main-frame' && event.loaderId === 'initial-loader'))
  await targets.close()
})

test('page-scoped Network reports final document status with frame and loader identity', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; status?: number; frameId?: string; loaderId?: string }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Network.responseReceived', sessionId: `session-${targetId}`, params: {
    type: 'Script', frameId: 'main-frame', loaderId: 'loader-1',
    response: { url: 'https://example.com/app.js', status: 200 }
  } })
  fixture.emit({ method: 'Network.responseReceived', sessionId: `session-${targetId}`, params: {
    type: 'Document', frameId: 'main-frame', loaderId: 'loader-1',
    response: { url: 'https://example.com/', status: 200, fromDiskCache: true }
  } })
  assert.ok(fixture.calls.some(call => call.method === 'Network.enable' && call.sessionId === `session-${targetId}`))
  assert.deepEqual(events.map(event => [event.kind, event.frameId, event.loaderId, event.status]), [
    ['response', 'main-frame', 'loader-1', 200]
  ])
  await targets.closeTarget(targetId)
  fixture.emit({ method: 'Network.responseReceived', sessionId: `session-${targetId}`, params: {
    type: 'Document', frameId: 'main-frame', loaderId: 'late-loader',
    response: { url: 'https://late.example/', status: 200 }
  } })
  assert.equal(events.filter(event => event.kind === 'response').length, 1)
  await targets.close()
})

test('main-frame URL includes urlFragment while its network response URL does not', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; info: { url: string } }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.frameNavigated', sessionId: `session-${targetId}`, params: {
    frame: { id: 'main-frame', loaderId: 'loader-1', url: 'https://a.example/', urlFragment: '#x' }
  } })
  assert.equal(events.at(-1)?.info.url, 'https://a.example/#x')
  await targets.close()
})

test('document responses from many iframes cannot displace the main-frame response', async () => {
  const fixture = new FixturePipe()
  fixture.frameTreeReply = { frameTree: { frame: { id: 'main-frame', loaderId: 'initial', url: 'about:blank' } } }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; frameId?: string }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Network.responseReceived', sessionId: `session-${targetId}`, params: {
    type: 'Document', frameId: 'main-frame', loaderId: 'loader-1',
    response: { url: 'https://a.example/', status: 200 }
  } })
  for (let index = 0; index < 20; index++) fixture.emit({
    method: 'Network.responseReceived', sessionId: `session-${targetId}`, params: {
      type: 'Document', frameId: `child-${index}`, loaderId: `child-loader-${index}`,
      response: { url: `https://child.example/${index}`, status: 200 }
    }
  })
  assert.deepEqual(events.filter(event => event.kind === 'response').map(event => event.frameId), ['main-frame'])
  await targets.close()
})

test('same-document navigation emits a main-frame event with its URL', async () => {
  const fixture = new FixturePipe()
  fixture.navigationReply = { frameId: 'main-frame' }
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; info: { url: string }; frameId?: string }> = []
  targets.onTarget(event => events.push(event))
  assert.deepEqual(await targets.navigate(targetId, 'https://example.com/#section'), { frameId: 'main-frame', loaderId: null })
  fixture.emit({ method: 'Page.navigatedWithinDocument', sessionId: `session-${targetId}`,
    params: { frameId: 'main-frame', url: 'https://example.com/#section' } })
  assert.equal(events.at(-1)?.kind, 'same-document')
  assert.equal(events.at(-1)?.info.url, 'https://example.com/#section')
  await targets.close()
})

test('unknown main frame ignores same-document events from subframes', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const events: Array<{ kind: string; info: { url: string } }> = []
  targets.onTarget(event => events.push(event))
  fixture.emit({ method: 'Page.navigatedWithinDocument', sessionId: `session-${targetId}`,
    params: { frameId: 'child-frame', url: 'https://untrusted.example/' } })
  assert.equal(events.length, 0)
  assert.equal(targets.listTargets()[0].url, 'about:blank')
  await targets.close()
})

test('abort reports transport close failure instead of claiming shutdown', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  await targets.create()
  fixture.closeError = new Error('transport close failed')
  await assert.rejects(targets.abort(new Error('navigation uncertain')), /transport close failed/)
  await assert.rejects(targets.close(), /transport close failed/)
})

test('creates separate target sessions and directs navigation to the selected page', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create({ width: 800, height: 600 })
  const second = await targets.create({ width: 1024, height: 768 })
  assert.notEqual(first, second)
  await targets.navigate(second, 'https://example.com/page')
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.navigate'), [{
    method: 'Page.navigate', params: { url: 'https://example.com/page' }, sessionId: 'session-target-2'
  }])
  await assert.rejects(targets.navigate(first, 'file:///etc/passwd'), /not allowed/)
  fixture.navigationError = 'net::ERR_NAME_NOT_RESOLVED'
  await assert.rejects(targets.navigate(first, 'https://missing.example'), /ERR_NAME_NOT_RESOLVED/)
  await targets.close()
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), [first, second])
})

test('discovers only page targets from snapshot and events, including external CDP pages', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push(
    { targetId: 'external-page', type: 'page', url: 'https://example.com/', title: 'Example' },
    { targetId: 'browser-root', type: 'browser', url: '', title: '' },
    { targetId: 'devtools', type: 'other', url: 'devtools://devtools/', title: '' },
    { targetId: 'frame', type: 'iframe', url: 'https://example.com/frame', title: '' }
  )
  const targets = manager(fixture)
  const events: Array<{ kind: string; targetId: string }> = []
  targets.onTarget(event => events.push({ kind: event.kind, targetId: event.info.targetId }))
  await targets.discover()
  assert.deepEqual(targets.listTargets().map(info => info.targetId), ['external-page'])
  assert.deepEqual(events, [{ kind: 'created', targetId: 'external-page' }])
  fixture.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'cdp-page', type: 'page', url: 'about:blank', title: '' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(targets.listTargets().map(info => info.targetId), ['external-page', 'cdp-page'])
  await targets.activate('cdp-page')
  assert.equal(fixture.calls.find(call => call.method === 'Page.startScreencast')?.sessionId, 'session-cdp-page')
  await targets.close()
})

test('snapshot and discovery events converge without reviving destroyed or duplicate targets', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'stale', type: 'page', url: 'about:blank', title: '' })
  fixture.onGetTargets = () => {
    fixture.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'stale', type: 'page', url: 'about:blank', title: '' } } })
    fixture.emit({ method: 'Target.targetDestroyed', params: { targetId: 'stale' } })
  }
  fixture.onCreateTarget = targetId => fixture.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId, type: 'page', url: 'about:blank', title: '' } } })
  const targets = manager(fixture)
  await targets.discover()
  assert.deepEqual(targets.listTargets(), [])
  const targetId = await targets.create({ width: 900, height: 700 })
  assert.deepEqual(targets.listTargets().map(info => info.targetId), [targetId])
  assert.equal(fixture.calls.filter(call => call.method === 'Target.attachToTarget' && call.params.targetId === targetId).length, 1)
  await targets.close()
})

test('a page created while getTargets runs appears once even when absent from its snapshot', async () => {
  const fixture = new FixturePipe()
  fixture.onGetTargets = () => fixture.emit({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'during-query', type: 'page', url: 'about:blank', title: '' } }
  })
  const targets = manager(fixture)
  const created: string[] = []
  targets.onTarget(event => { if (event.kind === 'created') created.push(event.info.targetId) })
  await targets.discover()
  assert.deepEqual(created, ['during-query'])
  assert.equal(fixture.calls.filter(call => call.method === 'Target.attachToTarget').length, 1)
  await targets.close()
})

test('a discovered page changing to a non-page type is removed from the registry', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'changed', type: 'page', url: 'about:blank', title: '' })
  const targets = manager(fixture)
  const kinds: string[] = []
  targets.onTarget(event => kinds.push(event.kind))
  await targets.discover()
  fixture.emit({ method: 'Target.targetInfoChanged', params: {
    targetInfo: { targetId: 'changed', type: 'other', url: 'devtools://devtools/', title: '' }
  } })
  assert.deepEqual(targets.listTargets(), [])
  assert.deepEqual(kinds, ['created', 'destroyed'])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId), ['session-changed'])
  await targets.close()
})

test('failed release of a retyped registered page closes the isolated pipe', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'changed', type: 'page', url: 'about:blank', title: '' })
  const targets = manager(fixture)
  await targets.discover()
  fixture.detachFailuresRemaining = 1
  fixture.emit({ method: 'Target.targetInfoChanged', params: {
    targetInfo: { targetId: 'changed', type: 'other', url: 'devtools://devtools/', title: '' }
  } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.pipeClosed, true)
  assert.throws(() => targets.listTargets(), /closed/)
  await targets.close()
})

test('a target destroyed during attachment never becomes a registered page', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'vanishing', type: 'page', url: 'about:blank', title: '' })
  fixture.onAttachTarget = targetId => fixture.emit({ method: 'Target.targetDestroyed', params: { targetId } })
  const targets = manager(fixture)
  const events: string[] = []
  targets.onTarget(event => events.push(event.kind))
  await targets.discover()
  assert.deepEqual(targets.listTargets(), [])
  assert.deepEqual(events, [])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId), ['session-vanishing'])
  await targets.close()
})

test('a page retyped during attachment releases its session without closing a non-page target', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'retyped', type: 'page', url: 'about:blank', title: '' })
  fixture.onAttachTarget = targetId => fixture.emit({ method: 'Target.targetInfoChanged', params: {
    targetInfo: { targetId, type: 'other', url: 'devtools://devtools/', title: '' }
  } })
  const targets = manager(fixture)
  await targets.discover()
  assert.deepEqual(targets.listTargets(), [])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId), ['session-retyped'])
  assert.equal(fixture.calls.filter(call => call.method === 'Target.closeTarget').length, 0)
  await targets.close()
})

test('a session detached during attachment closes its target before it becomes visible', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'detached-early', type: 'page', url: 'about:blank', title: '' })
  fixture.onAttachTarget = targetId => fixture.emit({
    method: 'Target.detachedFromTarget', params: { sessionId: `session-${targetId}` }
  })
  const targets = manager(fixture)
  await targets.discover()
  assert.deepEqual(targets.listTargets(), [])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['detached-early'])
  await targets.close()
})

test('target metadata changes and external destruction notify one unified registry', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'external', type: 'page', url: 'about:blank', title: '' })
  const targets = manager(fixture)
  const events: Array<{ kind: string; url: string }> = []
  targets.onTarget(event => events.push({ kind: event.kind, url: event.info.url }))
  await targets.discover()
  fixture.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'external', type: 'page', url: 'https://example.com/', title: 'Example' } } })
  fixture.emit({ method: 'Target.targetDestroyed', params: { targetId: 'external' } })
  assert.deepEqual(events, [
    { kind: 'created', url: 'about:blank' },
    { kind: 'updated', url: 'https://example.com/' },
    { kind: 'destroyed', url: 'https://example.com/' }
  ])
  assert.deepEqual(targets.listTargets(), [])
  await assert.rejects(targets.activate('external'), /Unknown/)
  await targets.close()
})

test('unexpected detach notifies registry and closes externally created page', async () => {
  const fixture = new FixturePipe()
  fixture.discovered.push({ targetId: 'external', type: 'page', url: 'about:blank', title: '' })
  const targets = manager(fixture)
  const kinds: string[] = []
  targets.onTarget(event => kinds.push(event.kind))
  await targets.discover()
  fixture.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-external' } })
  await targets.close()
  assert.deepEqual(kinds, ['created', 'detached', 'destroyed'])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['external'])
})

test('forwards one bounded frame until its exact sequence is acknowledged', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create({ width: 800, height: 600 })
  const frames: number[] = []
  targets.onFrame(value => frames.push(value.sequence))
  await targets.activate(targetId)
  fixture.emit(frame('session-target-1', 91))
  fixture.emit(frame('session-target-1', 92))
  assert.deepEqual(frames, [1])
  const firstFrame = fixture.calls.filter(call => call.method === 'Page.screencastFrameAck')
  assert.equal(firstFrame.length, 1)
  await assert.rejects(targets.acknowledgeFrame(targetId, 0), /stale/)
  await targets.acknowledgeFrame(targetId, 1)
  fixture.emit(frame('session-target-1', 93))
  assert.deepEqual(frames, [1, 2])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.screencastFrameAck').map(call => call.params.sessionId), [92, 91])
  await targets.deactivate(targetId)
  fixture.emit(frame('session-target-1', 94))
  assert.deepEqual(frames, [1, 2])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.screencastFrameAck').map(call => call.params.sessionId), [92, 91, 93, 94])
  await targets.close()
})

test('rejects malformed or oversized frames without delivering them', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const frames: number[] = []
  targets.onFrame(value => frames.push(value.sequence))
  await targets.activate(targetId)
  fixture.emit(frame('session-target-1', 1, 'a'.repeat(6 * 1024 * 1024)))
  fixture.emit(frame('session-target-1', 2, 'bad*'))
  fixture.emit(frame('other-session', 3))
  assert.deepEqual(frames, [])
  fixture.emit(frame('session-target-1', 4))
  assert.deepEqual(frames, [1])
  await targets.close()
})

test('routes bounded input only to the focused page and its viewport', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create({ width: 800, height: 600 })
  const second = await targets.create({ width: 800, height: 600 })
  await assert.rejects(targets.input(first, { kind: 'text', text: 'x' }), /not active/)
  await targets.activate(first)
  await targets.input(first, { kind: 'mouse', type: 'mousePressed', x: 32, y: 48, button: 'left' })
  await targets.input(first, { kind: 'text', text: 'ScholarSeed' })
  await assert.rejects(targets.input(first, { kind: 'wheel', x: 800, y: 1, deltaX: 0, deltaY: 1 }), /outside/)
  await targets.activate(second)
  await assert.rejects(targets.input(first, { kind: 'text', text: 'x' }), /not active/)
  await targets.input(second, { kind: 'key', type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 })
  assert.deepEqual(fixture.calls.filter(call => call.method.startsWith('Input.')).map(call => call.sessionId), [
    'session-target-1', 'session-target-1', 'session-target-2'
  ])
  await targets.close()
})

test('IME composition updates and commits once in the active page session', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create()
  const second = await targets.create()
  await targets.activate(first)
  await targets.input(first, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await targets.input(first, { kind: 'composition', phase: 'update', text: '你好', selectionStart: 2, selectionEnd: 2 })
  await targets.input(first, { kind: 'composition', phase: 'commit', text: '你好' })
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'commit', text: '你好' }), /not active/)
  await targets.activate(second)
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 }), /not active/)
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Input.imeSetComposition' || call.method === 'Input.insertText'), [
    { method: 'Input.imeSetComposition', params: { text: 'ni', selectionStart: 2, selectionEnd: 2 }, sessionId: 'session-target-1' },
    { method: 'Input.imeSetComposition', params: { text: '你好', selectionStart: 2, selectionEnd: 2 }, sessionId: 'session-target-1' },
    { method: 'Input.insertText', params: { text: '你好' }, sessionId: 'session-target-1' }
  ])
  await targets.close()
})

test('IME cancellation removes candidate without inserting and key release survives composition', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  await targets.input(targetId, { kind: 'key', type: 'keyDown', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229 })
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await assert.rejects(targets.input(targetId, { kind: 'text', text: 'zhong' }), /composition/)
  await assert.rejects(targets.input(targetId, { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }), /composition/)
  await assert.rejects(targets.input(targetId, { kind: 'key', type: 'char', key: '中', code: 'KeyZ', windowsVirtualKeyCode: 90 }), /composition/)
  await targets.input(targetId, { kind: 'key', type: 'keyUp', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229 })
  await targets.input(targetId, { kind: 'composition', phase: 'cancel' })
  assert.deepEqual(fixture.calls.filter(call => call.method.startsWith('Input.')).map(call => [call.method, call.params]), [
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229, modifiers: 0 }],
    ['Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229, modifiers: 0 }],
    ['Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }]
  ])
  await targets.close()
})

test('IME validates page focus, composition bounds, and cancels before switching tabs', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create()
  const second = await targets.create()
  await targets.activate(first)
  fixture.pageFocused = false
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'begin', text: '你', selectionStart: 1, selectionEnd: 1 }), /focused/)
  fixture.pageFocused = true
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'update', text: '你', selectionStart: 1, selectionEnd: 1 }), /not active/)
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'begin', text: '你', selectionStart: 2, selectionEnd: 2 }), /selection/)
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'begin', text: 'x'.repeat(4097), selectionStart: 0, selectionEnd: 0 }), /composition/)
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'begin', text: 42, selectionStart: 0, selectionEnd: 0 } as unknown as Parameters<typeof targets.input>[1]), /composition/)
  await targets.input(first, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await assert.rejects(targets.input(first, { kind: 'composition', phase: 'unknown' } as unknown as Parameters<typeof targets.input>[1]), /phase/)
  await targets.activate(second)
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Input.imeSetComposition').map(call => call.params), [
    { text: 'ni', selectionStart: 2, selectionEnd: 2 },
    { text: '', selectionStart: 0, selectionEnd: 0 }
  ])
  await targets.close()
})

test('IME candidate is cancelled before navigation or clicking another focused element', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await targets.navigate(targetId, 'https://example.com/')
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'hao', selectionStart: 3, selectionEnd: 3 })
  await targets.input(targetId, { kind: 'mouse', type: 'mousePressed', x: 20, y: 20, button: 'left' })
  assert.deepEqual(fixture.calls.filter(call => ['Input.imeSetComposition', 'Page.navigate', 'Input.dispatchMouseEvent'].includes(call.method)).map(call => [call.method, call.params]), [
    ['Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }],
    ['Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['Page.navigate', { url: 'https://example.com/' }],
    ['Input.imeSetComposition', { text: 'hao', selectionStart: 3, selectionEnd: 3 }],
    ['Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 }]
  ])
  await targets.close()
})

test('main-frame navigation discards stale IME state but subframe navigation does not', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  fixture.emit({ method: 'Page.frameNavigated', sessionId: 'session-target-1', params: { frame: { id: 'child', parentId: 'root' } } })
  await targets.input(targetId, { kind: 'composition', phase: 'commit', text: '你' })
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'hao', selectionStart: 3, selectionEnd: 3 })
  fixture.emit({ method: 'Page.frameNavigated', sessionId: 'session-target-1', params: { frame: { id: 'root' } } })
  await assert.rejects(targets.input(targetId, { kind: 'composition', phase: 'commit', text: '好' }), /not active/)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'xin', selectionStart: 3, selectionEnd: 3 })
  await targets.close()
})

test('IME update and commit reject a different focused input element', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  fixture.focusedObjectId = 'focused-2'
  await assert.rejects(targets.input(targetId, { kind: 'composition', phase: 'commit', text: '你' }), /focused/)
  assert.equal(fixture.calls.filter(call => call.method === 'Input.insertText').length, 0)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'hao', selectionStart: 3, selectionEnd: 3 })
  fixture.editableFocused = false
  await assert.rejects(targets.input(targetId, { kind: 'composition', phase: 'update', text: '好', selectionStart: 1, selectionEnd: 1 }), /focused/)
  assert.equal(fixture.calls.filter(call => call.method === 'Input.imeSetComposition').length, 2)
  await targets.close()
})

test('uncertain IME commit result closes the sidecar rather than allowing a duplicate retry', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  await targets.input(targetId, { kind: 'composition', phase: 'begin', text: 'ni', selectionStart: 2, selectionEnd: 2 })
  fixture.insertTextFailuresRemaining = 1
  await assert.rejects(targets.input(targetId, { kind: 'composition', phase: 'commit', text: '你' }), /commit timeout/)
  assert.equal(fixture.pipeClosed, true)
  await assert.rejects(targets.input(targetId, { kind: 'composition', phase: 'commit', text: '你' }), /closed/)
  assert.equal(fixture.calls.filter(call => call.method === 'Input.insertText').length, 1)
  await targets.close()
})

test('switching pages releases each pressed key once using its original payload', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create()
  const second = await targets.create()
  await targets.activate(first)
  const keyDown = { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 } as const
  await targets.input(first, keyDown)
  await targets.input(first, { ...keyDown, modifiers: 0 })
  await targets.activate(second)
  await assert.rejects(targets.input(first, { kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }), /not active/)
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyUp'), [
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 }, sessionId: 'session-target-1' }
  ])
  await targets.close()
})

test('uncertain synthetic key release closes the sidecar without retrying a duplicate keyUp', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create()
  const second = await targets.create()
  await targets.activate(first)
  await targets.input(first, { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 })
  fixture.keyReleaseFailuresRemaining = 1
  await assert.rejects(targets.activate(second), /key release failed/)
  assert.equal(fixture.pipeClosed, true)
  await assert.rejects(targets.activate(second), /closed/)
  assert.equal(fixture.calls.filter(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyUp').length, 1)
  await targets.close()
})

test('concurrent activation and resizing preserve one active page and restart its stream', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const first = await targets.create({ width: 800, height: 600 })
  const second = await targets.create({ width: 800, height: 600 })
  await Promise.all([targets.activate(first), targets.activate(second)])
  await assert.rejects(targets.input(first, { kind: 'text', text: 'x' }), /not active/)
  await targets.resize(second, { width: 1024, height: 768 })
  await targets.input(second, { kind: 'text', text: 'x' })
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.startScreencast').map(call => call.sessionId), [
    'session-target-1', 'session-target-2', 'session-target-2'
  ])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.stopScreencast').map(call => call.sessionId), [
    'session-target-1', 'session-target-2'
  ])
  await targets.close()
})

test('target destruction invalidates its session and all later input', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  await targets.activate(targetId)
  fixture.emit({ method: 'Target.targetDestroyed', params: { targetId } })
  await assert.rejects(targets.input(targetId, { kind: 'text', text: 'x' }), /Unknown/)
  await targets.close()
})

test('failed close retains the target so a second close can converge', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  fixture.closeFailuresRemaining = 1
  await assert.rejects(targets.closeTarget(targetId), /close target failed/)
  await targets.navigate(targetId, 'https://example.com/')
  await targets.closeTarget(targetId)
  await assert.rejects(targets.navigate(targetId, 'https://example.com/'), /Unknown/)
  assert.equal(fixture.calls.filter(call => call.method === 'Target.closeTarget').length, 2)
  await targets.close()
})

test('target-destroyed event converges a simultaneous close-command rejection', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  fixture.destroyWhileClosing = true
  await targets.closeTarget(targetId)
  assert.equal(fixture.pipeClosed, false)
  await assert.rejects(targets.navigate(targetId, 'https://example.com/'), /Unknown/)
  await targets.close()
})

test('unexpected session detach closes its live target rather than forgetting it', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  fixture.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-target-1' } })
  await assert.rejects(targets.input(targetId, { kind: 'text', text: 'x' }), /Unknown/)
  assert.equal(fixture.pipeClosed, false)
  await targets.close()
  assert.equal(fixture.calls.filter(call => call.method === 'Target.closeTarget').length, 1)
  assert.equal(fixture.pipeClosed, true)
})

test('an unexpected detach that cannot close its target closes the isolated pipe', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  await targets.create()
  fixture.closeFailuresRemaining = 1
  fixture.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-target-1' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.pipeClosed, true)
  assert.throws(() => targets.listTargets(), /closed/)
  fixture.closeFailuresRemaining = 0
  await targets.close()
})

test('routine target destruction and unknown detach do not retain unbounded markers', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  for (let index = 0; index < 128; index++) {
    const targetId = await targets.create()
    fixture.emit({ method: 'Target.targetDestroyed', params: { targetId } })
    fixture.emit({ method: 'Target.detachedFromTarget', params: { sessionId: `unknown-${index}` } })
  }
  const markers = targets as unknown as { destroyedTargets: Set<string>; detachedSessions: Set<string> }
  assert.equal(markers.destroyedTargets.size, 0)
  assert.equal(markers.detachedSessions.size, 0)
  await targets.close()
})

test('removing the only frame consumer acknowledges pending and later frames', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const received: number[] = []
  const unsubscribe = targets.onFrame(value => received.push(value.sequence))
  await targets.activate(targetId)
  fixture.emit(frame('session-target-1', 21))
  unsubscribe()
  await new Promise(resolve => setImmediate(resolve))
  fixture.emit(frame('session-target-1', 22))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.screencastFrameAck').map(call => call.params.sessionId), [21, 22])
  targets.onFrame(value => received.push(value.sequence))
  fixture.emit(frame('session-target-1', 23))
  assert.deepEqual(received, [1, 2])
  await targets.acknowledgeFrame(targetId, 2)
  await targets.close()
})

test('failed frame acknowledgement retains the exact pending frame for retry', async () => {
  const fixture = new FixturePipe()
  const targets = manager(fixture)
  const targetId = await targets.create()
  const received: number[] = []
  targets.onFrame(value => received.push(value.sequence))
  await targets.activate(targetId)
  fixture.emit(frame('session-target-1', 31))
  fixture.ackFailuresRemaining = 1
  await assert.rejects(targets.acknowledgeFrame(targetId, 1), /frame ack failed/)
  fixture.emit(frame('session-target-1', 32))
  assert.deepEqual(received, [1])
  await targets.acknowledgeFrame(targetId, 1)
  fixture.emit(frame('session-target-1', 33))
  assert.deepEqual(received, [1, 2])
  assert.deepEqual(fixture.calls.filter(call => call.method === 'Page.screencastFrameAck').map(call => call.params.sessionId), [31, 32, 31])
  await targets.close()
})
