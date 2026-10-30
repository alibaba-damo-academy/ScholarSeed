import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { ChromiumProtocolError } from './chromium.ts'
import type { ChromiumMessage } from './chromium.ts'
import { authorizedDevToolsUpgrade, createChromiumDevToolsRelay } from './chromiumdevtools.ts'

class FixturePipe {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  readonly events = new EventEmitter()
  readonly closes = new EventEmitter()
  readonly pending: Array<{ resolve(value: unknown): void }> = []
  nextSession = 1
  attachResult?: unknown
  attachError?: Error
  holdAttach = false
  holdDetach = false
  closeCalls = 0
  closeError?: Error
  holdClose = false
  readonly attachReplies: Array<{ resolve(value: unknown): void }> = []

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId })
    if (method === 'Target.attachToTarget') {
      if (this.attachError) return Promise.reject(this.attachError)
      if (this.holdAttach) return new Promise(resolve => this.attachReplies.push({ resolve }))
      return Promise.resolve(this.attachResult ?? { sessionId: `page-${this.nextSession++}` })
    }
    if (method === 'Target.detachFromTarget') return this.holdDetach ? new Promise(() => undefined) : Promise.resolve({})
    return new Promise(resolve => this.pending.push({ resolve }))
  }

  onEvent(listener: (message: ChromiumMessage) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closes.on('close', listener)
    return () => this.closes.off('close', listener)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    if (this.holdClose) return new Promise(() => undefined)
    if (this.closeError) throw this.closeError
    this.closes.emit('close', new Error('pipe closed'))
  }
}

async function connect(endpoint: string, origin = 'devtools://devtools'): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, { origin })
  await Promise.race([once(socket, 'open'), once(socket, 'error').then(([error]) => { throw error })])
  return socket
}

async function reject(endpoint: string, origin = 'devtools://devtools'): Promise<void> {
  const socket = new WebSocket(endpoint, { origin })
  await assert.rejects(once(socket, 'open'))
  socket.terminate()
}

async function response(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, 'message')
  return JSON.parse(data.toString()) as Record<string, unknown>
}

test('DevTools upgrade requires exact loopback Host, token and internal Origin', () => {
  const request = { url: '/devtools/page/secret', headers: { host: '127.0.0.1:42', origin: 'devtools://devtools' }, socket: { remoteAddress: '127.0.0.1', localPort: 42 } }
  const allowed = () => authorizedDevToolsUpgrade(request as unknown as IncomingMessage, 'secret')
  assert.equal(allowed(), true)
  request.headers.origin = 'https://evil.example'
  assert.equal(allowed(), false)
  request.headers.origin = 'devtools://devtools'
  request.headers.host = 'localhost:42'
  assert.equal(allowed(), false)
  request.headers.host = '127.0.0.1:42'
  request.url = '/devtools/page/secret/other'
  assert.equal(allowed(), false)
})

test('relay binds only Main target, strips session envelope and isolates reconnect', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'main-target')
  const { endpoint } = await relay.start()
  const first = await connect(endpoint)
  await relay.waitForAttachment()
  try {
    await reject(endpoint, 'https://evil.example')
    await reject(endpoint.replace(/.$/, '0'))
    await reject(endpoint)
    const answer = response(first)
    first.send(JSON.stringify({ id: 7, method: 'DOM.getDocument' }))
    while (!pipe.pending.length) await new Promise(resolve => setTimeout(resolve, 1))
    assert.deepEqual(pipe.calls.slice(0, 2), [
      { method: 'Target.attachToTarget', params: { targetId: 'main-target', flatten: true }, sessionId: undefined },
      { method: 'DOM.getDocument', params: {}, sessionId: 'page-1' }
    ])
    pipe.pending[0].resolve({ root: { nodeName: 'HTML' } })
    assert.deepEqual(await answer, { id: 7, result: { root: { nodeName: 'HTML' } } })
    const acknowledgement = response(first)
    first.send(JSON.stringify({ id: 8, method: 'Page.screencastFrameAck', params: { sessionId: 1 } }))
    while (pipe.pending.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
    pipe.pending[1].resolve({})
    assert.deepEqual(await acknowledgement, { id: 8, result: {} })
    const event = response(first)
    pipe.events.emit('event', { method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 'page-1' })
    assert.deepEqual(await event, { method: 'Runtime.consoleAPICalled', params: { type: 'log' } })
    const closed = once(first, 'close')
    first.close()
    await closed
    const second = await connect(endpoint)
    try {
      const next = response(second)
      pipe.events.emit('event', { method: 'Network.requestWillBeSent', params: {}, sessionId: 'page-1' })
      pipe.events.emit('event', { method: 'Network.requestWillBeSent', params: {}, sessionId: 'page-2' })
      assert.deepEqual(await next, { method: 'Network.requestWillBeSent', params: {} })
      assert.deepEqual(pipe.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId), ['page-1'])
    } finally { second.terminate() }
  } finally { first.terminate(); await relay.stop() }
})

test('DevTools frontend cannot choose a browser download path', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'owned-target')
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  await relay.waitForAttachment()
  try {
    const answer = response(socket)
    socket.send(JSON.stringify({ id: 9, method: 'Page.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/tmp/untrusted-browser-downloads' } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(pipe.calls.map(call => call.method), ['Target.attachToTarget'])
    const message = await answer
    assert.equal((message.error as { code?: number })?.code, -32000)
  } finally {
    for (const reply of pipe.pending) reply.resolve({})
    socket.terminate()
    await relay.stop()
  }
})

test('known Chromium target refusal rejects readiness without killing the sidecar', async () => {
  const pipe = new FixturePipe()
  pipe.attachError = new ChromiumProtocolError('No target with given id', -32000)
  const relay = createChromiumDevToolsRelay(pipe, 'closed-target')
  const { endpoint } = await relay.start()
  const attached = relay.waitForAttachment()
  const socket = await connect(endpoint)
  await assert.rejects(attached, /No target with given id/)
  await once(socket, 'close')
  await relay.stop()
  assert.equal(pipe.closeCalls, 0)
})

test('attached frontend disconnect is reported once; relay stop is not reported as a disconnect', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'target')
  const disconnects: string[] = []
  relay.onDisconnect(error => disconnects.push(error.message))
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  await relay.waitForAttachment()
  const closed = once(socket, 'close')
  socket.terminate()
  await closed
  for (let attempt = 0; attempt < 100 && disconnects.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.deepEqual(disconnects, ['Chromium DevTools frontend disconnected'])
  await relay.stop()
  assert.deepEqual(disconnects, ['Chromium DevTools frontend disconnected'])

  const next = createChromiumDevToolsRelay(pipe, 'target')
  const intentional: string[] = []
  next.onDisconnect(error => intentional.push(error.message))
  const restarted = await next.start()
  const active = await connect(restarted.endpoint)
  await next.waitForAttachment()
  await next.stop()
  await once(active, 'close')
  assert.deepEqual(intentional, [])
})

test('client cannot select a target, session or browser-level commands', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'owned-target')
  const { endpoint } = await relay.start()
  try {
    const socket = await connect(endpoint)
    const answer = response(socket)
    socket.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }))
    assert.deepEqual(await answer, { id: 2, error: { code: -32601, message: 'Method Browser.getVersion is unavailable on a page DevTools relay' } })
    socket.terminate()
    for (const request of [
      { id: 1, method: 'Target.attachToTarget', params: { targetId: 'foreign' } },
      { id: 3, method: 'DOM.getDocument', sessionId: 'foreign-session' },
      { id: 4, method: 'Page.navigate', params: { targetId: 'foreign' } }
    ]) {
      const socket = await connect(endpoint)
      const closed = once(socket, 'close')
      socket.send(JSON.stringify(request))
      await closed
    }
    assert.equal(pipe.calls.some(call => call.params.targetId === 'foreign'), false)
  } finally { await relay.stop() }
})

test('pipe shutdown closes the relay and active frontend', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'target')
  const first = await relay.start()
  const socket = await connect(first.endpoint)
  const closed = once(socket, 'close')
  pipe.closes.emit('close', new Error('pipe closed'))
  await closed
  await reject(first.endpoint)
  await relay.stop()
})

test('relay rotates its token on restart', async () => {
  const relay = createChromiumDevToolsRelay(new FixturePipe(), 'target')
  const first = await relay.start()
  await relay.stop()
  const second = await relay.start()
  assert.notEqual(first.endpoint, second.endpoint)
  await reject(first.endpoint)
  await relay.stop()
})

test('in-flight budget disconnects the frontend before an unbounded command queue', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'bounded-target')
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const closed = once(socket, 'close')
    for (let id = 1; id <= 65; id += 1) socket.send(JSON.stringify({ id, method: 'DOM.getDocument' }))
    await closed
    assert.equal(pipe.calls.filter(call => call.method === 'DOM.getDocument').length, 64)
    for (const reply of pipe.pending) reply.resolve({})
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('unknown attachment fails closed and terminates the sidecar', async () => {
  const pipe = new FixturePipe()
  pipe.attachResult = {}
  const relay = createChromiumDevToolsRelay(pipe, 'target')
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  await once(socket, 'close')
  while (!pipe.closeCalls) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(pipe.closeCalls, 1)
  await reject(endpoint)
  await relay.stop()
})

test('attachment timeout closes the sidecar without waiting for window shutdown', async () => {
  const pipe = new FixturePipe()
  pipe.holdAttach = true
  const relay = createChromiumDevToolsRelay(pipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  await once(socket, 'close')
  assert.equal(pipe.closeCalls, 1)
  await reject(endpoint)
  await relay.stop()
})

test('hung attachment and hung command cannot make stop wait indefinitely', async () => {
  const attachPipe = new FixturePipe()
  attachPipe.holdAttach = true
  const attachRelay = createChromiumDevToolsRelay(attachPipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint: attachEndpoint } = await attachRelay.start()
  const attachSocket = await connect(attachEndpoint)
  await attachRelay.stop()
  assert.equal(attachPipe.closeCalls, 1)
  attachSocket.terminate()

  const commandPipe = new FixturePipe()
  const commandRelay = createChromiumDevToolsRelay(commandPipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint } = await commandRelay.start()
  const socket = await connect(endpoint)
  socket.send(JSON.stringify({ id: 1, method: 'DOM.getDocument' }))
  while (!commandPipe.pending.length) await new Promise(resolve => setTimeout(resolve, 1))
  await commandRelay.stop()
  assert.equal(commandPipe.closeCalls, 1)
  socket.terminate()
})

test('unconfirmed detach terminates sidecar instead of reusing the endpoint', async () => {
  const pipe = new FixturePipe()
  pipe.holdDetach = true
  const relay = createChromiumDevToolsRelay(pipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  const closed = once(socket, 'close')
  socket.close()
  await closed
  while (!pipe.closeCalls) await new Promise(resolve => setTimeout(resolve, 1))
  await reject(endpoint)
  await relay.stop()
})

test('page binding is not Cookie or local-file isolation for a trusted DevTools client', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumDevToolsRelay(pipe, 'target')
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    for (const [id, method, params] of [
      [1, 'Storage.getCookies', {}],
      [2, 'Page.navigate', { url: 'file:///etc/hosts' }]
    ] as const) {
      const answer = response(socket)
      socket.send(JSON.stringify({ id, method, params }))
      while (pipe.pending.length < id) await new Promise(resolve => setTimeout(resolve, 1))
      pipe.pending[id - 1].resolve({})
      assert.equal((await answer).id, id)
    }
    assert.deepEqual(pipe.calls.slice(1, 3).map(call => [call.method, call.sessionId]), [
      ['Storage.getCookies', 'page-1'], ['Page.navigate', 'page-1']
    ])
  } finally { socket.terminate(); await relay.stop() }
})

test('stop reports sidecar close failure and permanently rejects restart', async () => {
  const pipe = new FixturePipe()
  pipe.closeError = new Error('profile cleanup failed')
  const relay = createChromiumDevToolsRelay(pipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  socket.send(JSON.stringify({ id: 1, method: 'DOM.getDocument' }))
  while (!pipe.pending.length) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(relay.stop(), /profile cleanup failed/)
  await reject(endpoint)
  await assert.rejects(relay.start(), /cleanup failed|shutdown failed|termination unconfirmed/)
  socket.terminate()
})

test('stop reports unconfirmed process termination when sidecar close never settles', async () => {
  const pipe = new FixturePipe()
  pipe.holdClose = true
  const relay = createChromiumDevToolsRelay(pipe, 'target', { drainTimeoutMs: 20 })
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  socket.send(JSON.stringify({ id: 1, method: 'DOM.getDocument' }))
  while (!pipe.pending.length) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(relay.stop(), /termination unconfirmed/)
  await reject(endpoint)
  await assert.rejects(relay.start(), /termination unconfirmed|cleanup failed/)
  socket.terminate()
})
