import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import {
  TASK_ERROR,
  TASK_STATUS,
  parseTaskProjection,
  type TaskActionRequest,
  type TaskActionState,
} from '../../../../../taskcenter.ts'
import type { TaskSourceContribution } from '../../../contracts/features.ts'
import type { ProductTask } from '../../../contracts/tasks.ts'
import {
  projectTasks,
  createTaskDispatcher,
  clearCompletedMessages,
  visibleTaskMessages,
} from './presentation.ts'

const localization = createInstance()

test('clearing completed messages preserves other outcomes and hides only the cleared versions', () => {
  const tasks = Object.values(TASK_STATUS).map((status) => task({ id: status, status }))
  const original = structuredClone(tasks)
  const dismissals = clearCompletedMessages(tasks, {})
  const visible = visibleTaskMessages(tasks, dismissals)
  assert.deepEqual(
    visible.map((entry) => entry.status),
    ['queued', 'running', 'partial', 'failed', 'cancelled']
  )
  assert.deepEqual(tasks, original)
  assert.deepEqual(clearCompletedMessages(tasks, dismissals), dismissals)
  const completed = tasks.find((entry) => entry.status === 'completed')!
  assert.equal(visibleTaskMessages([completed], JSON.parse(JSON.stringify(dismissals))).length, 0)
  assert.equal(
    visibleTaskMessages([{ ...completed, eventSeq: completed.eventSeq + 1 }], dismissals).length,
    1
  )
  assert.equal(visibleTaskMessages([{ ...completed, status: 'running' }], dismissals).length, 1)
  assert.equal(
    visibleTaskMessages([{ ...completed, sourceId: 'another-source' }], dismissals).length,
    1
  )
  assert.equal(visibleTaskMessages([{ ...completed, id: 'new-task' }], dismissals).length, 1)
})
await localization.init({
  lng: 'zh',
  fallbackLng: false,
  resources: {
    zh: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../../../localization/locales/zh/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
    en: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../../../localization/locales/en/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
  },
})

function task(overrides: Partial<ProductTask> = {}): ProductTask {
  return {
    id: 'job',
    sourceId: 'source',
    projectId: 'private-project',
    operation: 'link',
    title: { key: 'title.link', names: ['paper', 'other'] },
    detail: 'private detail',
    sourceNames: ['private path'],
    outcome: {
      available: true,
      total: 1,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      results: [{ index: 0, name: 'private', status: 'failed', error: 'private', retryable: true }],
    },
    status: 'running',
    phase: 'scanning',
    discoveredItems: 326,
    completedItems: 1,
    totalItems: 2,
    completedBytes: 10,
    totalBytes: 20,
    versionDiscoveredItems: 8,
    versionCompletedItems: 3,
    versionTotalItems: 6,
    eventSeq: 1,
    error: '',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function source(
  id = 'source',
  execute: (taskId: string) => Promise<ProductTask> = async (taskId) =>
    task({ id: taskId, sourceId: id, status: 'cancelled' })
): TaskSourceContribution {
  return {
    id,
    present: (_task, translate) => ({
      title: 'not-current-title',
      detail: 'private',
      announcement: 'private',
      error: translate('progress.failed'),
      failures: [{ name: 'paper', reason: translate('feedback.reasonUnavailable') }],
    }),
    list: async () => [],
    cancel: execute,
    retry: execute,
  }
}

function request(
  current: ProductTask,
  kind: TaskActionRequest['kind'] = 'cancel'
): TaskActionRequest {
  return {
    kind,
    requestId: 'request',
    row: { sourceId: current.sourceId, taskId: current.id, eventSeq: current.eventSeq },
  }
}

test('projects all current statuses and phase progress in real Chinese and English resources', () => {
  const tasks = Object.values(TASK_STATUS).map((status) => task({ id: status, status }))
  tasks.push(
    task({ id: 'versions', phase: 'versioning' }),
    task({ id: 'preparing', phase: 'preparing' }),
    task({ id: 'copy', phase: 'copying' }),
    task({ id: 'link', phase: 'linking' }),
    task({ id: 'discover-versions', phase: 'versioning', versionTotalItems: 0 })
  )
  for (const language of ['zh', 'en']) {
    const translate = localization.getFixedT(language, 'tasks')
    const labels =
      language === 'zh'
        ? [
            '扫描中（已发现 326 项）',
            '扫描中（已发现 326 项）',
            '已完成',
            '部分完成',
            '执行失败',
            '已取消',
            '初始化版本 3/6',
            '准备中',
            '复制中 50%',
            '正在建立关联（共 2 项）',
            '统计版本文件（已发现 8 项）',
          ]
        : [
            'Scanning (326 items found)',
            'Scanning (326 items found)',
            'Completed',
            'Partially completed',
            'Execution failed',
            'Cancelled',
            'Initializing versions 3/6',
            'Preparing',
            'Copying 50%',
            'Creating links (2 items)',
            'Counting versioned files (8 items found)',
          ]
    const percentages = [0, 0, 100, 0, 0, 0, 50, 0, 50, 0, 0]
    const determinate = [false, false, true, false, false, false, true, false, true, false, false]
    const projection = projectTasks(tasks, [source()], translate, new Map())
    assert.equal(projection.activeCount, 7)
    assert.equal(projection.rows.length, tasks.length)
    assert.ok(parseTaskProjection(projection))
    for (const [index, row] of projection.rows.entries()) {
      const current = tasks[index]
      assert.equal(
        row.title,
        language === 'zh'
          ? '关联本地资料 · paper 等 2 项'
          : 'Link local resources · paper (2 items)'
      )
      assert.deepEqual(row.progress, {
        determinate: determinate[index],
        label: labels[index],
        value: percentages[index],
      })
      assert.equal(row.canCancel, ['queued', 'running'].includes(current.status))
      assert.equal(row.canRetry, ['failed', 'partial', 'cancelled'].includes(current.status))
      assert.deepEqual(row.action, { pending: false, error: null })
      assert.equal(row.error, '')
      assert.equal(translate('failure', row.failures[0]).includes('paper'), true)
      assert.equal(JSON.stringify(row).includes('private'), false)
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          'sourceId',
          'taskId',
          'eventSeq',
          'title',
          'status',
          'progress',
          'error',
          'failures',
          'canCancel',
          'canRetry',
          'action',
        ].sort()
      )
    }
    assert.equal(
      projection.rows[0].progress.label,
      language === 'zh' ? '扫描中（已发现 326 项）' : 'Scanning (326 items found)'
    )
  }
})

test('preserves source error policy, failures and detached per-row tuple action state', () => {
  const tasks = [
    task({ sourceId: 'a:b', id: 'c', error: 'business error' }),
    task({ sourceId: 'a', id: 'b:c', error: 'business error' }),
    task({ sourceId: 'other', id: 'c', error: 'business error' }),
  ]
  const failures = [{ name: 'name', reason: 'reason' }]
  const registered = source('a:b')
  registered.present = () => ({ title: '', detail: '', announcement: '', error: '', failures })
  const actions = new Map<string, TaskActionState>([
    [JSON.stringify(['a:b', 'c']), { pending: true, error: null }],
    [JSON.stringify(['other', 'c']), { pending: false, error: TASK_ERROR.failed }],
  ])
  const projection = projectTasks(
    tasks,
    [registered],
    localization.getFixedT('zh', 'tasks'),
    actions
  )
  assert.deepEqual(
    projection.rows.map((row) => row.error),
    ['business error', 'business error', 'business error']
  )
  assert.deepEqual(
    projection.rows.map((row) => row.action),
    [
      { pending: true, error: null },
      { pending: false, error: null },
      { pending: false, error: TASK_ERROR.failed },
    ]
  )
  assert.deepEqual(projection.rows[0].failures, failures)
  projection.rows[0].failures[0].name = 'changed'
  projection.rows[0].action.pending = false
  assert.equal(failures[0].name, 'name')
  assert.equal(actions.get(JSON.stringify(['a:b', 'c']))?.pending, true)
  const translated = projectTasks(
    [tasks[0]],
    [source('a:b')],
    localization.getFixedT('en', 'tasks'),
    new Map()
  )
  assert.equal(translated.rows[0].error, localization.getFixedT('en', 'tasks')('progress.failed'))
})

test('reads latest tasks and sources and rechecks sequence and eligibility before the public call', async () => {
  let tasks = [task()]
  let sources: TaskSourceContribution[] = []
  let calls = 0
  const accepted: ProductTask[] = []
  const dispatcher = createTaskDispatcher({
    tasks: () => tasks,
    sources: () => sources,
    accept: (updated) => accepted.push(updated),
    changed: () => {},
  })
  const original = request(tasks[0])
  assert.deepEqual(await dispatcher.dispatch(original), {
    ok: false,
    error: TASK_ERROR.unavailable,
  })
  sources = [
    source('source', async (taskId) => {
      calls += 1
      return task({ id: taskId, status: 'cancelled' })
    }),
  ]
  tasks = [task({ eventSeq: 2 })]
  assert.deepEqual(await dispatcher.dispatch(original), { ok: false, error: TASK_ERROR.stale })
  tasks = [task({ status: 'completed' })]
  assert.deepEqual(await dispatcher.dispatch(original), { ok: false, error: TASK_ERROR.ineligible })
  tasks = [task({ status: 'unknown' as ProductTask['status'] })]
  assert.deepEqual(await dispatcher.dispatch(original), { ok: false, error: TASK_ERROR.ineligible })
  tasks = []
  assert.deepEqual(await dispatcher.dispatch(original), { ok: false, error: TASK_ERROR.stale })
  tasks = [task()]
  assert.deepEqual(
    await dispatcher.dispatch({ ...original, kind: 'delete' } as unknown as TaskActionRequest),
    { ok: false, error: TASK_ERROR.invalid }
  )
  assert.equal(calls, 0)
  assert.deepEqual(await dispatcher.dispatch(original), { ok: true })
  assert.equal(calls, 1)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].status, 'cancelled')
  sources = []
  assert.deepEqual(await dispatcher.dispatch(original), {
    ok: false,
    error: TASK_ERROR.unavailable,
  })
  assert.equal(calls, 1)
})

test('authorizes cancel and retry against each current business status', async () => {
  for (const status of Object.values(TASK_STATUS)) {
    for (const kind of ['cancel', 'retry'] as const) {
      const current = task({ status })
      const calls: { kind: string; taskId: string }[] = []
      const registered = source()
      registered.cancel = async (taskId) => {
        calls.push({ kind: 'cancel', taskId })
        return current
      }
      registered.retry = async (taskId) => {
        calls.push({ kind: 'retry', taskId })
        return current
      }
      const dispatcher = createTaskDispatcher({
        tasks: () => [current],
        sources: () => [registered],
        accept: () => {},
        changed: () => {},
      })
      const eligible = (
        kind === 'cancel' ? ['queued', 'running'] : ['failed', 'partial', 'cancelled']
      ).includes(status)
      assert.deepEqual(
        await dispatcher.dispatch(request(current, kind)),
        eligible ? { ok: true } : { ok: false, error: TASK_ERROR.ineligible }
      )
      assert.deepEqual(calls, eligible ? [{ kind, taskId: 'job' }] : [])
    }
  }
})

test('serializes any action on one row, preserves pending across reprojection, and isolates tuple identities', async () => {
  const tasks = [
    task({ sourceId: 'a:b', id: 'c' }),
    task({ sourceId: 'a', id: 'b:c' }),
    task({ sourceId: 'other', id: 'c' }),
  ]
  let finish!: (updated: ProductTask) => void
  let calls = 0
  let changes = 0
  const accepted: ProductTask[] = []
  const sources = [
    source('a:b', () => {
      calls += 1
      return new Promise((resolve) => {
        finish = resolve
      })
    }),
    source('a'),
    source('other'),
  ]
  const dispatcher = createTaskDispatcher({
    tasks: () => tasks,
    sources: () => sources,
    accept: (updated) => accepted.push(updated),
    changed: () => {
      changes += 1
    },
  })
  const pending = dispatcher.dispatch(request(tasks[0]))
  assert.deepEqual(await dispatcher.dispatch(request(tasks[0])), {
    ok: false,
    error: TASK_ERROR.pending,
  })
  assert.deepEqual(await dispatcher.dispatch(request(tasks[0], 'retry')), {
    ok: false,
    error: TASK_ERROR.pending,
  })
  const exposed = dispatcher.states() as Map<string, TaskActionState>
  exposed.get(JSON.stringify(['a:b', 'c']))!.pending = false
  exposed.clear()
  for (const _open of [false, true]) {
    assert.equal(
      projectTasks(tasks, sources, localization.getFixedT('zh', 'tasks'), dispatcher.states())
        .rows[0].action.pending,
      true
    )
  }
  assert.deepEqual(await dispatcher.dispatch(request(tasks[1])), { ok: true })
  assert.deepEqual(await dispatcher.dispatch(request(tasks[2])), { ok: true })
  finish(task({ sourceId: 'a:b', id: 'c', status: 'cancelled' }))
  assert.deepEqual(await pending, { ok: true })
  assert.equal(calls, 1)
  assert.equal(accepted.length, 3)
  assert.deepEqual(
    accepted.map((updated) => [updated.sourceId, updated.id]),
    [
      ['a', 'b:c'],
      ['other', 'c'],
      ['a:b', 'c'],
    ]
  )
  assert.equal(changes, 6)
  assert.deepEqual(dispatcher.states().get(JSON.stringify(['a:b', 'c'])), {
    pending: false,
    error: null,
  })
})

test('handles synchronous throws and asynchronous rejection without accept and retries only explicitly', async () => {
  for (const synchronous of [true, false]) {
    const current = task({ status: 'failed' })
    let calls = 0
    let accepts = 0
    let changes = 0
    const dispatcher = createTaskDispatcher({
      tasks: () => [current],
      sources: () => [
        source('source', () => {
          calls += 1
          if (calls > 1) return Promise.resolve(task({ status: 'running' }))
          if (synchronous) throw new Error('private token')
          return Promise.reject(new Error('private token'))
        }),
      ],
      accept: () => {
        accepts += 1
      },
      changed: () => {
        changes += 1
      },
    })
    assert.deepEqual(await dispatcher.dispatch(request(current, 'retry')), {
      ok: false,
      error: TASK_ERROR.failed,
    })
    assert.equal(calls, 1)
    assert.equal(accepts, 0)
    assert.equal(changes, 2)
    assert.deepEqual(dispatcher.states().get(JSON.stringify(['source', 'job'])), {
      pending: false,
      error: TASK_ERROR.failed,
    })
    assert.deepEqual(
      await dispatcher.dispatch({ ...request(current, 'retry'), requestId: 'explicit-retry' }),
      { ok: true }
    )
    assert.equal(calls, 2)
    assert.equal(accepts, 1)
  }
})

test('disposal revokes new calls and suppresses late success and late rejection callbacks', async () => {
  for (const rejected of [false, true]) {
    const current = task()
    let complete!: (updated: ProductTask) => void
    let fail!: (reason: Error) => void
    let changes = 0
    let accepts = 0
    let calls = 0
    const dispatcher = createTaskDispatcher({
      tasks: () => [current],
      sources: () => [
        source('source', () => {
          calls += 1
          return new Promise((resolve, reject) => {
            complete = resolve
            fail = reject
          })
        }),
      ],
      accept: () => {
        accepts += 1
      },
      changed: () => {
        changes += 1
      },
    })
    const pending = dispatcher.dispatch(request(current))
    assert.equal(changes, 1)
    dispatcher.dispose()
    dispatcher.dispose()
    assert.deepEqual(await dispatcher.dispatch(request(current)), {
      ok: false,
      error: TASK_ERROR.revoked,
    })
    if (rejected) fail(new Error('late private error'))
    else complete(current)
    assert.deepEqual(await pending, { ok: false, error: TASK_ERROR.revoked })
    assert.equal(calls, 1)
    assert.equal(accepts, 0)
    assert.equal(changes, 1)
    assert.equal(dispatcher.states().size, 0)
  }
})
