import assert from 'node:assert/strict'
import test from 'node:test'

import { setSessionPinned } from './api.ts'

test('pinning sets an explicit boolean and requires the acknowledged session state', async () => {
  const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = []
  let response = Response.json({ ok: true, session_id: 'task/one', pinned: true })
  Object.assign(globalThis, {
    window: { scholarseed: { getApiBase: () => 'http://serve.test' } },
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, method: options.method, body: options.body })
      return response.clone()
    },
  })
  assert.deepEqual(await setSessionPinned('task/one', true), { ok: true, status: 200, pinned: true })
  assert.equal(calls[0].url, 'http://serve.test/api/serve/sessions/task%2Fone/pin')
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].body, JSON.stringify({ pinned: true }))
  response = Response.json({ ok: true, session_id: 'task/one', pinned: false })
  assert.deepEqual(await setSessionPinned('task/one', false), { ok: true, status: 200, pinned: false })
  for (const payload of [{}, { ok: false, pinned: true }, { ok: true, pinned: 'true' }, { ok: true, session_id: 'other', pinned: true }]) {
    response = Response.json(payload)
    assert.equal((await setSessionPinned('task/one', true)).ok, false)
  }
  response = Response.json({ detail: 'session not found' }, { status: 404 })
  assert.deepEqual(await setSessionPinned('task/one', true), { ok: false, status: 404 })
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.deepEqual(await setSessionPinned('task/one', true), { ok: false, status: 0 })
})
