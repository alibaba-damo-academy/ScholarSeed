import assert from 'node:assert/strict'
import test from 'node:test'

import { createResourceListingRefresh } from './refresh.ts'

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('overlapping resource invalidations keep one read and publish one fresh result', async () => {
  const reads: ((value: string) => void)[] = []
  const published: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result) => published.push(result)
  )

  refresh.request()
  refresh.request()
  await flush()
  assert.equal(reads.length, 1)

  refresh.request()
  refresh.request()
  await flush()
  assert.equal(reads.length, 1)
  reads[0]('before change')
  await flush()
  assert.equal(reads.length, 2)
  assert.deepEqual(published, [])

  reads[1]('after change')
  await flush()
  assert.deepEqual(published, ['after change'])
  assert.equal(reads.length, 2)

  refresh.request()
  await flush()
  assert.equal(reads.length, 3)
  reads[2]('later refresh')
  await flush()
  assert.deepEqual(published, ['after change', 'later refresh'])
})

test('disposing a resource listing suppresses queued reads and stale publication', async () => {
  const reads: ((value: string) => void)[] = []
  const published: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result) => published.push(result)
  )
  refresh.request()
  await flush()
  refresh.request()
  refresh.dispose()
  reads[0]('old project')
  refresh.request()
  await flush()

  assert.equal(reads.length, 1)
  assert.deepEqual(published, [])
})

test('resource refresh exposes a failure and accepts a later retry', async () => {
  const published: (string | null)[] = []
  let attempts = 0
  const refresh = createResourceListingRefresh(
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('network unavailable')
      return 'recovered'
    },
    (result) => published.push(result)
  )

  refresh.request()
  await flush()
  assert.deepEqual(published, [null])

  refresh.request()
  await flush()
  assert.deepEqual(published, [null, 'recovered'])
})
