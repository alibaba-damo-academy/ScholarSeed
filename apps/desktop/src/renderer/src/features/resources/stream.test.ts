import assert from 'node:assert/strict'
import test from 'node:test'
import { createResourceListingSearch } from './stream.ts'

interface Candidate {
  path: string
  label: string
}

interface Snapshot {
  items: Candidate[]
  revision: number
}

const candidate = (path: string, label = path): Candidate => ({ path, label })
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function searchFixture() {
  const requests: {
    signal: AbortSignal
    batch: (items: Candidate[]) => void
    finish: (result: Snapshot | null) => void
  }[] = []
  const deltas: {
    paths: readonly string[]
    snapshot: Snapshot
    finish: (result: Snapshot | null) => void
  }[] = []
  const states: { items: Candidate[] | null; refreshing: boolean; failed: boolean }[] = []
  const paints: (() => void)[] = []
  const search = createResourceListingSearch<Candidate, Snapshot>(
    (signal, batch) => new Promise((finish) => requests.push({ signal, batch, finish })),
    (snapshot, paths) => new Promise((finish) => deltas.push({ snapshot, paths, finish })),
    (items, refreshing, failed) => states.push({ items, refreshing, failed }),
    (paint) => paints.push(paint)
  )
  return { search, requests, deltas, states, paints }
}

test('one project stream publishes first candidates promptly, coalesces later batches and reuses completion', async () => {
  const { search, requests, states, paints } = searchFixture()
  search.setWanted(false)
  await flush()
  assert.equal(requests.length, 0)
  search.setWanted(true)
  search.setWanted(true)
  await flush()
  assert.equal(requests.length, 1)
  requests[0].batch([candidate('first')])
  assert.deepEqual(states.at(-1), { items: [candidate('first')], refreshing: true, failed: false })
  requests[0].batch([candidate('later')])
  requests[0].batch([candidate('first', 'updated'), candidate('last')])
  assert.equal(paints.length, 1)
  assert.deepEqual(states.at(-1)?.items, [candidate('first')])
  paints[0]()
  assert.deepEqual(states.at(-1)?.items, [
    candidate('first', 'updated'),
    candidate('later'),
    candidate('last'),
  ])
  const full = [candidate('last'), candidate('later'), candidate('first', 'final')]
  requests[0].finish({ items: full, revision: 1 })
  await flush()
  search.setWanted(false)
  search.setWanted(true)
  await flush()
  assert.equal(requests.length, 1)
  assert.deepEqual(states.at(-1), { items: full, refreshing: false, failed: false })
  search.dispose()
})

test('ordinary updates do not abort a first stream and merge after its authoritative completion', async () => {
  const { search, requests, deltas, states } = searchFixture()
  search.setWanted(true)
  await flush()
  requests[0].batch([candidate('first')])
  search.invalidate(['file-a', 'file-b'])
  search.invalidate(['file-b', 'file-c'])
  assert.equal(requests[0].signal.aborted, false)
  assert.equal(deltas.length, 0)
  const complete = { items: [candidate('first'), candidate('second')], revision: 1 }
  requests[0].finish(complete)
  await flush()
  assert.equal(requests.length, 1)
  assert.deepEqual(
    deltas.map(({ snapshot, paths }) => ({ snapshot, paths })),
    [{ snapshot: complete, paths: ['file-a', 'file-b', 'file-c'] }]
  )
  assert.deepEqual(states.at(-1), { items: complete.items, refreshing: true, failed: false })
  const updated = { items: [candidate('third')], revision: 2 }
  deltas[0].finish(updated)
  await flush()
  assert.deepEqual(states.at(-1), { items: updated.items, refreshing: false, failed: false })
  search.dispose()
})

test('rescans evict partial state and ignore old callbacks and hidden stale results', async () => {
  const { search, requests, states, paints } = searchFixture()
  search.setWanted(true)
  await flush()
  requests[0].batch([candidate('old')])
  requests[0].batch([candidate('old pending')])
  search.invalidate()
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(states.at(-1), { items: null, refreshing: true, failed: false })
  await flush()
  assert.equal(requests.length, 2)
  requests[0].batch([candidate('old late')])
  requests[0].finish({ items: [candidate('old complete')], revision: 1 })
  paints[0]()
  await flush()
  assert.equal(states.at(-1)?.items, null)
  requests[1].finish({ items: [candidate('current')], revision: 2 })
  await flush()
  search.setWanted(false)
  search.invalidate(['updated'])
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(states.at(-1)?.items, null)
  search.setWanted(true)
  await flush()
  assert.equal(requests.length, 3)
  search.dispose()
  assert.equal(requests[2].signal.aborted, true)
})

test('an incomplete stream clears provisional rows and exposes retry instead of an empty result', async () => {
  const { search, requests, states } = searchFixture()
  search.setWanted(true)
  await flush()
  requests[0].batch([candidate('provisional')])
  requests[0].finish(null)
  await flush()
  assert.deepEqual(states.at(-1), { items: null, refreshing: false, failed: true })
  search.invalidate()
  await flush()
  assert.equal(requests.length, 2)
  requests[1].finish({ items: [], revision: 2 })
  await flush()
  assert.deepEqual(states.at(-1), { items: [], refreshing: false, failed: false })
  search.dispose()
})
