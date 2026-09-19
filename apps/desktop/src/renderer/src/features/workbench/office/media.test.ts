import assert from 'node:assert/strict'
import test from 'node:test'
import { OfficeImageLeases } from './media.ts'

test('save snapshot cannot clean an image inserted after serialization', async () => {
  const removed: string[] = []
  const leases = new OfficeImageLeases<string>(async value => { removed.push(value) }, error => assert.fail(String(error)))
  await leases.add('first', 'first')
  const saved = leases.snapshot()
  await leases.add('later', 'later')
  assert.deepEqual(removed, [], 'failed or unacknowledged saves retain assets')
  await leases.remove(saved)
  assert.deepEqual(removed, ['first'])
  assert.deepEqual(leases.snapshot(), ['later'])
})

test('late upload after document disposal cleans its own receipt and cannot insert', async () => {
  const removed: string[] = []
  const leases = new OfficeImageLeases<string>(async value => { removed.push(value) }, error => assert.fail(String(error)))
  leases.dispose()
  assert.equal(await leases.add('late', 'receipt'), false)
  assert.deepEqual(removed, ['receipt'])
})

test('failed cleanup remains retryable and reports the failure', async () => {
  let reject = true
  let failures = 0
  const leases = new OfficeImageLeases<string>(async () => { if (reject) throw new Error('conflict') }, () => { failures++ })
  await leases.add('one', 'receipt')
  await leases.remove(leases.snapshot())
  assert.deepEqual(leases.snapshot(), ['one'])
  assert.equal(failures, 1)
  reject = false
  await leases.remove(leases.snapshot())
  assert.deepEqual(leases.snapshot(), [])
})
