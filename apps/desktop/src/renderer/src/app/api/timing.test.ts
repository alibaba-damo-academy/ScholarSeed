import assert from 'node:assert/strict'
import test from 'node:test'
import { apiFetch, LIVE_CATALOG_REQUEST } from './client.ts'
import { API_DIAGNOSTIC_HEADER, HTTP_LATENCY_DIAGNOSTIC_PREFIX } from '../../../../requests.ts'
import { flushApiDiagnostics } from './diagnostics.ts'
import { readApiJson, reportCatalogFailure } from './timing.ts'

const CATALOG = '/api/serve/sessions?scope=project&project_path=private-project'
const CORRELATION = '0123456789abcdef0123456789abcdef'

function fixture(context: test.TestContext, transport: typeof fetch) {
  const records: Record<string, unknown>[] = []
  context.mock.method(console, 'info', (prefix: string, value: string) => {
    if (prefix === HTTP_LATENCY_DIAGNOSTIC_PREFIX) {
      const batch = JSON.parse(value)
      records.push(...batch.stages)
    }
  })
  context.mock.method(globalThis, 'fetch', transport)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => 'http://127.0.0.1:9000' } },
  })
  context.after(() => {
    flushApiDiagnostics()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as Record<string, unknown>).window
  })
  return records
}

test('ordinary catalog requests correlate fetch and JSON without recording private content', async (context) => {
  let observed: RequestInit | undefined
  const response = Response.json({ sessions: [{ title: 'private-answer' }] })
  const records = fixture(context, async (_input, init) => {
    observed = init
    return response
  })
  assert.equal(await apiFetch(CATALOG, LIVE_CATALOG_REQUEST), response)
  assert.deepEqual(await readApiJson(response), { sessions: [{ title: 'private-answer' }] })
  const identifier = new Headers(observed?.headers).get(API_DIAGNOSTIC_HEADER)
  assert.match(identifier!, /^[a-f0-9]{32}$/)
  assert.equal(observed?.cache, 'no-store')
  assert.equal(observed?.credentials, 'include')
  assert.ok(observed?.signal instanceof AbortSignal)
  assert.deepEqual(
    records.map((record) => record.event),
    ['fetch_started', 'headers_received', 'body_started', 'body_decoded']
  )
  assert.ok(records.every((record) => record.client_request_id === identifier))
  assert.equal(records[0].timeout_ms, 10_000)
  assert.ok(Number(records[3].body_elapsed_ms) >= 0)
  assert.ok(records.every((record) => Number.isFinite(record.timestamp_ms)))
  assert.ok(!JSON.stringify(records).includes('private'))
})

test('caller abort and timeout remain failures with the original reason and no retry', async (context) => {
  let requests = 0
  const failure = new DOMException('private-detail', 'TimeoutError')
  const records = fixture(context, async () => {
    requests += 1
    throw failure
  })
  await assert.rejects(apiFetch(CATALOG, LIVE_CATALOG_REQUEST), (error) => error === failure)
  assert.equal(requests, 1)
  assert.deepEqual(
    records.map((record) => record.event),
    ['fetch_started', 'fetch_failed']
  )
  assert.equal(records[1].error_type, 'TimeoutError')
  assert.ok(!JSON.stringify(records).includes('private'))
})

test('body failures are not mistaken for successful catalog completion', async (context) => {
  const response = new Response('not JSON')
  const records = fixture(context, async () => response)
  await apiFetch(CATALOG)
  await assert.rejects(readApiJson(response), SyntaxError)
  assert.deepEqual(
    records.map((record) => record.event),
    ['fetch_started', 'headers_received', 'body_started', 'body_failed']
  )
  assert.equal(records[3].error_type, 'SyntaxError')
})

test('same-URL concurrent calls retain distinct exact correlations', async (context) => {
  const identifiers: string[] = []
  const records = fixture(context, async (_input, init) => {
    identifiers.push(new Headers(init?.headers).get(API_DIAGNOSTIC_HEADER)!)
    return Response.json({ sessions: [] })
  })
  const responses = await Promise.all([apiFetch(CATALOG), apiFetch(CATALOG)])
  await Promise.all(responses.map((response) => readApiJson(response)))
  assert.notEqual(identifiers[0], identifiers[1])
  for (const identifier of identifiers)
    assert.deepEqual(
      records
        .filter((record) => record.client_request_id === identifier)
        .map((record) => record.event),
      ['fetch_started', 'headers_received', 'body_started', 'body_decoded']
    )
})

test('existing valid correlations and unrelated request headers are retained', async (context) => {
  let headers: Headers | undefined
  fixture(context, async (_input, init) => {
    headers = new Headers(init?.headers)
    return Response.json({})
  })
  await apiFetch(CATALOG, {
    headers: { [API_DIAGNOSTIC_HEADER]: CORRELATION, accept: 'application/json' },
  })
  assert.equal(headers?.get(API_DIAGNOSTIC_HEADER), CORRELATION)
  assert.equal(headers?.get('accept'), 'application/json')
})

test('diagnostic sinks cannot change HTTP or decode results', async (context) => {
  const response = Response.json({ sessions: [] })
  fixture(context, async () => response)
  context.mock.method(console, 'info', () => {
    throw new Error('sink unavailable')
  })
  assert.equal(await apiFetch(CATALOG), response)
  assert.deepEqual(await readApiJson(response), { sessions: [] })
})

test('other endpoints are not opted into automatic catalog diagnostics', async (context) => {
  let headers: Headers | undefined
  const records = fixture(context, async (_input, init) => {
    headers = new Headers(init?.headers)
    return Response.json({ ok: true })
  })
  const response = await apiFetch('/api/auth/me')
  assert.deepEqual(await readApiJson(response), { ok: true })
  assert.equal(headers?.has(API_DIAGNOSTIC_HEADER), false)
  assert.deepEqual(records, [])
})

test('caller cancellation retains its reason and the existing request deadline', async (context) => {
  const controller = new AbortController()
  const reason = new DOMException('private-cancellation-detail', 'AbortError')
  controller.abort(reason)
  const records = fixture(context, async (_input, init) => {
    throw init?.signal?.reason
  })
  let timeout: number | undefined
  const original = AbortSignal.timeout
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeout = milliseconds
    return original(milliseconds)
  })
  await assert.rejects(
    apiFetch(CATALOG, { ...LIVE_CATALOG_REQUEST, signal: controller.signal }),
    (error) => error === reason
  )
  assert.equal(timeout, 10_000)
  assert.equal(records[1].error_type, 'AbortError')
  assert.ok(!JSON.stringify(records).includes('private'))
})

test('an unavailable correlation generator does not break the catalog request', async (context) => {
  const response = Response.json({ sessions: [] })
  const records = fixture(context, async () => response)
  context.mock.method(crypto, 'randomUUID', () => {
    throw new Error('unavailable')
  })
  assert.equal(await apiFetch(CATALOG), response)
  assert.deepEqual(await readApiJson(response), { sessions: [] })
  assert.deepEqual(records, [])
})

test('stage capture batches diagnostic writes without losing early timestamps', async (context) => {
  const response = Response.json({ sessions: [] })
  fixture(context, async () => response)
  const batches: Record<string, unknown>[] = []
  context.mock.method(console, 'info', (prefix: string, value: string) => {
    if (prefix === HTTP_LATENCY_DIAGNOSTIC_PREFIX) batches.push(JSON.parse(value))
  })
  await apiFetch(CATALOG)
  assert.equal(batches.length, 0)
  await readApiJson(response)
  assert.equal(batches.length, 1)
  const stages = batches[0].stages as { event: string; elapsed_ms: number }[]
  assert.deepEqual(
    stages.map((stage) => stage.event),
    ['fetch_started', 'headers_received', 'body_started', 'body_decoded']
  )
  assert.ok(stages[0].elapsed_ms >= 0)
  assert.ok(
    stages.every((stage, index) => index === 0 || stage.elapsed_ms >= stages[index - 1].elapsed_ms)
  )
})

test('schema failures after JSON decoding retain the same exact correlation', async (context) => {
  const response = Response.json({ private: 'invalid-schema-body' })
  const records = fixture(context, async () => response)
  await apiFetch(CATALOG)
  await readApiJson(response)
  reportCatalogFailure(response, 'schema')
  assert.equal(records.at(-1)?.event, 'catalog_failed')
  assert.equal(records.at(-1)?.failure_phase, 'schema')
  assert.ok(records.every((record) => record.client_request_id === records[0].client_request_id))
  assert.ok(!JSON.stringify(records).includes('private'))
})
