import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_CONVERSATION } from './conversation.ts'
import { PreviewTransport, PreviewTransportError } from './transport.ts'

const POLICY = { mode: 'failure', disconnectAfterDeltas: 2 } as const
const CLOSED = { code: 'preview_transport_disposed', message: 'preview_transport_disposed', status: 410 }

test('initial handshakes are immediate and no configured outage means no fault', async () => {
  const owner = new PreviewTransport({ mode: 'chat' })
  await owner.wait()
  for (let index = 0; index < 5; index += 1) assert.equal(owner.observeDelta(true), false)
  await owner.wait()
  owner.dispose()
})

test('the threshold faults once only with a subscriber, including after a subscriber arrives', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport(POLICY)
  assert.equal(owner.observeDelta(false), false)
  assert.equal(owner.observeDelta(false), false)
  assert.equal(owner.observeDelta(true), true)
  assert.equal(owner.observeDelta(true), false)
  const ready = owner.wait()
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs)
  await ready
  assert.equal(owner.observeDelta(true), false)
  await owner.wait()
  owner.dispose()
})

test('concurrent and later handshakes share the first reconnect ready time', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1 })
  assert.equal(owner.observeDelta(true), true)
  let completed = 0
  const first = owner.wait().then(() => { completed += 1 })
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs - 1)
  const second = owner.wait().then(() => { completed += 1 })
  await Promise.resolve()
  assert.equal(completed, 0)
  context.mock.timers.tick(1)
  await Promise.all([first, second])
  assert.equal(completed, 2)
  await owner.wait()
  owner.dispose()
})

test('domain timer cleanup does not cancel the independent reconnect handshake', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1 })
  const domainTimers = new Set([setTimeout(() => assert.fail('domain action after finish'), PREVIEW_CONVERSATION.tickMs)])
  owner.observeDelta(true)
  const ready = owner.wait()
  for (const timer of domainTimers) clearTimeout(timer)
  domainTimers.clear()
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs)
  await ready
  owner.dispose()
})

test('individual abort only rejects its own wait and does not extend the shared outage', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1 })
  owner.observeDelta(true)
  const signal = new AbortController()
  const aborted = assert.rejects(owner.wait(signal.signal), CLOSED)
  const other = owner.wait()
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs - 1)
  signal.abort('private reason must not escape')
  await aborted
  context.mock.timers.tick(1)
  await other
  await owner.wait()
  owner.dispose()
})

test('an already aborted first caller does not begin or consume the reconnect window', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1 })
  owner.observeDelta(true)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(owner.wait(aborted.signal), CLOSED)
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs)
  let ready = false
  const handshake = owner.wait().then(() => { ready = true })
  await Promise.resolve()
  assert.equal(ready, false)
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs)
  await handshake
  owner.dispose()
})

test('dispose cancels every pending caller, rejects future use and does not leak abort reasons', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1 })
  owner.observeDelta(true)
  const controller = new AbortController()
  const first = assert.rejects(owner.wait(controller.signal), CLOSED)
  const second = assert.rejects(owner.wait(), CLOSED)
  owner.dispose()
  owner.dispose()
  controller.abort()
  await Promise.all([first, second])
  await assert.rejects(owner.wait(), CLOSED)
  assert.throws(() => owner.observeDelta(true), PreviewTransportError)
  context.mock.timers.tick(PREVIEW_CONVERSATION.reconnectDelayMs)
})

test('zero delay is immediately ready and policy input mutation cannot change the owner', async () => {
  const policy = { mode: POLICY.mode, disconnectAfterDeltas: 2, reconnectDelayMs: 0 }
  const owner = new PreviewTransport(policy)
  policy.disconnectAfterDeltas = 100
  assert.equal(owner.observeDelta(true), false)
  assert.equal(owner.observeDelta(true), true)
  await owner.wait()
  await owner.wait()
  owner.dispose()
})

test('a new owner resets the one-shot fault without inheriting disposed state', async () => {
  const first = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1, reconnectDelayMs: 0 })
  assert.equal(first.observeDelta(true), true)
  await first.wait()
  first.dispose()
  const next = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1, reconnectDelayMs: 0 })
  await next.wait()
  assert.equal(next.observeDelta(true), true)
  next.dispose()
})

test('a shorter declared reconnect policy is honored and aborting every caller does not restart its clock', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const delay = PREVIEW_CONVERSATION.tickMs
  const owner = new PreviewTransport({ ...POLICY, disconnectAfterDeltas: 1, reconnectDelayMs: delay })
  owner.observeDelta(true)
  const controller = new AbortController()
  const first = assert.rejects(owner.wait(controller.signal), CLOSED)
  controller.abort()
  await first
  context.mock.timers.tick(delay)
  await owner.wait()
  owner.dispose()
})

test('invalid delta thresholds never accidentally consume or trigger an outage', async () => {
  for (const disconnectAfterDeltas of [0, -1, 0.5, Infinity, NaN]) {
    const owner = new PreviewTransport({ mode: 'streaming', disconnectAfterDeltas })
    assert.equal(owner.observeDelta(true), false)
    await owner.wait()
    owner.dispose()
  }
})
