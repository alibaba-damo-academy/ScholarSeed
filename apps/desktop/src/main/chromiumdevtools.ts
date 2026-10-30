import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { CHROMIUM_PROTOCOL_MESSAGES, ChromiumProtocolError } from './chromium.ts'
import type { ChromiumPipe } from './chromium'
import { chromiumProductControlledMethod } from './chromiumpolicy.ts'

const LOOPBACK = '127.0.0.1'
const DEVTOOLS_ORIGIN = 'devtools://devtools'
const ENDPOINT_PREFIX = '/devtools/page/'
const TOKEN_BYTES = 32
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const MAX_PENDING_BYTES = 64 * 1024 * 1024
const MAX_PENDING_COMMANDS = 64
const MAX_METHOD_LENGTH = 128
const MAX_HTTP_CONNECTIONS = 16
const HTTP_TIMEOUT_MS = 10_000
const DRAIN_TIMEOUT_MS = 10_000
const CDP_ERROR = -32000
const CDP_METHOD_NOT_FOUND = -32601
const FRONTEND_DISCONNECT_ERROR = 'Chromium DevTools frontend disconnected'

type RelayPipe = Pick<ChromiumPipe, 'command' | 'onEvent' | 'onClose' | 'close'>

interface RelayOptions {
  drainTimeoutMs?: number
}

interface ClientLease {
  socket: WebSocket
  ready: Promise<void>
  sessionId?: string
  operations: Set<Promise<void>>
  pendingCommands: number
  pendingBytes: number
  closed: boolean
  explicitAttachRefusal?: boolean
  closing?: Promise<void>
}

export interface ChromiumDevToolsRelay {
  start(): Promise<{ port: number; endpoint: string }>
  waitForAttachment(): Promise<void>
  onDisconnect(listener: (error: Error) => void): () => void
  stop(): Promise<void>
}

export function authorizedDevToolsUpgrade(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`${ENDPOINT_PREFIX}${token}`)
  const received = Buffer.from(request.url ?? '')
  return (
    request.socket.remoteAddress === LOOPBACK &&
    request.headers.host === `${LOOPBACK}:${request.socket.localPort}` &&
    request.headers.origin === DEVTOOLS_ORIGIN &&
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  )
}

export function createChromiumDevToolsRelay(
  pipe: RelayPipe,
  targetId: string,
  options: RelayOptions = {}
): ChromiumDevToolsRelay {
  if (!targetId || typeof targetId !== 'string')
    throw new Error('A Main-owned Chromium target is required')
  const drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0)
    throw new Error('Invalid DevTools drain timeout')
  let server: Server | undefined
  let sockets: WebSocketServer | undefined
  let client: ClientLease | undefined
  let starting: Promise<{ port: number; endpoint: string }> | undefined
  let stopping: Promise<void> | undefined
  let unsubscribeEvent: (() => void) | undefined
  let unsubscribeClose: (() => void) | undefined
  let tainted = false
  let sidecarClosing: Promise<void> | undefined
  let shutdownError: Error | undefined
  let attachment: Promise<void> | undefined
  let resolveAttachment: (() => void) | undefined
  let rejectAttachment: ((error: Error) => void) | undefined
  const disconnectListeners = new Set<(error: Error) => void>()

  const finishAttachment = (error?: Error): void => {
    const resolve = resolveAttachment
    const reject = rejectAttachment
    resolveAttachment = undefined
    rejectAttachment = undefined
    if (error) reject?.(error)
    else resolve?.()
  }

  const withinTimeout = async <T>(operation: Promise<T>): Promise<T> => {
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Chromium DevTools operation timed out')),
            drainTimeoutMs
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  const closeSidecar = (): Promise<void> => {
    tainted = true
    if (!sidecarClosing)
      sidecarClosing = withinTimeout(Promise.resolve().then(() => pipe.close())).catch((error) => {
        shutdownError = new Error(
          `Chromium sidecar shutdown failed; termination unconfirmed or profile cleanup incomplete: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
        throw shutdownError
      })
    return sidecarClosing
  }

  const send = (socket: WebSocket, message: object): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    const frame = JSON.stringify(message)
    const bytes = Buffer.byteLength(frame)
    if (bytes > MAX_FRAME_BYTES || socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
      socket.terminate()
      return
    }
    socket.send(frame, (error) => {
      if (error) socket.terminate()
    })
  }

  const releaseClient = (lease: ClientLease): Promise<void> => {
    if (lease.closing) return lease.closing
    lease.closed = true
    lease.socket.terminate()
    lease.closing = (async () => {
      try {
        try {
          await withinTimeout(lease.ready)
        } catch {
          if (!lease.explicitAttachRefusal) await closeSidecar()
        }
        if (!tainted) {
          try {
            await withinTimeout(Promise.allSettled([...lease.operations]))
          } catch {
            await closeSidecar()
          }
        }
        if (lease.sessionId && !tainted) {
          try {
            await withinTimeout(
              pipe.command('Target.detachFromTarget', { sessionId: lease.sessionId })
            )
          } catch (error) {
            console.error('[browser-chromium-devtools] session cleanup failed', error)
            await closeSidecar()
          }
        }
      } finally {
        if (client === lease) client = undefined
        if (tainted)
          void relay
            .stop()
            .catch((error) =>
              console.error('[browser-chromium-devtools] relay shutdown failed', error)
            )
      }
    })()
    return lease.closing
  }

  const accept = (socket: WebSocket): void => {
    const lease: ClientLease = {
      socket,
      ready: Promise.resolve(),
      operations: new Set(),
      pendingCommands: 0,
      pendingBytes: 0,
      closed: false,
    }
    client = lease
    lease.ready = withinTimeout(pipe.command('Target.attachToTarget', { targetId, flatten: true }))
      .then((result) => {
        const sessionId = (result as { sessionId?: unknown })?.sessionId
        if (typeof sessionId !== 'string' || !sessionId)
          throw new Error('Chromium did not attach a page session')
        lease.sessionId = sessionId
        finishAttachment()
      })
      .catch(async (error) => {
        let failure = error instanceof Error ? error : new Error(String(error))
        if (error instanceof ChromiumProtocolError) lease.explicitAttachRefusal = true
        else {
          try {
            await closeSidecar()
          } catch (closeError) {
            failure = closeError instanceof Error ? closeError : new Error(String(closeError))
          }
        }
        finishAttachment(failure)
        socket.terminate()
        throw failure
      })
    void lease.ready.catch(() => undefined)
    socket.on('message', (data) => {
      const frame = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      const bytes = frame.length
      if (
        bytes > MAX_FRAME_BYTES ||
        lease.pendingCommands >= MAX_PENDING_COMMANDS ||
        lease.pendingBytes + bytes > MAX_PENDING_BYTES
      ) {
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
        request.sessionId !== undefined ||
        (request.params !== undefined &&
          (!request.params ||
            typeof request.params !== 'object' ||
            Array.isArray(request.params))) ||
        (request.params &&
          ('targetId' in request.params ||
            typeof (request.params as Record<string, unknown>).sessionId === 'string'))
      ) {
        socket.terminate()
        return
      }
      const id = request.id as number
      const method = request.method
      const params = (request.params ?? {}) as Record<string, unknown>
      if (method.startsWith('Target.') || method.startsWith('Browser.')) {
        send(socket, {
          id,
          error: {
            code: CDP_METHOD_NOT_FOUND,
            message: CHROMIUM_PROTOCOL_MESSAGES.methodUnavailable(method),
          },
        })
        return
      }
      if (chromiumProductControlledMethod(method)) {
        send(socket, {
          id,
          error: { code: CDP_ERROR, message: CHROMIUM_PROTOCOL_MESSAGES.methodControlled(method) },
        })
        return
      }
      lease.pendingCommands += 1
      lease.pendingBytes += bytes
      const operation = lease.ready
        .then(async () => {
          if (lease.closed || !lease.sessionId) return
          const result = await pipe.command(method, params, lease.sessionId)
          send(socket, { id, result: result ?? {} })
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
          })
        })
        .finally(() => {
          lease.pendingCommands -= 1
          lease.pendingBytes -= bytes
        })
      lease.operations.add(operation)
      void operation.then(
        () => lease.operations.delete(operation),
        () => lease.operations.delete(operation)
      )
    })
    socket.on('error', () => socket.terminate())
    socket.once('close', () => {
      if (lease.sessionId && !lease.closed && !stopping && server) {
        const error = new Error(FRONTEND_DISCONNECT_ERROR)
        for (const listener of disconnectListeners) {
          try {
            listener(error)
          } catch (failure) {
            console.error('[browser-chromium-devtools] disconnect listener failed', failure)
          }
        }
      }
      void releaseClient(lease).catch((error) =>
        console.error('[browser-chromium-devtools] client cleanup failed', error)
      )
    })
  }

  const release = async (): Promise<void> => {
    const closingServer = server
    const closingSockets = sockets
    server = undefined
    sockets = undefined
    unsubscribeEvent?.()
    unsubscribeEvent = undefined
    unsubscribeClose?.()
    unsubscribeClose = undefined
    let failure: unknown
    try {
      if (client) await releaseClient(client)
    } catch (error) {
      failure = error
    }
    if (closingSockets) {
      try {
        await withinTimeout(new Promise<void>((resolve) => closingSockets.close(() => resolve())))
      } catch (error) {
        failure ??= error
      }
    }
    closingServer?.closeAllConnections()
    if (closingServer) {
      try {
        await withinTimeout(new Promise<void>((resolve) => closingServer.close(() => resolve())))
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }

  const relay: ChromiumDevToolsRelay = {
    start() {
      if (tainted)
        return Promise.reject(
          shutdownError ?? new Error('Chromium DevTools session cleanup failed')
        )
      if (stopping) return stopping.then(() => this.start())
      if (starting) return starting
      attachment = new Promise<void>((resolve, reject) => {
        resolveAttachment = resolve
        rejectAttachment = reject
      })
      void attachment.catch(() => undefined)
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
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
        })
        server.on('upgrade', (request, socket, head) => {
          if (!sockets || client || tainted || !authorizedDevToolsUpgrade(request, token)) {
            socket.destroy()
            return
          }
          sockets.handleUpgrade(request, socket, head, accept)
        })
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(0, LOOPBACK, resolve)
        })
        const port = (server.address() as { port: number }).port
        unsubscribeEvent = pipe.onEvent((message) => {
          const lease = client
          if (!lease || lease.closed || !lease.sessionId || message.sessionId !== lease.sessionId)
            return
          const { sessionId: _sessionId, ...event } = message
          send(lease.socket, event)
        })
        unsubscribeClose = pipe.onClose(() => {
          void this.stop().catch((error) =>
            console.error('[browser-chromium-devtools] relay shutdown failed', error)
          )
        })
        return { port, endpoint: `ws://${LOOPBACK}:${port}${ENDPOINT_PREFIX}${token}` }
      })().catch(async (error) => {
        finishAttachment(error instanceof Error ? error : new Error(String(error)))
        await release()
        starting = undefined
        throw error
      })
      return starting
    },
    waitForAttachment() {
      return attachment ?? Promise.reject(new Error('Chromium DevTools relay has not started'))
    },
    onDisconnect(listener) {
      disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
    stop() {
      if (stopping) return stopping
      if (!server && !sockets && shutdownError) return Promise.reject(shutdownError)
      stopping = (async () => {
        if (starting) await starting.catch(() => undefined)
        finishAttachment(new Error('Chromium DevTools relay stopped before attachment'))
        await release()
        starting = undefined
      })()
        .catch((error) => {
          shutdownError = error instanceof Error ? error : new Error(String(error))
          throw shutdownError
        })
        .finally(() => {
          stopping = undefined
        })
      return stopping
    },
  }
  return relay
}
