import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import electron from 'electron'
import type { WebContents } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserRegistry } from './browser.ts'
import { BROWSER_CDP_STATUS, BROWSER_ERROR } from '../browser.ts'

export const MAX_CDP_FRAME_BYTES = 1024 * 1024
const LOOPBACK = '127.0.0.1'
const ENDPOINT_PREFIX = '/devtools/browser/'
const TOKEN_BYTES = 32
const MAX_CLIENTS = 4
const MAX_PENDING_COMMANDS = 64
const MAX_METHOD_LENGTH = 100
const MAX_HTTP_CONNECTIONS = 32
const HTTP_HANDSHAKE_TIMEOUT_MS = 10_000
const PROTOCOL_ERROR = -32000
const CONTEXT_ID = 'scholarseed-browser'
const METHODS = new Set([
  'Page.enable', 'Page.getFrameTree', 'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.createIsolatedWorld', 'Page.captureScreenshot', 'Page.getLayoutMetrics',
  'Page.bringToFront', 'Page.reload', 'Page.handleJavaScriptDialog',
  'Runtime.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Runtime.getProperties', 'Runtime.runIfWaitingForDebugger', 'Runtime.addBinding',
  'Log.enable', 'Network.enable', 'Network.setCacheDisabled', 'Network.setExtraHTTPHeaders', 'Network.getResponseBody',
  'DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getDocument',
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent',
  'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia', 'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled', 'Emulation.setScriptExecutionDisabled'
])

export interface CdpBroker {
  start(): Promise<{ port: number }>
  stop(): Promise<void>
  copyEndpoint(): void
  disconnectTab(tabId: string, reason: string): void
  syncTargets(): Promise<void>
}

interface BrokerOptions {
  publish(status: { enabled: boolean; port: number | null }): void
  log(message: string): void
}

export function authorizedUpgrade(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`${ENDPOINT_PREFIX}${token}`)
  const received = Buffer.from(request.url ?? '')
  return request.socket.remoteAddress === LOOPBACK
    && request.headers.host === `${LOOPBACK}:${request.socket.localPort}`
    && request.headers.origin === undefined
    && expected.length === received.length && timingSafeEqual(expected, received)
}

interface SessionBinding {
  tabId: string
  targetId: string
  contents: WebContents
  nativeSession?: string
}

interface CdpClient {
  disconnectTab(tabId: string, reason: string): void
  syncTargets(): Promise<void>
}

export function acceptCdpClient(client: WebSocket, registry: BrowserRegistry, log: (message: string) => void = () => {}): CdpClient {
  const targets = new Map<string, string>()
  const sessions = new Map<string, SessionBinding>()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const frameIds = new Map<string, string>()
  const attaching = new Map<string, Promise<string>>()
  const leases = new Map<string, WebContents>()
  const detachedTabs = new Set<string>()
  let autoAttach = false
  let discovering = false
  let pendingCommands = 0
  const exposeFrame = (native: string) => {
    if (!frameIds.has(native)) frameIds.set(native, randomUUID())
    return frameIds.get(native)!
  }
  const nativeFrame = (exposed: string) => {
    const native = [...frameIds].find(([, candidate]) => candidate === exposed)?.[0]
    if (!native) throw new Error('unknown_frame')
    return native
  }
  const translate = (value: unknown, reverse = false, owner = ''): unknown => {
    if (owner === 'value') return value
    if (Array.isArray(value)) return value.map(item => translate(item, reverse, owner))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      (['frameId', 'parentFrameId', 'parentId', 'targetId', 'openerId'].includes(key) || key === 'id' && owner === 'frame') && typeof item === 'string'
        ? reverse ? nativeFrame(item) : exposeFrame(item)
        : translate(item, reverse, key)]))
    return value
  }
  const send = (message: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)) }
  const event = (method: string, params: object, sessionId?: string) => send({ method, params, ...(sessionId ? { sessionId } : {}) })
  const info = (targetId: string, tabId: string) => {
    const contents = registry.externalTarget(tabId)
    return { targetId, type: 'page', title: contents.getTitle(), url: contents.getURL(), attached: [...sessions.values()].some(value => value.tabId === tabId), browserContextId: CONTEXT_ID, canAccessOpener: false }
  }
  const refresh = () => {
    const eligible = new Set(registry.externalTabIds())
    for (const tabId of eligible) if (![...targets.values()].includes(tabId)) targets.set(randomUUID(), tabId)
    return [...targets].filter(([, tabId]) => eligible.has(tabId)).map(([targetId, tabId]) => info(targetId, tabId))
  }
  const disconnect = (tabId: string, reason: string) => {
    detachedTabs.add(tabId)
    const contents = leases.get(tabId)
    leases.delete(tabId)
    for (const [sessionId, binding] of [...sessions]) if (binding.tabId === tabId) {
      sessions.delete(sessionId)
      event('Target.detachedFromTarget', { sessionId, targetId: binding.targetId, reason })
    }
    const listener = listeners.get(tabId)
    listeners.delete(tabId)
    try {
      if (contents && listener) contents.debugger.removeListener('message', listener)
      if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
    } catch { log('[browser-cdp] target already closed') }
  }
  const unsubscribe = registry.onDebuggerDetach(disconnect)
  const attach = async (targetId: string) => {
    const tabId = targets.get(targetId)
    if (!tabId) throw new Error('unknown_target')
    registry.externalTarget(tabId)
    const existing = [...sessions].find(([, value]) => value.tabId === tabId && !value.nativeSession)
    if (existing) return existing[0]
    const contents = registry.attachExternal(tabId)
    leases.set(tabId, contents)
    detachedTabs.delete(tabId)
    const initialTree = await contents.debugger.sendCommand('Page.getFrameTree').catch(error => {
      if (leases.get(tabId) === contents) disconnect(tabId, BROWSER_ERROR.targetClosed)
      throw error
    })
    if (client.readyState !== WebSocket.OPEN) {
      if (leases.get(tabId) === contents) disconnect(tabId, 'client_closed')
      throw new Error('client_closed')
    }
    if (leases.get(tabId) !== contents || registry.externalTarget(tabId) !== contents) throw new Error(BROWSER_ERROR.targetClosed)
    frameIds.set(initialTree.frameTree.frame.id, targetId)
    const sessionId = randomUUID()
    sessions.set(sessionId, { tabId, targetId, contents })
    const listener = (...args: unknown[]) => {
      const [, method, parameters, nativeSession] = args as [unknown, string, Record<string, unknown>, string | undefined]
      const ownerSession = nativeSession ? [...sessions].find(([, value]) => value.contents === contents && value.nativeSession === nativeSession)?.[0] : sessionId
      if (!ownerSession) return
      if (method === 'Target.attachedToTarget') {
        log('[browser-cdp] child target attached')
        const targetInfo = parameters.targetInfo as Record<string, unknown>
        if (targetInfo.type !== 'iframe') {
          void contents.debugger.sendCommand('Target.detachFromTarget', { sessionId: parameters.sessionId }, nativeSession).catch(() => {})
          return
        }
        const childSession = randomUUID()
        const childTarget = exposeFrame(String(targetInfo.targetId))
        sessions.set(childSession, { tabId, targetId: childTarget, contents, nativeSession: String(parameters.sessionId) })
        event(method, { ...parameters, sessionId: childSession, targetInfo: { ...targetInfo, targetId: childTarget, browserContextId: CONTEXT_ID } }, ownerSession)
      } else if (method === 'Target.detachedFromTarget') {
        const child = [...sessions].find(([, binding]) => binding.contents === contents && binding.nativeSession === parameters.sessionId)
        if (child) {
          sessions.delete(child[0])
          event(method, { sessionId: child[0], targetId: child[1].targetId }, ownerSession)
        }
      } else if (!method.startsWith('Target.')) event(method, translate(parameters) as object, ownerSession)
    }
    listeners.set(tabId, listener)
    contents.debugger.on('message', listener)
    event('Target.attachedToTarget', { sessionId, targetInfo: info(targetId, tabId), waitingForDebugger: false })
    return sessionId
  }
  const attachOnce = (targetId: string): Promise<string> => {
    const pending = attaching.get(targetId)
    if (pending) return pending
    const result = Promise.resolve().then(() => attach(targetId)).finally(() => attaching.delete(targetId))
    attaching.set(targetId, result)
    return result
  }
  const syncTargets = async () => {
    if (client.readyState !== WebSocket.OPEN) return
    const previous = new Set(targets.keys())
    const current = refresh()
    for (const [targetId, tabId] of [...targets]) if (!current.some(target => target.targetId === targetId)) {
      disconnect(tabId, 'target_closed')
      targets.delete(targetId)
      event('Target.targetDestroyed', { targetId })
    }
    for (const targetInfo of current) {
      if (discovering && !previous.has(targetInfo.targetId)) event('Target.targetCreated', { targetInfo })
      const tabId = targets.get(targetInfo.targetId)!
      const tab = registry.snapshot().tabs.find(candidate => candidate.tabId === tabId)
      if (autoAttach && !detachedTabs.has(tabId) && !tab?.devtoolsOpen && tab?.cdpStatus !== BROWSER_CDP_STATUS.conflict) {
        await attachOnce(targetInfo.targetId).catch(() => log('[browser-cdp] target unavailable'))
      }
    }
  }
  client.on('message', data => {
    if (pendingCommands >= MAX_PENDING_COMMANDS) { client.close(1008, 'command_limit'); return }
    pendingCommands += 1
    void (async () => {
      let request: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
      try { request = JSON.parse(data.toString()) } catch { client.close(1007, 'invalid_json'); return }
      if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string' || request.method.length > MAX_METHOD_LENGTH || !/^[A-Za-z]+\.[A-Za-z]+$/.test(request.method) || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)))) { client.close(1007, 'invalid_request'); return }
      const { id, method, sessionId } = request
      const params = request.params ?? {}
      log(`[browser-cdp] command ${method}`)
      try {
        let result: unknown = {}
        if (sessionId) {
          const binding = sessions.get(sessionId)
          if (!binding || registry.externalTarget(binding.tabId) !== binding.contents) throw new Error('unknown_session')
          if (method === 'Page.navigate') {
            if (binding.nativeSession || typeof params.url !== 'string' || params.frameId && params.frameId !== binding.targetId) throw new Error('navigation_denied')
            await registry.navigate(binding.tabId, params.url)
            const tree = await binding.contents.debugger.sendCommand('Page.getFrameTree')
            result = { frameId: binding.targetId, loaderId: tree.frameTree.frame.loaderId }
          } else {
            if (method === 'Target.setAutoAttach') {
              if (params.flatten !== true) throw new Error('flatten_required')
            } else if (!METHODS.has(method)) throw new Error('unsupported_cdp_method')
            result = translate(await binding.contents.debugger.sendCommand(method, translate(params, true) as Record<string, unknown>, binding.nativeSession))
          }
        } else {
          switch (method) {
            case 'Browser.getVersion': result = { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: electron.app.userAgentFallback, jsVersion: process.versions.v8 }; break
            case 'Browser.setDownloadBehavior':
              if (params.browserContextId && params.browserContextId !== CONTEXT_ID) throw new Error('unknown_context')
              log('[browser-cdp] client download behavior ignored; product download policy remains in force'); break
            case 'Target.getTargetInfo': {
              const pages = refresh()
              if (params.targetId) {
                const target = pages.find(value => value.targetId === params.targetId)
                if (!target) throw new Error('unknown_target')
                result = { targetInfo: target }
              } else result = { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, browserContextId: CONTEXT_ID } }
              break
            }
            case 'Target.getTargets': result = { targetInfos: refresh() }; break
            case 'Target.setDiscoverTargets': discovering = params.discover === true; if (discovering) for (const targetInfo of refresh()) event('Target.targetCreated', { targetInfo }); break
            case 'Target.setAutoAttach':
              if (params.flatten !== true) throw new Error('flatten_required')
              autoAttach = params.autoAttach === true
              if (autoAttach) for (const target of refresh()) {
                const tabId = targets.get(target.targetId)!
                const tab = registry.snapshot().tabs.find(candidate => candidate.tabId === tabId)
                if (tab?.devtoolsOpen || tab?.cdpStatus === BROWSER_CDP_STATUS.conflict) continue
                await attachOnce(target.targetId).catch(error => {
                  if (error instanceof Error && error.message === BROWSER_ERROR.devtoolsConflict) return
                  throw error
                })
              }
              break
            case 'Target.attachToTarget':
              if (params.flatten !== true) throw new Error('flatten_required')
              refresh(); result = { sessionId: await attachOnce(String(params.targetId)) }; break
            default: throw new Error('unsupported_cdp_method')
          }
        }
        log(`[browser-cdp] completed ${method}`)
        send({ id, result, ...(sessionId ? { sessionId } : {}) })
      } catch (error) {
        log(`[browser-cdp] rejected ${method}`)
        send({ id, error: { code: PROTOCOL_ERROR, message: error instanceof Error ? error.message : BROWSER_ERROR.operationFailed }, ...(sessionId ? { sessionId } : {}) })
      }
    })().catch(() => client.close(1011, 'command_failed')).finally(() => { pendingCommands -= 1 })
  })
  client.on('error', () => log('[browser-cdp] transport error'))
  client.once('close', () => { unsubscribe(); for (const tabId of [...leases.keys()]) disconnect(tabId, 'client_closed') })
  return { disconnectTab: disconnect, syncTargets }
}

export function createCdpBroker(registry: BrowserRegistry, options: BrokerOptions): CdpBroker {
  let server: Server | null = null
  let sockets: WebSocketServer | null = null
  let endpoint: string | null = null
  let port: number | null = null
  let starting: Promise<{ port: number }> | null = null
  let stopping: Promise<void> | null = null
  const disconnectors = new Map<WebSocket, CdpClient>()
  const release = async () => {
    const closingServer = server
    const closingSockets = sockets
    server = null; sockets = null; endpoint = null; port = null
    for (const client of disconnectors.keys()) client.terminate()
    if (closingSockets) await new Promise<void>(resolve => closingSockets.close(() => resolve()))
    closingServer?.closeAllConnections()
    if (closingServer) await new Promise<void>(resolve => closingServer.close(() => resolve()))
  }
  return {
    start() {
      if (stopping) return stopping.then(() => this.start())
      if (starting) return starting
      starting = (async () => {
        const token = randomBytes(TOKEN_BYTES).toString('hex')
        server = createServer((_request, response) => { response.writeHead(404); response.end() })
        server.maxConnections = MAX_HTTP_CONNECTIONS
        server.headersTimeout = HTTP_HANDSHAKE_TIMEOUT_MS
        server.requestTimeout = HTTP_HANDSHAKE_TIMEOUT_MS
        sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_FRAME_BYTES, perMessageDeflate: false })
        server.on('upgrade', (request, socket, head) => {
          if (!sockets || sockets.clients.size >= MAX_CLIENTS || !authorizedUpgrade(request, token)) { socket.destroy(); return }
          sockets.handleUpgrade(request, socket, head, client => {
            disconnectors.set(client, acceptCdpClient(client, registry, options.log))
            client.once('close', () => disconnectors.delete(client))
          })
        })
        await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, LOOPBACK, resolve) })
        port = (server.address() as { port: number }).port
        endpoint = `ws://${LOOPBACK}:${port}${ENDPOINT_PREFIX}${token}`
        options.publish({ enabled: true, port })
        return { port }
      })().catch(async error => {
        await release()
        starting = null
        options.publish({ enabled: false, port: null })
        throw error
      })
      return starting
    },
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (starting) await starting.catch(() => undefined)
        await release()
        starting = null
        options.publish({ enabled: false, port: null })
      })().finally(() => { stopping = null })
      return stopping
    },
    copyEndpoint() { if (!endpoint) throw new Error('cdp_disabled'); electron.clipboard.writeText(endpoint) },
    disconnectTab(tabId, reason) { for (const connection of disconnectors.values()) connection.disconnectTab(tabId, reason) },
    async syncTargets() { await Promise.all([...disconnectors.values()].map(connection => connection.syncTargets())) }
  }
}
