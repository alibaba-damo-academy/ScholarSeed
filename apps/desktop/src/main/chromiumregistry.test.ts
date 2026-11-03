import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChromiumTargetEvent, ChromiumTargetInfo } from './chromiumtarget.ts'
import { createChromiumBrowserRegistry } from './chromiumregistry.ts'
import type { ChromiumHistoryEvent } from './chromiumregistry.ts'

class Targets {
  readonly calls: string[] = []
  readonly pages = new Map<string, ChromiumTargetInfo>()
  private readonly listeners = new Set<(event: ChromiumTargetEvent) => void>()
  closeError = false
  destroyDuringCreate = false
  waitForActivation: Promise<void> | null = null
  activateError = false
  waitForHistory: Promise<void> | null = null
  waitForDiscover: Promise<void> | null = null
  navigationLoader: string | null = 'loader-1'
  navigationError: Error | null = null
  historyError: Error | null = null
  requireActiveHistory = false
  requireCommittedHistory = false
  activeTargetId: string | null = null
  readonly pendingNavigations = new Set<string>()
  readonly historyByTarget = new Map<string, { canGoBack: boolean; canGoForward: boolean }>()
  onNavigate?: (targetId: string, url: string) => void
  nextTarget = 1
  onTarget(listener: (event: ChromiumTargetEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  listTargets(): ChromiumTargetInfo[] {
    return [...this.pages.values()]
  }
  async discover(): Promise<void> {
    this.calls.push('discover')
    await this.waitForDiscover
  }
  emit(
    kind: ChromiumTargetEvent['kind'],
    info: ChromiumTargetInfo,
    metadata: {
      loaderId?: string
      frameId?: string
      status?: number
      navigationType?: ChromiumTargetEvent['navigationType']
      documentEpoch?: number
    } = {}
  ): void {
    if (kind === 'navigated' || kind === 'same-document' || kind === 'destroyed')
      this.pendingNavigations.delete(info.targetId)
    if (kind === 'destroyed') this.pages.delete(info.targetId)
    else this.pages.set(info.targetId, info)
    for (const listener of this.listeners) listener({ kind, info, ...metadata })
  }
  async create(): Promise<string> {
    const targetId = `target-${this.nextTarget++}`
    this.emit('created', { targetId, url: 'about:blank', title: '' })
    if (this.destroyDuringCreate) this.emit('destroyed', this.pages.get(targetId)!)
    return targetId
  }
  async activate(targetId: string): Promise<void> {
    this.calls.push(`activate:${targetId}`)
    await this.waitForActivation
    if (this.activateError) throw new Error('activate failed')
    this.activeTargetId = targetId
  }
  async deactivate(targetId: string): Promise<void> {
    this.calls.push(`deactivate:${targetId}`)
    if (this.activeTargetId === targetId) this.activeTargetId = null
  }
  async navigate(
    targetId: string,
    url: string
  ): Promise<{ frameId: string; loaderId: string | null }> {
    this.calls.push(`navigate:${targetId}:${url}`)
    if (this.requireCommittedHistory) this.pendingNavigations.add(targetId)
    this.onNavigate?.(targetId, url)
    if (this.navigationError) throw this.navigationError
    return { frameId: 'main-frame', loaderId: this.navigationLoader }
  }
  async navigationState(targetId: string): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    this.calls.push(`history:${targetId}`)
    if (this.requireActiveHistory && this.activeTargetId !== targetId)
      throw new Error('Not attached to an active page')
    if (this.requireCommittedHistory && this.pendingNavigations.has(targetId))
      throw new Error('Not attached to an active page')
    if (this.historyError) throw this.historyError
    await this.waitForHistory
    return this.historyByTarget.get(targetId) ?? { canGoBack: true, canGoForward: false }
  }
  async goBack(targetId: string): Promise<void> {
    this.calls.push(`back:${targetId}`)
    if (this.requireActiveHistory && this.activeTargetId !== targetId)
      throw new Error('Not attached to an active page')
    if (this.requireCommittedHistory) this.pendingNavigations.add(targetId)
  }
  async goForward(targetId: string): Promise<void> {
    this.calls.push(`forward:${targetId}`)
    if (this.requireActiveHistory && this.activeTargetId !== targetId)
      throw new Error('Not attached to an active page')
    if (this.requireCommittedHistory) this.pendingNavigations.add(targetId)
  }
  async reload(targetId: string): Promise<void> {
    this.calls.push(`reload:${targetId}`)
    if (this.requireActiveHistory && this.activeTargetId !== targetId)
      throw new Error('Not attached to an active page')
    if (this.requireCommittedHistory) this.pendingNavigations.add(targetId)
  }
  async closeTarget(targetId: string): Promise<void> {
    this.calls.push(`close:${targetId}`)
    if (this.closeError) throw new Error('close failed')
    this.emit('destroyed', this.pages.get(targetId)!)
  }
  async close(): Promise<void> {
    this.calls.push('close-all')
    this.pages.clear()
  }
  async abort(): Promise<void> {
    this.calls.push('abort-all')
    this.pages.clear()
  }
}

class Inspector {
  readonly calls: string[] = []
  waitForOpen: Promise<void> | null = null
  async open(targetId: string): Promise<void> {
    this.calls.push(`open:${targetId}`)
    await this.waitForOpen
  }
  async close(targetId: string): Promise<void> {
    this.calls.push(`close:${targetId}`)
  }
  async targetDestroyed(targetId: string): Promise<void> {
    this.calls.push(`destroyed:${targetId}`)
  }
}

test('history is queried only after activation and inactive external tabs refresh when selected', async () => {
  const targets = new Targets()
  targets.requireActiveHistory = true
  targets.pages.set('external-a', { targetId: 'external-a', url: 'https://a.example/', title: 'A' })
  targets.pages.set('external-b', { targetId: 'external-b', url: 'https://b.example/', title: 'B' })
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    await registry.initialize()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const tabs = registry.snapshot().tabs
    const first = tabs.find((tab) => tab.url === 'https://a.example/')!
    const second = tabs.find((tab) => tab.url === 'https://b.example/')!
    assert.equal(first.canGoBack, true)
    assert.equal(second.canGoBack, false)
    assert.equal(targets.calls.includes('history:external-b'), false)
    assert.ok(
      targets.calls.indexOf('activate:external-a') < targets.calls.indexOf('history:external-a')
    )
    await registry.dispatch({ kind: 'select', tabId: second.tabId })
    assert.equal(
      registry.snapshot().tabs.find((tab) => tab.tabId === second.tabId)?.canGoBack,
      true
    )
    assert.ok(
      targets.calls.indexOf('activate:external-b') < targets.calls.indexOf('history:external-b')
    )
    assert.equal(errors.length, 0)
  } finally {
    console.error = originalError
    await registry.dispose()
  }
})

test('active external commits refresh history while an old inactive result cannot overwrite state', async () => {
  const targets = new Targets()
  targets.requireActiveHistory = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  const second = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'select', tabId: first })
  targets.historyByTarget.set('target-1', { canGoBack: false, canGoForward: true })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://a.example/', title: '' },
    { loaderId: 'external-loader', frameId: 'main-frame' }
  )
  targets.emit(
    'ready',
    { targetId: 'target-1', url: 'https://a.example/', title: '' },
    { loaderId: 'external-loader', frameId: 'main-frame' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(registry.snapshot().tabs.find((tab) => tab.tabId === first)?.canGoForward, true)
  let release: () => void = () => undefined
  targets.waitForHistory = new Promise<void>((resolve) => {
    release = resolve
  })
  targets.historyByTarget.set('target-1', { canGoBack: false, canGoForward: false })
  targets.emit('updated', { targetId: 'target-1', url: 'https://a.example/', title: 'A' })
  const selection = registry.dispatch({ kind: 'select', tabId: second })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(registry.active()?.tabId, second)
  release()
  await selection
  assert.equal(registry.snapshot().tabs.find((tab) => tab.tabId === first)?.canGoForward, true)
  assert.equal(registry.snapshot().tabs.find((tab) => tab.tabId === second)?.canGoBack, true)
})

test('back forward and reload activate their target tab before issuing commands', async () => {
  const targets = new Targets()
  targets.requireActiveHistory = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  const second = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'back', tabId: first })
  assert.equal(registry.snapshot().activeTabId, first)
  assert.equal(targets.activeTargetId, 'target-1')
  await registry.dispatch({ kind: 'forward', tabId: second })
  assert.equal(registry.snapshot().activeTabId, second)
  assert.equal(targets.activeTargetId, 'target-2')
  await registry.dispatch({ kind: 'reload', tabId: first })
  assert.equal(registry.snapshot().activeTabId, first)
  assert.equal(targets.activeTargetId, 'target-1')
})

test('navigation receipt does not query history before the main-frame commit', async () => {
  const targets = new Targets()
  targets.requireActiveHistory = true
  targets.requireCommittedHistory = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    await registry.initialize()
    await registry.dispatch({ kind: 'open' })
    const tabId = registry.snapshot().activeTabId!
    const before = targets.calls.filter((call) => call === 'history:target-1').length
    await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/#frag' })
    assert.equal(registry.snapshot().tabs.at(-1)?.loading, true)
    assert.equal(registry.snapshot().tabs.at(-1)?.canGoBack, false)
    assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
    targets.emit(
      'navigated',
      { targetId: 'target-1', url: 'https://example.com/#frag', title: '' },
      { loaderId: 'loader-1', frameId: 'main-frame' }
    )
    targets.emit(
      'ready',
      { targetId: 'target-1', url: 'https://example.com/#frag', title: '' },
      { loaderId: 'loader-1', frameId: 'main-frame' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(registry.snapshot().tabs.at(-1)?.loading, false)
    assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
    assert.equal(errors.length, 0)
  } finally {
    console.error = originalError
    await registry.dispose()
  }
})

test('history commands query navigation state after commit, including external navigation', async () => {
  const targets = new Targets()
  targets.requireActiveHistory = true
  targets.requireCommittedHistory = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    await registry.initialize()
    await registry.dispatch({ kind: 'open' })
    const tabId = registry.snapshot().activeTabId!
    for (const kind of ['back', 'forward', 'reload'] as const) {
      const before = targets.calls.filter((call) => call === 'history:target-1').length
      await registry.dispatch({ kind, tabId })
      assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
      targets.historyByTarget.set('target-1', { canGoBack: true, canGoForward: kind === 'back' })
      targets.emit(
        'navigated',
        { targetId: 'target-1', url: `https://example.com/${kind}`, title: '' },
        { loaderId: `loader-${kind}`, frameId: 'main-frame' }
      )
      targets.emit(
        'ready',
        { targetId: 'target-1', url: `https://example.com/${kind}`, title: '' },
        { loaderId: `loader-${kind}`, frameId: 'main-frame' }
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
      assert.equal(registry.snapshot().tabs[0].canGoForward, kind === 'back')
    }
    const beforeExternal = targets.calls.filter((call) => call === 'history:target-1').length
    targets.emit(
      'navigated',
      { targetId: 'target-1', url: 'https://example.com/external', title: '' },
      { loaderId: 'loader-external', frameId: 'main-frame' }
    )
    targets.emit(
      'ready',
      { targetId: 'target-1', url: 'https://example.com/external', title: '' },
      { loaderId: 'loader-external', frameId: 'main-frame' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      targets.calls.filter((call) => call === 'history:target-1').length,
      beforeExternal + 1
    )
    assert.equal(errors.length, 0)
  } finally {
    console.error = originalError
    await registry.dispose()
  }
})

test('provisional target metadata never changes committed URL or queries history', async () => {
  const targets = new Targets()
  targets.requireCommittedHistory = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    await registry.initialize()
    await registry.dispatch({ kind: 'open' })
    const tabId = registry.snapshot().activeTabId!
    const historyCount = (): number =>
      targets.calls.filter((call) => call === 'history:target-1').length

    const initialHistory = historyCount()
    await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/local' })
    targets.emit('updated', {
      targetId: 'target-1',
      url: 'https://example.com/local',
      title: 'Provisional',
    })
    assert.equal(historyCount(), initialHistory)
    assert.equal(registry.snapshot().tabs[0].title, '')
    targets.emit(
      'navigated',
      { targetId: 'target-1', url: 'https://example.com/local', title: 'Committed' },
      { loaderId: 'loader-1', frameId: 'main-frame' }
    )
    targets.emit(
      'ready',
      { targetId: 'target-1', url: 'https://example.com/local', title: 'Committed' },
      { loaderId: 'loader-1', frameId: 'main-frame' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(historyCount(), initialHistory + 1)

    const externalHistory = historyCount()
    targets.pendingNavigations.add('target-1')
    targets.emit('updated', {
      targetId: 'target-1',
      url: 'https://example.com/external',
      title: 'External provisional',
    })
    assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/local')
    assert.equal(historyCount(), externalHistory)
    targets.emit(
      'navigated',
      { targetId: 'target-1', url: 'https://example.com/external', title: 'External committed' },
      { loaderId: 'external-loader', frameId: 'main-frame' }
    )
    targets.emit(
      'ready',
      { targetId: 'target-1', url: 'https://example.com/external', title: 'External committed' },
      { loaderId: 'external-loader', frameId: 'main-frame' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/external')
    assert.equal(historyCount(), externalHistory + 1)

    const backHistory = historyCount()
    await registry.dispatch({ kind: 'back', tabId })
    targets.emit('updated', {
      targetId: 'target-1',
      url: 'https://example.com/local',
      title: 'Back provisional',
    })
    assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/external')
    assert.equal(historyCount(), backHistory)
    targets.emit(
      'navigated',
      { targetId: 'target-1', url: 'https://example.com/local', title: 'Back committed' },
      { loaderId: 'back-loader', frameId: 'main-frame' }
    )
    targets.emit(
      'ready',
      { targetId: 'target-1', url: 'https://example.com/local', title: 'Back committed' },
      { loaderId: 'back-loader', frameId: 'main-frame' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/local')
    assert.equal(historyCount(), backHistory + 1)
    assert.equal(errors.length, 0)
  } finally {
    console.error = originalError
    await registry.dispose()
  }
})

test('cross-document history waits for matching main-frame readiness and ignores old loaders', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/one', title: '' },
    { loaderId: 'loader-one', frameId: 'main-frame' }
  )
  assert.equal(registry.snapshot().tabs[0].canGoBack, false)
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/two', title: '' },
    { loaderId: 'loader-two', frameId: 'main-frame' }
  )
  targets.emit(
    'ready',
    { targetId: 'target-1', url: 'https://example.com/one', title: '' },
    { loaderId: 'loader-one', frameId: 'main-frame' }
  )
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
  targets.emit(
    'ready',
    { targetId: 'target-1', url: 'https://example.com/two', title: '' },
    { loaderId: 'loader-two', frameId: 'main-frame' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  assert.equal(registry.snapshot().tabs[0].canGoBack, true)
  await registry.dispose()
})

test('early readiness is cached and missing readiness or failed history fails closed', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const info = { targetId: 'target-1', url: 'https://example.com/early', title: '' }
  targets.emit('ready', info, { loaderId: 'early-loader', frameId: 'main-frame', documentEpoch: 1 })
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit('navigated', info, {
    loaderId: 'early-loader',
    frameId: 'main-frame',
    documentEpoch: 1,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  targets.emit(
    'navigated',
    { ...info, url: 'https://example.com/missing' },
    { loaderId: 'missing-loader', frameId: 'main-frame' }
  )
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))

  const failing = new Targets()
  const failingRegistry = createChromiumBrowserRegistry(failing as never, new Inspector() as never)
  await failingRegistry.initialize()
  await failingRegistry.dispatch({ kind: 'open' })
  failing.emit('navigated', info, { loaderId: 'error-loader', frameId: 'main-frame' })
  failing.historyError = new Error('Not attached to an active page')
  failing.emit('ready', info, { loaderId: 'error-loader', frameId: 'main-frame' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(failingRegistry.snapshot().tabs, [])
  assert.ok(failing.calls.includes('abort-all'))
})

test('main-frame commit without loader identity cannot leave stale history controls', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { frameId: 'main-frame' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
})

test('BFCache back and forward restore history immediately and record prior successful visits', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  const visits: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => {
    if (event.kind === 'visit') visits.push(event)
  })
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = { targetId: 'target-1', url: 'https://example.com/a', title: 'A' }
  const second = { targetId: 'target-1', url: 'https://example.com/b', title: 'B' }
  targets.emit('response', first, { frameId: 'main-frame', loaderId: 'loader-a', status: 200 })
  targets.emit('navigated', first, {
    frameId: 'main-frame',
    loaderId: 'loader-a',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'loader-a' })
  targets.emit('response', second, { frameId: 'main-frame', loaderId: 'loader-b', status: 200 })
  targets.emit('navigated', second, {
    frameId: 'main-frame',
    loaderId: 'loader-b',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'loader-a' })
  targets.emit('ready', second, { frameId: 'main-frame', loaderId: 'loader-b' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const beforeBack = targets.calls.filter((call) => call === 'history:target-1').length
  targets.historyByTarget.set('target-1', { canGoBack: true, canGoForward: true })
  targets.emit('navigated', first, {
    frameId: 'main-frame',
    loaderId: 'loader-a',
    navigationType: 'BackForwardCacheRestore',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, beforeBack + 1)
  assert.equal(registry.snapshot().tabs[0].canGoForward, true)
  targets.historyByTarget.set('target-1', { canGoBack: true, canGoForward: false })
  targets.emit('navigated', second, {
    frameId: 'main-frame',
    loaderId: 'loader-b',
    navigationType: 'BackForwardCacheRestore',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  assert.equal(registry.snapshot().tabs[0].canGoBack, true)
  assert.equal(registry.snapshot().tabs[0].canGoForward, false)
  assert.deepEqual(
    visits.map((event) => event.url),
    [first.url, second.url, first.url, second.url]
  )
  assert.equal(targets.calls.includes('abort-all'), false)
  await registry.dispose()
})

test('BFCache restore of a failed or unknown response never invents a history visit', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const visits: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => {
    if (event.kind === 'visit') visits.push(event)
  })
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const failed = { targetId: 'target-1', url: 'https://example.com/missing', title: '' }
  targets.emit('response', failed, { frameId: 'main-frame', loaderId: 'loader-404', status: 404 })
  targets.emit('navigated', failed, {
    frameId: 'main-frame',
    loaderId: 'loader-404',
    navigationType: 'Navigation',
  })
  targets.emit('ready', failed, { frameId: 'main-frame', loaderId: 'loader-404' })
  targets.emit(
    'navigated',
    { ...failed, url: 'https://example.com/unknown' },
    { frameId: 'main-frame', loaderId: 'loader-unknown', navigationType: 'Navigation' }
  )
  targets.emit('ready', failed, { frameId: 'main-frame', loaderId: 'loader-unknown' })
  targets.emit('navigated', failed, {
    frameId: 'main-frame',
    loaderId: 'loader-404',
    navigationType: 'BackForwardCacheRestore',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(visits, [])
  assert.equal(targets.calls.includes('abort-all'), false)
  await registry.dispose()
})

test('BFCache restore records the current pushState URL using its successful document identity', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const visits: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => {
    if (event.kind === 'visit') visits.push(event)
  })
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const original = { targetId: 'target-1', url: 'https://example.com/a', title: '' }
  const changed = { ...original, url: 'https://example.com/changed#section' }
  const second = { ...original, url: 'https://example.com/b' }
  targets.emit('response', original, { frameId: 'main-frame', loaderId: 'loader-a', status: 200 })
  targets.emit('navigated', original, {
    frameId: 'main-frame',
    loaderId: 'loader-a',
    navigationType: 'Navigation',
  })
  targets.emit('ready', original, { frameId: 'main-frame', loaderId: 'loader-a' })
  targets.emit('same-document', changed, { frameId: 'main-frame' })
  targets.emit('response', second, { frameId: 'main-frame', loaderId: 'loader-b', status: 200 })
  targets.emit('navigated', second, {
    frameId: 'main-frame',
    loaderId: 'loader-b',
    navigationType: 'Navigation',
  })
  targets.emit('ready', second, { frameId: 'main-frame', loaderId: 'loader-b' })
  targets.emit('navigated', changed, {
    frameId: 'main-frame',
    loaderId: 'loader-a',
    navigationType: 'BackForwardCacheRestore',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(
    visits.map((event) => event.url),
    [original.url, changed.url, second.url, changed.url]
  )
  await registry.dispose()
})

test('a reused loader identity with a new document cannot inherit an old successful status', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const visits: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => {
    if (event.kind === 'visit') visits.push(event)
  })
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const original = { targetId: 'target-1', url: 'https://example.com/a', title: '' }
  const other = { ...original, url: 'https://example.com/other' }
  targets.emit('response', original, {
    frameId: 'main-frame',
    loaderId: 'same-loader',
    status: 200,
  })
  targets.emit('navigated', original, {
    frameId: 'main-frame',
    loaderId: 'same-loader',
    navigationType: 'Navigation',
  })
  targets.emit('ready', original, { frameId: 'main-frame', loaderId: 'same-loader' })
  targets.emit('navigated', other, {
    frameId: 'main-frame',
    loaderId: 'same-loader',
    navigationType: 'Navigation',
  })
  targets.emit('response', other, { frameId: 'main-frame', loaderId: 'same-loader', status: 404 })
  targets.emit('navigated', other, {
    frameId: 'main-frame',
    loaderId: 'same-loader',
    navigationType: 'BackForwardCacheRestore',
  })
  assert.deepEqual(
    visits.map((event) => event.url),
    [original.url]
  )
  await registry.dispose()
})

test('normal commit with a reused loader and new URL waits for fresh readiness', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = { targetId: 'target-1', url: 'https://example.com/first', title: '' }
  const middle = { ...first, url: 'https://example.com/middle' }
  const last = { ...first, url: 'https://example.com/last' }
  targets.emit('navigated', first, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'reused' })
  targets.emit('navigated', middle, {
    frameId: 'main-frame',
    loaderId: 'middle-loader',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'reused' })
  targets.emit('ready', middle, { frameId: 'main-frame', loaderId: 'middle-loader' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit('navigated', last, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
  })
  assert.equal(registry.snapshot().tabs[0].url, last.url)
  assert.equal(registry.snapshot().tabs[0].canGoBack, false)
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
  targets.emit('ready', last, { frameId: 'main-frame', loaderId: 'reused' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  assert.equal(registry.snapshot().tabs[0].canGoBack, true)
  await registry.dispose()
})

test('reused loader with only stale readiness times out instead of retaining old buttons', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = { targetId: 'target-1', url: 'https://example.com/first', title: '' }
  const middle = { ...first, url: 'https://example.com/middle' }
  const last = { ...first, url: 'https://example.com/last' }
  targets.emit('navigated', first, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'reused' })
  targets.emit('navigated', middle, {
    frameId: 'main-frame',
    loaderId: 'middle-loader',
    navigationType: 'Navigation',
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'reused' })
  targets.emit('ready', middle, { frameId: 'main-frame', loaderId: 'middle-loader' })
  targets.emit('navigated', last, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
})

test('projected old ready with the new URL cannot settle a newer document epoch', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = { targetId: 'target-1', url: 'https://example.com/a', title: '' }
  const second = { ...first, url: 'https://example.com/b' }
  targets.emit('navigated', first, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
    documentEpoch: 1,
  })
  targets.emit('ready', first, { frameId: 'main-frame', loaderId: 'reused', documentEpoch: 1 })
  targets.emit('navigated', second, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
    documentEpoch: 2,
  })
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit('ready', second, { frameId: 'main-frame', loaderId: 'reused', documentEpoch: 1 })
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
  targets.emit('ready', second, { frameId: 'main-frame', loaderId: 'reused', documentEpoch: 2 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  await registry.dispose()
})

test('same loader and URL with a new document epoch still resets history controls', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const info = { targetId: 'target-1', url: 'https://example.com/same', title: '' }
  targets.emit('navigated', info, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
    documentEpoch: 1,
  })
  targets.emit('ready', info, { frameId: 'main-frame', loaderId: 'reused', documentEpoch: 1 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit('navigated', info, {
    frameId: 'main-frame',
    loaderId: 'reused',
    navigationType: 'Navigation',
    documentEpoch: 2,
  })
  assert.equal(registry.snapshot().tabs[0].canGoBack, false)
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before)
  targets.emit('ready', info, { frameId: 'main-frame', loaderId: 'reused', documentEpoch: 2 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  await registry.dispose()
})

test('early ready with provisional old URL matches only its frame loader and document epoch', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { historyReadyTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const oldInfo = { targetId: 'target-1', url: 'about:blank', title: '' }
  const committed = { targetId: 'target-1', url: 'https://example.com/new', title: '' }
  const before = targets.calls.filter((call) => call === 'history:target-1').length
  targets.emit('ready', oldInfo, {
    frameId: 'main-frame',
    loaderId: 'loader-new',
    documentEpoch: 1,
  })
  targets.emit('navigated', committed, {
    frameId: 'main-frame',
    loaderId: 'loader-new',
    documentEpoch: 1,
    navigationType: 'Navigation',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(targets.calls.filter((call) => call === 'history:target-1').length, before + 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(registry.snapshot().tabs[0].url, committed.url)
  assert.equal(targets.calls.includes('abort-all'), false)
  await registry.dispose()
})

test('uncertain BFCache history query fails closed instead of retaining disabled controls', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  targets.historyError = new Error('Not attached to an active page')
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/cached', title: '' },
    { frameId: 'main-frame', loaderId: 'prior-loader', navigationType: 'BackForwardCacheRestore' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
})

test('committed top-level visits and title changes expose one history stream', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'example.com' })
  assert.deepEqual(events, [])
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  targets.emit('updated', { targetId: 'target-1', url: 'https://example.com/', title: 'Example' })
  targets.emit('updated', { targetId: 'target-1', url: 'https://example.com/', title: 'Example' })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: 'Example' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: 'Reloaded' },
    { loaderId: 'loader-2', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://example.com/', title: 'Reloaded' },
    { loaderId: 'loader-2', frameId: 'main-frame', status: 200 }
  )
  assert.deepEqual(events, [
    { kind: 'visit', tabId, visitSequence: 1, url: 'https://example.com/', title: '' },
    { kind: 'title', tabId, visitSequence: 1, url: 'https://example.com/', title: 'Example' },
    { kind: 'visit', tabId, visitSequence: 2, url: 'https://example.com/', title: 'Reloaded' },
  ])
})

test('external destruction and commanded close each end the tab history stream once', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  targets.emit('created', { targetId: 'external', url: 'about:blank', title: '' })
  const externalTabId = registry.snapshot().tabs[0].tabId
  targets.emit('destroyed', { targetId: 'external', url: 'about:blank', title: '' })
  targets.emit('destroyed', { targetId: 'external', url: 'about:blank', title: '' })
  await registry.dispatch({ kind: 'open' })
  const localTabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'close', tabId: localTabId })
  assert.deepEqual(
    events.filter((event) => event.kind === 'closed').map((event) => event.tabId),
    [externalTabId, localTabId]
  )
  await registry.dispose()
})

test('history listener failure closes the sidecar rather than continuing without persistence', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  registry.onHistoryEvent((event) => {
    if (event.kind === 'visit') throw new Error('history storage failed')
  })
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  targets.emit(
    'same-document',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { frameId: 'main-frame' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
})

test('external loaded target waits for response status before recording a later loader', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  targets.emit(
    'created',
    { targetId: 'external', url: 'https://external.example/', title: 'Loaded' },
    { loaderId: 'existing-loader', frameId: 'main-frame' }
  )
  const tabId = registry.snapshot().tabs[0].tabId
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://external.example/', title: 'Loaded' },
    { loaderId: 'existing-loader', frameId: 'main-frame' }
  )
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://external.example/', title: 'Loaded' },
    { loaderId: 'new-loader', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'external', url: 'https://external.example/', title: 'Loaded' },
    { loaderId: 'new-loader', frameId: 'main-frame', status: 200 }
  )
  assert.deepEqual(events, [
    { kind: 'visit', tabId, visitSequence: 1, url: 'https://external.example/', title: 'Loaded' },
  ])
})

test('external target without a frame-tree identity waits for a committed main-frame event', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  targets.emit('created', {
    targetId: 'external',
    url: 'https://external.example/',
    title: 'Provisional',
  })
  targets.emit('updated', {
    targetId: 'external',
    url: 'https://external.example/',
    title: 'Updated',
  })
  assert.equal(events.length, 0)
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://external.example/', title: 'Committed' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'external', url: 'https://external.example/', title: 'Committed' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'visit')
})

test('history stream excludes non-HTTP pages and uncertain navigation, and unsubscribes', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  const unsubscribe = registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  targets.emit('created', { targetId: 'external', url: 'about:blank', title: '' })
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'file:///tmp/private.html', title: 'Private' },
    { loaderId: 'file-loader', frameId: 'main-frame' }
  )
  assert.equal(events.length, 0)
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://external.example/', title: 'External' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'external', url: 'https://external.example/', title: 'External' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'about:blank', title: '' },
    { loaderId: 'loader-2', frameId: 'main-frame' }
  )
  targets.emit('updated', { targetId: 'external', url: 'about:blank', title: 'Blank title' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'visit')
  unsubscribe()
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://after.example/', title: '' },
    { loaderId: 'loader-3', frameId: 'main-frame' }
  )
  assert.equal(events.length, 1)
  await registry.dispose()
  targets.emit(
    'navigated',
    { targetId: 'external', url: 'https://late.example/', title: '' },
    { loaderId: 'loader-4', frameId: 'main-frame' }
  )
  assert.equal(events.length, 1)
})

test('back, forward, and same-document main-frame commits each publish a distinct visit', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'back', tabId })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/one', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://example.com/one', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  await registry.dispatch({ kind: 'forward', tabId })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/two', title: '' },
    { loaderId: 'loader-2', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://example.com/two', title: '' },
    { loaderId: 'loader-2', frameId: 'main-frame', status: 200 }
  )
  targets.emit(
    'same-document',
    { targetId: 'target-1', url: 'https://example.com/two#section', title: '' },
    { frameId: 'main-frame' }
  )
  assert.deepEqual(
    events.map((event) => [event.kind, event.visitSequence, event.url]),
    [
      ['visit', 1, 'https://example.com/one'],
      ['visit', 2, 'https://example.com/two'],
      ['visit', 3, 'https://example.com/two#section'],
    ]
  )
})

test('two same-document commits to the same URL remain two visits', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  const info = { targetId: 'target-1', url: 'https://example.com/#same', title: '' }
  targets.emit(
    'navigated',
    { ...info, url: 'https://example.com/' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit(
    'response',
    { ...info, url: 'https://example.com/' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  targets.emit('same-document', info, { frameId: 'main-frame' })
  targets.emit('same-document', info, { frameId: 'main-frame' })
  assert.deepEqual(
    events.map((event) => [event.kind, event.tabId, event.visitSequence, event.url]),
    [
      ['visit', tabId, 1, 'https://example.com/'],
      ['visit', tabId, 2, 'https://example.com/#same'],
      ['visit', tabId, 3, 'https://example.com/#same'],
    ]
  )
})

test('cross-document visit waits for matching successful main-document status', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const info = { targetId: 'target-1', url: 'https://example.com/', title: '' }
  targets.emit('navigated', info, { loaderId: 'loader-1', frameId: 'main-frame' })
  assert.equal(events.length, 0)
  targets.emit('response', info, { loaderId: 'wrong-loader', frameId: 'main-frame', status: 200 })
  assert.equal(events.length, 0)
  targets.emit('response', info, { loaderId: 'loader-1', frameId: 'main-frame', status: 404 })
  assert.equal(events.length, 0)
  targets.emit('response', info, { loaderId: 'loader-2', frameId: 'main-frame', status: 200 })
  targets.emit('navigated', info, { loaderId: 'loader-2', frameId: 'main-frame' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'visit')
})

test('title received before document status belongs to the eventual visit', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const info = { targetId: 'target-1', url: 'https://example.com/', title: '' }
  targets.emit('navigated', info, { loaderId: 'loader-1', frameId: 'main-frame' })
  targets.emit('updated', { ...info, title: 'Ready' })
  targets.emit('response', info, { loaderId: 'loader-1', frameId: 'main-frame', status: 200 })
  assert.deepEqual(
    events.map((event) => [event.kind, event.title]),
    [['visit', 'Ready']]
  )
})

test('cached final response records and redirected failed final response does not', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const cached = { targetId: 'target-1', url: 'https://example.com/cached', title: '' }
  targets.emit('response', cached, {
    loaderId: 'cached-loader',
    frameId: 'main-frame',
    status: 200,
  })
  targets.emit('navigated', cached, { loaderId: 'cached-loader', frameId: 'main-frame' })
  const failed = { targetId: 'target-1', url: 'https://example.com/final', title: '' }
  targets.emit(
    'response',
    { ...failed, url: 'https://example.com/redirect' },
    { loaderId: 'redirect-loader', frameId: 'main-frame', status: 302 }
  )
  targets.emit('response', failed, {
    loaderId: 'redirect-loader',
    frameId: 'main-frame',
    status: 500,
  })
  targets.emit('navigated', failed, { loaderId: 'redirect-loader', frameId: 'main-frame' })
  assert.deepEqual(
    events.map((event) => event.url),
    ['https://example.com/cached']
  )
})

test('first cross-document fragment visit keeps the fragment but matches fragmentless response', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const events: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => events.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://a.example/#x' })
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://redirect.example/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 302 }
  )
  targets.emit(
    'response',
    { targetId: 'target-1', url: 'https://a.example/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame', status: 200 }
  )
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://a.example/#x', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  targets.emit('updated', { targetId: 'target-1', url: 'https://a.example/#x', title: 'A' })
  assert.equal(registry.snapshot().tabs[0].url, 'https://a.example/#x')
  assert.deepEqual(
    events.map((event) => event.url),
    ['https://a.example/#x', 'https://a.example/#x']
  )
  assert.deepEqual(
    events.map((event) => [event.kind, event.title]),
    [
      ['visit', ''],
      ['title', 'A'],
    ]
  )
})

test('external page creation and destruction use the same stable tab registry as local open', async () => {
  const targets = new Targets()
  const inspector = new Inspector()
  const registry = createChromiumBrowserRegistry(targets as never, inspector as never)
  await registry.initialize()
  targets.emit('created', { targetId: 'external', url: 'https://example.org/', title: 'External' })
  const external = registry.snapshot().tabs[0]
  assert.equal(external.url, 'https://example.org/')
  assert.equal(registry.snapshot().engine, 'chromium-sidecar')
  assert.equal(registry.target(external.tabId), 'external')
  targets.emit('updated', {
    targetId: 'external',
    url: 'https://example.org/next',
    title: 'Updated',
  })
  assert.equal(registry.snapshot().tabs[0].tabId, external.tabId)
  assert.equal(registry.snapshot().tabs[0].url, 'https://example.org/')
  await registry.dispatch({ kind: 'open' })
  assert.equal(registry.snapshot().tabs.length, 2)
  assert.equal(new Set(registry.snapshot().tabs.map((tab) => tab.tabId)).size, 2)
  targets.emit('destroyed', {
    targetId: 'external',
    url: 'https://example.org/',
    title: 'External',
  })
  assert.equal(registry.snapshot().tabs.length, 1)
  assert.equal(registry.snapshot().tabs[0].url, 'about:blank')
  assert.equal(registry.active()?.targetId, 'target-1')
})

test('selection, bare-domain navigation, history and DevTools remain on one target', async () => {
  const targets = new Targets()
  const inspector = new Inspector()
  const registry = createChromiumBrowserRegistry(targets as never, inspector as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  const second = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'select', tabId: first })
  await registry.dispatch({ kind: 'navigate', tabId: first, input: 'example.com' })
  assert.equal(
    registry.snapshot().tabs.find((tab) => tab.tabId === first)?.url,
    'https://example.com/'
  )
  await registry.dispatch({ kind: 'back', tabId: first })
  await registry.dispatch({ kind: 'forward', tabId: first })
  await registry.dispatch({ kind: 'reload', tabId: first })
  await registry.dispatch({ kind: 'devtools', tabId: first, open: true })
  assert.ok(targets.calls.includes('navigate:target-1:https://example.com/'))
  assert.ok(targets.calls.includes('back:target-1'))
  assert.ok(targets.calls.includes('forward:target-1'))
  assert.ok(targets.calls.includes('reload:target-1'))
  assert.deepEqual(inspector.calls, ['open:target-1'])
  assert.equal(registry.snapshot().tabs.find((tab) => tab.tabId === first)?.devtoolsOpen, true)
  assert.equal(registry.target(second), 'target-2')
  assert.ok(targets.calls.includes('activate:target-1'))
})

test('closing failure fails closed rather than leaving a hidden live page', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  targets.closeError = true
  await assert.rejects(
    registry.dispatch({ kind: 'close', tabId: registry.snapshot().activeTabId! }),
    /close failed/
  )
  assert.ok(targets.calls.includes('close-all'))
  assert.deepEqual(registry.snapshot().tabs, [])
})

test('closing the active page selects the remaining registered page before returning', async () => {
  const registry = createChromiumBrowserRegistry(new Targets() as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  const second = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'close', tabId: second })
  assert.equal(registry.snapshot().activeTabId, first)
})

test('target destroyed before create resolves fails closed rather than materializing a ghost tab', async () => {
  const targets = new Targets()
  targets.destroyDuringCreate = true
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await assert.rejects(registry.dispatch({ kind: 'open' }), /not registered/)
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('close-all'))
})

test('active mapping is withheld while switching targets', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  let release: () => void = () => undefined
  targets.waitForActivation = new Promise<void>((resolve) => {
    release = resolve
  })
  const selection = registry.dispatch({ kind: 'select', tabId: first })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(registry.active(), null)
  release()
  await selection
  assert.equal(registry.active()?.targetId, 'target-1')
})

test('navigation loading settles only when the same page commits', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'example.com' })
  assert.equal(registry.snapshot().tabs[0].loading, true)
  targets.emit('updated', { targetId: 'target-1', url: 'about:blank', title: 'Old title' })
  assert.equal(registry.snapshot().tabs[0].loading, true)
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: 'Example' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  assert.equal(registry.snapshot().tabs[0].loading, false)
})

test('failed target switch closes the sidecar instead of leaving uncertain active ownership', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  targets.activateError = true
  await assert.rejects(registry.dispatch({ kind: 'select', tabId: first }), /activate failed/)
  assert.ok(targets.calls.includes('close-all'))
  assert.deepEqual(registry.snapshot().tabs, [])
})

test('dispose suppresses in-flight activation and history snapshots', async () => {
  const targets = new Targets()
  const snapshots: Array<{ activeTabId: string | null; tabs: unknown[] }> = []
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    (snapshot) => snapshots.push(snapshot)
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const first = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'open' })
  let release: () => void = () => undefined
  targets.waitForActivation = new Promise<void>((resolve) => {
    release = resolve
  })
  const selection = registry.dispatch({ kind: 'select', tabId: first })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const disposal = registry.dispose()
  const disposalSnapshotIndex = snapshots.length
  release()
  await Promise.allSettled([selection, disposal])
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.equal(snapshots.at(-1)?.activeTabId, null)
  assert.equal(snapshots.at(-1)?.tabs.length, 0)
  assert.ok(
    snapshots.slice(disposalSnapshotIndex).every((snapshot) => snapshot.activeTabId === null)
  )
})

test('dispose suppresses a delayed navigation-state refresh', async () => {
  const targets = new Targets()
  const snapshots: Array<{ tabs: Array<{ canGoBack: boolean }> }> = []
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    (snapshot) => snapshots.push(snapshot)
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  let release: () => void = () => undefined
  targets.waitForHistory = new Promise<void>((resolve) => {
    release = resolve
  })
  targets.emit('updated', { targetId: 'target-1', url: 'about:blank', title: 'Changed' })
  const disposal = registry.dispose()
  const disposalSnapshotIndex = snapshots.length
  release()
  await disposal
  assert.ok(
    snapshots
      .slice(disposalSnapshotIndex)
      .every((snapshot) => snapshot.tabs.every((tab) => !tab.canGoBack))
  )
})

test('late prior-loader commit cannot settle a newer navigation', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/old' })
  targets.navigationLoader = 'loader-2'
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/new' })
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/old', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  assert.equal(registry.snapshot().tabs[0].loading, true)
  assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/new')
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/new', title: '' },
    { loaderId: 'loader-2', frameId: 'main-frame' }
  )
  assert.equal(registry.snapshot().tabs[0].loading, false)
})

test('same-document and early commit events settle only their matching navigation', async () => {
  const targets = new Targets()
  targets.navigationLoader = null
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  targets.onNavigate = (targetId, url) =>
    targets.emit('same-document', { targetId, url, title: '' }, { frameId: 'main-frame' })
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/#section' })
  assert.equal(registry.snapshot().tabs[0].loading, false)
  assert.equal(registry.snapshot().tabs[0].url, 'https://example.com/#section')
})

test('navigation without a matching commit times out and closes the sidecar', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { navigationTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'example.com' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  assert.deepEqual(registry.snapshot().tabs, [])
})

test('a later timeout never restores an earlier uncommitted URL', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { navigationTimeoutMs: 20 }
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/first' })
  targets.navigationLoader = 'loader-2'
  await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.com/second' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.ok(targets.calls.includes('abort-all'))
})

test('rejected navigation with an uncertain commit closes the sidecar', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const historyEvents: ChromiumHistoryEvent[] = []
  registry.onHistoryEvent((event) => historyEvents.push(event))
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  const tabId = registry.snapshot().activeTabId!
  targets.navigationError = new Error('protocol timeout')
  targets.onNavigate = (targetId, url) =>
    targets.emit(
      'navigated',
      { targetId, url, title: '' },
      { loaderId: 'loader-1', frameId: 'main-frame' }
    )
  await assert.rejects(
    registry.dispatch({ kind: 'navigate', tabId, input: 'example.com' }),
    /protocol timeout/
  )
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.deepEqual(historyEvents, [])
  assert.ok(targets.calls.includes('abort-all'))
  targets.emit(
    'navigated',
    { targetId: 'target-1', url: 'https://example.com/', title: '' },
    { loaderId: 'loader-1', frameId: 'main-frame' }
  )
  assert.deepEqual(registry.snapshot().tabs, [])
  assert.deepEqual(historyEvents, [])
})

test('ordinary navigation timeout does not report a shutdown failure', async () => {
  const targets = new Targets()
  const registry = createChromiumBrowserRegistry(
    targets as never,
    new Inspector() as never,
    () => undefined,
    { navigationTimeoutMs: 20 }
  )
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    await registry.initialize()
    await registry.dispatch({ kind: 'open' })
    await registry.dispatch({
      kind: 'navigate',
      tabId: registry.snapshot().activeTabId!,
      input: 'example.com',
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(
      errors.filter((args) => args[0] === '[browser-sidecar] navigation timeout shutdown failed')
        .length,
      0
    )
  } finally {
    console.error = originalError
  }
})

test('dispose during DevTools open cannot publish an open snapshot', async () => {
  const targets = new Targets()
  const inspector = new Inspector()
  const snapshots: Array<{ tabs: Array<{ devtoolsOpen: boolean }> }> = []
  const registry = createChromiumBrowserRegistry(targets as never, inspector as never, (snapshot) =>
    snapshots.push(snapshot)
  )
  await registry.initialize()
  await registry.dispatch({ kind: 'open' })
  let release: () => void = () => undefined
  inspector.waitForOpen = new Promise<void>((resolve) => {
    release = resolve
  })
  const opening = registry.dispatch({
    kind: 'devtools',
    tabId: registry.snapshot().activeTabId!,
    open: true,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const disposal = registry.dispose()
  const snapshotIndex = snapshots.length
  release()
  await Promise.allSettled([opening, disposal])
  assert.ok(
    snapshots
      .slice(snapshotIndex)
      .every((snapshot) => snapshot.tabs.every((tab) => !tab.devtoolsOpen))
  )
})

test('dispose racing discovery cannot repopulate the closed registry', async () => {
  const targets = new Targets()
  let release: () => void = () => undefined
  targets.waitForDiscover = new Promise<void>((resolve) => {
    release = resolve
  })
  const registry = createChromiumBrowserRegistry(targets as never, new Inspector() as never)
  const initialization = registry.initialize()
  const disposal = registry.dispose()
  targets.pages.set('external', { targetId: 'external', url: 'https://example.org/', title: '' })
  release()
  await Promise.allSettled([initialization, disposal])
  assert.deepEqual(registry.snapshot().tabs, [])
  await assert.rejects(registry.dispatch({ kind: 'open' }), /unavailable/)
})
