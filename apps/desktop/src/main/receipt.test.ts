import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reportReceipt, RECEIPT_DELAYS_MS, RECEIPT_TIMEOUT_MS } from './receipt.ts'

function harness(respond: (init: RequestInit) => Promise<Response>) {
  const calls: RequestInit[] = [],
    waits: number[] = [],
    logs: string[] = []
  const deps = {
    base: async (): Promise<string | null> => 'https://account.test',
    request: (async (_url, init) => {
      calls.push(init!)
      return respond(init!)
    }) as typeof fetch,
    wait: async (ms: number) => {
      waits.push(ms)
    },
    log: (line: string) => {
      logs.push(line)
    },
  }
  return { deps, calls, waits, logs }
}
const run = (h: ReturnType<typeof harness>, current = () => true) =>
  reportReceipt('state-private', 'adopted', 'token-private', current, h.deps)

test('network failure and transient rejection retry the same immutable result, then stop on success', async () => {
  let attempt = 0
  const h = harness(async () => {
    if (++attempt === 1) throw new Error('token-private')
    return new Response(null, { status: attempt === 2 ? 503 : 200 })
  })
  await run(h)
  assert.equal(h.calls.length, 3)
  assert.deepEqual(h.waits, [1000, 2000])
  assert.equal(new Set(h.calls.map((c) => c.body)).size, 1)
  assert.ok(h.logs.at(-1)?.includes('delivered'))
  assert.equal(h.logs.join('').includes('private'), false)
})

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} exhausts a bounded budget without rejecting local success`, async () => {
    const h = harness(async () => new Response(null, { status }))
    await run(h)
    assert.equal(h.calls.length, 5)
    assert.deepEqual(h.waits, [...RECEIPT_DELAYS_MS])
    assert.ok(h.logs.at(-1)?.includes('"retry":false'))
  })
}
for (const status of [400, 401, 403, 404, 409]) {
  test(`HTTP ${status} is terminal`, async () => {
    const h = harness(async () => new Response(null, { status }))
    await run(h)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.waits, [])
  })
}

test('account discovery can recover and stale generations cannot issue another report', async () => {
  const h = harness(async () => new Response(null))
  let discovery = 0
  h.deps.base = async () => (++discovery === 1 ? null : 'https://account.test')
  await run(h)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.waits, [1000])
  let current = true
  const stale = harness(async () => {
    throw new Error('offline')
  })
  stale.deps.wait = async () => {
    current = false
  }
  await run(stale, () => current)
  assert.equal(stale.calls.length, 1)
})

test('deadline bounds discovery and prevents a late discovery from sending credentials', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(async () => new Response(null))
  let resolve!: (base: string) => void
  h.deps.base = () =>
    new Promise((r) => {
      resolve = r
    })
  let current = true
  h.deps.wait = async () => {
    current = false
  }
  const pending = run(h, () => current)
  t.mock.timers.tick(RECEIPT_TIMEOUT_MS)
  await pending
  resolve('https://account.test')
  await Promise.resolve()
  assert.equal(h.calls.length, 0)
  assert.ok(h.logs[0].includes('timeout'))
})

test('request timeout aborts transport and clears timers after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(
    async (init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
  )
  let current = true
  h.deps.wait = async () => {
    current = false
  }
  const pending = run(h, () => current)
  await Promise.resolve()
  t.mock.timers.tick(RECEIPT_TIMEOUT_MS)
  await pending
  assert.equal(h.calls[0].signal!.aborted, true)
  assert.ok(h.logs[0].includes('timeout'))
  const success = harness(async () => new Response(null))
  await run(success)
  t.mock.timers.tick(RECEIPT_TIMEOUT_MS)
  assert.equal(success.calls[0].signal!.aborted, false)
})
