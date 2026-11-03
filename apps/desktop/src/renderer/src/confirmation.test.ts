import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  confirmLocalSession,
  CONFIRMATION_DELAYS_MS,
  CONFIRMATION_REQUEST_TIMEOUT_MS,
} from './confirmation.ts'

function harness(request: (signal: AbortSignal) => Promise<Response>) {
  const records: Record<string, string | number | boolean | null>[] = []
  const waits: number[] = []
  return {
    records,
    waits,
    deps: {
      request,
      wait: async (ms: number) => {
        waits.push(ms)
      },
      log: (record: Record<string, string | number | boolean | null>) => records.push(record),
    },
  }
}

test('transient failures cross the JWKS cooldown and recover without exposing secrets', async () => {
  let elapsed = 0
  const h = harness(async () =>
    elapsed > 10_000
      ? Response.json({ auth: true })
      : new Response('secret-token-do-not-log', { status: 401 })
  )
  h.deps.wait = async (ms) => {
    elapsed += ms
    h.waits.push(ms)
  }
  assert.equal(await confirmLocalSession(new AbortController().signal, h.deps), true)
  assert.deepEqual(h.waits, [...CONFIRMATION_DELAYS_MS])
  assert.equal(h.records.length, 5)
  assert.equal(h.records.at(-1)?.reason, 'confirmed')
  assert.equal(JSON.stringify(h.records).includes('secret-token'), false)
})

test('network errors and anonymous replies retry, then confirmation succeeds', async () => {
  let calls = 0
  const h = harness(async () => {
    calls += 1
    if (calls === 1) throw new TypeError('https://secret.test/?token=private')
    return Response.json({ auth: calls > 2 })
  })
  assert.equal(await confirmLocalSession(new AbortController().signal, h.deps), true)
  assert.deepEqual(
    h.records.map((r) => r.reason),
    ['network-error', 'unauthenticated', 'confirmed']
  )
  assert.equal(JSON.stringify(h.records).includes('private'), false)
})

for (const status of [401, 408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} has a bounded retry budget`, async () => {
    const h = harness(async () => new Response(null, { status }))
    assert.equal(await confirmLocalSession(new AbortController().signal, h.deps), false)
    assert.equal(h.records.length, 5)
    assert.equal(h.records.at(-1)?.retry, false)
  })
}

for (const [name, response] of [
  ['forbidden', () => new Response(null, { status: 403 })],
  ['not found', () => new Response(null, { status: 404 })],
  ['invalid JSON', () => new Response('secret')],
  ['invalid schema', () => Response.json({ auth: 'true', token: 'secret' })],
] as const) {
  test(`${name} fails immediately`, async () => {
    const h = harness(async () => response())
    assert.equal(await confirmLocalSession(new AbortController().signal, h.deps), false)
    assert.equal(h.records.length, 1)
    assert.deepEqual(h.waits, [])
    assert.equal(JSON.stringify(h.records).includes('secret'), false)
  })
}

test('cancellation during backoff prevents another request', async () => {
  const ctl = new AbortController()
  const h = harness(async () => Response.json({ auth: false }))
  h.deps.wait = async () => {
    ctl.abort()
  }
  assert.equal(await confirmLocalSession(ctl.signal, h.deps), false)
  assert.equal(h.records.length, 1)
})

test('request deadline covers body reads and cancellation suppresses late success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctl = new AbortController()
  const h = harness(
    async (signal) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          ),
      }) as Response
  )
  h.deps.wait = async () => {
    ctl.abort()
  }
  const pending = confirmLocalSession(ctl.signal, h.deps)
  await Promise.resolve()
  t.mock.timers.tick(CONFIRMATION_REQUEST_TIMEOUT_MS)
  assert.equal(await pending, false)
  assert.equal(h.records[0].reason, 'timeout')
  const late = new AbortController()
  const cancelled = harness(async () => {
    late.abort()
    return Response.json({ auth: true })
  })
  assert.equal(await confirmLocalSession(late.signal, cancelled.deps), false)
  assert.deepEqual(cancelled.records, [])
})
