import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { createAgentTransport, type AgentTransport } from './agenttransport.ts'
import { createBrowserReadGrants, type BrowserReadRequest } from './grant.ts'

const scope = {
  sessionId: 'session',
  instanceId: 'instance',
  productTurnId: 'product-turn',
  turnId: 'native-turn',
  generation: 1,
  interruptGeneration: 0,
  lifecycleEpoch: 1,
}
const target = { instanceId: 'tab-instance', generation: 3, origin: 'https://example.org' }
const request = {
  sessionId: scope.sessionId,
  turnId: scope.turnId,
  requestId: 'request-1',
  tabId: 'tab',
  origin: target.origin,
  targetInstanceId: target.instanceId,
  targetGeneration: target.generation,
  intent: 'Read page',
  expiresAt: Date.now() + 20_000,
}
const REQUEST_LEDGER_CAPACITY = 4_096
const OBSERVED_ACTION_LIFETIME_MS = 25_000

async function searchFixture() {
  const state = fixture()
  state.setDecision('allow')
  state.setInteractDecision('allow')
  const proof = state.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'search-home-read',
    tabId: 'tab',
    intent: 'Inspect search form',
  })
  const authority = await state.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: 'tab',
  })
  const input = {
    authority,
    requestId: 'search-submit',
    url: 'https://example.org/search?q=test&form=HOME',
    query: 'test',
    parameter: 'q',
  }
  return { ...state, input }
}

test('public search authority binds exact destination, query, target and a single claim', async () => {
  const state = await searchFixture()
  const grant = state.grants.issueSearch(state.input)
  assert.equal(grant.url, state.input.url)
  assert.equal(state.grants.validateSearch(grant), true)
  assert.equal(state.grants.validateSearch({ ...grant, query: 'changed' }), false)
  assert.equal(
    state.grants.validateSearch({ ...grant, url: 'https://example.org/search?q=other' }),
    false
  )
  assert.throws(() => state.grants.issueSearch(state.input), /replayed_request/)
  state.grants.claimSearch(grant)
  assert.throws(() => state.grants.claimSearch(grant), /replayed_request/)
  state.grants.finishSearch(grant)
  assert.equal(state.grants.validateSearch(grant), false)
})

test('public search cannot mint authority from ask, block or a changed read lease', async () => {
  for (const decision of ['ask', 'block'] as const) {
    const state = await searchFixture()
    state.setInteractDecision(decision)
    assert.throws(
      () => state.grants.issueSearch(state.input),
      decision === 'ask' ? /browser_search_authorization_required/ : /stale_grant/
    )
  }
  const state = await searchFixture()
  state.setDecision('ask')
  assert.throws(() => state.grants.issueSearch(state.input), /stale_grant/)
})

test('public search rejects cross-origin, mismatched and duplicate query destinations', async () => {
  for (const url of [
    'https://other.example/search?q=test',
    'https://example.org/search?q=other',
    'https://example.org/search?q=test&q=test',
    'https://example.org/search?q=test#fragment',
  ]) {
    const state = await searchFixture()
    assert.throws(() => state.grants.issueSearch({ ...state.input, url }), /stale_grant/)
  }
})

test('only a claimed public search survives its owned same-instance navigation', async () => {
  const state = await searchFixture()
  const grant = state.grants.issueSearch(state.input)
  state.grants.claimSearch(grant)
  state.setTarget({ ...target, generation: target.generation + 1 })
  state.grants.revokeTab('tab', true)
  assert.equal(state.grants.validateSearch(grant), true)
  assert.equal(state.grants.validateAuthority(state.input.authority), false)
  state.grants.revokeTab('tab')
  assert.equal(state.grants.validateSearch(grant), false)
  const unclaimed = await searchFixture()
  const pending = unclaimed.grants.issueSearch(unclaimed.input)
  unclaimed.grants.revokeTab('tab', true)
  assert.equal(unclaimed.grants.validateSearch(pending), false)
})

test('search authority is revoked by policy, scope, replacement and global cleanup', async () => {
  for (const change of [
    'policy',
    'scope',
    'instance',
    'origin',
    'all',
    'scope-revoke',
    'retire',
  ] as const) {
    const state = await searchFixture()
    const grant = state.grants.issueSearch(state.input)
    state.grants.claimSearch(grant)
    if (change === 'policy') state.setRevision(2)
    if (change === 'scope') state.setScope({ ...scope, generation: 2 })
    if (change === 'instance') state.setTarget({ ...target, instanceId: 'replacement' })
    if (change === 'origin') state.setTarget({ ...target, origin: 'https://other.example' })
    if (change === 'all') state.grants.revokeAll()
    if (change === 'scope-revoke') state.grants.revokeScope(scope)
    if (change === 'retire') state.grants.retireTransport()
    assert.equal(state.grants.validateSearch(grant), false, change)
  }
})

test('search authority expires permanently and cannot revive after scope restoration', async (context) => {
  const state = await searchFixture()
  const grant = state.grants.issueSearch(state.input)
  state.grants.claimSearch(grant)
  context.mock.timers.enable({ apis: ['Date'], now: grant.expiresAt })
  assert.equal(state.grants.validateSearch(grant), false)
  context.mock.timers.reset()
  assert.equal(state.grants.validateSearch(grant), false)
  const next = await searchFixture()
  const current = next.grants.issueSearch(next.input)
  next.setScope({ ...scope, interruptGeneration: scope.interruptGeneration + 1 })
  assert.equal(next.grants.validateSearch(current), false)
  next.setScope(scope)
  assert.equal(next.grants.validateSearch(current), false)
})

test('revalidated action binding cannot republish an old snapshot as ordinary read authority', async () => {
  const state = fixture()
  const proof = state.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'renewed-action-read',
    tabId: 'tab',
    intent: request.intent,
  })
  state.grants.issueApproved({
    ...request,
    requestId: proof.requestId,
    proofId: proof.proofId,
    expiresAt: proof.expiresAt,
  })
  const authority = await state.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: 'tab',
  })
  state.grants.finishActionObservation(authority, 'original-observation')
  assert.throws(
    () => state.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'original-observation' }),
    /stale_ref/
  )
  assert.throws(
    () => state.grants.finishActionObservation(authority, 'other-observation'),
    /stale_grant/
  )
  state.grants.extendActionLease(
    authority,
    'original-observation',
    Date.now() + OBSERVED_ACTION_LIFETIME_MS
  )
  assert.equal(state.grants.validateAuthority(authority), true)
  assert.throws(
    () => state.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'original-observation' }),
    /stale_ref/
  )
  state.setRevision(2)
  assert.equal(state.grants.validateAuthority(authority), false)
})

function issue(
  grants: ReturnType<typeof createBrowserReadGrants>,
  input: Omit<BrowserReadRequest, 'proofId'>,
  source: 'approved' | 'persistent' = 'approved'
) {
  const proof = grants.prepareRead({
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestId: input.requestId,
    tabId: input.tabId,
    intent: input.intent,
  })
  const prepared = { ...input, proofId: proof.proofId, expiresAt: proof.expiresAt }
  return source === 'approved' ? grants.issueApproved(prepared) : grants.issuePersistent(prepared)
}

function fixture() {
  let activeScope: typeof scope | null = scope
  let currentTarget: typeof target | null = target
  let revision = 1
  let decision: 'ask' | 'allow' | 'block' = 'ask'
  let interactDecision: 'ask' | 'allow' | 'block' = 'ask'
  const grants = createBrowserReadGrants({
    scope: () => activeScope,
    target: () => currentTarget,
    policy: () => ({ revision, decision }),
    navigatePolicy: () => ({ revision, decision: interactDecision }),
  })
  return {
    grants,
    setScope: (value: typeof scope | null) => {
      activeScope = value
    },
    setTarget: (value: typeof target | null) => {
      currentTarget = value
    },
    setRevision: (value: number) => {
      revision = value
    },
    setDecision: (value: typeof decision) => {
      decision = value
    },
    setInteractDecision: (value: typeof interactDecision) => {
      interactDecision = value
    },
  }
}

test('authority validation checks each live lease once and still sees the next policy revocation', async () => {
  let revision = 1
  let inspections = 0
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => {
      inspections += 1
      return { revision, decision: 'allow' }
    },
  })
  const proof = grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'inspection-request',
    tabId: 'tab',
    intent: 'Read page',
  })
  grants.issuePersistent({
    ...request,
    requestId: proof.requestId,
    proofId: proof.proofId,
    expiresAt: proof.expiresAt,
  })
  const authority = await grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: 'tab',
  })
  inspections = 0
  assert.equal(grants.validateAuthority(authority), true)
  assert.equal(inspections, 1)
  revision += 1
  assert.equal(grants.validateAuthority(authority), false)
})

test('trusted allow-once grant binds complete scope and is consumed exactly once', () => {
  const fixtureState = fixture()
  const grant = issue(fixtureState.grants, request)
  assert.equal(grant.scope.lifecycleEpoch, 1)
  assert.equal(grant.policyRevision, 1)
  assert.equal(fixtureState.grants.consume(grant.id).requestId, request.requestId)
  assert.throws(() => fixtureState.grants.consume(grant.id), /stale_grant/)
  assert.throws(() => issue(fixtureState.grants, request), /replayed_request/)
})

test('policy allow is needed for persistent grant; block prevents both sources', () => {
  const fixtureState = fixture()
  assert.throws(() => issue(fixtureState.grants, request, 'persistent'), /stale_grant/)
  fixtureState.setDecision('allow')
  const persistent = issue(
    fixtureState.grants,
    { ...request, requestId: 'persistent-request' },
    'persistent'
  )
  fixtureState.setRevision(2)
  assert.throws(() => fixtureState.grants.consume(persistent.id), /stale_grant/)
  fixtureState.setDecision('block')
  assert.throws(
    () => issue(fixtureState.grants, { ...request, requestId: 'request-2' }),
    /stale_grant/
  )
})

test('persistent grant rejects same-revision allow-to-ask policy change', () => {
  const fixtureState = fixture()
  fixtureState.setDecision('allow')
  const persistent = issue(fixtureState.grants, request, 'persistent')
  fixtureState.setDecision('ask')
  assert.throws(() => fixtureState.grants.consume(persistent.id), /stale_grant/)
})

test('grant lifetime is capped without rejecting a longer valid HIL card', () => {
  const fixtureState = fixture()
  const issuedAt = Date.now()
  const longCard = { ...request, expiresAt: issuedAt + 60_000 }
  const grant = issue(fixtureState.grants, longCard)
  assert.ok(grant.expiresAt >= issuedAt + 29_000)
  assert.ok(grant.expiresAt <= issuedAt + 30_000)
  assert.ok(grant.expiresAt < longCard.expiresAt)
  assert.equal(fixtureState.grants.consume(grant.id).requestId, longCard.requestId)
})

test('scope, target and policy changes revoke before consume', () => {
  const fixtureState = fixture()
  const oldTab = issue(fixtureState.grants, request)
  fixtureState.setTarget({ ...target, generation: 4 })
  assert.throws(() => fixtureState.grants.consume(oldTab.id), /stale_grant/)
  fixtureState.setTarget(target)
  const oldScope = issue(fixtureState.grants, { ...request, requestId: 'request-2' })
  fixtureState.setScope({ ...scope, generation: 2 })
  assert.throws(() => fixtureState.grants.consume(oldScope.id), /stale_grant/)
  fixtureState.setScope(scope)
  const revoked = issue(fixtureState.grants, { ...request, requestId: 'request-3' })
  fixtureState.grants.revokeTab(request.tabId)
  assert.throws(() => fixtureState.grants.consume(revoked.id), /stale_grant/)
  fixtureState.grants.revokeAll()
  assert.throws(
    () => issue(fixtureState.grants, { ...request, requestId: 'request-3' }),
    /replayed_request/
  )
})

test('transport retirement cannot clear request IDs while their scope is still active', () => {
  const fixtureState = fixture()
  const issued = issue(fixtureState.grants, request)
  assert.equal(fixtureState.grants.retireTransport(), false)
  assert.throws(() => issue(fixtureState.grants, request), /replayed_request/)
  fixtureState.setScope(null)
  assert.equal(fixtureState.grants.retireTransport(), true)
  assert.throws(() => fixtureState.grants.consume(issued.id), /stale_grant/)
})

test('window owner rebind preserves request IDs within the same active scope', () => {
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'ask' }),
  })
  const oldGrant = issue(grants, request)
  const nextTarget = { ...target, instanceId: 'next-window-tab' }
  grants.rebind({
    scope: () => scope,
    target: () => nextTarget,
    policy: () => ({ revision: 2, decision: 'ask' }),
  })
  assert.throws(() => grants.consume(oldGrant.id), /stale_grant/)
  const nextRequest = { ...request, targetInstanceId: nextTarget.instanceId }
  assert.throws(() => issue(grants, nextRequest), /replayed_request/)
  assert.equal(
    issue(grants, { ...nextRequest, requestId: 'new-window-request' }).target.instanceId,
    nextTarget.instanceId
  )
})

test('read proof comes from live Main owners and rejects stale scope, target, and policy', () => {
  const fixtureState = fixture()
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'prepared-request',
    tabId: 'tab',
    intent: request.intent,
  })
  assert.equal(proof.target.origin, target.origin)
  assert.equal(proof.scope.instanceId, scope.instanceId)
  assert.equal(proof.policyDecision, 'ask')
  assert.ok(proof.expiresAt > Date.now())
  assert.ok(proof.expiresAt <= Date.now() + 60_000)
  assert.throws(() => fixtureState.grants.readProof(proof.requestId, 'forged-proof'), /stale_grant/)
  assert.throws(
    () =>
      fixtureState.grants.issueApproved({
        ...request,
        requestId: proof.requestId,
        proofId: 'forged-proof',
        expiresAt: proof.expiresAt,
      }),
    /replayed_request/
  )
  assert.throws(
    () =>
      fixtureState.grants.prepareRead({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: 'prepared-request',
        tabId: 'tab',
        intent: request.intent,
      }),
    /replayed_request/
  )
  fixtureState.setTarget({ ...target, generation: target.generation + 1 })
  assert.throws(
    () =>
      fixtureState.grants.issueApproved({
        ...request,
        requestId: proof.requestId,
        proofId: proof.proofId,
        targetGeneration: target.generation,
        expiresAt: proof.expiresAt,
      }),
    /stale_grant/
  )
  fixtureState.setTarget(target)
  fixtureState.setRevision(2)
  assert.throws(
    () =>
      fixtureState.grants.issueApproved({
        ...request,
        requestId: proof.requestId,
        proofId: proof.proofId,
        expiresAt: proof.expiresAt,
      }),
    /stale_grant/
  )
})

test('approved snapshot waits for the matching Main mint and keeps read in its snapshot lease', async () => {
  const fixtureState = fixture()
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'snapshot-request',
    tabId: 'tab',
    intent: request.intent,
  })
  const pending = fixtureState.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  const issued = fixtureState.grants.issueApproved({
    ...request,
    requestId: proof.requestId,
    proofId: proof.proofId,
    expiresAt: proof.expiresAt,
  })
  const authority = await pending
  assert.equal(authority.grantId, issued.id)
  assert.equal(authority.grantRequestId, proof.requestId)
  assert.equal(fixtureState.grants.validateAuthority(authority), true)
  fixtureState.grants.finishSnapshot(authority, 'snapshot-id')
  assert.deepEqual(
    fixtureState.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'snapshot-id' }),
    authority
  )
  assert.throws(
    () => fixtureState.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'forged' }),
    /stale_ref/
  )
  await assert.rejects(
    fixtureState.grants.acquireSnapshot({
      scope,
      requestId: proof.requestId,
      proofId: proof.proofId,
      tabId: proof.tabId,
    }),
    /replayed_request/
  )
})

test('action lease extends only a live snapshot and refuses interact block or revision drift', async () => {
  const fixtureState = fixture()
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'action-read',
    tabId: 'tab',
    intent: request.intent,
  })
  const pending = fixtureState.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  fixtureState.grants.issueApproved({
    ...request,
    requestId: proof.requestId,
    proofId: proof.proofId,
    expiresAt: proof.expiresAt,
  })
  const authority = await pending
  fixtureState.grants.finishSnapshot(authority, 'action-snapshot')
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    const actionExpiry = now + 25_000
    fixtureState.setInteractDecision('block')
    assert.throws(
      () => fixtureState.grants.extendActionLease(authority, 'action-snapshot', actionExpiry),
      /stale_grant/
    )
    fixtureState.setInteractDecision('ask')
    assert.throws(
      () => fixtureState.grants.extendActionLease(authority, 'forged-snapshot', actionExpiry),
      /stale_grant/
    )
    fixtureState.grants.extendActionLease(authority, 'action-snapshot', actionExpiry)
    now += 11_000
    assert.equal(fixtureState.grants.validateAuthority(authority), true)
    fixtureState.setRevision(2)
    assert.equal(fixtureState.grants.validateAuthority(authority), false)
  } finally {
    Date.now = originalNow
  }
})

test('persistent read lease needs live allow and cannot survive target, policy, or scope changes', async () => {
  const fixtureState = fixture()
  fixtureState.setDecision('allow')
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'persistent-snapshot',
    tabId: 'tab',
    intent: request.intent,
  })
  const authority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  fixtureState.grants.finishSnapshot(authority, 'persistent-id')
  fixtureState.setDecision('ask')
  assert.equal(fixtureState.grants.validateAuthority(authority), false)
  assert.throws(
    () => fixtureState.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'persistent-id' }),
    /stale_ref/
  )
  fixtureState.setDecision('allow')
  const second = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'second-snapshot',
    tabId: 'tab',
    intent: request.intent,
  })
  const secondAuthority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: second.requestId,
    proofId: second.proofId,
    tabId: second.tabId,
  })
  fixtureState.grants.finishSnapshot(secondAuthority, 'second-id')
  fixtureState.setTarget({ ...target, generation: target.generation + 1 })
  assert.equal(fixtureState.grants.validateAuthority(secondAuthority), false)
  fixtureState.setTarget(target)
  const third = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'third-snapshot',
    tabId: 'tab',
    intent: request.intent,
  })
  const thirdAuthority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: third.requestId,
    proofId: third.proofId,
    tabId: third.tabId,
  })
  fixtureState.grants.finishSnapshot(thirdAuthority, 'third-id')
  fixtureState.setScope({ ...scope, generation: scope.generation + 1 })
  assert.equal(fixtureState.grants.validateAuthority(thirdAuthority), false)
})

test('late approval after snapshot cancellation never creates an executable lease', async () => {
  const fixtureState = fixture()
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'cancelled-snapshot',
    tabId: 'tab',
    intent: request.intent,
  })
  const pending = fixtureState.grants.acquireSnapshot({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  fixtureState.grants.cancelSnapshot(proof.requestId)
  await assert.rejects(pending, /stale_grant/)
  assert.throws(
    () =>
      fixtureState.grants.issueApproved({
        ...request,
        requestId: proof.requestId,
        proofId: proof.proofId,
        expiresAt: proof.expiresAt,
      }),
    /replayed_request/
  )
  assert.equal(
    fixtureState.grants.validateAuthority({
      scope,
      tabId: 'tab',
      grantId: 'forged',
      grantRequestId: proof.requestId,
      grantRevision: 1,
    }),
    false
  )
})

test('explicit target and scope revocation invalidate snapshot refs before their TTL', async () => {
  const fixtureState = fixture()
  fixtureState.setDecision('allow')
  const first = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'tab-revocation',
    tabId: 'tab',
    intent: request.intent,
  })
  const firstAuthority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: first.requestId,
    proofId: first.proofId,
    tabId: first.tabId,
  })
  fixtureState.grants.finishSnapshot(firstAuthority, 'first-snapshot')
  fixtureState.grants.revokeTab('tab')
  assert.equal(fixtureState.grants.validateAuthority(firstAuthority), false)
  assert.throws(
    () => fixtureState.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'first-snapshot' }),
    /stale_ref/
  )
  const second = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'scope-revocation',
    tabId: 'tab',
    intent: request.intent,
  })
  const secondAuthority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: second.requestId,
    proofId: second.proofId,
    tabId: second.tabId,
  })
  fixtureState.grants.finishSnapshot(secondAuthority, 'second-snapshot')
  fixtureState.grants.revokeScope(scope)
  assert.equal(fixtureState.grants.validateAuthority(secondAuthority), false)
  assert.throws(
    () => fixtureState.grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'second-snapshot' }),
    /stale_ref/
  )
})

test('navigate proof binds blank source and canonical destination, then consumes once', async () => {
  const source = { ...target, origin: null }
  let decision: 'ask' | 'allow' | 'block' = 'allow'
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigateTarget: () => source,
    navigatePolicy: () => ({ revision: 7, decision }),
  })
  const proof = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'navigate-1',
    tabId: 'tab',
    url: 'HTTPS://example.org:443/a/../b#c',
    intent: 'Open page',
  })
  assert.equal(proof.source.origin, null)
  assert.equal(proof.url, 'https://example.org/b#c')
  assert.equal(proof.destinationOrigin, 'https://example.org')
  const grant = grants.issueNavigatePersistent({
    ...proof,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sourceInstanceId: source.instanceId,
    sourceGeneration: source.generation,
    sourceOrigin: source.origin,
  })
  const consumed = await grants.acquireNavigate({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  assert.equal(consumed.id, grant.id)
  assert.equal(consumed.action, 'navigate')
  await assert.rejects(
    grants.acquireNavigate({
      scope,
      requestId: proof.requestId,
      proofId: proof.proofId,
      tabId: proof.tabId,
    }),
    /replayed_request/
  )
  decision = 'block'
})

test('navigate cannot inherit read permission and rejects destination or source drift', async () => {
  const source = { ...target, origin: null as string | null }
  let revision = 1
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigateTarget: () => source,
    navigatePolicy: () => ({ revision, decision: 'ask' }),
  })
  const proof = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'navigate-2',
    tabId: 'tab',
    url: 'https://example.org/path',
    intent: 'Open page',
  })
  const mint = {
    ...proof,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sourceInstanceId: source.instanceId,
    sourceGeneration: source.generation,
    sourceOrigin: source.origin,
  }
  assert.throws(() => grants.issueNavigatePersistent(mint), /stale_grant/)
  assert.throws(
    () => grants.issueNavigateApproved({ ...mint, url: 'https://example.org/other' }),
    /replayed_request/
  )
  source.generation += 1
  assert.throws(() => grants.issueNavigateApproved(mint), /stale_grant/)
  source.generation -= 1
  revision += 1
  assert.throws(() => grants.issueNavigateApproved(mint), /stale_grant/)
  assert.throws(
    () =>
      grants.prepareNavigate({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: 'bad-url',
        tabId: 'tab',
        url: 'javascript:alert(1)',
        intent: 'Open page',
      }),
    /stale_grant/
  )
  const readOnly = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
  })
  assert.throws(
    () =>
      readOnly.prepareNavigate({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: 'no-policy',
        tabId: 'tab',
        url: 'https://example.org',
        intent: 'Open page',
      }),
    /stale_grant/
  )
})

test('navigate proof and grant invalidate on explicit revocation and owner rebind', () => {
  const owners = {
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' as const }),
    navigatePolicy: () => ({ revision: 1, decision: 'allow' as const }),
  }
  const grants = createBrowserReadGrants(owners)
  const prepare = (requestId: string) =>
    grants.prepareNavigate({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      requestId,
      tabId: 'tab',
      url: 'https://example.org',
      intent: 'Open page',
    })
  const mint = (proof: ReturnType<typeof prepare>) =>
    grants.issueNavigatePersistent({
      ...proof,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      sourceInstanceId: target.instanceId,
      sourceGeneration: target.generation,
      sourceOrigin: target.origin,
    })
  const first = prepare('nav-tab')
  grants.revokeTab('tab')
  assert.throws(() => mint(first), /replayed_request/)
  const second = mint(prepare('nav-scope'))
  grants.revokeScope(scope)
  assert.throws(() => grants.consumeNavigate(second.id), /stale_grant/)
  assert.throws(() => prepare('nav-scope'), /replayed_request/)
  const third = mint(prepare('nav-rebind'))
  grants.rebind(owners)
  assert.throws(() => grants.consumeNavigate(third.id), /stale_grant/)
  const fourth = mint(prepare('nav-retire'))
  assert.equal(grants.retireTransport(), false)
  assert.throws(() => grants.consumeNavigate(fourth.id), /stale_grant/)
  const fifth = mint(prepare('nav-all'))
  grants.revokeAll()
  assert.throws(() => grants.consumeNavigate(fifth.id), /stale_grant/)
})

test('navigate approval waits for a matching grant and cancelling leaves request tombstone', async () => {
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigatePolicy: () => ({ revision: 2, decision: 'ask' }),
  })
  const proof = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'nav-wait',
    tabId: 'tab',
    url: 'https://example.org/path',
    intent: 'Open page',
  })
  const pending = grants.acquireNavigate({
    scope,
    requestId: proof.requestId,
    proofId: proof.proofId,
    tabId: proof.tabId,
  })
  const issued = grants.issueNavigateApproved({
    ...proof,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sourceInstanceId: target.instanceId,
    sourceGeneration: target.generation,
    sourceOrigin: target.origin,
  })
  assert.equal((await pending).id, issued.id)
  const cancelled = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'nav-cancel',
    tabId: 'tab',
    url: 'https://example.org/path',
    intent: 'Open page',
  })
  const waiting = grants.acquireNavigate({
    scope,
    requestId: cancelled.requestId,
    proofId: cancelled.proofId,
    tabId: cancelled.tabId,
  })
  grants.cancelNavigate({ scope, requestId: cancelled.requestId, tabId: cancelled.tabId })
  await assert.rejects(waiting, /stale_grant/)
  assert.throws(
    () =>
      grants.prepareNavigate({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: cancelled.requestId,
        tabId: 'tab',
        url: 'https://example.org/path',
        intent: 'Open page',
      }),
    /replayed_request/
  )
})

test('navigate cancellation revokes only an actually reserved tab and preserves pre-cancel tombstones', () => {
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigatePolicy: () => ({ revision: 1, decision: 'allow' }),
  })
  assert.equal(
    grants.cancelNavigate({ scope, requestId: 'not-prepared', tabId: 'unrelated-tab' }),
    null
  )
  assert.equal(
    grants.cancelNavigate({ scope, requestId: 'not-prepared', tabId: 'unrelated-tab' }),
    null
  )
  assert.throws(
    () =>
      grants.prepareNavigate({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: 'not-prepared',
        tabId: 'unrelated-tab',
        url: 'https://example.org',
        intent: 'Open page',
      }),
    /replayed_request/
  )
  const proof = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'prepared',
    tabId: 'real-tab',
    url: 'https://example.org',
    intent: 'Open page',
  })
  assert.throws(
    () => grants.cancelNavigate({ scope, requestId: proof.requestId, tabId: 'unrelated-tab' }),
    /stale_grant/
  )
  assert.equal(
    grants.cancelNavigate({ scope, requestId: proof.requestId, tabId: proof.tabId }),
    'real-tab'
  )
  assert.equal(
    grants.cancelNavigate({ scope, requestId: proof.requestId, tabId: proof.tabId }),
    null
  )
  assert.throws(() => grants.navigateProof(proof.requestId, proof.proofId), /stale_grant/)
})

test('navigate proof output mutation cannot rewrite retained destination or scope', () => {
  const grants = createBrowserReadGrants({
    scope: () => scope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigatePolicy: () => ({ revision: 2, decision: 'allow' }),
  })
  const proof = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'nav-mutate',
    tabId: 'tab',
    url: 'https://example.org/original',
    intent: 'Open page',
  })
  proof.url = 'https://example.org/changed'
  proof.destinationOrigin = 'https://attacker.example'
  proof.scope.generation += 1
  proof.source.generation += 1
  const original = grants.navigateProof(proof.requestId, proof.proofId)
  assert.equal(original.url, 'https://example.org/original')
  assert.equal(original.destinationOrigin, 'https://example.org')
  assert.equal(original.scope.generation, scope.generation)
  assert.equal(original.source.generation, target.generation)
})

test('closed navigate scopes release request capacity without reviving an old proof', () => {
  let activeScope: typeof scope | null = scope
  const grants = createBrowserReadGrants({
    scope: () => activeScope,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'allow' }),
    navigatePolicy: () => ({ revision: 1, decision: 'allow' }),
  })
  const first = grants.prepareNavigate({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'closed-old',
    tabId: 'tab',
    url: 'https://example.org',
    intent: 'Open page',
  })
  activeScope = null
  grants.revokeScope(scope)
  activeScope = { ...scope, generation: 2 }
  assert.throws(() => grants.navigateProof(first.requestId, first.proofId), /stale_grant/)
  for (let index = 0; index <= REQUEST_LEDGER_CAPACITY; index += 1) {
    const current: typeof scope = activeScope!
    grants.prepareNavigate({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      requestId: `closed-${index}`,
      tabId: 'tab',
      url: 'https://example.org',
      intent: 'Open page',
    })
    activeScope = null
    grants.revokeScope(current)
    activeScope = { ...current, generation: current.generation + 1 }
  }
  assert.equal(
    grants.prepareNavigate({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      requestId: 'after-closure',
      tabId: 'tab',
      url: 'https://example.org',
      intent: 'Open page',
    }).requestId,
    'after-closure'
  )
})

test('cancel before prepare leaves a same-scope tombstone and cannot cancel another tab', () => {
  const fixtureState = fixture()
  assert.equal(
    fixtureState.grants.cancelRead({ scope, requestId: 'cancel-first', tabId: 'tab' }),
    false
  )
  assert.equal(
    fixtureState.grants.cancelRead({ scope, requestId: 'cancel-first', tabId: 'tab' }),
    false
  )
  assert.throws(
    () => fixtureState.grants.cancelRead({ scope, requestId: 'cancel-first', tabId: 'other-tab' }),
    /stale_grant/
  )
  assert.throws(
    () =>
      fixtureState.grants.prepareRead({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        requestId: 'cancel-first',
        tabId: 'tab',
        intent: request.intent,
      }),
    /replayed_request/
  )
  assert.throws(
    () =>
      fixtureState.grants.cancelRead({
        scope: { ...scope, generation: 2 },
        requestId: 'cancel-first',
        tabId: 'tab',
      }),
    /stale_grant/
  )
})

test('cancel after Main approval removes grant and a live read lease without touching another request', async () => {
  const fixtureState = fixture()
  const proof = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'approved-then-cancelled',
    tabId: 'tab',
    intent: request.intent,
  })
  const issued = fixtureState.grants.issueApproved({
    ...request,
    requestId: proof.requestId,
    proofId: proof.proofId,
    expiresAt: proof.expiresAt,
  })
  assert.equal(
    fixtureState.grants.cancelRead({ scope, requestId: proof.requestId, tabId: 'tab' }),
    false
  )
  assert.throws(() => fixtureState.grants.consume(issued.id), /stale_grant/)
  fixtureState.setDecision('allow')
  const other = fixtureState.grants.prepareRead({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    requestId: 'other-live-request',
    tabId: 'tab',
    intent: request.intent,
  })
  const authority = await fixtureState.grants.acquireSnapshot({
    scope,
    requestId: other.requestId,
    proofId: other.proofId,
    tabId: other.tabId,
  })
  assert.equal(
    fixtureState.grants.cancelRead({ scope, requestId: proof.requestId, tabId: 'tab' }),
    false
  )
  assert.equal(fixtureState.grants.validateAuthority(authority), true)
  assert.equal(
    fixtureState.grants.cancelRead({ scope, requestId: other.requestId, tabId: 'tab' }),
    true
  )
  assert.equal(fixtureState.grants.validateAuthority(authority), false)
})

async function startScope(transport: AgentTransport, generation: number): Promise<number> {
  const body = JSON.stringify({
    session_id: scope.sessionId,
    instance_id: scope.instanceId,
    product_turn_id: scope.productTurnId,
    turn_id: scope.turnId,
    generation,
    interrupt_generation: scope.interruptGeneration,
    lifecycle_epoch: generation,
    action: 'scope/start',
    deadline: Date.now() + 5_000,
  })
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        hostname: '127.0.0.1',
        port: transport.port,
        path: '/agent/browser',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${transport.port}`,
          'X-ScholarSeed-Agent-Key': transport.key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      }
    )
    call.on('error', reject)
    call.end(body)
  })
}

test('closed transport rejects old key and repeated backend epochs reclaim request capacity', async () => {
  let transport: AgentTransport | null = null
  const grants = createBrowserReadGrants({
    scope: (sessionId, turnId) => transport?.activeScope(sessionId, turnId) ?? null,
    target: () => target,
    policy: () => ({ revision: 1, decision: 'ask' }),
  })
  try {
    for (let generation = 1; generation <= 3; generation += 1) {
      transport = await createAgentTransport(() => [])
      assert.equal(await startScope(transport, generation), 200)
      if (generation === 1) {
        for (let index = 0; index < REQUEST_LEDGER_CAPACITY; index += 1) {
          const issued = issue(grants, { ...request, requestId: `capacity-${index}` })
          grants.consume(issued.id)
        }
        assert.throws(
          () => issue(grants, { ...request, requestId: 'overflow' }),
          /grant_capacity_exhausted/
        )
      }
      const issued =
        generation === 1 ? null : issue(grants, { ...request, requestId: `request-${generation}` })
      const oldTransport = transport
      await oldTransport.close()
      transport = null
      await assert.rejects(startScope(oldTransport, generation))
      assert.equal(grants.retireTransport(), true)
      if (issued) assert.throws(() => grants.consume(issued.id), /stale_grant/)
    }
    transport = await createAgentTransport(() => [])
    assert.equal(await startScope(transport, 4), 200)
    assert.equal(issue(grants, request).requestId, request.requestId)
  } finally {
    await transport?.close()
  }
})
