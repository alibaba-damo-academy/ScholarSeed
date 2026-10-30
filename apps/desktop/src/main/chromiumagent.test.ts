import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentPage } from './agent.ts'
import { createChromiumAgentPage } from './chromiumagent.ts'
import type { ChromiumAgentPageEvent, ChromiumTargetEvent, ChromiumTargets } from './chromiumtarget.ts'

class TargetFixture {
  readonly commands: Array<{ targetId: string; method: string; params: Record<string, unknown> }> = []
  private readonly pageListeners = new Set<(event: ChromiumAgentPageEvent) => void>()
  private readonly targetListeners = new Set<(event: ChromiumTargetEvent) => void>()
  readonly sessions = new Map([['first', 'session-first'], ['second', 'session-second']])
  readonly titles = new Map([['first', 'First title'], ['second', 'Second title']])
  readonly loading = new Map([['first', false], ['second', false]])
  commandGate?: Promise<void>

  agentPageSession(targetId: string): string {
    const sessionId = this.sessions.get(targetId)
    if (!sessionId) throw new Error('Unknown Chromium page target')
    return sessionId
  }

  agentPageState(targetId: string): { loading: boolean; navigationEpoch: number; documentEpoch: number;
    mainFrameId: string | null } {
    if (!this.sessions.has(targetId)) throw new Error('Unknown Chromium page target')
    return { loading: this.loading.get(targetId) ?? true, navigationEpoch: 1, documentEpoch: 1,
      mainFrameId: 'main-frame' }
  }

  async agentCommand(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.sessions.has(targetId)) throw new Error('Unknown Chromium page target')
    this.commands.push({ targetId, method, params })
    if (this.commandGate) await this.commandGate
    return { targetId, method }
  }

  listTargets(): Array<{ targetId: string; url: string; title: string }> {
    return [...this.sessions.keys()].map(targetId => ({ targetId, url: 'https://example.org/',
      title: this.titles.get(targetId) ?? '' }))
  }

  onAgentPageEvent(listener: (event: ChromiumAgentPageEvent) => void): () => void {
    this.pageListeners.add(listener)
    return () => { this.pageListeners.delete(listener) }
  }

  onTarget(listener: (event: ChromiumTargetEvent) => void): () => void {
    this.targetListeners.add(listener)
    return () => { this.targetListeners.delete(listener) }
  }

  emitPage(targetId: string, method: string, params: Record<string, unknown> = {}): void {
    for (const listener of this.pageListeners) listener({ targetId, method, params })
  }

  emitTarget(targetId: string, kind: ChromiumTargetEvent['kind']): void {
    const info = { targetId, url: 'https://example.org/', title: this.titles.get(targetId) ?? '' }
    for (const listener of this.targetListeners) listener({ kind, info })
  }

  asTargets(): ChromiumTargets { return this as unknown as ChromiumTargets }
}

test('adapter binds one sidecar target and forwards commands only through the Agent allowlist owner', async () => {
  const targets = new TargetFixture()
  const page: AgentPage = createChromiumAgentPage(targets.asTargets(), 'first')
  const messages: Array<{ method: string; params: Record<string, unknown>; sessionId: string }> = []
  const listener = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionId: string) => {
    messages.push({ method, params, sessionId })
  }
  page.debugger.on('message', listener)
  targets.emitPage('second', 'Page.frameNavigated', { other: true })
  targets.emitPage('first', 'Page.frameNavigated', { frameId: 'main-frame' })
  assert.deepEqual(messages, [{ method: 'Page.frameNavigated', params: { frameId: 'main-frame' },
    sessionId: 'session-first' }])
  assert.deepEqual(await page.debugger.sendCommand('Page.getFrameTree', { depth: 1 }),
    { targetId: 'first', method: 'Page.getFrameTree' })
  assert.deepEqual(targets.commands, [{ targetId: 'first', method: 'Page.getFrameTree', params: { depth: 1 } }])
  page.debugger.removeListener('message', listener)
  targets.emitPage('first', 'Page.frameStartedLoading')
  assert.equal(messages.length, 1)
  assert.equal(page.debugger.isAttached(), true)
  assert.equal(page.isDestroyed(), false)
})

test('adapter reports actual target loading and title without borrowing another page', () => {
  const targets = new TargetFixture()
  const page = createChromiumAgentPage(targets.asTargets(), 'first')
  assert.equal(page.getTitle(), 'First title')
  assert.equal(page.isLoadingMainFrame(), false)
  targets.titles.set('first', 'Updated first title')
  targets.titles.set('second', 'Updated second title')
  targets.loading.set('first', true)
  targets.emitTarget('first', 'updated')
  assert.equal(page.getTitle(), 'Updated first title')
  assert.equal(page.isLoadingMainFrame(), true)
  page.dispose()
})

test('detach and same target ID with a replacement session fail closed exactly once', async () => {
  const targets = new TargetFixture()
  const page = createChromiumAgentPage(targets.asTargets(), 'first')
  const reasons: string[] = []
  const listener = (_event: Electron.Event, reason: string) => { reasons.push(reason) }
  page.debugger.on('detach', listener)
  targets.sessions.set('first', 'replacement-session')
  assert.equal(page.debugger.isAttached(), false)
  assert.equal(page.isDestroyed(), true)
  await assert.rejects(page.debugger.sendCommand('Page.getFrameTree'), /detached|changed/i)
  targets.emitPage('first', 'Page.frameNavigated')
  targets.emitTarget('first', 'destroyed')
  assert.equal(reasons.length, 1)
  assert.equal(targets.commands.length, 0)
  page.debugger.removeListener('detach', listener)
  page.dispose()
})

test('explicit target detach and dispose stop events and later commands', async () => {
  const targets = new TargetFixture()
  const page = createChromiumAgentPage(targets.asTargets(), 'first')
  let messages = 0
  let detaches = 0
  page.debugger.on('message', () => { messages++ })
  page.debugger.on('detach', () => { detaches++ })
  targets.emitTarget('first', 'detached')
  targets.emitPage('first', 'Network.requestWillBeSent')
  assert.equal(messages, 0)
  assert.equal(detaches, 1)
  assert.equal(page.debugger.isAttached(), false)
  await assert.rejects(page.debugger.sendCommand('DOM.getDocument'), /detached/i)
  page.dispose()
  assert.equal(detaches, 1)
})

test('in-flight command rejects when its bound session is replaced', async () => {
  const targets = new TargetFixture()
  let releaseCommand: (() => void) | undefined
  targets.commandGate = new Promise(resolve => { releaseCommand = resolve })
  const page = createChromiumAgentPage(targets.asTargets(), 'first')
  const command = page.debugger.sendCommand('Page.getFrameTree')
  targets.sessions.set('first', 'replacement-session')
  releaseCommand?.()
  await assert.rejects(command, /changed/i)
  assert.equal(page.isDestroyed(), true)
  assert.deepEqual(targets.commands.map(value => value.targetId), ['first'])
  page.dispose()
})
