import assert from 'node:assert/strict'
import test from 'node:test'

import { listCreationRecoveries, preserveCreation, retryCreation } from './api.ts'

const operation = '0123456789abcdef0123456789abcdef'
const base = 'http://serve.test'
Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => base } } })

test('recovery listing distinguishes an empty list from an unavailable service', async (t) => {
  const replies = [Response.json({ creations: [] }), new Response(null, { status: 503 })]
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, `${base}/api/content/projects/recoveries`)
    assert.equal(init?.credentials, 'include')
    return replies.shift()!
  })
  assert.deepEqual(await listCreationRecoveries(), [])
  assert.equal(await listCreationRecoveries(), null)
})

test('retry submits once and waits for the original operation through maintenance', async (t) => {
  const calls: Array<{ url: unknown; method: string | undefined }> = []
  const replies = [
    Response.json({ operation }, { status: 202 }),
    new Response(null, { status: 503 }),
    Response.json({ operation, state: 'running' }),
    Response.json({ operation, state: 'failed', error: 'project_creation_recovery_required' }),
  ]
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url, method: init?.method })
    return replies.shift()!
  })
  assert.deepEqual(await retryCreation(operation), {
    ok: false,
    error: 'project_creation_recovery_required',
    project: undefined,
  })
  assert.deepEqual(calls, [
    { url: `${base}/api/content/projects/recoveries/${operation}/retry`, method: 'POST' },
    ...Array(3).fill({ url: `${base}/api/content/operations/${operation}`, method: undefined }),
  ])
})

test('preserving uses only the operation identity and reports conflicts without replay', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls++
    assert.equal(url, `${base}/api/content/projects/recoveries/${operation}/preserve`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, '{}')
    return Response.json({ detail: 'content_maintenance_active' }, { status: 503 })
  })
  assert.deepEqual(await preserveCreation(operation), {
    ok: false,
    error: 'content_maintenance_active',
  })
  assert.equal(calls, 1)
})

test('a lost preservation response is not resubmitted automatically', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new Error('connection lost')
  })
  assert.deepEqual(await preserveCreation(operation), { ok: false, error: 'connection lost' })
  assert.equal(calls, 1)
})
