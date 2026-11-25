import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileEvent } from '../../contracts/content.ts'
import {
  fetchVersionCapability,
  observeResourceFileEvent,
  resourceFileEventObservation,
} from './api.ts'
import {
  applyResourceListingChanges,
  createResourceListingRefresh,
  isResourceListingBoundaryFailure,
  listingDirectoryNodes,
  RESOURCE_LISTING_SCOPE_UNAVAILABLE,
  resourceListingDirectories,
  resourceListingDirectoryEventPaths,
  resourceListingEventPaths,
} from './refresh.ts'

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('a decoded capability remains usable when its deadline has just fired', async (context) => {
  const deadline = new AbortController()
  context.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  const capability = { file_id: 'complete' }
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => {
      deadline.abort()
      return capability
    },
  }))
  Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => '' } } })
  context.after(() => Reflect.deleteProperty(globalThis, 'window'))
  assert.equal(await fetchVersionCapability('project', 'note.md'), capability)
})

test('a file event shares its pending lookup and can retry after a failed capability read', async (context) => {
  const event: FileEvent = {
    epoch: 'one',
    seq: 1,
    project_id: 'project',
    root: 'resources',
    kind: 'modified',
    path: 'note.md',
    source: 'external',
    previous_path: null,
  }
  const capability = { file_id: 'available' }
  const firstResponse = Promise.withResolvers<Response>()
  let calls = 0
  context.mock.method(globalThis, 'fetch', () =>
    ++calls === 1 ? firstResponse.promise : Promise.resolve(Response.json(capability))
  )
  Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => '' } } })
  context.after(() => Reflect.deleteProperty(globalThis, 'window'))
  const first = observeResourceFileEvent('project', event)
  assert.equal(observeResourceFileEvent('project', event), first)
  assert.equal(resourceFileEventObservation(event), first)
  firstResponse.resolve(new Response(null, { status: 503 }))
  assert.equal(await first, null)
  assert.equal(resourceFileEventObservation(event), undefined)
  const retry = observeResourceFileEvent('project', event)
  assert.deepEqual(await retry, capability)
  assert.equal(observeResourceFileEvent('project', event), retry)
  assert.equal(calls, 2)
})

test('reachable directory groups ignore closed and removed parents and deduplicate aliases', () => {
  const alias = { path: 'alias', name: 'alias', kind: 'dir' } as const
  const note = { path: 'note.md', name: 'note.md', kind: 'file' } as const
  const orphan = { path: 'orphan/a.md', name: 'a.md', kind: 'file' } as const
  const directories = new Map([
    ['', { snapshot: { directory: '', items: [alias, note], versionsLoaded: false } }],
    ['alias', { snapshot: { directory: '', items: [alias, note], versionsLoaded: false } }],
    ['orphan', { snapshot: { directory: 'orphan', items: [orphan], versionsLoaded: false } }],
  ])
  const visible = resourceListingDirectories(directories, { alias: true, orphan: true })
  assert.deepEqual(visible, ['', 'alias'])
  assert.deepEqual(listingDirectoryNodes(directories, visible), [alias, note])
  assert.deepEqual(resourceListingDirectories(directories, { alias: false }), [''])
})

test('listing events affect direct parent groups and invalidate moved directory subtrees', () => {
  assert.deepEqual(resourceListingDirectoryEventPaths('', ['a.md', 'nested/b.md']), ['a.md'])
  assert.deepEqual(resourceListingDirectoryEventPaths('other', ['a.md', 'nested/b.md']), [])
  assert.deepEqual(resourceListingDirectoryEventPaths('nested', ['a.md', 'nested/b.md']), [
    'nested/b.md',
  ])
  assert.equal(resourceListingDirectoryEventPaths('nested/child', ['nested']), undefined)
  assert.equal(resourceListingDirectoryEventPaths('', undefined), undefined)
})

test('boundary failures clear actionable rows while a busy or transient read preserves them', async () => {
  assert.equal(isResourceListingBoundaryFailure(400, 'path_outside_root'), true)
  assert.equal(isResourceListingBoundaryFailure(403), true)
  assert.equal(isResourceListingBoundaryFailure(404), true)
  assert.equal(isResourceListingBoundaryFailure(409, 'root_source_changed'), true)
  assert.equal(isResourceListingBoundaryFailure(409, 'root_busy'), false)
  assert.equal(isResourceListingBoundaryFailure(503), false)
  const reads: (string | null | typeof RESOURCE_LISTING_SCOPE_UNAVAILABLE)[] = [
    'authorized rows',
    null,
    RESOURCE_LISTING_SCOPE_UNAVAILABLE,
  ]
  const changes: unknown[] = []
  const refresh = createResourceListingRefresh<string>(
    async () => reads.shift() ?? null,
    (snapshot, _refreshing, invalidated) => changes.push([snapshot, invalidated])
  )
  for (const _read of [...reads]) {
    refresh.request()
    await flush()
  }
  assert.deepEqual(changes, [
    ['authorized rows', false],
    [null, false],
    [null, true],
  ])
})

test('a current versions read can replace changed structure or revoke the displayed scope', async () => {
  for (const hydrated of [
    'updated rows with versions',
    RESOURCE_LISTING_SCOPE_UNAVAILABLE,
  ] as const) {
    const changes: unknown[] = []
    const refresh = createResourceListingRefresh<string>(
      async () => 'initial metadata',
      (snapshot, _refreshing, invalidated) => changes.push([snapshot, invalidated]),
      undefined,
      { hydrate: async () => hydrated }
    )
    refresh.request()
    await flush()
    assert.deepEqual(changes, [
      ['initial metadata', false],
      hydrated === RESOURCE_LISTING_SCOPE_UNAVAILABLE ? [null, true] : [hydrated, false],
    ])
  }
})

test('scope metadata and deltas publish immediately, stale version jobs never overwrite a newer read', async () => {
  const statuses: ((result: string) => void)[] = []
  const seen: (string | null)[] = []
  const refresh = createResourceListingRefresh(
    async () => 'initial metadata',
    (result) => seen.push(result),
    async (_old, paths) => paths.join(','),
    { deltaWhileIdle: true, hydrate: () => new Promise((resolve) => statuses.push(resolve)) }
  )
  refresh.request()
  await flush()
  assert.deepEqual(seen, ['initial metadata'])
  assert.equal(statuses.length, 1)
  refresh.request(['first.md', 'second.md'])
  await flush()
  assert.deepEqual(seen, ['initial metadata', 'first.md,second.md'])
  assert.equal(statuses.length, 1)
  statuses[0]('stale statuses')
  await flush()
  assert.deepEqual(seen, ['initial metadata', 'first.md,second.md'])
  assert.equal(statuses.length, 2)
  statuses[1]('current statuses')
  await flush()
  assert.deepEqual(seen, ['initial metadata', 'first.md,second.md', 'current statuses'])
})

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
