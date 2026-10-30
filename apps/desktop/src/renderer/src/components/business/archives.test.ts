import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArchiveReader } from './archives.ts'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  for (let step = 0; step < 6; step += 1) await Promise.resolve()
}

test('archive background invalidations coalesce without cancelling an in-flight read or starving its publication', async () => {
  const flights: ReturnType<typeof deferred<number>>[] = []
  const active: (() => boolean)[] = []
  const results: number[] = []
  const reader = createArchiveReader(
    (alive) => {
      const flight = deferred<number>()
      flights.push(flight)
      active.push(alive)
      return flight.promise
    },
    (result) => results.push(result),
    () => assert.fail('unexpected rejection')
  )
  reader.request()
  reader.request()
  reader.request()
  assert.equal(
    flights.length,
    1,
    'background polling must not replace the still-running list request'
  )
  assert.equal(active[0](), true)
  flights[0].resolve(1)
  await flush()
  assert.deepEqual(results, [1])
  assert.equal(flights.length, 2, 'all invalidations must coalesce to one follow-up request')
  reader.request()
  flights[1].resolve(2)
  await flush()
  assert.deepEqual(results, [1, 2])
  assert.equal(flights.length, 3)
  reader.dispose()
  flights[2].resolve(3)
  await flush()
  assert.deepEqual(results, [1, 2])
})

test('local retry or mutation creates a new reader generation and old completion cannot overwrite it', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const values: string[] = []
  let oldActive!: () => boolean
  const old = createArchiveReader(
    (active) => {
      oldActive = active
      return first.promise
    },
    (result) => values.push(result),
    () => assert.fail('stale failure')
  )
  old.request()
  old.request()
  old.dispose()
  assert.equal(oldActive(), false)
  const current = createArchiveReader(
    () => second.promise,
    (result) => values.push(result),
    () => assert.fail('unexpected failure')
  )
  current.request()
  second.resolve('after mutation')
  await flush()
  first.resolve('before mutation')
  await flush()
  assert.deepEqual(values, ['after mutation'])
  current.dispose()
})

test('archive read failure is observable and a queued background refresh can recover without a rejected stale write', async () => {
  const flights = [deferred<number>(), deferred<number>()]
  let reads = 0
  let errors = 0
  const results: number[] = []
  const reader = createArchiveReader(
    () => flights[reads++].promise,
    (result) => results.push(result),
    () => {
      errors += 1
    }
  )
  reader.request()
  reader.request()
  flights[0].reject(new Error('unavailable'))
  await flush()
  assert.equal(errors, 1)
  assert.equal(reads, 2)
  flights[1].resolve(2)
  await flush()
  assert.deepEqual(results, [2])
  reader.dispose()
  reader.request()
  assert.equal(reads, 2)
})

test('awaiting an archive read waits for its publication', async () => {
  const flight = deferred<number>()
  const published: number[] = []
  const reader = createArchiveReader(
    () => flight.promise,
    (value) => published.push(value),
    () => assert.fail('unexpected failure')
  )
  let complete = false
  const done = Promise.resolve(reader.request()).then(() => {
    complete = true
  })
  await flush()
  assert.equal(complete, false)
  flight.resolve(1)
  await done
  assert.deepEqual(published, [1])
  reader.dispose()
})

test('coalesced archive callers await their follow-up rather than the previous read', async () => {
  const flights = [deferred<number>(), deferred<number>()]
  const published: number[] = []
  let reads = 0
  const reader = createArchiveReader(
    () => flights[reads++].promise,
    (value) => published.push(value),
    () => assert.fail('unexpected failure')
  )
  const first = reader.request()
  let complete = false
  const next = Promise.resolve(reader.request()).then(() => {
    complete = true
  })
  const coalesced = reader.request()
  flights[0].resolve(1)
  await first
  await flush()
  assert.equal(reads, 2)
  assert.equal(complete, false)
  assert.deepEqual(published, [1])
  flights[1].resolve(2)
  await Promise.all([next, coalesced])
  assert.equal(complete, true)
  assert.deepEqual(published, [1, 2])
  reader.dispose()
})

test('archive failure is published before its awaiting caller completes', async () => {
  const flight = deferred<number>()
  let failed = false
  const reader = createArchiveReader(
    () => flight.promise,
    () => assert.fail('unexpected publication'),
    () => {
      failed = true
    }
  )
  const done = Promise.resolve(reader.request()).then(() => assert.equal(failed, true))
  flight.reject(new Error('unavailable'))
  await done
  reader.dispose()
})

test('dispose settles in-flight and queued archive callers without stale publication or failure', async () => {
  const flight = deferred<number>()
  let reads = 0
  const reader = createArchiveReader(
    () => {
      reads += 1
      return flight.promise
    },
    () => assert.fail('disposed reader published'),
    () => assert.fail('disposed reader failed')
  )
  const first = reader.request()
  const queued = reader.request()
  assert.notEqual(first, undefined)
  assert.notEqual(queued, undefined)
  reader.dispose()
  await Promise.all([first, queued, reader.request()])
  flight.reject(new Error('late failure'))
  await flush()
  assert.equal(reads, 1)
})
