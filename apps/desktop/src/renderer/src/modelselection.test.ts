import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelSelectionGuard } from './modelselection.ts'

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

test('reload fences a pending write until the service instance changes', () => {
  const ledger = storage()
  const old = createModelSelectionGuard(ledger, () => 'old')
  old.begin('service-1', 'session-1')
  assert.equal(old.unknown('service-1', 'session-1'), false)
  assert.equal(old.blocked('service-1', 'session-1'), true)
  assert.equal(old.blocked(null, 'session-1'), true)
  assert.equal(old.blocked('service-1', 'session-2'), false)
  assert.equal(old.blocked('service-2', 'session-1'), false)
  const reloaded = createModelSelectionGuard(ledger, () => 'new')
  assert.equal(reloaded.unknown('service-1', 'session-1'), true)
  assert.equal(reloaded.unknown('service-1', 'session-2'), false)
  assert.equal(reloaded.unknown('service-2', 'session-1'), false)
  assert.throws(() => reloaded.begin('service-1', 'session-1'))
})

test('out-of-order concurrent results cannot erase an unknown operation', () => {
  const ledger = storage()
  let id = 0
  const guard = createModelSelectionGuard(ledger, () => String(++id))
  const first = guard.begin('service', 'session')
  const second = guard.begin('service', 'session')
  assert.equal(guard.finish(second, false), false)
  assert.equal(guard.finish(first, true), true)
  assert.equal(guard.unknown('service', 'session'), true)
  assert.equal(guard.blocked('service', 'session'), true)
  assert.equal(createModelSelectionGuard(ledger, () => 'next').unknown('service', 'session'), true)
})

test('failure to write or read the ledger fails closed', () => {
  const ledger = storage()
  const guard = createModelSelectionGuard(ledger, () => 'id')
  ledger.setItem = () => {
    throw new Error('quota')
  }
  assert.throws(() => guard.begin('service', 'session'))
  ledger.key = () => {
    throw new Error('unavailable')
  }
  Object.defineProperty(ledger, 'length', { get: () => 1 })
  assert.equal(guard.unknown('service', 'session'), true)
  assert.equal(guard.blocked('service', 'session'), true)
})

test('a failed marker removal stays fenced even after a successful response', () => {
  const ledger = storage()
  const guard = createModelSelectionGuard(ledger, () => 'id')
  const key = guard.begin('service', 'session')
  ledger.removeItem = () => {
    throw new Error('storage unavailable')
  }
  assert.equal(guard.finish(key, true), false)
  assert.equal(guard.unknown('service', 'session'), true)
})
