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
  const state: OfficeHostState = reconcileOfficeHosts(
    { hosts: [] }, ['a', 'b', 'c'], ids()
  )
  assert.deepEqual(state.hosts, [{ id: 'host-1', viewId: 'a' }])
  assert.deepEqual(state.queuedViewIds, ['b', 'c'])
})

test('the active demand retains its singleton host', () => {
  const nextId = ids()
  const first = reconcileOfficeHosts({ hosts: [] }, ['a'], nextId)
  const second = reconcileOfficeHosts(first, ['a'], nextId)
  assert.equal(second, first)
})
