import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BROWSER_APPROVAL_RESPONSE_CHANNEL, BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL,
  type BrowserApprovalResponseRequest, type BrowserHistoryApprovalResponseRequest } from '../approval.ts'
import { registerBrowserApprovalIpc, registerBrowserHistoryApprovalIpc } from './approval.ts'

const request: BrowserApprovalResponseRequest = {
  sessionId: 'session-test', requestId: 'request-test', proofId: 'main-proof', turnId: 'turn-test',
  tabId: 'tab-test', targetInstanceId: 'instance-test', targetGeneration: 3,
  origin: 'https://example.org', action: 'read', intent: 'Read page',
  expiresAt: 2_000_000_000_000, decision: 'allow_once'
}
const scope = { sessionId: request.sessionId, instanceId: 'scope-instance', productTurnId: 'product-turn',
  turnId: request.turnId, generation: 1, interruptGeneration: 0, lifecycleEpoch: 1 }
const scopePayload = { instance_id: scope.instanceId, product_turn_id: scope.productTurnId,
  generation: scope.generation, interrupt_generation: scope.interruptGeneration, lifecycle_epoch: scope.lifecycleEpoch }

test('disabled browser refuses allow and deny before any pending fetch, proof or grant', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const contents = { mainFrame: {}, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' }
  const calls: string[] = []
  const owners = {
    enabled: () => false, contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173', rendererNavigationEpoch: () => 0,
    backendBase: () => { calls.push('backend'); return 'http://127.0.0.1:8765' },
    fetch: () => { calls.push('fetch'); throw new Error('unexpected fetch') }
  }
  const ipc = { handle(channel, handler) { handlers.set(channel, handler) } } as Parameters<typeof registerBrowserApprovalIpc>[0]
  registerBrowserApprovalIpc(ipc, owners as never)
  registerBrowserHistoryApprovalIpc(ipc, owners as never)
  for (const handler of handlers.values()) {
    for (const decision of ['allow_once', 'deny']) {
      assert.deepEqual(await handler({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent, { ...request, decision }), { ok: false, outcome: 'unknown' })
    }
  }
  assert.deepEqual(calls, [])
})

test('history approval IPC rejects untrusted senders and changed pending queries', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const historyRequest: BrowserHistoryApprovalResponseRequest = { sessionId: scope.sessionId,
    requestId: 'history-request', proofId: 'history-proof', turnId: scope.turnId,
    search: 'prior page', offset: 0, limit: 5, intent: 'Find a visit', queryDigest: 'a'.repeat(64),
    historyRevision: 3, expiresAt: 2_000_000_000_000, decision: 'allow_once' }
  const pending = { session_id: historyRequest.sessionId, request_id: historyRequest.requestId,
    turn_id: historyRequest.turnId, kind: 'browser_history_approval', method: 'browser_history_approval',
    search: historyRequest.search, offset: historyRequest.offset, limit: historyRequest.limit,
    intent: historyRequest.intent, proof_id: historyRequest.proofId,
    query_digest: historyRequest.queryDigest, history_revision: historyRequest.historyRevision,
    expires_at: historyRequest.expiresAt / 1000, state: 'pending', ...scopePayload }
  let pendingRow: Record<string, unknown> = pending
  let granted = 0
  let posts = 0
  registerBrowserHistoryApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents, rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => 0, backendBase: () => 'http://127.0.0.1:8765',
    activeScope: () => scope, historyProof: () => ({ proofId: historyRequest.proofId,
      requestId: historyRequest.requestId, scope, search: historyRequest.search,
      offset: historyRequest.offset, limit: historyRequest.limit, intent: historyRequest.intent,
      queryDigest: historyRequest.queryDigest, historyRevision: historyRequest.historyRevision,
      policyRevision: 1, expiresAt: historyRequest.expiresAt }),
    grantHistory: () => { granted += 1 }, hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    fetch: async (_url, init) => {
      if (init.method === 'POST') posts += 1
      return { ok: true, status: 200, json: async () => init.method === 'GET'
        ? { interactions: [pendingRow] }
        : { ok: true, request_id: historyRequest.requestId,
          interaction: { ...pending, state: 'resolved', decision: historyRequest.decision } } }
    }
  })
  const respond = handlers.get(BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  assert.deepEqual(await respond({ sender: contents, senderFrame: {} } as IpcMainInvokeEvent, historyRequest),
    { ok: false, outcome: 'unknown' })
  pendingRow = { ...pending, search: 'another page' }
  assert.deepEqual(await respond(event, historyRequest), { ok: false, outcome: 'unknown' })
  assert.equal(posts, 0)
  pendingRow = pending
  assert.equal((await respond(event, historyRequest) as { ok: boolean }).ok, true)
  assert.equal(posts, 1)
  assert.equal(granted, 1)
})

test('history approval never sends a host-key decision after renderer navigation', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  let navigationEpoch = 0
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const historyRequest: BrowserHistoryApprovalResponseRequest = { sessionId: scope.sessionId,
    requestId: 'history-navigation-race', proofId: 'history-proof', turnId: scope.turnId,
    search: 'prior page', offset: 0, limit: 5, intent: 'Find a visit', queryDigest: 'a'.repeat(64),
    historyRevision: 3, expiresAt: 2_000_000_000_000, decision: 'allow_once' }
  const pending = { session_id: historyRequest.sessionId, request_id: historyRequest.requestId,
    turn_id: historyRequest.turnId, kind: 'browser_history_approval', method: 'browser_history_approval',
    search: historyRequest.search, offset: historyRequest.offset, limit: historyRequest.limit,
    intent: historyRequest.intent, proof_id: historyRequest.proofId,
    query_digest: historyRequest.queryDigest, history_revision: historyRequest.historyRevision,
    expires_at: historyRequest.expiresAt / 1000, state: 'pending', ...scopePayload }
  let releaseLookup!: () => void
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
  const sent: string[] = []
  registerBrowserHistoryApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents, rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => navigationEpoch, backendBase: () => 'http://127.0.0.1:8765',
    activeScope: () => scope, historyProof: () => ({ proofId: historyRequest.proofId,
      requestId: historyRequest.requestId, scope, search: historyRequest.search,
      offset: historyRequest.offset, limit: historyRequest.limit, intent: historyRequest.intent,
      queryDigest: historyRequest.queryDigest, historyRevision: historyRequest.historyRevision,
      policyRevision: 1, expiresAt: historyRequest.expiresAt }),
    grantHistory: () => { throw new Error('history grant must not be minted') },
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    fetch: async (_url, init) => {
      sent.push(init.method ?? '')
      if (init.method === 'GET') await lookupGate
      return { ok: true, status: 200, json: async () => ({ interactions: [pending] }) }
    }
  })
  const respond = handlers.get(BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL)!
  const pendingResponse = respond({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, historyRequest)
  assert.deepEqual(sent, ['GET'])
  navigationEpoch += 1
  releaseLookup()
  assert.deepEqual(await pendingResponse, { ok: false, outcome: 'unknown' })
  assert.deepEqual(sent, ['GET'])
})

test('browser approval IPC binds main frame, pending card, live tab, and host-only response', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  let rendererUrl = 'http://127.0.0.1:5173/'
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => rendererUrl } as WebContents
  const sent: Array<{ url: string; init: RequestInit }> = []
  const granted: string[] = []
  const pending = { session_id: request.sessionId, request_id: request.requestId, turn_id: request.turnId,
    kind: 'browser_approval', method: 'browser_approval', tab_id: request.tabId,
    target_instance_id: request.targetInstanceId, target_generation: request.targetGeneration, origin: request.origin,
    action: request.action, intent: request.intent, proof_id: request.proofId,
    expires_at: request.expiresAt / 1000, state: 'pending', ...scopePayload }
  let currentPending: Record<string, unknown> = pending
  let tabUrl = 'https://example.org/page'
  let targetGeneration = request.targetGeneration
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => 0,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => ({ instanceId: request.targetInstanceId, generation: targetGeneration, origin: new URL(tabUrl).origin }),
    activeScope: () => scope,
    readProof: () => ({ proofId: request.proofId, requestId: request.requestId, scope,
      tabId: request.tabId, target: { instanceId: request.targetInstanceId,
        generation: request.targetGeneration, origin: request.origin }, intent: request.intent,
      expiresAt: request.expiresAt, policyRevision: 1, policyDecision: 'ask' }),
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    grantRead: request => { granted.push(request.requestId) },
    fetch: async (url, init) => {
      sent.push({ url, init })
      return { ok: true, status: 200, json: async () => init.method === 'POST'
        ? { ok: true, request_id: request.requestId, interaction: { ...pending, state: 'resolved', decision: (JSON.parse(String(init.body)) as { decision: string }).decision } }
        : { interactions: [currentPending] } }
    }
  })
  const respond = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  for (const invalid of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) {
    assert.deepEqual(await respond(invalid as IpcMainInvokeEvent, request), { ok: false, outcome: 'unknown' })
  }
  assert.equal(sent.length, 0)
  rendererUrl = 'https://attacker.example/'
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  assert.equal(sent.length, 0)
  rendererUrl = 'http://127.0.0.1:5173/'
  assert.deepEqual(await respond(event, { ...request, turnId: 'other-turn' }), { ok: false, outcome: 'unknown' })
  assert.equal(sent.length, 1)
  currentPending = { ...pending, origin: 'https://other.org' }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, target_instance_id: '' }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, target_generation: request.targetGeneration + 1 }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, generation: scope.generation - 1 }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, instance_id: undefined }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, proof_id: 'forged-proof' }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = { ...pending, proof_id: undefined }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  currentPending = pending
  assert.deepEqual(await respond(event, { ...request, proofId: 'forged-proof' }), { ok: false, outcome: 'unknown' })
  tabUrl = 'https://other.org/page'
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  assert.deepEqual(await respond(event, { ...request, decision: 'deny' }), { ok: true, request_id: request.requestId, interaction: { ...pending, state: 'resolved', decision: 'deny' } })
  assert.deepEqual(granted, [])
  tabUrl = 'https://example.org/page'
  assert.deepEqual(await respond(event, request), { ok: true, request_id: request.requestId, interaction: { ...pending, state: 'resolved', decision: 'allow_once' } })
  assert.deepEqual(granted, [request.requestId])
  assert.equal(sent.filter(call => call.init.method === 'POST').length, 2)
  const posted = sent.at(-1)!
  assert.equal(posted.init.headers && (posted.init.headers as Record<string, string>)['X-ScholarSeed-Host-Key'], 'host-secret')
  assert.deepEqual(JSON.parse(String(posted.init.body)), { decision: 'allow_once' })
  targetGeneration += 1
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  assert.equal(sent.filter(call => call.init.method === 'POST').length, 2)
})

test('navigation during pending lookup never sends a host-key approval', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  let rendererUrl = 'http://127.0.0.1:5173/'
  let navigationEpoch = 0
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => rendererUrl } as WebContents
  let releaseLookup!: () => void
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
  const sent: string[] = []
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => navigationEpoch,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => ({ instanceId: request.targetInstanceId, generation: request.targetGeneration, origin: request.origin }),
    activeScope: () => scope,
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    fetch: async (url, init) => {
      sent.push(init.method ?? '')
      if (init.method === 'GET') await lookupGate
      return { ok: true, status: 200, json: async () => init.method === 'GET'
        ? { interactions: [{ session_id: request.sessionId, request_id: request.requestId, turn_id: request.turnId,
          kind: 'browser_approval', method: 'browser_approval', tab_id: request.tabId,
          target_instance_id: request.targetInstanceId, target_generation: request.targetGeneration, origin: request.origin,
          action: request.action, intent: request.intent, proof_id: request.proofId,
          expires_at: request.expiresAt / 1000, state: 'pending', ...scopePayload }] }
        : { ok: true, interaction: { state: 'resolved', decision: 'allow_once' } } }
    }
  })
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const result = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!(event, request)
  assert.deepEqual(sent, ['GET'])
  rendererUrl = 'http://127.0.0.1:5173/another-page'
  navigationEpoch += 1
  releaseLookup()
  assert.deepEqual(await result, { ok: false, outcome: 'unknown' })
  assert.deepEqual(sent, ['GET'])
})

test('allow-once never mints a read grant from an unbound HIL response', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const pending = { session_id: request.sessionId, request_id: request.requestId, turn_id: request.turnId,
    kind: 'browser_approval', method: 'browser_approval', tab_id: request.tabId,
    target_instance_id: request.targetInstanceId, target_generation: request.targetGeneration,
    origin: request.origin, action: request.action, intent: request.intent,
    proof_id: request.proofId, expires_at: request.expiresAt / 1000, state: 'pending', ...scopePayload }
  let result: Record<string, unknown> = { ok: true, request_id: 'other-request',
    interaction: { ...pending, state: 'resolved', decision: 'allow_once' } }
  let minted = 0
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => 0,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => ({ instanceId: request.targetInstanceId, generation: request.targetGeneration, origin: request.origin }),
    activeScope: () => scope,
    readProof: () => ({ proofId: request.proofId, requestId: request.requestId, scope,
      tabId: request.tabId, target: { instanceId: request.targetInstanceId,
        generation: request.targetGeneration, origin: request.origin }, intent: request.intent,
      expiresAt: request.expiresAt, policyRevision: 1, policyDecision: 'ask' }),
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    grantRead: () => { minted += 1 },
    fetch: async (_url, init) => ({ ok: true, status: 200,
      json: async () => init.method === 'POST' ? result : { interactions: [pending] } })
  })
  const respond = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  result = { ok: true, request_id: request.requestId,
    interaction: { ...pending, turn_id: 'other-turn', state: 'resolved', decision: 'allow_once' } }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  result = { ok: true, request_id: request.requestId,
    interaction: { ...pending, generation: scope.generation - 1, state: 'resolved', decision: 'allow_once' } }
  assert.deepEqual(await respond(event, request), { ok: false, outcome: 'unknown' })
  assert.equal(minted, 0)
})

test('late allow-once response for an ended scope cannot mint into the successor scope', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const pending = { session_id: request.sessionId, request_id: request.requestId, turn_id: request.turnId,
    kind: 'browser_approval', method: 'browser_approval', tab_id: request.tabId,
    target_instance_id: request.targetInstanceId, target_generation: request.targetGeneration,
    origin: request.origin, action: request.action, intent: request.intent,
    proof_id: request.proofId, expires_at: request.expiresAt / 1000, state: 'pending', ...scopePayload }
  let activeScope = scope
  let releasePost!: () => void
  const postGate = new Promise<void>(resolve => { releasePost = resolve })
  let postStarted!: () => void
  const postStart = new Promise<void>(resolve => { postStarted = resolve })
  let minted = 0
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => 0,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => ({ instanceId: request.targetInstanceId, generation: request.targetGeneration, origin: request.origin }),
    activeScope: () => activeScope,
    readProof: () => ({ proofId: request.proofId, requestId: request.requestId, scope,
      tabId: request.tabId, target: { instanceId: request.targetInstanceId,
        generation: request.targetGeneration, origin: request.origin }, intent: request.intent,
      expiresAt: request.expiresAt, policyRevision: 1, policyDecision: 'ask' }),
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    grantRead: () => { minted += 1 },
    fetch: async (_url, init) => {
      if (init.method === 'POST') { postStarted(); await postGate }
      return { ok: true, status: 200, json: async () => init.method === 'POST'
        ? { ok: true, request_id: request.requestId, interaction: { ...pending, state: 'resolved', decision: 'allow_once' } }
        : { interactions: [pending] } }
    }
  })
  const respond = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!
  const result = respond({ sender: contents, senderFrame: frame } as IpcMainInvokeEvent, request)
  await postStart
  activeScope = { ...scope, generation: scope.generation + 1 }
  releasePost()
  assert.deepEqual(await result, { ok: false, outcome: 'unknown' })
  assert.equal(minted, 0)
})

test('navigate approval binds source and destination before minting a one-time grant', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const navigationRequest = { ...request, action: 'navigate', origin: 'https://destination.example',
    sourceOrigin: null, destinationUrl: 'https://destination.example/path',
    destinationOrigin: 'https://destination.example' }
  const pending = { session_id: request.sessionId, request_id: request.requestId, turn_id: request.turnId,
    kind: 'browser_approval', method: 'browser_approval', tab_id: request.tabId,
    target_instance_id: request.targetInstanceId, target_generation: request.targetGeneration,
    origin: navigationRequest.origin, source_origin: null,
    destination_url: navigationRequest.destinationUrl, destination_origin: navigationRequest.destinationOrigin,
    action: 'navigate', intent: request.intent, proof_id: request.proofId,
    expires_at: request.expiresAt / 1000, state: 'pending', ...scopePayload }
  let currentPending: Record<string, unknown> = pending
  let currentResolved: Record<string, unknown> = pending
  let currentTarget: { instanceId: string; generation: number; origin: string | null; url: string } = {
    instanceId: request.targetInstanceId, generation: request.targetGeneration, origin: null, url: 'about:blank'
  }
  let minted = 0
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    rendererNavigationEpoch: () => 0,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => null,
    browserNavigateTarget: () => currentTarget,
    activeScope: () => scope,
    navigateProof: () => ({ proofId: request.proofId, requestId: request.requestId, scope,
      tabId: request.tabId, source: { instanceId: request.targetInstanceId,
        generation: request.targetGeneration, origin: null }, url: navigationRequest.destinationUrl,
      destinationOrigin: navigationRequest.destinationOrigin, intent: request.intent,
      expiresAt: request.expiresAt, policyRevision: 1, policyDecision: 'ask' }),
    grantNavigate: () => { minted += 1 },
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    fetch: async (_url, init) => ({ ok: true, status: 200, json: async () => init.method === 'POST'
      ? { ok: true, request_id: request.requestId, interaction: { ...currentResolved, state: 'resolved', decision: 'allow_once' } }
      : { interactions: [currentPending] } })
  })
  const respond = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  currentPending = { ...pending, destination_url: 'https://attacker.example/' }
  assert.deepEqual(await respond(event, navigationRequest), { ok: false, outcome: 'unknown' })
  currentPending = pending
  assert.deepEqual(await respond(event, { ...navigationRequest, destinationOrigin: 'https://attacker.example' }),
    { ok: false, outcome: 'unknown' })
  currentTarget = { ...currentTarget, url: 'https://destination.example/path' }
  assert.deepEqual(await respond(event, navigationRequest), { ok: false, outcome: 'unknown' })
  currentTarget = { ...currentTarget, url: 'about:blank' }
  currentResolved = { ...pending, destination_origin: 'https://attacker.example' }
  assert.deepEqual(await respond(event, navigationRequest), { ok: false, outcome: 'unknown' })
  currentResolved = pending
  assert.equal((await respond(event, navigationRequest) as { ok: boolean }).ok, true)
  assert.equal(minted, 1)
})

test('action approval binds structured element and Main proof before minting', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const frame = {}
  const contents = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => 'http://127.0.0.1:5173/' } as WebContents
  const actionRequest: BrowserApprovalResponseRequest = { ...request, requestId: 'action-request',
    proofId: 'action-proof', action: 'fill', browserAction: 'fill', intent: 'Search',
    preparedId: 'prepared', snapshotId: 'snapshot', elementRef: 'ref', element: { role: 'textbox', name: 'Query' } }
  const pending = { session_id: actionRequest.sessionId, request_id: actionRequest.requestId,
    turn_id: actionRequest.turnId, kind: 'browser_approval', method: 'browser_approval',
    tab_id: actionRequest.tabId, target_instance_id: actionRequest.targetInstanceId,
    target_generation: actionRequest.targetGeneration, origin: actionRequest.origin,
    action: 'fill', browser_action: 'fill', intent: actionRequest.intent, proof_id: actionRequest.proofId,
    prepared_id: actionRequest.preparedId, snapshot_id: actionRequest.snapshotId,
    element_ref: actionRequest.elementRef, element: actionRequest.element,
    expires_at: actionRequest.expiresAt / 1000, state: 'pending', ...scopePayload }
  let currentPending: Record<string, unknown> = pending
  let currentResolved: Record<string, unknown> = pending
  let proofName = 'Query'
  let minted = 0
  registerBrowserApprovalIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents, rendererOrigin: () => 'http://127.0.0.1:5173', rendererNavigationEpoch: () => 0,
    backendBase: () => 'http://127.0.0.1:8765',
    browserTarget: () => ({ instanceId: actionRequest.targetInstanceId,
      generation: actionRequest.targetGeneration, origin: actionRequest.origin }),
    activeScope: () => scope,
    actionProof: () => ({ id: 'prepared', proofId: 'action-proof', requestId: 'action-request', action: 'fill',
      scope, tabId: actionRequest.tabId, target: { tabId: actionRequest.tabId,
        instanceId: actionRequest.targetInstanceId, generation: actionRequest.targetGeneration,
        origin: actionRequest.origin, title: 'Page', url: 'https://example.org/page' },
      snapshotId: 'snapshot', elementRef: 'ref', backendNodeId: 7,
      grantId: 'read-grant', grantRequestId: 'read-request', grantRevision: 1,
      revocationEpoch: 0, expiresAt: actionRequest.expiresAt, consequential: true,
      intent: actionRequest.intent, element: { role: 'textbox', name: proofName } }),
    grantAction: () => { minted += 1 },
    hostHeader: () => ({ 'X-ScholarSeed-Host-Key': 'host-secret' }),
    fetch: async (_url, init) => ({ ok: true, status: 200, json: async () => init.method === 'POST'
      ? { ok: true, request_id: actionRequest.requestId,
        interaction: { ...currentResolved, state: 'resolved', decision: 'allow_once' } }
      : { interactions: [currentPending] } })
  })
  const respond = handlers.get(BROWSER_APPROVAL_RESPONSE_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  currentPending = { ...pending, element: { role: 'textbox', name: 'Pay now' } }
  assert.deepEqual(await respond(event, actionRequest), { ok: false, outcome: 'unknown' })
  currentPending = pending
  proofName = 'Pay now'
  assert.deepEqual(await respond(event, actionRequest), { ok: false, outcome: 'unknown' })
  proofName = 'Query'
  currentResolved = { ...pending, snapshot_id: 'other-snapshot' }
  assert.deepEqual(await respond(event, actionRequest), { ok: false, outcome: 'unknown' })
  currentResolved = pending
  assert.equal((await respond(event, actionRequest) as { ok: boolean }).ok, true)
  assert.equal(minted, 1)
})
