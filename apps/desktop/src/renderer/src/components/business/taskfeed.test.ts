import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskSourceContribution } from '../../contracts/features.ts'
import type { ProductTask } from '../../contracts/tasks.ts'
import { TaskFeed } from './taskfeed.ts'

const task = (overrides: Partial<ProductTask> = {}): ProductTask => ({
  id: 'job-1',
  sourceId: 'imports',
  projectId: 'project-a',
  operation: 'copy',
  title: 'source',
  detail: '',
  sourceNames: ['source'],
  outcome: { available: true, total: 1, succeeded: 0, failed: 0, cancelled: 0, results: [] },
  status: 'running',
  phase: 'copying',
  discoveredItems: 1,
  completedItems: 0,
  totalItems: 1,
  completedBytes: 0,
  totalBytes: 1,
  versionDiscoveredItems: 0,
  versionCompletedItems: 0,
  versionTotalItems: 0,
  eventSeq: 1,
  error: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

function fixture(overrides: Partial<TaskSourceContribution> = {}) {
  let snapshot: ProductTask[] = []
  const announcements: ProductTask[] = []
  const projections: ProductTask[] = []
  const connections: Array<Parameters<NonNullable<TaskSourceContribution['watch']>>[1]> = []
  let stopped = 0
  const source: TaskSourceContribution = {
    id: 'imports',
    list: async () => [],
    cancel: async () => task({ status: 'cancelled', eventSeq: 2 }),
    retry: async () => task({ status: 'queued', eventSeq: 3 }),
    present: () => ({ title: '', detail: '', announcement: '', error: '', failures: [] }),
    watch: (_task, callbacks) => {
      connections.push(callbacks)
      return () => {
        stopped += 1
      }
    },
    onTerminal: (terminal) => {
      projections.push(terminal)
    },
    ...overrides,
  }
  const feed = new TaskFeed(
    [source],
    (tasks) => {
      snapshot = tasks
    },
    (terminal) => {
      announcements.push(terminal)
    }
  )
  feed.start()
  return {
    feed,
    source,
    announcements,
    projections,
    connections,
    snapshot: () => snapshot,
    stopped: () => stopped,
  }
}

test('completed facts remain completed independent of project navigation or resource refresh', async () => {
  const context = fixture()
  await context.feed.refresh()
  context.feed.accept(task(), true)
  const completed = task({ status: 'completed', phase: 'completed', eventSeq: 2 })
  context.connections[0].onTask(completed)
  context.feed.accept(completed, true)
  context.feed.accept(task(), true)
  assert.equal(context.snapshot()[0].status, 'completed')
  assert.deepEqual(context.announcements, [completed])
  assert.deepEqual(context.projections, [completed])
  assert.equal(context.stopped(), 1)
  assert.equal(context.feed.needsRefresh(), false)
  context.feed.stop()
})

test('initial snapshots merge with concurrent live tasks without regression or lost announcements', async () => {
  let finish: ((tasks: ProductTask[]) => void) | undefined
  const initial = new Promise<ProductTask[]>((resolve) => {
    finish = resolve
  })
  const context = fixture({ list: () => initial })
  context.feed.accept(task(), true)
  context.feed.accept(task({ id: 'job-2', eventSeq: 4 }), true)
  finish?.([
    task({ status: 'completed', eventSeq: 2 }),
    task({ id: 'historical', status: 'failed', eventSeq: 8 }),
    task({ id: 'job-2', eventSeq: 2 }),
  ])
  await context.feed.refresh()
  assert.equal(context.snapshot().length, 3)
  assert.equal(context.snapshot().find((entry) => entry.id === 'job-2')?.eventSeq, 4)
  assert.deepEqual(
    context.announcements.map((entry) => entry.id),
    ['job-1']
  )
  context.feed.stop()
})

test('failed bootstrap is retried and recovered historical terminals remain silent', async () => {
  let attempts = 0
  const context = fixture({
    list: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return [task({ status: 'completed', eventSeq: 2 })]
    },
  })
  await context.feed.refresh()
  assert.equal(context.feed.needsRefresh(), true)
  await context.feed.refresh()
  assert.equal(context.feed.needsRefresh(), false)
  assert.equal(context.snapshot()[0].status, 'completed')
  assert.equal(context.announcements.length, 0)
  context.feed.stop()
})

test('disconnected active tasks require polling without any popover state', async () => {
  const context = fixture()
  await context.feed.refresh()
  context.feed.accept(task(), true)
  assert.equal(context.feed.needsRefresh(), true)
  context.connections[0].onConnectionChange(true)
  assert.equal(context.feed.needsRefresh(), false)
  context.connections[0].onConnectionChange(false)
  assert.equal(context.feed.needsRefresh(), true)
  context.source.list = async () => [task({ status: 'completed', eventSeq: 2 })]
  await context.feed.refresh()
  assert.equal(context.feed.needsRefresh(), false)
  assert.equal(context.announcements.length, 1)
  context.connections[0].onConnectionChange(false)
  assert.equal(context.feed.needsRefresh(), false)
  context.feed.stop()
})

test('retry uses the same identity with a higher sequence and fences the old watcher', async () => {
  const context = fixture()
  await context.feed.refresh()
  context.feed.accept(task(), true)
  context.connections[0].onTask(task({ status: 'partial', eventSeq: 2 }))
  await context.feed.mutate(context.snapshot()[0], 'retry')
  assert.equal(context.snapshot()[0].status, 'queued')
  assert.equal(context.connections.length, 2)
  context.connections[0].onTask(task({ status: 'failed', eventSeq: 20 }))
  assert.equal(context.snapshot()[0].eventSeq, 3)
  context.connections[1].onTask(task({ status: 'completed', eventSeq: 4 }))
  assert.deepEqual(
    context.announcements.map((entry) => entry.status),
    ['partial', 'completed']
  )
  context.feed.stop()
})

test('stop fences late list, mutation and subscription callbacks across restart', async () => {
  let finishList: ((tasks: ProductTask[]) => void) | undefined
  let finishCancel: ((result: ProductTask) => void) | undefined
  let subscription: ((result: ProductTask) => void) | undefined
  const initial = new Promise<ProductTask[]>((resolve) => {
    finishList = resolve
  })
  const cancellation = new Promise<ProductTask>((resolve) => {
    finishCancel = resolve
  })
  const context = fixture({
    list: () => initial,
    cancel: () => cancellation,
    subscribe: (listener) => {
      subscription = listener
      return () => undefined
    },
  })
  const pendingList = context.feed.refresh()
  const pendingCancel = context.feed.mutate(task(), 'cancel')
  const oldSubscription = subscription
  context.feed.stop()
  context.source.list = async () => []
  context.feed.start()
  finishList?.([task({ status: 'completed', eventSeq: 9 })])
  finishCancel?.(task({ status: 'cancelled', eventSeq: 10 }))
  oldSubscription?.(task({ status: 'failed', eventSeq: 11 }))
  await Promise.all([pendingList, pendingCancel, context.feed.refresh()])
  assert.deepEqual(context.snapshot(), [])
  assert.deepEqual(context.announcements, [])
  context.feed.stop()
})

test('cancelled and failed terminal results are deduplicated without inventing completion', async () => {
  const context = fixture()
  await context.feed.refresh()
  for (const status of ['cancelled', 'failed', 'partial'] as const) {
    const terminal = task({ id: status, status, eventSeq: 2 })
    context.feed.accept(terminal, true)
    context.feed.accept(terminal, true)
  }
  assert.deepEqual(
    context.announcements.map((entry) => entry.status),
    ['cancelled', 'failed', 'partial']
  )
  assert.equal(context.projections.length, 3)
  context.feed.stop()
})

test('newer same-status terminal snapshots update facts without repeating notification', async () => {
  const context = fixture()
  await context.feed.refresh()
  context.feed.accept(task(), true)
  context.feed.accept(task({ status: 'completed', eventSeq: 2 }), true)
  context.feed.accept(task({ status: 'completed', eventSeq: 3 }), true)
  assert.equal(context.snapshot()[0].eventSeq, 3)
  assert.equal(context.announcements.length, 1)
  context.feed.stop()
})
