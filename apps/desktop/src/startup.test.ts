import assert from 'node:assert/strict'
import test from 'node:test'
import { StartupState, STARTUP_PHASE, type StartupSnapshot } from './startup.ts'

test('startup exposes no endpoint until the current attempt completes', () => {
  const snapshots: StartupSnapshot[] = []
  const state = new StartupState(snapshot => snapshots.push(snapshot))
  const first = state.begin()
  assert.equal(state.snapshot().apiBase, null)
  state.fail(first, 'healthTimeout')
  assert.equal(state.snapshot().phase, STARTUP_PHASE.failed)
  const second = state.begin()
  state.complete(first, 'http://127.0.0.1:8000')
  assert.equal(state.snapshot().phase, STARTUP_PHASE.connecting)
  state.complete(second, 'http://127.0.0.1:8000')
  assert.equal(state.snapshot().phase, STARTUP_PHASE.ready)
  state.fail(first, 'exited')
  assert.equal(state.snapshot().phase, STARTUP_PHASE.ready)
  assert.deepEqual(snapshots.map(snapshot => snapshot.revision), [1, 2, 3, 4])
})

test('same-port restart has a distinct generation and invalidates readiness', () => {
  const state = new StartupState(() => {})
  const first = state.begin()
  state.complete(first, 'http://127.0.0.1:8000')
  const second = state.begin()
  assert.notEqual(first, second)
  assert.equal(state.snapshot().apiBase, null)
  state.complete(second, 'http://127.0.0.1:8000')
  assert.equal(state.snapshot().generation, second)
})

test('startup rejects non-loopback endpoints', () => {
  const state = new StartupState(() => {})
  const generation = state.begin()
  assert.throws(() => state.complete(generation, 'https://attacker.invalid'))
  assert.equal(state.snapshot().phase, STARTUP_PHASE.connecting)
})
