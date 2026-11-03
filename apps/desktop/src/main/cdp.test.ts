import assert from 'node:assert/strict'
import test from 'node:test'
import { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { acceptCdpClient, authorizedUpgrade, createCdpBroker } from './cdp.ts'
import type { BrowserRegistry } from './browser.ts'
import { connect } from 'node:net'
import { EventEmitter, once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebContents } from 'electron'

test('upgrade requires exact loopback Host, absent Origin and secret path', () => {
  const request = { url: '/devtools/browser/secret', headers: { host: '127.0.0.1:12345' }, socket: { localPort: 12345, remoteAddress: '127.0.0.1' } } as IncomingMessage
  assert.equal(authorizedUpgrade(request, 'secret'), true)
  assert.equal(authorizedUpgrade(request, 'wrong'), false)
  request.headers.origin = 'https://evil.example'
  assert.equal(authorizedUpgrade(request, 'secret'), false)
  delete request.headers.origin
  request.headers.host = 'evil.example:12345'
  assert.equal(authorizedUpgrade(request, 'secret'), false)
})

for (const stopBeforeRetry of [false, true]) test(`failed listener initialization cleans resources and permits ${stopBeforeRetry ? 'stop before retry' : 'immediate retry'}`, async context => {
  const states: object[] = []
  const broker = createCdpBroker({} as BrowserRegistry, { publish: state => states.push(state), log() {} })
  const failure = new Error('listen failed')
  const serverClose = context.mock.method(Server.prototype, 'close')
  const socketClose = context.mock.method(WebSocketServer.prototype, 'close')
  const listen = context.mock.method(Server.prototype, 'listen', function (this: Server) {
    queueMicrotask(() => this.emit('error', failure))
    return this
  })
  await assert.rejects(broker.start(), failure)
  assert.equal(serverClose.mock.callCount(), 1)
  assert.equal(socketClose.mock.callCount(), 1)
  assert.throws(() => broker.copyEndpoint(), /cdp_disabled/)
  listen.mock.restore()
  if (stopBeforeRetry) await assert.doesNotReject(broker.stop())
  const { port } = await broker.start()
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.destroy()
  await broker.stop()
  const rejected = connect(port, '127.0.0.1')
  await assert.rejects(once(rejected, 'connect'))
  assert.deepEqual(states.at(-1), { enabled: false, port: null })
})

test('broker stays disabled until start, publishes no secret and closes listener', async () => {
  const states: object[] = []
  const broker = createCdpBroker({} as BrowserRegistry, { publish: state => states.push(state), log() {} })
  assert.deepEqual(states, [])
  assert.throws(() => broker.copyEndpoint(), /cdp_disabled/)
  const { port } = await broker.start()
  assert.deepEqual(await broker.start(), { port })
  assert.deepEqual(states, [{ enabled: true, port }])
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  assert.equal(socket.remoteAddress, '127.0.0.1')
  socket.destroy()
  await broker.stop()
  const rejected = connect(port, '127.0.0.1')
  await assert.rejects(once(rejected, 'connect'))
  assert.deepEqual(states.at(-1), { enabled: false, port: null })
})

test('late failure of an old attach cannot detach a new tab lease', async () => {
  let failOld!: (error: Error) => void
  let oldStarted!: () => void
  const started = new Promise<void>(resolve => { oldStarted = resolve })
  const oldFrameTree = new Promise<never>((_resolve, reject) => { failOld = reject })
  const createContents = (url: string, initialTree: Promise<unknown> | null): WebContents => {
    const debuggerSession = new EventEmitter() as EventEmitter & {
      attached: boolean
      attach(): void
      detach(): void
      isAttached(): boolean
      sendCommand(method: string): Promise<unknown>
    }
    debuggerSession.attached = false
    debuggerSession.attach = () => { debuggerSession.attached = true }
    debuggerSession.detach = () => { debuggerSession.attached = false }
    debuggerSession.isAttached = () => debuggerSession.attached
    debuggerSession.sendCommand = method => {
      if (method === 'Page.getFrameTree' && initialTree) { oldStarted(); return initialTree }
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'frame', loaderId: 'loader' } } })
      return Promise.resolve({ result: { value: 2 } })
    }
    return { debugger: debuggerSession, getURL: () => url, getTitle: () => url, isDestroyed: () => false } as unknown as WebContents
  }
  const oldContents = createContents('https://example.org/old', oldFrameTree)
  const newContents = createContents('https://example.org/new', null)
  let current: WebContents | null = oldContents
  const detachListeners = new Set<(tabId: string, reason: string) => void>()
  const registry = {
    externalTabIds: () => current ? ['tab'] : [],
    externalTarget: () => { if (!current) throw new Error('permission_denied'); return current },
    attachExternal: () => { if (!current) throw new Error('permission_denied'); current.debugger.attach('1.3'); return current },
    snapshot: () => ({ tabs: current ? [{ tabId: 'tab', devtoolsOpen: false, cdpStatus: 'connected' }] : [] }),
    onDebuggerDetach: (listener: (tabId: string, reason: string) => void) => {
      detachListeners.add(listener)
      return () => { detachListeners.delete(listener) }
    }
  } as unknown as BrowserRegistry
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let controller!: ReturnType<typeof acceptCdpClient>
  server.on('connection', connection => { controller = acceptCdpClient(connection, registry) })
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await once(client, 'open')
  let requestId = 0
  const command = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = ++requestId
    return new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>(resolve => {
      const receive = (data: Buffer) => {
        const message = JSON.parse(String(data))
        if (message.id !== id) return
        client.removeListener('message', receive)
        resolve(message)
      }
      client.on('message', receive)
      client.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  try {
    const first = await command('Target.getTargets')
    const oldTarget = (first.result!.targetInfos as { targetId: string }[])[0].targetId
    const pendingOld = command('Target.attachToTarget', { targetId: oldTarget, flatten: true })
    await started
    current = null
    for (const listener of detachListeners) listener('tab', 'target_closed')
    await controller.syncTargets()
    current = newContents
    await controller.syncTargets()
    const second = await command('Target.getTargets')
    const newTarget = (second.result!.targetInfos as { targetId: string }[])[0].targetId
    assert.notEqual(newTarget, oldTarget)
    const attached = await command('Target.attachToTarget', { targetId: newTarget, flatten: true })
    const newSession = attached.result!.sessionId as string
    failOld(new Error('old target failed'))
    assert.equal((await pendingOld).error?.message, 'old target failed')
    assert.equal(newContents.debugger.isAttached(), true)
    const evaluated = await command('Runtime.evaluate', { expression: '1 + 1' }, newSession)
    assert.deepEqual(evaluated.result, { result: { value: 2 } })
  } finally {
    client.close()
    await once(client, 'close')
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
