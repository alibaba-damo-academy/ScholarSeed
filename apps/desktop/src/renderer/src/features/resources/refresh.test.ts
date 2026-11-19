import assert from 'node:assert/strict'
import test from 'node:test'

import { createResourceListingRefresh } from './refresh.ts'

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('overlapping resource invalidations publish the first snapshot before one catch-up', async () => {
  const reads: ((value: string) => void)[] = []
  const published: { result: string | null; refreshing: boolean }[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result, refreshing) => published.push({ result, refreshing })
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
  assert.deepEqual(published, [{ result: 'before change', refreshing: true }])

  reads[1]('after change')
  await flush()
  assert.deepEqual(published, [
    { result: 'before change', refreshing: true },
    { result: 'after change', refreshing: false },
  ])
  assert.equal(reads.length, 2)

  refresh.request()
  await flush()
  assert.equal(reads.length, 3)
  reads[2]('later refresh')
  await flush()
  assert.deepEqual(published.at(-1), { result: 'later refresh', refreshing: false })
})

test('disposing a resource listing suppresses an in-flight catch-up and further reads', async () => {
  const reads: ((value: string) => void)[] = []
  const published: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result) => published.push(result)
  )
  refresh.request()
  await flush()
  refresh.request()
  reads[0]('first snapshot')
  await flush()
  assert.equal(reads.length, 2)
  refresh.request()
  refresh.dispose()
  reads[1]('old project')
  refresh.request()
  await flush()

  assert.equal(reads.length, 2)
  assert.deepEqual(published, ['first snapshot'])
})

test('a resource read publishes a failure only when its queue has drained', async () => {
  const reads: ((value: string | null) => void)[] = []
  const published: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string | null>((resolve) => reads.push(resolve)),
    (result) => published.push(result)
  )
  refresh.request()
  await flush()
  refresh.request()
  reads[0](null)
  await flush()
  assert.equal(reads.length, 2)
  assert.deepEqual(published, [])

  refresh.request()
  reads[1]('available snapshot')
  await flush()
  assert.equal(reads.length, 3)
  assert.deepEqual(published, ['available snapshot'])

  reads[2](null)
  await flush()
  assert.deepEqual(published, ['available snapshot', null])
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
