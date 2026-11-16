import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeStorageBindings } from './storagebinding.ts'
import type { StorageBindingNative } from './storagebinding.ts'

const id = (n: number) => 'windows:' + '0'.repeat(16) + ':' + n.toString(16).padStart(32, '0')
const selected = {
  home: '/home',
  userData: '/profile',
  sessionData: '/session',
  source: { kind: 'default' as const },
}
function fixture() {
  const lineages = new Map([
    ['/home', [id(0), id(1)]],
    ['/profile', [id(0), id(2)]],
    ['/session', [id(0), id(3)]],
  ])
  const released: unknown[] = []
  const native: StorageBindingNative = {
    pin: (path, create) => {
      assert.equal(create, false)
      if (!lineages.has(path)) throw new Error('missing')
      return path
    },
    lineage: (pin) => lineages.get(pin as string)!,
    release: (pin) => {
      released.push(pin)
    },
    readAt: () => {
      throw new Error('binding must not read configuration')
    },
  }
  return { native, lineages, released }
}

test('storage bindings are copied, deeply frozen and release every pin', () => {
  const { native, lineages, released } = fixture()
  const bindings = observeStorageBindings(native, selected)
  lineages.get('/home')!.fill(id(9))
  assert.equal(bindings[0].identity, id(1))
  assert.deepEqual(bindings[0].ancestors, [id(0)])
  assert(
    Object.isFrozen(bindings) &&
      Object.isFrozen(bindings[0]) &&
      Object.isFrozen(bindings[0].ancestors)
  )
  assert.deepEqual(released, ['/session', '/profile', '/home'])
})

test('environment home still observes userData and Chromium sessionData', () => {
  const { native, lineages } = fixture()
  const selection = { ...selected, source: { kind: 'environment' as const, value: '/home' } }
  assert.deepEqual(
    observeStorageBindings(native, selection).map((value) => value.path),
    ['/home', '/profile', '/session']
  )
  lineages.delete('/session')
  assert.throws(() => observeStorageBindings(native, selection), /missing/)
  lineages.set('/session', [id(0), id(3)])
  lineages.delete('/profile')
  assert.throws(() => observeStorageBindings(native, selection), /missing/)
})

test('coincident selected roots have one identity observation', () => {
  const { native } = fixture()
  assert.equal(
    observeStorageBindings(native, { ...selected, sessionData: selected.home }).length,
    2
  )
})

test('failed observation cleans up; uncertain release retains remaining pins', () => {
  const { native, lineages, released } = fixture()
  lineages.set('/profile', ['invalid'])
  assert.throws(() => observeStorageBindings(native, selected), /Invalid/)
  assert.deepEqual(released, ['/profile', '/home'])
  released.length = 0
  native.release = (pin) => {
    released.push(pin as string)
    throw Object.assign(new Error('close'), { code: 'ERR_LEASE_RELEASE' })
  }
  assert.throws(() => observeStorageBindings(native, selected), AggregateError)
  assert.deepEqual(released, ['/profile'])
})
