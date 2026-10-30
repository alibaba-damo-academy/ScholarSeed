import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ALL, V4MAPPED } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP, Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { BROWSER_ERROR } from '../browser.ts'
import { browserLoopbackHost, browserResourceAllowed, mappedIPv4 } from './navigation.ts'

const LOOPBACK = '127.0.0.1'
const EPHEMERAL_PORT = 0
const HTTP_PORT = 80
const HTTPS_PORT = 443
const SECRET_BYTES = 32
const HANDSHAKE_TIMEOUT_MS = 30_000
const CONNECT_ATTEMPT_TIMEOUT_MS = 250
const CONNECT_BUDGET_MS = 20_000
const MAX_DESTINATIONS = 8
const MAX_DIAGNOSTIC_EVENTS = 32
const CONNECT_ATTEMPTS_STAGE = 'connect_attempts'
const CONNECT_EVENT = { attempt: 'attempt', failed: 'failed', timeout: 'timeout' } as const
const SAFE_ERROR_CODE = /^[A-Z][A-Z_0-9]{0,31}$/
const NO_IDLE_TIMEOUT = 0
const MAX_CONNECTIONS = 256
const PROXY_REALM = 'scholarseed-browser'
const PROXY_USER = 'browser'
const PROXY_AUTHENTICATION_REQUIRED = 407
const FORBIDDEN = 403
export const BROWSER_PROXY_ERROR_HEADER = 'x-scholarseed-proxy-error'
const BAD_GATEWAY = 502
const HTTP_OK = 200
const SWITCHING_PROTOCOLS = 101
const WEBSOCKET_PROTOCOL = 'websocket'
const GLOBAL_IPV6_PREFIX = /^[23][\da-f]{3}:/
const NON_GLOBAL_IPV6_SUBNETS = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
] as const
const nonGlobalIPv6 = new BlockList()
for (const [address, prefix] of NON_GLOBAL_IPV6_SUBNETS) nonGlobalIPv6.addSubnet(address, prefix, 'ipv6')
const HOP_HEADERS = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding']

type Address = { address: string; family: number }
type Resolver = (hostname: string) => Promise<Address[]>
const resolveHost: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true, hints: ALL | V4MAPPED })

export function publicBrowserAddress(address: string): boolean {
  const version = isIP(address)
  if (!version) return false
  const mapped = mappedIPv4(address)
  if (mapped !== null) return publicBrowserAddress(mapped)
  const url = new URL(`http://${version === 6 ? `[${address}]` : address}`)
  if (!browserResourceAllowed({ url, topOrigin: '', apiOrigin: null, approvedLocalOrigin: null })) return false
  if (version === 6) {
    const normalized = url.hostname.slice(1, -1)
    return GLOBAL_IPV6_PREFIX.test(normalized) && !nonGlobalIPv6.check(normalized, 'ipv6')
  }
  return !address.startsWith('192.0.0.') && !address.startsWith('192.0.2.')
    && !address.startsWith('198.51.100.') && !address.startsWith('203.0.113.')
}

export async function resolveBrowserDestinations(url: URL, apiOrigin: string | null, resolver: Resolver = resolveHost): Promise<Address[]> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(BROWSER_ERROR.permissionDenied)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const answers = family ? [{ address: hostname, family }] : await resolver(hostname)
  if (!answers.length || answers.some(value => isIP(value.address) !== value.family)) throw new Error(BROWSER_ERROR.permissionDenied)
  const addresses = answers.map(value => {
    const mapped = mappedIPv4(value.address)
    return mapped === null ? value : { address: mapped, family: 4 }
  })
  if (addresses.some(value => !publicBrowserAddress(value.address))
    && (url.origin !== apiOrigin || !browserLoopbackHost(hostname)
      || addresses.some(value => !browserLoopbackHost(value.address)))) throw new Error(BROWSER_ERROR.permissionDenied)
  return addresses.slice(0, MAX_DESTINATIONS)
}

type PinnedDialOptions = { staggerMs?: number; budgetMs?: number; dial?: (socket: Socket, address: Address, port: number) => void }

export function connectPinned(port: number, addresses: Address[], diagnosticId: number,
  log: (stage: string, code: string) => void, signal: AbortSignal, options: PinnedDialOptions = {}): Promise<Socket> {
  const started = Date.now()
  const events: { type: typeof CONNECT_EVENT[keyof typeof CONNECT_EVENT]; index: number; family: number; code?: string }[] = []
  const sockets = new Set<Socket>()
  const staggerMs = options.staggerMs ?? CONNECT_ATTEMPT_TIMEOUT_MS
  const budgetMs = options.budgetMs ?? CONNECT_BUDGET_MS
  const dial = options.dial ?? ((socket: Socket, address: Address, targetPort: number) => {
    socket.connect({ host: address.address, family: address.family, port: targetPort })
  })
  let attemptCount = 0
  let finished = false
  let nextIndex = 0
  let pending = 0
  let lastError: Error | undefined
  let launchTimer: NodeJS.Timeout | undefined
  const familyFor = (family: number) => family === 4 || family === 6 ? family : 0
  const codeFor = (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code
    return code && SAFE_ERROR_CODE.test(code) ? code : 'unknown'
  }
  const record = (type: typeof CONNECT_EVENT[keyof typeof CONNECT_EVENT], index: number, family: number, code?: string) => {
    if (type === CONNECT_EVENT.attempt) attemptCount += 1
    if (events.length >= MAX_DIAGNOSTIC_EVENTS) return
    events.push({ type, index, family: familyFor(family), ...(code ? { code } : {}) })
  }
  const finish = (result: 'connected' | 'timeout' | 'error' | 'closed', winner?: Socket, error?: Error) => {
    if (finished) return
    finished = true
    if (launchTimer) clearTimeout(launchTimer)
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    for (const socket of sockets) if (socket !== winner) socket.destroy()
    sockets.clear()
    log(CONNECT_ATTEMPTS_STAGE, JSON.stringify({ id: diagnosticId,
      resolved: { ipv4: addresses.filter(candidate => candidate.family === 4).length,
        ipv6: addresses.filter(candidate => candidate.family === 6).length },
      events, attemptCount, result, ...(error ? { code: codeFor(error) } : {}),
      remoteFamily: winner?.remoteFamily === 'IPv4' ? 4 : winner?.remoteFamily === 'IPv6' ? 6 : 0,
      elapsedMs: Date.now() - started }))
    if (winner) resolveConnection(winner)
    else rejectConnection(error ?? new Error('CONNECT closed'))
  }
  let resolveConnection!: (socket: Socket) => void
  let rejectConnection!: (error: Error) => void
  const result = new Promise<Socket>((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject })
  const abort = () => finish('closed', undefined, new Error('CONNECT aborted'))
  const deadline = setTimeout(() => finish('timeout', undefined, new Error('CONNECT timed out')), budgetMs)
  const launch = () => {
    if (finished || nextIndex >= addresses.length) return
    const index = nextIndex++
    const address = addresses[index]
    const socket = new Socket()
    sockets.add(socket)
    pending += 1
    let attemptFinished = false
    const failed = (error: Error) => {
      if (attemptFinished || finished) return
      attemptFinished = true
      pending -= 1
      lastError = error
      record(CONNECT_EVENT.failed, index, address.family, codeFor(error))
      socket.destroy()
      if (pending === 0 && nextIndex >= addresses.length) finish('error', undefined, lastError)
      else if (pending === 0 && launchTimer) { clearTimeout(launchTimer); launchTimer = undefined; launch() }
    }
    socket.on('error', failed)
    socket.once('close', () => failed(new Error('CONNECT closed')))
    socket.once('connect', () => {
      if (finished) { socket.destroy(); return }
      attemptFinished = true
      finish('connected', socket)
    })
    record(CONNECT_EVENT.attempt, index, address.family)
    try { dial(socket, address, port) } catch (error) { failed(error instanceof Error ? error : new Error('CONNECT failed')) }
    if (!finished && nextIndex < addresses.length && !launchTimer) {
      launchTimer = setTimeout(() => { launchTimer = undefined; launch() }, staggerMs)
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  else launch()
  return result
}

function headersForUpstream(incoming: IncomingHttpHeaders, url: URL): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...incoming, host: url.host }
  const connectionHeaders = (incoming.connection ?? '').split(',').map(header => header.trim().toLowerCase())
  for (const header of [...HOP_HEADERS, ...connectionHeaders]) delete headers[header]
  return headers
}

export interface BrowserNetwork {
  port: number
  username: string
  password: string
  authorization: string
  consumeProxyError(marker: string): typeof BROWSER_ERROR.permissionDenied | typeof BROWSER_ERROR.navigationFailed | null
  revoke(): void
  close(): Promise<void>
}

export async function createBrowserNetwork(apiOrigin: () => string | null, scope: 'public' | 'origin' = 'public',
  log: (stage: string, code: string) => void = () => undefined, resolver: Resolver = resolveHost): Promise<BrowserNetwork> {
  const password = randomBytes(SECRET_BYTES).toString('hex')
  const authorization = `Basic ${Buffer.from(`${PROXY_USER}:${password}`).toString('base64')}`
  const connections = new Set<Duplex>()
  const pendingConnects = new Set<AbortController>()
  const pendingErrors = new Map<string, { error: typeof BROWSER_ERROR.permissionDenied | typeof BROWSER_ERROR.navigationFailed; timeout: NodeJS.Timeout }>()
  let closed = false
  let generation = 0
  let nextConnectId = 0
  const writeProxyError = (response: ServerResponse, status: number,
    error: typeof BROWSER_ERROR.permissionDenied | typeof BROWSER_ERROR.navigationFailed) => {
    const marker = randomBytes(SECRET_BYTES).toString('hex')
    const timeout = setTimeout(() => pendingErrors.delete(marker), HANDSHAKE_TIMEOUT_MS)
    timeout.unref()
    pendingErrors.set(marker, { error, timeout })
    response.writeHead(status, { [BROWSER_PROXY_ERROR_HEADER]: marker })
    response.end()
  }
  const destinationFor = (url: URL) => {
    const allowedOrigin = scope === 'origin' ? apiOrigin() : null
    if (scope === 'origin' && (!allowedOrigin || url.origin !== allowedOrigin)) throw new Error(BROWSER_ERROR.permissionDenied)
    return resolveBrowserDestinations(url, allowedOrigin, resolver)
  }
  const authenticated = (incoming: IncomingMessage): boolean => {
    const supplied = Buffer.from(incoming.headers['proxy-authorization'] ?? '')
    const expected = Buffer.from(authorization)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
  const track = (socket: Duplex) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    socket.on('error', () => socket.destroy())
    if ('setTimeout' in socket) (socket as Socket).setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      log('socket_timeout', 'ETIMEDOUT')
      socket.destroy()
    })
  }
  const established = (...sockets: Socket[]) => {
    for (const socket of sockets) socket.setTimeout(NO_IDLE_TIMEOUT)
  }
  const pinnedRequestConnection = (port: number, destinations: Address[], downstream: Socket, admission: number) => {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const cleanup = () => {
      pendingConnects.delete(controller)
      downstream.removeListener('close', cancel)
    }
    return {
      cancel,
      createConnection: (_options: unknown, callback: (error: Error | null, socket: Duplex) => void) => {
        pendingConnects.add(controller)
        downstream.once('close', cancel)
        if (downstream.destroyed) cancel()
        const complete = callback as (error: Error | null, socket?: Duplex) => void
        void connectPinned(port, destinations, ++nextConnectId, log, controller.signal).then(upstream => {
          if (closed || admission !== generation || downstream.destroyed || controller.signal.aborted) {
            upstream.destroy()
            complete(new Error('Connection closed'))
            return
          }
          track(upstream)
          upstream.setTimeout(HANDSHAKE_TIMEOUT_MS)
          complete(null, upstream)
        }, error => complete(error)).finally(cleanup)
        return undefined
      }
    }
  }
  const server = createServer(async (incoming, response) => {
    if (!authenticated(incoming)) {
      response.writeHead(PROXY_AUTHENTICATION_REQUIRED, { 'Proxy-Authenticate': `Basic realm="${PROXY_REALM}"` })
      response.end()
      return
    }
    const admission = generation
    try {
      const url = new URL(incoming.url ?? '')
      if (url.protocol !== 'http:') throw new Error(BROWSER_ERROR.permissionDenied)
      const destinations = await destinationFor(url)
      if (closed || admission !== generation || incoming.socket.destroyed) throw new Error(BROWSER_ERROR.permissionDenied)
      const dial = pinnedRequestConnection(Number(url.port || HTTP_PORT), destinations, incoming.socket, admission)
      const upstream = request({ hostname: url.hostname, createConnection: dial.createConnection,
        port: url.port || HTTP_PORT, method: incoming.method, path: `${url.pathname}${url.search}`,
        headers: headersForUpstream(incoming.headers, url) }, reply => {
        established(incoming.socket, reply.socket)
        reply.on('aborted', () => response.destroy())
        reply.on('error', () => response.destroy())
        const headers = { ...reply.headers }
        delete headers[BROWSER_PROXY_ERROR_HEADER]
        response.writeHead(reply.statusCode ?? BAD_GATEWAY, headers)
        reply.pipe(response)
      })
      upstream.on('error', error => {
        dial.cancel()
        log('http_error', (error as NodeJS.ErrnoException).code ?? 'unknown')
        if (response.headersSent) response.destroy()
        else writeProxyError(response, BAD_GATEWAY, BROWSER_ERROR.navigationFailed)
      })
      incoming.on('aborted', () => { dial.cancel(); upstream.destroy() })
      incoming.on('error', () => { dial.cancel(); upstream.destroy() })
      response.on('close', () => { dial.cancel(); upstream.destroy() })
      incoming.pipe(upstream)
    } catch {
      writeProxyError(response, FORBIDDEN, BROWSER_ERROR.permissionDenied)
    }
  })
  server.maxConnections = MAX_CONNECTIONS
  server.on('connection', track)
  server.on('upgrade', async (incoming, socket, head) => {
    const admission = generation
    try {
      if (!authenticated(incoming) || incoming.headers.upgrade?.toLowerCase() !== WEBSOCKET_PROTOCOL) throw new Error(BROWSER_ERROR.permissionDenied)
      const url = new URL(incoming.url ?? '')
      if (url.protocol === 'ws:') url.protocol = 'http:'
      if (url.protocol !== 'http:') throw new Error(BROWSER_ERROR.permissionDenied)
      const destinations = await destinationFor(url)
      if (closed || admission !== generation || socket.destroyed) throw new Error(BROWSER_ERROR.permissionDenied)
      const dial = pinnedRequestConnection(Number(url.port || HTTP_PORT), destinations, socket as Socket, admission)
      const upstream = request({ hostname: url.hostname, createConnection: dial.createConnection, port: url.port || HTTP_PORT,
        method: incoming.method, path: `${url.pathname}${url.search}`,
        headers: { ...headersForUpstream(incoming.headers, url), connection: 'Upgrade', upgrade: WEBSOCKET_PROTOCOL } })
      upstream.on('error', error => { dial.cancel(); log('websocket_error', (error as NodeJS.ErrnoException).code ?? 'unknown'); socket.destroy() })
      upstream.on('response', response => {
        response.on('error', () => socket.destroy())
        response.resume()
        socket.destroy()
      })
      upstream.on('upgrade', (response, tunnel, upstreamHead) => {
        established(socket as Socket, tunnel)
        const responseHeaders = response.rawHeaders.reduce<string[]>((headers, value, index, values) => {
          if (index % 2 === 0) headers.push(`${value}: ${values[index + 1]}`)
          return headers
        }, [])
        socket.write(`HTTP/1.1 ${SWITCHING_PROTOCOLS} Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`)
        if (head.length) tunnel.write(head)
        if (upstreamHead.length) socket.write(upstreamHead)
        socket.pipe(tunnel).pipe(socket)
        socket.once('close', () => tunnel.destroy())
        tunnel.once('close', () => socket.destroy())
      })
      socket.once('close', () => { dial.cancel(); upstream.destroy() })
      upstream.end()
    } catch {
      socket.end(`HTTP/1.1 ${FORBIDDEN} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  })
  server.on('connect', async (incoming, socket, head) => {
    log('connect_received', 'ok')
    if (!authenticated(incoming)) {
      socket.end(`HTTP/1.1 ${PROXY_AUTHENTICATION_REQUIRED} Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_REALM}"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const admission = generation
    try {
      const url = new URL(`https://${incoming.url}`)
      if (url.pathname !== '/' || url.search || url.hash) throw new Error(BROWSER_ERROR.permissionDenied)
      const destinations = await destinationFor(url)
      log('connect_resolved', 'ok')
      if (closed || admission !== generation || socket.destroyed) throw new Error(BROWSER_ERROR.permissionDenied)
      const controller = new AbortController()
      pendingConnects.add(controller)
      const cancel = () => controller.abort()
      socket.once('close', cancel)
      let upstream: Socket
      try {
        upstream = await connectPinned(Number(url.port || HTTPS_PORT), destinations, ++nextConnectId, log, controller.signal)
      } catch (error) {
        if (!socket.destroyed) {
          log('connect_error', (error as NodeJS.ErrnoException).code ?? 'unknown')
          socket.destroy()
        }
        return
      } finally {
        pendingConnects.delete(controller)
        socket.removeListener('close', cancel)
      }
      if (closed || admission !== generation || socket.destroyed) { upstream.destroy(); return }
      track(upstream)
      upstream.once('error', error => { log('connect_error', (error as NodeJS.ErrnoException).code ?? 'unknown'); socket.destroy() })
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
      log('connect_established', upstream.remoteFamily ?? 'unknown')
      established(socket as Socket, upstream)
      socket.write(`HTTP/1.1 ${HTTP_OK} Connection Established\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    } catch {
      socket.end(`HTTP/1.1 ${FORBIDDEN} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(EPHEMERAL_PORT, LOOPBACK, () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(BROWSER_ERROR.navigationFailed)
  const revoke = () => {
    generation += 1
    for (const controller of pendingConnects) controller.abort()
    for (const socket of connections) socket.destroy()
  }
  return { port: address.port, username: PROXY_USER, password, authorization, revoke,
    consumeProxyError(marker) {
      const pending = pendingErrors.get(marker)
      if (!pending) return null
      clearTimeout(pending.timeout)
      pendingErrors.delete(marker)
      return pending.error
    },
    close: async () => {
      if (closed) return
      closed = true
      revoke()
      for (const pending of pendingErrors.values()) clearTimeout(pending.timeout)
      pendingErrors.clear()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}
