import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'

import { BrowserSearchError, createAgentTransport as createTransport } from './agenttransport.ts'

const SCOPE = {
  session_id: 'session',
  instance_id: 'instance',
  product_turn_id: 'product-turn',
  turn_id: 'turn',
  generation: 1,
  interrupt_generation: 0,
  lifecycle_epoch: 1,
}
const TRANSPORT_CONCURRENCY_CAPACITY = 16
test('full-budget scope drain delivers its local acknowledgement before socket teardown', async () => {
  const controlBudgetMs = 10_000
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    captureLifecycle: () => () => true,
    waitForEffects: async (_scope, signal) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }),
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const ending = await post(transport.port, transport.key, JSON.stringify({
      ...SCOPE, action: 'scope/end', deadline: Date.now() + controlBudgetMs,
    }))
    assert.equal(ending.status, 408)
    assert.deepEqual(JSON.parse(ending.body), { ok: false, error: 'scope_unsettled', phase: 'effects' })
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
      ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next',
    })).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
      ...SCOPE, session_id: 'independent', instance_id: 'independent',
    })).status, 200)
  } finally { await transport.close() }
})
test('action revalidation transports a new read proof without replaying the original prepare', async () => {
  let calls = 0
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
    captureLifecycle: () => () => true,
    prepare: (input) => {
      calls += 1
      assert.equal(input.requestId, 'original-action')
      if (input.readGrant) {
        assert.deepEqual(input.readGrant, { requestId: 'fresh-read', proofId: 'fresh-proof' })
        assert.equal(input.signal.aborted, false)
        throw new Error('stale_ref')
      }
      throw new Error('observation_read_required')
    }, execute: () => { throw new Error('unexpected_execute') }, cancel: () => {},
    waitForEffects: async () => true,
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const original = { ...SCOPE, action: 'prepare-action', request_id: 'original-action',
      tab_id: 'tab', snapshot_id: 'snapshot', element_ref: 'element', browser_action: 'click',
      intent: 'Open result', deadline: Date.now() + 5_000 }
    const required = await post(transport.port, transport.key, JSON.stringify(original))
    assert.equal(required.status, 409)
    assert.deepEqual(JSON.parse(required.body), { ok: false, error: 'observation_read_required' })
    const renewed = { ...original, request_id: 'derived-reprepare', action_request_id: 'original-action',
      grant_request_id: 'fresh-read', proof_id: 'fresh-proof' }
    for (const invalid of [
      { ...renewed, proof_id: undefined }, { ...renewed, action_request_id: undefined },
      { ...renewed, action_request_id: renewed.request_id },
      { ...original, proof_id: 'unpaired-proof' },
    ]) assert.equal((await post(transport.port, transport.key, JSON.stringify(invalid))).status, 400)
    const result = await post(transport.port, transport.key, JSON.stringify(renewed))
    assert.equal(result.status, 409)
    assert.deepEqual(JSON.parse(result.body), { ok: false, error: 'stale_ref' })
    assert.equal((await post(transport.port, transport.key, JSON.stringify(renewed))).body, result.body)
    assert.equal(calls, 2)
  } finally { await transport.close() }
})
test('request drain cannot classify a disposed or replaced action Owner as local', async () => {
  for (const replaced of [false, true]) {
    let owner = { alive: true }
    let release!: () => void
    let entered!: () => void
    let capture!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const captured = new Promise<void>(resolve => { capture = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const transport = await createTransport(() => [], undefined, {
      snapshot: async () => {
        entered()
        await pending
        return { snapshotId: 'late', origin: 'https://example.org', title: 'Page', elements: [] }
      }, read: () => { throw new Error('unused') },
    }, authorizeTestList, undefined, {
      prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
      captureLifecycle: () => {
        const original = owner
        capture()
        return () => original === owner && original.alive
      },
      waitForEffects: async () => true,
    })
    let operation: Promise<unknown> | undefined
    try {
      await scopeCommand(transport.port, transport.key, 'scope/start')
      operation = post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
        action: 'snapshot', request_id: 'pending', grant_request_id: 'grant', proof_id: 'proof',
        tab_id: 'tab', deadline: Date.now() + 5_000 }))
      await started
      const ending = post(transport.port, transport.key,
        JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 }))
      await captured
      if (replaced) owner = { alive: true }
      else owner.alive = false
      const end = await ending
      assert.equal(end.status, 503)
      assert.deepEqual(JSON.parse(end.body), { ok: false, error: 'browser_unavailable' })
      assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
        ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next',
      })).status, 409)
    } finally { release(); await operation; await transport.close() }
  }
})
test('scope effect timer releases only its drain waiter and preserves the old fence', async () => {
  let aborted = false
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    captureLifecycle: () => () => true,
    waitForEffects: async (_scope, signal) => new Promise<boolean>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('request_expired'))
      }, { once: true })
    }),
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const end = await post(transport.port, transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 }))
    assert.equal(end.status, 408)
    assert.deepEqual(JSON.parse(end.body), { ok: false, error: 'scope_unsettled', phase: 'effects' })
    assert.equal(aborted, true)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
      ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next',
    })).status, 409)
  } finally { await transport.close() }
})
test('concurrent scope drain acknowledgements remain idempotent', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<boolean>(resolve => { release = () => resolve(true) })
  const started = new Promise<void>(resolve => { entered = resolve })
  let waiters = 0
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    captureLifecycle: () => () => true,
    waitForEffects: () => { if (++waiters === 2) entered(); return waiting },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const first = scopeCommand(transport.port, transport.key, 'scope/end')
    const second = scopeCommand(transport.port, transport.key, 'scope/end')
    await started
    release()
    assert.equal((await first).status, 200)
    assert.equal((await second).status, 200)
  } finally { release(); await transport.close() }
})
test('scope drain distinguishes its lease timer from an unknown lease rejection', async () => {
  for (const failed of [false, true]) {
    let aborted = false
    const transport = await createTransport(() => [], undefined, undefined, authorizeTestList,
      undefined, undefined, {
        prepare: () => { throw new Error('unused') }, execute: () => { throw new Error('unused') },
        cancel: () => {}, complete: () => {},
        waitForLeases: async (_scope, signal) => {
          if (failed) throw new Error('private failure detail')
          await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('request_expired'))
          }, { once: true }))
        },
      })
    try {
      await scopeCommand(transport.port, transport.key, 'scope/start')
      const end = await post(transport.port, transport.key,
        JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 }))
      assert.equal(end.status, failed ? 503 : 408)
      assert.deepEqual(JSON.parse(end.body), failed
        ? { ok: false, error: 'browser_unavailable' }
        : { ok: false, error: 'scope_unsettled', phase: 'leases' })
      assert.equal(aborted, !failed)
      assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
        ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next',
      })).status, 409)
    } finally { await transport.close() }
  }
})
test('scope drain distinguishes confirmed effect fences from unknown owner failures', async () => {
  for (const failed of [false, true]) {
    const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
      prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
      captureLifecycle: () => () => true,
      waitForEffects: async () => {
        if (failed) throw new Error('private failure detail')
        return false
      },
    })
    try {
      await scopeCommand(transport.port, transport.key, 'scope/start')
      const end = await scopeCommand(transport.port, transport.key, 'scope/end')
      assert.equal(end.status, failed ? 503 : 408)
      assert.deepEqual(JSON.parse(end.body), failed
        ? { ok: false, error: 'browser_unavailable' }
        : { ok: false, error: 'scope_unsettled', phase: 'effects' })
      assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
        ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next',
      })).status, 409)
      assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
        ...SCOPE, session_id: 'independent',
      })).status, 200)
    } finally { await transport.close() }
  }
})
test('snapshot failures preserve bounded codes without leaking page or input text', async () => {
  let failure = 'snapshot_too_large'
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: async () => { throw new Error(failure) },
    read: () => { throw new Error('unused') },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    for (const code of ['snapshot_too_large', 'snapshot_timeout', 'stale_ref', 'stale_grant', 'private page text']) {
      failure = code
      const result = await post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
        action: 'snapshot', request_id: code, grant_request_id: 'grant', proof_id: 'proof',
        tab_id: 'tab', deadline: Date.now() + 5_000 }))
      assert.equal(result.status, code.startsWith('stale_') ? 409 : 503)
      assert.deepEqual(JSON.parse(result.body), { ok: false,
        error: code === 'private page text' ? 'browser_unavailable' : code })
      assert.equal(result.body.includes('private page text'), false)
    }
  } finally { await transport.close() }
})
test('read failures distinguish stale authority without leaking arbitrary page text', async () => {
  let failure = 'stale_ref'
  const transport = await createTransport(() => [], undefined, {
    snapshot: async () => { throw new Error('unused') },
    read: () => { throw new Error(failure) },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    for (const code of ['stale_ref', 'stale_grant', 'private page text']) {
      failure = code
      const result = await post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
        action: 'read', request_id: code, snapshot_id: 'snapshot', element_ref: 'element',
        tab_id: 'tab', deadline: Date.now() + 5_000 }))
      assert.equal(result.status, code === 'private page text' ? 503 : 409)
      assert.deepEqual(JSON.parse(result.body), { ok: false,
        error: code === 'private page text' ? 'browser_unavailable' : code })
      assert.equal(result.body.includes('private page text'), false)
    }
  } finally { await transport.close() }
})
test('expired action references are reported before dispatch without exposing arbitrary failures', async () => {
  let failure = 'stale_grant'
  let executions = 0
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, undefined, {
    prepare: () => { throw new Error(failure) },
    execute: () => { executions += 1 }, cancel: () => {},
    captureLifecycle: () => () => true, waitForEffects: async () => true,
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    for (const code of ['stale_grant', 'stale_ref', 'private page text']) {
      failure = code
      const result = await post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
        action: 'prepare-action', request_id: code, tab_id: 'tab', snapshot_id: 'snapshot',
        element_ref: 'element', browser_action: 'fill', value: 'private input', intent: 'Fill query',
        deadline: Date.now() + 5_000 }))
      assert.equal(result.status, code === 'private page text' ? 503 : 409)
      assert.deepEqual(JSON.parse(result.body), { ok: false,
        error: code === 'private page text' ? 'browser_unavailable' : 'stale_ref' })
      assert.equal(result.body.includes('private input'), false)
    }
    assert.equal(executions, 0)
  } finally { await transport.close() }
})
test('snapshot honors its action deadline instead of the shorter socket idle timeout', { timeout: 25_000 }, async () => {
  const snapshotDelayMs = 11_000
  const actionBudgetMs = 20_000
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: async input => {
      await new Promise(resolve => setTimeout(resolve, snapshotDelayMs))
      assert.equal(input.signal.aborted, false)
      return { snapshotId: 'snapshot', origin: 'https://example.org', title: 'Page', elements: [] }
    },
    read: () => { throw new Error('unused') },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const result = await post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
      action: 'snapshot', request_id: 'slow-snapshot', grant_request_id: 'grant', proof_id: 'proof',
      tab_id: 'tab', deadline: Date.now() + actionBudgetMs }))
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).ok, true)
  } finally { await transport.close() }
})

test('frozen action scope admits only a newer owned-target close without restoring execution', async () => {
  let closures = 0
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    close: input => { assert.equal(input.scope.instanceId, SCOPE.instance_id); closures += 1 },
  }, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    captureLifecycle: () => () => true,
    waitForEffects: async () => false,
  })
  const next = { ...SCOPE, generation: SCOPE.generation + 1,
    interrupt_generation: SCOPE.interrupt_generation + 1,
    product_turn_id: 'cleanup-product-turn', turn_id: 'cleanup-turn' }
  const deadline = Date.now() + 5_000
  const close = { ...next, action: 'close', request_id: 'cleanup-owned', tab_id: 'owned', deadline }
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 408)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', next)).status, 409)
    const closed = await post(transport.port, transport.key, JSON.stringify(close))
    assert.equal(closed.status, 200)
    assert.equal((await post(transport.port, transport.key, JSON.stringify(close))).status, 200)
    assert.equal(closures, 1)
    for (const action of ['list', 'open']) {
      assert.equal((await post(transport.port, transport.key, JSON.stringify({ ...next,
        action, request_id: `blocked-${action}`, deadline }))).status, 409)
    }
    assert.equal((await post(transport.port, transport.key, JSON.stringify({ ...close, tab_id: 'other' }))).status, 409)
    for (const invalid of [{ ...next, instance_id: 'other-instance' }, { ...next, session_id: 'other-session' },
      { ...next, product_turn_id: SCOPE.product_turn_id }, { ...next, turn_id: SCOPE.turn_id }, SCOPE,
      { ...next, generation: next.generation + 1, product_turn_id: 'later-product', turn_id: 'later-turn',
        interrupt_generation: SCOPE.interrupt_generation }]) {
      assert.notEqual((await post(transport.port, transport.key, JSON.stringify({ ...close,
        ...invalid, request_id: 'invalid-cleanup' }))).status, 200)
    }
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', next)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 408)
    assert.equal(closures, 1)
  } finally { await transport.close() }
})

test('a newer revocation watermark aborts an unfinished close without restoring execution', async () => {
  let entered!: () => void
  let release!: () => void
  let closures = 0
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    close: async input => {
      if (input.requestId === 'old-close') { entered(); await blocked }
      if (input.signal.aborted) throw new Error('request_expired')
      closures += 1
    },
  }, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    captureLifecycle: () => () => true,
    waitForEffects: async () => false,
  })
  const next = { ...SCOPE, generation: SCOPE.generation + 1, product_turn_id: 'cleanup-product', turn_id: 'cleanup-turn' }
  const newest = { ...next, generation: next.generation + 1, product_turn_id: 'newest-product', turn_id: 'newest-turn' }
  const deadline = Date.now() + 5_000
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    await scopeCommand(transport.port, transport.key, 'scope/end')
    const pending = post(transport.port, transport.key, JSON.stringify({ ...next, action: 'close',
      request_id: 'old-close', tab_id: 'owned-old', deadline }))
    await started
    assert.equal((await post(transport.port, transport.key, JSON.stringify({ ...newest, action: 'close',
      request_id: 'new-close', tab_id: 'owned-new', deadline }))).status, 200)
    release()
    assert.equal((await pending).status, 409)
    assert.equal(closures, 1)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', newest)).status, 409)
  } finally { release(); await transport.close() }
})

test('owned tab close is scoped, replay-safe, and rejects extra destination fields', async () => {
  let calls = 0
  const transport = await createTransport(() => [], undefined, undefined, () => 1, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    close: input => { assert.equal(input.scope.sessionId, 'session'); assert.equal(input.tabId, 'owned'); calls += 1 },
  })
  const deadline = Date.now() + 5000
  const send = async (action: string, extra = {}) => post(transport.port, transport.key,
    JSON.stringify({ ...SCOPE, action, ...extra, deadline }))
  try {
    assert.equal((await send('close', { request_id: 'early', tab_id: 'owned' })).status, 409)
    await send('scope/start')
    assert.equal(JSON.parse((await send('close', { request_id: 'closed', tab_id: 'owned' })).body).ok, true)
    assert.equal(JSON.parse((await send('close', { request_id: 'closed', tab_id: 'owned' })).body).ok, true)
    assert.equal(calls, 1)
    assert.equal((await send('close', { request_id: 'extra', tab_id: 'owned', url: 'https://example.org' })).status, 400)
    await send('scope/end')
    assert.equal((await send('close', { request_id: 'late', tab_id: 'owned' })).status, 409)
    assert.equal(calls, 1)
  } finally { await transport.close() }
})
test('blank browser open is scoped, replay-safe, and cannot accept a destination', async () => {
  let calls = 0
  const transport = await createTransport(() => [], undefined, undefined, () => 1, {
    prepare: () => { throw new Error('unused') },
    execute: () => {}, cancel: () => {},
    open: async () => { calls += 1; return { tabId: 'created-tab', close() {} } },
  })
  const deadline = Date.now() + 1000
  const send = async (action: string, extra = {}) => JSON.parse((await post(transport.port, transport.key,
    JSON.stringify({ ...SCOPE, action, ...extra, deadline }))).body)
  try {
    await send('scope/start')
    assert.equal((await send('open', { request_id: 'opened' })).tab_id, 'created-tab')
    assert.equal((await send('open', { request_id: 'opened' })).tab_id, 'created-tab')
    assert.equal(calls, 1)
    assert.equal((await send('open', { request_id: 'invalid', url: 'https://example.org' })).ok, false)
    await send('scope/end')
    assert.equal((await send('open', { request_id: 'late' })).ok, false)
  } finally { await transport.close() }
})
test('close admits a successor turn but cancellation cannot dispatch its late close', async () => {
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const transport = await createTransport(() => [], undefined, undefined, () => 1, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    close: async input => {
      if (input.requestId === 'held-close') { entered(); await held }
      if (input.signal.aborted) throw new Error('request_expired')
      calls += 1
    },
  })
  const successor = { ...SCOPE, turn_id: 'next-turn', product_turn_id: 'next-product-turn', generation: 2 }
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    await scopeCommand(transport.port, transport.key, 'scope/end')
    await scopeCommand(transport.port, transport.key, 'scope/start', successor)
    const closed = await post(transport.port, transport.key, JSON.stringify({ ...successor,
      action: 'close', request_id: 'successor-close', tab_id: 'owned', deadline: Date.now() + 5000 }))
    assert.equal(JSON.parse(closed.body).ok, true)
    const pending = post(transport.port, transport.key, JSON.stringify({ ...successor,
      action: 'close', request_id: 'held-close', tab_id: 'owned', deadline: Date.now() + 5000 }))
    await entering
    const ending = scopeCommand(transport.port, transport.key, 'scope/end', successor)
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    assert.equal(JSON.parse((await pending).body).ok, false)
    await ending
    assert.equal(calls, 1)
  } finally { release(); await transport.close() }
})
test('product search is scoped, bounded, and does not expose browser targets', async () => {
  const calls: unknown[] = []
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList,
    undefined, undefined, undefined, async input => {
      calls.push(input)
      if (input.query === 'authorization') throw new BrowserSearchError('browser_search_authorization_required')
      return { url: 'https://www.bing.com/search?q=query', cards: [], challenge: false }
    })
  const payload = { ...SCOPE, action: 'search', request_id: 'search-request',
    engine: 'bing', query: 'query', limit: 3, deadline: Date.now() + 5000 }
  try {
    assert.equal((await post(transport.port, transport.key, JSON.stringify(payload))).status, 409)
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const result = await post(transport.port, transport.key, JSON.stringify(payload))
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).ok, true)
    assert.equal(calls.length, 1)
    const replay = await post(transport.port, transport.key, JSON.stringify(payload))
    assert.equal(replay.body, result.body)
    assert.equal(calls.length, 1)
    const independent = await post(transport.port, transport.key,
      JSON.stringify({ ...payload, request_id: 'independent-search' }))
    assert.equal(independent.status, 200)
    assert.equal(calls.length, 2)
    const denied = await post(transport.port, transport.key,
      JSON.stringify({ ...payload, request_id: 'authorization', query: 'authorization' }))
    assert.equal(JSON.parse(denied.body).error, 'browser_search_authorization_required')
    assert.equal((await post(transport.port, transport.key,
      JSON.stringify({ ...payload, request_id: 'oversized', limit: 21 }))).status, 400)
    assert.equal((await post(transport.port, transport.key,
      JSON.stringify({ ...payload, request_id: 'injected', url: 'https://example.com' }))).status, 400)
    await scopeCommand(transport.port, transport.key, 'scope/end')
    assert.equal((await post(transport.port, transport.key,
      JSON.stringify({ ...payload, request_id: 'late' }))).status, 409)
  } finally { await transport.close() }
})
const authorizeTestList = () => 0
test('search deadline aborts its owner and scope drain joins cleanup before a successor starts', async () => {
  let entered!: () => void
  let release!: () => void
  let aborted = false
  let cleaned = false
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const transport = await createTransport(() => [], undefined, undefined, authorizeTestList,
    undefined, undefined, undefined, async input => {
      input.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      entered()
      try {
        await held
        throw new BrowserSearchError('request_expired')
      } finally { cleaned = true }
    })
  let pending: Promise<unknown> | undefined
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    pending = post(transport.port, transport.key, JSON.stringify({ ...SCOPE, action: 'search',
      request_id: 'deadline-search', engine: 'bing', query: 'deadline', limit: 3,
      deadline: Date.now() + 100 }))
    await started
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(aborted, true)
    assert.equal(cleaned, false)
    const ending = scopeCommand(transport.port, transport.key, 'scope/end')
    const beforeCleanup = await Promise.race([
      ending.then(() => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 20)),
    ])
    assert.equal(beforeCleanup, 'pending')
    release()
    await pending
    assert.equal((await ending).status, 200)
    assert.equal(cleaned, true)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start', {
      ...SCOPE, generation: 2, turn_id: 'next', product_turn_id: 'next',
    })).status, 200)
  } finally { release(); await pending; await transport.close() }
})
test('scope cancellation joins blank-tab creation and closes its late owned target', async () => {
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let closed = 0
  const transport = await createTransport(() => [], undefined, undefined, () => 1, {
    prepare: () => { throw new Error('unused') }, execute: () => {}, cancel: () => {},
    open: async () => { entered(); await held; return { tabId: 'late-tab', close() { closed += 1 } } },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const pending = post(transport.port, transport.key, JSON.stringify({ ...SCOPE,
      action: 'open', request_id: 'opening', deadline: Date.now() + 5000 }))
    await entering
    const ending = scopeCommand(transport.port, transport.key, 'scope/end')
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    assert.equal(JSON.parse((await pending).body).ok, false)
    await ending
    assert.equal(closed, 1)
  } finally { release(); await transport.close() }
})
const createAgentTransport = (
  list: Parameters<typeof createTransport>[0],
  prepareRead?: Parameters<typeof createTransport>[1],
  readActions?: Parameters<typeof createTransport>[2],
  listAuthority: () => number | null = authorizeTestList,
  navigateActions?: Parameters<typeof createTransport>[4]
) => createTransport(list, prepareRead, readActions, listAuthority, navigateActions)

async function scopeCommand(
  port: number,
  key: string,
  action: 'scope/start' | 'scope/end',
  scope = SCOPE
): Promise<{ status: number; body: string }> {
  return post(port, key, JSON.stringify({ ...scope, action, deadline: Date.now() + 5000 }))
}

function post(
  port: number,
  key: string,
  body: string,
  host = `127.0.0.1:${port}`
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/agent/browser',
        method: 'POST',
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          'X-ScholarSeed-Agent-Key': key,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = ''
        response.on('data', (chunk) => {
          data += chunk.toString()
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }))
      }
    )
    call.on('error', reject)
    call.end(body)
  })
}

test('managed transport authenticates one bounded list request and reuses its result', async () => {
  let calls = 0
  const transport = await createAgentTransport(() => {
    calls += 1
    return [{ tab_id: 'safe-tab' }]
  })
  try {
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'request',
      action: 'list',
      deadline: Date.now() + 5000,
    })
    assert.equal((await post(transport.port, '', body)).status, 401)
    assert.equal((await post(transport.port, 'wrong', body)).status, 401)
    assert.equal((await post(transport.port, transport.key, body, 'attacker.test')).status, 403)
    assert.equal((await post(transport.port, transport.key, body)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const accepted = await post(transport.port, transport.key, body)
    assert.equal(accepted.status, 200)
    assert.deepEqual(JSON.parse(accepted.body), { ok: true, tabs: [{ tab_id: 'safe-tab' }] })
    assert.equal((await post(transport.port, transport.key, body)).status, 200)
    assert.equal(calls, 1)
    assert.equal((await post(transport.port, transport.key, '{')).status, 400)
    assert.equal((await post(transport.port, transport.key, 'x'.repeat(20000))).status, 413)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(body), request_id: 'expired', deadline: Date.now() - 1 })
        )
      ).status,
      400
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(body), request_id: 'forged', action: 'evaluate' })
        )
      ).status,
      400
    )
  } finally {
    await transport.close()
  }
})

test('history transport authenticates query proof and never replays approved history results', async () => {
  let executions = 0
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    undefined,
    {
      prepare: (input) => ({
        proofId: 'history-proof',
        requestId: input.requestId,
        scope: input.scope,
        search: input.search,
        offset: input.offset,
        limit: input.limit,
        intent: input.intent,
        queryDigest: 'digest',
        historyRevision: 2,
        policyRevision: 1,
        expiresAt: Date.now() + 60_000,
      }),
      execute: (input) => {
        executions += 1
        assert.equal(input.grantRequestId, 'approval')
        return {
          items: [
            { id: 'visit', url: 'https://example.org/secret', title: 'Secret', visitedAt: 123 },
          ],
          total: 1,
        }
      },
      cancel: () => {},
      complete: () => {},
      waitForLeases: async () => {},
    }
  )
  try {
    const prepare = JSON.stringify({
      ...SCOPE,
      request_id: 'approval',
      action: 'history/prepare',
      search: 'secret',
      offset: 0,
      limit: 1,
      intent: 'Find prior page',
      deadline: Date.now() + 5_000,
    })
    const execute = JSON.stringify({
      ...SCOPE,
      request_id: 'execution',
      action: 'history/execute',
      grant_request_id: 'approval',
      proof_id: 'history-proof',
      deadline: Date.now() + 20_000,
    })
    assert.equal((await post(transport.port, transport.key, prepare)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.equal((await post(transport.port, '', prepare)).status, 401)
    const prepared = await post(transport.port, transport.key, prepare)
    assert.equal(prepared.status, 200)
    assert.deepEqual(Object.keys(JSON.parse(prepared.body).proof).sort(), [
      'expires_at',
      'history_revision',
      'proof_id',
      'query_digest',
      'request_id',
      'scope',
    ])
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(prepare), limit: 21 })
        )
      ).status,
      400
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(prepare), tab_id: 'forged' })
        )
      ).status,
      400
    )
    const accepted = await post(transport.port, transport.key, execute)
    assert.equal(accepted.status, 200)
    assert.equal(JSON.parse(accepted.body).page.items[0].url, 'https://example.org/secret')
    const replay = await post(transport.port, transport.key, execute)
    assert.equal(replay.status, 409)
    assert.equal(replay.body.includes('example.org'), false)
    assert.equal(executions, 1)
  } finally {
    await transport.close()
  }
})

test('scope end waits for a history response lease while complete remains accepted', async () => {
  let releaseLease!: () => void
  const lease = new Promise<void>((resolve) => {
    releaseLease = resolve
  })
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    undefined,
    {
      prepare: (input) => ({
        proofId: 'proof',
        requestId: input.requestId,
        scope: input.scope,
        search: input.search,
        offset: input.offset,
        limit: input.limit,
        intent: input.intent,
        queryDigest: 'digest',
        historyRevision: 1,
        policyRevision: 1,
        expiresAt: Date.now() + 60_000,
      }),
      execute: () => ({ items: [], total: 0 }),
      cancel: () => {
        releaseLease()
      },
      complete: () => {
        releaseLease()
      },
      waitForLeases: () => lease,
    }
  )
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const execute = JSON.stringify({
      ...SCOPE,
      request_id: 'execution',
      action: 'history/execute',
      grant_request_id: 'approval',
      proof_id: 'proof',
      deadline: Date.now() + 5_000,
    })
    assert.equal((await post(transport.port, transport.key, execute)).status, 200)
    let endResolved = false
    const ending = scopeCommand(transport.port, transport.key, 'scope/end').then((result) => {
      endResolved = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(endResolved, false)
    const complete = JSON.stringify({
      ...SCOPE,
      request_id: 'completion',
      action: 'history/complete',
      grant_request_id: 'approval',
      proof_id: 'proof',
      deadline: Date.now() + 5_000,
    })
    assert.equal((await post(transport.port, '', complete)).status, 401)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(complete), tab_id: 'forged' })
        )
      ).status,
      400
    )
    assert.equal((await post(transport.port, transport.key, complete)).status, 200)
    assert.equal((await ending).status, 200)
  } finally {
    await transport.close()
  }
})

test('Agent Browser Use revocation hides cached and in-flight list metadata', async () => {
  let enabled = false
  let revision = 0
  let releaseList!: (value: unknown) => void
  const listing = new Promise<unknown>((resolve) => {
    releaseList = resolve
  })
  const transport = await createAgentTransport(
    () => listing,
    undefined,
    undefined,
    () => (enabled ? revision : null)
  )
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const deadline = Date.now() + 5000
    const payload = (requestId: string) =>
      JSON.stringify({ ...SCOPE, request_id: requestId, action: 'list', deadline })
    const denied = await post(transport.port, transport.key, payload('disabled'))
    assert.equal(denied.status, 503)
    assert.equal(denied.body.includes('Secret tab'), false)
    enabled = true
    revision += 1
    const pending = post(transport.port, transport.key, payload('in-flight'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    enabled = false
    revision += 1
    releaseList([{ tab_id: 'tab', origin: 'https://example.org', title: 'Secret tab' }])
    const cancelled = await pending
    assert.equal(cancelled.status, 503)
    assert.equal(cancelled.body.includes('Secret tab'), false)
    enabled = true
    revision += 1
    const accepted = await post(transport.port, transport.key, payload('visible'))
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.includes('Secret tab'), true)
    enabled = false
    revision += 1
    const replay = await post(transport.port, transport.key, payload('visible'))
    assert.equal(replay.status, 503)
    assert.equal(replay.body.includes('Secret tab'), false)
    enabled = true
    revision += 1
    const oldEpoch = await post(transport.port, transport.key, payload('visible'))
    assert.equal(oldEpoch.status, 503)
    assert.equal(oldEpoch.body.includes('Secret tab'), false)
    assert.equal((await post(transport.port, transport.key, payload('new-epoch'))).status, 200)
  } finally {
    await transport.close()
  }
})

test('list replay renews only its delivery deadline and stays bound to policy epoch and scope', async () => {
  let revision: number | null = 1
  let calls = 0
  const transport = await createAgentTransport(
    () => {
      calls += 1
      return [{ title: 'Private page' }]
    },
    undefined,
    undefined,
    () => revision
  )
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const payload = {
      ...SCOPE,
      request_id: 'deadline-replay',
      action: 'list',
      deadline: Date.now() + 1000,
    }
    assert.equal((await post(transport.port, transport.key, JSON.stringify(payload))).status, 200)
    const renewed = { ...payload, deadline: Date.now() + 4000 }
    assert.equal((await post(transport.port, transport.key, JSON.stringify(renewed))).status, 200)
    assert.equal(calls, 1)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...renewed, deadline: Date.now() - 1 })
        )
      ).status,
      400
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...renewed, deadline: Date.now() + 60_000 })
        )
      ).status,
      400
    )
    for (const field of ['session_id', 'instance_id', 'product_turn_id', 'turn_id']) {
      assert.equal(
        (
          await post(
            transport.port,
            transport.key,
            JSON.stringify({ ...renewed, [field]: 'another' })
          )
        ).status,
        409
      )
    }
    for (const field of ['generation', 'interrupt_generation', 'lifecycle_epoch']) {
      assert.equal(
        (await post(transport.port, transport.key, JSON.stringify({ ...renewed, [field]: 2 })))
          .status,
        409
      )
    }
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...renewed, action: 'prepare-read', tab_id: 'tab', intent: 'Read' })
        )
      ).status,
      409
    )
    revision = null
    assert.equal((await post(transport.port, transport.key, JSON.stringify(renewed))).status, 503)
    revision = 3
    const stale = await post(transport.port, transport.key, JSON.stringify(renewed))
    assert.equal(stale.status, 503)
    assert.equal(stale.body.includes('Private page'), false)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...renewed, request_id: 'fresh-epoch' })
        )
      ).status,
      200
    )
    assert.equal(calls, 2)
  } finally {
    await transport.close()
  }
})

test('an in-flight list replay cannot outlive its own renewed delivery deadline', async () => {
  let release!: (value: unknown) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<unknown>((resolve) => {
    release = resolve
  })
  let calls = 0
  const transport = await createAgentTransport(() => {
    calls += 1
    entered()
    return pending
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const payload = {
      ...SCOPE,
      request_id: 'pending-deadline',
      action: 'list',
      deadline: Date.now() + 4000,
    }
    const first = post(transport.port, transport.key, JSON.stringify(payload))
    await started
    const replay = post(
      transport.port,
      transport.key,
      JSON.stringify({ ...payload, deadline: Date.now() + 30 })
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    release([{ title: 'Private page' }])
    assert.equal((await first).status, 200)
    const expired = await replay
    assert.equal(expired.status, 408)
    assert.equal(expired.body.includes('Private page'), false)
    assert.equal(calls, 1)
  } finally {
    release([])
    await transport.close()
  }
})

test('unavailable Agent Browser Use authority fails closed before reading tabs', async () => {
  let listCalls = 0
  const transport = await createAgentTransport(
    () => {
      listCalls += 1
      return [{ title: 'Secret tab' }]
    },
    undefined,
    undefined,
    () => {
      throw new Error('browser_policy_io_unavailable')
    }
  )
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'unavailable-list',
      action: 'list',
      deadline: Date.now() + 5000,
    })
    const result = await post(transport.port, transport.key, body)
    assert.equal(result.status, 503)
    assert.equal(result.body.includes('Secret tab'), false)
    assert.equal(listCalls, 0)
  } finally {
    await transport.close()
  }
})

test('transport omitting list authority denies metadata by default', async () => {
  const transport = await createTransport(() => [{ title: 'Secret tab' }])
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'default-deny',
      action: 'list',
      deadline: Date.now() + 5000,
    })
    const result = await post(transport.port, transport.key, body)
    assert.equal(result.status, 503)
    assert.equal(result.body.includes('Secret tab'), false)
  } finally {
    await transport.close()
  }
})

test('authenticated prepare-read binds a Main proof to exact scope and request identity', async () => {
  let prepares = 0
  const transport = await createAgentTransport(
    () => [],
    (input) => {
      prepares += 1
      assert.equal(input.scope.instanceId, SCOPE.instance_id)
      assert.equal(input.requestId, 'read-request')
      assert.equal(input.tabId, 'tab')
      assert.equal(input.intent, 'Read current page')
      return {
        proofId: 'main-proof',
        requestId: input.requestId,
        scope: input.scope,
        tabId: input.tabId,
        target: { instanceId: 'tab-instance', generation: 2, origin: 'https://example.org' },
        intent: input.intent,
        expiresAt: Date.now() + 60_000,
        policyRevision: 1,
        policyDecision: 'ask',
      }
    }
  )
  try {
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'read-request',
      action: 'prepare-read',
      tab_id: 'tab',
      intent: 'Read current page',
      deadline: Date.now() + 5_000,
    })
    assert.equal((await post(transport.port, '', body)).status, 401)
    assert.equal((await post(transport.port, transport.key, body)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const result = await post(transport.port, transport.key, body)
    assert.equal(result.status, 200)
    assert.equal(
      (JSON.parse(result.body) as { proof: { proof_id: string } }).proof.proof_id,
      'main-proof'
    )
    assert.equal((await post(transport.port, transport.key, body)).body, result.body)
    assert.equal(prepares, 1)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(body), intent: 'Changed' })
        )
      ).status,
      409
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(body), action: 'snapshot' })
        )
      ).status,
      400
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal((await post(transport.port, transport.key, body)).status, 409)
    assert.equal(prepares, 1)
  } finally {
    await transport.close()
  }
})

test('authenticated snapshot and read use distinct transport IDs and replay their exact result', async () => {
  let snapshots = 0
  let reads = 0
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: (input) => {
      snapshots += 1
      assert.equal(input.scope.instanceId, SCOPE.instance_id)
      assert.equal(input.requestId, 'snapshot-transport')
      assert.equal(input.grantRequestId, 'original-callback')
      assert.equal(input.proofId, 'main-proof')
      assert.equal(input.tabId, 'tab')
      return {
        snapshotId: 'snapshot-id',
        origin: 'https://example.org',
        title: 'Example',
        elements: [{ ref: 'element-ref', role: 'link', name: 'Example link' }],
      }
    },
    read: (input) => {
      reads += 1
      assert.equal(input.scope.productTurnId, SCOPE.product_turn_id)
      assert.equal(input.requestId, 'read-transport')
      assert.equal(input.snapshotId, 'snapshot-id')
      assert.equal(input.elementRef, 'element-ref')
      return { ref: 'element-ref', role: 'link', name: 'Example link' }
    },
  })
  try {
    const snapshot = JSON.stringify({
      ...SCOPE,
      request_id: 'snapshot-transport',
      action: 'snapshot',
      grant_request_id: 'original-callback',
      proof_id: 'main-proof',
      tab_id: 'tab',
      deadline: Date.now() + 20_000,
    })
    const read = JSON.stringify({
      ...SCOPE,
      request_id: 'read-transport',
      action: 'read',
      tab_id: 'tab',
      snapshot_id: 'snapshot-id',
      element_ref: 'element-ref',
      deadline: Date.now() + 20_000,
    })
    assert.equal((await post(transport.port, transport.key, snapshot)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    const first = await post(transport.port, transport.key, snapshot)
    assert.equal(first.status, 200)
    assert.deepEqual(JSON.parse(first.body), {
      ok: true,
      snapshot: {
        snapshot_id: 'snapshot-id',
        origin: 'https://example.org',
        title: 'Example',
        elements: [{ element_ref: 'element-ref', role: 'link', name: 'Example link' }],
      },
    })
    assert.equal((await post(transport.port, transport.key, snapshot)).body, first.body)
    assert.equal(snapshots, 1)
    const second = await post(transport.port, transport.key, read)
    assert.equal(second.status, 200)
    assert.deepEqual(JSON.parse(second.body), {
      ok: true,
      element: { element_ref: 'element-ref', role: 'link', name: 'Example link' },
    })
    assert.equal((await post(transport.port, transport.key, read)).body, second.body)
    assert.equal(reads, 1)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(read), element_ref: 'changed' })
        )
      ).status,
      409
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal((await post(transport.port, transport.key, read)).status, 409)
  } finally {
    await transport.close()
  }
})

test('authenticated cancel-read is scoped and replay-safe before a delayed prepare', async () => {
  let cancellations = 0
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: () => {
      throw new Error('unexpected_snapshot')
    },
    read: () => {
      throw new Error('unexpected_read')
    },
    cancel: (input) => {
      cancellations += 1
      assert.equal(input.scope.instanceId, SCOPE.instance_id)
      assert.equal(input.grantRequestId, 'delayed-prepare')
      assert.equal(input.tabId, 'tab')
    },
  })
  try {
    const cancel = JSON.stringify({
      ...SCOPE,
      request_id: 'cancel-transport',
      action: 'cancel-read',
      grant_request_id: 'delayed-prepare',
      tab_id: 'tab',
      deadline: Date.now() + 5_000,
    })
    assert.equal((await post(transport.port, transport.key, cancel)).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.deepEqual(JSON.parse((await post(transport.port, transport.key, cancel)).body), {
      ok: true,
    })
    assert.equal((await post(transport.port, transport.key, cancel)).status, 200)
    assert.equal(cancellations, 1)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...JSON.parse(cancel), tab_id: 'other-tab' })
        )
      ).status,
      409
    )
  } finally {
    await transport.close()
  }
})

test('expired snapshot dispatch aborts its Main lease and never runs twice', async () => {
  let calls = 0
  let aborted = false
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: (input) =>
      new Promise((_resolve, reject) => {
        calls += 1
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true }
        )
      }),
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'expiring-snapshot',
      action: 'snapshot',
      grant_request_id: 'original-callback',
      proof_id: 'main-proof',
      tab_id: 'tab',
      deadline: Date.now() + 50,
    })
    assert.equal((await post(transport.port, transport.key, body)).status, 408)
    assert.equal(aborted, true)
    assert.equal((await post(transport.port, transport.key, body)).status, 408)
    assert.equal(calls, 1)
  } finally {
    await transport.close()
  }
})

test('completed request body does not abort a live snapshot awaiting its response', async () => {
  const signals: AbortSignal[] = []
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: async (input) => {
      signals.push(input.signal)
      entered()
      await waiting
      return {
        snapshotId: 'live-snapshot',
        origin: 'https://example.org',
        title: 'Example',
        elements: [],
      }
    },
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'live-body-end',
      action: 'snapshot',
      grant_request_id: 'original-callback',
      proof_id: 'main-proof',
      tab_id: 'tab',
      deadline: Date.now() + 5_000,
    })
    const pending = post(transport.port, transport.key, body)
    await started
    assert.equal(signals[0]?.aborted, false)
    release()
    assert.equal((await pending).status, 200)
    assert.equal(signals[0]?.aborted, false)
  } finally {
    release?.()
    await transport.close()
  }
})

test('scope/end does not acknowledge while an admitted browser operation is still in flight', async () => {
  let entered!: () => void
  let release!: () => void
  let aborted = false
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: async (input) => {
      input.signal.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      entered()
      await waiting
      return {
        snapshotId: 'late-snapshot',
        origin: 'https://example.org',
        title: 'Example',
        elements: [],
      }
    },
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  let operation: Promise<{ status: number; body: string }> | null = null
  let ending: Promise<{ status: number; body: string }> | null = null
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const body = JSON.stringify({
      ...SCOPE,
      request_id: 'in-flight-at-end',
      action: 'snapshot',
      grant_request_id: 'original-callback',
      proof_id: 'main-proof',
      tab_id: 'tab',
      deadline: Date.now() + 5_000,
    })
    operation = post(transport.port, transport.key, body)
    await started
    ending = scopeCommand(transport.port, transport.key, 'scope/end')
    const early = await Promise.race([
      ending.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ])
    assert.equal(
      early,
      false,
      'scope/end must not acknowledge before its in-flight operation settles'
    )
    assert.equal(aborted, true)
    release()
    assert.equal((await ending).status, 200)
    assert.notEqual((await operation).status, 200)
  } finally {
    release?.()
    await Promise.allSettled([operation, ending])
    await transport.close()
  }
})

test('scope/end timeout fails closed until the in-flight operation settles and a retry acknowledges', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: async () => {
      entered()
      await waiting
      return {
        snapshotId: 'late-snapshot',
        origin: 'https://example.org',
        title: 'Example',
        elements: [],
      }
    },
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  let operation: Promise<{ status: number; body: string }> | null = null
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    operation = post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        request_id: 'timed-out-end',
        action: 'snapshot',
        grant_request_id: 'original-callback',
        proof_id: 'main-proof',
        tab_id: 'tab',
        deadline: Date.now() + 5_000,
      })
    )
    await started
    const end = await post(
      transport.port,
      transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 })
    )
    assert.equal(end.status, 408)
    assert.deepEqual(JSON.parse(end.body), { ok: false, error: 'scope_unsettled', phase: 'requests' })
    const next = {
      ...SCOPE,
      generation: 2,
      product_turn_id: 'next-product-turn',
      turn_id: 'next-turn',
    }
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', next)).status,
      409
    )
    release()
    assert.notEqual((await operation).status, 200)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', next)).status,
      200
    )
  } finally {
    release?.()
    await Promise.allSettled([operation])
    await transport.close()
  }
})

test('navigate transport binds separate prepare, execute and cancel protocol fields', async () => {
  const calls: string[] = []
  const transport = await createAgentTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: (input) => {
      calls.push('prepare')
      assert.equal(input.url, 'https://example.org/path')
      return {
        proofId: 'navigate-proof',
        requestId: input.requestId,
        scope: input.scope,
        tabId: input.tabId,
        source: { instanceId: 'tab-instance', generation: 0, origin: null },
        url: input.url,
        destinationOrigin: 'https://example.org',
        intent: input.intent,
        expiresAt: Date.now() + 60_000,
        policyRevision: 4,
        policyDecision: 'ask',
      }
    },
    execute: (input) => {
      calls.push('execute')
      assert.equal(input.grantRequestId, 'navigate-callback')
      assert.equal(input.proofId, 'navigate-proof')
    },
    cancel: (input) => {
      calls.push('cancel')
      assert.equal(input.grantRequestId, 'navigate-callback')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const prepare = await post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        action: 'prepare-navigate',
        request_id: 'navigate-callback',
        tab_id: 'tab',
        url: 'https://example.org/path',
        intent: 'Open page',
        deadline: Date.now() + 5_000,
      })
    )
    assert.equal(prepare.status, 200)
    assert.deepEqual(JSON.parse(prepare.body).proof, {
      proof_id: 'navigate-proof',
      request_id: 'navigate-callback',
      scope: {
        sessionId: 'session',
        instanceId: 'instance',
        productTurnId: 'product-turn',
        turnId: 'turn',
        generation: 1,
        interruptGeneration: 0,
        lifecycleEpoch: 1,
      },
      tab_id: 'tab',
      target_instance_id: 'tab-instance',
      target_generation: 0,
      source_origin: null,
      destination_url: 'https://example.org/path',
      destination_origin: 'https://example.org',
      intent: 'Open page',
      expires_at: JSON.parse(prepare.body).proof.expires_at,
      policy_revision: 4,
      policy_decision: 'ask',
    })
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...SCOPE,
            action: 'execute-navigate',
            request_id: 'navigate-dispatch',
            grant_request_id: 'navigate-callback',
            proof_id: 'navigate-proof',
            tab_id: 'tab',
            deadline: Date.now() + 20_000,
          })
        )
      ).status,
      200
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...SCOPE,
            action: 'cancel-navigate',
            request_id: 'navigate-cancel',
            grant_request_id: 'navigate-callback',
            tab_id: 'tab',
            deadline: Date.now() + 5_000,
          })
        )
      ).status,
      200
    )
    assert.deepEqual(calls, ['prepare', 'execute', 'cancel'])
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...SCOPE,
            action: 'execute-navigate',
            request_id: 'forged',
            grant_request_id: 'navigate-callback',
            proof_id: 'navigate-proof',
            tab_id: 'tab',
            snapshot_id: 'read-lease',
            deadline: Date.now() + 20_000,
          })
        )
      ).status,
      400
    )
  } finally {
    await transport.close()
  }
})

test('navigate execute remains in flight until effect idle and blocks next scope after end timeout', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const idle = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: () => {
      throw new Error('unexpected_prepare')
    },
    execute: async (input) => {
      entered()
      await idle
      assert.equal(input.signal.aborted, true)
    },
    cancel: () => {
      throw new Error('unexpected_cancel')
    },
  })
  let action: Promise<{ status: number; body: string }> | null = null
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    action = post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        action: 'execute-navigate',
        request_id: 'nav-effect',
        grant_request_id: 'nav-proof-request',
        proof_id: 'proof',
        tab_id: 'tab',
        deadline: Date.now() + 5_000,
      })
    )
    await started
    const end = await post(
      transport.port,
      transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 })
    )
    assert.equal(end.status, 408)
    const next = { ...SCOPE, generation: 2, product_turn_id: 'next', turn_id: 'next' }
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', next)).status,
      409
    )
    release()
    assert.notEqual((await action).status, 200)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', next)).status,
      200
    )
  } finally {
    release?.()
    await Promise.allSettled([action])
    await transport.close()
  }
})

test('action transport rejects loose fields and replays one exact prepare, execute and cancel', async () => {
  const calls: string[] = []
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    {
      prepare: (input) => {
        calls.push(`prepare:${input.action}`)
        assert.equal(input.snapshotId, 'snapshot')
        assert.equal(input.elementRef, 'element')
        return {
          id: 'prepared-action',
          proofId: 'action-proof',
          requestId: input.requestId,
          action: input.action,
          scope: input.scope,
          tabId: input.tabId,
          target: {
            tabId: input.tabId,
            instanceId: 'target-instance',
            generation: 2,
            origin: 'https://example.org',
            title: 'Example',
            url: 'https://example.org',
          },
          snapshotId: input.snapshotId,
          elementRef: input.elementRef,
          backendNodeId: 7,
          grantId: 'read-grant',
          grantRequestId: 'read-request',
          grantRevision: 3,
          revocationEpoch: 0,
          expiresAt: Date.now() + 30_000,
          consequential: true,
          intent: input.intent,
          element: { role: 'textbox', name: 'Query' },
        }
      },
      execute: (input) => {
        calls.push(`execute:${input.grantRequestId}:${input.proofId}`)
      },
      cancel: (input) => {
        calls.push(`cancel:${input.grantRequestId}`)
      },
      captureLifecycle: () => () => true,
      waitForEffects: async () => true,
    }
  )
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const deadline = Date.now() + 5_000
    const prepare = {
      ...SCOPE,
      request_id: 'action-prepare',
      action: 'prepare-action',
      tab_id: 'tab',
      snapshot_id: 'snapshot',
      element_ref: 'element',
      browser_action: 'fill',
      intent: 'Fill query',
      value: 'secret value',
      deadline,
    }
    assert.equal(
      (await post(transport.port, transport.key, JSON.stringify({ ...prepare, unexpected: true })))
        .status,
      400
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...prepare, browser_action: 'evaluate' })
        )
      ).status,
      400
    )
    assert.equal(
      (await post(transport.port, transport.key, JSON.stringify({ ...prepare, value: 42 }))).status,
      400
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...prepare, value: 'x'.repeat(4_097) })
        )
      ).status,
      400
    )
    const first = await post(transport.port, transport.key, JSON.stringify(prepare))
    assert.equal(first.status, 200)
    assert.equal(first.body.includes('secret value'), false)
    assert.deepEqual(JSON.parse(first.body).proof, {
      prepared_id: 'prepared-action',
      proof_id: 'action-proof',
      request_id: 'action-prepare',
      scope: {
        sessionId: 'session',
        instanceId: 'instance',
        productTurnId: 'product-turn',
        turnId: 'turn',
        generation: 1,
        interruptGeneration: 0,
        lifecycleEpoch: 1,
      },
      tab_id: 'tab',
      target_instance_id: 'target-instance',
      target_generation: 2,
      origin: 'https://example.org',
      snapshot_id: 'snapshot',
      element_ref: 'element',
      backend_node_id: 7,
      grant_id: 'read-grant',
      grant_request_id: 'read-request',
      grant_revision: 3,
      revocation_epoch: 0,
      browser_action: 'fill',
      intent: 'Fill query',
      expires_at: JSON.parse(first.body).proof.expires_at,
      element: { role: 'textbox', name: 'Query' },
    })
    assert.equal(
      (await post(transport.port, transport.key, JSON.stringify(prepare))).body,
      first.body
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({ ...prepare, value: 'another value' })
        )
      ).status,
      409
    )
    const click = {
      ...prepare,
      request_id: 'click-prepare',
      browser_action: 'click',
      value: undefined,
    }
    assert.equal(
      (await post(transport.port, transport.key, JSON.stringify({ ...click, value: 'forbidden' })))
        .status,
      400
    )
    assert.equal((await post(transport.port, transport.key, JSON.stringify(click))).status, 200)
    const submit = { ...click, request_id: 'submit-prepare', browser_action: 'submit' }
    assert.equal((await post(transport.port, transport.key, JSON.stringify(submit))).status, 200)
    const execute = {
      ...SCOPE,
      request_id: 'action-dispatch',
      action: 'execute-action',
      grant_request_id: 'action-prepare',
      proof_id: 'action-proof',
      tab_id: 'tab',
      deadline,
    }
    assert.equal(
      (await post(transport.port, transport.key, JSON.stringify({ ...execute, value: 'leak' })))
        .status,
      400
    )
    assert.equal((await post(transport.port, transport.key, JSON.stringify(execute))).status, 200)
    assert.equal((await post(transport.port, transport.key, JSON.stringify(execute))).status, 200)
    const cancel = {
      ...SCOPE,
      request_id: 'action-cancel',
      action: 'cancel-action',
      grant_request_id: 'action-prepare',
      tab_id: 'tab',
      deadline,
    }
    assert.equal((await post(transport.port, transport.key, JSON.stringify(cancel))).status, 200)
    assert.equal((await post(transport.port, transport.key, JSON.stringify(cancel))).status, 200)
    assert.deepEqual(calls, [
      'prepare:fill',
      'prepare:click',
      'prepare:submit',
      'execute:action-prepare:action-proof',
      'cancel:action-prepare',
    ])
  } finally {
    await transport.close()
  }
})

test('action timeout is unknown and scope/end waits for underlying effect fence', async () => {
  let entered!: () => void
  let release!: () => void
  let effectComplete = false
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const effect = new Promise<void>((resolve) => {
    release = resolve
  })
  let executions = 0
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    {
      prepare: () => {
        throw new Error('unexpected_prepare')
      },
      execute: async () => {
        executions += 1
        entered()
        await effect
        effectComplete = true
      },
      cancel: () => {
        throw new Error('unexpected_cancel')
      },
      captureLifecycle: () => () => true,
      waitForEffects: async () => {
        await effect
        return effectComplete
      },
    }
  )
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const execute = JSON.stringify({
      ...SCOPE,
      request_id: 'delayed-action',
      action: 'execute-action',
      grant_request_id: 'action-prepare',
      proof_id: 'action-proof',
      tab_id: 'tab',
      deadline: Date.now() + 150,
    })
    const pending = post(transport.port, transport.key, execute)
    await started
    const timedOut = await pending
    assert.deepEqual(JSON.parse(timedOut.body), { ok: false, error: 'request_unknown' })
    assert.deepEqual(JSON.parse((await post(transport.port, transport.key, execute)).body), {
      ok: false,
      error: 'request_unknown',
    })
    assert.equal(executions, 1)
    const end = await post(
      transport.port,
      transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 })
    )
    assert.equal(end.status, 408)
    release()
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(effectComplete, true)
  } finally {
    release?.()
    await transport.close()
  }
})

test('scope/end cannot acknowledge an action whose request returned before its CDP effect settles', async () => {
  let release!: () => void
  let effectSettled = false
  const pendingEffect = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    {
      prepare: () => {
        throw new Error('unexpected_prepare')
      },
      execute: () => {
        void pendingEffect.then(() => {
          effectSettled = true
        })
      },
      cancel: () => {
        throw new Error('unexpected_cancel')
      },
      captureLifecycle: () => () => true,
      waitForEffects: async () => {
        await pendingEffect
        return effectSettled
      },
    }
  )
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const execution = await post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        request_id: 'action-returned',
        action: 'execute-action',
        grant_request_id: 'action-grant',
        proof_id: 'action-proof',
        tab_id: 'tab',
        deadline: Date.now() + 5_000,
      })
    )
    assert.equal(execution.status, 200)
    const end = await post(
      transport.port,
      transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 })
    )
    assert.equal(end.status, 408)
    assert.equal(effectSettled, false)
    assert.equal(
      (
        await scopeCommand(transport.port, transport.key, 'scope/start', {
          ...SCOPE,
          generation: 2,
          product_turn_id: 'next',
          turn_id: 'next',
        })
      ).status,
      409
    )
    release()
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(effectSettled, true)
  } finally {
    release?.()
    await transport.close()
  }
})

test('action execute distinguishes a known pre-dispatch refusal from an uncertain failure', async () => {
  let failure = 'action_cancelled_before_dispatch'
  const transport = await createTransport(
    () => [],
    undefined,
    undefined,
    authorizeTestList,
    undefined,
    {
      prepare: () => {
        throw new Error('unexpected_prepare')
      },
      execute: () => {
        throw new Error(failure)
      },
      cancel: () => {
        throw new Error('unexpected_cancel')
      },
      captureLifecycle: () => () => true,
      waitForEffects: async () => true,
    }
  )
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const execute = (requestId: string) =>
      post(
        transport.port,
        transport.key,
        JSON.stringify({
          ...SCOPE,
          request_id: requestId,
          action: 'execute-action',
          grant_request_id: 'action-grant',
          proof_id: 'action-proof',
          tab_id: 'tab',
          deadline: Date.now() + 5_000,
        })
      )
    assert.deepEqual(JSON.parse((await execute('known-refusal')).body), {
      ok: false,
      error: 'action_cancelled_before_dispatch',
    })
    failure = 'cdp_connection_lost'
    const uncertain = JSON.stringify({
      ...SCOPE,
      request_id: 'uncertain',
      action: 'execute-action',
      grant_request_id: 'action-grant',
      proof_id: 'action-proof',
      tab_id: 'tab',
      deadline: Date.now() + 5_000,
    })
    assert.deepEqual(JSON.parse((await post(transport.port, transport.key, uncertain)).body), {
      ok: false,
      error: 'request_unknown',
    })
    assert.deepEqual(JSON.parse((await post(transport.port, transport.key, uncertain)).body), {
      ok: false,
      error: 'request_unknown',
    })
  } finally {
    await transport.close()
  }
})

test('navigate distinguishes known pre-dispatch cancellation from unknown issued outcome', async () => {
  let outcome = 'navigation_cancelled_before_dispatch'
  const transport = await createAgentTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: () => {
      throw new Error('unexpected_prepare')
    },
    execute: () => {
      throw new Error(outcome)
    },
    cancel: () => {
      throw new Error('unexpected_cancel')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const execute = (requestId: string) =>
      post(
        transport.port,
        transport.key,
        JSON.stringify({
          ...SCOPE,
          action: 'execute-navigate',
          request_id: requestId,
          grant_request_id: 'nav-proof-request',
          proof_id: 'proof',
          tab_id: 'tab',
          deadline: Date.now() + 5_000,
        })
      )
    const cancelled = await execute('cancel-before-dispatch')
    assert.equal(cancelled.status, 409)
    assert.deepEqual(JSON.parse(cancelled.body), {
      ok: false,
      error: 'navigation_cancelled_before_dispatch',
    })
    outcome = 'navigation_outcome_unknown'
    const unknown = await execute('issued-unknown')
    assert.equal(unknown.status, 409)
    assert.deepEqual(JSON.parse(unknown.body), { ok: false, error: 'request_unknown' })
  } finally {
    await transport.close()
  }
})

test('admitted navigate deadline reports unknown while idle fence still blocks scope end', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const idle = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, undefined, authorizeTestList, {
    prepare: () => {
      throw new Error('unexpected_prepare')
    },
    execute: async (input) => {
      entered()
      await idle
      assert.equal(input.signal.aborted, true)
    },
    cancel: () => {
      throw new Error('unexpected_cancel')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const response = post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        action: 'execute-navigate',
        request_id: 'nav-timeout',
        grant_request_id: 'nav-proof-request',
        proof_id: 'proof',
        tab_id: 'tab',
        deadline: Date.now() + 150,
      })
    )
    await started
    const outcome = await response
    assert.equal(outcome.status, 409)
    assert.deepEqual(JSON.parse(outcome.body), { ok: false, error: 'request_unknown' })
    const end = await post(
      transport.port,
      transport.key,
      JSON.stringify({ ...SCOPE, action: 'scope/end', deadline: Date.now() + 100 })
    )
    assert.equal(end.status, 408)
    release()
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
  } finally {
    release?.()
    await transport.close()
  }
})

test('client disconnect aborts a started snapshot, caches unknown, and permits another request', async () => {
  let calls = 0
  const signals = new Map<string, AbortSignal>()
  const starts = new Map<string, () => void>()
  let release!: (reason: Error) => void
  const never = new Promise<never>((_resolve, reject) => {
    release = reject
  })
  const transport = await createAgentTransport(() => [{ tab_id: 'safe' }], undefined, {
    snapshot: (input) => {
      calls += 1
      signals.set(input.requestId, input.signal)
      starts.get(input.requestId)?.()
      return never
    },
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    let firstBody = ''
    for (let index = 0; index < TRANSPORT_CONCURRENCY_CAPACITY; index += 1) {
      const requestId = `disconnected-snapshot-${index}`
      const started = new Promise<void>((resolve) => {
        starts.set(requestId, resolve)
      })
      const body = JSON.stringify({
        ...SCOPE,
        request_id: requestId,
        action: 'snapshot',
        grant_request_id: `original-callback-${index}`,
        proof_id: 'main-proof',
        tab_id: 'tab',
        deadline: Date.now() + 5_000,
      })
      if (index === 0) firstBody = body
      const call = request({
        hostname: '127.0.0.1',
        port: transport.port,
        path: '/agent/browser',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${transport.port}`,
          'Content-Type': 'application/json',
          'X-ScholarSeed-Agent-Key': transport.key,
          'Content-Length': Buffer.byteLength(body),
        },
      })
      call.on('error', () => {})
      call.end(body)
      await started
      assert.equal(signals.get(requestId)?.aborted, false)
      call.destroy()
    }
    const replay = await post(transport.port, transport.key, firstBody)
    for (const signal of signals.values()) assert.equal(signal.aborted, true)
    assert.equal(replay.status, 409)
    assert.equal((JSON.parse(replay.body) as { error: string }).error, 'request_unknown')
    assert.equal(calls, TRANSPORT_CONCURRENCY_CAPACITY)
    const list = JSON.stringify({
      ...SCOPE,
      request_id: 'later-list',
      action: 'list',
      deadline: Date.now() + 5_000,
    })
    assert.equal((await post(transport.port, transport.key, list)).status, 200)
  } finally {
    release(new Error('fixture released'))
    await transport.close()
  }
})

test('transport close waits for an aborted snapshot to actually settle', async () => {
  let release!: (reason: Error) => void
  let signal: AbortSignal | undefined
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const transport = await createAgentTransport(() => [], undefined, {
    snapshot: (input) => {
      entered()
      return new Promise<never>((_resolve, reject) => {
        signal = input.signal
        release = reject
      })
    },
    read: () => {
      throw new Error('unexpected_read')
    },
  })
  await scopeCommand(transport.port, transport.key, 'scope/start')
  const body = JSON.stringify({
    ...SCOPE,
    request_id: 'shutdown-snapshot',
    action: 'snapshot',
    grant_request_id: 'original-callback',
    proof_id: 'main-proof',
    tab_id: 'tab',
    deadline: Date.now() + 5_000,
  })
  const pending = post(transport.port, transport.key, body).catch(() => null)
  await started
  let drained = false
  const closing = transport.close().then(() => {
    drained = true
  })
  try {
    await pending
    assert.equal(signal?.aborted, true)
    assert.equal(drained, false)
  } finally {
    release(new Error('fixture released'))
    await closing
  }
  assert.equal(drained, true)
})

test('closed transport rejects stale child capability', async () => {
  const transport = await createAgentTransport(() => [])
  assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
  assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id)?.generation, 1)
  const activeDuringEnd: Array<ReturnType<typeof transport.activeScope>> = []
  transport.onScopeEnd(() => {
    activeDuringEnd.push(transport.activeScope(SCOPE.session_id, SCOPE.turn_id))
  })
  const closing = transport.close()
  assert.deepEqual(activeDuringEnd, [null])
  assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id), null)
  assert.strictEqual(transport.close(), closing)
  await closing
  assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id), null)
  await assert.rejects(post(transport.port, transport.key, '{}'))
})

test('grant scope is visible only while authenticated scope is active and end revokes it', async () => {
  const ended: string[] = []
  const transport = await createAgentTransport(() => [])
  const unsubscribe = transport.onScopeEnd((scope) => {
    ended.push(scope.turnId)
  })
  try {
    assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id), null)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id)?.lifecycleEpoch, 1)
    assert.equal(transport.activeScope(SCOPE.session_id, 'other-turn'), null)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(transport.activeScope(SCOPE.session_id, SCOPE.turn_id), null)
    assert.deepEqual(ended, [SCOPE.turn_id])
  } finally {
    unsubscribe()
    await transport.close()
  }
})

test('in-flight response cannot escape transport shutdown', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const transport = await createAgentTransport(async () => {
    entered()
    await waiting
    return [{ tab_id: 'late' }]
  })
  await scopeCommand(transport.port, transport.key, 'scope/start')
  const body = JSON.stringify({
    ...SCOPE,
    request_id: 'request',
    action: 'list',
    deadline: Date.now() + 5000,
  })
  const pending = post(transport.port, transport.key, body)
  await started
  const rejected = assert.rejects(pending)
  const closing = transport.close()
  await rejected
  release()
  await closing
})

test('request identity remains consumed after its deadline and a new backend rotates the key', async () => {
  let calls = 0
  const first = await createAgentTransport(() => {
    calls += 1
    return []
  })
  const original = { ...SCOPE, request_id: 'once', action: 'list', deadline: Date.now() + 50 }
  try {
    assert.equal((await scopeCommand(first.port, first.key, 'scope/start')).status, 200)
    assert.equal((await post(first.port, first.key, JSON.stringify(original))).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(
      (
        await post(
          first.port,
          first.key,
          JSON.stringify({ ...original, deadline: Date.now() + 5000 })
        )
      ).status,
      200
    )
    assert.equal(calls, 1)
  } finally {
    await first.close()
  }
  const second = await createAgentTransport(() => [])
  try {
    assert.notEqual(second.key, first.key)
    assert.equal(
      (
        await post(
          second.port,
          first.key,
          JSON.stringify({ ...original, deadline: Date.now() + 5000 })
        )
      ).status,
      401
    )
  } finally {
    await second.close()
  }
})

test('distinct identity tuples cannot collide through embedded separators', async () => {
  const transport = await createAgentTransport(() => [])
  try {
    const firstScope = { ...SCOPE, session_id: 'a\0b', turn_id: 'c' }
    const secondScope = { ...SCOPE, session_id: 'a', turn_id: 'b\0c' }
    await scopeCommand(transport.port, transport.key, 'scope/start', firstScope)
    await scopeCommand(transport.port, transport.key, 'scope/start', secondScope)
    const first = { ...firstScope, request_id: 'd', action: 'list', deadline: Date.now() + 5000 }
    const second = { ...secondScope, request_id: 'd', action: 'list', deadline: Date.now() + 5000 }
    assert.equal((await post(transport.port, transport.key, JSON.stringify(first))).status, 200)
    assert.equal((await post(transport.port, transport.key, JSON.stringify(second))).status, 200)
  } finally {
    await transport.close()
  }
})

test('ended scope rejects delayed start and list, while a strictly newer generation reclaims request capacity', async () => {
  let calls = 0
  const transport = await createAgentTransport(() => {
    calls += 1
    return []
  })
  try {
    for (let index = 0; index < 70; index += 1) {
      const scope = {
        ...SCOPE,
        product_turn_id: `product-${index}`,
        turn_id: `turn-${index}`,
        generation: index + 1,
      }
      assert.equal(
        (await scopeCommand(transport.port, transport.key, 'scope/start', scope)).status,
        200
      )
      for (let requestIndex = 0; requestIndex < 64; requestIndex += 1) {
        const body = JSON.stringify({
          ...scope,
          request_id: `request-${requestIndex}`,
          action: 'list',
          deadline: Date.now() + 5000,
        })
        assert.equal((await post(transport.port, transport.key, body)).status, 200)
      }
      assert.equal(
        (await scopeCommand(transport.port, transport.key, 'scope/end', scope)).status,
        200
      )
      assert.equal(
        (await scopeCommand(transport.port, transport.key, 'scope/start', scope)).status,
        409
      )
    }
    assert.equal(calls, 70 * 64)
  } finally {
    await transport.close()
  }
})

test('out-of-order end never closes a newer scope and old list never executes', async () => {
  let calls = 0
  const transport = await createAgentTransport(() => {
    calls += 1
    return []
  })
  const newer = { ...SCOPE, product_turn_id: 'next-product', turn_id: 'next-turn', generation: 2 }
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', newer)).status,
      200
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 409)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...SCOPE,
            request_id: 'old',
            action: 'list',
            deadline: Date.now() + 5000,
          })
        )
      ).status,
      409
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...newer,
            request_id: 'current',
            action: 'list',
            deadline: Date.now() + 5000,
          })
        )
      ).status,
      200
    )
    assert.equal(calls, 1)
  } finally {
    await transport.close()
  }
})

test('closed session admits only a newer durable lifecycle epoch for a replacement instance', async () => {
  let calls = 0
  const transport = await createAgentTransport(() => {
    calls += 1
    return []
  })
  const replacement = {
    ...SCOPE,
    instance_id: 'replacement',
    lifecycle_epoch: 2,
    product_turn_id: 'replacement-product',
    turn_id: 'replacement-turn',
  }
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', replacement)).status,
      409
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (
        await scopeCommand(transport.port, transport.key, 'scope/start', {
          ...replacement,
          lifecycle_epoch: 1,
        })
      ).status,
      409
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', replacement)).status,
      200
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 409)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...SCOPE,
            request_id: 'old',
            action: 'list',
            deadline: Date.now() + 5000,
          })
        )
      ).status,
      409
    )
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...replacement,
            request_id: 'new',
            action: 'list',
            deadline: Date.now() + 5000,
          })
        )
      ).status,
      200
    )
    assert.equal(calls, 1)
  } finally {
    await transport.close()
  }
})

test('end before start leaves a tombstone and cannot revoke a newer active epoch', async () => {
  const transport = await createAgentTransport(() => [])
  const replacement = {
    ...SCOPE,
    instance_id: 'replacement',
    lifecycle_epoch: 2,
    product_turn_id: 'replacement-product',
    turn_id: 'replacement-turn',
  }
  const nextTurn = {
    ...SCOPE,
    product_turn_id: 'next-product',
    turn_id: 'next-turn',
    generation: 2,
  }
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 409)
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', nextTurn)).status,
      200
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/end', nextTurn)).status,
      200
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', replacement)).status,
      200
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 409)
    assert.equal(
      (
        await post(
          transport.port,
          transport.key,
          JSON.stringify({
            ...replacement,
            request_id: 'current',
            action: 'list',
            deadline: Date.now() + 5000,
          })
        )
      ).status,
      200
    )
  } finally {
    await transport.close()
  }
})

test('successor end overtakes delayed start only after the predecessor is closed', async () => {
  const transport = await createAgentTransport(() => [])
  const replacement = {
    ...SCOPE,
    instance_id: 'replacement',
    lifecycle_epoch: 2,
    product_turn_id: 'replacement-product',
    turn_id: 'replacement-turn',
  }
  const later = { ...replacement, instance_id: 'later', lifecycle_epoch: 3 }
  try {
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/start')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/end', replacement)).status,
      409
    )
    assert.equal((await scopeCommand(transport.port, transport.key, 'scope/end')).status, 200)
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/end', replacement)).status,
      200
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', replacement)).status,
      409
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/start', later)).status,
      200
    )
    assert.equal(
      (await scopeCommand(transport.port, transport.key, 'scope/end', replacement)).status,
      409
    )
  } finally {
    await transport.close()
  }
})

test('transport close joins browser work after the request deadline has elapsed', async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = await createAgentTransport(async () => {
    entered()
    await finished
    return []
  })
  try {
    await scopeCommand(transport.port, transport.key, 'scope/start')
    const pending = post(
      transport.port,
      transport.key,
      JSON.stringify({
        ...SCOPE,
        request_id: 'slow-list',
        action: 'list',
        deadline: Date.now() + 100,
      })
    )
    await started
    assert.equal((await pending).status, 408)
    let drained = false
    const closing = transport.close().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(drained, false)
    release()
    await closing
    assert.equal(drained, true)
  } finally {
    release()
    await transport.close()
  }
})
