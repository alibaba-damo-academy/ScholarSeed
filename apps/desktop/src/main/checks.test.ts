import assert from 'node:assert/strict'
import test from 'node:test'
import { nextUpdateCheckAt, UpdateChecks } from './checks.ts'

test('concurrent surface and timer checks share a request and failure permits retry', async () => {
  let attempts = 0
  const checks = new UpdateChecks(async () => {
    if (++attempts === 1) throw new Error('offline')
    return { has_update: false, latest: null }
  })
  const first = checks.run(),
    second = checks.run()
  assert.equal(first, second)
  await assert.rejects(first, /offline/)
  assert.deepEqual(await checks.run(), { has_update: false, latest: null, checkRevision: 0 })
  assert.equal(attempts, 2)
})

test('preparation deadline wakes before a distant metadata poll', () => {
  assert.equal(
    nextUpdateCheckAt({ now: 1000, periodicAt: 30_000, preparationAt: 4000, retryAt: 0 }),
    4000
  )
  assert.equal(
    nextUpdateCheckAt({ now: 5000, periodicAt: 30_000, preparationAt: 4000, retryAt: 0 }),
    5000
  )
})

test('failed metadata checks retain a retry floor even with an overdue preparation', () => {
  assert.equal(
    nextUpdateCheckAt({ now: 5000, periodicAt: 30_000, preparationAt: 4000, retryAt: 6000 }),
    6000
  )
  assert.equal(nextUpdateCheckAt({ now: 5000, periodicAt: 30_000, retryAt: 6000 }), 30_000)
})

test('invalidating a policy check starts a fresh request and old completion cannot clear it', async () => {
  const releases: Array<(result: { has_update: boolean; latest: null }) => void> = []
  const checks = new UpdateChecks(() => new Promise((resolve) => releases.push(resolve)))
  const old = checks.run()
  await Promise.resolve()
  checks.invalidate()
  const fresh = checks.run()
  await Promise.resolve()
  assert.notEqual(old, fresh)
  releases[0]({ has_update: false, latest: null })
  assert.equal(checks.isCurrent(await old), false)
  assert.equal(checks.run(), fresh)
  releases[1]({ has_update: false, latest: null })
  assert.equal(checks.isCurrent(await fresh), true)
})
