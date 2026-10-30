import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { BROWSER_APPROVAL_RESPONSE_CHANNEL, BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL,
  type BrowserApprovalResponseReply, type BrowserApprovalResponseRequest,
  type BrowserHistoryApprovalResponseRequest } from '../approval.ts'
import type { BrowserNavigateProof, BrowserReadProof, BrowserReadScope } from './grant.ts'
import type { AgentPreparedAction } from './agent.ts'
import type { HistoryAgentProof } from './history.ts'

const MAX_ID_LENGTH = 128
const MAX_INTENT_LENGTH = 512
const MAX_ACTION_LENGTH = 64
const PENDING_PATH = '/api/serve/interactions/pending'
const BROWSER_APPROVAL_KIND = 'browser_approval'
const PENDING_STATE = 'pending'
const UNKNOWN: BrowserApprovalResponseReply = { ok: false, outcome: 'unknown' }

interface Owners {
  enabled(): boolean

  contents(): WebContents | null
  rendererOrigin(): string | null
  rendererNavigationEpoch(): number
  backendBase(): string | null
  browserTarget(tabId: string): { instanceId: string; generation: number; origin: string } | null
  browserNavigateTarget?(tabId: string): { instanceId: string; generation: number; origin: string | null; url: string } | null
  activeScope(sessionId: string, turnId: string): BrowserReadScope | null
  readProof?(requestId: string, proofId: string): BrowserReadProof
  grantRead?(request: BrowserApprovalResponseRequest): void
  navigateProof?(requestId: string, proofId: string): BrowserNavigateProof
  grantNavigate?(request: BrowserApprovalResponseRequest): void
  actionProof?(requestId: string, proofId: string): AgentPreparedAction
  grantAction?(request: BrowserApprovalResponseRequest): void
  hostHeader(): Record<string, string>
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function validId(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function parseRequest(value: unknown): BrowserApprovalResponseRequest | null {
  const input = record(value)
  const readFields = 'action,decision,expiresAt,intent,origin,proofId,requestId,sessionId,tabId,targetGeneration,targetInstanceId,turnId'
  const navigateFields = 'action,decision,destinationOrigin,destinationUrl,expiresAt,intent,origin,proofId,requestId,sessionId,sourceOrigin,tabId,targetGeneration,targetInstanceId,turnId'
  const actionFields = 'action,browserAction,decision,element,elementRef,expiresAt,intent,origin,preparedId,proofId,requestId,sessionId,snapshotId,tabId,targetGeneration,targetInstanceId,turnId'
  const isAction = input?.action === 'click' || input?.action === 'fill' || input?.action === 'submit'
  if (!input || Object.keys(input).sort().join(',') !== (input.action === 'navigate' ? navigateFields : isAction ? actionFields : readFields)) return null
  if (!validId(input.sessionId) || !validId(input.requestId) || !validId(input.proofId) || !validId(input.turnId)
    || !validId(input.tabId) || !validId(input.targetInstanceId)
    || !Number.isSafeInteger(input.targetGeneration) || Number(input.targetGeneration) < 0
    || !validId(input.action, MAX_ACTION_LENGTH)
    || typeof input.intent !== 'string' || input.intent.length > MAX_INTENT_LENGTH
    || typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)
    || input.expiresAt <= Date.now() || (input.decision !== 'deny' && input.decision !== 'allow_once')) return null
  try {
    const origin = new URL(String(input.origin))
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== input.origin) return null
    if (input.action === 'navigate') {
      const destination = new URL(String(input.destinationUrl))
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
        || destination.href !== input.destinationUrl || destination.origin !== input.destinationOrigin
        || input.destinationOrigin !== input.origin) return null
      if (input.sourceOrigin !== null) {
        const source = new URL(String(input.sourceOrigin))
        if (!['http:', 'https:'].includes(source.protocol) || source.origin !== input.sourceOrigin) return null
      }
    }
    if (isAction && (!validId(input.preparedId) || !validId(input.snapshotId) || !validId(input.elementRef)
      || input.browserAction !== input.action || !record(input.element)
      || Object.keys(record(input.element)!).sort().join(',') !== 'name,role'
      || typeof record(input.element)!.role !== 'string' || String(record(input.element)!.role).length > 128
      || typeof record(input.element)!.name !== 'string' || String(record(input.element)!.name).length > 320)) return null
  } catch { return null }
  return input as unknown as BrowserApprovalResponseRequest
}

function pendingMatches(value: unknown, request: BrowserApprovalResponseRequest): boolean {
  const row = record(value)
  return row?.state === PENDING_STATE && row.kind === BROWSER_APPROVAL_KIND
    && row.method === BROWSER_APPROVAL_KIND && row.session_id === request.sessionId
    && row.request_id === request.requestId && row.turn_id === request.turnId
    && row.tab_id === request.tabId && row.origin === request.origin
    && row.target_instance_id === request.targetInstanceId
    && row.target_generation === request.targetGeneration
    && row.proof_id === request.proofId
    && row.action === request.action && row.intent === request.intent
    && (request.action !== 'navigate' || row.source_origin === request.sourceOrigin
      && row.destination_url === request.destinationUrl && row.destination_origin === request.destinationOrigin)
    && (!isActionRequest(request) || row.prepared_id === request.preparedId
      && row.snapshot_id === request.snapshotId && row.element_ref === request.elementRef
      && row.browser_action === request.browserAction && elementMatches(row.element, request))
    && typeof row.expires_at === 'number' && row.expires_at * 1000 === request.expiresAt
}

function isActionRequest(request: BrowserApprovalResponseRequest): boolean {
  return request.action === 'click' || request.action === 'fill' || request.action === 'submit'
}

function elementMatches(value: unknown, request: BrowserApprovalResponseRequest): boolean {
  const element = record(value)
  return !!element && Object.keys(element).sort().join(',') === 'name,role'
    && element.role === request.element?.role && element.name === request.element?.name
}

function actionProofMatches(proof: AgentPreparedAction, request: BrowserApprovalResponseRequest,
  scope: BrowserReadScope): boolean {
  return proof.id === request.preparedId && proof.proofId === request.proofId && proof.requestId === request.requestId
    && sameScope(proof.scope, scope) && proof.tabId === request.tabId
    && proof.target.instanceId === request.targetInstanceId && proof.target.generation === request.targetGeneration
    && proof.target.origin === request.origin && proof.snapshotId === request.snapshotId
    && proof.elementRef === request.elementRef && proof.action === request.action
    && proof.intent === request.intent && proof.expiresAt === request.expiresAt
    && proof.element?.role === request.element?.role && proof.element?.name === request.element?.name
}

function scopeMatches(value: unknown, scope: BrowserReadScope): boolean {
  const row = record(value)
  return row?.session_id === scope.sessionId && row.instance_id === scope.instanceId
    && row.product_turn_id === scope.productTurnId && row.turn_id === scope.turnId
    && row.generation === scope.generation && row.interrupt_generation === scope.interruptGeneration
    && row.lifecycle_epoch === scope.lifecycleEpoch
}

function sameScope(left: BrowserReadScope | null, right: BrowserReadScope): boolean {
  return left !== null && left.sessionId === right.sessionId && left.instanceId === right.instanceId
    && left.productTurnId === right.productTurnId && left.turnId === right.turnId
    && left.generation === right.generation && left.interruptGeneration === right.interruptGeneration
    && left.lifecycleEpoch === right.lifecycleEpoch
}

function proofMatches(proof: BrowserReadProof, request: BrowserApprovalResponseRequest, scope: BrowserReadScope): boolean {
  return proof.proofId === request.proofId && proof.requestId === request.requestId
    && sameScope(proof.scope, scope) && proof.tabId === request.tabId
    && proof.target.instanceId === request.targetInstanceId
    && proof.target.generation === request.targetGeneration && proof.target.origin === request.origin
    && proof.intent === request.intent && proof.expiresAt === request.expiresAt
}

function navigateProofMatches(proof: BrowserNavigateProof, request: BrowserApprovalResponseRequest,
  scope: BrowserReadScope): boolean {
  return proof.proofId === request.proofId && proof.requestId === request.requestId
    && sameScope(proof.scope, scope) && proof.tabId === request.tabId
    && proof.source.instanceId === request.targetInstanceId
    && proof.source.generation === request.targetGeneration && proof.source.origin === request.sourceOrigin
    && proof.url === request.destinationUrl && proof.destinationOrigin === request.destinationOrigin
    && proof.intent === request.intent && proof.expiresAt === request.expiresAt
}

function resolvedMatches(value: unknown, request: BrowserApprovalResponseRequest, scope: BrowserReadScope | null): boolean {
  const row = record(value)
  return row?.state === 'resolved' && row.decision === request.decision
    && row.kind === BROWSER_APPROVAL_KIND && row.method === BROWSER_APPROVAL_KIND
    && row.session_id === request.sessionId && row.request_id === request.requestId
    && row.turn_id === request.turnId && row.tab_id === request.tabId
    && row.origin === request.origin && row.target_instance_id === request.targetInstanceId
    && row.target_generation === request.targetGeneration && row.proof_id === request.proofId
    && row.action === request.action
    && row.intent === request.intent && row.expires_at === request.expiresAt / 1000
    && (request.action !== 'navigate' || row.source_origin === request.sourceOrigin
      && row.destination_url === request.destinationUrl && row.destination_origin === request.destinationOrigin)
    && (!isActionRequest(request) || row.prepared_id === request.preparedId
      && row.snapshot_id === request.snapshotId && row.element_ref === request.elementRef
      && row.browser_action === request.browserAction && elementMatches(row.element, request))
    && (request.decision !== 'allow_once' || scope !== null && scopeMatches(row, scope))
}

export function registerBrowserApprovalIpc(ipc: Pick<IpcMain, 'handle'>, owners: Owners): void {
  const inFlight = new Set<string>()
  ipc.handle(BROWSER_APPROVAL_RESPONSE_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<BrowserApprovalResponseReply> => {
    const contents = owners.contents()
    const navigationEpoch = owners.rendererNavigationEpoch()
    const trustedSender = (): boolean => {
      if (!contents || owners.contents() !== contents || event.sender !== contents
        || event.senderFrame !== contents.mainFrame || contents.isDestroyed()
        || owners.rendererNavigationEpoch() !== navigationEpoch || contents.isLoadingMainFrame()) return false
      try {
        const origin = owners.rendererOrigin()
        return Boolean(origin) && new URL(contents.getURL()).origin === origin
      } catch { return false }
    }
    if (!trustedSender() || !owners.enabled() || args.length !== 1) return UNKNOWN
    const request = parseRequest(args[0])
    const base = owners.backendBase()
    if (!request || !base) return UNKNOWN
    if (request.decision === 'allow_once' && request.action !== 'read' && request.action !== 'navigate'
      && !isActionRequest(request)) return UNKNOWN
    let endpoint: URL
    try {
      endpoint = new URL(base)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') return UNKNOWN
    } catch { return UNKNOWN }
    const identity = `${request.sessionId}:${request.requestId}`
    if (inFlight.has(identity)) return UNKNOWN
    inFlight.add(identity)
    try {
      const pendingResponse = await owners.fetch(`${base}${PENDING_PATH}`, {
        method: 'GET', credentials: 'include', redirect: 'error'
      })
      if (!pendingResponse.ok) return UNKNOWN
      const pending = record(await pendingResponse.json())
      if (!Array.isArray(pending?.interactions)
        || !pending.interactions.some(value => pendingMatches(value, request))) return UNKNOWN
      const scope = owners.activeScope(request.sessionId, request.turnId)
      if (request.decision === 'allow_once' && (!scope
        || !pending.interactions.some(value => pendingMatches(value, request) && scopeMatches(value, scope)))) return UNKNOWN
      if (request.decision === 'allow_once' && (!scope || (request.action === 'read'
        ? !owners.readProof || !proofMatches(owners.readProof(request.requestId, request.proofId), request, scope)
        : request.action === 'navigate'
          ? !owners.navigateProof || !navigateProofMatches(owners.navigateProof(request.requestId, request.proofId), request, scope)
          : !owners.actionProof || !actionProofMatches(owners.actionProof(request.requestId, request.proofId), request, scope)))) return UNKNOWN
      if (!trustedSender() || request.expiresAt <= Date.now()) return UNKNOWN
      if (request.decision === 'allow_once') {
        const target = request.action === 'navigate' ? owners.browserNavigateTarget?.(request.tabId)
          : owners.browserTarget(request.tabId)
        if (!target || target.instanceId !== request.targetInstanceId
          || target.generation !== request.targetGeneration
          || target.origin !== (request.action === 'navigate' ? request.sourceOrigin : request.origin)
          || request.action === 'navigate' && request.sourceOrigin === null && (!('url' in target) || target.url !== 'about:blank')) return UNKNOWN
      }
      if (!trustedSender()) return UNKNOWN
      const response = await owners.fetch(
        `${base}/api/serve/sessions/${encodeURIComponent(request.sessionId)}/hil/${encodeURIComponent(request.requestId)}`,
        {
          method: 'POST', credentials: 'include', redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...owners.hostHeader() },
          body: JSON.stringify({ decision: request.decision })
        }
      )
      if (!response.ok) return UNKNOWN
      const body = record(await response.json())
      if (body?.ok !== true || body.request_id !== request.requestId
        || !resolvedMatches(body.interaction, request, scope) || !trustedSender()
        || request.decision === 'allow_once' && (!scope || !sameScope(owners.activeScope(request.sessionId, request.turnId), scope))) return UNKNOWN
      if (request.decision === 'allow_once') {
        const target = request.action === 'navigate' ? owners.browserNavigateTarget?.(request.tabId)
          : owners.browserTarget(request.tabId)
        if (!target || target.instanceId !== request.targetInstanceId
          || target.generation !== request.targetGeneration
          || target.origin !== (request.action === 'navigate' ? request.sourceOrigin : request.origin)
          || request.action === 'navigate' && request.sourceOrigin === null && (!('url' in target) || target.url !== 'about:blank')
          || request.expiresAt <= Date.now()) return UNKNOWN
        if (request.action === 'navigate') {
          if (!owners.grantNavigate || !owners.navigateProof
            || !navigateProofMatches(owners.navigateProof(request.requestId, request.proofId), request, scope!)) return UNKNOWN
          owners.grantNavigate(request)
        } else if (isActionRequest(request)) {
          if (!owners.grantAction || !owners.actionProof
            || !actionProofMatches(owners.actionProof(request.requestId, request.proofId), request, scope!)) return UNKNOWN
          owners.grantAction(request)
        } else {
          if (!owners.grantRead) return UNKNOWN
          owners.grantRead(request)
        }
      }
      return body as unknown as BrowserApprovalResponseReply
    } catch { return UNKNOWN }
    finally { inFlight.delete(identity) }
  })
}

interface HistoryOwners {
  enabled(): boolean

  contents(): WebContents | null
  rendererOrigin(): string | null
  rendererNavigationEpoch(): number
  backendBase(): string | null
  activeScope(sessionId: string, turnId: string): BrowserReadScope | null
  historyProof(requestId: string, proofId: string): HistoryAgentProof
  grantHistory(request: BrowserHistoryApprovalResponseRequest, scope: BrowserReadScope): void
  hostHeader(): Record<string, string>
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

function historyRequest(value: unknown): BrowserHistoryApprovalResponseRequest | null {
  const input = record(value)
  if (!input || Object.keys(input).sort().join(',') !==
    'decision,expiresAt,historyRevision,intent,limit,offset,proofId,queryDigest,requestId,search,sessionId,turnId'
    || !validId(input.sessionId) || !validId(input.requestId) || !validId(input.proofId)
    || !validId(input.turnId) || typeof input.search !== 'string' || !input.search.trim()
    || input.search.length > 256 || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0
    || Number(input.offset) > 1000 || !Number.isSafeInteger(input.limit) || Number(input.limit) < 1
    || Number(input.limit) > 20 || typeof input.intent !== 'string' || !input.intent.trim()
    || input.intent.length > MAX_INTENT_LENGTH || typeof input.queryDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.queryDigest) || !Number.isSafeInteger(input.historyRevision)
    || Number(input.historyRevision) < 0 || typeof input.expiresAt !== 'number'
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()
    || input.decision !== 'deny' && input.decision !== 'allow_once') return null
  return input as unknown as BrowserHistoryApprovalResponseRequest
}

function historyInteractionMatches(value: unknown, request: BrowserHistoryApprovalResponseRequest,
  state: 'pending' | 'resolved', scope: BrowserReadScope | null): boolean {
  const row = record(value)
  return !!row && row.kind === 'browser_history_approval' && row.method === 'browser_history_approval'
    && row.state === state && row.session_id === request.sessionId && row.request_id === request.requestId
    && row.turn_id === request.turnId && row.proof_id === request.proofId
    && row.search === request.search && row.offset === request.offset && row.limit === request.limit
    && row.intent === request.intent && row.query_digest === request.queryDigest
    && row.history_revision === request.historyRevision && row.expires_at === request.expiresAt / 1000
    && (state === 'pending' || row.decision === request.decision)
    && (scope === null || scopeMatches(row, scope))
}

function historyProofMatches(proof: HistoryAgentProof, request: BrowserHistoryApprovalResponseRequest,
  scope: BrowserReadScope): boolean {
  return proof.proofId === request.proofId && proof.requestId === request.requestId
    && sameScope(proof.scope, scope) && proof.search === request.search && proof.offset === request.offset
    && proof.limit === request.limit && proof.intent === request.intent
    && proof.queryDigest === request.queryDigest && proof.historyRevision === request.historyRevision
    && proof.expiresAt === request.expiresAt
}

export function registerBrowserHistoryApprovalIpc(ipc: Pick<IpcMain, 'handle'>, owners: HistoryOwners): void {
  const inFlight = new Set<string>()
  ipc.handle(BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL, async (event: IpcMainInvokeEvent,
    ...args: unknown[]): Promise<BrowserApprovalResponseReply> => {
    const contents = owners.contents()
    const navigationEpoch = owners.rendererNavigationEpoch()
    const trustedSender = (): boolean => {
      if (!contents || owners.contents() !== contents || event.sender !== contents
        || event.senderFrame !== contents.mainFrame || contents.isDestroyed()
        || contents.isLoadingMainFrame() || owners.rendererNavigationEpoch() !== navigationEpoch) return false
      try {
        const origin = owners.rendererOrigin()
        return Boolean(origin) && new URL(contents.getURL()).origin === origin
      } catch { return false }
    }
    if (!trustedSender() || !owners.enabled() || args.length !== 1) return UNKNOWN
    const request = historyRequest(args[0])
    const base = owners.backendBase()
    if (!request || !base) return UNKNOWN
    try {
      const endpoint = new URL(base)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.pathname !== '/') return UNKNOWN
    } catch { return UNKNOWN }
    const identity = JSON.stringify([request.sessionId, request.requestId])
    if (inFlight.has(identity)) return UNKNOWN
    inFlight.add(identity)
    try {
      const pendingResponse = await owners.fetch(`${base}${PENDING_PATH}`, {
        method: 'GET', credentials: 'include', redirect: 'error'
      })
      if (!pendingResponse.ok) return UNKNOWN
      const pending = record(await pendingResponse.json())
      const scope = owners.activeScope(request.sessionId, request.turnId)
      if (!Array.isArray(pending?.interactions)
        || !pending.interactions.some(value => historyInteractionMatches(value, request, 'pending',
          request.decision === 'allow_once' ? scope : null))) return UNKNOWN
      if (request.decision === 'allow_once' && (!scope
        || !historyProofMatches(owners.historyProof(request.requestId, request.proofId), request, scope))) return UNKNOWN
      if (!trustedSender() || request.expiresAt <= Date.now()) return UNKNOWN
      const response = await owners.fetch(
        `${base}/api/serve/sessions/${encodeURIComponent(request.sessionId)}/hil/${encodeURIComponent(request.requestId)}`,
        { method: 'POST', credentials: 'include', redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...owners.hostHeader() },
          body: JSON.stringify({ decision: request.decision }) }
      )
      if (!response.ok) return UNKNOWN
      const body = record(await response.json())
      if (body?.ok !== true || body.request_id !== request.requestId
        || !historyInteractionMatches(body.interaction, request, 'resolved', scope)
        || !trustedSender() || request.expiresAt <= Date.now()) return UNKNOWN
      if (request.decision === 'allow_once') {
        if (!scope || !sameScope(owners.activeScope(request.sessionId, request.turnId), scope)
          || !historyProofMatches(owners.historyProof(request.requestId, request.proofId), request, scope)) return UNKNOWN
        owners.grantHistory(request, scope)
      }
      return body as unknown as BrowserApprovalResponseReply
    } catch { return UNKNOWN }
    finally { inFlight.delete(identity) }
  })
}
