import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PdfLifecycle,
  SCHOLARSEED_ANNOTATIONS_ATTACHMENT
} from './lifecycle.ts'

interface FakePage {
  pageNumber: number
}

interface FakeDocument {
  numPages: number
  getAttachments: () => Promise<Record<string, { filename: string }> | null>
  getPage: (pageNumber: number) => Promise<FakePage>
}

interface FakeTask {
  promise: Promise<FakeDocument>
  destroy: () => Promise<void>
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function document(
  attachments: Record<string, { filename: string }> | null = null,
  pageCount = 86
): { value: FakeDocument; requested: number[] } {
  const requested: number[] = []
  return {
    requested,
    value: {
      numPages: pageCount,
      getAttachments: async () => attachments,
      getPage: async (pageNumber) => {
        requested.push(pageNumber)
        return { pageNumber }
      }
    }
  }
}

test('ordinary PDFs publish the requested page without legacy restore or full-page prefetch', async () => {
  const source = document()
  let restoreCount = 0
  let destroyCount = 0
  const lifecycle = new PdfLifecycle<Uint8Array, FakeDocument, FakePage>({
    createTask: () => ({
      promise: Promise.resolve(source.value),
      destroy: async () => { destroyCount += 1 }
    }),
    restore: async (bytes) => { restoreCount += 1; return bytes }
  })

  const opened = await lifecycle.open(new Uint8Array([1, 2, 3]), 42)

  assert.equal(opened?.pageCount, 86)
  assert.equal(opened?.page.pageNumber, 42)
  assert.deepEqual(source.requested, [42])
  assert.equal(restoreCount, 0)
  assert.equal(destroyCount, 0)
})

test('legacy ScholarSeed attachments restore once and replace the probe task', async () => {
  const probe = document({
    records: { filename: SCHOLARSEED_ANNOTATIONS_ATTACHMENT }
  })
  const restored = document(null, 40)
  const destroyed: string[] = []
  const created: string[] = []
  let restoreCount = 0
  const tasks: FakeTask[] = [
    { promise: Promise.resolve(probe.value), destroy: async () => { destroyed.push('probe') } },
    { promise: Promise.resolve(restored.value), destroy: async () => { destroyed.push('restored') } }
  ]
  const lifecycle = new PdfLifecycle<Uint8Array, FakeDocument, FakePage>({
    createTask: (bytes) => {
      created.push(Array.from(bytes).join(','))
      return tasks.shift()!
    },
    restore: async () => { restoreCount += 1; return new Uint8Array([9]) }
  })

  const opened = await lifecycle.open(new Uint8Array([1]), 1)

  assert.equal(opened?.pageCount, 40)
  assert.deepEqual(probe.requested, [])
  assert.deepEqual(restored.requested, [1])
  assert.deepEqual(created, ['1', '9'])
  assert.deepEqual(destroyed, ['probe'])
  assert.equal(restoreCount, 1)

  await lifecycle.suspend()
  await lifecycle.suspend()
  assert.deepEqual(destroyed, ['probe', 'restored'])
})

test('page requests share one proxy promise per active document', async () => {
  const source = document()
  const lifecycle = new PdfLifecycle<Uint8Array, FakeDocument, FakePage>({
    createTask: () => ({ promise: Promise.resolve(source.value), destroy: async () => undefined }),
    restore: async (bytes) => bytes
  })
  await lifecycle.open(new Uint8Array([1]), 1)

  const [left, right] = await Promise.all([lifecycle.getPage(7), lifecycle.getPage(7)])

  assert.equal(left?.pageNumber, 7)
  assert.equal(right?.pageNumber, 7)
  assert.equal(source.requested.filter(page => page === 7).length, 1)
})

test('suspend destroys a pending task and rejects its late document result', async () => {
  const pending = deferred<FakeDocument>()
  const source = document()
  let destroyCount = 0
  const lifecycle = new PdfLifecycle<Uint8Array, FakeDocument, FakePage>({
    createTask: () => ({
      promise: pending.promise,
      destroy: async () => { destroyCount += 1 }
    }),
    restore: async (bytes) => bytes
  })

  const opening = lifecycle.open(new Uint8Array([1]), 1)
  await Promise.resolve()
  await lifecycle.suspend()
  pending.resolve(source.value)

  assert.equal(await opening, null)
  assert.equal(await lifecycle.getPage(1), null)
  assert.equal(destroyCount, 1)
})
