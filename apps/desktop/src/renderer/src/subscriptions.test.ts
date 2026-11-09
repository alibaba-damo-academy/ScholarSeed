import assert from 'node:assert/strict'
import test from 'node:test'
import { ExclusiveSubscription } from './subscriptions.ts'

test('foreground handoff closes old stream before new open and rejects delayed recovery', () => {
  const budget = new ExclusiveSubscription()
  let active = 0
  let maximum = 0
  const open = (): (() => void) => {
    active++
    maximum = Math.max(maximum, active)
    return () => {
      active--
    }
  }
  const old = budget.claim('old')
  old.attach(open)
  const next = budget.claim('next')
  assert.equal(old.current(), false)
  old.attach(open)
  next.attach(open)
  assert.equal(maximum, 1)
  budget.clear()
  next.attach(open)
  assert.equal(active, 0)
})

test('ten sessions and late retry callbacks never exceed one body subscription', () => {
  const budget = new ExclusiveSubscription()
  let active = 0
  let maximum = 0
  const open = (): (() => void) => {
    active++
    maximum = Math.max(maximum, active)
    return () => {
      active--
    }
  }
  const leases = Array.from({ length: 10 }, (_, index) => {
    const lease = budget.claim(`session-${index}`)
    lease.attach(open)
    return lease
  })
  for (const lease of leases.slice(0, -1)) lease.attach(open)
  assert.equal(active, 1)
  assert.equal(maximum, 1)
  budget.retain(null)
  for (const lease of leases) lease.attach(open)
  assert.equal(active, 0)
})
