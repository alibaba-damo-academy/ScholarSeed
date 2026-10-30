import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { WebSocket } from 'ws'
import { ChromiumPipe, ChromiumProtocolError } from './chromium.ts'
import type { ChromiumMessage } from './chromium.ts'
import { authorizedChromiumUpgrade, createChromiumCdpRelay } from './chromiumrelay.ts'

const delayedCreationFixture = new URL('./chromium.fixture.mjs', import.meta.url)

class FixturePipe {
  private readonly events = new EventEmitter()
  private readonly closes = new EventEmitter()
  private readonly commands = new EventEmitter()
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  readonly replies: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = []
  readonly contexts = new Set<string>()
  private nextBrowserSession = 1
  attachError?: Error
  detachError?: Error
  disposeError?: Error
  closeCalls = 0

  async close(): Promise<void> { this.closeCalls += 1 }

  command(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId })
    if (method === 'Target.attachToBrowserTarget') {
      if (this.attachError) return Promise.reject(this.attachError)
      return Promise.resolve({ sessionId: `browser-${this.nextBrowserSession++}` })
    }
    if (method === 'Target.detachFromTarget') return this.detachError ? Promise.reject(this.detachError) : Promise.resolve({})
    if (method === 'Target.getBrowserContexts') return Promise.resolve({ browserContextIds: [...this.contexts] })
    if (method === 'Target.disposeBrowserContext') {
      if (this.disposeError) return Promise.reject(this.disposeError)
      this.contexts.delete(params.browserContextId as string)
      return Promise.resolve({})
    }
    if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] })
    this.commands.emit('command')
    return new Promise((resolve, reject) => { this.replies.push({ resolve, reject }) })
  }

  nextCommand(): Promise<unknown[]> { return once(this.commands, 'command') }

  onEvent(listener: (message: ChromiumMessage) => void): () => void {
    this.events.on('message', listener)
    return () => this.events.off('message', listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closes.on('close', listener)
    return () => this.closes.off('close', listener)
  }

  emitEvent(message: ChromiumMessage): void { this.events.emit('message', message) }
  exit(): void { this.closes.emit('close', new Error('exited')) }
}

async function connect(endpoint: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, options)
  await Promise.race([
    once(socket, 'open'),
    once(socket, 'error').then(([error]) => { throw error })
  ])
  return socket
}

async function rejected(endpoint: string, options?: WebSocket.ClientOptions): Promise<void> {
  const socket = new WebSocket(endpoint, options)
  await assert.rejects(once(socket, 'open'))
  socket.terminate()
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, 'message')
  return JSON.parse(data.toString()) as Record<string, unknown>
}

async function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connectTcp(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

test('upgrade requires loopback peer, exact Host, absent Origin and exact token path', () => {
  const request = {
    url: '/devtools/browser/secret',
    headers: { host: '127.0.0.1:1234' },
    socket: { remoteAddress: '127.0.0.1', localPort: 1234 }
  }
  const authorized = () => authorizedChromiumUpgrade(request as unknown as IncomingMessage, 'secret')
  assert.equal(authorized(), true)
  request.socket.remoteAddress = '192.168.1.12'
  assert.equal(authorized(), false)
  request.socket.remoteAddress = '127.0.0.1'
  request.headers.host = 'localhost:1234'
  assert.equal(authorized(), false)
  request.headers.host = '127.0.0.1:1234'
  const headers = request.headers as Record<string, string>
  headers.origin = 'https://example.com'
  assert.equal(authorized(), false)
  delete headers.origin
  request.url = '/devtools/browser/other'
  assert.equal(authorized(), false)
})

test('relay preserves browser-level CDP ids and flat sessions across concurrent replies', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const responses: Record<string, unknown>[] = []
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (typeof message.id === 'number') responses.push(message)
    })
    const firstCall = pipe.nextCommand()
    socket.send(JSON.stringify({ id: 41, method: 'Browser.getVersion' }))
    await firstCall
    pipe.emitEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'page-session' }, sessionId: 'browser-1' })
    const secondCall = pipe.nextCommand()
    socket.send(JSON.stringify({ id: 42, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'page-session' }))
    await secondCall
    assert.deepEqual(pipe.calls.filter(call => call.method !== 'Target.attachToBrowserTarget'), [
      { method: 'Browser.getVersion', params: {}, sessionId: 'browser-1' },
      { method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'page-session' }
    ])
    pipe.replies[1].resolve({ result: { value: 2 } })
    pipe.replies[0].resolve({ product: 'Chrome/149' })
    while (responses.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
    assert.deepEqual(responses, [
      { id: 42, result: { result: { value: 2 } }, sessionId: 'page-session' },
      { id: 41, result: { product: 'Chrome/149' } }
    ])
    const event = nextMessage(socket)
    pipe.emitEvent({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page' } }, sessionId: 'browser-1' })
    assert.deepEqual(await event, { method: 'Target.targetCreated', params: { targetInfo: { type: 'page' } } })
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('external CDP cannot override product download or permission settings', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    for (const method of ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior',
      'Browser.grantPermissions', 'Browser.setPermission', 'Browser.resetPermissions']) {
      const forwarded = method === 'Browser.setDownloadBehavior' ? pipe.nextCommand() : null
      const answer = nextMessage(socket)
      socket.send(JSON.stringify({ id: pipe.calls.length + 1, method,
        params: { behavior: 'allow', downloadPath: '/tmp/untrusted-browser-downloads' } }))
      if (method === 'Browser.setDownloadBehavior') {
        await forwarded
        assert.deepEqual(pipe.calls.at(-1), { method, params: { behavior: 'deny' }, sessionId: 'browser-1' })
        pipe.replies.at(-1)?.resolve({})
      } else {
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.deepEqual(pipe.calls.map(call => call.method), ['Target.attachToBrowserTarget', 'Browser.setDownloadBehavior'])
      }
      const message = await answer
      if (method === 'Browser.setDownloadBehavior') assert.deepEqual(message.result, { scholarseedDownloadPolicy: 'disabled' })
      else {
        assert.equal((message.error as { code?: number })?.code, -32000)
        assert.match((message.error as { message?: string }).message ?? '', /controlled by browser settings/i)
      }
    }
    const forwarded = pipe.nextCommand()
    const answer = nextMessage(socket)
    socket.send(JSON.stringify({ id: 42, method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allowAndName', browserContextId: 'playwright-context',
        downloadPath: '/tmp/untrusted-browser-downloads', eventsEnabled: true } }))
    await forwarded
    assert.deepEqual(pipe.calls.at(-1), { method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny', browserContextId: 'playwright-context' }, sessionId: 'browser-1' })
    pipe.replies.at(-1)?.resolve({})
    assert.deepEqual((await answer).result, { scholarseedDownloadPolicy: 'disabled' })
  } finally {
    for (const reply of pipe.replies) reply.resolve({})
    socket.terminate()
    await relay.stop()
  }
})

test('new external browser context is denied downloads before its id is returned', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const created = pipe.nextCommand()
    const answer = nextMessage(socket)
    socket.send(JSON.stringify({ id: 27, method: 'Target.createBrowserContext' }))
    await created
    pipe.contexts.add('external-context')
    pipe.replies[0].resolve({ browserContextId: 'external-context' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(pipe.calls.at(-1), { method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny', browserContextId: 'external-context' }, sessionId: 'browser-1' })
    pipe.replies[1].resolve({})
    assert.deepEqual((await answer).result, { browserContextId: 'external-context' })
  } finally {
    for (const reply of pipe.replies) reply.resolve({})
    socket.terminate()
    await relay.stop()
  }
})

test('concurrent commands cannot discover or use a context before its download policy settles', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const created = pipe.nextCommand()
    socket.send(JSON.stringify({ id: 31, method: 'Target.createBrowserContext' }))
    await created
    pipe.contexts.add('pending-context')
    const guarded = pipe.nextCommand()
    pipe.replies[0].resolve({ browserContextId: 'pending-context' })
    await guarded
    socket.send(JSON.stringify({ id: 32, method: 'Target.getBrowserContexts' }))
    socket.send(JSON.stringify({ id: 33, method: 'Target.createTarget',
      params: { url: 'about:blank', browserContextId: 'pending-context' } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(pipe.calls.map(call => call.method),
      ['Target.attachToBrowserTarget', 'Target.createBrowserContext', 'Browser.setDownloadBehavior'])
    pipe.replies[1].resolve({})
    for (let attempt = 0; attempt < 50 && !pipe.calls.some(call => call.method === 'Target.createTarget'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.ok(pipe.calls.some(call => call.method === 'Target.getBrowserContexts'))
    assert.ok(pipe.calls.some(call => call.method === 'Target.createTarget'))
    pipe.replies[2].resolve({ targetId: 'external-target' })
  } finally {
    for (const reply of pipe.replies) reply.resolve({})
    socket.terminate()
    await relay.stop()
  }
})

test('failed context download policy disposes the context instead of returning its id', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const created = pipe.nextCommand()
    const answer = nextMessage(socket)
    socket.send(JSON.stringify({ id: 28, method: 'Target.createBrowserContext' }))
    await created
    pipe.contexts.add('failed-context')
    const guarded = pipe.nextCommand()
    pipe.replies[0].resolve({ browserContextId: 'failed-context' })
    await guarded
    pipe.replies[1].reject(new Error('download policy failed'))
    const message = await answer
    assert.match((message.error as { message?: string }).message ?? '', /download policy failed/)
    assert.deepEqual(pipe.calls.filter(call => call.method === 'Target.disposeBrowserContext')
      .map(call => call.params.browserContextId), ['failed-context'])
    assert.equal(pipe.contexts.size, 0)
    assert.equal(pipe.closeCalls, 0)
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('failed context policy cleanup closes the sidecar and relay', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  pipe.disposeError = new Error('context disposal failed')
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const created = pipe.nextCommand()
    socket.send(JSON.stringify({ id: 29, method: 'Target.createBrowserContext' }))
    await created
    pipe.contexts.add('uncertain-context')
    const guarded = pipe.nextCommand()
    pipe.replies[0].resolve({ browserContextId: 'uncertain-context' })
    await guarded
    const closed = once(socket, 'close')
    pipe.replies[1].reject(new Error('download policy failed'))
    await closed
    for (let attempt = 0; attempt < 50 && pipe.closeCalls === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.equal(pipe.closeCalls, 1)
    await rejected(endpoint)
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('disconnect detaches its browser session and a reconnect receives a new isolated session', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const first = await connect(endpoint)
  try {
    const firstReady = pipe.nextCommand()
    first.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    await firstReady
    const firstResponse = nextMessage(first)
    pipe.replies[0].resolve({ product: 'fixture' })
    await firstResponse
    const closed = once(first, 'close')
    first.close()
    await closed
    const second = await connect(endpoint)
    try {
      const secondReady = pipe.nextCommand()
      second.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
      await secondReady
      const secondResponse = nextMessage(second)
      pipe.replies[1].resolve({ product: 'fixture' })
      await secondResponse
      assert.deepEqual(pipe.calls.filter(call => call.method === 'Target.attachToBrowserTarget').map(call => call.sessionId), [undefined, undefined])
      assert.deepEqual(pipe.calls.filter(call => call.method === 'Browser.getVersion').map(call => call.sessionId), ['browser-1', 'browser-2'])
      assert.deepEqual(pipe.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId), ['browser-1'])
      const events: Record<string, unknown>[] = []
      second.on('message', data => { events.push(JSON.parse(data.toString()) as Record<string, unknown>) })
      pipe.emitEvent({ method: 'Target.targetCreated', params: { targetInfo: { type: 'old' } }, sessionId: 'browser-1' })
      pipe.emitEvent({ method: 'Target.targetCreated', params: { targetInfo: { type: 'root' } } })
      pipe.emitEvent({ method: 'Target.targetCreated', params: { targetInfo: { type: 'new' } }, sessionId: 'browser-2' })
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(events, [{ method: 'Target.targetCreated', params: { targetInfo: { type: 'new' } } }])
    } finally {
      second.terminate()
    }
  } finally {
    first.terminate()
    await relay.stop()
  }
})

test('relay rejects other clients and invalid credentials, then allows reconnect after release', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const first = await connect(endpoint)
  try {
    const busy = new WebSocket(endpoint)
    busy.on('error', () => undefined)
    const [, response] = await once(busy, 'unexpected-response')
    assert.equal(response.statusCode, 503)
    assert.equal(response.headers['retry-after'], '1')
    response.destroy()
    await rejected(endpoint.replace(/.$/, '0'))
    await rejected(endpoint, { headers: { Origin: 'https://example.com' } })
    const closed = once(first, 'close')
    first.close()
    await closed
    const second = await connect(endpoint)
    second.terminate()
  } finally {
    first.terminate()
    await relay.stop()
  }
  await rejected(endpoint)
})

test('failed browser-session attachment closes the lease without an unhandled rejection', async () => {
  const pipe = new FixturePipe()
  pipe.attachError = new Error('attach denied')
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  try {
    const socket = await connect(endpoint)
    await once(socket, 'close')
    pipe.attachError = undefined
    const next = await connect(endpoint)
    next.terminate()
  } finally {
    await relay.stop()
  }
})

test('unknown session detach is rejected before reaching Chromium', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const response = nextMessage(socket)
    socket.send(JSON.stringify({ id: 1, method: 'Target.detachFromTarget', params: { sessionId: 'main-session' } }))
    const message = await response
    assert.match(String((message.error as { message: string })?.message), /session/)
    assert.equal(pipe.calls.some(call => call.method === 'Target.detachFromTarget'), false)
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('failed session cleanup closes the endpoint and prevents restart', async () => {
  const pipe = new FixturePipe()
  pipe.detachError = new Error('detach denied')
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint, port } = await relay.start()
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => { errors.push(values) }
  try {
    const socket = await connect(endpoint)
    const closed = once(socket, 'close')
    socket.terminate()
    await closed
    for (let attempt = 0; attempt < 50 && await listening(port); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(await listening(port), false)
    await rejected(endpoint)
    await assert.rejects(relay.start(), /cleanup failed/)
    assert.equal(errors[0]?.[0], '[browser-chromium-cdp] session cleanup failed')
  } finally {
    console.error = originalError
    await relay.stop()
  }
})

test('relay closes the endpoint and active client when the pipe exits', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  const closed = once(socket, 'close')
  pipe.exit()
  await closed
  await rejected(endpoint)
  await relay.stop()
})

test('relay rotates its token on restart and caps in-flight commands', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const first = await relay.start()
  await relay.stop()
  const second = await relay.start()
  assert.notEqual(first.endpoint.split('/').pop(), second.endpoint.split('/').pop())
  const socket = await connect(second.endpoint)
  try {
    const closed = once(socket, 'close')
    for (let id = 1; id <= 65; id += 1) socket.send(JSON.stringify({ id, method: 'Browser.getVersion' }))
    const [code] = await closed
    assert.equal(code, 1006)
    assert.equal(pipe.calls.filter(call => call.method === 'Browser.getVersion').length, 64)
    for (const reply of pipe.replies) reply.resolve({ product: 'fixture' })
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('pending command budget blocks reconnect until old commands settle', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const first = await connect(endpoint)
  try {
    const firstClosed = once(first, 'close')
    for (let id = 1; id <= 64; id += 1) first.send(JSON.stringify({ id, method: 'Browser.getVersion' }))
    while (pipe.calls.filter(call => call.method === 'Browser.getVersion').length < 64) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    first.terminate()
    await firstClosed
    await rejected(endpoint)
    assert.equal(pipe.calls.filter(call => call.method === 'Browser.getVersion').length, 64)
    for (const reply of pipe.replies) reply.resolve({ product: 'fixture' })
    while (!pipe.calls.some(call => call.method === 'Target.detachFromTarget')) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const third = await connect(endpoint)
    try {
      const thirdCommand = pipe.nextCommand()
      third.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
      await thirdCommand
      assert.equal(pipe.calls.filter(call => call.method === 'Browser.getVersion').length, 65)
      pipe.replies.at(-1)!.resolve({ product: 'fixture' })
    } finally {
      third.terminate()
    }
  } finally {
    first.terminate()
    await relay.stop()
  }
})

test('disconnect waits for an in-flight browser context before disposing the lease', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const first = await connect(endpoint)
  try {
    const command = pipe.nextCommand()
    first.send(JSON.stringify({ id: 1, method: 'Target.createBrowserContext' }))
    await command
    const closed = once(first, 'close')
    first.terminate()
    await closed
    await rejected(endpoint)
    pipe.contexts.add('late-context')
    const guarded = pipe.nextCommand()
    pipe.replies[0].resolve({ browserContextId: 'late-context' })
    await guarded
    assert.deepEqual(pipe.calls.at(-1), { method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny', browserContextId: 'late-context' }, sessionId: 'browser-1' })
    pipe.replies[1].resolve({})
    while (!pipe.calls.some(call => call.method === 'Target.detachFromTarget')) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.deepEqual(pipe.calls.filter(call => call.method === 'Target.disposeBrowserContext').map(call => call.params.browserContextId), ['late-context'])
    assert.equal(pipe.contexts.size, 0)
    const second = await connect(endpoint)
    second.terminate()
  } finally {
    first.terminate()
    await relay.stop()
  }
})

test('relay preserves Chromium protocol errors instead of flattening them', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const call = pipe.nextCommand()
    const response = nextMessage(socket)
    socket.send(JSON.stringify({ id: 9, method: 'Target.createTarget', params: { url: 'about:blank' } }))
    await call
    pipe.replies[0].reject(new ChromiumProtocolError('Not supported', -32601, { reason: 'fixture' }))
    assert.deepEqual(await response, { id: 9, error: { code: -32601, message: 'Not supported', data: { reason: 'fixture' } } })
    assert.equal(pipe.closeCalls, 0)
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

test('explicit Chromium context creation refusal leaves the relay usable', async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const issued = pipe.nextCommand()
    const response = nextMessage(socket)
    socket.send(JSON.stringify({ id: 1, method: 'Target.createBrowserContext' }))
    await issued
    pipe.replies[0].reject(new ChromiumProtocolError('Context denied', -32000))
    assert.deepEqual(await response, { id: 1, error: { code: -32000, message: 'Context denied' } })
    assert.equal(pipe.closeCalls, 0)
    const nextIssued = pipe.nextCommand()
    const nextResponse = nextMessage(socket)
    socket.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }))
    await nextIssued
    pipe.replies[1].resolve({ product: 'fixture' })
    assert.deepEqual(await nextResponse, { id: 2, result: { product: 'fixture' } })
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

for (const method of ['Target.createBrowserContext', 'Target.createTarget']) {
  for (const failure of ['timed out', 'transport closed']) {
    test(`${method} ${failure} closes an uncertain sidecar and rejects reconnect`, { timeout: 3000 }, async () => {
      const pipe = new FixturePipe()
      const relay = createChromiumCdpRelay(pipe)
      const { endpoint } = await relay.start()
      const socket = await connect(endpoint)
      try {
        const issued = pipe.nextCommand()
        socket.send(JSON.stringify({ id: 1, method, params: method === 'Target.createTarget' ? { url: 'about:blank' } : {} }))
        await issued
        const closed = once(socket, 'close')
        pipe.replies[0].reject(new Error(`Chromium command ${failure}`))
        await closed
        assert.equal(pipe.closeCalls, 1)
        await rejected(endpoint)
        await assert.rejects(relay.start(), /cleanup failed/)
      } finally {
        socket.terminate()
        await relay.stop()
      }
    })
  }
}

test('Target.createTarget without an identity closes the sidecar before another client can connect', { timeout: 3000 }, async () => {
  const pipe = new FixturePipe()
  const relay = createChromiumCdpRelay(pipe)
  const { endpoint } = await relay.start()
  const socket = await connect(endpoint)
  try {
    const issued = pipe.nextCommand()
    socket.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }))
    await issued
    const closed = once(socket, 'close')
    pipe.replies[0].resolve({})
    await closed
    assert.equal(pipe.closeCalls, 1)
    await rejected(endpoint)
    await assert.rejects(relay.start(), /cleanup failed/)
  } finally {
    socket.terminate()
    await relay.stop()
  }
})

for (const method of ['Target.createBrowserContext', 'Target.createTarget']) {
  test(`real ChromiumPipe ${method} timeout ignores a late success and terminates its sidecar`, { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(delayedCreationFixture), 'late-create'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    const pipe = new ChromiumPipe(child, { commandTimeoutMs: 250, exitTimeoutMs: 1000 })
    const relay = createChromiumCdpRelay(pipe)
    let activeSocket: WebSocket | undefined
    try {
      assert.match((await once(child.stderr!, 'data', { signal: AbortSignal.timeout(10_000) }))[0].toString(), /late-create-ready/)
      const { endpoint } = await relay.start()
      const socket = await connect(endpoint)
      activeSocket = socket
      const ready = nextMessage(socket)
      socket.send(JSON.stringify({ id: 0, method: 'Browser.getVersion' }))
      assert.deepEqual(await Promise.race([ready, once(socket, 'close').then(() => { throw new Error('Fixture closed before ready') })]),
        { id: 0, result: { product: 'fixture' } })
      let lateSuccessObserved = false
      const delivered = new Promise<void>((resolve, reject) => {
        child.stderr!.on('data', chunk => {
          if (chunk.toString().includes('late-create-delivered')) {
            lateSuccessObserved = true
            resolve()
          }
        })
        child.once('exit', () => reject(new Error('Fixture exited before its late success')))
      })
      const exited = once(child, 'exit')
      const closed = once(socket, 'close')
      socket.send(JSON.stringify({ id: 1, method, params: method === 'Target.createTarget' ? { url: 'about:blank' } : {} }))
      await closed
      assert.equal(lateSuccessObserved, false)
      await delivered
      const [exitCode, signal] = await exited
      assert.ok(exitCode !== null || signal !== null)
      await rejected(endpoint)
      await assert.rejects(relay.start(), /cleanup failed/)
      await assert.rejects(pipe.command('Browser.getVersion'), /closed/)
    } finally {
      activeSocket?.terminate()
      await relay.stop()
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })
}

test('real Playwright CDP reconnect leaves the Main-owned target usable', {
  skip: !existsSync(chromium.executablePath()), timeout: 60_000
}, async () => {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'scholarseed-relay-test-'))
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--use-mock-keychain', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${profileDirectory}`, 'about:blank'
  ], { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const pipe = new ChromiumPipe(child, { profileDirectory })
  const relay = createChromiumCdpRelay(pipe)
  try {
    await pipe.command('Browser.getVersion')
    const mainTarget = await pipe.command('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
    const mainSession = await pipe.command('Target.attachToTarget', { targetId: mainTarget.targetId, flatten: true }) as { sessionId: string }
    const { endpoint } = await relay.start()
    const first = await chromium.connectOverCDP(endpoint)
    const firstContext = await first.newContext()
    const firstPage = await firstContext.newPage()
    await firstPage.setContent('<button onclick="this.textContent=\'clicked\'">ready</button>')
    await firstPage.getByRole('button').click()
    assert.equal(await firstPage.getByRole('button').textContent(), 'clicked')
    await first.close()
    await pipe.command('Page.getFrameTree', {}, mainSession.sessionId)
    let second: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    for (let attempt = 0; attempt < 20 && !second; attempt += 1) {
      try { second = await chromium.connectOverCDP(endpoint) }
      catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    assert.ok(second, 'Playwright must reconnect after browser-session detach')
    const remainingContexts = await pipe.command('Target.getBrowserContexts') as { browserContextIds: string[] }
    assert.deepEqual(remainingContexts.browserContextIds, [])
    const browserCdp = await second.newBrowserCDPSession()
    await assert.rejects(browserCdp.send('Target.detachFromTarget', { sessionId: mainSession.sessionId }), /Unknown Chromium child session/)
    await pipe.command('Page.getFrameTree', {}, mainSession.sessionId)
    await browserCdp.detach()
    const secondContext = await second.newContext()
    const secondPage = await secondContext.newPage()
    await secondPage.setContent('<title>reconnected</title>')
    assert.equal(await secondPage.title(), 'reconnected')
    await second.close()
    await pipe.command('Page.getFrameTree', {}, mainSession.sessionId)
    await pipe.command('Target.closeTarget', { targetId: mainTarget.targetId })
  } finally {
    await relay.stop()
    await pipe.close()
    await rm(profileDirectory, { recursive: true, force: true })
  }
})
