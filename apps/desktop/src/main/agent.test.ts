import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron } from '@playwright/test'
import { build } from 'esbuild'
import { agentFailureCode, createAgentBrowserController as createController } from './agent.ts'
import type { BrowserRegistry } from './browser.ts'
import type { BrowserNavigateGrant, BrowserNavigateProof } from './grant.ts'
import type { WebContents } from 'electron'
import type { AgentBrowserPort, AgentPage, AgentPreparedAction } from './agent.ts'

const MIN_EFFECT_QUIET_ASSERT_MS = 350
const EXPIRED_OBSERVATION_OFFSET_MS = 11_000
const BODY_COLOR_CASES = ['body-color-link', 'body-color-LINK', 'body-color-vlink', 'body-color-alink', 'body-color-text', 'body-color-bgcolor'] as const

for (const invalidation of ['expiry', 'replacement-snapshot', 'controlled-release', 'external-detach', 'continuity-instance',
  'continuity-gap', 'continuity-previous', 'continuity-replay', 'revoke', 'document', 'scope', 'policy', 'fence',
  'renewed', 'name', 'id', 'formaction', 'ancestor-id', 'ancestor-order', 'ancestor-other',
  ...BODY_COLOR_CASES, 'body-background', 'nonbody-link', 'unapproved', 'reused-grant', 'cancelled'] as const) {
test(`expired observation requests fresh read authority only for pure expiry: ${invalidation}`, async (context) => {
    const diagnostic = context.mock.method(console, 'info', () => {})
    let attached = false
    let generation = 1
    let policyCurrent = true
    let changedAttribute: string | null = null
    const presentationChange = invalidation.startsWith('body-color-')
    const ancestorChange = invalidation.startsWith('ancestor-') || presentationChange
      || invalidation === 'body-background' || invalidation === 'nonbody-link'
    const revalidating = ancestorChange || ['renewed', 'name', 'id', 'formaction', 'unapproved', 'reused-grant', 'cancelled'].includes(invalidation)
    const fence = new Set<string>()
    let detached!: Parameters<AgentBrowserPort['onDebuggerDetach']>[0]
    const commands: string[] = []
    const contents = { debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string, params?: { backendNodeId?: number }) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'DOM.describeNode' && ancestorChange && params?.backendNodeId === 1) {
          const pairs = [['id', invalidation === 'ancestor-id' && changedAttribute ? 'private-query' : 'original'],
            [invalidation === 'ancestor-other' ? 'data-private-query' : 'role',
              invalidation === 'ancestor-other' && changedAttribute ? 'private-query' : 'presentation']]
          if (changedAttribute && (presentationChange || invalidation === 'body-background' || invalidation === 'nonbody-link'))
            pairs.push([presentationChange ? invalidation.slice('body-color-'.length)
              : invalidation === 'body-background' ? 'background' : 'link', '#0000cc'])
          return { node: { nodeName: invalidation === 'nonbody-link' ? 'DIV'
            : invalidation === 'body-color-link' ? 'body' : 'BODY', attributes: (invalidation === 'ancestor-order' && changedAttribute
            ? pairs.reverse() : pairs).flat() } }
        }
        if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'text',
          ...(changedAttribute && !ancestorChange ? [changedAttribute, 'changed'] : [])] } }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [
          { nodeId: 'root', frameId: 'top', backendDOMNodeId: ancestorChange ? 1 : undefined,
            role: { value: 'RootWebArea' }, name: { value: 'Page' } },
          { nodeId: 'field', parentId: 'root', backendDOMNodeId: 2,
            role: { value: 'textbox' }, name: { value: 'Search' } },
        ] }
        return {}
      },
    }, isDestroyed: () => false, getTitle: () => 'Page' } as unknown as WebContents
    const registry = {
      agentTarget: () => ({ contents, origin: 'https://example.org', generation, instanceId: 'instance',
        title: 'Page', url: 'https://example.org/' }),
      attach: () => {
        if (attached) throw new Error('cdp_busy')
        attached = true
        return contents
      },
      detach: () => {
        attached = false
        if (invalidation === 'replacement-snapshot') {
          const previousGeneration = generation++
          detached('tab', 'target_closed', { instanceId: 'instance', previousGeneration, generation })
        }
      },
      onDebuggerDetach: (listener: Parameters<AgentBrowserPort['onDebuggerDetach']>[0]) => {
        detached = listener
        return () => {}
      },
      cancelAgentNavigation: () => {},
    } as unknown as BrowserRegistry
    const controller = createAgentBrowserController(registry, {
      validateAuthority: authority => authority.grantId === 'grant'
        || authority.grantId === 'renewed-grant' && invalidation !== 'unapproved',
      validateActionPolicy: () => policyCurrent, actionFence: fence })
    const originalNow = Date.now
    try {
      const authority = testAuthority()
      let snapshot = await controller.snapshot(authority)
      if (invalidation === 'replacement-snapshot') snapshot = await controller.snapshot(authority)
      if (invalidation === 'controlled-release' || invalidation === 'external-detach') {
        const previousGeneration = generation++
        attached = false
        detached('tab', 'target_closed', invalidation === 'controlled-release'
          ? { instanceId: 'instance', previousGeneration, generation } : undefined)
      }
      if (invalidation.startsWith('continuity-')) {
        const previousGeneration = generation
        generation += invalidation === 'continuity-gap' ? 2 : 1
        attached = false
        const continuity = {
          instanceId: invalidation === 'continuity-instance' ? 'replacement' : 'instance',
          previousGeneration: invalidation === 'continuity-previous' ? previousGeneration - 1 : previousGeneration,
          generation,
        }
        detached('tab', 'target_closed', continuity)
        if (invalidation === 'continuity-replay') detached('tab', 'target_closed', continuity)
      }
      if (invalidation === 'revoke') controller.revoke('tab')
      if (invalidation === 'document') generation += 1
      if (invalidation === 'policy') policyCurrent = false
      if (invalidation === 'fence') fence.add(JSON.stringify([
        authority.scope.sessionId, authority.scope.instanceId, authority.scope.productTurnId,
        authority.scope.turnId, authority.scope.generation, authority.scope.interruptGeneration,
        authority.scope.lifecycleEpoch,
      ]))
      Date.now = () => originalNow() + EXPIRED_OBSERVATION_OFFSET_MS
      await assert.rejects(controller.read({ ...authority, snapshotId: snapshot.snapshotId,
        elementRef: snapshot.elements[1].ref }), /stale_ref/)
      assert.throws(() => controller.prepareAction({ scope: invalidation === 'scope'
        ? { ...authority.scope, turnId: 'other-turn' } : authority.scope,
        requestId: 'expired-action', tabId: 'tab', snapshotId: snapshot.snapshotId,
        elementRef: snapshot.elements[1].ref, action: 'fill', value: 'ScholarSeed', intent: 'Fill query' }),
      invalidation === 'expiry' || invalidation === 'replacement-snapshot' || invalidation === 'controlled-release' || revalidating
        ? /observation_read_required/ : /stale_ref|stale_grant/)
      if (revalidating) {
        if (['name', 'id', 'formaction'].includes(invalidation) || ancestorChange) changedAttribute = invalidation
        const renewed = invalidation === 'reused-grant' ? authority
          : { ...authority, grantId: 'renewed-grant', grantRequestId: 'renewed-read' }
        const cancellation = new AbortController()
        if (invalidation === 'cancelled') cancellation.abort()
        const prepared = controller.prepareObservedAction({ ...renewed,
          signal: cancellation.signal,
          requestId: 'revalidated-action', snapshotId: snapshot.snapshotId,
          elementRef: snapshot.elements[1].ref, action: 'fill', value: 'ScholarSeed', intent: 'Fill query' })
        if (invalidation === 'renewed' || presentationChange) {
          const proof = await prepared
          assert.equal(proof.grantId, renewed.grantId)
          assert.equal(proof.snapshotId, snapshot.snapshotId)
          assert.equal(JSON.stringify(proof).includes('ScholarSeed'), false)
          assert.throws(() => controller.prepareInteract({ ...renewed,
            requestId: 'bypass-interact', snapshotId: snapshot.snapshotId,
            elementRef: snapshot.elements[1].ref, action: 'fill', value: 'ScholarSeed', intent: 'Fill query' }), /stale_ref/)
          assert.throws(() => controller.prepareSubmit({ ...renewed,
            requestId: 'bypass-submit', snapshotId: snapshot.snapshotId,
            elementRef: snapshot.elements[1].ref, intent: 'Submit query' }), /stale_ref/)
          await assert.rejects(controller.read({ ...renewed, snapshotId: snapshot.snapshotId,
            elementRef: snapshot.elements[1].ref }), /stale_ref/)
        } else await assert.rejects(prepared, /stale_ref|stale_grant|request_expired/)
        if (invalidation.startsWith('ancestor-')) {
          const changed = diagnostic.mock.calls.find(call => call.arguments[0] === '[browser-agent] observation attributes changed')
          assert.ok(changed)
          const details = JSON.parse(changed.arguments[1] as string)
          assert.equal(details.nodeKind, 'body')
          assert.deepEqual(details.changedAttributes, invalidation === 'ancestor-order' ? []
            : [invalidation === 'ancestor-id' ? 'id' : 'other'])
          assert.equal(details.attributeOrderOnly, invalidation === 'ancestor-order')
          assert.equal(details.targetNode, false)
          assert.equal(JSON.stringify(diagnostic.mock.calls).includes('private-query'), false)
        }
      }
      assert.equal(commands.some(method => method.startsWith('Input.')), false)
    } finally { Date.now = originalNow; controller.dispose() }
})
}

test('disposed Agent cannot attest a settled or locally frozen scope', async () => {
  for (const frozen of [false, true]) {
    const scope = testAuthority().scope
    const fence = new Set<string>(frozen ? [JSON.stringify([
      scope.sessionId, scope.instanceId, scope.productTurnId, scope.turnId,
      scope.generation, scope.interruptGeneration, scope.lifecycleEpoch,
    ])] : [])
    const controller = createAgentBrowserController({
      onDebuggerDetach: () => () => {}, detach: () => {},
    } as unknown as BrowserRegistry, { validateAuthority: () => true, actionFence: fence })
    assert.equal(await controller.waitForEffects(scope), !frozen)
    controller.dispose()
    await assert.rejects(controller.waitForEffects(scope), /target_closed/)
    assert.equal(fence.size, frozen ? 1 : 0)
  }
})

test('Agent diagnostics preserve only fixed failure codes and never arbitrary exception text', () => {
  assert.equal(agentFailureCode(new Error('approval_required')), 'approval_required')
  assert.equal(agentFailureCode(new Error('snapshot_timeout')), 'snapshot_timeout')
  assert.equal(agentFailureCode(new Error('non_interactive_ref')), 'non_interactive_ref')
  assert.equal(agentFailureCode(new Error('submit_requires_approval')), 'submit_requires_approval')
  assert.equal(agentFailureCode(new Error('cross_frame_denied')), 'cross_frame_denied')
  assert.equal(agentFailureCode(new Error('private query or token must not be logged')), 'operation_failed')
  assert.equal(agentFailureCode({ message: 'stale_action' }), 'operation_failed')
})

interface BrowserFixture {
  ready: Promise<void>
  registry: BrowserRegistry
  agent: ReturnType<typeof createController>
}

function createAgentBrowserController(
  ...args: Parameters<typeof createController>
): ReturnType<typeof createController> {
  const registry = args[0]
  if (!registry.detachAgent) registry.detachAgent = registry.detach
  return createController(...args)
}

function visibleDomCommand(method: string): unknown {
  if (method === 'DOM.describeNode')
    return { node: { nodeName: 'H1', nodeType: 1, attributes: [] } }
  return undefined
}

function testAuthority(grantRevision = 1, tabId = 'tab') {
  return {
    tabId,
    grantRevision,
    grantId: 'grant',
    grantRequestId: 'request',
    scope: {
      sessionId: 'session',
      instanceId: 'instance',
      productTurnId: 'product-turn',
      turnId: 'turn',
      generation: 1,
      interruptGeneration: 0,
      lifecycleEpoch: 1,
    },
  }
}

function actionEvidence(prepared: AgentPreparedAction, approvalId: string) {
  return {
    preparedId: prepared.id,
    proofId: prepared.proofId,
    approvalId,
    requestId: prepared.requestId,
    scope: prepared.scope,
    tabId: prepared.tabId,
    target: prepared.target,
    snapshotId: prepared.snapshotId,
    elementRef: prepared.elementRef,
    backendNodeId: prepared.backendNodeId,
    grantId: prepared.grantId,
    grantRequestId: prepared.grantRequestId,
    grantRevision: prepared.grantRevision,
    revocationEpoch: prepared.revocationEpoch,
    action: prepared.action,
    intent: prepared.intent,
    expiresAt: prepared.expiresAt,
  }
}

function navigateProof(requestId = 'navigate-request'): BrowserNavigateProof {
  return {
    proofId: 'navigate-proof',
    requestId,
    scope: testAuthority().scope,
    tabId: 'tab',
    source: { instanceId: 'target-instance', generation: 4, origin: 'https://example.org' },
    url: 'https://www.iana.org/',
    destinationOrigin: 'https://www.iana.org',
    intent: 'Open reference',
    expiresAt: Date.now() + 30_000,
    policyRevision: 2,
    policyDecision: 'ask',
  }
}

test('controller accepts a protocol-backed page without Electron WebContents', () => {
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async () => ({}),
  })
  const page = {
    debugger: debuggerSession,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getTitle: () => 'Protocol page',
  } satisfies AgentPage
  const registry = {
    agentTarget: () => ({
      contents: page,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'protocol-target',
      title: 'Protocol page',
      url: 'https://example.org/',
    }),
    agentNavigationTarget: () => ({
      contents: page,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'protocol-target',
      title: 'Protocol page',
      url: 'https://example.org/',
    }),
    agentNavigate: async () => undefined,
    blockAgentPopups: () => () => undefined,
    cancelAgentNavigation: () => undefined,
    attach: () => page,
    detach: () => undefined,
    detachAgent: () => undefined,
    onDebuggerDetach: () => () => undefined,
  } satisfies AgentBrowserPort
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    assert.equal(controller.targetProof('tab').instanceId, 'protocol-target')
  } finally {
    controller.dispose()
  }
})

test('navigation grant survives its own target invalidation and cannot be replayed', async () => {
  let generation = 4
  let instanceId = 'target-instance'
  let currentUrl = 'https://example.org/'
  let finishNavigation!: () => void
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  const pendingLoad = new Promise<void>((resolve) => {
    finishNavigation = resolve
  })
  let cancelled = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      started()
      await pendingLoad
      currentUrl = url
      generation += 1
      instanceId = 'swapped-instance'
    },
    cancelAgentNavigation: () => {
      cancelled += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  const proof = navigateProof()
  const grant: BrowserNavigateGrant = { ...proof, id: 'navigate-grant', action: 'navigate' }
  try {
    controller.prepareNavigate(proof)
    const running = controller.executeNavigate(grant)
    await startedPromise
    generation += 1
    finishNavigation()
    await running
    assert.equal(cancelled, 0)
    await assert.rejects(controller.executeNavigate(grant), /stale|replay/)
  } finally {
    controller.dispose()
  }
})

test('read lease binds every scope field and opaque grant identity', async () => {
  let attached = false
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        const dom = visibleDomCommand(method)
        if (dom !== undefined) return dom
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'heading',
              parentId: 'root',
              backendDOMNodeId: 2,
              role: { value: 'heading' },
              name: { value: 'Public heading' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'target',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    for (const variant of [
      { scope: { instanceId: 'other' } },
      { scope: { productTurnId: 'other' } },
      { scope: { turnId: 'other' } },
      { scope: { generation: 2 } },
      { scope: { interruptGeneration: 1 } },
      { scope: { lifecycleEpoch: 2 } },
      { grantId: 'other' },
      { grantRequestId: 'other' },
    ]) {
      const authority = testAuthority()
      const snapshot = await controller.snapshot(authority)
      const changed = { ...authority, ...variant, scope: { ...authority.scope, ...variant.scope } }
      await assert.rejects(
        controller.read({
          ...changed,
          snapshotId: snapshot.snapshotId,
          elementRef: snapshot.elements[1].ref,
        }),
        /stale_ref/
      )
    }
    const authority = testAuthority()
    const snapshot = await controller.snapshot(authority)
    authority.scope.lifecycleEpoch += 1
    await assert.rejects(
      controller.read({
        ...authority,
        snapshotId: snapshot.snapshotId,
        elementRef: snapshot.elements[1].ref,
      }),
      /stale_ref/
    )
  } finally {
    controller.dispose()
  }
})

test('scope end preserves other read leases and prepared actions while draining its own', async () => {
  const detached: string[] = []
  const contents = {
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        const dom = visibleDomCommand(method)
        if (dom !== undefined) return dom
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'heading',
              parentId: 'root',
              backendDOMNodeId: 2,
              role: { value: 'heading' },
              name: { value: 'Public heading' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'target',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => contents,
    detachAgent: (tabId: string) => {
      detached.push(tabId)
    },
    cancelAgentNavigation: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const authority = testAuthority(1, 'tab-b')
  const ending = {
    ...testAuthority(1, 'tab-a'),
    scope: { ...authority.scope, sessionId: 'session-a' },
  }
  try {
    const first = await controller.snapshot(ending)
    const second = await controller.snapshot(authority)
    const action = controller.prepareInteract({
      ...authority,
      requestId: 'action-b',
      snapshotId: second.snapshotId,
      elementRef: second.elements[1].ref,
      action: 'click',
      intent: 'Open public heading',
    })
    const endingAction = controller.prepareInteract({
      ...ending,
      requestId: 'action-a',
      snapshotId: first.snapshotId,
      elementRef: first.elements[1].ref,
      action: 'click',
      intent: 'Open public heading',
    })
    for (const variant of [
      { sessionId: 'other' },
      { instanceId: 'other' },
      { productTurnId: 'other' },
      { turnId: 'other' },
      { generation: 2 },
      { interruptGeneration: 1 },
      { lifecycleEpoch: 2 },
      ending.scope,
    ]) {
      controller.revoke('tab-b', { ...authority.scope, ...variant })
      assert.equal(
        (
          await controller.read({
            ...authority,
            snapshotId: second.snapshotId,
            elementRef: second.elements[1].ref,
          })
        ).name,
        'Public heading'
      )
      assert.equal(controller.actionProof(action.requestId, action.proofId).id, action.id)
    }
    controller.revoke('tab-a', ending.scope)
    controller.revoke('tab-a', ending.scope)
    await assert.rejects(
      controller.read({
        ...ending,
        snapshotId: first.snapshotId,
        elementRef: first.elements[1].ref,
      }),
      /stale_ref/
    )
    assert.throws(
      () => controller.actionProof(endingAction.requestId, endingAction.proofId),
      /stale_action/
    )
    assert.deepEqual(detached, ['tab-a'])
    controller.revoke('tab-b')
    await assert.rejects(
      controller.read({
        ...authority,
        snapshotId: second.snapshotId,
        elementRef: second.elements[1].ref,
      }),
      /stale_ref/
    )
    assert.throws(() => controller.actionProof(action.requestId, action.proofId), /stale_action/)
  } finally {
    controller.dispose()
  }
})

test('scope end cancels only its issued navigation and preserves another prepared navigation', async () => {
  const cancelled: string[] = []
  const targets = new Map<string, { url: string; instanceId: string }>()
  const releases = new Map<string, () => void>()
  const contents = { isDestroyed: () => false, getTitle: () => 'Page' } as unknown as WebContents
  const target = (tabId: string) => {
    const state = targets.get(tabId) ?? {
      url: 'https://example.org/',
      instanceId: 'target-instance',
    }
    return {
      contents,
      origin: new URL(state.url).origin,
      generation: 4,
      instanceId: state.instanceId,
      title: 'Page',
      url: state.url,
    }
  }
  const registry = {
    agentTarget: target,
    agentNavigationTarget: target,
    agentNavigate: async (tabId: string, url: string) => {
      await new Promise<void>((resolve) => {
        releases.set(tabId, resolve)
      })
      targets.set(tabId, { url, instanceId: `new-${tabId}` })
    },
    cancelAgentNavigation: (tabId: string) => {
      cancelled.push(tabId)
    },
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const first = { ...navigateProof('scope-a'), tabId: 'tab-a' }
  const second = {
    ...navigateProof('scope-b'),
    tabId: 'tab-b',
    scope: { ...first.scope, sessionId: 'session-b' },
  }
  const prepared = { ...navigateProof('scope-b-prepared'), tabId: 'tab-c', scope: second.scope }
  const endingPrepared = { ...navigateProof('scope-a-prepared'), tabId: 'tab-d' }
  try {
    for (const proof of [first, second, prepared, endingPrepared]) controller.prepareNavigate(proof)
    const activeFirst = controller.executeNavigate({ ...first, id: 'grant-a', action: 'navigate' })
    const firstRejected = assert.rejects(activeFirst, /stale_action/)
    const activeSecond = controller.executeNavigate({
      ...second,
      id: 'grant-b',
      action: 'navigate',
    })
    for (const tabId of ['tab-a', 'tab-b', 'tab-c', 'tab-d']) controller.revoke(tabId, first.scope)
    controller.revoke('tab-b', { ...second.scope, lifecycleEpoch: 0 })
    assert.deepEqual(cancelled, ['tab-a'])
    releases.get('tab-a')!()
    releases.get('tab-b')!()
    await firstRejected
    await activeSecond
    await assert.rejects(
      controller.executeNavigate({ ...endingPrepared, id: 'grant-d', action: 'navigate' }),
      /stale_action/
    )
    const last = controller.executeNavigate({ ...prepared, id: 'grant-c', action: 'navigate' })
    releases.get('tab-c')!()
    await last
    controller.revoke('tab-b', first.scope)
    assert.deepEqual(cancelled, ['tab-a'])
  } finally {
    for (const release of releases.values()) release()
    controller.dispose()
  }
})

test('read lease revalidates live grant across scope, policy, target and awaited CDP', async () => {
  let attached = false
  let scopeActive = true
  let grantActive = true
  let policyRevision = 1
  let grantId = 'grant'
  let generation = 1
  let holdRead = false
  let releaseRead: (() => void) | undefined
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        const dom = visibleDomCommand(method)
        if (dom !== undefined) return dom
        if (method === 'Accessibility.getFullAXTree' && holdRead) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve
          })
        }
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'heading',
              parentId: 'root',
              backendDOMNodeId: 2,
              role: { value: 'heading' },
              name: { value: 'Public heading' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation,
      instanceId: 'target',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) =>
      scopeActive &&
      grantActive &&
      authority.grantId === grantId &&
      authority.grantRevision === policyRevision,
  })
  const authority = testAuthority()
  try {
    let snapshot = await controller.snapshot(authority)
    const read = () =>
      controller.read({
        ...authority,
        snapshotId: snapshot.snapshotId,
        elementRef: snapshot.elements[1].ref,
      })
    scopeActive = false
    await assert.rejects(read(), /stale_grant/)
    scopeActive = true
    grantActive = false
    await assert.rejects(read(), /stale_grant/)
    grantActive = true
    policyRevision = 2
    await assert.rejects(read(), /stale_grant/)
    policyRevision = 1
    grantId = 'replacement'
    await assert.rejects(read(), /stale_grant/)
    grantId = 'grant'
    generation = 2
    await assert.rejects(read(), /stale_ref/)
    generation = 1
    snapshot = await controller.snapshot(authority)
    holdRead = true
    const pending = read()
    await new Promise((resolve) => setImmediate(resolve))
    grantActive = false
    releaseRead?.()
    await assert.rejects(pending, /stale_grant/)
  } finally {
    controller.dispose()
  }
})

test('controller refuses unavailable read authority before snapshot', async () => {
  let attached = false
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    debugger: { isAttached: () => attached },
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    agentNavigate: async () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const authority = testAuthority()
  assert.throws(() => createAgentBrowserController(registry), /authority_unavailable/)
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    await assert.rejects(controller.snapshot(authority), /stale_grant/)
    assert.equal(attached, false)
  } finally {
    controller.dispose()
  }
})

test('prepared actions expire without permanently exhausting request capacity', () => {
  const contents = { isDestroyed: () => false } as unknown as WebContents
  const registry = {
    agentNavigationTarget: () => ({
      contents,
      origin: null,
      generation: 1,
      instanceId: 'instance',
      title: '',
      url: 'about:blank',
    }),
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    for (let index = 0; index < 64; index += 1)
      controller.prepareNavigate({
        ...navigateProof(`expired-${index}`),
        source: { instanceId: 'instance', generation: 1, origin: null },
      })
    now += 31_000
    controller.prepareNavigate({
      ...navigateProof('expired-0'),
      source: { instanceId: 'instance', generation: 1, origin: null },
    })
    controller.prepareNavigate({
      ...navigateProof('next'),
      source: { instanceId: 'instance', generation: 1, origin: null },
    })
  } finally {
    Date.now = originalNow
    controller.dispose()
  }
})

test('prepared navigation binds target proof and consumes navigate grant exactly once', async () => {
  let generation = 4
  let instanceId = 'instance-1'
  let navigated = ''
  let currentUrl = 'https://example.org/'
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => 'https://example.org/',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      navigated = url
      currentUrl = url
      generation += 1
      instanceId = 'instance-2'
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const proof = {
      ...navigateProof('request-1'),
      source: { instanceId: 'instance-1', generation: 4, origin: 'https://example.org' },
    }
    controller.prepareNavigate(proof)
    await controller.executeNavigate({ ...proof, id: 'approval-1', action: 'navigate' })
    assert.equal(navigated, 'https://www.iana.org/')
    await assert.rejects(
      controller.executeNavigate({ ...proof, id: 'approval-1', action: 'navigate' }),
      /replayed|stale/
    )
  } finally {
    controller.dispose()
  }
})

test('cancelling one prepared navigation preserves another request on the same tab', async () => {
  let instanceId = 'target-instance'
  let currentUrl = 'https://example.org/'
  let cancellations = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      currentUrl = url
      instanceId = 'swapped-instance'
    },
    cancelAgentNavigation: () => {
      cancellations += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const first = navigateProof('prepared-first')
    const second = navigateProof('prepared-second')
    controller.prepareNavigate(first)
    controller.prepareNavigate(second)
    controller.cancelNavigate(first.requestId, first.tabId)
    await assert.rejects(
      controller.executeNavigate({ ...first, id: 'first-grant', action: 'navigate' }),
      /stale_action/
    )
    await controller.executeNavigate({ ...second, id: 'second-grant', action: 'navigate' })
    assert.equal(cancellations, 0)
  } finally {
    controller.dispose()
  }
})

test('late cancellation of a completed request does not abort the next active navigation', async () => {
  let currentUrl = 'https://example.org/'
  let instanceId = 'target-instance'
  let finishSecond!: () => void
  let startSecond!: () => void
  const secondStarted = new Promise<void>((resolve) => {
    startSecond = resolve
  })
  const secondLoad = new Promise<void>((resolve) => {
    finishSecond = resolve
  })
  let cancellations = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      if (instanceId !== 'target-instance') {
        startSecond()
        await secondLoad
      }
      currentUrl = url
      instanceId =
        instanceId === 'target-instance' ? 'first-swapped-instance' : 'second-swapped-instance'
    },
    cancelAgentNavigation: () => {
      cancellations += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const first = navigateProof('completed-first')
    controller.prepareNavigate(first)
    await controller.executeNavigate({ ...first, id: 'first-grant', action: 'navigate' })
    const second = {
      ...navigateProof('active-second'),
      source: {
        instanceId: 'first-swapped-instance',
        generation: 4,
        origin: 'https://www.iana.org',
      },
    }
    controller.prepareNavigate(second)
    const pending = controller.executeNavigate({
      ...second,
      id: 'second-grant',
      action: 'navigate',
    })
    await secondStarted
    controller.cancelNavigate(first.requestId, first.tabId)
    finishSecond()
    await pending
    assert.equal(cancellations, 0)
  } finally {
    controller.dispose()
  }
})

test('request-scoped cancellation aborts only its active load and waits for the idle fence', async () => {
  let finishLoad!: () => void
  let loadStarted!: () => void
  const started = new Promise<void>((resolve) => {
    loadStarted = resolve
  })
  const load = new Promise<void>((resolve) => {
    finishLoad = resolve
  })
  let cancellations = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => 'https://example.org/',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 4,
      instanceId: 'target-instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 4,
      instanceId: 'target-instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigate: async () => {
      loadStarted()
      await load
    },
    cancelAgentNavigation: () => {
      cancellations += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const proof = navigateProof('active-cancel')
    controller.prepareNavigate(proof)
    const pending = controller.executeNavigate({ ...proof, id: 'cancel-grant', action: 'navigate' })
    let settled = false
    void pending
      .finally(() => {
        settled = true
      })
      .catch(() => {})
    await started
    controller.cancelNavigate(proof.requestId, proof.tabId)
    assert.equal(cancellations, 1)
    await Promise.resolve()
    assert.equal(settled, false)
    finishLoad()
    await assert.rejects(pending, /stale_action/)
  } finally {
    controller.dispose()
  }
})

test('disposing during an active navigation cancels its load and cannot report a late success', async () => {
  let finishLoad!: () => void
  let loadStarted!: () => void
  const started = new Promise<void>((resolve) => {
    loadStarted = resolve
  })
  const load = new Promise<void>((resolve) => {
    finishLoad = resolve
  })
  let cancellations = 0
  let currentUrl = 'https://example.org/'
  let instanceId = 'target-instance'
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      loadStarted()
      await load
      currentUrl = url
      instanceId = 'late-swapped-instance'
    },
    cancelAgentNavigation: () => {
      cancellations += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  const proof = navigateProof('dispose-active')
  controller.prepareNavigate(proof)
  const pending = controller.executeNavigate({ ...proof, id: 'dispose-grant', action: 'navigate' })
  await started
  controller.dispose()
  assert.equal(cancellations, 1)
  finishLoad()
  await assert.rejects(pending, /stale_action/)
})

test('the same tab refuses a second active navigation until the first settles', async () => {
  let finishLoad!: () => void
  let loadStarted!: () => void
  const started = new Promise<void>((resolve) => {
    loadStarted = resolve
  })
  const load = new Promise<void>((resolve) => {
    finishLoad = resolve
  })
  let navigations = 0
  let currentUrl = 'https://example.org/'
  let instanceId = 'target-instance'
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 4,
      instanceId,
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      navigations += 1
      loadStarted()
      await load
      currentUrl = url
      instanceId = 'swapped-instance'
    },
    cancelAgentNavigation: () => {},
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const first = navigateProof('active-first')
    const second = navigateProof('active-second')
    controller.prepareNavigate(first)
    controller.prepareNavigate(second)
    const pending = controller.executeNavigate({ ...first, id: 'first-grant', action: 'navigate' })
    await started
    await assert.rejects(
      controller.executeNavigate({ ...second, id: 'second-grant', action: 'navigate' }),
      /cdp_busy/
    )
    finishLoad()
    await pending
    assert.equal(navigations, 1)
  } finally {
    controller.dispose()
  }
})

test('a navigation that keeps the original target instance cannot claim success', async () => {
  let currentUrl = 'https://example.org/'
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => currentUrl,
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 5,
      instanceId: 'unchanged-instance',
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: new URL(currentUrl).origin,
      generation: 5,
      instanceId: 'unchanged-instance',
      title: 'Page',
      url: currentUrl,
    }),
    agentNavigate: async (_tabId: string, url: string) => {
      currentUrl = url
    },
    cancelAgentNavigation: () => {},
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const proof = {
      ...navigateProof('no-swap'),
      source: { instanceId: 'unchanged-instance', generation: 5, origin: 'https://example.org' },
    }
    controller.prepareNavigate(proof)
    await assert.rejects(
      controller.executeNavigate({ ...proof, id: 'no-swap-grant', action: 'navigate' }),
      /stale_target/
    )
  } finally {
    controller.dispose()
  }
})

test('blank registered tab can prepare navigation but cannot expose a page snapshot', async () => {
  const contents = {
    isDestroyed: () => false,
    getTitle: () => '',
    getURL: () => 'about:blank',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => {
      throw new Error('permission_denied')
    },
    agentNavigationTarget: () => ({
      contents,
      origin: null,
      generation: 2,
      instanceId: 'blank-instance',
      title: '',
      url: 'about:blank',
    }),
    agentNavigate: async () => {},
    cancelAgentNavigation: () => {},
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    controller.prepareNavigate({
      ...navigateProof('blank-nav'),
      tabId: 'blank',
      source: { instanceId: 'blank-instance', generation: 2, origin: null },
    })
    await assert.rejects(controller.snapshot(testAuthority(1, 'blank')), /permission_denied/)
  } finally {
    controller.dispose()
  }
})

test('prepared navigation rejects changed target, revision and expired grant without dispatch', async () => {
  let generation = 4
  let revision = 2
  let navigations = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => 'https://example.org/',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation,
      instanceId: 'instance-1',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation,
      instanceId: 'instance-1',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigate: async () => {
      navigations += 1
    },
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => false })
  try {
    const prepared = {
      ...navigateProof('stale-request'),
      source: { instanceId: 'instance-1', generation: 4, origin: 'https://example.org' },
    }
    controller.prepareNavigate(prepared)
    generation += 1
    await assert.rejects(
      controller.executeNavigate({ ...prepared, id: 'a1', action: 'navigate' }),
      /stale/
    )
    const revoked = {
      ...navigateProof('revoked-request'),
      source: { instanceId: 'instance-1', generation: 5, origin: 'https://example.org' },
    }
    controller.prepareNavigate(revoked)
    revision += 1
    await assert.rejects(
      controller.executeNavigate({
        ...revoked,
        id: 'a2',
        action: 'navigate',
        policyRevision: revision,
      }),
      /stale/
    )
    assert.equal(navigations, 0)
  } finally {
    controller.dispose()
  }
})

test('fill tolerates focus presentation updates but rejects security attribute changes', async () => {
  for (const changedAttributes of [['style', 'height: 28px;', 'class', 'focused'], ['hidden', ''], ['type', 'password']]) {
    let attached = false
    let focused = false
    let inserted = false
    const contents = { debugger: Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [
          { nodeId: 'root', frameId: 'top', role: { value: 'RootWebArea' }, name: { value: 'Page' } },
          { nodeId: 'input', parentId: 'root', backendDOMNodeId: 42,
            role: { value: 'textbox' }, name: { value: 'Query' } },
        ] }
        if (method === 'DOM.describeNode') return { node: { nodeName: 'TEXTAREA', nodeType: 1,
          attributes: focused ? changedAttributes : [] } }
        if (method === 'DOM.focus') focused = true
        if (method === 'Input.insertText') inserted = true
        return {}
      },
    }), isDestroyed: () => false, getTitle: () => 'Page' } as unknown as WebContents
    const registry = {
      agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
        instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
      attach: () => { attached = true; return contents },
      detachAgent: () => { attached = false }, onDebuggerDetach: () => () => {},
      cancelAgentNavigation: () => {}, blockAgentPopups: () => () => {},
    } as unknown as BrowserRegistry
    const controller = createController(registry, { validateAuthority: () => true })
    try {
      const authority = testAuthority()
      const snapshot = await controller.snapshot(authority)
      const proof = controller.prepareInteract({ ...authority, requestId: 'fill-presentation',
        snapshotId: snapshot.snapshotId, elementRef: snapshot.elements[1].ref,
        action: 'fill', value: 'public query', intent: 'Fill search field' })
      const execution = controller.execute(actionEvidence(proof, 'presentation-approval'))
      if (changedAttributes[0] === 'style') {
        await execution
        assert.equal(inserted, true)
      } else {
        await assert.rejects(execution, /action_outcome_unknown/)
        assert.equal(inserted, false)
      }
    } finally { controller.dispose() }
  }
})

test('prepared fill uses only fixed DOM and Input commands and consumes one approval', async () => {
  let attached = false
  let interactBlocked = false
  let effectSettledAt = 0
  let popupBlocks = 0
  let inputStarted!: () => void
  let finishInput!: () => void
  const enteredInput = new Promise<void>((resolve) => {
    inputStarted = resolve
  })
  const pendingInput = new Promise<void>((resolve) => {
    finishInput = resolve
  })
  const actionFence = new Set<string>()
  const commands: string[] = []
  const contents = {
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree')
          return {
            nodes: [
              {
                nodeId: 'root',
                frameId: 'top',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
              },
              {
                nodeId: 'input',
                parentId: 'root',
                backendDOMNodeId: 42,
                role: { value: 'textbox' },
                name: { value: 'Query' },
              },
            ],
          }
        if (method === 'DOM.describeNode')
          return { node: { nodeName: 'INPUT', nodeType: 1, attributes: ['type', 'text'] } }
        if (method === 'Input.insertText') {
          await new Promise((resolve) => setTimeout(resolve, 5_100))
          inputStarted()
          await pendingInput
          effectSettledAt = performance.now()
        }
        return {}
      },
    }),
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigationTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    agentNavigate: async () => {},
    blockAgentPopups: () => {
      popupBlocks += 1
      return () => {
        popupBlocks -= 1
      }
    },
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
    validateActionPolicy: () => !interactBlocked,
    actionFence,
  })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    interactBlocked = true
    assert.throws(
      () =>
        controller.prepareAction({
          scope: authority.scope,
          requestId: 'blocked-action',
          tabId: authority.tabId,
          snapshotId: snapshot.snapshotId,
          elementRef: snapshot.elements[1].ref,
          action: 'fill',
          value: 'hello',
          intent: 'Search the catalog',
        }),
      /stale_grant/
    )
    interactBlocked = false
    const prepared = controller.prepareInteract({
      ...authority,
      requestId: 'fill-1',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'fill',
      value: 'hello',
      intent: 'Search the catalog',
    })
    assert.equal(prepared.consequential, true)
    assert.equal(prepared.intent, 'Search the catalog')
    assert.deepEqual(prepared.element, { role: 'textbox', name: 'Query' })
    const evidence = actionEvidence(prepared, 'approval-fill')
    assert.equal(JSON.stringify(prepared).includes('hello'), false)
    await assert.rejects(controller.execute({ ...evidence, intent: 'Pay now' }), /stale_action/)
    const approved = controller.prepareInteract({
      ...authority,
      requestId: 'fill-2',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'fill',
      value: 'hello',
      intent: 'Search the catalog',
    })
    await assert.rejects(
      controller.execute({
        ...actionEvidence(approved, 'approval-fill-2'),
        scope: { ...approved.scope, lifecycleEpoch: 2 },
      }),
      /stale_action/
    )
    const expired = controller.prepareInteract({ ...authority, requestId: 'expired-fill',
      snapshotId: snapshot.snapshotId, elementRef: snapshot.elements[1].ref,
      action: 'fill', value: 'hello', intent: 'Search the catalog' })
    const expiredExecution = controller.executeApprovedAction({ scope: expired.scope,
      requestId: expired.requestId, proofId: expired.proofId, tabId: expired.tabId })
    const actualNow = Date.now
    Date.now = () => expired.expiresAt + 1
    try {
      assert.throws(() => controller.actionProof(expired.requestId, expired.proofId), /stale_action/)
      await assert.rejects(expiredExecution, /stale_action/)
    } finally { Date.now = actualNow }
    const executable = controller.prepareInteract({
      ...authority,
      requestId: 'fill-3',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'fill',
      value: 'hello',
      intent: 'Search the catalog',
    })
    const dispatch = {
      scope: executable.scope,
      requestId: executable.requestId,
      proofId: executable.proofId,
      tabId: executable.tabId,
    }
    await assert.rejects(controller.executeApprovedAction({ ...dispatch,
      scope: { ...dispatch.scope, lifecycleEpoch: dispatch.scope.lifecycleEpoch + 1 } }), /stale_action/)
    const denied = controller.prepareInteract({ ...authority, requestId: 'denied-fill',
      snapshotId: snapshot.snapshotId, elementRef: snapshot.elements[1].ref,
      action: 'fill', value: 'hello', intent: 'Search the catalog' })
    const deniedExecution = controller.executeApprovedAction({ scope: denied.scope,
      requestId: denied.requestId, proofId: denied.proofId, tabId: denied.tabId })
    controller.cancelAction(denied.requestId, denied.tabId)
    await assert.rejects(deniedExecution, /stale_action/)
    assert.equal(commands.includes('Input.insertText'), false)
    let prematurelySettled = false
    const earlyExecution = controller.executeApprovedAction(dispatch).finally(() => { prematurelySettled = true })
    void earlyExecution.catch(() => {})
    await assert.rejects(controller.executeApprovedAction(dispatch), /replayed_request/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(prematurelySettled, false)
    controller.extendActionLease(executable.requestId, executable.proofId)
    controller.approveAction(executable.requestId, executable.proofId)
    assert.throws(
      () => controller.approveAction(executable.requestId, executable.proofId),
      /replayed_approval/
    )
    const originalNow = Date.now
    Date.now = () => originalNow() + 11_000
    try {
      const execution = earlyExecution
      await enteredInput
      assert.equal(popupBlocks, 1)
      assert.equal(
        await Promise.race([
          execution.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 450)),
        ]),
        false
      )
      finishInput()
      await execution
      assert.equal(popupBlocks, 0)
    } finally {
      finishInput()
      Date.now = originalNow
    }
    assert.ok(effectSettledAt > 0)
    assert.ok(performance.now() - effectSettledAt >= MIN_EFFECT_QUIET_ASSERT_MS)
    assert.ok(commands.includes('DOM.focus'))
    assert.ok(commands.includes('Input.insertText'))
    assert.ok(commands.every((method) => !method.startsWith('Runtime.')))
    await assert.rejects(controller.executeApprovedAction(dispatch), /stale_action/)
    controller.dispose()
    const replacement = createAgentBrowserController(registry, {
      validateAuthority: () => true,
      actionFence,
    })
    try {
      assert.equal(await replacement.waitForEffects(authority.scope), true)
    } finally {
      replacement.dispose()
    }
  } finally {
    controller.dispose()
  }
})

for (const { disposing, cancelling } of [
  { disposing: false, cancelling: false },
  { disposing: true, cancelling: false },
  { disposing: false, cancelling: true },
]) {
test(`started action drain preserves its CDP fence when disposing=${disposing} cancelling=${cancelling}`, async () => {
  let attached = false
  let finishEffect!: () => void
  let effectStarted!: () => void
  const started = new Promise<void>((resolve) => {
    effectStarted = resolve
  })
  const pendingEffect = new Promise<void>((resolve) => {
    finishEffect = resolve
  })
  const commands: string[] = []
  const contents = {
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree')
          return {
            nodes: [
              {
                nodeId: 'root',
                frameId: 'top',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
              },
              {
                nodeId: 'input',
                parentId: 'root',
                backendDOMNodeId: 42,
                role: { value: 'textbox' },
                name: { value: 'Query' },
              },
            ],
          }
        if (method === 'DOM.describeNode')
          return { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } }
        if (method === 'DOM.focus') {
          effectStarted()
          await pendingEffect
        }
        return {}
      },
    }),
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detachAgent: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
    blockAgentPopups: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    const prepared = controller.prepareInteract({
      ...authority,
      requestId: 'pending-fill',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'fill',
      value: 'secret',
      intent: 'Enter text',
    })
    const running = controller.execute(actionEvidence(prepared, 'pending-approval'))
    await started
    controller.revoke('tab')
    let drained = false
    let failure: unknown
    const drainAbort = new AbortController()
    const drain = controller.waitForEffects(authority.scope, drainAbort.signal).then(
      (settled) => { drained = true; return settled },
      (error: unknown) => { failure = error; return false })
    await Promise.resolve()
    assert.equal(drained, false)
    if (disposing) {
      controller.dispose()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(String(failure), /target_closed/)
      assert.equal(drained, false)
    }
    if (cancelling) {
      drainAbort.abort()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(String(failure), /request_expired/)
      assert.equal(drained, false)
    }
    finishEffect()
    assert.equal(await drain, false)
    await assert.rejects(running, /action_outcome_unknown/)
    assert.equal(commands.filter((method) => method.startsWith('Input.')).length, 0)
    await assert.rejects(
      controller.execute(actionEvidence(prepared, 'second-approval')),
      /stale_action/
    )
  } finally {
    finishEffect()
    controller.dispose()
  }
})
}

test('debugger detach followed by reattach cannot resume a pending action or close its fence', async () => {
  let attached = false
  let finishFocus!: () => void
  let focusStarted!: () => void
  const started = new Promise<void>((resolve) => {
    focusStarted = resolve
  })
  const pendingFocus = new Promise<void>((resolve) => {
    finishFocus = resolve
  })
  const commands: string[] = []
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      commands.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'input',
              parentId: 'root',
              backendDOMNodeId: 42,
              role: { value: 'textbox' },
              name: { value: 'Query' },
            },
          ],
        }
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } }
      if (method === 'DOM.focus') {
        focusStarted()
        await pendingFocus
      }
      return {}
    },
  })
  const contents = {
    debugger: debuggerSession,
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detachAgent: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
    blockAgentPopups: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    const prepared = controller.prepareInteract({
      ...authority,
      requestId: 'reattach-fill',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'fill',
      value: 'secret',
      intent: 'Enter text',
    })
    const running = controller.execute(actionEvidence(prepared, 'reattach-approval'))
    await started
    attached = false
    debuggerSession.emit('detach', {}, 'target_closed')
    attached = true
    finishFocus()
    await assert.rejects(running, /action_outcome_unknown/)
    assert.equal(commands.filter((method) => method.startsWith('Input.')).length, 0)
    assert.equal(await controller.waitForEffects(authority.scope), false)
  } finally {
    finishFocus()
    controller.dispose()
  }
})

test('prepared click rejects missing DOM node and stale reference before any Input event', async () => {
  let attached = false
  const commands: string[] = []
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'button',
              parentId: 'root',
              role: { value: 'button' },
              name: { value: 'Pay' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    agentNavigate: async () => {},
    blockAgentPopups: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    assert.throws(
      () =>
        controller.prepareInteract({
          ...authority,
          requestId: 'click-1',
          snapshotId: snapshot.snapshotId,
          elementRef: snapshot.elements[0].ref,
          action: 'click',
          intent: 'Pay',
        }),
      /non_interactive_ref/
    )
    assert.equal(commands.filter((method) => method.startsWith('Input.')).length, 0)
  } finally {
    controller.dispose()
  }
})

test('prepared submit dispatches one click and refuses replay or stale permission', async () => {
  let attached = false
  let revision = 1
  let generation = 1
  let origin = 'https://example.org'
  let navigationEvent: string | null = null
  let mainLoading = false
  let enteredNavigation!: () => void
  let navigationStarted = new Promise<void>(resolve => { enteredNavigation = resolve })
  let axName = 'Pay'
  let hitNodeId = 42
  let requestStarted!: () => void
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  const commands: string[] = []
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      commands.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'button',
              parentId: 'root',
              backendDOMNodeId: 42,
              role: { value: 'button' },
              name: { value: axName },
            },
          ],
        }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON', nodeType: 1 } }
      if (method === 'DOM.getBoxModel') return { model: { content: [0.25, 0.5, 20.25, 0.5, 20.25, 20.5, 0.25, 20.5] } }
      if (method === 'DOM.getNodeForLocation') {
        assert.deepEqual(params, { x: 10, y: 11 })
        return { backendNodeId: hitNodeId, frameId: 'top' }
      }
      if (method === 'Input.dispatchMouseEvent') {
        assert.equal(params?.x, 10)
        assert.equal(params?.y, 11)
      }
      if (method === 'Input.dispatchMouseEvent' && (params?.type === 'mouseReleased' || params?.type === navigationEvent)) {
        if (params?.type === navigationEvent) {
          mainLoading = true
          generation += 1
          origin = 'https://destination.example.org'
          enteredNavigation()
          controller.invalidateTarget(testAuthority().tabId)
          debuggerSession.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'top' } })
        }
        debuggerSession.emit('message', {}, 'Page.frameStartedLoading', { frameId: 'top' })
        debuggerSession.emit('message', {}, 'Network.requestWillBeSent', {
          requestId: 'action-network',
        })
        requestStarted()
      }
      return {}
    },
  })
  const contents = {
    debugger: debuggerSession,
    isDestroyed: () => false,
    isLoadingMainFrame: () => mainLoading,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin,
      generation,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    agentNavigate: async () => {},
    blockAgentPopups: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === revision,
  })
  const authority = testAuthority()
  try {
    assert.equal(typeof controller.invalidateTarget, 'function')
    const snapshot = await controller.snapshot(authority)
    const prepared = controller.prepareSubmit({
      ...authority,
      requestId: 'submit-1',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      intent: 'Pay for order',
    })
    assert.equal(prepared.consequential, true)
    assert.equal(prepared.intent, 'Pay for order')
    assert.deepEqual(prepared.element, { role: 'button', name: 'Pay' })
    revision += 1
    await assert.rejects(controller.execute(actionEvidence(prepared, 'approval-stale')), /stale/)
    assert.equal(commands.filter((method) => method === 'Input.dispatchMouseEvent').length, 0)
    revision -= 1
    const current = controller.prepareSubmit({
      ...authority,
      requestId: 'submit-2',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      intent: 'Pay for order',
    })
    const evidence = actionEvidence(current, 'approval-current')
    const execution = controller.execute(evidence)
    await started
    const earlyCompletion = await Promise.race([
      execution.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ])
    assert.equal(earlyCompletion, false)
    debuggerSession.emit('message', {}, 'Network.loadingFinished', { requestId: 'action-network' })
    assert.equal(
      await Promise.race([
        execution.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]),
      false
    )
    debuggerSession.emit('message', {}, 'Page.frameStoppedLoading', { frameId: 'top' })
    await execution
    assert.equal(await controller.waitForEffects(authority.scope), true)
    assert.equal(commands.filter((method) => method === 'Input.dispatchMouseEvent').length, 3)
    await assert.rejects(controller.execute(evidence), /stale|replayed/)
    for (const event of ['mouseReleased', 'mousePressed']) {
      navigationStarted = new Promise<void>(resolve => { enteredNavigation = resolve })
      const navigationSnapshot = await controller.snapshot(authority)
      const navigationProof = controller.prepareSubmit({ ...authority, requestId: `submit-navigation-${event}`,
        snapshotId: navigationSnapshot.snapshotId, elementRef: navigationSnapshot.elements[1].ref,
        intent: 'Submit form' })
      navigationEvent = event
      const countBefore = commands.filter(method => method === 'Input.dispatchMouseEvent').length
      const navigating = controller.execute(actionEvidence(navigationProof, `navigation-${event}`))
      void navigating.catch(() => {})
      await navigationStarted
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(attached, true)
      await assert.rejects(controller.read({ ...authority, snapshotId: navigationSnapshot.snapshotId,
        elementRef: navigationSnapshot.elements[1].ref }), /stale_ref/)
      assert.equal(attached, true)
      debuggerSession.emit('message', {}, 'Network.loadingFinished', { requestId: 'action-network' })
      debuggerSession.emit('message', {}, 'Page.frameStoppedLoading', { frameId: 'top' })
      debuggerSession.emit('message', {}, 'Page.loadEventFired', {})
      let ended = false
      void navigating.then(() => { ended = true }, () => { ended = true })
      await new Promise(resolve => setTimeout(resolve, 450))
      assert.equal(ended, false)
      mainLoading = false
      await assert.rejects(navigating, /action_outcome_unknown/)
      assert.equal(await controller.waitForEffects(authority.scope), true)
      assert.equal(attached, false)
      assert.equal(commands.filter(method => method === 'Input.dispatchMouseEvent').length - countBefore,
        event === 'mouseReleased' ? 3 : 2)
      await assert.rejects(controller.execute(actionEvidence(navigationProof, 'old-navigation')), /stale/)
    }
    navigationEvent = null
    let nextSnapshot = await controller.snapshot(authority)
    const adjacent = controller.prepareSubmit({ ...authority, requestId: 'submit-adjacent',
      snapshotId: nextSnapshot.snapshotId, elementRef: nextSnapshot.elements[1].ref, intent: 'Pay for order' })
    hitNodeId += 1
    const mouseCount = commands.filter(method => method === 'Input.dispatchMouseEvent').length
    await assert.rejects(controller.execute(actionEvidence(adjacent, 'approval-adjacent')), /action_outcome_unknown/)
    assert.equal(commands.filter(method => method === 'Input.dispatchMouseEvent').length, mouseCount)
    hitNodeId -= 1
    nextSnapshot = await controller.snapshot(authority)
    const changed = controller.prepareSubmit({
      ...authority,
      requestId: 'submit-changed',
      snapshotId: nextSnapshot.snapshotId,
      elementRef: nextSnapshot.elements[1].ref,
      intent: 'Pay for order',
    })
    axName = 'Delete'
    await assert.rejects(
      controller.execute(actionEvidence(changed, 'approval-changed')),
      /stale_ref/
    )
    assert.equal(commands.filter((method) => method === 'Input.dispatchMouseEvent').length, 8)
    controller.invalidateTarget(authority.tabId)
    assert.equal(attached, false)
    await assert.rejects(controller.read({ ...authority, snapshotId: nextSnapshot.snapshotId,
      elementRef: nextSnapshot.elements[1].ref }), /stale_ref/)
    axName = 'Pay'
    const finalSnapshot = await controller.snapshot(authority)
    const unfinished = controller.prepareSubmit({
      ...authority,
      requestId: 'submit-unfinished',
      snapshotId: finalSnapshot.snapshotId,
      elementRef: finalSnapshot.elements[1].ref,
      intent: 'Pay for order',
    })
    await assert.rejects(
      controller.execute(actionEvidence(unfinished, 'approval-unfinished')),
      /action_outcome_unknown/
    )
    assert.equal(await controller.waitForEffects(authority.scope), false)
  } finally {
    controller.dispose()
  }
})

test('navigation drain fails closed on revocation, debugger loss, replacement and main-frame loss', async () => {
  for (const invalidation of ['revoke', 'detach', 'instance', 'contents', 'frame']) {
    let attached = false
    let generation = 1
    let instanceId = 'instance'
    let replaced = false
    let entered!: () => void
    const navigationStarted = new Promise<void>(resolve => { entered = resolve })
    const debuggerSession = Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [
          { nodeId: 'root', frameId: 'top', role: { value: 'RootWebArea' }, name: { value: 'Page' } },
          { nodeId: 'button', parentId: 'root', backendDOMNodeId: 42,
            role: { value: 'button' }, name: { value: 'Search' } },
        ] }
        if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON', attributes: [] } }
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42, frameId: 'top' }
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          generation += 1
          debuggerSession.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'top' } })
          entered()
        }
        return {}
      },
    })
    const contents = { debugger: debuggerSession, isDestroyed: () => false,
      getTitle: () => 'Page' } as unknown as WebContents
    const registry = {
      agentTarget: () => ({ contents: replaced ? {} : contents, origin: 'https://example.org',
        generation, instanceId, title: 'Page', url: 'https://example.org/' }),
      attach: () => { attached = true; return contents },
      detachAgent: () => { attached = false }, onDebuggerDetach: () => () => {},
      cancelAgentNavigation: () => {}, blockAgentPopups: () => () => {},
    } as unknown as BrowserRegistry
    const controller = createController(registry, { validateAuthority: () => true })
    try {
      const authority = testAuthority()
      const snapshot = await controller.snapshot(authority)
      const proof = controller.prepareSubmit({ ...authority, requestId: invalidation,
        snapshotId: snapshot.snapshotId, elementRef: snapshot.elements[1].ref, intent: 'Submit search' })
      const execution = controller.execute(actionEvidence(proof, invalidation))
      void execution.catch(() => {})
      await navigationStarted
      if (invalidation === 'revoke') controller.revoke(authority.tabId)
      if (invalidation === 'detach') { debuggerSession.emit('detach'); attached = true }
      if (invalidation === 'instance') instanceId = 'replacement'
      if (invalidation === 'contents') replaced = true
      if (invalidation === 'frame') debuggerSession.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'replacement' } })
      debuggerSession.emit('message', {}, 'Page.frameStoppedLoading', { frameId: 'top' })
      await assert.rejects(execution, /action_outcome_unknown/)
      assert.equal(await controller.waitForEffects(authority.scope), false, invalidation)
    } finally { controller.dispose() }
  }
})

test('ordinary click cannot activate a form submit button', async () => {
  let attached = false
  const commands: string[] = []
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree')
          return {
            nodes: [
              {
                nodeId: 'root',
                frameId: 'top',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
              },
              {
                nodeId: 'submit',
                parentId: 'root',
                backendDOMNodeId: 42,
                role: { value: 'button' },
                name: { value: 'Send' },
              },
            ],
          }
        if (method === 'DOM.describeNode')
          return { node: { nodeName: 'BUTTON', nodeType: 1, attributes: [] } }
        if (method === 'DOM.getBoxModel')
          return { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42, frameId: 'top' }
        return {}
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    assert.throws(
      () =>
        controller.prepareInteract({
          ...authority,
          requestId: 'intentless-click',
          snapshotId: snapshot.snapshotId,
          elementRef: snapshot.elements[1].ref,
          action: 'click',
          intent: '',
        }),
      /invalid_action/
    )
    const prepared = controller.prepareInteract({
      ...authority,
      requestId: 'ordinary-click',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      action: 'click',
      intent: 'Send message',
    })
    assert.equal(prepared.consequential, true)
    await assert.rejects(
      controller.execute(actionEvidence(prepared, 'click-approval')),
      /submit_requires_approval/
    )
    assert.equal(commands.filter((method) => method.startsWith('Input.')).length, 0)
  } finally {
    controller.dispose()
  }
})

test('revocation during DOM resolution suppresses all Input events', async () => {
  let attached = false
  let resolveDescription!: (value: unknown) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pendingDescription = new Promise<unknown>((resolve) => {
    resolveDescription = resolve
  })
  const commands: string[] = []
  let descriptions = 0
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        if (method === 'Accessibility.getFullAXTree')
          return {
            nodes: [
              {
                nodeId: 'root',
                frameId: 'top',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
              },
              {
                nodeId: 'button',
                parentId: 'root',
                backendDOMNodeId: 42,
                role: { value: 'button' },
                name: { value: 'Pay' },
              },
            ],
          }
        if (method === 'DOM.describeNode') {
          descriptions += 1
          if (descriptions <= 1) return { node: { nodeName: 'BUTTON', nodeType: 1 } }
          entered()
          return pendingDescription
        }
        return {}
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    agentNavigate: async () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  const authority = testAuthority()
  try {
    const snapshot = await controller.snapshot(authority)
    const prepared = controller.prepareSubmit({
      ...authority,
      requestId: 'revoke-submit',
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
      intent: 'Pay',
    })
    const pending = controller.execute(actionEvidence(prepared, 'revoke-approval'))
    await started
    controller.revoke('tab')
    resolveDescription({ node: { nodeName: 'BUTTON' } })
    await assert.rejects(pending, /stale/)
    assert.equal(commands.filter((method) => method.startsWith('Input.')).length, 0)
  } finally {
    controller.dispose()
  }
})

test('revocation aborts a started navigation and rejects its eventual result', async () => {
  let resolveNavigation!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    resolveNavigation = resolve
  })
  let cancelled = 0
  const contents = {
    isDestroyed: () => false,
    getTitle: () => 'Page',
    getURL: () => 'https://example.org/',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    agentNavigate: async () => {
      entered()
      await waiting
    },
    cancelAgentNavigation: () => {
      cancelled += 1
    },
    agentNavigationTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => contents,
    detach: () => {},
    detachAgent: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  try {
    const proof = {
      ...navigateProof('navigate-revoke'),
      source: { instanceId: 'instance', generation: 1, origin: 'https://example.org' },
    }
    controller.prepareNavigate(proof)
    const pending = controller.executeNavigate({ ...proof, id: 'approve-nav', action: 'navigate' })
    await started
    controller.revoke('tab')
    resolveNavigation()
    await assert.rejects(pending, /stale/)
    assert.equal(cancelled, 1)
  } finally {
    controller.dispose()
  }
})

test('an older async snapshot cannot reveal data or detach its replacement lease', async () => {
  let attached = false
  let pageCalls = 0
  let enteredPage!: () => void
  const pageStarted = new Promise<void>((resolveStarted) => {
    enteredPage = resolveStarted
  })
  let completeOld!: (value: unknown) => void
  const oldPage = new Promise<unknown>((resolvePage) => {
    completeOld = resolvePage
  })
  const frameTree = { frameTree: { frame: { id: 'top-frame' } } }
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') {
          pageCalls += 1
          if (pageCalls === 1) enteredPage()
          return pageCalls === 1 ? oldPage : frameTree
        }
        const styled = visibleDomCommand(method)
        if (styled !== undefined) return styled
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top-frame',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'heading',
              parentId: 'root',
              backendDOMNodeId: 2,
              role: { value: 'heading' },
              name: { value: 'Current heading' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Current page',
  } as unknown as WebContents
  let detachCount = 0
  const registry = {
    agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
      instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
      detachCount += 1
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  const authority = testAuthority()
  try {
    const old = controller.snapshot(authority).then(
      () => 'leaked',
      (error) => String(error)
    )
    await pageStarted
    const current = await controller.snapshot(authority)
    completeOld(frameTree)
    assert.match(await old, /stale_ref/)
    assert.deepEqual(
      (
        await controller.read({
          ...authority,
          snapshotId: current.snapshotId,
          elementRef: current.elements[1].ref,
        })
      ).name,
      'Current heading'
    )
    assert.equal(attached, true)
    assert.equal(detachCount, 1)
    const originalNow = Date.now
    Date.now = () => originalNow() + EXPIRED_OBSERVATION_OFFSET_MS
    try {
      assert.throws(() => controller.prepareAction({ scope: authority.scope, requestId: 'replacement-action',
        tabId: authority.tabId, snapshotId: current.snapshotId, elementRef: current.elements[1].ref,
        action: 'click', intent: 'Inspect heading' }), /observation_read_required/)
    } finally { Date.now = originalNow }
  } finally {
    controller.dispose()
  }
})

test('revocation during an awaited CDP command rejects its late result', async () => {
  let attached = false
  let completePage!: (value: unknown) => void
  const page = new Promise<unknown>((resolvePage) => {
    completePage = resolvePage
  })
  const contents = {
    debugger: { isAttached: () => attached, sendCommand: async () => page },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
      instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
    cancelAgentNavigation: () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  const authority = testAuthority()
  try {
    const pending = controller.snapshot(authority).then(
      () => 'leaked',
      (error) => String(error)
    )
    controller.revoke(authority.tabId)
    completePage({ frameTree: { frame: { id: 'top-frame' } } })
    assert.match(await pending, /stale_ref/)
  } finally {
    controller.dispose()
  }
})

test('deep main-frame controls survive snapshot and read without bypassing hidden ancestors', async () => {
  const wrapperCount = 18
  const expansionNodeCount = 513
  const nodes: Record<string, unknown>[] = [{ nodeId: 'root', frameId: 'top', role: { value: 'RootWebArea' }, name: { value: 'Page' } }]
  for (let index = 0; index < wrapperCount; index += 1)
    nodes.push({ nodeId: `wrapper-${index}`, parentId: index ? `wrapper-${index - 1}` : 'root', backendDOMNodeId: index + 4, role: { value: 'generic' } })
  nodes.push(
    { nodeId: 'search', parentId: `wrapper-${wrapperCount - 1}`, backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Public search' } },
    { nodeId: 'hidden', parentId: 'root', ignored: true, ignoredReasons: [{ name: 'notRendered' }], role: { value: 'none' } },
    { nodeId: 'secret', parentId: 'hidden', backendDOMNodeId: 3, role: { value: 'textbox' }, name: { value: 'Hidden search' } },
  )
  for (const node of nodes) node.childIds = nodes.filter(child => child.parentId === node.nodeId).map(child => child.nodeId)
  const requested: unknown[] = []
  let expansion = 'normal'
  const contents = {
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
        const dom = visibleDomCommand(method)
        if (dom !== undefined) return dom
        if (method === 'Accessibility.getFullAXTree') {
          requested.push(params)
          assert.equal(params?.depth, undefined)
          assert.equal(params?.frameId, 'top')
          if (expansion === 'oversized') return { nodes: Array.from({ length: expansionNodeCount }, (_, index) => ({ nodeId: `excess-${index}` })) }
          if (expansion === 'incomplete') return { nodes: nodes.slice(0, 1) }
          return { nodes }
        }
        return {}
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1, instanceId: 'target', title: 'Page', url: 'https://example.org/' }),
    attach: () => contents,
    detach: () => {},
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    const authority = testAuthority()
    const snapshot = await controller.snapshot(authority)
    assert.deepEqual(snapshot.elements.map(element => element.name), ['Page', 'Public search'])
    const search = snapshot.elements.find(element => element.name === 'Public search')!
    const read = await controller.read({ ...authority, snapshotId: snapshot.snapshotId, elementRef: search.ref })
    assert.equal(read.name, 'Public search')
    assert.equal(requested.length, 2)
    expansion = 'oversized'
    await assert.rejects(controller.snapshot(authority), /snapshot_too_large/)
    expansion = 'incomplete'
    await assert.rejects(controller.snapshot(authority), /stale_ref/)
  } finally { controller.dispose() }
})

test('one main-frame AX read retains the bounded DOM inspection batch', { timeout: 10_000 }, async () => {
  const frontierCount = 8
  let entered = 0
  let peak = 0
  let treeReads = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const roots = [{ nodeId: 'root', frameId: 'top', role: { value: 'RootWebArea' }, name: { value: '' } },
    ...Array.from({ length: frontierCount }, (_, index) => ({ nodeId: `child-${index}`, parentId: 'root', backendDOMNodeId: index + 1,
      role: { value: 'heading' }, name: { value: 'Public child' } }))]
  const contents = {
    debugger: { isAttached: () => true, sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
      if (method === 'Accessibility.getFullAXTree') {
        treeReads += 1
        assert.deepEqual(params, { frameId: 'top' })
        return { nodes: roots }
      }
      if (method === 'DOM.describeNode') {
        entered += 1
        peak = Math.max(peak, entered)
        if (entered === frontierCount) release()
        await barrier
        return visibleDomCommand(method)
      }
      return {}
    } }, isDestroyed: () => false, getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = { agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1, instanceId: 'target', title: 'Page', url: 'https://example.org/' }),
    attach: () => contents, detach: () => {}, onDebuggerDetach: () => () => {} } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    const snapshot = await controller.snapshot(testAuthority())
    assert.equal(snapshot.elements.length, frontierCount)
    assert.equal(peak, frontierCount)
    assert.equal(treeReads, 1)
  } finally { release(); controller.dispose() }
})

test('snapshot inspects shared DOM ancestry once but read and the next snapshot recheck hidden state', async () => {
  const described: number[] = []
  let hidden = false
  const nodes = [{ nodeId: 'root', frameId: 'top', backendDOMNodeId: 1, role: { value: 'RootWebArea' }, name: { value: 'Page' } },
    ...Array.from({ length: 8 }, (_, index) => ({ nodeId: `child-${index}`, parentId: 'root', backendDOMNodeId: index + 2,
      role: { value: 'heading' }, name: { value: `Public ${index}` } }))]
  const contents = { debugger: { isAttached: () => true,
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      if (method === 'DOM.describeNode') {
        const nodeId = params?.backendNodeId as number
        described.push(nodeId)
        return { node: { nodeName: 'DIV', attributes: hidden && nodeId === 1 ? ['hidden', ''] : [] } }
      }
      return {}
    } }, isDestroyed: () => false, getTitle: () => 'Page' } as unknown as WebContents
  const registry = { agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
    instanceId: 'target', title: 'Page', url: 'https://example.org/' }), attach: () => contents,
  detach: () => {}, onDebuggerDetach: () => () => {} } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    const authority = testAuthority()
    const snapshot = await controller.snapshot(authority)
    assert.equal(snapshot.elements.length, nodes.length)
    assert.equal(described.length, nodes.length)
    assert.equal(new Set(described).size, nodes.length)
    hidden = true
    await assert.rejects(controller.read({ ...authority, snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref }), /stale_ref/)
    const next = await controller.snapshot(authority)
    assert.equal(next.elements.length, 0)
  } finally { controller.dispose() }
})

test('AX snapshot rejects ignored ancestors, detached nodes, cycles and foreign frames', async () => {
  let attached = false
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top-frame' } } }
        const styled = visibleDomCommand(method)
        if (styled !== undefined) return styled
        return {
          nodes: [
            {
              nodeId: 'root',
              frameId: 'top-frame',
              role: { value: 'RootWebArea' },
              name: { value: 'Page' },
            },
            {
              nodeId: 'safe',
              parentId: 'root',
              backendDOMNodeId: 2,
              role: { value: 'heading' },
              name: { value: 'Safe heading' },
            },
            { nodeId: 'hidden', parentId: 'root', ignored: true, role: { value: 'generic' } },
            {
              nodeId: 'hidden-child',
              parentId: 'hidden',
              role: { value: 'text' },
              name: { value: 'Hidden secret' },
            },
            {
              nodeId: 'hidden-none',
              parentId: 'root',
              ignored: true,
              ignoredReasons: [{ name: 'ariaHiddenElement' }],
              role: { value: 'none' },
            },
            {
              nodeId: 'hidden-none-child',
              parentId: 'hidden-none',
              role: { value: 'text' },
              name: { value: 'Also hidden' },
            },
            { nodeId: 'unknown-none', parentId: 'root', ignored: true, role: { value: 'none' } },
            {
              nodeId: 'unknown-none-child',
              parentId: 'unknown-none',
              role: { value: 'text' },
              name: { value: 'Unknown hidden' },
            },
            {
              nodeId: 'uninteresting-none',
              parentId: 'root',
              ignored: true,
              ignoredReasons: [{ name: 'uninteresting' }],
              role: { value: 'none' },
            },
            {
              nodeId: 'visible-child',
              parentId: 'uninteresting-none',
              backendDOMNodeId: 3,
              role: { value: 'heading' },
              name: { value: 'Visible heading' },
            },
            {
              nodeId: 'iframe',
              parentId: 'root',
              role: { value: 'Iframe' },
              name: { value: 'External frame' },
            },
            {
              nodeId: 'iframe-child',
              parentId: 'iframe',
              role: { value: 'text' },
              name: { value: 'Cross origin secret' },
            },
            {
              nodeId: 'foreign',
              parentId: 'root',
              frameId: 'foreign-frame',
              role: { value: 'text' },
              name: { value: 'Foreign secret' },
            },
            {
              nodeId: 'orphan',
              parentId: 'unknown',
              role: { value: 'text' },
              name: { value: 'Orphan secret' },
            },
            {
              nodeId: 'cycle-a',
              parentId: 'cycle-b',
              role: { value: 'text' },
              name: { value: 'Cycle secret' },
            },
            { nodeId: 'cycle-b', parentId: 'cycle-a', role: { value: 'text' } },
            {
              nodeId: 'password',
              parentId: 'root',
              role: { value: 'textField' },
              name: { value: 'Password secret' },
            },
          ],
        }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
      instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  try {
    const snapshot = await controller.snapshot(testAuthority())
    assert.deepEqual(
      snapshot.elements.map((element) => element.name),
      ['Page', 'Safe heading', 'Visible heading']
    )
  } finally {
    controller.dispose()
  }
})

test('oversized AX tree fails closed and requests bounded protocol depth', async () => {
  let attached = false
  let requestedDepth: unknown
  const nodes = [
    { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Page' } },
    ...Array.from({ length: 600 }, (_, index) => ({
      nodeId: `child-${index}`,
      parentId: 'root',
      role: { value: 'text' },
      name: { value: 'Data' },
    })),
  ]
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top-frame' } } }
        requestedDepth = params?.depth
        return { nodes }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
      instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, {
    validateAuthority: (authority) => authority.grantRevision === 1,
  })
  try {
    await assert.rejects(controller.snapshot(testAuthority()), /snapshot_too_large/)
    assert.equal(requestedDepth, undefined)
    assert.equal(attached, false)
  } finally {
    controller.dispose()
  }
})

test('AX snapshot rejects a UTF-8 response beyond the bridge budget', async () => {
  let attached = false
  const nodes = [
    {
      nodeId: 'root',
      frameId: 'top-frame',
      role: { value: 'RootWebArea' },
      name: { value: 'Page' },
    },
    ...Array.from({ length: 96 }, (_, index) => ({
      nodeId: `child-${index}`,
      parentId: 'root',
      backendDOMNodeId: index + 2,
      role: { value: 'heading' },
      name: { value: '😀'.repeat(160) },
    })),
  ]
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top-frame' } } }
        const styled = visibleDomCommand(method)
        return styled === undefined ? { nodes } : styled
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    await assert.rejects(controller.snapshot(testAuthority()), /snapshot_too_large/)
    assert.equal(attached, false)
  } finally {
    controller.dispose()
  }
})

test('snapshot omits hidden name sources and password inputs while retaining public text', async () => {
  let attached = false
  const nodes = [
    {
      nodeId: 'root',
      frameId: 'top-frame',
      role: { value: 'RootWebArea' },
      name: { value: 'Page' },
    },
    {
      nodeId: 'public',
      parentId: 'root',
      backendDOMNodeId: 2,
      role: { value: 'heading' },
      name: { value: 'Public heading' },
    },
    {
      nodeId: 'related',
      parentId: 'root',
      backendDOMNodeId: 7,
      role: { value: 'button' },
      name: {
        value: 'Hidden secret',
        sources: [{ type: 'relatedElement', value: { value: 'Hidden secret' } }],
      },
    },
    {
      nodeId: 'hidden-label',
      parentId: 'root',
      backendDOMNodeId: 9,
      ignored: true,
      role: { value: 'generic' },
      name: { value: 'Hidden source' },
    },
    {
      nodeId: 'hidden-input',
      parentId: 'root',
      backendDOMNodeId: 10,
      role: { value: 'textbox' },
      name: {
        value: 'Hidden source',
        sources: [
          {
            type: 'relatedElement',
            value: { value: 'Hidden source' },
            attributeValue: { relatedNodes: [{ backendDOMNodeId: 9, text: 'Hidden source' }] },
          },
        ],
      },
    },
    {
      nodeId: 'foreign-label',
      parentId: 'root',
      frameId: 'foreign-frame',
      backendDOMNodeId: 11,
      role: { value: 'generic' },
      name: { value: 'Foreign source' },
    },
    {
      nodeId: 'foreign-input',
      parentId: 'root',
      backendDOMNodeId: 12,
      role: { value: 'textbox' },
      name: {
        value: 'Foreign source',
        sources: [
          {
            type: 'relatedElement',
            value: { value: 'Foreign source' },
            attributeValue: { relatedNodes: [{ backendDOMNodeId: 11, text: 'Foreign source' }] },
          },
        ],
      },
    },
    {
      nodeId: 'password',
      parentId: 'root',
      backendDOMNodeId: 8,
      role: { value: 'textbox' },
      name: { value: 'Password secret', sources: [{ type: 'attribute' }] },
    },
    {
      nodeId: 'foreign',
      parentId: 'root',
      frameId: 'foreign-frame',
      role: { value: 'heading' },
      name: { value: 'Foreign secret' },
    },
  ]
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string, params?: { backendNodeId?: number }) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top-frame' } } }
        if (method === 'DOM.describeNode')
          return params?.backendNodeId === 8
            ? { node: { nodeName: 'INPUT', nodeType: 1, attributes: ['type', 'password'] } }
            : visibleDomCommand(method)
        const styled = visibleDomCommand(method)
        if (styled !== undefined) return styled
        return { nodes }
      },
    },
    isDestroyed: () => false,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation: 1,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  try {
    const snapshot = await controller.snapshot(testAuthority())
    assert.deepEqual(
      snapshot.elements.map((element) => element.name),
      ['Page', 'Public heading']
    )
  } finally {
    controller.dispose()
  }
})

test('read fails closed on in-flight navigation and independent snapshot expiry', async () => {
  let attached = false
  let generation = 1
  let loadingMainFrame = false
  let pending: (() => void) | undefined
  let paused = false
  const nodes = [
    {
      nodeId: 'root',
      frameId: 'top-frame',
      role: { value: 'RootWebArea' },
      name: { value: 'Page' },
    },
    {
      nodeId: 'heading',
      parentId: 'root',
      backendDOMNodeId: 2,
      role: { value: 'heading' },
      name: { value: 'Public heading' },
    },
  ]
  const contents = {
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top-frame' } } }
        const styled = visibleDomCommand(method)
        if (styled !== undefined) return styled
        if (paused)
          await new Promise<void>((resolvePending) => {
            pending = resolvePending
          })
        return { nodes }
      },
    },
    isDestroyed: () => false,
    isLoadingMainFrame: () => loadingMainFrame,
    getTitle: () => 'Page',
  } as unknown as WebContents
  const registry = {
    agentTarget: () => ({
      contents,
      origin: 'https://example.org',
      generation,
      instanceId: 'instance',
      title: 'Page',
      url: 'https://example.org/',
    }),
    attach: () => {
      attached = true
      return contents
    },
    detach: () => {
      attached = false
    },
    onDebuggerDetach: () => () => {},
  } as unknown as BrowserRegistry
  const controller = createAgentBrowserController(registry, { validateAuthority: () => true })
  const authority = testAuthority()
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    const snapshot = await controller.snapshot(authority)
    paused = true
    const reading = controller.read({
      ...authority,
      snapshotId: snapshot.snapshotId,
      elementRef: snapshot.elements[1].ref,
    })
    await new Promise((resolveNext) => setImmediate(resolveNext))
    loadingMainFrame = true
    pending?.()
    await assert.rejects(reading, /stale_ref/)
    loadingMainFrame = false
    generation += 1
    paused = false
    const next = await controller.snapshot(authority)
    now += 10_001
    await assert.rejects(
      controller.read({
        ...authority,
        snapshotId: next.snapshotId,
        elementRef: next.elements[1].ref,
      }),
      /stale_ref/
    )
  } finally {
    Date.now = originalNow
    controller.dispose()
  }
})

test(
  'stalled CDP snapshot times out and releases its debugger lease',
  { timeout: 10_000 },
  async () => {
    let attached = false
    const contents = {
      debugger: {
        isAttached: () => attached,
        sendCommand: () => new Promise<never>(() => undefined),
      },
      isDestroyed: () => false,
      getTitle: () => 'Page',
    } as unknown as WebContents
    const registry = {
      agentTarget: () => ({ contents, origin: 'https://example.org', generation: 1,
        instanceId: 'instance', title: 'Page', url: 'https://example.org/' }),
      attach: () => {
        attached = true
        return contents
      },
      detach: () => {
        attached = false
      },
      onDebuggerDetach: () => () => {},
    } as unknown as BrowserRegistry
    const controller = createAgentBrowserController(registry, {
      validateAuthority: (authority) => authority.grantRevision === 1,
    })
    try {
      await assert.rejects(controller.snapshot(testAuthority()), /snapshot_timeout/)
      assert.equal(attached, false)
    } finally {
      controller.dispose()
    }
  }
)

test(
  'Main read lease keeps debugger attached across snapshot/read and rejects navigation-stale refs',
  { timeout: 90_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-read-'))
    const entry = join(temporary, 'main.cjs')
    await build({
      stdin: {
        contents: `
    import { app, BrowserWindow } from 'electron'
    import { createBrowserRegistry } from './src/main/browser.ts'
    import { selectStorage, publishStorage } from './src/main/storage.ts'
    import { createAgentBrowserController } from './src/main/agent.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessionData'))})
    app.commandLine.appendSwitch('use-mock-keychain')
    if (!process.env.SCHOLARSEED_HOME) throw new Error('Probe requires isolated home')
    const unexpectedPointer = () => { throw new Error('Explicit probe home must not read pointer') }
    publishStorage(selectStorage('browser-probe', {
      pin: unexpectedPointer, readAt: unexpectedPointer, release: unexpectedPointer
    }))
    globalThis.ready = app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: true })
      globalThis.registry = createBrowserRegistry(window, { apiBase: '', publish() {}, log() {} })
      globalThis.agent = createAgentBrowserController(globalThis.registry, { validateAuthority: authority => authority.grantRevision === 1 })
      await globalThis.registry.dispatch({ kind: 'open', input: 'https://www.rfc-editor.org/' })
      const tabId = globalThis.registry.snapshot().activeTabId
      await globalThis.registry.dispatch({ kind: 'bounds', tabId, x: 0, y: 0, width: 700, height: 500, visible: true })
    })
  `,
        resolveDir: resolve('.'),
      },
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron', './lease.node'],
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)
    )
    delete environment.ELECTRON_RUN_AS_NODE
    environment.SCHOLARSEED_HOME = join(temporary, 'home')
    const application = await _electron.launch({ args: [entry], env: environment })
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, agent } = globalThis as unknown as BrowserFixture
        const tabId = registry.snapshot().activeTabId
        if (!tabId) throw new Error('browser tab unavailable')
        const authority = {
          tabId,
          grantRevision: 1,
          grantId: 'grant',
          grantRequestId: 'request',
          scope: {
            sessionId: 'session',
            instanceId: 'instance',
            productTurnId: 'product-turn',
            turnId: 'turn',
            generation: 1,
            interruptGeneration: 0,
            lifecycleEpoch: 1,
          },
        }
        registry.attach(tabId)
        let busy = ''
        try {
          await agent.snapshot(authority)
        } catch (error) {
          busy = String(error)
        }
        registry.detach(tabId)
        const frameLoad = await registry.target(tabId).executeJavaScript(`new Promise(resolve => {
        document.body.replaceChildren()
        document.body.insertAdjacentHTML('afterbegin', '<h1>Public agent heading</h1><label id="visible-label" for="visible-input">Visible label</label><input id="visible-input" type="text" aria-labelledby="visible-label"><div style="opacity:0"><label id="css-hidden-label" for="css-hidden-input">CSS hidden secret</label></div><input id="css-hidden-input" type="text" aria-labelledby="css-hidden-label"><div style="color:transparent"><label id="color-hidden-label" for="color-hidden-input">Color hidden secret</label><span>Color static secret</span></div><input id="color-hidden-input" type="text" aria-labelledby="color-hidden-label"><div style="position:absolute;left:-9999px"><label id="offscreen-label" for="offscreen-input">Offscreen label secret</label><span>Offscreen static secret</span></div><input id="offscreen-input" type="text" aria-labelledby="offscreen-label"><span id="hidden-label" hidden>Hidden label secret</span><button aria-labelledby="hidden-label">Public button</button><input type="password" aria-label="Password label secret" value="secret-value"><input id="agent-fill-target" type="text" aria-label="Agent query">')
        document.body.insertAdjacentHTML('afterbegin', '<div style="text-indent:-9999px"><label id="indented-label" for="indented-input">Indented label text</label><span>Indented static text</span></div><input id="indented-input" type="text" aria-labelledby="indented-label"><div style="background:white;color:white"><label id="same-color-label" for="same-color-input">Same color label</label><span>Same color static text</span></div><input id="same-color-input" type="text" aria-labelledby="same-color-label"><div style="color:transparent"><label id="restored-label" for="restored-input" style="color:black">Restored label</label><span style="color:black">Restored static text</span></div><input id="restored-input" type="text" aria-labelledby="restored-label">')
        const deepWrapperCount = 18
        const submitTarget = document.createElement('button')
        submitTarget.textContent = 'Submit query'
        submitTarget.addEventListener('mousedown', event => { globalThis.agentPressedButtons = event.buttons })
        document.body.append(submitTarget)
        let deepParent = document.body
        for (let index = 0; index < deepWrapperCount; index += 1) {
          const wrapper = document.createElement('div')
          deepParent.append(wrapper)
          deepParent = wrapper
        }
        deepParent.append(document.getElementById('agent-fill-target'))
        document.getElementById('agent-fill-target').value = 'previous query'
        const frame = document.createElement('iframe')
        frame.id = 'agent-cross-frame'
        frame.title = 'Cross frame'
        frame.addEventListener('load', () => resolve('loaded'), { once: true })
        frame.src = 'https://httpbin.org/html'
        document.body.append(frame)
        setTimeout(() => resolve('timeout'), 10000)
      })`)
        const snapshot = await agent.snapshot(authority)
        const visibleLabeledInput = snapshot.elements.some(
          (element) => element.name === 'Visible label' && element.role.toLowerCase() === 'textbox'
        )
        const tree = (await registry.target(tabId).debugger.sendCommand('Page.getFrameTree')) as {
          frameTree: { frame: { id: string }; childFrames?: Array<{ frame: { url: string } }> }
        }
        const frameUrls = registry.target(tabId).mainFrame.framesInSubtree.map((frame) => frame.url)
        const crossFrameLoaded = frameUrls.includes('https://httpbin.org/html')
        const crossFrame = registry
          .target(tabId)
          .mainFrame.framesInSubtree.find((frame) => frame.url === 'https://httpbin.org/html')
        const crossFrameBody = crossFrame
          ? ((await crossFrame.executeJavaScript('document.body.innerText')) as string)
          : ''
        const ax = (await registry
          .target(tabId)
          .debugger.sendCommand('Accessibility.getFullAXTree', {
            frameId: tree.frameTree.frame.id,
            depth: 5,
          })) as {
          nodes: Array<{
            nodeId?: string
            parentId?: string
            frameId?: string
            role?: { value?: string }
          }>
        }
        const axRootFrameId = ax.nodes.find(
          (node) => node.role?.value?.toLowerCase() === 'rootwebarea' && !node.parentId
        )?.frameId
        const heading = snapshot.elements[0]
        const readable = await agent.read({
          ...authority,
          snapshotId: snapshot.snapshotId,
          elementRef: heading.ref,
        })
        const mutableRef = snapshot.elements.find(
          (element) => element.name === 'Public agent heading'
        )?.ref
        if (!mutableRef) throw new Error('public heading unavailable')
        await registry.target(tabId).executeJavaScript("document.querySelector('h1').remove()")
        let mutated = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: snapshot.snapshotId,
            elementRef: mutableRef,
          })
        } catch (error) {
          mutated = String(error)
        }
        const attached = registry.target(tabId).debugger.isAttached()
        const inputRef = snapshot.elements.find((element) => element.name === 'Agent query')?.ref
        if (!inputRef) throw new Error('agent input unavailable')
        const preparedFill = agent.prepareInteract({
          ...authority,
          requestId: 'electron-fill',
          snapshotId: snapshot.snapshotId,
          elementRef: inputRef,
          action: 'fill',
          value: 'filled by agent',
          intent: 'Fill agent query',
        })
        await agent.execute({
          preparedId: preparedFill.id,
          proofId: preparedFill.proofId,
          approvalId: 'electron-fill-approval',
          requestId: preparedFill.requestId,
          scope: preparedFill.scope,
          tabId: preparedFill.tabId,
          target: preparedFill.target,
          snapshotId: preparedFill.snapshotId,
          elementRef: preparedFill.elementRef,
          backendNodeId: preparedFill.backendNodeId,
          grantId: preparedFill.grantId,
          grantRequestId: preparedFill.grantRequestId,
          grantRevision: preparedFill.grantRevision,
          revocationEpoch: preparedFill.revocationEpoch,
          action: preparedFill.action,
          intent: preparedFill.intent,
          expiresAt: preparedFill.expiresAt,
        })
        const filledValue = await registry
          .target(tabId)
          .executeJavaScript("document.getElementById('agent-fill-target').value")
        const clickSnapshot = await agent.snapshot(authority)
        const submitRef = clickSnapshot.elements.find(element => element.name === 'Submit query')?.ref
        if (!submitRef) throw new Error('submit target unavailable')
        const preparedClick = agent.prepareSubmit({ ...authority, requestId: 'electron-submit',
          snapshotId: clickSnapshot.snapshotId, elementRef: submitRef, intent: 'Submit query' })
        await agent.execute({ ...preparedClick, preparedId: preparedClick.id, approvalId: 'electron-submit-approval' })
        const pressedButtons = await registry.target(tabId).executeJavaScript('globalThis.agentPressedButtons')
        let wrongGrant = ''
        try {
          await agent.read({
            ...authority,
            grantRevision: 2,
            snapshotId: snapshot.snapshotId,
            elementRef: heading.ref,
          })
        } catch (error) {
          wrongGrant = String(error)
        }
        agent.revoke(tabId)
        const detachedOnRevoke = !registry.target(tabId).debugger.isAttached()
        let revoked = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: snapshot.snapshotId,
            elementRef: heading.ref,
          })
        } catch (error) {
          revoked = String(error)
        }
        const afterRevoke = await agent.snapshot(authority)
        const afterRevokeElement = afterRevoke.elements[0]
        const moved = new Promise<void>((resolveMoved) =>
          registry.target(tabId).once('did-navigate-in-page', () => resolveMoved())
        )
        await registry.target(tabId).executeJavaScript("location.hash = 'agent-ref-stale'")
        await moved
        let hashStale = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterRevoke.snapshotId,
            elementRef: afterRevokeElement.ref,
          })
        } catch (error) {
          hashStale = String(error)
        }
        const afterHash = await agent.snapshot(authority)
        const afterHashElement = afterHash.elements[0]
        await registry.clearData({ kind: 'clear-history' })
        const clearReadable = await agent.read({
          ...authority,
          snapshotId: afterHash.snapshotId,
          elementRef: afterHashElement.ref,
        })
        const afterClear = await agent.snapshot(authority)
        const afterClearElement = afterClear.elements[0]
        await registry.dispatch({ kind: 'reload', tabId })
        let stale = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterClear.snapshotId,
            elementRef: afterClearElement.ref,
          })
        } catch (error) {
          stale = String(error)
        }
        await registry.dispatch({ kind: 'close', tabId })
        let closed = ''
        try {
          await agent.read({
            ...authority,
            snapshotId: afterRevoke.snapshotId,
            elementRef: afterRevokeElement.ref,
          })
        } catch (error) {
          closed = String(error)
        }
        await registry.dispatch({ kind: 'open' })
        let blank = ''
        const blankTabId = registry.snapshot().activeTabId
        if (!blankTabId) throw new Error('blank browser tab unavailable')
        try {
          await agent.snapshot({ ...authority, tabId: blankTabId })
        } catch (error) {
          blank = String(error)
        }
        agent.dispose()
        return {
          attached,
          detachedOnRevoke,
          filledValue,
          pressedButtons,
          visibleLabeledInput,
          heading: readable.name,
          mutated,
          stale,
          hashStale,
          clearReadable: clearReadable.name,
          expectedClearReadable: afterHashElement.name,
          revoked,
          busy,
          wrongGrant,
          closed,
          blank,
          frameLoad,
          crossFrameLoaded,
          crossFrameBody,
          frameUrls,
          pageFrameId: tree.frameTree.frame.id,
          axRootFrameId,
          serialized: JSON.stringify(snapshot),
        }
      })
      assert.equal(result.attached, true)
      assert.equal(result.visibleLabeledInput, true)
      assert.equal(result.filledValue, 'filled by agent')
      assert.equal(result.pressedButtons, 1)
      assert.equal(result.detachedOnRevoke, true)
      assert.equal(result.axRootFrameId, result.pageFrameId)
      assert.equal(result.frameLoad, 'loaded', JSON.stringify({ frameUrls: result.frameUrls,
        crossFrameLoaded: result.crossFrameLoaded, crossFrameBody: result.crossFrameBody }))
      assert.equal(result.crossFrameLoaded, true, JSON.stringify(result.frameUrls))
      assert.match(result.crossFrameBody, /Moby-Dick/)
      assert.ok(result.heading.length > 0)
      assert.match(result.mutated, /stale_ref/)
      assert.match(result.stale, /stale|target_closed/)
      assert.match(result.hashStale, /stale_ref/)
      assert.equal(result.clearReadable, result.expectedClearReadable)
      assert.match(result.busy, /cdp_busy/)
      assert.match(result.wrongGrant, /stale_ref/)
      assert.match(result.revoked, /stale_ref/)
      assert.match(result.closed, /stale_ref/)
      assert.match(result.blank, /permission_denied/)
      assert.match(result.serialized, /Public agent heading/)
      assert.match(result.serialized, /CSS hidden secret/)
      assert.match(result.serialized, /Color hidden secret/)
      assert.match(result.serialized, /Color static secret/)
      assert.match(result.serialized, /Offscreen label secret/)
      assert.match(result.serialized, /Offscreen static secret/)
      assert.match(result.serialized, /Indented label text/)
      assert.match(result.serialized, /Indented static text/)
      assert.match(result.serialized, /Same color label/)
      assert.match(result.serialized, /Same color static text/)
      assert.match(result.serialized, /Restored label/)
      assert.match(result.serialized, /Restored static text/)
      assert.doesNotMatch(
        result.serialized,
        /secret-value|Password label secret|Hidden label secret|Cross frame|Moby-Dick/
      )
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)
