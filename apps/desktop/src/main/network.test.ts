import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { BROWSER_PROXY_ERROR_HEADER, connectPinned, createBrowserNetwork, publicBrowserAddress, resolveBrowserDestinations } from './network.ts'

test('pinned CONNECT races all validated candidates and retains the first winner', { timeout: 2000 }, async () => {
  const sockets: Socket[] = []
  const attempts: string[] = []
  const summaries: string[] = []
  const addresses = [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }, { address: '9.9.9.9', family: 4 }]
  const winner = await connectPinned(443, addresses, 1, (stage, code) => summaries.push(`${stage}:${code}`),
    new AbortController().signal, { staggerMs: 10, budgetMs: 1000, dial: (socket, address) => {
      sockets.push(socket)
      attempts.push(address.address)
      if (address.address === '8.8.8.8') setTimeout(() => socket.emit('connect'), 5)
    } })
  assert.equal(winner, sockets[1])
  assert.deepEqual(attempts, ['1.1.1.1', '8.8.8.8'])
  assert.equal(sockets[0].destroyed, true)
  assert.equal(winner.destroyed, false)
  sockets[0].emit('error', Object.assign(new Error('late loser failure'), { code: 'ECONNRESET' }))
  await delay(30)
  assert.equal(attempts.length, 2)
  assert.equal(JSON.parse(summaries[0].slice('connect_attempts:'.length)).result, 'connected')
  winner.destroy()
})

test('pinned CONNECT continues after earlier failures and closes without a winner when all fail', { timeout: 2000 }, async () => {
  const addresses = [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }, { address: '9.9.9.9', family: 4 }]
  const attempted: string[] = []
  const summaries: string[] = []
  await assert.rejects(connectPinned(443, addresses, 4, (stage, code) => summaries.push(`${stage}:${code}`),
    new AbortController().signal, { staggerMs: 5, budgetMs: 200, dial: (socket, address) => {
      attempted.push(address.address)
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))
    } }), /refused/)
  assert.deepEqual(attempted, addresses.map(address => address.address))
  const summary = JSON.parse(summaries[0].slice('connect_attempts:'.length))
  assert.equal(summary.result, 'error')
  assert.equal(summary.attemptCount, 3)
  assert.equal(summary.code, 'ECONNREFUSED')
  assert.ok(summary.events.every((event: { index: number }) => event.index >= 0 && event.index < 3))
  assert.doesNotMatch(summaries[0], /1\.1\.1\.1|8\.8\.8\.8|9\.9\.9\.9/)
})

test('pinned CONNECT cancellation and deadline close every in-flight socket', { timeout: 2000 }, async () => {
  const addresses = [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }]
  const controller = new AbortController()
  const cancelledSockets: Socket[] = []
  const cancelled = connectPinned(443, addresses, 2, () => undefined, controller.signal,
    { staggerMs: 5, budgetMs: 200, dial: socket => { cancelledSockets.push(socket) } })
  await delay(20)
  controller.abort()
  await assert.rejects(cancelled, /abort/i)
  assert.equal(cancelledSockets.length, 2)
  assert.ok(cancelledSockets.every(socket => socket.destroyed))

  const timedSockets: Socket[] = []
  const summaries: string[] = []
  await assert.rejects(connectPinned(443, addresses, 3, (stage, code) => summaries.push(`${stage}:${code}`),
    new AbortController().signal, { staggerMs: 5, budgetMs: 25, dial: socket => { timedSockets.push(socket) } }), /timed out/i)
  assert.equal(timedSockets.length, 2)
  assert.ok(timedSockets.every(socket => socket.destroyed))
  assert.equal(JSON.parse(summaries[0].slice('connect_attempts:'.length)).result, 'timeout')
})

test('connection policy rejects non-global addresses including IPv6 transition networks', () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '2002:7f00:1::1', '2001::1']) {
    assert.equal(publicBrowserAddress(address), false, address)
  }
  for (const address of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicBrowserAddress(address), true, address)
  assert.equal(publicBrowserAddress('::ffff:8.8.8.8'), true)
  assert.equal(publicBrowserAddress('::ffff:192.0.2.1'), false)
  assert.equal(publicBrowserAddress('::ffff:808:808'), true)
  assert.equal(publicBrowserAddress('::ffff:7f00:1'), false)
  assert.equal(publicBrowserAddress('::ffff:c000:201'), false)
})

test('DNS answers are checked on every connection and the returned address is pinned', async () => {
  const destination = new URL('https://rebind.example/')
  let lookups = 0
  const lookup = async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
  assert.equal((await resolveBrowserDestinations(destination, null, lookup))[0].address, '93.184.216.34')
  await assert.rejects(resolveBrowserDestinations(destination, null, lookup), /permission_denied/)
  await assert.rejects(resolveBrowserDestinations(destination, null, async () => [
    { address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }
  ]), /permission_denied/)
  const dualStack = [{ address: '104.20.23.154', family: 4 }, { address: '2606:4700:10::6814:179a', family: 6 }]
  assert.deepEqual(await resolveBrowserDestinations(destination, null, async () => dualStack), dualStack)
  await assert.rejects(resolveBrowserDestinations(destination, null, async () => [
    ...dualStack, { address: 'fc00::1', family: 6 }
  ]), /permission_denied/)
  assert.deepEqual(await resolveBrowserDestinations(destination, null, async () => [
    { address: '::ffff:8.8.8.8', family: 6 }
  ]), [{ address: '8.8.8.8', family: 4 }])
  await assert.rejects(resolveBrowserDestinations(destination, null, async () => [
    { address: '::ffff:127.0.0.1', family: 6 }
  ]), /permission_denied/)
  await assert.rejects(resolveBrowserDestinations(destination, null, async () => [
    { address: '::ffff:8.8.8.8', family: 4 }
  ]), /permission_denied/)
  await assert.rejects(resolveBrowserDestinations(destination, null, async () => [
    { address: '::ffff:8.8.8.8', family: 6 }, { address: '::ffff:7f00:1', family: 6 }
  ]), /permission_denied/)
})

test('private exceptions match exact current origin rather than hostname or port alone', async () => {
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  assert.equal((await resolveBrowserDestinations(new URL('http://localhost:8100/a'), 'http://localhost:8100', lookup))[0].address, '127.0.0.1')
  for (const url of ['http://localhost:8101/', 'https://localhost:8100/', 'http://other.example:8100/']) {
    await assert.rejects(resolveBrowserDestinations(new URL(url), 'http://localhost:8100', lookup), /permission_denied/)
  }
  await assert.rejects(resolveBrowserDestinations(new URL('http://localhost:8100/'), 'http://localhost:8100',
    async () => [{ address: '169.254.169.254', family: 4 }]), /permission_denied/)
  await assert.rejects(resolveBrowserDestinations(new URL('http://api.example:8100/'), 'http://api.example:8100',
    async () => [{ address: '169.254.169.254', family: 4 }]), /permission_denied/)
})

test('HTTP, WebSocket and CONNECT fall back among prevalidated pinned addresses', async () => {
  const fixture = createServer((_incoming, response) => response.end('fixture'))
  fixture.on('upgrade', (_incoming, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'))
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const hostname = 'localhost'
  const destinations = [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }]
  const resolver = async () => destinations
  const httpOrigin = `http://${hostname}:${address.port}`
  const httpsOrigin = `https://${hostname}:${address.port}`
  assert.deepEqual(await resolveBrowserDestinations(new URL(httpOrigin), httpOrigin, resolver), destinations)
  const httpEvents: string[] = []
  const httpBoundary = await createBrowserNetwork(() => httpOrigin, 'origin',
    (stage, code) => httpEvents.push(`${stage}:${code}`), resolver)
  const connectionEvents: string[] = []
  const tunnelBoundary = await createBrowserNetwork(() => httpsOrigin, 'origin',
    (stage, code) => connectionEvents.push(`${stage}:${code}`), resolver)
  const send = (port: number, authorization: string, path: string, headers: Record<string, string>, method = 'GET') => new Promise<number>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers: { ...headers, 'Proxy-Authorization': authorization } })
    outgoing.on('response', response => { response.resume(); resolve(response.statusCode!) })
    outgoing.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    outgoing.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    outgoing.on('error', reject)
    outgoing.end()
  })
  try {
    assert.equal(await send(httpBoundary.port, httpBoundary.authorization, httpOrigin, {}), 200)
    assert.equal(await send(httpBoundary.port, httpBoundary.authorization, httpOrigin,
      { Connection: 'Upgrade', Upgrade: 'websocket' }), 101)
    const httpSummaries = httpEvents.filter(event => event.startsWith('connect_attempts:'))
      .map(event => JSON.parse(event.slice('connect_attempts:'.length)))
    assert.equal(httpSummaries.length, 2)
    for (const summary of httpSummaries) {
      assert.deepEqual(summary.resolved, { ipv4: 2, ipv6: 0 })
      assert.equal(summary.result, 'connected')
      assert.equal(summary.remoteFamily, 4)
      assert.ok(summary.events.some((event: { type: string; index: number }) => event.type === 'attempt' && event.index === 1))
    }
    assert.doesNotMatch(httpEvents.join('\n'), /localhost|127\.0\.0\.|browser|Basic /)
    assert.equal(await send(tunnelBoundary.port, tunnelBoundary.authorization, `${hostname}:${address.port}`, {}, 'CONNECT'), 200)
    assert.ok(connectionEvents.includes('connect_established:IPv4'))
    const summaries = connectionEvents.filter(event => event.startsWith('connect_attempts:'))
    assert.equal(summaries.length, 1)
    const summary = JSON.parse(summaries[0].slice('connect_attempts:'.length))
    assert.deepEqual(summary.resolved, { ipv4: 2, ipv6: 0 })
    assert.equal(summary.result, 'connected')
    assert.equal(summary.remoteFamily, 4)
    assert.ok(summary.attemptCount >= 1)
    assert.ok(summary.elapsedMs >= 0)
    assert.ok(summary.events.some((event: { type: string; index: number; family: number }) =>
      event.type === 'attempt' && event.index === 0 && event.family === 4))
    assert.doesNotMatch(summaries[0], /localhost|127\.0\.0\.|browser|Basic /)
  } finally {
    await Promise.all([httpBoundary.close(), tunnelBoundary.close()])
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})

test('a failed pinned CONNECT closes promptly and a later DNS answer can recover', { timeout: 5000 }, async () => {
  const fixture = createTcpServer(socket => socket.end())
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const hostname = 'localhost'
  const origin = `https://${hostname}:${address.port}`
  let recovered = false
  const errors: string[] = []
  const boundary = await createBrowserNetwork(() => origin, 'origin', (stage, code) => errors.push(`${stage}:${code}`),
    async () => recovered
      ? [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]
      : [{ address: '::1', family: 6 }])
  const send = () => new Promise<'failed' | 'connected'>(resolve => {
    const outgoing = request({ hostname: '127.0.0.1', port: boundary.port, path: `${hostname}:${address.port}`,
      method: 'CONNECT', headers: { 'Proxy-Authorization': boundary.authorization } })
    outgoing.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode === 200 ? 'connected' : 'failed') })
    outgoing.on('response', response => { response.resume(); resolve('failed') })
    outgoing.on('error', () => resolve('failed'))
    outgoing.on('close', () => resolve('failed'))
    outgoing.end()
  })
  try {
    assert.equal(await send(), 'failed')
    assert.ok(errors.some(error => error.startsWith('connect_error:')))
    recovered = true
    assert.equal(await send(), 'connected')
    const summaries = errors.filter(event => event.startsWith('connect_attempts:'))
      .map(event => JSON.parse(event.slice('connect_attempts:'.length)))
    assert.equal(summaries.length, 2)
    assert.notEqual(summaries[0].id, summaries[1].id)
    assert.deepEqual(summaries.map(summary => summary.resolved), [
      { ipv4: 0, ipv6: 1 }, { ipv4: 1, ipv6: 1 }
    ])
    assert.equal(summaries[0].result, 'error')
    assert.match(summaries[0].code, /^[A-Z][A-Z_0-9]{0,31}$/)
    assert.equal(summaries[1].result, 'connected')
    assert.equal(summaries[1].remoteFamily, 4)
    assert.ok(summaries.every(summary => summary.events.length <= 32))
    assert.doesNotMatch(errors.filter(event => event.startsWith('connect_attempts:')).join('\n'), /localhost|127\.0\.0\.|::1|Basic /)
  } finally {
    await boundary.close()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})

test('proxy policy errors have single-use markers while opaque HTTPS upstream headers cannot forge them', async () => {
  const fixture = createTcpServer(socket => {
    socket.once('data', () => socket.end(`HTTP/1.1 403 Forbidden\r\n${BROWSER_PROXY_ERROR_HEADER}: permission_denied\r\nContent-Length: 0\r\n\r\n`))
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `https://127.0.0.1:${address.port}`
  const boundary = await createBrowserNetwork(() => origin, 'origin')
  try {
    const denied = await new Promise<string>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: boundary.port,
        path: 'http://127.0.0.1:1/', headers: { 'Proxy-Authorization': boundary.authorization } })
      outgoing.on('response', response => {
        response.resume()
        resolve(String(response.headers[BROWSER_PROXY_ERROR_HEADER] ?? ''))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    assert.ok(denied && denied !== 'permission_denied')
    assert.equal(boundary.consumeProxyError(denied), 'permission_denied')
    assert.equal(boundary.consumeProxyError(denied), null)
    assert.equal(boundary.consumeProxyError('permission_denied'), null)
    const forged = await new Promise<string>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: boundary.port,
        path: `127.0.0.1:${address.port}`, method: 'CONNECT', headers: { 'Proxy-Authorization': boundary.authorization } })
      outgoing.on('connect', (response, socket) => {
        if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT ${response.statusCode}`)); return }
        socket.once('data', chunk => { socket.destroy(); resolve(chunk.toString()) })
        socket.write('GET / HTTP/1.1\r\nHost: fixture\r\n\r\n')
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    assert.match(forged, /x-scholarseed-proxy-error: permission_denied/i)
    assert.equal(boundary.consumeProxyError('permission_denied'), null)
  } finally {
    await boundary.close()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})

test('real HTTP and CONNECT reject unauthenticated and private destinations without contacting the fixture', async () => {
  let hits = 0
  const fixture = createServer((_incoming, response) => { hits += 1; response.end('fixture') })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let apiOrigin: string | null = null
  const boundary = await createBrowserNetwork(() => apiOrigin, 'origin')
  const send = (path: string, authenticated = true, method = 'GET') => new Promise<number>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: boundary.port, path, method,
      headers: authenticated ? { 'Proxy-Authorization': boundary.authorization } : {} })
    outgoing.on('response', response => { response.resume(); resolve(response.statusCode!) })
    outgoing.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    outgoing.on('error', reject)
    outgoing.end()
  })
  try {
    assert.equal(await send(origin, false), 407)
    assert.equal(await send(origin), 403)
    assert.equal(await send(`127.0.0.1:${address.port}`, true, 'CONNECT'), 403)
    assert.equal(await send(`http://localhost:${address.port}`), 403)
    assert.equal(hits, 0)
    apiOrigin = origin
    assert.equal(await send(`${origin}/allowed`), 200)
    assert.equal(hits, 1)
    apiOrigin = null
    assert.equal(await send(`${origin}/revoked`), 403)
    assert.equal(hits, 1)
  } finally {
    await boundary.close()
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})

test('WebSocket upgrade uses the same authenticated and pinned private-network policy', async () => {
  let upgrades = 0
  const fixture = createServer()
  fixture.on('upgrade', (_incoming, socket) => {
    upgrades += 1
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let apiOrigin: string | null = null
  const boundary = await createBrowserNetwork(() => apiOrigin, 'origin')
  const upgrade = () => new Promise<number>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: boundary.port, path: origin,
      headers: { 'Proxy-Authorization': boundary.authorization, Connection: 'Upgrade', Upgrade: 'websocket' } })
    outgoing.on('response', response => { response.resume(); resolve(response.statusCode!) })
    outgoing.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    outgoing.on('error', reject)
    outgoing.end()
  })
  try {
    assert.equal(await upgrade(), 403)
    assert.equal(upgrades, 0)
    apiOrigin = origin
    assert.equal(await upgrade(), 101)
    assert.equal(upgrades, 1)
  } finally {
    await boundary.close()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})

test('public proxy never inherits a local-origin exception from its caller', async () => {
  const boundary = await createBrowserNetwork(() => 'https://127.0.0.1:8100')
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: boundary.port, method: 'CONNECT', path: '127.0.0.1:8100',
        headers: { 'Proxy-Authorization': boundary.authorization } })
      outgoing.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
      outgoing.on('error', reject)
      outgoing.end()
    })
    assert.equal(status, 403)
  } finally { await boundary.close() }
})

test('an upstream response interrupted after headers aborts only its downstream request', { timeout: 5000 }, async context => {
  const fixture = createServer((_incoming, response) => {
    response.writeHead(200, { 'Content-Length': '100' })
    response.write('partial')
    setTimeout(() => response.socket?.destroy(), 30)
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const boundary = await createBrowserNetwork(() => origin, 'origin')
  context.after(async () => {
    await boundary.close()
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  })
  const outcome = await new Promise<string>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: boundary.port, path: origin,
      headers: { 'Proxy-Authorization': boundary.authorization } }, response => {
      response.resume()
      response.on('end', () => resolve('complete'))
      response.on('aborted', () => resolve('aborted'))
      response.on('error', () => resolve('aborted'))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
  assert.equal(outcome, 'aborted')
})

test('established SSE, WebSocket and CONNECT streams survive 31 seconds of idle time', { timeout: 45_000 }, async context => {
  const sockets = new Set<Socket>()
  let eventStream: ServerResponse | undefined
  let stalledHeaders = false
  const fixture = createServer((incoming, response) => {
    if (incoming.url === '/handshake') { stalledHeaders = true; return }
    eventStream = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: ready\n\n')
  })
  fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  fixture.on('upgrade', (_incoming, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', chunk => socket.write(chunk))
  })
  const tunnelFixture = createTcpServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', chunk => socket.write(chunk))
  })
  fixture.listen(0, '127.0.0.1')
  tunnelFixture.listen(0, '127.0.0.1')
  await Promise.all([once(fixture, 'listening'), once(tunnelFixture, 'listening')])
  const address = fixture.address()
  const tunnelAddress = tunnelFixture.address()
  assert.ok(address && typeof address !== 'string' && tunnelAddress && typeof tunnelAddress !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const boundary = await createBrowserNetwork(() => origin, 'origin')
  const tunnelBoundary = await createBrowserNetwork(() => `https://127.0.0.1:${tunnelAddress.port}`, 'origin')
  context.after(async () => {
    await Promise.all([boundary.close(), tunnelBoundary.close()])
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => fixture.close(() => resolve())), new Promise<void>(resolve => tunnelFixture.close(() => resolve()))])
  })
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: boundary.port, path: origin,
      headers: { 'Proxy-Authorization': boundary.authorization } }, resolve)
    outgoing.on('error', reject)
    outgoing.end()
  })
  const streamErrors: Error[] = []
  const chunks: string[] = []
  stream.on('error', error => streamErrors.push(error))
  stream.on('data', chunk => chunks.push(chunk.toString()))
  const websocket = await new Promise<Socket>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: boundary.port, path: origin,
      headers: { 'Proxy-Authorization': boundary.authorization, Connection: 'Upgrade', Upgrade: 'websocket' } })
    outgoing.on('upgrade', (_response, socket) => resolve(socket))
    outgoing.on('error', reject)
    outgoing.end()
  })
  const tunnel = await new Promise<Socket>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: tunnelBoundary.port, path: `127.0.0.1:${tunnelAddress.port}`, method: 'CONNECT',
      headers: { 'Proxy-Authorization': tunnelBoundary.authorization } })
    outgoing.on('connect', (_response, socket) => resolve(socket))
    outgoing.on('error', reject)
    outgoing.end()
  })
  const incompleteHandshake = connect(boundary.port, '127.0.0.1')
  incompleteHandshake.resume()
  let handshakeStatus: number | undefined
  const pendingRequest = request({ host: '127.0.0.1', port: boundary.port, path: `${origin}/handshake`,
    headers: { 'Proxy-Authorization': boundary.authorization } }, response => {
    handshakeStatus = response.statusCode
    response.resume()
  })
  pendingRequest.on('error', () => { handshakeStatus = 0 })
  pendingRequest.end()
  await delay(31_000)
  assert.equal(incompleteHandshake.destroyed, true)
  assert.equal(stalledHeaders, true)
  assert.ok(handshakeStatus === 0 || handshakeStatus === 502)
  assert.deepEqual({ sse: stream.destroyed, websocket: websocket.destroyed, tunnel: tunnel.destroyed }, { sse: false, websocket: false, tunnel: false })
  assert.deepEqual(streamErrors, [])
  const nextEvent = once(stream, 'data')
  eventStream!.write('data: resumed\n\n')
  await nextEvent
  assert.ok(chunks.includes('data: resumed\n\n'))
  for (const socket of [websocket, tunnel]) {
    const reply = once(socket, 'data')
    socket.write('resumed')
    assert.equal((await reply)[0].toString(), 'resumed')
  }
})
