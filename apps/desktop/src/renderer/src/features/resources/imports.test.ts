import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { taskTitleText, taskProgressPresentation } from '../../contracts/tasks.ts'

import {
  createResourceImport,
  listResourceImportTasks,
  presentResourceImportTask,
  watchResourceImportTask,
} from './imports.ts'

const i18n = createInstance()
await i18n.init({
  lng: 'zh',
  fallbackLng: false,
  resources: {
    zh: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/zh/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
    en: {
      tasks: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/en/tasks.json', import.meta.url),
          'utf8'
        )
      ),
    },
  },
})

const payload = {
  id: 'job-1',
  project_id: 'project-1',
  mode: 'copy',
  status: 'running',
  phase: 'copying',
  source_names: ['pressure_010k_100M'],
  source_summary: { total: 1, succeeded: 0, failed: 0, cancelled: 0 },
  source_results: [
    {
      source_index: 0,
      source_name: 'pressure_010k_100M',
      status: 'pending',
      error: '',
      retryable: false,
    },
  ],
  scan_discovered_items: 7,
  completed_items: 2,
  total_items: 4,
  completed_bytes: 64,
  total_bytes: 128,
  version_completed_items: 0,
  version_discovered_items: 7,
  version_total_items: 0,
  event_seq: 9,
  error: '',
  created_at: 1,
  updated_at: 2,
}

test('resource import admission uses the durable job endpoint and maps progress', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = []
  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    fetch: async (input: string, init?: RequestInit) => {
      requests.push({ input, init })
      return new Response(JSON.stringify({ job: payload }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await createResourceImport('copy', ['/tmp/source'], '', 'project-1')
  assert.equal(result.ok, true)
  assert.equal(result.task?.completedBytes, 64)
  assert.equal(result.task?.discoveredItems, 7)
  assert.equal(result.task?.eventSeq, 9)
  assert.ok(result.task)
  assert.deepEqual(result.task.title, { key: 'title.copy', names: payload.source_names })
  assert.equal(
    taskTitleText(result.task.title, i18n.getFixedT('zh', 'tasks')),
    '复制资料到项目 · pressure_010k_100M'
  )
  assert.equal(
    taskTitleText(result.task.title, i18n.getFixedT('en', 'tasks')),
    'Copy resources to project · pressure_010k_100M'
  )
  assert.deepEqual(result.task?.sourceNames, ['pressure_010k_100M'])
  assert.equal(result.task?.outcome.available, true)
  assert.equal(result.task?.versionDiscoveredItems, 7)
  assert.equal(requests[0]?.input, 'http://serve.test/api/resource/import-jobs')
  assert.ok(new Headers(requests[0]?.init?.headers).get('Idempotency-Key'))
})

test('resource import list maps backend jobs into product tasks', async () => {
  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    fetch: async () => new Response(JSON.stringify({ items: [payload] }), { status: 200 }),
  })
  const tasks = await listResourceImportTasks()
  assert.equal(tasks[0]?.sourceId, 'resource-imports')
  assert.equal(tasks[0]?.outcome.total, 1)
  assert.ok(tasks[0])
  assert.equal(tasks[0].completedItems, 2)
  assert.equal(tasks[0].totalItems, 4)
  assert.deepEqual(taskProgressPresentation(tasks[0], i18n.getFixedT('zh', 'tasks')), {
    determinate: true,
    label: '复制中 50%',
    value: 50,
  })
  assert.deepEqual(taskProgressPresentation(tasks[0], i18n.getFixedT('en', 'tasks')), {
    determinate: true,
    label: 'Copying 50%',
    value: 50,
  })
  assert.equal(tasks[0]?.status, 'running')
})

test('source results override a stale retry snapshot summary', async () => {
  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    fetch: async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              ...payload,
              status: 'completed',
              phase: 'completed',
              source_names: ['good.md', 'recovered.md'],
              source_summary: { total: 2, succeeded: 1, failed: 0, cancelled: 0 },
              source_results: [
                {
                  source_index: 0,
                  source_name: 'good.md',
                  status: 'succeeded',
                  error: '',
                  retryable: false,
                },
                {
                  source_index: 1,
                  source_name: 'recovered.md',
                  status: 'succeeded',
                  error: '',
                  retryable: false,
                },
              ],
            },
          ],
        }),
        { status: 200 }
      ),
  })
  const tasks = await listResourceImportTasks()
  assert.deepEqual(tasks[0]?.outcome, {
    available: true,
    total: 2,
    succeeded: 2,
    failed: 0,
    cancelled: 0,
    results: [
      { index: 0, name: 'good.md', status: 'succeeded', error: '', retryable: false },
      { index: 1, name: 'recovered.md', status: 'succeeded', error: '', retryable: false },
    ],
  })
})

test('resource import watcher resumes from the snapshot cursor and applies SSE progress', async () => {
  let instance: FakeEventSource | null = null
  class FakeEventSource {
    onopen: (() => void) | null = null
    onmessage: ((message: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    closed = false

    constructor(
      readonly url: string,
      readonly options: EventSourceInit
    ) {
      instance = this
    }

    close(): void {
      this.closed = true
    }
  }

  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    EventSource: FakeEventSource,
  })
  const initial = {
    id: 'job-1',
    sourceId: 'resource-imports',
    projectId: 'project-1',
    operation: 'copy',
    title: { key: 'title.copy' as const, names: ['pressure_010k_100M'] },
    detail: '',
    sourceNames: ['pressure_010k_100M'],
    outcome: {
      available: true,
      total: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      results: [
        {
          index: 0,
          name: 'pressure_010k_100M',
          status: 'pending' as const,
          error: '',
          retryable: false,
        },
      ],
    },
    status: 'running' as const,
    phase: 'copying',
    discoveredItems: 7,
    completedItems: 2,
    totalItems: 4,
    completedBytes: 64,
    totalBytes: 128,
    versionCompletedItems: 0,
    versionDiscoveredItems: 7,
    versionTotalItems: 0,
    eventSeq: 9,
    error: '',
    createdAt: 1,
    updatedAt: 2,
  }
  const updates: (typeof initial)[] = []
  const stop = watchResourceImportTask(initial, {
    onTask: (task) => updates.push(task as typeof initial),
    onConnectionChange: () => undefined,
  })
  const stream = instance as FakeEventSource | null
  assert.ok(stream)
  assert.equal(stream.url, 'http://serve.test/api/resource/import-jobs/job-1/events?after_seq=9')
  stream.onmessage?.({
    data: JSON.stringify({
      seq: 10,
      data: {
        status: 'running',
        phase: 'versioning',
        version_completed_items: 3,
        version_total_items: 8,
      },
    }),
  })
  assert.equal(updates[0]?.eventSeq, 10)
  assert.equal(updates[0]?.versionCompletedItems, 3)
  assert.equal(updates[0]?.completedBytes, 64)
  for (const seq of [9, 10]) {
    stream.onmessage?.({
      data: JSON.stringify({ seq, data: { status: 'completed', phase: 'completed' } }),
    })
  }
  assert.equal(updates.length, 1)
  assert.equal(stream.closed, false)
  stream.onmessage?.({
    data: JSON.stringify({
      seq: 11,
      data: { status: 'completed', phase: 'completed', event_seq: 1 },
    }),
  })
  assert.equal(updates[1]?.eventSeq, 11)
  assert.equal(updates[1]?.status, 'completed')
  assert.equal(stream.closed, true)
  stop()
  assert.equal(stream.closed, true)
})

test('terminal presentation reports the import method, exact source counts and failure reason', () => {
  const presentation = presentResourceImportTask(
    {
      id: 'job-2',
      sourceId: 'resource-imports',
      projectId: 'project-1',
      operation: 'copy',
      title: { key: 'title.copy', names: ['good.md', 'missing.md'] },
      detail: '',
      sourceNames: ['good.md', 'missing.md'],
      outcome: {
        available: true,
        total: 2,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        results: [
          { index: 0, name: 'good.md', status: 'succeeded', error: '', retryable: false },
          {
            index: 1,
            name: 'missing.md',
            status: 'failed',
            error: 'source_not_found',
            retryable: true,
          },
        ],
      },
      status: 'partial',
      phase: 'completed',
      discoveredItems: 1,
      completedItems: 1,
      totalItems: 1,
      completedBytes: 4,
      totalBytes: 4,
      versionDiscoveredItems: 1,
      versionCompletedItems: 1,
      versionTotalItems: 1,
      eventSeq: 4,
      error: 'resource_import_partial',
      createdAt: 1,
      updatedAt: 2,
    },
    i18n.getFixedT('zh', 'tasks')
  )
  assert.equal(presentation.detail, '接入方式：复制到项目；已导入 1 项，未导入 1 项')
  assert.deepEqual(presentation.failures, [
    {
      name: 'missing.md',
      reason: '选中的本地文件或文件夹已不存在。',
    },
  ])
  assert.equal(presentation.title, '复制资料到项目 · good.md 等 2 项')
})

test('import task projection preserves canonical statuses and errors', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  try {
    Object.assign(globalThis, {
      window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
      fetch: async () =>
        Response.json({
          items: [
            { ...payload, status: 'failed', error: 'resource_import_failed' },
            { ...payload, id: 'job-2', status: 'partial', error: 'resource_import_interrupted' },
            { ...payload, id: 'job-3', status: 'failed', error: 'vendor: 原始错误' },
          ],
        }),
    })
    const tasks = await listResourceImportTasks()
    assert.deepEqual(
      tasks.map((task) => [task.status, task.error]),
      [
        ['failed', 'resource_import_failed'],
        ['partial', 'resource_import_interrupted'],
        ['failed', 'vendor: 原始错误'],
      ]
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('storage failures render actionable reasons', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  try {
    for (const [error, expected] of [
      ['disk_full', '磁盘空间不足，请清理空间后重试。'],
      ['storage_io_failed', '本地存储读写失败，请检查磁盘状态后重试。'],
    ] as const) {
      Object.assign(globalThis, {
        window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
        fetch: async () => Response.json({ items: [{ ...payload, status: 'failed', error }] }),
      })
      const [task] = await listResourceImportTasks()
      assert.ok(task)
      assert.equal(presentResourceImportTask(task, i18n.getFixedT('zh', 'tasks')).error, expected)
    }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})
