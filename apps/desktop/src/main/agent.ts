import { createHash, randomUUID } from 'node:crypto'

import { BROWSER_ERROR } from '../browser.ts'
import type { BrowserAgentContinuity } from '../browser.ts'
import type { BrowserNavigateGrant, BrowserNavigateProof, BrowserReadScope } from './grant.ts'
import { browserResourceAllowed, normalizeBrowserInput } from './navigation.ts'

const LEASE_MS = 30_000
const SNAPSHOT_MS = 10_000
const MAX_ELEMENTS = 96
const MAX_NAME_LENGTH = 320
const MAX_TITLE_LENGTH = 320
const MAX_LEASES = 4
const MAX_AX_NODES = 512
const MAX_AX_VALUE_LENGTH = 4_096
const MAX_AX_TREE_BYTES = 1_048_576
const MAX_SNAPSHOT_BYTES = 48_000
const AX_INSPECTION_CONCURRENCY = 8
const MAX_RELATED_NODES = 8
const MAX_DOM_NODES = 32
const MAX_SNAPSHOT_DOM_NODES = 256
const COMMAND_TIMEOUT_MS = 5_000
const MAX_PREPARED = 64
const MAX_REPLAY_RECORDS = 4_096
const MAX_UNFENCED_SCOPES = 4_096
const EFFECT_SETTLE_MS = 8_000
const EFFECT_QUIET_MS = 400
const EFFECT_POLL_MS = 25
const MAX_EFFECT_EVENTS = 1_024
const MAX_EFFECT_REQUESTS = 256
const APPROVAL_TTL_MS = 30_000
const MAX_FILL_LENGTH = 4_096
const MAX_INTENT_LENGTH = 512
const CDP_CONTROL_MODIFIER = process.platform === 'darwin' ? 4 : 2
const CDP_SELECT_ALL_COMMAND = 'selectAll'
const AUTHORITY_UNAVAILABLE = 'authority_unavailable'
const SUBMIT_APPROVAL_REQUIRED = 'submit_requires_approval'
const AX_UNINTERESTING_REASON = 'uninteresting'
const PRESENTATION_ATTRIBUTES = new Set(['class', 'style'])
const NODE_PRESENTATION_ATTRIBUTES = new Map([
  ['BODY', new Set(['link', 'vlink', 'alink', 'text', 'bgcolor'])],
])
export const OBSERVATION_READ_REQUIRED = 'observation_read_required'
const OBSERVATION_VALUE_ATTRIBUTE = 'value'
const OBSERVATION_OTHER_ATTRIBUTE = 'other'
const OBSERVATION_NODE_KINDS = new Set(['#document', 'html', 'body', 'form', 'div', 'span', 'input', 'textarea', 'button', 'label'])
const OBSERVATION_DIAGNOSTIC_ATTRIBUTES = new Set(['id', 'name', 'type', 'role', 'placeholder', 'aria-label',
  'aria-labelledby', 'aria-hidden', 'hidden', 'inert', 'disabled', 'readonly', 'contenteditable',
  'form', 'action', 'formaction', 'method', 'formmethod', 'target', 'formtarget', 'autocomplete',
  'autofocus', 'aria-expanded', 'aria-activedescendant', 'aria-controls', 'aria-owns', 'aria-busy', 'tabindex'])
const EDITABLE_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number'])
const HIDDEN_ROLES = new Set(['iframe', 'frame', 'combobox', 'spinbutton', 'passwordfield'])
const VALUE_ROLES = new Set(['textfield', 'textbox', 'searchbox'])
const SENSITIVE_INPUT_TYPES = new Set(['password', 'hidden'])
const SAFE_SNAPSHOT_ERRORS = new Set(['stale_ref', 'stale_grant', 'snapshot_too_large', 'snapshot_timeout', 'snapshot_unavailable'])
const SAFE_AGENT_FAILURES = new Set([...SAFE_SNAPSHOT_ERRORS, OBSERVATION_READ_REQUIRED, 'approval_required', 'stale_action', 'stale_target',
  'action_outcome_unknown', 'action_cancelled_before_dispatch', 'request_expired', 'replayed_request', 'replayed_approval',
  'non_interactive_ref', SUBMIT_APPROVAL_REQUIRED, 'cross_frame_denied'])

export function agentFailureCode(error: unknown): string {
  return error instanceof Error && SAFE_AGENT_FAILURES.has(error.message) ? error.message : 'operation_failed'
}

export interface AgentReadAuthority {
  scope: BrowserReadScope
  tabId: string
  grantId: string
  grantRequestId: string
  grantRevision: number
}

export interface AgentReadElement {
  ref: string
  role: string
  name: string
}

export interface AgentReadSnapshot {
  snapshotId: string
  origin: string
  title: string
  elements: AgentReadElement[]
}

export interface AgentTargetProof {
  tabId: string
  instanceId: string
  generation: number
  origin: string | null
  title: string
  url: string
}

export interface AgentPreparedAction {
  id: string
  proofId: string
  requestId: string
  action: 'click' | 'fill' | 'submit'
  scope: BrowserReadScope
  tabId: string
  target: AgentTargetProof
  snapshotId: string
  elementRef: string
  backendNodeId: number
  grantId: string
  grantRequestId: string
  grantRevision: number
  revocationEpoch: number
  expiresAt: number
  consequential: true
  intent: string
  element?: Pick<AgentReadElement, 'role' | 'name'>
}

export interface AgentApprovalEvidence {
  preparedId: string
  proofId: string
  approvalId: string
  requestId: string
  scope: BrowserReadScope
  tabId: string
  target: AgentTargetProof
  snapshotId: string
  elementRef: string
  backendNodeId: number
  grantId: string
  grantRequestId: string
  grantRevision: number
  revocationEpoch: number
  action: AgentPreparedAction['action']
  expiresAt: number
  intent: string
}

interface PreparedRecord {
  result: AgentPreparedAction
  authority: AgentReadAuthority
  expiresAt: number
  revocationEpoch: number
  snapshotId?: string
  elementRef?: string
  backendNodeId?: number
  value?: string
  intent?: string
}

interface PreparedNavigateRecord {
  proof: BrowserNavigateProof
  revocationEpoch: number
}

interface ActiveNavigateRecord {
  requestId: string
  scope: BrowserReadScope
  cancelled: boolean
}

interface AxRelatedNode { backendDOMNodeId?: number; text?: string }
interface AxValue { value?: unknown; sources?: Array<{ type?: string; superseded?: boolean; value?: unknown;
  attributeValue?: { relatedNodes?: AxRelatedNode[] }; nativeSourceValue?: { relatedNodes?: AxRelatedNode[] } }> }
interface AxNode { nodeId?: string; parentId?: string; childIds?: string[]; frameId?: string; backendDOMNodeId?: number; ignored?: boolean;
  ignoredReasons?: Array<{ name?: string }>; role?: AxValue; name?: AxValue }
interface AgentElement { public: AgentReadElement; backendNodeId: number | null; nodeId: string;
  relatedNodeIds: number[]; domNodeIds: number[] }
interface AgentObservation {
  authority: AgentReadAuthority
  target: AgentTargetProof
  contents: AgentPage
  snapshotId: string
  topFrameId: string
  revocationEpoch: number
  elements: Map<string, { element: AgentElement; fingerprints: Map<number, ObservationFingerprint> }>
}
interface ObservationNode { nodeName?: string; attributes?: string[]; frameId?: string }
interface ObservationFingerprint {
  digest: string
  unorderedDigest: string
  nodeKind: string
  identity: string
  attributes: Map<string, string>
}
export interface AgentPage {
  debugger: {
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    isAttached(): boolean
    on(event: 'message', listener: (event: Electron.Event, method: string, params: Record<string, unknown>, sessionId: string) => void): void
    on(event: 'detach', listener: (event: Electron.Event, reason: string) => void): void
    removeListener(event: 'message', listener: (event: Electron.Event, method: string, params: Record<string, unknown>, sessionId: string) => void): void
    removeListener(event: 'detach', listener: (event: Electron.Event, reason: string) => void): void
  }
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getTitle(): string
}

interface AgentPageIdentity {
  contents: AgentPage
  generation: number
  instanceId: string
  title: string
  url: string
}

export interface AgentBrowserPort {
  agentTarget(tabId: string): AgentPageIdentity & { origin: string }
  agentNavigationTarget(tabId: string): AgentPageIdentity & { origin: string | null }
  agentNavigate(tabId: string, input: string, approvedOrigin: string): Promise<void>
  blockAgentPopups(tabId: string): () => void
  cancelAgentNavigation(tabId: string): void
  attach(tabId: string): AgentPage
  detach(tabId: string): void
  detachAgent(tabId: string): void
  onDebuggerDetach(listener: (tabId: string, reason: string, continuity?: BrowserAgentContinuity) => void): () => void
}

interface AgentLease {
  authority: AgentReadAuthority
  contents: AgentPage
  origin: string
  instanceId: string
  generation: number
  snapshotId: string | null
  snapshotExpiresAt: number
  observationOnly: boolean
  elements: Map<string, AgentElement>
  topFrameId: string | null
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  debuggerDetached: boolean
  observingEffects: boolean
  targetInvalidated: boolean
}

interface EffectObservation {
  markEffectSettled(): void
  wait(): Promise<boolean>
  close(): void
}

interface EffectRecord {
  completion: Promise<boolean>
  finish(settled: boolean): void
}

function sameAuthority(left: AgentReadAuthority, right: AgentReadAuthority): boolean {
  return left.scope.sessionId === right.scope.sessionId && left.scope.instanceId === right.scope.instanceId
    && left.scope.productTurnId === right.scope.productTurnId && left.scope.turnId === right.scope.turnId
    && left.scope.generation === right.scope.generation
    && left.scope.interruptGeneration === right.scope.interruptGeneration
    && left.scope.lifecycleEpoch === right.scope.lifecycleEpoch
    && left.tabId === right.tabId && left.grantId === right.grantId && left.grantRequestId === right.grantRequestId
    && left.grantRevision === right.grantRevision
}

function sameScope(left: BrowserReadScope, right: BrowserReadScope): boolean {
  return left.sessionId === right.sessionId && left.instanceId === right.instanceId
    && left.productTurnId === right.productTurnId && left.turnId === right.turnId
    && left.generation === right.generation && left.interruptGeneration === right.interruptGeneration
    && left.lifecycleEpoch === right.lifecycleEpoch
}

function copyAuthority(authority: AgentReadAuthority): AgentReadAuthority {
  return { ...authority, scope: { ...authority.scope } }
}

function axText(value: AxValue | undefined, limit: number): string {
  return typeof value?.value === 'string' ? value.value.slice(0, limit) : ''
}

function visibleElements(nodes: AxNode[], topFrameId: string): AgentElement[] {
  const byId = new Map(nodes.filter(node => node.nodeId).map(node => [node.nodeId!, node]))
  const byBackendId = new Map<number, AxNode[]>()
  for (const node of nodes) if (Number.isSafeInteger(node.backendDOMNodeId) && node.backendDOMNodeId! > 0) {
    const matching = byBackendId.get(node.backendDOMNodeId!) ?? []
    matching.push(node)
    byBackendId.set(node.backendDOMNodeId!, matching)
  }
  const safeAncestry = (node: AxNode): AxNode[] | null => {
    let current: AxNode | undefined = node
    const visited = new Set<string>()
    const chain: AxNode[] = []
    while (current) {
      const role = axText(current.role, MAX_NAME_LENGTH).toLowerCase()
      if (!current.nodeId || visited.has(current.nodeId)
        || current.ignored && (current === node || role !== 'none'
          || current.ignoredReasons?.length !== 1 || current.ignoredReasons[0]?.name !== AX_UNINTERESTING_REASON)
        || current.frameId && current.frameId !== topFrameId
        || HIDDEN_ROLES.has(role)
        || current !== node && VALUE_ROLES.has(role)) return null
      visited.add(current.nodeId)
      chain.push(current)
      if (!current.parentId) return current.frameId === topFrameId
        && axText(current.role, MAX_NAME_LENGTH).toLowerCase() === 'rootwebarea' ? chain : null
      current = byId.get(current.parentId)
    }
    return null
  }
  const elements: AgentElement[] = []
  for (const node of nodes) {
    if (elements.length >= MAX_ELEMENTS) break
    const ancestry = safeAncestry(node)
    if (!ancestry) continue
    if (node.name?.sources !== undefined && !Array.isArray(node.name.sources)) continue
    const relatedNodeIds: number[] = []
    const domNodeIds = new Set(ancestry.map(ancestor => ancestor.backendDOMNodeId)
      .filter((backendNodeId): backendNodeId is number => Number.isSafeInteger(backendNodeId) && backendNodeId! > 0))
    let unsafeSource = false
    for (const source of node.name?.sources ?? []) {
      if (source.type !== 'relatedElement' || source.superseded) continue
      const relatedNodes = source.attributeValue?.relatedNodes ?? source.nativeSourceValue?.relatedNodes
      if (source.value === undefined && !relatedNodes?.length) continue
      if (!Array.isArray(relatedNodes) || relatedNodes.length === 0 || relatedNodes.length > MAX_RELATED_NODES) {
        unsafeSource = true; break
      }
      for (const related of relatedNodes) {
        const backendNodeId = related?.backendDOMNodeId
        if (!Number.isSafeInteger(backendNodeId) || backendNodeId! <= 0) { unsafeSource = true; break }
        const relatedAncestry = byBackendId.get(backendNodeId!)?.map(safeAncestry).find(chain => chain !== null)
        if (!relatedAncestry) { unsafeSource = true; break }
        relatedNodeIds.push(backendNodeId!)
        for (const ancestor of relatedAncestry) if (Number.isSafeInteger(ancestor.backendDOMNodeId) && ancestor.backendDOMNodeId! > 0) {
          domNodeIds.add(ancestor.backendDOMNodeId!)
        }
      }
      if (unsafeSource) break
    }
    if (unsafeSource || domNodeIds.size > MAX_DOM_NODES) continue
    const name = axText(node.name, MAX_NAME_LENGTH)
    if (!name) continue
    const role = axText(node.role, MAX_NAME_LENGTH)
    const backendNodeId = Number.isSafeInteger(node.backendDOMNodeId) && node.backendDOMNodeId! > 0 ? node.backendDOMNodeId! : null
    if (backendNodeId === null && role.toLowerCase() !== 'rootwebarea') continue
    elements.push({ public: { ref: randomUUID(), role, name }, backendNodeId, nodeId: node.nodeId!,
      relatedNodeIds, domNodeIds: [...domNodeIds] })
  }
  return elements
}

async function boundedCommand(contents: AgentPage, method: string, params?: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      contents.debugger.sendCommand(method, params).catch(() => { throw new Error('snapshot_unavailable') }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('snapshot_timeout')), COMMAND_TIMEOUT_MS) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

function validateAxTree(nodes: unknown): asserts nodes is AxNode[] {
  if (!Array.isArray(nodes) || nodes.length > MAX_AX_NODES || nodes.some(node =>
    !node || typeof node !== 'object' || typeof node.nodeId !== 'string'
    || typeof node.name?.value === 'string' && node.name.value.length > MAX_AX_VALUE_LENGTH
    || typeof node.role?.value === 'string' && node.role.value.length > MAX_AX_VALUE_LENGTH)
    || Buffer.byteLength(JSON.stringify(nodes), 'utf8') > MAX_AX_TREE_BYTES) throw new Error('snapshot_too_large')
}

function snapshotError(error: unknown): Error {
  return error instanceof Error && SAFE_SNAPSHOT_ERRORS.has(error.message) ? error : new Error('snapshot_unavailable')
}

function actionAttributes(attributes: string[]): string[] {
  return attributes.filter((_value, index) => !PRESENTATION_ATTRIBUTES.has(attributes[index - index % 2].toLowerCase()))
}

function observationFingerprint(node: ObservationNode): ObservationFingerprint {
  const attributes = node.attributes ?? []
  const security = actionAttributes(attributes).filter((_value, index, filtered) =>
    filtered[index - index % 2].toLowerCase() !== OBSERVATION_VALUE_ATTRIBUTE
      && !NODE_PRESENTATION_ATTRIBUTES.get(node.nodeName?.toUpperCase() ?? '')
        ?.has(filtered[index - index % 2].toLowerCase()))
  const pairs: string[][] = []
  const groups = new Map<string, string[][]>()
  for (let index = 0; index < security.length; index += 2) {
    const pair = [security[index], security[index + 1]]
    pairs.push(pair)
    const category = OBSERVATION_DIAGNOSTIC_ATTRIBUTES.has(pair[0]) ? pair[0] : OBSERVATION_OTHER_ATTRIBUTE
    const grouped = groups.get(category) ?? []
    grouped.push(pair)
    groups.set(category, grouped)
  }
  const nodeKind = node.nodeName?.toLowerCase() ?? OBSERVATION_OTHER_ATTRIBUTE
  return {
    digest: createHash('sha256').update(JSON.stringify([node.nodeName, node.frameId, security])).digest('hex'),
    unorderedDigest: createHash('sha256').update(JSON.stringify([node.nodeName, node.frameId,
      pairs.sort((left, right) => left[0].localeCompare(right[0]))])).digest('hex'),
    nodeKind: OBSERVATION_NODE_KINDS.has(nodeKind) ? nodeKind : OBSERVATION_OTHER_ATTRIBUTE,
    identity: createHash('sha256').update(JSON.stringify([node.nodeName, node.frameId])).digest('hex'),
    attributes: new Map([...groups].map(([category, group]) => [category,
      createHash('sha256').update(JSON.stringify(group)).digest('hex')])),
  }
}

async function completeAxTree(command: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  topFrameId: string): Promise<AxNode[]> {
  const initial = await command('Accessibility.getFullAXTree', { frameId: topFrameId }) as { nodes: AxNode[] }
  validateAxTree(initial?.nodes)
  const nodes = new Map(initial.nodes.map(node => [node.nodeId!, node]))
  if (nodes.size !== initial.nodes.length) throw new Error('stale_ref')
  for (const node of nodes.values()) {
    const role = axText(node.role, MAX_NAME_LENGTH).toLowerCase()
    if (node.frameId && node.frameId !== topFrameId || HIDDEN_ROLES.has(role) || VALUE_ROLES.has(role)
      || node.ignored && (role !== 'none' || node.ignoredReasons?.length !== 1
        || node.ignoredReasons[0]?.name !== AX_UNINTERESTING_REASON)) continue
    if (node.childIds === undefined) continue
    if (!Array.isArray(node.childIds) || node.childIds.length > MAX_AX_NODES
      || node.childIds.some(id => typeof id !== 'string')) throw new Error('snapshot_too_large')
    if (node.childIds.some(id => !nodes.has(id))) throw new Error('stale_ref')
  }
  return [...nodes.values()]
}

async function safeElement(command: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  element: AgentElement, topFrameId: string): Promise<boolean> {
  if (element.backendNodeId === null) return true
  for (const backendNodeId of new Set([element.backendNodeId, ...element.relatedNodeIds, ...element.domNodeIds])) {
    let described: { node?: { nodeName?: string; attributes?: string[]; frameId?: string } }
    try { described = await command('DOM.describeNode', { backendNodeId }) as typeof described }
    catch (error) {
      if (error instanceof Error && SAFE_SNAPSHOT_ERRORS.has(error.message) && error.message !== 'snapshot_unavailable') throw error
      return false
    }
    const node = described?.node
    if (!node?.nodeName || node.frameId && node.frameId !== topFrameId
      || node.attributes !== undefined && !Array.isArray(node.attributes)) return false
    const attributes = node.attributes ?? []
    const typeIndex = attributes.findIndex((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === 'type')
    const inputType = typeIndex >= 0 ? attributes[typeIndex + 1]?.toLowerCase() : undefined
    if (node.nodeName.toUpperCase() === 'INPUT' && SENSITIVE_INPUT_TYPES.has(inputType ?? 'text')) return false
    if (attributes.some((attribute, index) => index % 2 === 0 && ['hidden', 'inert'].includes(attribute.toLowerCase()))) return false
    const ariaHiddenIndex = attributes.findIndex((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === 'aria-hidden')
    if (ariaHiddenIndex >= 0 && attributes[ariaHiddenIndex + 1]?.toLowerCase() === 'true') return false
  }
  return true
}

export function createAgentBrowserController(registry: AgentBrowserPort,
  options?: { validateAuthority(authority: AgentReadAuthority): boolean;
    validateActionPolicy?(authority: AgentReadAuthority, origin: string): boolean;
    actionFence?: Set<string> }) {
  if (typeof options?.validateAuthority !== 'function') throw new Error(AUTHORITY_UNAVAILABLE)
  const leases = new Map<string, AgentLease>()
  const observations = new Map<string, AgentObservation>()
  const prepared = new Map<string, PreparedRecord>()
  const preparedTimers = new Map<string, NodeJS.Timeout>()
  const approvedActions = new Map<string, { proofId: string; approvalId: string }>()
  const actionApprovalWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>()
  const preparedNavigations = new Map<string, PreparedNavigateRecord>()
  const activeNavigations = new Map<string, ActiveNavigateRecord>()
  const requestIds = new Map<string, number>()
  const approvalIds = new Map<string, number>()
  const navigateGrantIds = new Map<string, number>()
  const revocationEpochs = new Map<string, number>()
  const activeEffects = new Map<Promise<unknown>, BrowserReadScope>()
  const effectDrainWaiters = new Set<{ changed(): void; cancel(): void }>()
  const observedEffects = new Map<string, Set<EffectRecord>>()
  const failedEffectScopes = new Set<string>()
  const unfencedScopes = options.actionFence ?? new Set<string>()
  const scopeKey = (scope: BrowserReadScope): string => JSON.stringify([
    scope.sessionId, scope.instanceId, scope.productTurnId, scope.turnId, scope.generation,
    scope.interruptGeneration, scope.lifecycleEpoch])
  let disposed = false
  const targetProof = (tabId: string, allowBlank = false): AgentTargetProof => {
    const target = allowBlank ? registry.agentNavigationTarget(tabId) : registry.agentTarget(tabId)
    return { tabId, instanceId: target.instanceId, generation: target.generation, origin: target.origin,
      title: target.title.slice(0, MAX_TITLE_LENGTH), url: target.url }
  }
  const sameProof = (left: AgentTargetProof, right: AgentTargetProof): boolean =>
    left.tabId === right.tabId && left.instanceId === right.instanceId && left.generation === right.generation
    && left.origin === right.origin && left.url === right.url && left.title === right.title
  const validateAuthority = (authority: AgentReadAuthority): void => {
    if (!authority.scope?.sessionId || !authority.scope.instanceId || !authority.scope.productTurnId
      || !authority.scope.turnId || !authority.tabId || !authority.grantId || !authority.grantRequestId
      || !options.validateAuthority(authority)) throw new Error('stale_grant')
  }
  const validateActionPolicy = (authority: AgentReadAuthority, origin: string): void => {
    if (options.validateActionPolicy && !options.validateActionPolicy(authority, origin)) throw new Error('stale_grant')
  }
  const deletePrepared = (id: string): void => {
    prepared.delete(id)
    actionApprovalWaiters.get(id)?.reject(new Error('stale_action'))
    actionApprovalWaiters.delete(id)
    const timer = preparedTimers.get(id)
    if (timer) clearTimeout(timer)
    preparedTimers.delete(id)
  }
  const pruneExpired = (): void => {
    const now = Date.now()
    for (const [id, record] of prepared) if (record.expiresAt <= now) deletePrepared(id)
    for (const [requestId, approval] of approvedActions) {
      if (![...prepared.values()].some(record => record.result.requestId === requestId
        && record.result.proofId === approval.proofId)) approvedActions.delete(requestId)
    }
    for (const [id, record] of preparedNavigations) if (record.proof.expiresAt <= now) preparedNavigations.delete(id)
    for (const [id, expiresAt] of requestIds) if (expiresAt <= now) requestIds.delete(id)
    for (const [id, expiresAt] of approvalIds) if (expiresAt <= now) approvalIds.delete(id)
    for (const [id, expiresAt] of navigateGrantIds) if (expiresAt <= now) navigateGrantIds.delete(id)
  }
  const reserve = (authority: AgentReadAuthority, requestId: string, action: AgentPreparedAction['action'],
    extras: Omit<PreparedRecord, 'result' | 'authority' | 'expiresAt' | 'revocationEpoch'>,
    element?: AgentReadElement): AgentPreparedAction => {
    pruneExpired()
    if (!requestId || requestIds.has(requestId) || requestIds.size >= MAX_REPLAY_RECORDS) throw new Error('replayed_request')
    if (prepared.size >= MAX_PREPARED) throw new Error('action_capacity_exhausted')
    const expiresAt = Date.now() + APPROVAL_TTL_MS
    const revocationEpoch = revocationEpochs.get(authority.tabId) ?? 0
    const result: AgentPreparedAction = { id: randomUUID(), proofId: randomUUID(), requestId, action,
      scope: { ...authority.scope }, tabId: authority.tabId, target: targetProof(authority.tabId),
      snapshotId: extras.snapshotId!, elementRef: extras.elementRef!, backendNodeId: extras.backendNodeId!,
      grantId: authority.grantId, grantRequestId: authority.grantRequestId,
      grantRevision: authority.grantRevision, revocationEpoch, expiresAt, consequential: true,
      intent: extras.intent!, element: element && { role: element.role, name: element.name } }
    requestIds.set(requestId, expiresAt)
    prepared.set(result.id, { result, authority: copyAuthority(authority), expiresAt,
      revocationEpoch, ...extras })
    preparedTimers.set(result.id, setTimeout(() => deletePrepared(result.id), Math.max(0, expiresAt - Date.now())))
    return result
  }
  const release = (tabId: string, detach: boolean, expected?: AgentLease) => {
    const lease = leases.get(tabId)
    if (!lease || expected && lease !== expected) return
    leases.delete(tabId)
    for (const [id, record] of prepared) if (record.result.tabId === tabId
      && (!expected || sameScope(record.authority.scope, expected.authority.scope))) deletePrepared(id)
    for (const [requestId] of approvedActions) if (![...prepared.values()].some(record => record.result.requestId === requestId)) approvedActions.delete(requestId)
    clearTimeout(lease.timer)
    lease.elements.clear()
    if (detach && !lease.contents.isDestroyed()) {
      try { registry.detachAgent(tabId) } catch { /* target closed */ }
    }
  }
  const unsubscribe = registry.onDebuggerDetach((tabId, _reason, continuity) => {
    const observation = observations.get(tabId)
    let continuous = false
    if (observation && continuity && !disposed
      && !unfencedScopes.has(scopeKey(observation.authority.scope))
      && observation.revocationEpoch === (revocationEpochs.get(tabId) ?? 0)
      && observation.target.instanceId === continuity.instanceId
      && observation.target.generation === continuity.previousGeneration
      && continuity.generation === continuity.previousGeneration + 1) {
      try {
        const current = registry.agentTarget(tabId)
        validateActionPolicy(observation.authority, observation.target.origin!)
        continuous = current.contents === observation.contents && !observation.contents.isDestroyed()
          && !observation.contents.isLoadingMainFrame?.()
          && current.instanceId === continuity.instanceId && current.generation === continuity.generation
          && current.origin === observation.target.origin
        if (continuous) observation.target = { ...observation.target, generation: continuity.generation }
      } catch { continuous = false }
    }
    if (!continuous) observations.delete(tabId)
    release(tabId, false)
  })
  const verify = (lease: AgentLease, authority: AgentReadAuthority) => {
    validateAuthority(authority)
    if (disposed || lease.targetInvalidated || lease.debuggerDetached || leases.get(authority.tabId) !== lease || !sameAuthority(lease.authority, authority)
      || Date.now() >= lease.expiresAt) throw new Error('stale_ref')
    let current: ReturnType<AgentBrowserPort['agentTarget']>
    try { current = registry.agentTarget(authority.tabId) }
    catch { release(authority.tabId, true, lease); throw new Error('stale_ref') }
    if (current.contents !== lease.contents || current.origin !== lease.origin || current.generation !== lease.generation
      || current.instanceId !== lease.instanceId
      || !lease.contents.debugger.isAttached() || lease.contents.isLoadingMainFrame?.()) {
      if (!lease.observingEffects || current.contents !== lease.contents || current.instanceId !== lease.instanceId
        || !lease.contents.debugger.isAttached()) release(authority.tabId, true, lease)
      else { lease.snapshotId = null; lease.elements.clear() }
      throw new Error('stale_ref')
    }
  }
  const command = async (lease: AgentLease, authority: AgentReadAuthority, method: string,
    params?: Record<string, unknown>): Promise<unknown> => {
    verify(lease, authority)
    const result = await boundedCommand(lease.contents, method, params)
    verify(lease, authority)
    return result
  }
  const effect = async (lease: AgentLease, authority: AgentReadAuthority, method: string,
    params: Record<string, unknown>): Promise<unknown> => {
    verify(lease, authority)
    const completion = lease.contents.debugger.sendCommand(method, params)
    activeEffects.set(completion, { ...authority.scope })
    try {
      const result = await completion
      verify(lease, authority)
      return result
    } finally {
      activeEffects.delete(completion)
      for (const waiter of effectDrainWaiters) waiter.changed()
    }
  }
  const observeEffects = async (lease: AgentLease, authority: AgentReadAuthority): Promise<EffectObservation> => {
    const debuggerSession = lease.contents.debugger
    if (typeof debuggerSession.on !== 'function' || typeof debuggerSession.removeListener !== 'function') {
      throw new Error('action_observation_unavailable')
    }
    const requests = new Map<string, { mainFrame: boolean; readOnly: boolean; responded: boolean }>()
    const loadingFrames = new Set<string>()
    let navigationPending = false
    let failed = false
    let detached = false
    let events = 0
    let lastActivity = Date.now()
    let lastEffectSettledAt = 0
    const revocationEpoch = revocationEpochs.get(authority.tabId) ?? 0
    const onDetach = (): void => { detached = true; lease.debuggerDetached = true }
    const listener = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
      if (!method.startsWith('Page.') && !method.startsWith('Network.')) return
      events += 1
      lastActivity = Date.now()
      if (events > MAX_EFFECT_EVENTS) { failed = true; return }
      if (method === 'Network.requestWillBeSent') {
        if (typeof params.requestId !== 'string' || !params.requestId) { failed = true; return }
        const request = params.request as { method?: string } | undefined
        requests.set(params.requestId, { mainFrame: params.frameId === lease.topFrameId,
          readOnly: request?.method === 'GET' || request?.method === 'HEAD', responded: false })
        if (requests.size > MAX_EFFECT_REQUESTS) failed = true
      } else if (method === 'Network.responseReceived') {
        const pending = typeof params.requestId === 'string' ? requests.get(params.requestId) : undefined
        if (pending) pending.responded = true
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        if (typeof params.requestId !== 'string') failed = true
        else requests.delete(params.requestId)
      } else if (method === 'Page.frameStartedLoading') {
        if (typeof params.frameId === 'string' && params.frameId === lease.topFrameId) loadingFrames.add(params.frameId)
      } else if (method === 'Page.frameStoppedLoading') {
        if (typeof params.frameId === 'string' && params.frameId === lease.topFrameId) {
          loadingFrames.delete(params.frameId); navigationPending = false
        }
      } else if (method === 'Page.frameNavigated') {
        const frame = params.frame as { id?: string; parentId?: string } | undefined
        if (frame && !frame.parentId && frame.id !== lease.topFrameId) failed = true
        if (frame?.id === lease.topFrameId && !frame.parentId) navigationPending = true
      } else if (method === 'Page.loadEventFired') navigationPending = false
    }
    debuggerSession.on('message', listener)
    debuggerSession.on('detach', onDetach)
    try {
      await command(lease, authority, 'Page.enable')
      await command(lease, authority, 'Network.enable')
    } catch (error) {
      debuggerSession.removeListener('message', listener)
      debuggerSession.removeListener('detach', onDetach)
      throw error
    }
    let result: Promise<boolean> | null = null
    const unsettled = (reason: string): false => {
      console.info('[browser-agent] effects unsettled', JSON.stringify({ reason, requests: requests.size,
        pendingMainFrame: [...requests.values()].filter(request => request.mainFrame).length,
        pendingReadOnly: [...requests.values()].filter(request => request.readOnly).length,
        pendingResponded: [...requests.values()].filter(request => request.responded).length,
        loadingFrames: loadingFrames.size, navigationPending,
        mainLoading: !lease.contents.isDestroyed() && Boolean(lease.contents.isLoadingMainFrame?.()),
        failed, detached }))
      return false
    }
    return {
      markEffectSettled(): void { lastEffectSettledAt = Date.now() },
      wait(): Promise<boolean> {
        if (result) return result
        result = (async () => {
          const deadline = Date.now() + EFFECT_SETTLE_MS
          while (Date.now() < deadline) {
            if (failed || detached || disposed || leases.get(authority.tabId) !== lease
              || (revocationEpochs.get(authority.tabId) ?? 0) !== revocationEpoch
              || lease.contents.isDestroyed() || !debuggerSession.isAttached()) return unsettled('observation_lost')
            try {
              const target = registry.agentTarget(authority.tabId)
              if (target.contents !== lease.contents || target.instanceId !== lease.instanceId) return unsettled('target_replaced')
            } catch { return unsettled('target_unavailable') }
            if (requests.size === 0 && loadingFrames.size === 0 && !navigationPending
              && !lease.contents.isLoadingMainFrame?.()
              && lastEffectSettledAt > 0
              && Date.now() - Math.max(lastActivity, lastEffectSettledAt) >= EFFECT_QUIET_MS) return true
            await new Promise(resolve => setTimeout(resolve, EFFECT_POLL_MS))
          }
          return unsettled('deadline')
        })()
        return result
      },
      close(): void {
        debuggerSession.removeListener('message', listener)
        debuggerSession.removeListener('detach', onDetach)
      }
    }
  }
  const reserveEffect = (scope: BrowserReadScope): EffectRecord => {
    const identity = scopeKey(scope)
    if (unfencedScopes.has(identity) && !observedEffects.has(identity)) failedEffectScopes.add(identity)
    if (!unfencedScopes.has(identity) && unfencedScopes.size >= MAX_UNFENCED_SCOPES) {
      throw new Error('action_capacity_exhausted')
    }
    unfencedScopes.add(identity)
    let resolveCompletion!: (settled: boolean) => void
    const completion = new Promise<boolean>(resolve => { resolveCompletion = resolve })
    const record: EffectRecord = { completion, finish(settled) {
      const active = observedEffects.get(identity)
      if (!active?.delete(record)) return
      if (!settled) failedEffectScopes.add(identity)
      if (active.size === 0) {
        observedEffects.delete(identity)
        if (!failedEffectScopes.has(identity)) unfencedScopes.delete(identity)
      }
      resolveCompletion(settled)
      for (const waiter of effectDrainWaiters) waiter.changed()
    } }
    const active = observedEffects.get(identity) ?? new Set<EffectRecord>()
    active.add(record)
    observedEffects.set(identity, active)
    return record
  }
  const acquire = (authority: AgentReadAuthority, retainDebugger = false): AgentLease => {
    validateAuthority(authority)
    if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
    const previous = leases.get(authority.tabId)
    const previousTarget = registry.agentTarget(authority.tabId)
    const retainedContents = retainDebugger && previous && previous.contents.debugger.isAttached()
      ? previous.contents : null
    if (retainedContents && (previous!.debuggerDetached || previous!.targetInvalidated
      || retainedContents !== previousTarget.contents || previous!.instanceId !== previousTarget.instanceId
      || previous!.generation !== previousTarget.generation || previous!.origin !== previousTarget.origin)) throw new Error('stale_ref')
    if (leases.has(authority.tabId)) release(authority.tabId, !retainDebugger)
    if (leases.size >= MAX_LEASES) throw new Error(BROWSER_ERROR.cdpBusy)
    const target = registry.agentTarget(authority.tabId)
    const contents = retainedContents ?? registry.attach(authority.tabId)
    if (contents !== target.contents) {
      registry.detachAgent(authority.tabId)
      throw new Error(BROWSER_ERROR.targetClosed)
    }
    const lease: AgentLease = { authority: copyAuthority(authority), contents, origin: target.origin, instanceId: target.instanceId, generation: target.generation,
      snapshotId: null, snapshotExpiresAt: 0, observationOnly: false,
      elements: new Map(), topFrameId: null, expiresAt: Date.now() + LEASE_MS,
      timer: setTimeout(() => release(authority.tabId, true, lease), LEASE_MS), debuggerDetached: false, observingEffects: false, targetInvalidated: false }
    leases.set(authority.tabId, lease)
    return lease
  }
  const clearTargetRecords = (tabId: string, scope?: BrowserReadScope): void => {
    for (const [id, record] of prepared) if (record.authority.tabId === tabId
      && (!scope || sameScope(record.authority.scope, scope))) deletePrepared(id)
    for (const [requestId] of approvedActions) if (![...prepared.values()].some(record => record.result.requestId === requestId)) approvedActions.delete(requestId)
    for (const [id, record] of preparedNavigations) if (record.proof.tabId === tabId
      && (!scope || sameScope(record.proof.scope, scope))) preparedNavigations.delete(id)
  }
  const retainedObservation = (request: { scope: BrowserReadScope; tabId: string; snapshotId: string;
    elementRef: string }): AgentObservation => {
    const observation = observations.get(request.tabId)
    if (!observation || disposed || unfencedScopes.has(scopeKey(request.scope))
      || observation.snapshotId !== request.snapshotId
      || !sameScope(observation.authority.scope, request.scope)
      || !observation.elements.has(request.elementRef)
      || observation.revocationEpoch !== (revocationEpochs.get(request.tabId) ?? 0)) throw new Error('stale_ref')
    const target = registry.agentTarget(request.tabId)
    if (target.contents !== observation.contents || target.generation !== observation.target.generation
      || target.instanceId !== observation.target.instanceId || target.origin !== observation.target.origin
      || observation.contents.isDestroyed() || observation.contents.isLoadingMainFrame?.()) {
      observations.delete(request.tabId)
      throw new Error('stale_ref')
    }
    validateActionPolicy(observation.authority, observation.target.origin!)
    return observation
  }
  return {
    targetProof,
    isAvailable: (): boolean => !disposed,
    async waitForEffects(scope: BrowserReadScope, signal?: AbortSignal): Promise<boolean> {
      while (true) {
        if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
        if (signal?.aborted) throw new Error('request_expired')
        const observations = [...observedEffects.get(scopeKey(scope)) ?? []].map(record => record.completion)
        const pending = [...activeEffects].filter(([, activeScope]) => sameScope(activeScope, scope))
          .map(([completion]) => completion)
        if (pending.length === 0 && observations.length === 0) return !unfencedScopes.has(scopeKey(scope))
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            effectDrainWaiters.delete(waiter)
            signal?.removeEventListener('abort', abort)
          }
          const abort = (): void => { cleanup(); reject(new Error('request_expired')) }
          const waiter = {
            changed: (): void => { cleanup(); resolve() },
            cancel: (): void => { cleanup(); reject(new Error(BROWSER_ERROR.targetClosed)) },
          }
          effectDrainWaiters.add(waiter)
          signal?.addEventListener('abort', abort, { once: true })
        })
      }
    },
    prepareNavigate(proof: BrowserNavigateProof): void {
      if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
      pruneExpired()
      if (!proof.requestId || !proof.proofId || !Number.isFinite(proof.expiresAt)
        || requestIds.has(proof.requestId)
        || requestIds.size >= MAX_REPLAY_RECORDS || preparedNavigations.size >= MAX_PREPARED
        || proof.expiresAt <= Date.now()) throw new Error('replayed_request')
      const target = targetProof(proof.tabId, true)
      const url = normalizeBrowserInput(proof.url)
      if (!browserResourceAllowed({ url, topOrigin: target.origin ?? '', approvedLocalOrigin: null, apiOrigin: null })) {
        throw new Error(BROWSER_ERROR.permissionDenied)
      }
      if (url.href !== proof.url || url.origin !== proof.destinationOrigin
        || target.instanceId !== proof.source.instanceId || target.generation !== proof.source.generation
        || target.origin !== proof.source.origin || proof.source.origin === null && target.url !== 'about:blank'
        || typeof proof.intent !== 'string' || !proof.intent.trim() || proof.intent.length > MAX_INTENT_LENGTH) {
        throw new Error('stale_target')
      }
      requestIds.set(proof.requestId, proof.expiresAt)
      preparedNavigations.set(proof.requestId, { proof: { ...proof, scope: { ...proof.scope }, source: { ...proof.source } },
        revocationEpoch: revocationEpochs.get(proof.tabId) ?? 0 })
    },
    async executeNavigate(grant: BrowserNavigateGrant): Promise<void> {
      pruneExpired()
      const record = preparedNavigations.get(grant.requestId)
      if (!record) throw new Error('stale_action')
      if (activeNavigations.has(record.proof.tabId)) throw new Error(BROWSER_ERROR.cdpBusy)
      preparedNavigations.delete(grant.requestId)
      if (!grant.id || navigateGrantIds.has(grant.id) || navigateGrantIds.size >= MAX_REPLAY_RECORDS) throw new Error('replayed_approval')
      navigateGrantIds.set(grant.id, grant.expiresAt)
      const { proof } = record
      if (disposed || grant.action !== 'navigate' || grant.expiresAt <= Date.now()
        || grant.expiresAt > proof.expiresAt
        || proof.expiresAt <= Date.now() || grant.proofId !== proof.proofId || grant.tabId !== proof.tabId
        || grant.url !== proof.url || grant.destinationOrigin !== proof.destinationOrigin
        || grant.intent !== proof.intent || grant.policyRevision !== proof.policyRevision
        || grant.policyDecision !== proof.policyDecision || grant.source.instanceId !== proof.source.instanceId
        || grant.source.generation !== proof.source.generation || grant.source.origin !== proof.source.origin
        || !sameScope(grant.scope, proof.scope)
        || record.revocationEpoch !== (revocationEpochs.get(proof.tabId) ?? 0)) throw new Error('stale_action')
      const target = targetProof(proof.tabId, true)
      if (target.instanceId !== proof.source.instanceId || target.generation !== proof.source.generation
        || target.origin !== proof.source.origin) throw new Error('stale_target')
      release(proof.tabId, true)
      const active: ActiveNavigateRecord = { requestId: grant.requestId, scope: { ...proof.scope }, cancelled: false }
      activeNavigations.set(proof.tabId, active)
      try {
        await registry.agentNavigate(proof.tabId, proof.url, proof.destinationOrigin)
        if (disposed || active.cancelled || record.revocationEpoch !== (revocationEpochs.get(proof.tabId) ?? 0)) {
          throw new Error('stale_action')
        }
        const destination = targetProof(proof.tabId)
        if (destination.instanceId === proof.source.instanceId || destination.origin !== proof.destinationOrigin) {
          throw new Error('stale_target')
        }
      } finally {
        if (activeNavigations.get(proof.tabId) === active) activeNavigations.delete(proof.tabId)
      }
    },
    cancelNavigate(requestId: string, tabId: string): void {
      const prepared = preparedNavigations.get(requestId)
      if (prepared?.proof.tabId === tabId) preparedNavigations.delete(requestId)
      const active = activeNavigations.get(tabId)
      if (active?.requestId !== requestId || active.cancelled) return
      active.cancelled = true
      registry.cancelAgentNavigation(tabId)
    },
    prepareInteract(request: AgentReadAuthority & { requestId: string; snapshotId: string; elementRef: string;
      action: 'click' | 'fill'; value?: string; intent: string }): AgentPreparedAction {
      if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
      validateAuthority(request)
      const lease = leases.get(request.tabId)
      if (!lease || lease.observationOnly) throw new Error('stale_ref')
      verify(lease, request)
      const element = lease.snapshotId === request.snapshotId && Date.now() < lease.snapshotExpiresAt
        ? lease.elements.get(request.elementRef) : null
      if (!element) throw new Error('stale_ref')
      if (element.backendNodeId === null) throw new Error('non_interactive_ref')
      if (typeof request.intent !== 'string' || !request.intent.trim() || request.intent.length > MAX_INTENT_LENGTH) throw new Error('invalid_action')
      if (request.action === 'fill' && (typeof request.value !== 'string' || request.value.length > MAX_FILL_LENGTH)
        || request.action === 'click' && request.value !== undefined) throw new Error('invalid_action')
      return reserve(request, request.requestId, request.action,
        { snapshotId: request.snapshotId, elementRef: request.elementRef,
          backendNodeId: element.backendNodeId, value: request.value, intent: request.intent }, element.public)
    },
    prepareSubmit(request: AgentReadAuthority & { requestId: string; snapshotId: string; elementRef: string; intent: string }): AgentPreparedAction {
      if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
      validateAuthority(request)
      const lease = leases.get(request.tabId)
      if (!lease || lease.observationOnly) throw new Error('stale_ref')
      verify(lease, request)
      const element = lease.snapshotId === request.snapshotId && Date.now() < lease.snapshotExpiresAt
        ? lease.elements.get(request.elementRef) : null
      if (!element) throw new Error('stale_ref')
      if (element.backendNodeId === null) throw new Error('non_interactive_ref')
      if (typeof request.intent !== 'string' || !request.intent.trim() || request.intent.length > MAX_INTENT_LENGTH) throw new Error('invalid_action')
      return reserve(request, request.requestId, 'submit',
        { snapshotId: request.snapshotId, elementRef: request.elementRef,
          backendNodeId: element.backendNodeId, intent: request.intent }, element.public)
    },
    prepareAction(request: { scope: BrowserReadScope; requestId: string; tabId: string; snapshotId: string;
      elementRef: string; action: AgentPreparedAction['action']; intent: string; value?: string }): AgentPreparedAction {
      if (unfencedScopes.has(scopeKey(request.scope))) throw new Error('stale_ref')
      const lease = leases.get(request.tabId)
      if (!lease || lease.observationOnly || Date.now() >= lease.snapshotExpiresAt || Date.now() >= lease.expiresAt) {
        retainedObservation(request)
        throw new Error(OBSERVATION_READ_REQUIRED)
      }
      if (!lease || !sameScope(lease.authority.scope, request.scope)) throw new Error('stale_ref')
      const authority = lease.authority
      validateActionPolicy(authority, lease.origin)
      if (request.action === 'submit') {
        if (request.value !== undefined) throw new Error('invalid_action')
        return this.prepareSubmit({ ...authority, requestId: request.requestId, snapshotId: request.snapshotId,
          elementRef: request.elementRef, intent: request.intent })
      }
      return this.prepareInteract({ ...authority, requestId: request.requestId, snapshotId: request.snapshotId,
        elementRef: request.elementRef, action: request.action, intent: request.intent, value: request.value })
    },
    async prepareObservedAction(request: AgentReadAuthority & { requestId: string; snapshotId: string;
      elementRef: string; action: AgentPreparedAction['action']; intent: string; value?: string;
      signal?: AbortSignal }): Promise<AgentPreparedAction> {
      if (request.signal?.aborted) throw new Error('request_expired')
      validateAuthority(request)
      const observation = retainedObservation(request)
      if (request.grantId === observation.authority.grantId
        || request.grantRequestId === observation.authority.grantRequestId
        || request.grantRevision !== observation.authority.grantRevision) throw new Error('stale_grant')
      if (typeof request.intent !== 'string' || !request.intent.trim() || request.intent.length > MAX_INTENT_LENGTH
        || request.action === 'fill' && (typeof request.value !== 'string' || request.value.length > MAX_FILL_LENGTH)
        || request.action !== 'fill' && request.value !== undefined) throw new Error('invalid_action')
      const original = observation.elements.get(request.elementRef)!
      if (original.element.backendNodeId === null) throw new Error('non_interactive_ref')
      const lease = acquire(request, true)
      const deadline = Date.now() + SNAPSHOT_MS
      const descriptions = new Map<number, Promise<unknown>>()
      const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (request.signal?.aborted) throw new Error('request_expired')
        if (Date.now() >= deadline) throw new Error('snapshot_timeout')
        if (retainedObservation(request) !== observation) throw new Error('stale_ref')
        const result = await command(lease, request, method, params)
        if (request.signal?.aborted) throw new Error('request_expired')
        if (Date.now() >= deadline) throw new Error('snapshot_timeout')
        if (retainedObservation(request) !== observation) throw new Error('stale_ref')
        return result
      }
      const describe = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const nodeId = params.backendNodeId as number
        let pending = descriptions.get(nodeId)
        if (!pending) { pending = send(method, params); descriptions.set(nodeId, pending) }
        return pending
      }
      try {
        const frame = await send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
        if (frame.frameTree?.frame?.id !== observation.topFrameId) throw new Error('stale_ref')
        const nodes = await completeAxTree(send, observation.topFrameId)
        const matches = visibleElements(nodes, observation.topFrameId)
          .filter(element => element.backendNodeId === original.element.backendNodeId)
        const current = matches[0]
        if (matches.length !== 1 || current.nodeId !== original.element.nodeId
          || current.public.role !== original.element.public.role || current.public.name !== original.element.public.name) {
          console.info('[browser-agent] observation changed', JSON.stringify({ matchingNodes: matches.length,
            nodeIdentity: current?.nodeId === original.element.nodeId,
            role: current?.public.role === original.element.public.role,
            name: current?.public.name === original.element.public.name }))
          throw new Error('stale_ref')
        }
        if (!await safeElement(describe, current, observation.topFrameId)) throw new Error('stale_ref')
        const nodeIds = new Set([current.backendNodeId, ...current.relatedNodeIds, ...current.domNodeIds])
        if (nodeIds.size !== original.fingerprints.size) throw new Error('stale_ref')
        for (const [nodeId, fingerprint] of original.fingerprints) {
          const description = await describe('DOM.describeNode', { backendNodeId: nodeId }) as { node?: ObservationNode }
          const currentFingerprint = description.node && observationFingerprint(description.node)
          if (!nodeIds.has(nodeId) || !description.node
            || currentFingerprint!.digest !== fingerprint.digest) {
            console.info('[browser-agent] observation attributes changed', JSON.stringify({
              targetNode: nodeId === current.backendNodeId, ancestryMember: nodeIds.has(nodeId),
              described: !!description.node, nodeKind: currentFingerprint?.nodeKind,
              identityChanged: currentFingerprint?.identity !== fingerprint.identity,
              attributeOrderOnly: currentFingerprint?.unorderedDigest === fingerprint.unorderedDigest,
              changedAttributes: [...new Set([...fingerprint.attributes.keys(), ...currentFingerprint?.attributes.keys() ?? []])]
                .filter(category => fingerprint.attributes.get(category) !== currentFingerprint?.attributes.get(category)).sort() }))
            throw new Error('stale_ref')
          }
        }
        verify(lease, request)
        if (request.signal?.aborted) throw new Error('request_expired')
        retainedObservation(request)
        lease.observationOnly = true
        lease.snapshotId = request.snapshotId
        lease.snapshotExpiresAt = Math.min(lease.expiresAt, Date.now() + SNAPSHOT_MS)
        lease.topFrameId = observation.topFrameId
        lease.elements.set(request.elementRef, { ...current, public: { ...original.element.public } })
        return reserve(request, request.requestId, request.action, { snapshotId: request.snapshotId,
          elementRef: request.elementRef, backendNodeId: current.backendNodeId!, value: request.value,
          intent: request.intent }, original.element.public)
      } catch (error) {
        if (leases.get(request.tabId) === lease) observations.delete(request.tabId)
        release(request.tabId, true, lease)
        throw error
      }
    },
    actionProof(requestId: string, proofId: string): AgentPreparedAction {
      pruneExpired()
      const record = [...prepared.values()].find(candidate => candidate.result.requestId === requestId
        && candidate.result.proofId === proofId)
      if (!record || disposed) throw new Error('stale_action')
      validateAuthority(record.authority)
      validateActionPolicy(record.authority, record.result.target.origin!)
      if (!sameProof(record.result.target, targetProof(record.result.tabId))) throw new Error('stale_target')
      return record.result
    },
    approveAction(requestId: string, proofId: string): void {
      const proof = this.actionProof(requestId, proofId)
      if (approvedActions.has(requestId)) throw new Error('replayed_approval')
      approvedActions.set(requestId, { proofId: proof.proofId, approvalId: randomUUID() })
      actionApprovalWaiters.get(proof.id)?.resolve()
      actionApprovalWaiters.delete(proof.id)
    },
    extendActionLease(requestId: string, proofId: string): void {
      const proof = this.actionProof(requestId, proofId)
      const lease = leases.get(proof.tabId)
      if (!lease || lease.snapshotId !== proof.snapshotId || lease.snapshotExpiresAt <= Date.now()
        || lease.expiresAt <= Date.now()) throw new Error('stale_ref')
      lease.expiresAt = proof.expiresAt
      lease.snapshotExpiresAt = proof.expiresAt
      clearTimeout(lease.timer)
      lease.timer = setTimeout(() => release(proof.tabId, true, lease), Math.max(0, proof.expiresAt - Date.now()))
    },
    async executeApprovedAction(request: { scope: BrowserReadScope; requestId: string; proofId: string; tabId: string }): Promise<void> {
      const pending = this.actionProof(request.requestId, request.proofId)
      if (!sameScope(pending.scope, request.scope) || pending.tabId !== request.tabId) throw new Error('stale_action')
      if (!approvedActions.has(request.requestId)) {
        if (actionApprovalWaiters.has(pending.id)) throw new Error('replayed_request')
        await new Promise<void>((resolve, reject) => { actionApprovalWaiters.set(pending.id, { resolve, reject }) })
      }
      const approval = approvedActions.get(request.requestId)
      if (!approval || approval.proofId !== request.proofId) throw new Error('approval_required')
      approvedActions.delete(request.requestId)
      const proof = this.actionProof(request.requestId, request.proofId)
      if (!sameScope(proof.scope, request.scope) || proof.tabId !== request.tabId) throw new Error('stale_action')
      await this.execute({ preparedId: proof.id, proofId: proof.proofId, approvalId: approval.approvalId,
        requestId: proof.requestId, scope: proof.scope, tabId: proof.tabId, target: proof.target,
        snapshotId: proof.snapshotId, elementRef: proof.elementRef, backendNodeId: proof.backendNodeId,
        grantId: proof.grantId, grantRequestId: proof.grantRequestId, grantRevision: proof.grantRevision,
        revocationEpoch: proof.revocationEpoch, action: proof.action, expiresAt: proof.expiresAt,
        intent: proof.intent })
    },
    cancelAction(requestId: string, tabId: string): void {
      if ([...prepared.values()].some(record => record.result.requestId === requestId && record.result.tabId === tabId)) {
        approvedActions.delete(requestId)
      }
      for (const [id, record] of prepared) if (record.result.requestId === requestId && record.result.tabId === tabId) deletePrepared(id)
    },
    async execute(evidence: AgentApprovalEvidence): Promise<void> {
      pruneExpired()
      const record = prepared.get(evidence.preparedId)
      if (!record) throw new Error('stale_action')
      deletePrepared(evidence.preparedId)
      if (!evidence.approvalId || approvalIds.has(evidence.approvalId) || approvalIds.size >= MAX_REPLAY_RECORDS) throw new Error('replayed_approval')
      approvalIds.set(evidence.approvalId, Date.now() + APPROVAL_TTL_MS)
      const { authority, result } = record
      validateActionPolicy(authority, result.target.origin!)
      if (disposed || record.expiresAt <= Date.now() || evidence.expiresAt <= Date.now()
        || evidence.expiresAt > result.expiresAt || evidence.requestId !== result.requestId
        || evidence.proofId !== result.proofId || !evidence.scope || !sameScope(evidence.scope, result.scope)
        || evidence.tabId !== result.tabId || !evidence.target || !sameProof(evidence.target, result.target)
        || evidence.snapshotId !== result.snapshotId || evidence.elementRef !== result.elementRef
        || evidence.backendNodeId !== result.backendNodeId
        || evidence.grantId !== authority.grantId || evidence.grantRequestId !== authority.grantRequestId
        || evidence.grantRevision !== authority.grantRevision || evidence.action !== result.action
        || evidence.revocationEpoch !== result.revocationEpoch || evidence.intent !== result.intent
        || record.revocationEpoch !== (revocationEpochs.get(authority.tabId) ?? 0)) throw new Error('stale_action')
      validateAuthority(authority)
      if (!sameProof(result.target, targetProof(authority.tabId))) throw new Error('stale_target')
      const lease = leases.get(authority.tabId)
      if (!lease || lease.snapshotId !== record.snapshotId || Date.now() >= lease.snapshotExpiresAt || !record.elementRef
        || lease.elements.get(record.elementRef)?.backendNodeId !== record.backendNodeId) throw new Error('stale_ref')
      verify(lease, authority)
      let effectIssued = false
      const effectState: { observation: EffectObservation | null; record: EffectRecord | null; releasePopupBlock: (() => void) | null } = {
        observation: null, record: null, releasePopupBlock: null
      }
      let failure: unknown = null
      let effectMethod: string | null = null
      const actionStarted = performance.now()
      const timings = { verificationCount: 0, verificationMs: 0, effectCount: 0, effectMs: 0, drainMs: 0 }
      try {
        const backendNodeId = record.backendNodeId!
        const described = await command(lease, authority, 'DOM.describeNode', { backendNodeId }) as {
          node: { nodeName?: string; attributes?: string[]; frameId?: string }
        }
        verify(lease, authority)
        if (!described.node || described.node.frameId && described.node.frameId !== lease.topFrameId) throw new Error('cross_frame_denied')
        const nodeName = described.node.nodeName?.toUpperCase()
        const attributes = described.node.attributes ?? []
        const verifyAction = async (): Promise<void> => {
          const started = performance.now()
          timings.verificationCount += 1
          try {
            validateAuthority(authority)
            validateActionPolicy(authority, result.target.origin!)
            verify(lease, authority)
            if (Date.now() >= result.expiresAt || Date.now() >= evidence.expiresAt
              || Date.now() >= lease.snapshotExpiresAt
              || record.revocationEpoch !== (revocationEpochs.get(authority.tabId) ?? 0)
              || lease.snapshotId !== result.snapshotId
              || lease.elements.get(result.elementRef)?.backendNodeId !== backendNodeId
              || !sameProof(result.target, targetProof(authority.tabId))) throw new Error('stale_action')
            const current = await command(lease, authority, 'DOM.describeNode', { backendNodeId }) as typeof described
            if (!current.node || current.node.nodeName?.toUpperCase() !== nodeName
              || current.node.frameId && current.node.frameId !== lease.topFrameId
              || JSON.stringify(actionAttributes(current.node.attributes ?? [])) !== JSON.stringify(actionAttributes(attributes))) throw new Error('stale_ref')
            const currentElement = lease.elements.get(result.elementRef)
            if (!currentElement || !lease.topFrameId
              || !await safeElement((method, params) => command(lease, authority, method, params),
                currentElement, lease.topFrameId)) throw new Error('stale_ref')
            const currentTree = await completeAxTree((method, params) => command(lease, authority, method, params), lease.topFrameId)
            const currentAxElement = visibleElements(currentTree, lease.topFrameId)
              .find(candidate => candidate.nodeId === currentElement.nodeId)
            if (!currentAxElement || currentAxElement.public.role !== currentElement.public.role
              || currentAxElement.public.name !== currentElement.public.name
              || currentAxElement.backendNodeId !== backendNodeId) throw new Error('stale_ref')
            verify(lease, authority)
          } finally { timings.verificationMs += performance.now() - started }
        }
        const sendEffect = async (method: string, params: Record<string, unknown>): Promise<void> => {
          effectMethod = method
          await verifyAction()
          if (!effectState.observation) {
            effectState.releasePopupBlock = registry.blockAgentPopups(authority.tabId)
            effectState.observation = await observeEffects(lease, authority)
            lease.observingEffects = true
            await verifyAction()
          }
          if (!effectState.record) effectState.record = reserveEffect(authority.scope)
          effectIssued = true
          const started = performance.now()
          timings.effectCount += 1
          try { await effect(lease, authority, method, params) }
          finally {
            timings.effectMs += performance.now() - started
            effectState.observation.markEffectSettled()
          }
        }
        const typeIndex = attributes.findIndex((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === 'type')
        const inputType = typeIndex >= 0 ? attributes[typeIndex + 1]?.toLowerCase() : undefined
        if (result.action === 'fill') {
          if (nodeName !== 'TEXTAREA' && (nodeName !== 'INPUT' || !EDITABLE_INPUT_TYPES.has(inputType ?? 'text'))) throw new Error('non_interactive_ref')
          await sendEffect('DOM.focus', { backendNodeId })
          await sendEffect('Input.dispatchKeyEvent',
            { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: CDP_CONTROL_MODIFIER,
              commands: [CDP_SELECT_ALL_COMMAND] })
          await sendEffect('Input.dispatchKeyEvent',
            { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: CDP_CONTROL_MODIFIER })
          await sendEffect('Input.insertText', { text: record.value })
        } else {
          if (result.action === 'click' && (nodeName === 'BUTTON' && inputType !== 'button'
            || nodeName === 'INPUT' && (inputType === 'submit' || inputType === 'image' || inputType === 'reset'))) {
            throw new Error(SUBMIT_APPROVAL_REQUIRED)
          }
          await sendEffect('DOM.scrollIntoViewIfNeeded', { backendNodeId })
          const box = await command(lease, authority, 'DOM.getBoxModel', { backendNodeId }) as { model: { content: number[] } }
          verify(lease, authority)
          const quad = box.model?.content
          if (!Array.isArray(quad) || quad.length !== 8 || quad.some(value => !Number.isFinite(value))) throw new Error('non_interactive_ref')
          const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4)
          const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4)
          const hit = await command(lease, authority, 'DOM.getNodeForLocation', { x, y }) as { backendNodeId?: number; frameId?: string }
          verify(lease, authority)
          if (hit.backendNodeId !== backendNodeId || hit.frameId && hit.frameId !== lease.topFrameId) throw new Error('non_interactive_ref')
          await sendEffect('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
          await sendEffect('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await sendEffect('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        }
        verify(lease, authority)
        validateAuthority(authority)
      } catch (error) {
        console.info('[browser-agent] action failed', JSON.stringify({ action: result.action,
          method: effectMethod, effectIssued, code: agentFailureCode(error) }))
        failure = effectIssued ? new Error('action_outcome_unknown') : error
      } finally {
        try {
          if (effectState.observation) {
            const started = performance.now()
            const settled = effectIssued && await effectState.observation.wait()
            timings.drainMs = performance.now() - started
            effectState.observation.close()
            effectState.record?.finish(Boolean(settled))
            if (effectIssued && !settled) failure = new Error('action_outcome_unknown')
          }
        } finally {
          lease.observingEffects = false
          effectState.releasePopupBlock?.()
          release(authority.tabId, true, lease)
          console.info('[browser-agent] action timing', JSON.stringify({ requestId: result.requestId,
            action: result.action, ...timings, totalMs: performance.now() - actionStarted }))
        }
      }
      if (failure) throw failure
    },
    async snapshot(authority: AgentReadAuthority): Promise<AgentReadSnapshot> {
      const lease = acquire(authority)
      const started = performance.now()
      const timings = { commands: 0, commandWorkMs: 0, axCommands: 0 }
      try {
        const send = async (method: string, params?: Record<string, unknown>) => {
          const commandStarted = performance.now()
          timings.commands += 1
          if (method.startsWith('Accessibility.')) timings.axCommands += 1
          try { return await command(lease, authority, method, params) }
          finally { timings.commandWorkMs += performance.now() - commandStarted }
        }
        await send('DOM.enable')
        verify(lease, authority)
        await send('DOM.getDocument', { depth: 1 })
        verify(lease, authority)
        const frameTree = await send('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
        verify(lease, authority)
        if (typeof frameTree?.frameTree?.frame?.id !== 'string' || !frameTree.frameTree.frame.id) throw new Error('snapshot_unavailable')
        const nodes = await completeAxTree(send, frameTree.frameTree.frame.id)
        verify(lease, authority)
        const candidates = visibleElements(nodes, frameTree.frameTree.frame.id)
        if (new Set(candidates.flatMap(candidate => candidate.domNodeIds)).size > MAX_SNAPSHOT_DOM_NODES) {
          throw new Error('snapshot_too_large')
        }
        const elements: AgentElement[] = []
        const descriptions = new Map<number, Promise<unknown>>()
        const inspect = (method: string, params: Record<string, unknown>): Promise<unknown> => {
          const backendNodeId = params.backendNodeId as number
          let pending = descriptions.get(backendNodeId)
          if (!pending) {
            pending = send(method, params)
            descriptions.set(backendNodeId, pending)
          }
          return pending
        }
        for (let index = 0; index < candidates.length; index += AX_INSPECTION_CONCURRENCY) {
          const batch = candidates.slice(index, index + AX_INSPECTION_CONCURRENCY)
          const allowed = await Promise.all(batch.map(candidate => safeElement(inspect, candidate, frameTree.frameTree.frame.id)))
          verify(lease, authority)
          for (let offset = 0; offset < batch.length; offset += 1) if (allowed[offset]) elements.push(batch[offset])
        }
        const publicSnapshot: AgentReadSnapshot = { snapshotId: randomUUID(), origin: lease.origin,
          title: lease.contents.getTitle().slice(0, MAX_TITLE_LENGTH), elements: elements.map(element => element.public) }
        console.info('[browser-agent] snapshot inspection', JSON.stringify({ nodes: nodes.length, candidates: candidates.length, allowed: elements.length }))
        verify(lease, authority)
        if (Buffer.byteLength(JSON.stringify(publicSnapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('snapshot_too_large')
        lease.snapshotId = publicSnapshot.snapshotId
        lease.snapshotExpiresAt = Math.min(lease.expiresAt, Date.now() + SNAPSHOT_MS)
        lease.topFrameId = frameTree.frameTree.frame.id
        lease.elements = new Map(elements.map(element => [element.public.ref, element]))
        if (!observations.has(authority.tabId) && observations.size >= MAX_LEASES) throw new Error('snapshot_too_large')
        const retained = new Map<string, { element: AgentElement; fingerprints: Map<number, ObservationFingerprint> }>()
        const fingerprintsByNode = new Map<number, ObservationFingerprint>()
        for (const element of elements) {
          const fingerprints = new Map<number, ObservationFingerprint>()
          for (const nodeId of new Set([element.backendNodeId, ...element.relatedNodeIds, ...element.domNodeIds])) {
            if (nodeId === null) continue
            const description = await descriptions.get(nodeId) as { node?: ObservationNode } | undefined
            if (!description?.node) throw new Error('stale_ref')
            let fingerprint = fingerprintsByNode.get(nodeId)
            if (!fingerprint) {
              fingerprint = observationFingerprint(description.node)
              fingerprintsByNode.set(nodeId, fingerprint)
            }
            fingerprints.set(nodeId, fingerprint)
          }
          retained.set(element.public.ref, { element, fingerprints })
        }
        verify(lease, authority)
        observations.set(authority.tabId, { authority: copyAuthority(authority), target: targetProof(authority.tabId),
          contents: lease.contents, snapshotId: publicSnapshot.snapshotId, topFrameId: lease.topFrameId,
          revocationEpoch: revocationEpochs.get(authority.tabId) ?? 0, elements: retained })
        return publicSnapshot
      } catch (error) {
        console.info('[browser-agent] snapshot failed', snapshotError(error).message)
        if (leases.get(authority.tabId) === lease) observations.delete(authority.tabId)
        release(authority.tabId, true, lease)
        throw snapshotError(error)
      } finally {
        console.info('[browser-agent] snapshot timing', JSON.stringify({ requestId: authority.grantRequestId,
          ...timings, totalMs: performance.now() - started }))
      }
    },
    async read(request: AgentReadAuthority & { snapshotId: string; elementRef: string }): Promise<AgentReadElement> {
      const lease = leases.get(request.tabId)
      if (!lease || lease.observationOnly) throw new Error('stale_ref')
      try {
        verify(lease, request)
        if (lease.snapshotId !== request.snapshotId || Date.now() >= lease.snapshotExpiresAt || !lease.topFrameId) throw new Error('stale_ref')
        const element = lease.elements.get(request.elementRef)
        if (!element) throw new Error('stale_ref')
        const send = (method: string, params?: Record<string, unknown>) => command(lease, request, method, params)
        const nodes = await completeAxTree(send, lease.topFrameId)
        verify(lease, request)
        const current = visibleElements(nodes, lease.topFrameId).find(candidate => candidate.nodeId === element.nodeId)
        if (!current || current.public.role !== element.public.role || current.public.name !== element.public.name
          || current.backendNodeId !== element.backendNodeId
          || !await safeElement(send, current, lease.topFrameId)) throw new Error('stale_ref')
        verify(lease, request)
        if (Date.now() >= lease.snapshotExpiresAt) throw new Error('stale_ref')
        return element.public
      } catch (error) { throw snapshotError(error) }
    },
    revoke(tabId: string, scope?: BrowserReadScope): void {
      const observation = observations.get(tabId)
      if (observation && (!scope || sameScope(observation.authority.scope, scope))) observations.delete(tabId)
      if (!scope) revocationEpochs.set(tabId, (revocationEpochs.get(tabId) ?? 0) + 1)
      clearTargetRecords(tabId, scope)
      const active = activeNavigations.get(tabId)
      if (!scope || active && sameScope(active.scope, scope) && !active.cancelled) {
        if (active) active.cancelled = true
        registry.cancelAgentNavigation(tabId)
      }
      const lease = leases.get(tabId)
      if (lease && (!scope || sameScope(lease.authority.scope, scope))) release(tabId, true, lease)
    },
    invalidateTarget(tabId: string): void {
      observations.delete(tabId)
      clearTargetRecords(tabId)
      const lease = leases.get(tabId)
      if (!lease) return
      lease.targetInvalidated = true
      lease.snapshotId = null
      lease.elements.clear()
      if (!lease.observingEffects) release(tabId, true, lease)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      observations.clear()
      for (const waiter of effectDrainWaiters) waiter.cancel()
      unsubscribe()
      for (const [tabId, active] of activeNavigations) {
        active.cancelled = true
        registry.cancelAgentNavigation(tabId)
      }
      for (const id of prepared.keys()) deletePrepared(id)
      approvedActions.clear()
      for (const waiter of actionApprovalWaiters.values()) waiter.reject(new Error('stale_action'))
      actionApprovalWaiters.clear()
      preparedNavigations.clear()
      activeNavigations.clear()
      revocationEpochs.clear()
      for (const tabId of [...leases.keys()]) release(tabId, true)
    }
  }
}
