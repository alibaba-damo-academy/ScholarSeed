import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LiteratureTaskStore } from './tasks.ts'

/** 一个直到测试显式放行才 settle 的任务, 用来观察「在飞」这个中间态。 */
function gated<T>(value: T) {
  let release!: (resolved: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release(value), start: () => promise }
}

test('a running task is visible until it settles', async () => {
  const store = new LiteratureTaskStore()
  const task = gated('detail')
  const started = store.run('item-1', 'fulltext', task.start)

  assert.equal(store.isRunning('item-1', 'fulltext'), true)
  const before = store.getSnapshot()
  task.release()
  assert.equal(await started, 'detail')
  // settle 是微任务里摘登记的, 等一轮再断言。
  await Promise.resolve()
  assert.equal(store.isRunning('item-1', 'fulltext'), false)
  assert.notEqual(store.getSnapshot(), before)
})

test('a second run for the same item and kind reuses the in-flight request', async () => {
  const store = new LiteratureTaskStore()
  const task = gated('detail')
  let starts = 0
  const start = (): Promise<string> => {
    starts += 1
    return task.start()
  }

  const first = store.run('item-1', 'fulltext', start)
  const second = store.run('item-1', 'fulltext', start)
  task.release()

  assert.equal(first, second)
  assert.equal(await second, 'detail')
  assert.equal(starts, 1)
})

test('different items and different kinds never share a task', async () => {
  const store = new LiteratureTaskStore()
  const fulltext = gated('detail')
  const metadata = gated('payload')
  store.run('item-1', 'fulltext', fulltext.start)
  store.run('item-1', 'metadata', metadata.start)
  store.run('item-2', 'fulltext', fulltext.start)

  assert.equal(store.isRunning('item-1', 'fulltext'), true)
  assert.equal(store.isRunning('item-1', 'metadata'), true)
  assert.equal(store.isRunning('item-2', 'fulltext'), true)
  assert.equal(store.isRunning('item-3', 'fulltext'), false)

  fulltext.release()
  metadata.release()
  await Promise.allSettled([fulltext.promise, metadata.promise])
})

test('a reopened panel can attach to the in-flight task without starting a request', async () => {
  const store = new LiteratureTaskStore()
  assert.equal(store.attach('item-1', 'metadata'), null)

  const task = gated('payload')
  let starts = 0
  store.run('item-1', 'metadata', () => {
    starts += 1
    return task.start()
  })

  const attached = store.attach<string>('item-1', 'metadata')
  assert.ok(attached)
  task.release()
  assert.equal(await attached, 'payload')
  assert.equal(starts, 1)
  // settle 之后不再续接: 重开面板应当重新发起, 而不是拿到一个陈旧结果。
  await Promise.resolve()
  assert.equal(store.attach('item-1', 'metadata'), null)
})

test('a failed task stops showing busy and still reports the failure to every waiter', async () => {
  const store = new LiteratureTaskStore()
  const failure = new Error('upstream')
  const first = store.run('item-1', 'fulltext', () => Promise.reject(failure))
  const second = store.run('item-1', 'fulltext', () => Promise.reject(new Error('never')))

  assert.equal(first, second)
  await assert.rejects(first, /upstream/)
  await assert.rejects(second, /upstream/)
  await Promise.resolve()
  assert.equal(store.isRunning('item-1', 'fulltext'), false)
})

test('a settled key can be reused by the next round', async () => {
  const store = new LiteratureTaskStore()
  const first = gated('one')
  const firstRun = store.run('item-1', 'metadata', first.start)
  first.release()
  assert.equal(await firstRun, 'one')
  await Promise.resolve()
  assert.equal(store.isRunning('item-1', 'metadata'), false)

  const second = gated('two')
  const started = store.run('item-1', 'metadata', second.start)
  assert.equal(store.isRunning('item-1', 'metadata'), true)
  second.release()
  assert.equal(await started, 'two')
})

test('subscribers hear about registration and settlement, and stop hearing after unsubscribe', async () => {
  const store = new LiteratureTaskStore()
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  const task = gated('detail')

  store.run('item-1', 'fulltext', task.start)
  assert.equal(notifications, 1)
  task.release()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(notifications, 2)

  unsubscribe()
  const next = gated('again')
  store.run('item-1', 'fulltext', next.start)
  assert.equal(notifications, 2)
  next.release()
})

test('the detail panel reads busy state from the registry, not from local component state', () => {
  const source = readFileSync(new URL('./LiteratureDetail.tsx', import.meta.url), 'utf8')

  assert.match(source, /useSyncExternalStore\(literatureTasks\.subscribe, literatureTasks\.getSnapshot\)/)
  assert.match(source, /const fetchingArxiv = literatureTasks\.isRunning\(id, 'fulltext'\)/)
  assert.match(source, /const metadataRunning =\s*literatureTasks\.isRunning\(id, 'metadata'\)/)
  assert.match(source, /literatureTasks\.run\(id, 'fulltext', \(\) => fetchArxivFulltext\(id\)\)/)
  assert.match(source, /literatureTasks\.run\(id, 'metadata', \(\) => fetchPaperMeta\(query\)\)/)
  assert.match(source, /literatureTasks\.attach<Detail>\(id, 'fulltext'\)/)
  assert.match(source, /literatureTasks\.attach<PaperMetaPayload>\(id, 'metadata'\)/)
  assert.match(source, /loading=\{syncing \|\| metadataRunning\}/)
  // 失败也要续接: 否则重开面板后任务失败只剩一个静默变回可点的按钮。
  assert.match(source, /\(reason\) => failFulltext\.current\(reason\)/)
  assert.match(source, /\(reason\) => failMetadata\.current\(reason\)/)
  assert.match(source, /failFulltext\.current = rejectFulltext/)
  assert.match(source, /failMetadata\.current = rejectMetadata/)
  // 忙状态一旦回到本地 useState, 重开面板就会谎报空闲。
  assert.doesNotMatch(source, /setFetchingArxiv/)
})
