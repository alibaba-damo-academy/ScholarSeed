import { randomUUID } from 'node:crypto'

const READ_GRANT_LIFETIME_MS = 30_000
const READ_PROOF_LIFETIME_MS = 60_000
const MAX_READ_GRANTS = 64
const MAX_READ_PROOFS = 64
const MAX_NAVIGATE_GRANTS = 64
const MAX_NAVIGATE_PROOFS = 64
const MAX_NAVIGATE_URL_LENGTH = 8_192
const MAX_SCOPE_REQUESTS = 4_096
const MAX_ACTIVE_READ_LEASES = 4
const MAX_APPROVAL_WAITERS = 16
const APPROVAL_MINT_WAIT_MS = 5_000
const SNAPSHOT_READ_LIFETIME_MS = 10_000
const STALE_GRANT = 'stale_grant'
const STALE_REF = 'stale_ref'
const SEARCH_AUTHORIZATION_REQUIRED = 'browser_search_authorization_required'

export interface BrowserReadScope {
  sessionId: string
  instanceId: string
  productTurnId: string
  turnId: string
  generation: number
  interruptGeneration: number
  lifecycleEpoch: number
}

export interface BrowserReadTarget {
  instanceId: string
  generation: number
  origin: string
}

export interface BrowserReadRequest {
  sessionId: string
  turnId: string
  requestId: string
  proofId: string
  tabId: string
  origin: string
  targetInstanceId: string
  targetGeneration: number
  intent: string
  expiresAt: number
}

export interface BrowserReadProof {
  proofId: string
  requestId: string
  scope: BrowserReadScope
  tabId: string
  target: BrowserReadTarget
  intent: string
  expiresAt: number
  policyRevision: number
  policyDecision: 'ask' | 'allow'
}

export interface BrowserReadGrant {
  id: string
  proofId: string
  scope: BrowserReadScope
  requestId: string
  tabId: string
  target: BrowserReadTarget
  action: 'read'
  intent: string
  expiresAt: number
  policyRevision: number
  policyDecision: 'ask' | 'allow'
}

export interface BrowserReadAuthority {
  scope: BrowserReadScope
  tabId: string
  grantId: string
  grantRequestId: string
  grantRevision: number
}

export interface BrowserNavigateSource {
  instanceId: string
  generation: number
  origin: string | null
}

export interface BrowserNavigateProof {
  proofId: string
  requestId: string
  scope: BrowserReadScope
  tabId: string
  source: BrowserNavigateSource
  url: string
  destinationOrigin: string
  intent: string
  expiresAt: number
  policyRevision: number
  policyDecision: 'ask' | 'allow'
}

export interface BrowserNavigateRequest {
  sessionId: string
  turnId: string
  requestId: string
  proofId: string
  tabId: string
  sourceInstanceId: string
  sourceGeneration: number
  sourceOrigin: string | null
  url: string
  destinationOrigin: string
  intent: string
  expiresAt: number
}

export interface BrowserNavigateGrant extends BrowserNavigateProof {
  id: string
  action: 'navigate'
}

export interface BrowserSearchGrant {
  id: string
  requestId: string
  scope: BrowserReadScope
  tabId: string
  target: BrowserReadTarget
  url: string
  query: string
  parameter: string
  expiresAt: number
  readRevision: number
  interactRevision: number
}

interface BrowserReadLease {
  authority: BrowserReadAuthority
  grant: BrowserReadGrant
  snapshotId: string | null
  actionSnapshotId: string | null
  expiresAt: number
}

interface ApprovalWaiter {
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface Owners {
  scope(sessionId: string, turnId: string): BrowserReadScope | null
  target(tabId: string): BrowserReadTarget | null
  policy(origin: string): { revision: number; decision: 'ask' | 'allow' | 'block' }
  navigateTarget?(tabId: string): BrowserNavigateSource | null
  navigatePolicy?(origin: string): { revision: number; decision: 'ask' | 'allow' | 'block' }
}

function sameScope(left: BrowserReadScope, right: BrowserReadScope): boolean {
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

function sameTarget(left: BrowserReadTarget, right: BrowserReadTarget): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.generation === right.generation &&
    left.origin === right.origin
  )
}

function sameNavigateSource(left: BrowserNavigateSource, right: BrowserNavigateSource): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.generation === right.generation &&
    left.origin === right.origin
  )
}

function canonicalDestination(value: string): { url: string; origin: string } {
  try {
    if (!value || value.length > MAX_NAVIGATE_URL_LENGTH) throw new Error(STALE_GRANT)
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.origin === 'null'
    )
      throw new Error(STALE_GRANT)
    return { url: parsed.href, origin: parsed.origin }
  } catch {
    throw new Error(STALE_GRANT)
  }
}

function copyNavigateProof(proof: BrowserNavigateProof): BrowserNavigateProof {
  return { ...proof, scope: { ...proof.scope }, source: { ...proof.source } }
}

function copyNavigateGrant(grant: BrowserNavigateGrant): BrowserNavigateGrant {
  return { ...grant, scope: { ...grant.scope }, source: { ...grant.source } }
}

export function createBrowserReadGrants(owners: Owners) {
  let currentOwners = owners
  const grants = new Map<string, BrowserReadGrant>()
  const proofs = new Map<string, BrowserReadProof>()
  const navigateGrants = new Map<string, BrowserNavigateGrant>()
  const navigateProofs = new Map<string, BrowserNavigateProof>()
  const searchGrants = new Map<
    string,
    { grant: BrowserSearchGrant; claimed: boolean; generation: number }
  >()
  const requests = new Map<
    string,
    {
      scope: BrowserReadScope
      tabId: string
      cancelled: boolean
      action: 'read' | 'navigate' | 'search'
    }
  >()
  const leases = new Map<string, BrowserReadLease>()
  const snapshots = new Map<string, string>()
  const approvalWaiters = new Map<string, ApprovalWaiter>()
  const clearLease = (id: string): void => {
    const lease = leases.get(id)
    if (lease?.snapshotId) snapshots.delete(lease.snapshotId)
    leases.delete(id)
  }
  const rejectWaiter = (requestId: string): void => {
    const waiter = approvalWaiters.get(requestId)
    if (!waiter) return
    approvalWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.reject(new Error(STALE_GRANT))
  }
  const notifyWaiter = (requestId: string): void => {
    const waiter = approvalWaiters.get(requestId)
    if (!waiter) return
    approvalWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
  const validLease = (lease: BrowserReadLease): boolean => {
    const scope = currentOwners.scope(lease.grant.scope.sessionId, lease.grant.scope.turnId)
    const target = currentOwners.target(lease.grant.tabId)
    const policy = currentOwners.policy(lease.grant.target.origin)
    const expired = Date.now() >= lease.expiresAt
    const scopeCurrent = !!scope && sameScope(scope, lease.grant.scope)
    const targetCurrent = !!target && sameTarget(target, lease.grant.target)
    const policyCurrent =
      policy.revision === lease.grant.policyRevision &&
      policy.decision === lease.grant.policyDecision
    const valid = !expired && scopeCurrent && targetCurrent && policyCurrent
    if (!valid)
      console.info(
        '[browser-grant] lease invalidated',
        JSON.stringify({ expired, scopeCurrent, targetCurrent, policyCurrent })
      )
    return valid
  }
  const validSearch = (candidate: BrowserSearchGrant): boolean => {
    const record = searchGrants.get(candidate.id)
    if (!record) return false
    const { grant, generation } = record
    if (
      candidate.requestId !== grant.requestId ||
      candidate.tabId !== grant.tabId ||
      candidate.url !== grant.url ||
      candidate.query !== grant.query ||
      candidate.parameter !== grant.parameter ||
      candidate.expiresAt !== grant.expiresAt ||
      candidate.readRevision !== grant.readRevision ||
      candidate.interactRevision !== grant.interactRevision ||
      !sameScope(candidate.scope, grant.scope) ||
      !sameTarget(candidate.target, grant.target)
    )
      return false
    const scope = currentOwners.scope(grant.scope.sessionId, grant.scope.turnId)
    const target = currentOwners.target(grant.tabId)
    const read = currentOwners.policy(grant.target.origin)
    const interact = currentOwners.navigatePolicy?.(grant.target.origin)
    const valid =
      grant.expiresAt > Date.now() &&
      !!scope &&
      sameScope(scope, grant.scope) &&
      !!target &&
      target.instanceId === grant.target.instanceId &&
      target.origin === grant.target.origin &&
      target.generation === generation &&
      read.decision === 'allow' &&
      read.revision === grant.readRevision &&
      interact?.decision === 'allow' &&
      interact.revision === grant.interactRevision
    if (!valid) searchGrants.delete(grant.id)
    return valid
  }
  const prune = (): void => {
    for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id)
    for (const [id, proof] of proofs) if (proof.expiresAt <= Date.now()) proofs.delete(id)
    for (const [id, grant] of navigateGrants)
      if (grant.expiresAt <= Date.now()) navigateGrants.delete(id)
    for (const [id, proof] of navigateProofs)
      if (proof.expiresAt <= Date.now()) navigateProofs.delete(id)
    for (const [id, lease] of leases) if (!validLease(lease)) clearLease(id)
    for (const { grant } of searchGrants.values()) validSearch(grant)
  }
  const issue = (
    request: BrowserReadRequest,
    source: 'approved' | 'persistent'
  ): BrowserReadGrant => {
    prune()
    const now = Date.now()
    if (
      !request.requestId ||
      !request.proofId ||
      !request.intent.trim() ||
      !request.tabId ||
      !request.origin ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= now
    )
      throw new Error(STALE_GRANT)
    const proof = proofs.get(request.requestId)
    if (
      !proof ||
      proof.proofId !== request.proofId ||
      proof.expiresAt !== request.expiresAt ||
      proof.tabId !== request.tabId ||
      proof.target.origin !== request.origin ||
      proof.target.instanceId !== request.targetInstanceId ||
      proof.target.generation !== request.targetGeneration ||
      proof.intent !== request.intent
    )
      throw new Error(requests.has(request.requestId) ? 'replayed_request' : STALE_GRANT)
    const scope = currentOwners.scope(request.sessionId, request.turnId)
    const target = currentOwners.target(request.tabId)
    if (
      !scope ||
      scope.sessionId !== request.sessionId ||
      scope.turnId !== request.turnId ||
      !sameScope(scope, proof.scope) ||
      !target ||
      target.origin !== request.origin ||
      target.instanceId !== request.targetInstanceId ||
      target.generation !== request.targetGeneration
    )
      throw new Error(STALE_GRANT)
    const policy = currentOwners.policy(target.origin)
    if (
      policy.revision !== proof.policyRevision ||
      policy.decision !== proof.policyDecision ||
      (source === 'persistent' && policy.decision !== 'allow')
    )
      throw new Error(STALE_GRANT)
    if (grants.size >= MAX_READ_GRANTS) throw new Error('grant_capacity_exhausted')
    const grant: BrowserReadGrant = {
      id: randomUUID(),
      proofId: request.proofId,
      scope: { ...scope },
      requestId: request.requestId,
      tabId: request.tabId,
      target: { ...target },
      action: 'read',
      intent: request.intent,
      expiresAt: Math.min(request.expiresAt, now + READ_GRANT_LIFETIME_MS),
      policyRevision: policy.revision,
      policyDecision: policy.decision,
    }
    proofs.delete(request.requestId)
    grants.set(grant.id, grant)
    notifyWaiter(request.requestId)
    return grant
  }
  const consume = (id: string): BrowserReadGrant => {
    prune()
    const grant = grants.get(id)
    if (!grant) throw new Error(STALE_GRANT)
    grants.delete(id)
    const scope = currentOwners.scope(grant.scope.sessionId, grant.scope.turnId)
    const target = currentOwners.target(grant.tabId)
    const policy = currentOwners.policy(grant.target.origin)
    if (
      !scope ||
      !sameScope(scope, grant.scope) ||
      !target ||
      !sameTarget(target, grant.target) ||
      policy.revision !== grant.policyRevision ||
      policy.decision !== grant.policyDecision ||
      grant.expiresAt <= Date.now()
    )
      throw new Error(STALE_GRANT)
    return grant
  }
  const navigateSource = (tabId: string): BrowserNavigateSource | null =>
    currentOwners.navigateTarget ? currentOwners.navigateTarget(tabId) : currentOwners.target(tabId)
  const validNavigateProof = (proof: BrowserNavigateProof): boolean => {
    const scope = currentOwners.scope(proof.scope.sessionId, proof.scope.turnId)
    const source = navigateSource(proof.tabId)
    const policy = currentOwners.navigatePolicy?.(proof.destinationOrigin)
    return (
      proof.expiresAt > Date.now() &&
      !!scope &&
      sameScope(scope, proof.scope) &&
      !!source &&
      sameNavigateSource(source, proof.source) &&
      !!policy &&
      policy.revision === proof.policyRevision &&
      policy.decision === proof.policyDecision
    )
  }
  const issueNavigate = (
    request: BrowserNavigateRequest,
    mode: 'approved' | 'persistent'
  ): BrowserNavigateGrant => {
    prune()
    const proof = navigateProofs.get(request.requestId)
    if (
      !proof ||
      proof.proofId !== request.proofId ||
      proof.expiresAt !== request.expiresAt ||
      proof.tabId !== request.tabId ||
      proof.source.instanceId !== request.sourceInstanceId ||
      proof.source.generation !== request.sourceGeneration ||
      proof.source.origin !== request.sourceOrigin ||
      proof.url !== request.url ||
      proof.destinationOrigin !== request.destinationOrigin ||
      canonicalDestination(request.url).origin !== request.destinationOrigin ||
      proof.intent !== request.intent
    )
      throw new Error(requests.has(request.requestId) ? 'replayed_request' : STALE_GRANT)
    if (
      proof.scope.sessionId !== request.sessionId ||
      proof.scope.turnId !== request.turnId ||
      !validNavigateProof(proof) ||
      (mode === 'persistent' && proof.policyDecision !== 'allow')
    ) {
      throw new Error(STALE_GRANT)
    }
    if (navigateGrants.size >= MAX_NAVIGATE_GRANTS) throw new Error('grant_capacity_exhausted')
    const grant: BrowserNavigateGrant = {
      ...proof,
      scope: { ...proof.scope },
      source: { ...proof.source },
      id: randomUUID(),
      action: 'navigate',
      expiresAt: Math.min(proof.expiresAt, Date.now() + READ_GRANT_LIFETIME_MS),
    }
    navigateProofs.delete(request.requestId)
    navigateGrants.set(grant.id, grant)
    notifyWaiter(request.requestId)
    return copyNavigateGrant(grant)
  }
  const consumeNavigate = (id: string): BrowserNavigateGrant => {
    prune()
    const grant = navigateGrants.get(id)
    if (!grant) throw new Error(STALE_GRANT)
    navigateGrants.delete(id)
    if (!validNavigateProof(grant)) throw new Error(STALE_GRANT)
    return copyNavigateGrant(grant)
  }
  return {
    rebind(nextOwners: Owners): void {
      grants.clear()
      proofs.clear()
      navigateGrants.clear()
      navigateProofs.clear()
      searchGrants.clear()
      for (const requestId of approvalWaiters.keys()) rejectWaiter(requestId)
      for (const id of leases.keys()) clearLease(id)
      currentOwners = nextOwners
    },
    issueSearch(request: {
      authority: BrowserReadAuthority
      requestId: string
      url: string
      query: string
      parameter: string
    }): BrowserSearchGrant {
      prune()
      if (!request.requestId || requests.has(request.requestId)) throw new Error('replayed_request')
      if (!this.validateAuthority(request.authority)) throw new Error(STALE_GRANT)
      const target = currentOwners.target(request.authority.tabId)
      const destination = canonicalDestination(request.url)
      const address = new URL(destination.url)
      if (
        !target ||
        destination.origin !== target.origin ||
        address.hash ||
        !request.parameter ||
        !request.query.trim() ||
        request.query !== request.query.trim() ||
        address.searchParams.getAll(request.parameter).length !== 1 ||
        address.searchParams.get(request.parameter) !== request.query
      )
        throw new Error(STALE_GRANT)
      const read = currentOwners.policy(target.origin)
      const interact = currentOwners.navigatePolicy?.(target.origin)
      if (!interact || read.decision === 'block' || interact.decision === 'block')
        throw new Error(STALE_GRANT)
      if (read.decision !== 'allow' || interact.decision !== 'allow')
        throw new Error(SEARCH_AUTHORIZATION_REQUIRED)
      if (requests.size >= MAX_SCOPE_REQUESTS || searchGrants.size >= MAX_NAVIGATE_GRANTS)
        throw new Error('grant_capacity_exhausted')
      const grant: BrowserSearchGrant = {
        id: randomUUID(),
        requestId: request.requestId,
        scope: { ...request.authority.scope },
        tabId: request.authority.tabId,
        target: { ...target },
        url: destination.url,
        query: request.query,
        parameter: request.parameter,
        expiresAt: Date.now() + READ_GRANT_LIFETIME_MS,
        readRevision: read.revision,
        interactRevision: interact.revision,
      }
      requests.set(request.requestId, {
        scope: { ...grant.scope },
        tabId: grant.tabId,
        cancelled: false,
        action: 'search',
      })
      searchGrants.set(grant.id, { grant, claimed: false, generation: target.generation })
      return { ...grant, scope: { ...grant.scope }, target: { ...grant.target } }
    },
    claimSearch(grant: BrowserSearchGrant): void {
      if (!validSearch(grant)) throw new Error(STALE_GRANT)
      const record = searchGrants.get(grant.id)!
      if (record.claimed) throw new Error('replayed_request')
      record.claimed = true
    },
    validateSearch: validSearch,
    finishSearch(grant: BrowserSearchGrant): void {
      searchGrants.delete(grant.id)
    },
    prepareRead(
      request: Pick<BrowserReadRequest, 'sessionId' | 'turnId' | 'requestId' | 'tabId' | 'intent'>
    ): BrowserReadProof {
      prune()
      if (
        !request.requestId ||
        !request.tabId ||
        !request.intent.trim() ||
        requests.has(request.requestId)
      ) {
        throw new Error('replayed_request')
      }
      const scope = currentOwners.scope(request.sessionId, request.turnId)
      const target = currentOwners.target(request.tabId)
      if (
        !scope ||
        scope.sessionId !== request.sessionId ||
        scope.turnId !== request.turnId ||
        !target ||
        !target.origin
      )
        throw new Error(STALE_GRANT)
      const policy = currentOwners.policy(target.origin)
      if (policy.decision === 'block') throw new Error(STALE_GRANT)
      if (requests.size >= MAX_SCOPE_REQUESTS || proofs.size >= MAX_READ_PROOFS)
        throw new Error('grant_capacity_exhausted')
      const proof: BrowserReadProof = {
        proofId: randomUUID(),
        requestId: request.requestId,
        scope: { ...scope },
        tabId: request.tabId,
        target: { ...target },
        intent: request.intent,
        expiresAt: Date.now() + READ_PROOF_LIFETIME_MS,
        policyRevision: policy.revision,
        policyDecision: policy.decision,
      }
      requests.set(request.requestId, {
        scope: proof.scope,
        tabId: proof.tabId,
        cancelled: false,
        action: 'read',
      })
      proofs.set(request.requestId, proof)
      return proof
    },
    prepareNavigate(request: {
      sessionId: string
      turnId: string
      requestId: string
      tabId: string
      url: string
      intent: string
    }): BrowserNavigateProof {
      prune()
      if (
        !request.requestId ||
        !request.tabId ||
        !request.intent.trim() ||
        requests.has(request.requestId) ||
        !currentOwners.navigatePolicy
      )
        throw new Error(requests.has(request.requestId) ? 'replayed_request' : STALE_GRANT)
      const destination = canonicalDestination(request.url)
      const scope = currentOwners.scope(request.sessionId, request.turnId)
      const source = navigateSource(request.tabId)
      const policy = currentOwners.navigatePolicy(destination.origin)
      if (
        !scope ||
        scope.sessionId !== request.sessionId ||
        scope.turnId !== request.turnId ||
        !source ||
        policy.decision === 'block'
      )
        throw new Error(STALE_GRANT)
      if (requests.size >= MAX_SCOPE_REQUESTS || navigateProofs.size >= MAX_NAVIGATE_PROOFS) {
        throw new Error('grant_capacity_exhausted')
      }
      const proof: BrowserNavigateProof = {
        proofId: randomUUID(),
        requestId: request.requestId,
        scope: { ...scope },
        tabId: request.tabId,
        source: { ...source },
        url: destination.url,
        destinationOrigin: destination.origin,
        intent: request.intent,
        expiresAt: Date.now() + READ_PROOF_LIFETIME_MS,
        policyRevision: policy.revision,
        policyDecision: policy.decision,
      }
      requests.set(request.requestId, {
        scope: proof.scope,
        tabId: proof.tabId,
        cancelled: false,
        action: 'navigate',
      })
      navigateProofs.set(request.requestId, proof)
      return copyNavigateProof(proof)
    },
    navigateProof(requestId: string, proofId: string): BrowserNavigateProof {
      prune()
      const proof = navigateProofs.get(requestId)
      if (!proof || proof.proofId !== proofId || !validNavigateProof(proof))
        throw new Error(STALE_GRANT)
      return copyNavigateProof(proof)
    },
    issueNavigateApproved: (request: BrowserNavigateRequest): BrowserNavigateGrant =>
      issueNavigate(request, 'approved'),
    issueNavigatePersistent: (request: BrowserNavigateRequest): BrowserNavigateGrant =>
      issueNavigate(request, 'persistent'),
    consumeNavigate,
    async acquireNavigate(request: {
      scope: BrowserReadScope
      requestId: string
      proofId: string
      tabId: string
    }): Promise<BrowserNavigateGrant> {
      prune()
      const current = currentOwners.scope(request.scope.sessionId, request.scope.turnId)
      if (!current || !sameScope(current, request.scope)) throw new Error(STALE_GRANT)
      let grant = [...navigateGrants.values()].find(
        (candidate) => candidate.requestId === request.requestId
      )
      if (!grant) {
        const proof = navigateProofs.get(request.requestId)
        if (
          !proof ||
          proof.proofId !== request.proofId ||
          proof.tabId !== request.tabId ||
          !sameScope(proof.scope, request.scope)
        )
          throw new Error('replayed_request')
        this.navigateProof(proof.requestId, proof.proofId)
        if (proof.policyDecision === 'allow') {
          grant = issueNavigate(
            {
              sessionId: proof.scope.sessionId,
              turnId: proof.scope.turnId,
              requestId: proof.requestId,
              proofId: proof.proofId,
              tabId: proof.tabId,
              sourceInstanceId: proof.source.instanceId,
              sourceGeneration: proof.source.generation,
              sourceOrigin: proof.source.origin,
              url: proof.url,
              destinationOrigin: proof.destinationOrigin,
              intent: proof.intent,
              expiresAt: proof.expiresAt,
            },
            'persistent'
          )
        } else {
          if (
            approvalWaiters.size >= MAX_APPROVAL_WAITERS ||
            approvalWaiters.has(request.requestId)
          ) {
            throw new Error('grant_capacity_exhausted')
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                approvalWaiters.delete(request.requestId)
                reject(new Error(STALE_GRANT))
              },
              Math.min(APPROVAL_MINT_WAIT_MS, proof.expiresAt - Date.now())
            )
            approvalWaiters.set(request.requestId, { resolve, reject, timer })
          })
          grant = [...navigateGrants.values()].find(
            (candidate) => candidate.requestId === request.requestId
          )
        }
      }
      if (
        !grant ||
        grant.proofId !== request.proofId ||
        grant.tabId !== request.tabId ||
        !sameScope(grant.scope, request.scope)
      )
        throw new Error(STALE_GRANT)
      return consumeNavigate(grant.id)
    },
    cancelNavigate(request: {
      scope: BrowserReadScope
      requestId: string
      tabId: string
    }): string | null {
      const current = currentOwners.scope(request.scope.sessionId, request.scope.turnId)
      const reserved = requests.get(request.requestId)
      if (
        !request.requestId ||
        !request.tabId ||
        !current ||
        !sameScope(current, request.scope) ||
        (reserved &&
          (reserved.action !== 'navigate' ||
            !sameScope(reserved.scope, request.scope) ||
            reserved.tabId !== request.tabId))
      ) {
        throw new Error(STALE_GRANT)
      }
      const revokedTabId = reserved && !reserved.cancelled ? reserved.tabId : null
      if (!reserved) {
        if (requests.size >= MAX_SCOPE_REQUESTS) throw new Error('grant_capacity_exhausted')
        requests.set(request.requestId, {
          scope: { ...request.scope },
          tabId: request.tabId,
          cancelled: true,
          action: 'navigate',
        })
      } else reserved.cancelled = true
      rejectWaiter(request.requestId)
      navigateProofs.delete(request.requestId)
      for (const [id, grant] of navigateGrants)
        if (grant.requestId === request.requestId) navigateGrants.delete(id)
      return revokedTabId
    },
    readProof(requestId: string, proofId: string): BrowserReadProof {
      prune()
      const proof = proofs.get(requestId)
      if (!proof || proof.proofId !== proofId) throw new Error(STALE_GRANT)
      const scope = currentOwners.scope(proof.scope.sessionId, proof.scope.turnId)
      const target = currentOwners.target(proof.tabId)
      const policy = currentOwners.policy(proof.target.origin)
      if (
        !scope ||
        !sameScope(scope, proof.scope) ||
        !target ||
        !sameTarget(target, proof.target) ||
        policy.revision !== proof.policyRevision ||
        policy.decision !== proof.policyDecision
      )
        throw new Error(STALE_GRANT)
      return proof
    },
    issueApproved: (request: BrowserReadRequest): BrowserReadGrant => issue(request, 'approved'),
    issuePersistent: (request: BrowserReadRequest): BrowserReadGrant =>
      issue(request, 'persistent'),
    consume,
    async acquireSnapshot(request: {
      scope: BrowserReadScope
      requestId: string
      proofId: string
      tabId: string
    }): Promise<BrowserReadAuthority> {
      prune()
      const current = currentOwners.scope(request.scope.sessionId, request.scope.turnId)
      if (!current || !sameScope(current, request.scope)) throw new Error(STALE_GRANT)
      let grant = [...grants.values()].find(
        (candidate) => candidate.requestId === request.requestId
      )
      if (!grant) {
        const proof = proofs.get(request.requestId)
        if (
          !proof ||
          proof.proofId !== request.proofId ||
          proof.tabId !== request.tabId ||
          !sameScope(proof.scope, request.scope)
        )
          throw new Error('replayed_request')
        this.readProof(proof.requestId, proof.proofId)
        if (proof.policyDecision === 'allow') {
          grant = issue(
            {
              sessionId: proof.scope.sessionId,
              turnId: proof.scope.turnId,
              requestId: proof.requestId,
              proofId: proof.proofId,
              tabId: proof.tabId,
              origin: proof.target.origin,
              targetInstanceId: proof.target.instanceId,
              targetGeneration: proof.target.generation,
              intent: proof.intent,
              expiresAt: proof.expiresAt,
            },
            'persistent'
          )
        } else {
          if (
            approvalWaiters.size >= MAX_APPROVAL_WAITERS ||
            approvalWaiters.has(request.requestId)
          ) {
            throw new Error('grant_capacity_exhausted')
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                approvalWaiters.delete(request.requestId)
                reject(new Error(STALE_GRANT))
              },
              Math.min(APPROVAL_MINT_WAIT_MS, proof.expiresAt - Date.now())
            )
            approvalWaiters.set(request.requestId, { resolve, reject, timer })
          })
          grant = [...grants.values()].find(
            (candidate) => candidate.requestId === request.requestId
          )
        }
      }
      if (
        !grant ||
        grant.proofId !== request.proofId ||
        grant.tabId !== request.tabId ||
        !sameScope(grant.scope, request.scope)
      )
        throw new Error(STALE_GRANT)
      if (leases.size >= MAX_ACTIVE_READ_LEASES) throw new Error('grant_capacity_exhausted')
      const consumed = consume(grant.id)
      for (const [id, lease] of leases) if (lease.grant.tabId === consumed.tabId) clearLease(id)
      const authority: BrowserReadAuthority = {
        scope: { ...consumed.scope },
        tabId: consumed.tabId,
        grantId: consumed.id,
        grantRequestId: consumed.requestId,
        grantRevision: consumed.policyRevision,
      }
      leases.set(authority.grantId, {
        authority,
        grant: consumed,
        snapshotId: null,
        actionSnapshotId: null,
        expiresAt: consumed.expiresAt,
      })
      return { ...authority, scope: { ...authority.scope } }
    },
    validateAuthority(authority: BrowserReadAuthority): boolean {
      prune()
      const lease = leases.get(authority.grantId)
      if (
        !lease ||
        lease.authority.tabId !== authority.tabId ||
        lease.authority.grantRequestId !== authority.grantRequestId ||
        lease.authority.grantRevision !== authority.grantRevision ||
        !sameScope(lease.authority.scope, authority.scope)
      ) {
        if (lease) clearLease(authority.grantId)
        return false
      }
      return true
    },
    finishSnapshot(authority: BrowserReadAuthority, snapshotId: string): void {
      if (!snapshotId || !this.validateAuthority(authority) || snapshots.has(snapshotId))
        throw new Error(STALE_GRANT)
      const lease = leases.get(authority.grantId)!
      if (lease.snapshotId || lease.actionSnapshotId) throw new Error(STALE_GRANT)
      lease.snapshotId = snapshotId
      lease.expiresAt = Math.min(lease.expiresAt, Date.now() + SNAPSHOT_READ_LIFETIME_MS)
      snapshots.set(snapshotId, authority.grantId)
    },
    finishActionObservation(authority: BrowserReadAuthority, snapshotId: string): void {
      if (!snapshotId || !this.validateAuthority(authority)) throw new Error(STALE_GRANT)
      const lease = leases.get(authority.grantId)!
      if (lease.snapshotId || lease.actionSnapshotId) throw new Error(STALE_GRANT)
      lease.actionSnapshotId = snapshotId
    },
    extendActionLease(
      authority: BrowserReadAuthority,
      snapshotId: string,
      expiresAt: number
    ): void {
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + READ_GRANT_LIFETIME_MS ||
        !this.validateAuthority(authority)
      )
        throw new Error(STALE_GRANT)
      const lease = leases.get(authority.grantId)
      const interactPolicy = lease && currentOwners.navigatePolicy?.(lease.grant.target.origin)
      if (
        !lease ||
        (lease.snapshotId !== snapshotId && lease.actionSnapshotId !== snapshotId) ||
        !interactPolicy ||
        interactPolicy.decision === 'block' ||
        interactPolicy.revision !== authority.grantRevision
      )
        throw new Error(STALE_GRANT)
      lease.expiresAt = expiresAt
    },
    readAuthority(request: {
      scope: BrowserReadScope
      tabId: string
      snapshotId: string
    }): BrowserReadAuthority {
      const grantId = snapshots.get(request.snapshotId)
      const lease = grantId ? leases.get(grantId) : null
      if (
        !lease ||
        lease.snapshotId !== request.snapshotId ||
        lease.grant.tabId !== request.tabId ||
        !sameScope(lease.grant.scope, request.scope) ||
        !this.validateAuthority(lease.authority)
      ) {
        throw new Error(STALE_REF)
      }
      return { ...lease.authority, scope: { ...lease.authority.scope } }
    },
    cancelSnapshot(requestId: string): void {
      rejectWaiter(requestId)
      proofs.delete(requestId)
      for (const [id, grant] of grants) if (grant.requestId === requestId) grants.delete(id)
      for (const [id, lease] of leases) if (lease.grant.requestId === requestId) clearLease(id)
    },
    cancelRead(request: { scope: BrowserReadScope; requestId: string; tabId: string }): boolean {
      const current = currentOwners.scope(request.scope.sessionId, request.scope.turnId)
      if (!request.requestId || !request.tabId || !current || !sameScope(current, request.scope)) {
        throw new Error(STALE_GRANT)
      }
      const reserved = requests.get(request.requestId)
      if (
        reserved &&
        (reserved.action !== 'read' ||
          !sameScope(reserved.scope, request.scope) ||
          reserved.tabId !== request.tabId)
      ) {
        throw new Error(STALE_GRANT)
      }
      if (!reserved) {
        if (requests.size >= MAX_SCOPE_REQUESTS) throw new Error('grant_capacity_exhausted')
        requests.set(request.requestId, {
          scope: { ...request.scope },
          tabId: request.tabId,
          cancelled: true,
          action: 'read',
        })
      } else reserved.cancelled = true
      const hadActiveLease = [...leases.values()].some(
        (lease) => lease.grant.requestId === request.requestId
      )
      this.cancelSnapshot(request.requestId)
      return hadActiveLease
    },
    revokeTab(tabId: string, ownedNavigation = false): void {
      for (const [id, record] of searchGrants) {
        if (record.grant.tabId !== tabId) continue
        const target = currentOwners.target(tabId)
        if (
          !ownedNavigation ||
          !record.claimed ||
          !target ||
          target.instanceId !== record.grant.target.instanceId ||
          target.origin !== record.grant.target.origin
        )
          searchGrants.delete(id)
        else record.generation = target.generation
      }
      for (const [id, grant] of grants) if (grant.tabId === tabId) grants.delete(id)
      for (const [id, proof] of proofs)
        if (proof.tabId === tabId) {
          proofs.delete(id)
          rejectWaiter(id)
        }
      for (const [id, lease] of leases) if (lease.grant.tabId === tabId) clearLease(id)
      for (const [id, grant] of navigateGrants) if (grant.tabId === tabId) navigateGrants.delete(id)
      for (const [id, proof] of navigateProofs)
        if (proof.tabId === tabId) {
          navigateProofs.delete(id)
          rejectWaiter(id)
        }
    },
    revokeScope(scope: BrowserReadScope): void {
      for (const [id, record] of searchGrants)
        if (sameScope(record.grant.scope, scope)) searchGrants.delete(id)
      for (const [id, grant] of grants) if (sameScope(grant.scope, scope)) grants.delete(id)
      for (const [id, proof] of proofs)
        if (sameScope(proof.scope, scope)) {
          proofs.delete(id)
          rejectWaiter(id)
        }
      for (const [id, lease] of leases) if (sameScope(lease.grant.scope, scope)) clearLease(id)
      for (const [id, reserved] of requests) {
        if (!sameScope(reserved.scope, scope)) continue
        const current = currentOwners.scope(reserved.scope.sessionId, reserved.scope.turnId)
        if (reserved.action === 'read' || !current || !sameScope(current, reserved.scope))
          requests.delete(id)
      }
      for (const [id, grant] of navigateGrants)
        if (sameScope(grant.scope, scope)) navigateGrants.delete(id)
      for (const [id, proof] of navigateProofs)
        if (sameScope(proof.scope, scope)) {
          navigateProofs.delete(id)
          rejectWaiter(id)
        }
    },
    retireTransport(): boolean {
      searchGrants.clear()
      navigateGrants.clear()
      for (const requestId of navigateProofs.keys()) rejectWaiter(requestId)
      navigateProofs.clear()
      let retired = true
      for (const [id, reserved] of requests) {
        const active = currentOwners.scope(reserved.scope.sessionId, reserved.scope.turnId)
        if (active && sameScope(active, reserved.scope)) retired = false
        else requests.delete(id)
      }
      for (const [id, grant] of grants) {
        const active = currentOwners.scope(grant.scope.sessionId, grant.scope.turnId)
        if (!active || !sameScope(active, grant.scope)) grants.delete(id)
      }
      for (const [id, proof] of proofs) {
        const active = currentOwners.scope(proof.scope.sessionId, proof.scope.turnId)
        if (!active || !sameScope(active, proof.scope)) {
          proofs.delete(id)
          rejectWaiter(id)
        }
      }
      for (const [id, lease] of leases) if (!validLease(lease)) clearLease(id)
      return retired
    },
    revokeAll(): void {
      searchGrants.clear()
      grants.clear()
      proofs.clear()
      navigateGrants.clear()
      navigateProofs.clear()
      for (const requestId of approvalWaiters.keys()) rejectWaiter(requestId)
      for (const id of leases.keys()) clearLease(id)
    },
  }
}
