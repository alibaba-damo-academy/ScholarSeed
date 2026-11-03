import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveContentResponse } from './content.ts'
import { flushApiDiagnostics } from './diagnostics.ts'

test.afterEach(() => flushApiDiagnostics())

const operation = '0123456789abcdef0123456789abcdef'
const accepted = () => Response.json({ operation }, { status: 202 })

test('content commands wait through maintenance and running state without repeating the mutation', async () => {
  const calls: string[] = []
  const replies = [
    new Response(null, { status: 503 }),
    Response.json({ operation, state: 'running' }),
    Response.json({ operation, state: 'succeeded', result: { id: 'project' } }),
  ]
  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    fetch: async (url: string, init: RequestInit) => {
      calls.push(url)
      assert.equal(init.method, undefined)
      assert.equal(init.credentials, 'include')
      return replies.shift()!
    },
  })
  const response = await resolveContentResponse(accepted())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 'project' })
  assert.deepEqual(calls, Array(3).fill(`http://serve.test/api/content/operations/${operation}`))
})

test('failed or mismatched operation results never become successful project responses', async () => {
  for (const [state, status] of [
    [{ operation, state: 'failed', error: 'content_directory_busy' }, 400],
    [{ operation: 'different', state: 'succeeded', result: { id: 'wrong' } }, 502],
  ] as const) {
    Object.assign(globalThis, { fetch: async () => Response.json(state) })
    const response = await resolveContentResponse(accepted())
    assert.equal(response.status, status)
    assert.equal(response.ok, false)
  }
})

test('unknown operation after a restart is returned without a second submission', async () => {
  let calls = 0
  Object.assign(globalThis, {
    fetch: async () => {
      calls++
      return Response.json({ detail: 'content_operation_unknown' }, { status: 404 })
    },
  })
  const response = await resolveContentResponse(accepted())
  assert.equal(response.status, 404)
  assert.equal(calls, 1)
})

test('normal synchronous responses are preserved and malformed operation locations are never fetched', async () => {
  const normal = Response.json({ id: 'existing' })
  assert.equal(await resolveContentResponse(normal), normal)
  Object.assign(globalThis, {
    fetch: async () => {
      throw new Error('unexpected fetch')
    },
  })
  assert.equal(
    (
      await resolveContentResponse(
        Response.json({ operation: 'https://outside.test/' }, { status: 202 })
      )
    ).status,
    502
  )
})
