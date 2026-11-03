import assert from 'node:assert/strict'
import test from 'node:test'
import { apiFetch, getJson, postJson, LIVE_CATALOG_REQUEST } from './client.ts'
import { flushApiDiagnostics } from './diagnostics.ts'

test('API failures preserve behavior and emit only safe diagnostic metadata', async (context) => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalInfo = console.info
  const records: string[] = []
  const events: Event[] = []
  Object.assign(globalThis, {
    window: {
      setTimeout,
      clearTimeout,
      dispatchEvent: (event: Event) => {
        events.push(event)
      },
    },
  })
  console.info = (...values: unknown[]) => {
    records.push(values.join(' '))
  }
  context.after(() => {
    flushApiDiagnostics()
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
    console.info = originalInfo
  })
  const lastRecord = () => JSON.parse(records.at(-1)!.replace('[api-request] ', ''))
  const secret = 'private-user-content-and-api-key'
  const path = `/api/serve/model-profiles?token=${secret}`

  globalThis.fetch = async () => new Response(secret, { status: 503, statusText: secret })
  assert.equal(await getJson(path), null)
  assert.deepEqual(
    { ...lastRecord(), elapsedMs: 0 },
    {
      route: '/api/serve/model-profiles',
      method: 'GET',
      status: 503,
      reason: 'http-error',
      elapsedMs: 0,
      suppressedCount: 0,
    }
  )

  globalThis.fetch = async () => new Response(secret, { status: 401 })
  assert.equal(await getJson(path), null)
  assert.equal(events.length, 1)
  assert.equal(lastRecord().status, 401)

  const networkError = new TypeError(secret)
  globalThis.fetch = async () => {
    throw networkError
  }
  await assert.rejects(apiFetch(path), (error) => error === networkError)
  assert.equal(lastRecord().reason, 'network-error')
  assert.equal(lastRecord().status, null)

  for (const name of ['AbortError', 'TimeoutError', secret]) {
    globalThis.fetch = async () => {
      throw new DOMException(secret, name)
    }
    assert.equal(await getJson(path), null)
    assert.equal(
      lastRecord().reason,
      name === 'AbortError' ? 'aborted' : name === 'TimeoutError' ? 'timeout' : 'request-error'
    )
  }

  globalThis.fetch = async () => new Response(secret, { status: 200 })
  assert.equal(await getJson(path), null)
  assert.equal(lastRecord().reason, 'invalid-json')
  assert.equal(lastRecord().status, 200)
  globalThis.fetch = async () => {
    const response = Response.json({ ok: true })
    response.json = async () => {
      throw new TypeError(secret)
    }
    return response
  }
  assert.equal(await getJson(path), null)
  assert.equal(lastRecord().reason, 'response-read-error')
  globalThis.fetch = async () => new Response(secret, { status: 200 })
  assert.equal(await postJson(`/api/serve/sessions/${secret}`, { prompt: secret }), null)
  assert.equal(lastRecord().route, '/api/:resource')
  assert.equal(lastRecord().method, 'POST')

  flushApiDiagnostics()
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  assert.equal(await getJson(path, 1), null)
  assert.equal(lastRecord().reason, 'timeout')
  assert.equal(await postJson(path, { prompt: secret }, 1), null)
  assert.equal(lastRecord().reason, 'timeout')

  globalThis.fetch = async () => Response.json({ ok: true })
  const recordCount = records.length
  assert.deepEqual(await getJson(path), { ok: true })
  assert.deepEqual(await postJson(path, { apiKey: secret }), { ok: true })
  assert.equal(records.length, recordCount)
  assert.ok(!records.join('\n').includes(secret))
  assert.ok(
    records.every((record) =>
      Number.isFinite(JSON.parse(record.replace('[api-request] ', '')).elapsedMs)
    )
  )
})

test('GET and POST share authentication, parsing and request configuration semantics', async (context) => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalInfo = console.info
  let events = 0
  console.info = () => undefined
  Object.assign(globalThis, {
    window: {
      setTimeout,
      clearTimeout,
      dispatchEvent: () => {
        events += 1
      },
    },
  })
  context.after(() => {
    flushApiDiagnostics()
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
    console.info = originalInfo
  })
  for (const method of ['GET', 'POST']) {
    const request = (path: string) =>
      method === 'GET' ? getJson(path) : postJson(path, { value: 'kept' })
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.credentials, 'include')
      assert.equal(init?.method ?? 'GET', method)
      if (method === 'POST') {
        assert.deepEqual(init?.headers, { 'content-type': 'application/json' })
        assert.equal(init?.body, '{"value":"kept"}')
      }
      return Response.json({ ok: true })
    }
    assert.deepEqual(await request('/api/serve/model-profiles'), { ok: true })
    globalThis.fetch = async () => new Response(null, { status: 401 })
    const before = events
    assert.equal(await request('/api/auth/me'), null)
    assert.equal(events, before)
    assert.equal(await request('/api/serve/model-profiles'), null)
    assert.equal(events, before + 1)
    globalThis.fetch = async () => new Response('not JSON')
    assert.equal(await request('/api/serve/model-profiles'), null)
  }
  const circular: { self?: unknown } = {}
  circular.self = circular
  globalThis.fetch = async () => {
    throw new Error('serialization should fail before fetch')
  }
  assert.equal(await postJson('/api/serve/model-profiles', circular), null)
})

test('diagnostic sink failure never changes API failure semantics', async (context) => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalInfo = console.info
  Object.assign(globalThis, { window: {} })
  console.info = () => {
    throw new Error('unavailable diagnostic sink')
  }
  context.after(() => {
    flushApiDiagnostics()
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
    console.info = originalInfo
  })
  globalThis.fetch = async () => new Response(null, { status: 500 })
  assert.equal((await apiFetch('/api/serve/model-profiles')).status, 500)
  const failure = new TypeError('network unavailable')
  globalThis.fetch = async () => {
    throw failure
  }
  await assert.rejects(apiFetch('/api/serve/model-profiles'), (error) => error === failure)
  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.equal(await postJson('/api/serve/model-profiles', circular), null)
})

test('POST encoding failures report only safe metadata without issuing fetch', async (context) => {
  const originalFetch = globalThis.fetch
  const originalInfo = console.info
  const records: string[] = []
  let fetchCount = 0
  console.info = (...values) => records.push(values.join(' '))
  globalThis.fetch = async () => {
    fetchCount += 1
    return Response.json({ ok: true })
  }
  context.after(() => {
    flushApiDiagnostics()
    globalThis.fetch = originalFetch
    console.info = originalInfo
  })
  const secret = 'private-encoding-body-token'
  const circular: { prompt: string; self?: unknown } = { prompt: secret }
  circular.self = circular
  const bodies = [
    circular,
    { prompt: secret, value: BigInt(1) },
    {
      toJSON: () => {
        throw new Error(secret)
      },
    },
  ]
  for (const body of bodies)
    assert.equal(await postJson(`/api/serve/model-profiles/private-id?token=${secret}`, body), null)
  assert.equal(fetchCount, 0)
  assert.equal(records.length, 1)
  flushApiDiagnostics()
  assert.equal(records.length, 2)
  const parsed = records.map((record) => JSON.parse(record.replace('[api-request] ', '')))
  assert.deepEqual(
    parsed.map((record) => record.suppressedCount),
    [0, 2]
  )
  for (const record of parsed) {
    assert.equal(record.route, '/api/serve/model-profiles')
    assert.equal(record.method, 'POST')
    assert.equal(record.status, null)
    assert.equal(record.reason, 'request-serialization-error')
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0)
    assert.deepEqual(Object.keys(record).sort(), [
      'elapsedMs',
      'method',
      'reason',
      'route',
      'status',
      'suppressedCount',
    ])
  }
  assert.ok(!records.join('\n').includes(secret))
  assert.ok(!records.join('\n').includes('private-id'))
})

test('opt-in live catalog cache preserves ordinary fetch defaults, credentials, timeout cleanup and auth-required events', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: RequestInit[] = []
  const events: string[] = []
  let created = 0
  let cleared = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => 'http://serve.test' },
      setTimeout: () => {
        created += 1
        return 1
      },
      clearTimeout: () => {
        cleared += 1
      },
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    },
  })
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(options ?? {})
      return Response.json({ ok: true })
    }
    assert.deepEqual(await getJson('/ordinary'), { ok: true })
    assert.deepEqual(await getJson('/live', 500, LIVE_CATALOG_REQUEST), { ok: true })
    await apiFetch('/explicit-cache', { cache: 'reload' })
    assert.deepEqual(
      requests.map((request) => request.cache),
      [undefined, 'no-store', 'reload']
    )
    assert.ok(requests.every((request) => request.credentials === 'include'))
    assert.ok(requests[1].signal instanceof AbortSignal)
    assert.equal(created, 1)
    assert.equal(cleared, 1)
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    assert.equal(await getJson('/live', undefined, LIVE_CATALOG_REQUEST), null)
    assert.equal(await getJson('/api/auth/me', undefined, LIVE_CATALOG_REQUEST), null)
    assert.deepEqual(events, ['scholarseed:auth-required'])
  } finally {
    flushApiDiagnostics()
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
