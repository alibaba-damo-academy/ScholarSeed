import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ApiDiagnostics,
  API_DIAGNOSTIC_WINDOW_MS,
  API_DIAGNOSTIC_BUCKET_LIMIT,
} from './diagnostics.ts'

test('a polling burst emits the first failure and a timed duplicate summary without another request', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: { status: number | null; route: string; suppressedCount: number }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  context.after(() => diagnostics.flush())
  for (let index = 0; index < 900; index += 1)
    diagnostics.report(
      '/api/content/operations/private-id?token=private-token',
      'get',
      503,
      performance.now(),
      'http'
    )
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 503)
  assert.equal(records[0].route, '/api/content/operations')
  context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS - 1)
  assert.equal(records.length, 1)
  context.mock.timers.tick(1)
  assert.equal(records.length, 2)
  assert.equal(records[1].suppressedCount, 899)
  assert.ok(!JSON.stringify(records).includes('private'))
  diagnostics.report('/api/content/operations/another-id', 'GET', 503, performance.now(), 'http')
  assert.equal(records.length, 3)
  context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS)
  assert.equal(records.length, 3, 'a single failure needs no duplicate summary')
})

test('status, reason, safe route and method remain separate, including 401 and 503', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: unknown[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  context.after(() => diagnostics.flush())
  const path = '/api/serve/model-profiles'
  diagnostics.report(path, 'GET', 401, 0, 'http')
  diagnostics.report(path, 'GET', 503, 0, 'http')
  diagnostics.report(path, 'POST', 503, 0, 'http')
  diagnostics.report('/api/auth/me', 'GET', 503, 0, 'http')
  diagnostics.report(path, 'GET', null, 0, 'transport', new TypeError('secret'))
  diagnostics.report(path, 'GET', null, 0, 'transport', new DOMException('secret', 'AbortError'))
  assert.equal(records.length, 6)
  assert.ok(!JSON.stringify(records).includes('secret'))
})

test('ninety seconds of 100ms polling produces bounded summaries with exact totals', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: { suppressedCount: number }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  context.after(() => diagnostics.flush())
  for (let index = 0; index < 900; index += 1) {
    diagnostics.report('/api/content/operations/private-id', 'GET', 503, 0, 'http')
    context.mock.timers.tick(100)
  }
  assert.equal(records.length, 18)
  assert.equal(records.filter((record) => record.suppressedCount === 0).length, 9)
  assert.equal(
    records.reduce((count, record) => count + record.suppressedCount, 0),
    891
  )
})

test('only sanitized metadata is used for deduplication and manual flush cancels timers', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: { suppressedCount: number; route: string; method: string }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  for (const secret of ['user-one', 'user-two', 'user-three'])
    diagnostics.report('/api/unknown/' + secret, secret, 500, 0, 'http')
  assert.equal(records.length, 1)
  diagnostics.flush()
  assert.equal(records.length, 2)
  assert.deepEqual(
    { route: records[1].route, method: records[1].method, count: records[1].suppressedCount },
    { route: '/api/:resource', method: 'OTHER', count: 2 }
  )
  diagnostics.flush()
  context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS * 2)
  assert.equal(records.length, 2)
  assert.ok(!JSON.stringify(records).includes('user-'))
})

test('bucket capacity is bounded and eviction preserves pending duplicate counts', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: { suppressedCount: number }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  for (let index = 0; index <= API_DIAGNOSTIC_BUCKET_LIMIT; index += 1) {
    for (let repeat = 0; repeat < 2; repeat += 1)
      diagnostics.report('/api/serve/model-profiles', 'GET', 400 + index, 0, 'http')
  }
  assert.equal(records.length, API_DIAGNOSTIC_BUCKET_LIMIT + 2)
  assert.equal(records.filter((record) => record.suppressedCount > 0).length, 1)
  diagnostics.flush()
  assert.equal(
    records.reduce((sum, record) => sum + record.suppressedCount, 0),
    API_DIAGNOSTIC_BUCKET_LIMIT + 1
  )
  const count = records.length
  context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS)
  assert.equal(records.length, count, 'evicted and flushed timers must not emit again')
})

test('sink failure cannot escape either request reporting or a timer summary', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const diagnostics = new ApiDiagnostics(() => {
    attempts += 1
    throw new Error('sink offline')
  })
  assert.doesNotThrow(() => {
    diagnostics.report('/api/auth/me', 'GET', 401, 0, 'http')
    diagnostics.report('/api/auth/me', 'GET', 401, 0, 'http')
    context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS)
    diagnostics.flush()
  })
  assert.equal(attempts, 2)
})

test('approved route categories match current endpoints without exposing similar or unknown paths', () => {
  const records: { route: string }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  const routes = [
    '/api/serve/model-profiles',
    '/api/serve/model-providers',
    '/api/auth/me',
    '/api/content/operations',
  ]
  for (const route of routes) {
    diagnostics.report(`${route}/private-id?token=secret`, 'GET', 503, 0, 'http')
    diagnostics.flush()
  }
  for (const path of [
    '/api/serve/sessions-secret',
    '/api/serve/providers',
    '/api/serve/model-profiles-secret',
    '/api/auth/message',
  ]) {
    diagnostics.report(path, 'GET', 503, 0, 'http')
    diagnostics.flush()
  }
  assert.deepEqual(
    records.map((record) => record.route),
    [...routes, '/api/:resource', '/api/:resource', '/api/:resource', '/api/:resource']
  )
})

test('flush only drains the snapshot and leaves reentrant reports for their own window', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const records: { status: number | null; suppressedCount: number }[] = []
  const diagnostics = new ApiDiagnostics((record) => {
    records.push(record)
    if (record.status === 401 && record.suppressedCount > 0) {
      diagnostics.report('/api/auth/me', 'GET', 503, 0, 'http')
      diagnostics.report('/api/auth/me', 'GET', 503, 0, 'http')
    }
  })
  context.after(() => diagnostics.flush())
  diagnostics.report('/api/auth/me', 'GET', 401, 0, 'http')
  diagnostics.report('/api/auth/me', 'GET', 401, 0, 'http')
  diagnostics.flush()
  assert.deepEqual(
    records.map((record) => [record.status, record.suppressedCount]),
    [
      [401, 0],
      [401, 1],
      [503, 0],
    ]
  )
  context.mock.timers.tick(API_DIAGNOSTIC_WINDOW_MS)
  assert.deepEqual(
    records.map((record) => [record.status, record.suppressedCount]),
    [
      [401, 0],
      [401, 1],
      [503, 0],
      [503, 1],
    ]
  )
})

test('catalog diagnostics identify only the collection and discard queries and session identifiers', () => {
  const records: { route: string }[] = []
  const diagnostics = new ApiDiagnostics((record) => records.push(record))
  for (const path of [
    '/api/serve/sessions',
    '/api/serve/sessions?scope=project&project_path=private-path',
    '/api/serve/sessions/private-session/events',
  ]) {
    diagnostics.report(path, 'GET', 503, 0, 'http')
    diagnostics.flush()
  }
  assert.deepEqual(
    records.map((record) => record.route),
    ['/api/serve/sessions', '/api/serve/sessions', '/api/:resource']
  )
  assert.ok(!JSON.stringify(records).includes('private'))
})
