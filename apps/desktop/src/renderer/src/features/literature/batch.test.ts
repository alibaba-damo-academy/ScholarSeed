import assert from 'node:assert/strict'
import test from 'node:test'

import { MetadataBatchStore, synchronizeMetadata, type MetadataPorts } from './batch.ts'

const entries = [
  { id: 'doi', title: 'DOI' },
  { id: 'arxiv', title: 'arXiv' },
  { id: 'title', title: 'Title only' },
]
const immediate = async (): Promise<void> => undefined

test('identifier metadata is saved; title matching is never queried or written', async () => {
  const queries: string[] = []
  const writes: string[] = []
  const ports: MetadataPorts = {
    get: async (id) => ({
      doi: id === 'doi' ? '10.1000/test' : '',
      arxiv: id === 'arxiv' ? '1706.03762' : '',
      title: 'A real paper title',
    }),
    fetch: async (query) => {
      queries.push(query.dimension)
      return { fields: { authors: 'Author', year: 2026 }, bib_type: 'article' }
    },
    save: async (id, update, projectId) => {
      writes.push(id)
      assert.equal(projectId, 'project')
      assert.equal(update.fields?.year, 2026)
      assert.equal(update.bib_type, 'article')
    },
  }
  const store = new MetadataBatchStore(
    (entry, projectId) => synchronizeMetadata(entry.id, projectId, ports),
    immediate
  )
  await store.start(entries, 'project')
  assert.deepEqual(queries, ['doi', 'arxiv'])
  assert.deepEqual(writes, ['doi', 'arxiv'])
  assert.deepEqual(
    store.getSnapshot().entries.map((entry) => entry.status),
    ['success', 'success', 'skipped']
  )
})

test('empty metadata and explicit upstream miss are not successes', async () => {
  let saved = false
  const result = await synchronizeMetadata('doi', undefined, {
    get: async () => ({ doi: '10.1000/test', title: '', arxiv: '' }),
    fetch: async () => ({ fields: { year: null, authors: '' } }),
    save: async () => {
      saved = true
    },
  })
  assert.equal(result, 'missing')
  assert.equal(saved, false)
  const store = new MetadataBatchStore(async () => {
    throw { failure: { code: 'PAPER_META_NOT_FOUND', status: 404 } }
  }, immediate)
  await store.start(entries.slice(0, 1))
  assert.equal(store.getSnapshot().entries[0].status, 'missing')
})

test('save failures stay failed; remaining entries continue', async () => {
  const store = new MetadataBatchStore(async (entry) => {
    if (entry.id === 'doi') throw new Error('save failed')
    return 'success'
  }, immediate)
  await store.start(entries)
  assert.deepEqual(
    store.getSnapshot().entries.map((entry) => entry.status),
    ['failed', 'success', 'success']
  )
})

test('quota pauses unstarted entries; retry only processes failed and deferred entries', async () => {
  const calls: string[] = []
  let limited = true
  const store = new MetadataBatchStore(async (entry) => {
    calls.push(entry.id)
    if (entry.id === 'arxiv' && limited)
      throw { failure: { code: 'PAPER_META_QUOTA_EXHAUSTED', status: 429 } }
    return 'success'
  }, immediate)
  await store.start(entries, 'project')
  assert.deepEqual(calls, ['doi', 'arxiv'])
  assert.deepEqual(
    store.getSnapshot().entries.map((entry) => entry.status),
    ['success', 'quota', 'deferred']
  )
  limited = false
  await store.retry()
  assert.deepEqual(calls, ['doi', 'arxiv', 'arxiv', 'title'])
  assert.equal(store.getSnapshot().projectId, 'project')
  assert.ok(store.getSnapshot().entries.every((entry) => entry.status === 'success'))
})

test('cancel finishes an in-flight write but never starts queued entries', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: string[] = []
  const store = new MetadataBatchStore(async (entry) => {
    calls.push(entry.id)
    await gate
    return 'success'
  }, immediate)
  const running = store.start(entries)
  store.cancel()
  release()
  await running
  assert.deepEqual(calls, ['doi'])
  assert.deepEqual(
    store.getSnapshot().entries.map((entry) => entry.status),
    ['success', 'cancelled', 'cancelled']
  )
  assert.equal(store.getSnapshot().running, false)
})

test('duplicate starts do not replace the captured workset; subscriptions survive remount', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let notifications = 0
  const store = new MetadataBatchStore(async () => {
    await gate
    return 'success'
  }, immediate)
  const first = store.start([entries[0], entries[0]])
  const initial = store.getSnapshot()
  assert.equal(store.start(entries), first)
  assert.equal(store.getSnapshot(), initial)
  assert.equal(initial.entries.length, 1)
  const detach = store.subscribe(() => {
    notifications += 1
  })
  detach()
  store.subscribe(() => {
    notifications += 1
  })
  release()
  await first
  assert.ok(notifications > 0)
  assert.equal(store.getSnapshot().entries[0].status, 'success')
})

test('pacing separates requests and cancellation during pacing stops the next one', async () => {
  const calls: string[] = []
  const store: MetadataBatchStore = new MetadataBatchStore(
    async (entry) => {
      calls.push(entry.id)
      return 'success'
    },
    async (_milliseconds, signal) => {
      assert.equal(signal.aborted, false)
      store.cancel()
    }
  )
  await store.start(entries)
  assert.deepEqual(calls, ['doi'])
  assert.equal(store.getSnapshot().entries[1].status, 'cancelled')
})
