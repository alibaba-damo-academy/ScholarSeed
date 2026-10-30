import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AgentPreparedAction, AgentReadElement, AgentReadSnapshot } from './agent.ts'
import { agentFailureCode, OBSERVATION_READ_REQUIRED } from './agent.ts'
import type { BrowserNavigateProof, BrowserReadProof } from './grant.ts'
import type { BrowserHistoryPage } from '../browser.ts'
import type { HistoryAgentProof } from './history.ts'

const FAILURE_CODES = {
  browserUnavailable: 'browser_unavailable',
  forbidden: 'forbidden',
  notFound: 'not_found',
  unauthorized: 'unauthorized',
  requestTooLarge: 'request_too_large',
  invalidRequest: 'invalid_request',
  requestCapacityExhausted: 'request_capacity_exhausted',
  staleScope: 'stale_scope',
  requestIdConflict: 'request_id_conflict',
  requestUnknown: 'request_unknown',
  requestExpired: 'request_expired',
  navigationCancelledBeforeDispatch: 'navigation_cancelled_before_dispatch',
  actionCancelledBeforeDispatch: 'action_cancelled_before_dispatch',
  browserActionUnavailable: 'browser_action_unavailable',
} as const

const HOST = '127.0.0.1'
const ROUTE = '/agent/browser'
const OPEN_ACTION = 'open'
const CLOSE_ACTION = 'close'
const KEY_HEADER = 'x-scholarseed-agent-key'
const MAX_REQUEST_BYTES = 16_384
const MAX_RESPONSE_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 10_000
const SCOPE_END_RESPONSE_GRACE_MS = 1_000
const ACTION_TIMEOUT_MS = 30_000
const MAX_ID_CHARS = 128
const MAX_INTENT_CHARS = 512
const MAX_NAVIGATE_URL_CHARS = 8_192
const MAX_FILL_CHARS = 4_096
const MAX_REPLAY_RECORDS = 4096
const MAX_SCOPE_RECORDS = 4096
const MAX_CONNECTIONS = 32
const MAX_ACTIVE_REQUESTS = 16
const MAX_SEARCH_QUERY_CHARS = 512
const MAX_SEARCH_RESULTS = 20
const STALE_ACTION_REFERENCES = new Set(['stale_grant', 'stale_ref'])
const STALE_REFERENCE = 'stale_ref'
const SNAPSHOT_FAILURE_CODES = new Set(['snapshot_too_large', 'snapshot_timeout'])
const SCOPE_UNSETTLED = 'scope_unsettled'
enum ScopeDrainPhase {
  Requests = 'requests',
  Effects = 'effects',
  Leases = 'leases',
}
enum ScopeDrainResult {
  Settled,
  Unsettled,
  Failed,
}

export interface BrowserSearchInput {
  scope: AgentScope
  requestId: string
  engine: string
  query: string
  limit: number
  signal: AbortSignal
}

export type BrowserSearchAction = (input: BrowserSearchInput) => Promise<unknown>

export class BrowserSearchError extends Error {}

export interface AgentScope {
  sessionId: string
  instanceId: string
  productTurnId: string
  turnId: string
  generation: number
  interruptGeneration: number
  lifecycleEpoch: number
}

interface ScopeRecord {
  identity: AgentScope
  closeIdentity?: AgentScope
  closeControllers?: Set<AbortController>
  closed: boolean
  endComplete: boolean
  controllers: Set<AbortController>
  inFlight: Set<Promise<void>>
  requests: Map<
    string,
    {
      signature: string
      listRevision: number | null
      result: Promise<{ status: number; body: unknown }>
    }
  >
}

export interface AgentTransport {
  port: number
  key: string
  activeScope(sessionId: string, turnId: string): AgentScope | null
  onScopeEnd(listener: (scope: AgentScope) => void): () => void
  close(): Promise<void>
}

type BrowserList = () => unknown | Promise<unknown>
type BrowserPrepareRead = (input: {
  scope: AgentScope
  requestId: string
  tabId: string
  intent: string
}) => BrowserReadProof | Promise<BrowserReadProof>
interface BrowserReadActions {
  snapshot(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId: string
    tabId: string
    signal: AbortSignal
  }): AgentReadSnapshot | Promise<AgentReadSnapshot>
  read(input: {
    scope: AgentScope
    requestId: string
    tabId: string
    snapshotId: string
    elementRef: string
    signal: AbortSignal
  }): AgentReadElement | Promise<AgentReadElement>
  cancel?(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    tabId: string
  }): void | Promise<void>
}

interface BrowserNavigateActions {
  close?(input: {
    scope: AgentScope
    requestId: string
    tabId: string
    signal: AbortSignal
  }): void | Promise<void>
  open?(input: {
    scope: AgentScope
    requestId: string
    signal: AbortSignal
  }): Promise<{ tabId: string; close(): void }>
  prepare(input: {
    scope: AgentScope
    requestId: string
    tabId: string
    url: string
    intent: string
  }): BrowserNavigateProof | Promise<BrowserNavigateProof>
  execute(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId: string
    tabId: string
    signal: AbortSignal
  }): void | Promise<void>
  cancel(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    tabId: string
  }): void | Promise<void>
}

interface BrowserActionActions {
  captureLifecycle(): () => boolean
  prepare(input: {
    scope: AgentScope
    requestId: string
    tabId: string
    snapshotId: string
    elementRef: string
    action: AgentPreparedAction['action']
    intent: string
    value?: string
    readGrant?: { requestId: string; proofId: string }
    signal: AbortSignal
  }): AgentPreparedAction | Promise<AgentPreparedAction>
  execute(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId: string
    tabId: string
    signal: AbortSignal
  }): void | Promise<void>
  cancel(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    tabId: string
  }): void | Promise<void>
  waitForEffects(scope: AgentScope, signal: AbortSignal): Promise<boolean>
}

interface BrowserHistoryActions {
  prepare(input: {
    scope: AgentScope
    requestId: string
    search: string
    offset: number
    limit: number
    intent: string
  }): HistoryAgentProof | Promise<HistoryAgentProof>
  execute(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId: string
    signal: AbortSignal
  }): BrowserHistoryPage | Promise<BrowserHistoryPage>
  cancel(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId?: string
  }): void | Promise<void>
  complete(input: {
    scope: AgentScope
    requestId: string
    grantRequestId: string
    proofId: string
  }): void | Promise<void>
  waitForLeases(scope: AgentScope, signal: AbortSignal): Promise<void>
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    response
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end('{"ok":false,"error":"response_too_large"}')
    return
  }
  response
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(body)
}

function validId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

function sameScope(left: AgentScope, right: AgentScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.instanceId === right.instanceId &&
    left.productTurnId === right.productTurnId &&
    left.turnId === right.turnId &&
    left.generation === right.generation &&
    left.interruptGeneration === right.interruptGeneration &&
    left.lifecycleEpoch === right.lifecycleEpoch
  )
}

function canAdvanceScope(previous: AgentScope, next: AgentScope): boolean {
  return (
    next.lifecycleEpoch > previous.lifecycleEpoch ||
    (next.lifecycleEpoch === previous.lifecycleEpoch &&
      next.instanceId === previous.instanceId &&
      next.generation > previous.generation &&
      next.interruptGeneration >= previous.interruptGeneration)
  )
}

function canCloseTarget(scope: ScopeRecord, next: AgentScope): boolean {
  if (!scope.closed) return sameScope(scope.identity, next)
  const previous = scope.closeIdentity ?? scope.identity
  if (scope.closeIdentity && sameScope(previous, next)) return true
  return (
    previous.sessionId === next.sessionId &&
    previous.instanceId === next.instanceId &&
    next.lifecycleEpoch >= previous.lifecycleEpoch &&
    next.generation > previous.generation &&
    next.interruptGeneration >= previous.interruptGeneration &&
    next.productTurnId !== previous.productTurnId &&
    next.turnId !== previous.turnId
  )
}

export async function createAgentTransport(
  list: BrowserList,
  prepareRead?: BrowserPrepareRead,
  readActions?: BrowserReadActions,
  listAuthority: () => number | null = () => null,
  navigateActions?: BrowserNavigateActions,
  actionActions?: BrowserActionActions,
  historyActions?: BrowserHistoryActions,
  searchAction?: BrowserSearchAction
): Promise<AgentTransport> {
  const key = randomBytes(32).toString('hex')
  const scopes = new Map<string, ScopeRecord>()
  const scopeEndListeners = new Set<(scope: AgentScope) => void>()
  const notifyScopeEnd = (identity: AgentScope): void => {
    for (const listener of scopeEndListeners) {
      try {
        listener({ ...identity })
      } catch {}
    }
  }
  let boundPort = 0
  let closed = false
  let closePromise: Promise<void> | null = null
  let activeRequests = 0
  const currentListRevision = (): number | null => {
    try {
      const revision = listAuthority()
      return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : null
    } catch {
      return null
    }
  }
  const listDenied = { status: 503, body: { ok: false, error: FAILURE_CODES.browserUnavailable } }
  const activeControllers = new Set<AbortController>()
  const invocations = new Set<Promise<void>>()
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy())
    if (closed) {
      respond(response, 503, { ok: false, error: FAILURE_CODES.browserUnavailable })
      return
    }
    if (request.socket.remoteAddress !== HOST || request.headers.host !== `${HOST}:${boundPort}`) {
      respond(response, 403, { ok: false, error: FAILURE_CODES.forbidden })
      return
    }
    if (request.method !== 'POST' || request.url !== ROUTE) {
      respond(response, 404, { ok: false, error: FAILURE_CODES.notFound })
      return
    }
    const supplied = request.headers[KEY_HEADER]
    const suppliedKey = typeof supplied === 'string' ? supplied : ''
    const expected = Buffer.from(key)
    const actual = Buffer.from(suppliedKey)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      respond(response, 401, { ok: false, error: FAILURE_CODES.unauthorized })
      return
    }
    const chunks: Buffer[] = []
    let length = 0
    try {
      for await (const chunk of request) {
        length += chunk.length
        if (length > MAX_REQUEST_BYTES) {
          respond(response, 413, { ok: false, error: FAILURE_CODES.requestTooLarge })
          return
        }
        chunks.push(chunk)
      }
    } catch {
      if (!response.destroyed) response.destroy()
      return
    }
    if (closed) {
      response.destroy()
      return
    }
    let payload: Record<string, unknown>
    try {
      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded))
        throw new Error('invalid')
      payload = decoded as Record<string, unknown>
    } catch {
      respond(response, 400, { ok: false, error: FAILURE_CODES.invalidRequest })
      return
    }
    const action = payload.action
    const control = action === 'scope/start' || action === 'scope/end'
    const preparing = action === 'prepare-read'
    const preparingNavigate = action === 'prepare-navigate'
    const snapshotting = action === 'snapshot'
    const reading = action === 'read'
    const cancelling = action === 'cancel-read'
    const executingNavigate = action === 'execute-navigate'
    const cancellingNavigate = action === 'cancel-navigate'
    const preparingAction = action === 'prepare-action'
    const revalidatingAction = preparingAction && payload.grant_request_id !== undefined
    const executingAction = action === 'execute-action'
    const cancellingAction = action === 'cancel-action'
    const preparingHistory = action === 'history/prepare'
    const executingHistory = action === 'history/execute'
    const cancellingHistory = action === 'history/cancel'
    const completingHistory = action === 'history/complete'
    const searching = action === 'search'
    const opening = action === OPEN_ACTION
    const closingTab = action === CLOSE_ACTION
    const effectful = executingNavigate || executingAction || closingTab
    const readAction =
      snapshotting || reading || effectful || executingHistory || searching || opening || closingTab
    const fields = Object.keys(payload)
    const expectedFields = control
      ? [
          'session_id',
          'instance_id',
          'product_turn_id',
          'turn_id',
          'generation',
          'interrupt_generation',
          'lifecycle_epoch',
          'action',
          'deadline',
        ]
      : [
          'session_id',
          'instance_id',
          'product_turn_id',
          'turn_id',
          'generation',
          'interrupt_generation',
          'lifecycle_epoch',
          'request_id',
          'action',
          'deadline',
          ...(preparing ? ['tab_id', 'intent'] : []),
          ...(preparingNavigate ? ['tab_id', 'url', 'intent'] : []),
          ...(preparingAction
            ? [
                'tab_id',
                'snapshot_id',
                'element_ref',
                'browser_action',
                'intent',
                ...(revalidatingAction
                  ? ['grant_request_id', 'proof_id', 'action_request_id']
                  : []),
                ...(payload.browser_action === 'fill' ? ['value'] : []),
              ]
            : []),
          ...(preparingHistory ? ['search', 'offset', 'limit', 'intent'] : []),
          ...(searching ? ['engine', 'query', 'limit'] : []),
          ...(closingTab ? ['tab_id'] : []),
          ...(snapshotting ? ['grant_request_id', 'proof_id', 'tab_id'] : []),
          ...(executingNavigate || executingAction
            ? ['grant_request_id', 'proof_id', 'tab_id']
            : []),
          ...(executingHistory ? ['grant_request_id', 'proof_id'] : []),
          ...(completingHistory ? ['grant_request_id', 'proof_id'] : []),
          ...(reading ? ['tab_id', 'snapshot_id', 'element_ref'] : []),
          ...(cancelling || cancellingNavigate || cancellingAction
            ? ['grant_request_id', 'tab_id']
            : []),
          ...(cancellingHistory
            ? ['grant_request_id', ...(payload.proof_id === undefined ? [] : ['proof_id'])]
            : []),
        ]
    if (
      fields.length !== expectedFields.length ||
      !fields.every((field) => expectedFields.includes(field)) ||
      !validId(payload.session_id) ||
      !validId(payload.instance_id) ||
      !validId(payload.product_turn_id) ||
      !validId(payload.turn_id) ||
      (!control &&
        ((action !== 'list' &&
          !preparing &&
          !preparingNavigate &&
          !preparingAction &&
          !preparingHistory &&
          !readAction &&
          !cancelling &&
          !cancellingNavigate &&
          !cancellingAction &&
          !cancellingHistory &&
          !completingHistory) ||
          !validId(payload.request_id))) ||
      ((preparing || preparingNavigate || preparingAction) &&
        (!validId(payload.tab_id) ||
          typeof payload.intent !== 'string' ||
          !payload.intent.trim() ||
          payload.intent.length > MAX_INTENT_CHARS)) ||
      (preparingNavigate &&
        (typeof payload.url !== 'string' ||
          !payload.url ||
          payload.url.length > MAX_NAVIGATE_URL_CHARS)) ||
      (preparingAction &&
        (!validId(payload.snapshot_id) ||
          !validId(payload.element_ref) ||
          (payload.browser_action !== 'click' &&
            payload.browser_action !== 'fill' &&
            payload.browser_action !== 'submit') ||
          (payload.browser_action === 'fill' &&
            (typeof payload.value !== 'string' || payload.value.length > MAX_FILL_CHARS)))) ||
      (revalidatingAction &&
        (!validId(payload.grant_request_id) ||
          !validId(payload.proof_id) ||
          !validId(payload.action_request_id) ||
          payload.action_request_id === payload.request_id ||
          payload.action_request_id === payload.grant_request_id)) ||
      (preparingHistory &&
        (typeof payload.search !== 'string' ||
          !payload.search.trim() ||
          payload.search.length > 256 ||
          typeof payload.intent !== 'string' ||
          !payload.intent.trim() ||
          payload.intent.length > MAX_INTENT_CHARS ||
          !Number.isSafeInteger(payload.offset) ||
          Number(payload.offset) < 0 ||
          Number(payload.offset) > 1000 ||
          !Number.isSafeInteger(payload.limit) ||
          Number(payload.limit) < 1 ||
          Number(payload.limit) > 20)) ||
      (searching &&
        (typeof payload.engine !== 'string' ||
          !validId(payload.engine) ||
          typeof payload.query !== 'string' ||
          !payload.query.trim() ||
          payload.query.length > MAX_SEARCH_QUERY_CHARS ||
          !Number.isSafeInteger(payload.limit) ||
          Number(payload.limit) < 1 ||
          Number(payload.limit) > MAX_SEARCH_RESULTS)) ||
      (closingTab && !validId(payload.tab_id)) ||
      ((snapshotting || executingNavigate || executingAction) &&
        (!validId(payload.tab_id) ||
          !validId(payload.grant_request_id) ||
          !validId(payload.proof_id))) ||
      ((executingHistory || completingHistory) &&
        (!validId(payload.grant_request_id) || !validId(payload.proof_id))) ||
      (reading &&
        (!validId(payload.tab_id) ||
          !validId(payload.snapshot_id) ||
          !validId(payload.element_ref))) ||
      ((cancelling || cancellingNavigate || cancellingAction) &&
        (!validId(payload.grant_request_id) || !validId(payload.tab_id))) ||
      (cancellingHistory &&
        (!validId(payload.grant_request_id) ||
          (payload.proof_id !== undefined && !validId(payload.proof_id)))) ||
      typeof payload.generation !== 'number' ||
      !Number.isSafeInteger(payload.generation) ||
      payload.generation < 1 ||
      typeof payload.interrupt_generation !== 'number' ||
      !Number.isSafeInteger(payload.interrupt_generation) ||
      typeof payload.lifecycle_epoch !== 'number' ||
      !Number.isSafeInteger(payload.lifecycle_epoch) ||
      payload.lifecycle_epoch < 1 ||
      payload.interrupt_generation < 0 ||
      typeof payload.deadline !== 'number' ||
      !Number.isSafeInteger(payload.deadline) ||
      payload.deadline > Date.now() + (readAction ? ACTION_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
    ) {
      respond(response, 400, { ok: false, error: FAILURE_CODES.invalidRequest })
      return
    }
    const identity: AgentScope = {
      sessionId: payload.session_id as string,
      instanceId: payload.instance_id as string,
      productTurnId: payload.product_turn_id as string,
      turnId: payload.turn_id as string,
      generation: payload.generation as number,
      interruptGeneration: payload.interrupt_generation as number,
      lifecycleEpoch: payload.lifecycle_epoch as number,
    }
    let scope = scopes.get(identity.sessionId)
    if (control) {
      if (payload.deadline <= Date.now()) {
        respond(response, 400, { ok: false, error: FAILURE_CODES.invalidRequest })
        return
      }
      if (action === 'scope/end')
        request.setTimeout(REQUEST_TIMEOUT_MS + SCOPE_END_RESPONSE_GRACE_MS)
      if (action === 'scope/start') {
        if (!scope) {
          if (scopes.size >= MAX_SCOPE_RECORDS) {
            respond(response, 503, { ok: false, error: FAILURE_CODES.requestCapacityExhausted })
            return
          }
          scope = {
            identity,
            closed: false,
            endComplete: false,
            controllers: new Set(),
            inFlight: new Set(),
            requests: new Map(),
          }
          scopes.set(identity.sessionId, scope)
        } else if (sameScope(scope.identity, identity) && !scope.closed) {
          respond(response, 200, { ok: true })
          return
        } else if (scope.closed && scope.endComplete && canAdvanceScope(scope.identity, identity)) {
          scope.identity = identity
          delete scope.closeIdentity
          scope.closed = false
          scope.endComplete = false
          scope.requests.clear()
        } else {
          respond(response, 409, { ok: false, error: FAILURE_CODES.staleScope })
          return
        }
      } else if (!scope) {
        if (scopes.size >= MAX_SCOPE_RECORDS) {
          respond(response, 503, { ok: false, error: FAILURE_CODES.requestCapacityExhausted })
          return
        }
        scopes.set(identity.sessionId, {
          identity,
          closed: true,
          endComplete: true,
          controllers: new Set(),
          inFlight: new Set(),
          requests: new Map(),
        })
      } else if (scope.closed && scope.endComplete && canAdvanceScope(scope.identity, identity)) {
        scope.identity = identity
        delete scope.closeIdentity
        scope.requests.clear()
      } else if (!sameScope(scope.identity, identity)) {
        respond(response, 409, { ok: false, error: FAILURE_CODES.staleScope })
        return
      } else {
        if (!scope.closed) {
          scope.closed = true
          notifyScopeEnd(scope.identity)
          for (const controller of scope.controllers) controller.abort()
        }
        if (!scope.endComplete) {
          const endingScope = scope
          let ownerCurrent: () => boolean
          try {
            ownerCurrent = actionActions?.captureLifecycle() ?? (() => true)
          } catch {
            respond(response, 503, { ok: false, error: FAILURE_CODES.browserUnavailable })
            return
          }
          const confirmDrain = (phase: ScopeDrainPhase, result: ScopeDrainResult): boolean => {
            if (
              closed ||
              response.destroyed ||
              request.aborted ||
              !ownerCurrent() ||
              scopes.get(identity.sessionId) !== endingScope ||
              !sameScope(endingScope.identity, identity) ||
              !endingScope.closed
            ) {
              respond(response, 503, { ok: false, error: FAILURE_CODES.browserUnavailable })
              return false
            }
            if (endingScope.endComplete) return true
            if (
              result === ScopeDrainResult.Failed ||
              (result === ScopeDrainResult.Settled && (payload.deadline as number) <= Date.now())
            ) {
              respond(response, 503, { ok: false, error: FAILURE_CODES.browserUnavailable })
              return false
            }
            if (result === ScopeDrainResult.Unsettled) {
              respond(response, 408, { ok: false, error: SCOPE_UNSETTLED, phase })
              return false
            }
            return true
          }
          let timer: NodeJS.Timeout | null = null
          const drained = await Promise.race([
            Promise.all([...scope.inFlight]).then(
              () => ScopeDrainResult.Settled,
              () => ScopeDrainResult.Failed
            ),
            new Promise<ScopeDrainResult>((resolve) => {
              timer = setTimeout(
                () => resolve(ScopeDrainResult.Unsettled),
                Math.max(0, (payload.deadline as number) - Date.now())
              )
            }),
          ])
          if (timer) clearTimeout(timer)
          if (!confirmDrain(ScopeDrainPhase.Requests, drained)) return
          if (actionActions) {
            let fenceTimer: NodeJS.Timeout | null = null
            const fenceWait = new AbortController()
            const effectsSettled = await Promise.race([
              Promise.resolve()
                .then(() => actionActions.waitForEffects(identity, fenceWait.signal))
                .then(
                  (settled) => (settled ? ScopeDrainResult.Settled : ScopeDrainResult.Unsettled),
                  () => ScopeDrainResult.Failed
                ),
              new Promise<ScopeDrainResult>((resolve) => {
                fenceTimer = setTimeout(
                  () => {
                    resolve(ScopeDrainResult.Unsettled)
                    fenceWait.abort()
                  },
                  Math.max(0, (payload.deadline as number) - Date.now())
                )
              }),
            ])
            if (fenceTimer) clearTimeout(fenceTimer)
            fenceWait.abort()
            if (!confirmDrain(ScopeDrainPhase.Effects, effectsSettled)) return
          }
          if (historyActions) {
            let leaseTimer: NodeJS.Timeout | null = null
            const leaseWait = new AbortController()
            const leasesSettled = await Promise.race([
              Promise.resolve()
                .then(() => historyActions.waitForLeases(identity, leaseWait.signal))
                .then(
                  () => ScopeDrainResult.Settled,
                  () => ScopeDrainResult.Failed
                ),
              new Promise<ScopeDrainResult>((resolve) => {
                leaseTimer = setTimeout(
                  () => {
                    resolve(ScopeDrainResult.Unsettled)
                    leaseWait.abort()
                  },
                  Math.max(0, (payload.deadline as number) - Date.now())
                )
              }),
            ])
            if (leaseTimer) clearTimeout(leaseTimer)
            if (!confirmDrain(ScopeDrainPhase.Leases, leasesSettled)) return
          }
          scope.endComplete = true
          scope.requests.clear()
        }
      }
      respond(response, 200, { ok: true })
      return
    }
    if (
      !scope ||
      (closingTab
        ? !canCloseTarget(scope, identity)
        : !sameScope(scope.identity, identity) ||
          (scope.closed && !cancellingHistory && !completingHistory))
    ) {
      respond(response, 409, { ok: false, error: FAILURE_CODES.staleScope })
      return
    }
    const listRevision = action === 'list' ? currentListRevision() : null
    if (action === 'list' && listRevision === null) {
      respond(response, listDenied.status, listDenied.body)
      return
    }
    if (action === 'list' && payload.deadline <= Date.now()) {
      respond(response, 400, { ok: false, error: FAILURE_CODES.invalidRequest })
      return
    }
    const signaturePayload = action === 'list' ? { ...payload, deadline: undefined } : payload
    const signature = createHash('sha256').update(JSON.stringify(signaturePayload)).digest('hex')
    const prior = scope.requests.get(payload.request_id as string)
    if (prior) {
      if (prior.signature !== signature)
        respond(response, 409, { ok: false, error: FAILURE_CODES.requestIdConflict })
      else if (executingHistory)
        respond(response, 409, { ok: false, error: FAILURE_CODES.requestUnknown })
      else if (action === 'list' && prior.listRevision !== listRevision)
        respond(response, listDenied.status, listDenied.body)
      else {
        let replayTimer: NodeJS.Timeout | null = null
        try {
          const result =
            action === 'list'
              ? await Promise.race([
                  prior.result,
                  new Promise<null>((resolve) => {
                    replayTimer = setTimeout(
                      () => resolve(null),
                      Math.max(0, (payload.deadline as number) - Date.now())
                    )
                  }),
                ])
              : await prior.result
          if (result === null || (action === 'list' && payload.deadline <= Date.now())) {
            respond(response, 408, { ok: false, error: FAILURE_CODES.requestExpired })
          } else if (action === 'list' && currentListRevision() !== listRevision)
            respond(response, listDenied.status, listDenied.body)
          else respond(response, result.status, result.body)
        } finally {
          if (replayTimer) clearTimeout(replayTimer)
        }
      }
      return
    }
    if (payload.deadline <= Date.now()) {
      respond(response, 400, { ok: false, error: FAILURE_CODES.invalidRequest })
      return
    }
    if (scope.requests.size >= MAX_REPLAY_RECORDS) {
      respond(response, 503, { ok: false, error: FAILURE_CODES.requestCapacityExhausted })
      return
    }
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      respond(response, 503, { ok: false, error: FAILURE_CODES.requestCapacityExhausted })
      return
    }
    const deadline = payload.deadline as number
    request.setTimeout(readAction ? ACTION_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
    activeRequests += 1
    const abortController = new AbortController()
    activeControllers.add(abortController)
    const currentScope = scope
    if (closingTab) {
      if (currentScope.closed) {
        if (!sameScope(currentScope.closeIdentity ?? currentScope.identity, identity))
          for (const controller of currentScope.closeControllers ?? []) controller.abort()
        currentScope.closeIdentity = { ...identity }
      }
      currentScope.closeControllers ??= new Set()
      currentScope.closeControllers.add(abortController)
    }
    currentScope.controllers.add(abortController)
    const result = (async (): Promise<{ status: number; body: unknown }> => {
      let expiryTimer: NodeJS.Timeout | null = null
      let timedOut = false
      let interrupted = false
      const interruptedResult = new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => {
            if (timedOut) return
            interrupted = true
            reject(new Error('request_unknown'))
          },
          { once: true }
        )
      })
      const onResponseClose = (): void => {
        if (!response.writableEnded) abortController.abort()
      }
      response.once('close', onResponseClose)
      try {
        const invocation = Promise.resolve().then(() => {
          if (
            closed ||
            (closingTab && (abortController.signal.aborted || Date.now() >= deadline)) ||
            (closingTab
              ? !canCloseTarget(currentScope, identity)
              : (currentScope.closed && !cancellingHistory && !completingHistory) ||
                !sameScope(currentScope.identity, identity))
          )
            throw new Error('request_expired')
          return closingTab
            ? navigateActions?.close
              ? Promise.resolve(
                  navigateActions.close({
                    scope: { ...identity },
                    requestId: payload.request_id as string,
                    tabId: payload.tab_id as string,
                    signal: abortController.signal,
                  })
                )
              : Promise.reject(new Error('browser_unavailable'))
            : opening
              ? (navigateActions?.open?.({
                  scope: { ...identity },
                  requestId: payload.request_id as string,
                  signal: abortController.signal,
                }) ?? Promise.reject(new Error('browser_unavailable')))
              : searching
                ? (searchAction?.({
                    scope: { ...identity },
                    requestId: payload.request_id as string,
                    engine: payload.engine as string,
                    query: payload.query as string,
                    limit: payload.limit as number,
                    signal: abortController.signal,
                  }) ?? Promise.reject(new Error('browser_unavailable')))
                : preparing
                  ? (prepareRead?.({
                      scope: { ...identity },
                      requestId: payload.request_id as string,
                      tabId: payload.tab_id as string,
                      intent: payload.intent as string,
                    }) ?? Promise.reject(new Error('browser_unavailable')))
                  : snapshotting
                    ? (readActions?.snapshot({
                        scope: { ...identity },
                        requestId: payload.request_id as string,
                        grantRequestId: payload.grant_request_id as string,
                        proofId: payload.proof_id as string,
                        tabId: payload.tab_id as string,
                        signal: abortController.signal,
                      }) ?? Promise.reject(new Error('browser_unavailable')))
                    : preparingNavigate
                      ? (navigateActions?.prepare({
                          scope: { ...identity },
                          requestId: payload.request_id as string,
                          tabId: payload.tab_id as string,
                          url: payload.url as string,
                          intent: payload.intent as string,
                        }) ?? Promise.reject(new Error('browser_unavailable')))
                      : preparingHistory
                        ? (historyActions?.prepare({
                            scope: { ...identity },
                            requestId: payload.request_id as string,
                            search: payload.search as string,
                            offset: payload.offset as number,
                            limit: payload.limit as number,
                            intent: payload.intent as string,
                          }) ?? Promise.reject(new Error('browser_unavailable')))
                        : preparingAction
                          ? (actionActions?.prepare({
                              scope: { ...identity },
                              requestId: (revalidatingAction
                                ? payload.action_request_id
                                : payload.request_id) as string,
                              tabId: payload.tab_id as string,
                              snapshotId: payload.snapshot_id as string,
                              elementRef: payload.element_ref as string,
                              action: payload.browser_action as AgentPreparedAction['action'],
                              intent: payload.intent as string,
                              signal: abortController.signal,
                              ...(revalidatingAction
                                ? {
                                    readGrant: {
                                      requestId: payload.grant_request_id as string,
                                      proofId: payload.proof_id as string,
                                    },
                                  }
                                : {}),
                              ...(payload.browser_action === 'fill'
                                ? { value: payload.value as string }
                                : {}),
                            }) ?? Promise.reject(new Error('browser_action_unavailable')))
                          : executingNavigate
                            ? navigateActions
                              ? navigateActions.execute({
                                  scope: { ...identity },
                                  requestId: payload.request_id as string,
                                  grantRequestId: payload.grant_request_id as string,
                                  proofId: payload.proof_id as string,
                                  tabId: payload.tab_id as string,
                                  signal: abortController.signal,
                                })
                              : Promise.reject(new Error('browser_unavailable'))
                            : executingAction
                              ? actionActions
                                ? actionActions.execute({
                                    scope: { ...identity },
                                    requestId: payload.request_id as string,
                                    grantRequestId: payload.grant_request_id as string,
                                    proofId: payload.proof_id as string,
                                    tabId: payload.tab_id as string,
                                    signal: abortController.signal,
                                  })
                                : Promise.reject(new Error('browser_action_unavailable'))
                              : executingHistory
                                ? (historyActions?.execute({
                                    scope: { ...identity },
                                    requestId: payload.request_id as string,
                                    grantRequestId: payload.grant_request_id as string,
                                    proofId: payload.proof_id as string,
                                    signal: abortController.signal,
                                  }) ?? Promise.reject(new Error('browser_unavailable')))
                                : cancellingHistory
                                  ? historyActions
                                    ? historyActions.cancel({
                                        scope: { ...identity },
                                        requestId: payload.request_id as string,
                                        grantRequestId: payload.grant_request_id as string,
                                        ...(payload.proof_id === undefined
                                          ? {}
                                          : { proofId: payload.proof_id as string }),
                                      })
                                    : Promise.reject(new Error('browser_unavailable'))
                                  : completingHistory
                                    ? historyActions
                                      ? historyActions.complete({
                                          scope: { ...identity },
                                          requestId: payload.request_id as string,
                                          grantRequestId: payload.grant_request_id as string,
                                          proofId: payload.proof_id as string,
                                        })
                                      : Promise.reject(new Error('browser_unavailable'))
                                    : cancellingAction
                                      ? actionActions
                                        ? actionActions.cancel({
                                            scope: { ...identity },
                                            requestId: payload.request_id as string,
                                            grantRequestId: payload.grant_request_id as string,
                                            tabId: payload.tab_id as string,
                                          })
                                        : Promise.reject(new Error('browser_action_unavailable'))
                                      : cancellingNavigate
                                        ? navigateActions
                                          ? navigateActions.cancel({
                                              scope: { ...identity },
                                              requestId: payload.request_id as string,
                                              grantRequestId: payload.grant_request_id as string,
                                              tabId: payload.tab_id as string,
                                            })
                                          : Promise.reject(new Error('browser_unavailable'))
                                        : reading
                                          ? (readActions?.read({
                                              scope: { ...identity },
                                              requestId: payload.request_id as string,
                                              tabId: payload.tab_id as string,
                                              snapshotId: payload.snapshot_id as string,
                                              elementRef: payload.element_ref as string,
                                              signal: abortController.signal,
                                            }) ?? Promise.reject(new Error('browser_unavailable')))
                                          : cancelling
                                            ? readActions?.cancel
                                              ? Promise.resolve(
                                                  readActions.cancel({
                                                    scope: { ...identity },
                                                    requestId: payload.request_id as string,
                                                    grantRequestId:
                                                      payload.grant_request_id as string,
                                                    tabId: payload.tab_id as string,
                                                  })
                                                )
                                              : Promise.reject(new Error('browser_unavailable'))
                                            : list()
        })
        const settledInvocation = invocation.then(
          (output) => {
            if (opening && (abortController.signal.aborted || currentScope.closed || closed))
              (output as { close(): void }).close()
          },
          () => undefined
        )
        currentScope.inFlight.add(settledInvocation)
        invocations.add(settledInvocation)
        void settledInvocation.then(() => {
          currentScope.inFlight.delete(settledInvocation)
          invocations.delete(settledInvocation)
        })
        const output = await Promise.race([
          invocation,
          interruptedResult,
          new Promise<never>((_resolve, reject) => {
            expiryTimer = setTimeout(
              () => {
                timedOut = true
                abortController.abort()
                reject(new Error('request_expired'))
              },
              Math.max(0, deadline - Date.now())
            )
          }),
        ])
        const expired =
          closed ||
          (closingTab
            ? !canCloseTarget(currentScope, identity)
            : (currentScope.closed && !cancellingHistory && !completingHistory) ||
              !sameScope(currentScope.identity, identity)) ||
          scopes.get(identity.sessionId) !== currentScope ||
          Date.now() >= deadline
        if (expired) abortController.abort()
        return action === 'list' && currentListRevision() !== listRevision
          ? listDenied
          : expired
            ? effectful
              ? { status: 409, body: { ok: false, error: FAILURE_CODES.requestUnknown } }
              : { status: 408, body: { ok: false, error: FAILURE_CODES.requestExpired } }
            : closingTab
              ? { status: 200, body: { ok: true, tab_id: payload.tab_id } }
              : opening
                ? { status: 200, body: { ok: true, tab_id: (output as { tabId: string }).tabId } }
                : searching
                  ? { status: 200, body: { ok: true, ...(output as Record<string, unknown>) } }
                  : preparing
                    ? {
                        status: 200,
                        body: {
                          ok: true,
                          proof: {
                            proof_id: (output as BrowserReadProof).proofId,
                            request_id: (output as BrowserReadProof).requestId,
                            scope: (output as BrowserReadProof).scope,
                            tab_id: (output as BrowserReadProof).tabId,
                            target_instance_id: (output as BrowserReadProof).target.instanceId,
                            target_generation: (output as BrowserReadProof).target.generation,
                            origin: (output as BrowserReadProof).target.origin,
                            intent: (output as BrowserReadProof).intent,
                            expires_at: (output as BrowserReadProof).expiresAt,
                            policy_revision: (output as BrowserReadProof).policyRevision,
                            policy_decision: (output as BrowserReadProof).policyDecision,
                          },
                        },
                      }
                    : snapshotting
                      ? {
                          status: 200,
                          body: {
                            ok: true,
                            snapshot: {
                              snapshot_id: (output as AgentReadSnapshot).snapshotId,
                              origin: (output as AgentReadSnapshot).origin,
                              title: (output as AgentReadSnapshot).title,
                              elements: (output as AgentReadSnapshot).elements.map((element) => ({
                                element_ref: element.ref,
                                role: element.role,
                                name: element.name,
                              })),
                            },
                          },
                        }
                      : preparingNavigate
                        ? {
                            status: 200,
                            body: {
                              ok: true,
                              proof: {
                                proof_id: (output as BrowserNavigateProof).proofId,
                                request_id: (output as BrowserNavigateProof).requestId,
                                scope: (output as BrowserNavigateProof).scope,
                                tab_id: (output as BrowserNavigateProof).tabId,
                                target_instance_id: (output as BrowserNavigateProof).source
                                  .instanceId,
                                target_generation: (output as BrowserNavigateProof).source
                                  .generation,
                                source_origin: (output as BrowserNavigateProof).source.origin,
                                destination_url: (output as BrowserNavigateProof).url,
                                destination_origin: (output as BrowserNavigateProof)
                                  .destinationOrigin,
                                intent: (output as BrowserNavigateProof).intent,
                                expires_at: (output as BrowserNavigateProof).expiresAt,
                                policy_revision: (output as BrowserNavigateProof).policyRevision,
                                policy_decision: (output as BrowserNavigateProof).policyDecision,
                              },
                            },
                          }
                        : preparingHistory
                          ? {
                              status: 200,
                              body: {
                                ok: true,
                                proof: {
                                  proof_id: (output as HistoryAgentProof).proofId,
                                  request_id: (output as HistoryAgentProof).requestId,
                                  scope: (output as HistoryAgentProof).scope,
                                  query_digest: (output as HistoryAgentProof).queryDigest,
                                  history_revision: (output as HistoryAgentProof).historyRevision,
                                  expires_at: (output as HistoryAgentProof).expiresAt,
                                },
                              },
                            }
                          : preparingAction
                            ? {
                                status: 200,
                                body: {
                                  ok: true,
                                  proof: {
                                    prepared_id: (output as AgentPreparedAction).id,
                                    proof_id: (output as AgentPreparedAction).proofId,
                                    request_id: (output as AgentPreparedAction).requestId,
                                    scope: (output as AgentPreparedAction).scope,
                                    tab_id: (output as AgentPreparedAction).tabId,
                                    target_instance_id: (output as AgentPreparedAction).target
                                      .instanceId,
                                    target_generation: (output as AgentPreparedAction).target
                                      .generation,
                                    origin: (output as AgentPreparedAction).target.origin,
                                    snapshot_id: (output as AgentPreparedAction).snapshotId,
                                    element_ref: (output as AgentPreparedAction).elementRef,
                                    backend_node_id: (output as AgentPreparedAction).backendNodeId,
                                    grant_id: (output as AgentPreparedAction).grantId,
                                    grant_request_id: (output as AgentPreparedAction)
                                      .grantRequestId,
                                    grant_revision: (output as AgentPreparedAction).grantRevision,
                                    revocation_epoch: (output as AgentPreparedAction)
                                      .revocationEpoch,
                                    browser_action: (output as AgentPreparedAction).action,
                                    intent: (output as AgentPreparedAction).intent,
                                    expires_at: (output as AgentPreparedAction).expiresAt,
                                    element: (output as AgentPreparedAction).element,
                                  },
                                },
                              }
                            : executingHistory
                              ? { status: 200, body: { ok: true, page: output } }
                              : effectful ||
                                  cancellingNavigate ||
                                  cancellingAction ||
                                  cancellingHistory ||
                                  completingHistory
                                ? { status: 200, body: { ok: true } }
                                : reading
                                  ? {
                                      status: 200,
                                      body: {
                                        ok: true,
                                        element: {
                                          element_ref: (output as AgentReadElement).ref,
                                          role: (output as AgentReadElement).role,
                                          name: (output as AgentReadElement).name,
                                        },
                                      },
                                    }
                                  : cancelling
                                    ? { status: 200, body: { ok: true } }
                                    : { status: 200, body: { ok: true, tabs: output } }
      } catch (error) {
        console.info(
          '[browser-agent] request failed',
          JSON.stringify({ action, code: agentFailureCode(error), timedOut, interrupted })
        )
        return timedOut
          ? effectful
            ? { status: 409, body: { ok: false, error: FAILURE_CODES.requestUnknown } }
            : { status: 408, body: { ok: false, error: FAILURE_CODES.requestExpired } }
          : interrupted
            ? { status: 409, body: { ok: false, error: FAILURE_CODES.requestUnknown } }
            : (snapshotting || reading) &&
                error instanceof Error &&
                STALE_ACTION_REFERENCES.has(error.message)
              ? { status: 409, body: { ok: false, error: error.message } }
              : snapshotting && error instanceof Error && SNAPSHOT_FAILURE_CODES.has(error.message)
                ? { status: 503, body: { ok: false, error: error.message } }
                : preparingAction &&
                    error instanceof Error &&
                    error.message === OBSERVATION_READ_REQUIRED
                  ? { status: 409, body: { ok: false, error: OBSERVATION_READ_REQUIRED } }
                  : preparingAction &&
                      error instanceof Error &&
                      STALE_ACTION_REFERENCES.has(error.message)
                    ? { status: 409, body: { ok: false, error: STALE_REFERENCE } }
                    : error instanceof Error && error.message === 'navigation_outcome_unknown'
                      ? { status: 409, body: { ok: false, error: FAILURE_CODES.requestUnknown } }
                      : error instanceof Error &&
                          error.message === 'navigation_cancelled_before_dispatch'
                        ? {
                            status: 409,
                            body: {
                              ok: false,
                              error: FAILURE_CODES.navigationCancelledBeforeDispatch,
                            },
                          }
                        : error instanceof Error &&
                            error.message === 'action_cancelled_before_dispatch'
                          ? {
                              status: 409,
                              body: {
                                ok: false,
                                error: FAILURE_CODES.actionCancelledBeforeDispatch,
                              },
                            }
                          : error instanceof Error && error.message === 'action_outcome_unknown'
                            ? {
                                status: 409,
                                body: { ok: false, error: FAILURE_CODES.requestUnknown },
                              }
                            : error instanceof Error &&
                                error.message === 'browser_action_unavailable'
                              ? {
                                  status: 503,
                                  body: {
                                    ok: false,
                                    error: FAILURE_CODES.browserActionUnavailable,
                                  },
                                }
                              : executingAction
                                ? {
                                    status: 409,
                                    body: { ok: false, error: FAILURE_CODES.requestUnknown },
                                  }
                                : searching && error instanceof BrowserSearchError
                                  ? { status: 503, body: { ok: false, error: error.message } }
                                  : {
                                      status: 503,
                                      body: { ok: false, error: FAILURE_CODES.browserUnavailable },
                                    }
      } finally {
        if (expiryTimer) clearTimeout(expiryTimer)
        response.removeListener('close', onResponseClose)
        activeControllers.delete(abortController)
        currentScope.controllers.delete(abortController)
        currentScope.closeControllers?.delete(abortController)
        activeRequests -= 1
      }
    })()
    const replayResult = executingHistory
      ? result.then(() => ({
          status: 409,
          body: { ok: false, error: FAILURE_CODES.requestUnknown },
        }))
      : result
    scope.requests.set(payload.request_id as string, {
      signature,
      listRevision,
      result: replayResult,
    })
    const outcome = await result
    if (action === 'list' && currentListRevision() !== listRevision)
      respond(response, listDenied.status, listDenied.body)
    else respond(response, outcome.status, outcome.body)
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = REQUEST_TIMEOUT_MS
  server.maxConnections = MAX_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || !address)
    throw new Error('agent_transport_address_unavailable')
  boundPort = address.port
  return {
    port: address.port,
    key,
    activeScope: (sessionId, turnId) => {
      if (closed) return null
      const scope = scopes.get(sessionId)
      return scope && !scope.closed && scope.identity.turnId === turnId
        ? { ...scope.identity }
        : null
    },
    onScopeEnd: (listener) => {
      scopeEndListeners.add(listener)
      return () => {
        scopeEndListeners.delete(listener)
      }
    },
    close: () => {
      if (closePromise) return closePromise
      closed = true
      for (const controller of activeControllers) controller.abort()
      for (const scope of scopes.values()) if (!scope.closed) notifyScopeEnd(scope.identity)
      scopeEndListeners.clear()
      closePromise = (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
        // A timeout/abort settles HTTP delivery, not the underlying browser work.
        // Keep invocations even when their scope has already been replaced.
        await Promise.all([...invocations])
      })()
      return closePromise
    },
  }
}
