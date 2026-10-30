import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileOfficeHosts, type OfficeHostState } from './hosts.ts'

function ids(): () => string {
  let value = 0
  return () => `host-${++value}`
}

test('the first demanded view owns the singleton host', () => {
  const state = reconcileOfficeHosts({ hosts: [] }, ['tab-a'], ids())
  assert.deepEqual(state, { hosts: [{ id: 'host-1', viewId: 'tab-a' }], queuedViewIds: [] })
})

test('the singleton host is reassigned instead of recreated', () => {
  const nextId = ids()
  const opened = reconcileOfficeHosts({ hosts: [] }, ['tab-a'], nextId)
  const replaced = reconcileOfficeHosts(opened, ['tab-b'], nextId)
  assert.deepEqual(replaced, { hosts: [{ id: 'host-1', viewId: 'tab-b' }], queuedViewIds: [] })
})

test('only the first demanded view is assigned and remaining views wait', () => {
  const state: OfficeHostState = reconcileOfficeHosts({ hosts: [] }, ['a', 'b', 'c'], ids())
  assert.deepEqual(state.hosts, [{ id: 'host-1', viewId: 'a' }])
  assert.deepEqual(state.queuedViewIds, ['b', 'c'])
})

test('the active demand retains its singleton host', () => {
  const nextId = ids()
  const first = reconcileOfficeHosts({ hosts: [] }, ['a'], nextId)
  const second = reconcileOfficeHosts(first, ['a'], nextId)
  assert.equal(second, first)
})

test('no Office demand leaves the runtime unallocated', () => {
  const initial: OfficeHostState = { hosts: [] }
  assert.equal(
    reconcileOfficeHosts(initial, [], () => {
      throw new Error('unused host allocated')
    }),
    initial
  )
})

test('application prewarm allocates one unbound host without document demand', () => {
  const nextId = ids()
  const state = reconcileOfficeHosts({ hosts: [] }, [], nextId, true)
  assert.deepEqual(state, { hosts: [{ id: 'host-1', viewId: null }], queuedViewIds: [] })
  assert.equal(reconcileOfficeHosts(state, [], nextId, true), state)
})

test('early document demand and later idle prewarm share the same host', () => {
  const nextId = ids()
  const demand = reconcileOfficeHosts({ hosts: [] }, ['a'], nextId)
  assert.equal(reconcileOfficeHosts(demand, ['a'], nextId, true), demand)
  const idle = reconcileOfficeHosts(demand, [], nextId, true)
  assert.deepEqual(idle.hosts, [{ id: 'host-1', viewId: null }])
  assert.deepEqual(reconcileOfficeHosts(idle, ['b'], nextId, true).hosts, [{ id: 'host-1', viewId: 'b' }])
})

test('closing the final document keeps the warm host for the next demand', () => {
  const nextId = ids()
  const opened = reconcileOfficeHosts({ hosts: [] }, ['a'], nextId)
  const closed = reconcileOfficeHosts(opened, [], nextId)
  assert.deepEqual(closed, { hosts: [{ id: 'host-1', viewId: null }], queuedViewIds: [] })
  assert.equal(reconcileOfficeHosts(closed, [], nextId), closed)
  assert.deepEqual(reconcileOfficeHosts(closed, ['b'], nextId), {
    hosts: [{ id: 'host-1', viewId: 'b' }],
    queuedViewIds: [],
  })
})
