import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyResourceListingChanges,
  createResourceListingRefresh,
  resourceListingEventPaths,
} from './refresh.ts'

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

test('in-flight resource events coalesce paths and publish the first full result before the delta', async () => {
  const reads: ((value: string) => void)[] = []
  const deltas: { snapshot: string; paths: readonly string[]; resolve: (value: string) => void }[] =
    []
  const published: [string | null, boolean][] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result, refreshing) => published.push([result, refreshing]),
    (snapshot, paths) => new Promise<string>((resolve) => deltas.push({ snapshot, paths, resolve }))
  )
  refresh.request(['a'])
  await flush()
  assert.equal(reads.length, 1)
  refresh.request(['a', 'b'])
  refresh.request(['b', 'c'])
  reads[0]('initial')
  await flush()
  assert.deepEqual(published, [['initial', true]])
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].snapshot, 'initial')
  assert.deepEqual(deltas[0].paths, ['a', 'b', 'c'])

  refresh.request(['d'])
  deltas[0].resolve('catch-up')
  await flush()
  assert.equal(deltas[1].snapshot, 'catch-up')
  assert.deepEqual(deltas[1].paths, ['d'])
  deltas[1].resolve('current')
  await flush()
  assert.equal(reads.length, 1)
  assert.deepEqual(published, [
    ['initial', true],
    ['catch-up', true],
    ['current', false],
  ])
})

test('full resource invalidation shadows an in-flight delta and its queued paths', async () => {
  const reads: ((value: string) => void)[] = []
  const deltas: ((value: string) => void)[] = []
  const published: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result) => published.push(result),
    () => new Promise<string>((resolve) => deltas.push(resolve))
  )
  refresh.request()
  await flush()
  refresh.request(['a'])
  reads[0]('initial')
  await flush()
  refresh.request(['b'])
  refresh.request()
  refresh.request(['c'])
  deltas[0]('obsolete')
  await flush()
  assert.equal(deltas.length, 1)
  assert.equal(reads.length, 2)
  assert.deepEqual(published, ['initial'])
  reads[1]('current')
  await flush()
  assert.deepEqual(published, ['initial', 'current'])
})

test('a rejected resource delta falls back to one full read without publishing a failure', async () => {
  const reads: ((value: string) => void)[] = []
  const published: [string | null, boolean][] = []
  const refresh = createResourceListingRefresh(
    () => new Promise<string>((resolve) => reads.push(resolve)),
    (result, refreshing) => published.push([result, refreshing]),
    async () => null
  )
  refresh.request()
  await flush()
  refresh.request(['a'])
  reads[0]('initial')
  await flush()
  assert.equal(reads.length, 2)
  assert.deepEqual(published, [['initial', true]])
  reads[1]('current')
  await flush()
  assert.deepEqual(published, [
    ['initial', true],
    ['current', false],
  ])
})

test('resource event paths include both move ends and delegate ambiguous events to full refresh', () => {
  const path = 'resources/current.md'
  const previous_path = 'resources/previous.md'
  for (const kind of ['created', 'modified', 'deleted'] as const) {
    assert.deepEqual(resourceListingEventPaths({ kind, path, previous_path: null }), [path])
  }
  assert.deepEqual(resourceListingEventPaths({ kind: 'moved', path, previous_path }), [
    previous_path,
    path,
  ])
  assert.equal(resourceListingEventPaths({ kind: 'moved', path, previous_path: null }), undefined)
  assert.equal(resourceListingEventPaths({ kind: 'rescan', path, previous_path }), undefined)
  for (const unsafe of ['', 'resources/.gitignore', 'resources/.git/HEAD', '../outside', '/root']) {
    assert.equal(
      resourceListingEventPaths({ kind: 'modified', path: unsafe, previous_path: null }),
      undefined
    )
  }
})

test('resource changes preserve breadth-first order, delete missing paths, and insert new files', () => {
  const file = (path: string, updated_at = 1) => ({ path, kind: 'file', updated_at })
  const dir = (path: string) => ({ path, kind: 'dir' })
  const rootItem = file('resources/c.txt')
  const firstDir = dir('resources/first')
  const secondDir = dir('resources/second')
  const old = file('resources/first/old.txt')
  const moved = file('resources/second/new.txt', 2)
  const updated = file(rootItem.path, 3)
  const snapshot = {
    items: [rootItem, firstDir, secondDir, old],
    linked_roots: {},
    incremental: { supported: true, parents: ['resources', firstDir.path, secondDir.path] },
  }
  const merged = applyResourceListingChanges(
    snapshot,
    {
      items: [moved, updated],
      groups: [
        { parent: secondDir.path, paths: [moved.path] },
        { parent: 'resources', paths: [updated.path, firstDir.path, secondDir.path] },
        { parent: firstDir.path, paths: [] },
      ],
    },
    [updated.path, old.path, moved.path]
  )
  assert.deepEqual(merged, { ...snapshot, items: [updated, firstDir, secondDir, moved] })
  assert.deepEqual(snapshot.items, [rootItem, firstDir, secondDir, old])
  assert.equal(merged?.items[1], firstDir)
  assert.equal(
    applyResourceListingChanges(
      snapshot,
      { items: [], groups: [{ parent: 'resources', paths: [rootItem.path, secondDir.path] }] },
      [firstDir.path]
    ),
    null
  )
  assert.equal(
    applyResourceListingChanges(
      snapshot,
      { items: [], groups: [{ parent: secondDir.path, paths: [moved.path] }] },
      [moved.path]
    ),
    null
  )
  assert.equal(
    applyResourceListingChanges(
      snapshot,
      { items: [], groups: [{ parent: firstDir.path, paths: [] }] },
      [`${firstDir.path}/unrelated.txt`]
    ),
    null
  )
  assert.equal(
    applyResourceListingChanges(
      snapshot,
      {
        items: [updated],
        groups: [{ parent: 'resources', paths: [rootItem.path, secondDir.path, firstDir.path] }],
      },
      [rootItem.path]
    ),
    null
  )
})
