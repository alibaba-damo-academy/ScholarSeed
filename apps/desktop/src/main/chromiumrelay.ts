import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { CHROMIUM_PROTOCOL_MESSAGES, ChromiumProtocolError } from './chromium.ts'
import type { ChromiumPipe } from './chromium'
import { chromiumProductControlledMethod } from './chromiumpolicy.ts'

const LOOPBACK = '127.0.0.1'
const ENDPOINT_PREFIX = '/devtools/browser/'
const TOKEN_BYTES = 32
const MAX_CDP_FRAME_BYTES = 32 * 1024 * 1024
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const MAX_PENDING_BYTES = 64 * 1024 * 1024
const MAX_PENDING_COMMANDS = 64
const MAX_METHOD_LENGTH = 128
const MAX_HTTP_CONNECTIONS = 16
const HTTP_TIMEOUT_MS = 10_000
const CDP_ERROR = -32000

type RelayPipe = Pick<ChromiumPipe, 'command' | 'onEvent' | 'onClose' | 'close'>

interface ClientLease {
  socket: WebSocket
  ready: Promise<void>
  browserSession?: string
  sessions: Set<string>
  contexts: Set<string>
  targets: Set<string>
  contextBarrier: Promise<void>
  operations: Set<Promise<void>>
  closed: boolean
  closing?: Promise<void>
}

export interface ChromiumCdpRelay {
  start(): Promise<{ port: number; endpoint: string }>
  stop(): Promise<void>
}

export function authorizedChromiumUpgrade(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`${ENDPOINT_PREFIX}${token}`)
  const received = Buffer.from(request.url ?? '')
  return (
    request.socket.remoteAddress === LOOPBACK &&
    request.headers.host === `${LOOPBACK}:${request.socket.localPort}` &&
    request.headers.origin === undefined &&
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  )
}

export function createChromiumCdpRelay(pipe: RelayPipe): ChromiumCdpRelay {
  let server: Server | undefined
  let sockets: WebSocketServer | undefined
  let client: ClientLease | undefined
  let endpoint: string | undefined
  let port: number | undefined
  let starting: Promise<{ port: number; endpoint: string }> | undefined
  let stopping: Promise<void> | undefined
  let unsubscribeEvent: (() => void) | undefined
  let unsubscribeClose: (() => void) | undefined
  let pendingCommands = 0
  let pendingBytes = 0
  let tainted = false

  const send = (socket: WebSocket, message: object): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    const frame = JSON.stringify(message)
    if (
      Buffer.byteLength(frame) > MAX_CDP_FRAME_BYTES ||
      socket.bufferedAmount + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES
    ) {
      socket.terminate()
      return
    }
    socket.send(frame, (error) => {
      if (error) socket.terminate()
    })
  }

  const failClosedCreation = (socket: WebSocket): void => {
    if (tainted) return
    tainted = true
    socket.terminate()
    void pipe
      .close()
      .catch((error) => console.error('[browser-chromium-cdp] sidecar shutdown failed', error))
    void relay
      .stop()
      .catch((error) => console.error('[browser-chromium-cdp] relay shutdown failed', error))
  }

  const releaseClient = (lease: ClientLease): Promise<void> => {
    if (lease.closing) return lease.closing
    lease.closed = true
    lease.socket.terminate()
    lease.closing = (async () => {
      await lease.ready.catch(() => undefined)
      await Promise.allSettled([...lease.operations])
      if (lease.browserSession) {
        let failed = false
        try {
          const result = (await pipe.command(
            'Target.getBrowserContexts',
            {},
            lease.browserSession
          )) as { browserContextIds?: unknown }
          if (!Array.isArray(result?.browserContextIds))
            throw new Error('Chromium did not list browser contexts')
          const existing = new Set(result.browserContextIds)
          for (const contextId of lease.contexts) {
            if (existing.has(contextId))
              await pipe.command(
                'Target.disposeBrowserContext',
                { browserContextId: contextId },
                lease.browserSession
              )
          }
        } catch (error) {
          failed = true
          console.error('[browser-chromium-cdp] context cleanup failed', error)
        }
        try {
          const result = (await pipe.command('Target.getTargets', {}, lease.browserSession)) as {
            targetInfos?: unknown
          }
          if (!Array.isArray(result?.targetInfos))
            throw new Error('Chromium did not list page targets')
          const existing = new Set(
            result.targetInfos.map((info) => (info as { targetId?: unknown }).targetId)
          )
          for (const targetId of lease.targets) {
            if (existing.has(targetId))
              await pipe.command('Target.closeTarget', { targetId }, lease.browserSession)
          }
        } catch (error) {
          failed = true
          console.error('[browser-chromium-cdp] target cleanup failed', error)
        }
        try {
          await pipe.command('Target.detachFromTarget', { sessionId: lease.browserSession })
        } catch (error) {
          failed = true
          console.error('[browser-chromium-cdp] session cleanup failed', error)
        }
        if (failed) tainted = true
      }
      if (client === lease) client = undefined
      if (tainted)
        void relay
          .stop()
          .catch((error) => console.error('[browser-chromium-cdp] relay shutdown failed', error))
    })()
    return lease.closing
  }

  const accept = (socket: WebSocket): void => {
    const lease: ClientLease = {
      socket,
      ready: Promise.resolve(),
      sessions: new Set(),
      contexts: new Set(),
      targets: new Set(),
      contextBarrier: Promise.resolve(),
      operations: new Set(),
      closed: false,
    }
    client = lease
    lease.ready = pipe
      .command('Target.attachToBrowserTarget')
      .then((result) => {
        const sessionId = (result as { sessionId?: unknown })?.sessionId
        if (typeof sessionId !== 'string' || !sessionId)
          throw new Error('Chromium did not attach a browser session')
        lease.browserSession = sessionId
      })
      .catch((error) => {
        socket.terminate()
        throw error
      })
    void lease.ready.catch(() => undefined)
    socket.on('message', (data) => {
      const frame = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      const bytes = frame.length
      if (pendingCommands >= MAX_PENDING_COMMANDS || pendingBytes + bytes > MAX_PENDING_BYTES) {
        socket.terminate()
        return
      }
      let request: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown }
      try {
        request = JSON.parse(frame.toString())
      } catch {
        socket.terminate()
        return
      }
      if (
        !request ||
        !Number.isSafeInteger(request.id) ||
        typeof request.method !== 'string' ||
        request.method.length > MAX_METHOD_LENGTH ||
        !/^[A-Za-z]+\.[A-Za-z]+$/.test(request.method) ||
        (request.params !== undefined &&
          (!request.params ||
            typeof request.params !== 'object' ||
            Array.isArray(request.params))) ||
        (request.sessionId !== undefined &&
          (typeof request.sessionId !== 'string' || !request.sessionId))
      ) {
        socket.terminate()
        return
      }
      const id = request.id as number
      const method = request.method
      const params = (request.params ?? {}) as Record<string, unknown>
      const sessionId = request.sessionId as string | undefined
      if (chromiumProductControlledMethod(method) && method !== 'Browser.setDownloadBehavior') {
        send(socket, {
          id,
          error: { code: CDP_ERROR, message: CHROMIUM_PROTOCOL_MESSAGES.methodControlled(method) },
          ...(sessionId ? { sessionId } : {}),
        })
        return
      }
      const precedingContextBarrier = lease.contextBarrier
      let releaseContextBarrier: (() => void) | undefined
      if (method === 'Target.createBrowserContext') {
        const currentBarrier = new Promise<void>((resolve) => {
          releaseContextBarrier = resolve
        })
        lease.contextBarrier = precedingContextBarrier.then(() => currentBarrier)
      }
      pendingCommands += 1
      pendingBytes += bytes
      const operation = lease.ready
        .then(async () => {
          await precedingContextBarrier
          if (lease.closed || !lease.browserSession) return
          if (sessionId && !lease.sessions.has(sessionId))
            throw new Error('Unknown Chromium page session')
          if (
            (method === 'Target.detachFromTarget' || method === 'Target.sendMessageToTarget') &&
            (typeof params.sessionId !== 'string' || !lease.sessions.has(params.sessionId))
          ) {
            throw new Error('Unknown Chromium child session')
          }
          const forwardedParams =
            method === 'Browser.setDownloadBehavior'
              ? {
                  behavior: 'deny',
                  ...(typeof params.browserContextId === 'string'
                    ? { browserContextId: params.browserContextId }
                    : {}),
                }
              : params
          let result: unknown
          try {
            result = await pipe.command(method, forwardedParams, sessionId ?? lease.browserSession)
          } catch (error) {
            if (
              (method === 'Target.createBrowserContext' || method === 'Target.createTarget') &&
              !(error instanceof ChromiumProtocolError)
            )
              failClosedCreation(socket)
            throw error
          }
          if (
            (method === 'Target.attachToTarget' || method === 'Target.attachToBrowserTarget') &&
            typeof (result as { sessionId?: unknown })?.sessionId === 'string'
          ) {
            lease.sessions.add((result as { sessionId: string }).sessionId)
          }
          if (method === 'Target.createBrowserContext') {
            const contextId = (result as { browserContextId?: unknown })?.browserContextId
            if (typeof contextId !== 'string' || !contextId) {
              failClosedCreation(socket)
              throw new Error('Chromium created a browser context without an identity')
            }
            lease.contexts.add(contextId)
            try {
              await pipe.command(
                'Browser.setDownloadBehavior',
                { behavior: 'deny', browserContextId: contextId },
                lease.browserSession
              )
            } catch (error) {
              try {
                await pipe.command(
                  'Target.disposeBrowserContext',
                  { browserContextId: contextId },
                  lease.browserSession
                )
                lease.contexts.delete(contextId)
              } catch (cleanupError) {
                failClosedCreation(socket)
                throw new AggregateError(
                  [error, cleanupError],
                  'Chromium context policy and cleanup failed'
                )
              }
              throw error
            }
          }
          if (method === 'Target.createTarget') {
            const targetId = (result as { targetId?: unknown })?.targetId
            if (typeof targetId !== 'string' || !targetId) {
              failClosedCreation(socket)
              throw new Error('Chromium created a target without an identity')
            }
            lease.targets.add(targetId)
          }
          if (
            method === 'Target.disposeBrowserContext' &&
            typeof params.browserContextId === 'string'
          )
            lease.contexts.delete(params.browserContextId)
          if (method === 'Target.closeTarget' && typeof params.targetId === 'string')
            lease.targets.delete(params.targetId)
          if (method === 'Target.detachFromTarget' && typeof params.sessionId === 'string')
            lease.sessions.delete(params.sessionId)
          send(socket, {
            id,
            result:
              method === 'Browser.setDownloadBehavior'
                ? { scholarseedDownloadPolicy: 'disabled' }
                : (result ?? {}),
            ...(sessionId ? { sessionId } : {}),
          })
        })
        .catch((error) => {
          send(socket, {
            id,
            error: {
              code: error instanceof ChromiumProtocolError ? error.code : CDP_ERROR,
              message:
                error instanceof Error ? error.message : CHROMIUM_PROTOCOL_MESSAGES.commandFailed,
              ...(error instanceof ChromiumProtocolError && error.data !== undefined
                ? { data: error.data }
                : {}),
            },
            ...(sessionId ? { sessionId } : {}),
          })
        })
        .finally(() => {
          releaseContextBarrier?.()
          pendingCommands -= 1
          pendingBytes -= bytes
        })
      lease.operations.add(operation)
      void operation.then(
        () => lease.operations.delete(operation),
        () => lease.operations.delete(operation)
      )
    })
    socket.on('error', () => socket.terminate())
    socket.once('close', () => {
      void releaseClient(lease)
    })
  }

  const release = async (): Promise<void> => {
    const closingServer = server
    const closingSockets = sockets
    server = undefined
    sockets = undefined
    endpoint = undefined
    port = undefined
    unsubscribeEvent?.()
    unsubscribeEvent = undefined
    unsubscribeClose?.()
    unsubscribeClose = undefined
    if (client) await releaseClient(client)
    if (closingSockets) await new Promise<void>((resolve) => closingSockets.close(() => resolve()))
    closingServer?.closeAllConnections()
    if (closingServer) await new Promise<void>((resolve) => closingServer.close(() => resolve()))
  }

  const relay: ChromiumCdpRelay = {
    start() {
      if (tainted) return Promise.reject(new Error('Chromium CDP relay cleanup failed'))
      if (stopping) return stopping.then(() => this.start())
      if (starting) return starting
      starting = (async () => {
        const token = randomBytes(TOKEN_BYTES).toString('hex')
        server = createServer((_request, response) => {
          response.writeHead(404)
          response.end()
        })
        server.maxConnections = MAX_HTTP_CONNECTIONS
        server.headersTimeout = HTTP_TIMEOUT_MS
        server.requestTimeout = HTTP_TIMEOUT_MS
        sockets = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_CDP_FRAME_BYTES,
          perMessageDeflate: false,
        })
        server.on('upgrade', (request, socket, head) => {
          if (!sockets || tainted || !authorizedChromiumUpgrade(request, token)) {
            socket.destroy()
            return
          }
          if (client) {
            socket.end(
              'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
            )
            return
          }
          sockets.handleUpgrade(request, socket, head, accept)
        })
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(0, LOOPBACK, resolve)
        })
        port = (server.address() as { port: number }).port
        endpoint = `ws://${LOOPBACK}:${port}${ENDPOINT_PREFIX}${token}`
        unsubscribeEvent = pipe.onEvent((message) => {
          const lease = client
          if (!lease || lease.closed || !lease.browserSession) return
          if (message.sessionId === lease.browserSession) {
            if (
              message.method === 'Target.attachedToTarget' &&
              typeof message.params.sessionId === 'string'
            ) {
              lease.sessions.add(message.params.sessionId)
            }
            if (
              message.method === 'Target.detachedFromTarget' &&
              typeof message.params.sessionId === 'string'
            ) {
              lease.sessions.delete(message.params.sessionId)
            }
            const { sessionId: _browserSession, ...event } = message
            send(lease.socket, event)
          } else if (message.sessionId && lease.sessions.has(message.sessionId))
            send(lease.socket, message)
        })
        unsubscribeClose = pipe.onClose(() => {
          void this.stop()
        })
        return { port, endpoint }
      })().catch(async (error) => {
        await release()
        starting = undefined
        throw error
      })
      return starting
    },
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (starting) await starting.catch(() => undefined)
        await release()
        starting = undefined
      })().finally(() => {
        stopping = undefined
      })
      return stopping
    },
  }
  return relay
}
