import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTaskActionRequest, parseTaskProjection } from './taskcenter.ts'

const request = {
  kind: 'cancel',
  requestId: 'request',
  row: { sourceId: 'source', taskId: 'task', eventSeq: 3 },
}
const statuses = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled']
const projection = {
  activeCount: 2,
  rows: statuses.map((status) => ({
    sourceId: 'source',
    taskId: status,
    eventSeq: 3,
    title: '完整标题'.repeat(1000),
    status,
    progress: { determinate: true, label: 'progress', value: 50 },
    error: '',
    failures: [{ name: 'name', reason: 'reason' }],
    canCancel: ['queued', 'running'].includes(status),
    canRetry: ['partial', 'failed', 'cancelled'].includes(status),
    action: { pending: false, error: null },
  })),
}

test('parses both actions and all current display statuses without truncation or input mutation', () => {
  assert.deepEqual(parseTaskActionRequest(request), request)
  assert.deepEqual(parseTaskActionRequest({ ...request, kind: 'retry' }), {
    ...request,
    kind: 'retry',
  })
  assert.deepEqual(parseTaskProjection(projection), projection)
  assert.deepEqual(parseTaskProjection({ activeCount: 0, rows: [] }), { activeCount: 0, rows: [] })
})

test('rejects invalid requests, unknown fields and unsafe sequence numbers', () => {
  for (const value of [
    null,
    [],
    'request',
    { ...request, extra: true },
    { ...request, kind: 'delete' },
    { ...request, requestId: '' },
    { ...request, requestId: undefined },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((eventSeq) => ({
      ...request,
      row: { ...request.row, eventSeq },
    })),
    { ...request, row: { ...request.row, sourceId: '' } },
    { ...request, row: { ...request.row, taskId: '' } },
    { ...request, row: { ...request.row, extra: true } },
  ]) {
    assert.equal(parseTaskActionRequest(value), null)
  }
})

test('rejects non-plain objects, symbols, accessors and non-enumerable properties without invoking getters', () => {
  let reads = 0
  const accessor = { ...request }
  Object.defineProperty(accessor, 'kind', {
    enumerable: true,
    get: () => {
      reads += 1
      return 'cancel'
    },
  })
  for (const value of [
    Object.assign(Object.create({}), request),
    Object.assign(Object.create(null), request),
    { ...request, [Symbol('secret')]: 'secret' },
    Object.defineProperty({ ...request }, 'secret', { value: 'secret' }),
    accessor,
    { ...request, row: Object.assign(Object.create({}), request.row) },
  ]) {
    assert.equal(parseTaskActionRequest(value), null)
  }
  assert.equal(reads, 0)
})

test('rejects nested invalid projections and private business fields', () => {
  const row = projection.rows[0]
  const invalidRows = [
    { ...row, projectId: 'private' },
    { ...row, outcome: {} },
    { ...row, status: 'unknown' },
    { ...row, title: undefined },
    { ...row, canCancel: 1 },
    { ...row, eventSeq: -1 },
    { ...row, progress: { ...row.progress, value: Infinity } },
    ...[-1, 101, NaN].map((value) => ({ ...row, progress: { ...row.progress, value } })),
    { ...row, progress: { ...row.progress, extra: true } },
    { ...row, progress: { ...row.progress, label: () => 'label' } },
    { ...row, failures: [{ name: 'name', reason: 'reason', extra: true }] },
    { ...row, failures: [{ name: 'name', reason: 1n }] },
    { ...row, action: { pending: false, error: 'raw exception' } },
    { ...row, action: { pending: false, error: null, extra: true } },
    { ...row, action: Object.assign(Object.create({}), row.action) },
    { ...row, failures: new Array(1) },
    {
      ...row,
      progress: Object.defineProperty({ ...row.progress }, 'label', {
        enumerable: true,
        get: () => {
          throw new Error('getter must not run')
        },
      }),
    },
  ]
  for (const invalidRow of invalidRows)
    assert.equal(parseTaskProjection({ activeCount: 1, rows: [invalidRow] }), null)
  for (const value of [
    { ...projection, activeCount: 3 },
    { ...projection, activeCount: 3.5 },
    { ...projection, extra: true },
    { ...projection, rows: undefined },
    { ...projection, rows: Object.assign([...projection.rows], { secret: 'secret' }) },
  ])
    assert.equal(parseTaskProjection(value), null)
})

test('returns detached nested data and accepts only fixed action errors', () => {
  const parsed = parseTaskProjection(projection) as typeof projection
  assert.ok(parsed)
  parsed.rows[0].progress.label = 'changed'
  parsed.rows[0].failures[0].name = 'changed'
  parsed.rows[0].action.pending = true
  assert.equal(projection.rows[0].progress.label, 'progress')
  assert.equal(projection.rows[0].failures[0].name, 'name')
  assert.equal(projection.rows[0].action.pending, false)
  const parsedRequest = parseTaskActionRequest(request) as typeof request
  parsedRequest.row.taskId = 'changed'
  assert.equal(request.row.taskId, 'task')
  for (const error of [
    'invalid',
    'stale',
    'unavailable',
    'ineligible',
    'pending',
    'failed',
    'revoked',
  ]) {
    assert.ok(
      parseTaskProjection({
        activeCount: 1,
        rows: [{ ...projection.rows[0], action: { pending: false, error } }],
      })
    )
  }
})
