import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  WebContents,
  OnSendHeadersListenerDetails,
  OnResponseStartedListenerDetails,
  OnCompletedListenerDetails,
} from 'electron'
import { installNetworkDiagnostics, NETWORK_DIAGNOSTIC_LIMIT } from './latency.ts'
import { API_DIAGNOSTIC_HEADER } from '../requests.ts'

const CORRELATION = '0123456789abcdef0123456789abcdef'
const BASE = 'http://127.0.0.1:9000'

function fixture() {
  const listeners: Record<string, ((details: unknown) => void) | null> = {}
  const records: Record<string, unknown>[] = []
  let destroyed = false
  const webRequest = Object.fromEntries(
    ['onSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'].map((name) => [
      name,
      (listener: ((details: unknown) => void) | null) => {
        listeners[name] = listener
      },
    ])
  )
  const contents = {
    get id() {
      assert.equal(destroyed, false)
      return 17
    },
    get session() {
      assert.equal(destroyed, false)
      return { webRequest }
    },
  } as unknown as WebContents
  const dispose = installNetworkDiagnostics(
    contents,
    () => BASE,
    (message) => {
      records.push(JSON.parse(message.slice(message.indexOf('{'))))
    }
  )
  return {
    records,
    dispose,
    listeners,
    send(id = 1, overrides: Partial<OnSendHeadersListenerDetails> = {}) {
      assert.equal(destroyed, false)
      listeners.onSendHeaders?.({
        id,
        webContentsId: 17,
        url: `${BASE}/api/serve/sessions?query=private`,
        method: 'GET',
        timestamp: 1000,
        requestHeaders: { [API_DIAGNOSTIC_HEADER]: CORRELATION },
        ...overrides,
      })
    },
    destroy() {
      destroyed = true
    },
    headers(id = 1) {
      listeners.onResponseStarted?.({
        id,
        webContentsId: 17,
        statusCode: 200,
      } as OnResponseStartedListenerDetails)
    },
    complete(id = 1) {
      listeners.onCompleted?.({
        id,
        webContentsId: 17,
        statusCode: 200,
      } as OnCompletedListenerDetails)
    },
  }
}

test('native send, headers and completion share the exact renderer correlation', () => {
  const state = fixture()
  state.send()
  state.headers()
  state.complete()
  assert.deepEqual(
    state.records.map((record) => record.event),
    ['request_sent', 'request_completed']
  )
  assert.ok(state.records.every((record) => record.client_request_id === CORRELATION))
  assert.equal(state.records[0].diagnostic_previous_enqueue_ms, null)
  assert.equal(state.records[1].diagnostic_previous_enqueue_event, 'request_sent')
  assert.ok(Number(state.records[1].diagnostic_previous_enqueue_ms) >= 0)
  assert.ok(Number(state.records[1].response_started_elapsed_ms) >= 0)
  assert.ok(Number(state.records[1].transfer_after_headers_ms) >= 0)
  assert.ok(!JSON.stringify(state.records).includes('private'))
  state.dispose()
})

test('catalog scope is visible without exposing project paths or search content', () => {
  const state = fixture()
  state.send(1, {
    url: `${BASE}/api/serve/sessions?scope=project&archived=true&limit=60&include_last_agent_reply=false&project_path=private&query=private`,
  })
  try {
    assert.deepEqual(state.records[0].catalog, {
      scope: 'project',
      archived: true,
      include_last_agent_reply: false,
      limit: 60,
    })
    assert.ok(!JSON.stringify(state.records).includes('private'))
  } finally {
    state.dispose()
  }
})

test('catalog diagnostics expose same-backend activity and a named event-loop window', () => {
  const state = fixture()
  state.send(10, { url: `${BASE}/api/serve/sessions/private-session/events` })
  state.headers(10)
  state.send(11, { url: `${BASE}/api/serve/runtime/prepare/private-preparation` })
  state.send(12)
  try {
    const activity = state.records[0].backend_activity as Record<string, unknown>
    assert.equal(activity.inflight_total, 3)
    assert.equal(activity.with_headers, 1)
    assert.deepEqual(activity.categories, { session_stream: 1, runtime_preparation: 1, catalog: 1 })
    const loop = state.records[0].main_loop as Record<string, unknown>
    assert.ok(Number(loop.window_ended_timestamp_ms) >= Number(loop.window_started_timestamp_ms))
    assert.ok(!JSON.stringify(state.records).includes('private'))
    state.complete(10)
    state.complete(11)
    state.complete(12)
    assert.equal((state.records[1].backend_activity as Record<string, unknown>).inflight_total, 0)
  } finally {
    state.dispose()
  }
})

test('activity is bounded, excludes other backends and never claims to count sockets', () => {
  const state = fixture()
  try {
    for (let index = 0; index < NETWORK_DIAGNOSTIC_LIMIT; index += 1)
      state.send(index, { url: `${BASE}/api/serve/sessions/private/events` })
    state.send(500, { url: 'https://private.example/api/serve/sessions/private/events' })
    state.send(501, { webContentsId: 99 })
    state.send(502)
    const activity = state.records[0].backend_activity as Record<string, unknown>
    assert.equal(activity.inflight_total, NETWORK_DIAGNOSTIC_LIMIT)
    assert.equal(activity.evicted_observations, 1)
    assert.ok(!JSON.stringify(state.records).includes('private'))
    assert.equal(activity.socket_count, undefined)
  } finally {
    state.dispose()
  }
})

test('ambiguous or malformed scope values do not enter diagnostic logs', () => {
  const state = fixture()
  try {
    state.send(1, {
      url: `${BASE}/api/serve/sessions?scope=private&scope=project&archived=private&limit=private&include_last_agent_reply=private`,
    })
    assert.deepEqual(state.records[0].catalog, {
      scope: null,
      archived: null,
      include_last_agent_reply: null,
      limit: null,
    })
    assert.ok(!JSON.stringify(state.records).includes('private'))
  } finally {
    state.dispose()
  }
})

test('unrelated origins, routes, contents and malformed identifiers are excluded', () => {
  const state = fixture()
  state.send(1, { url: 'https://external.test/api/serve/sessions' })
  state.send(2, { url: `${BASE}/api/auth/me` })
  state.send(3, { webContentsId: 18 })
  state.send(4, { requestHeaders: { [API_DIAGNOSTIC_HEADER]: 'private-value' } })
  state.complete(4)
  assert.deepEqual(state.records, [])
  state.dispose()
})

test('destroyed contents are never accessed by native callbacks or disposal', () => {
  const state = fixture()
  state.send()
  state.destroy()
  state.headers()
  state.complete()
  state.dispose()
  assert.equal(state.records.length, 2)
  assert.ok(Object.values(state.listeners).every((listener) => listener === null))
})

test('a native failure is recorded rather than a fabricated completion', () => {
  const state = fixture()
  state.send()
  state.listeners.onErrorOccurred?.({ id: 1, webContentsId: 17, error: 'net::ERR_ABORTED' })
  state.complete()
  assert.deepEqual(
    state.records.map((record) => record.event),
    ['request_sent', 'request_failed']
  )
  state.dispose()
})

test('incomplete native observations are bounded and never reported complete', () => {
  const state = fixture()
  for (let index = 0; index <= NETWORK_DIAGNOSTIC_LIMIT; index += 1) state.send(index)
  assert.equal(state.records.filter((record) => record.event === 'request_evicted').length, 1)
  state.dispose()
  assert.equal(
    state.records.filter((record) => record.event === 'observation_disposed').length,
    NETWORK_DIAGNOSTIC_LIMIT
  )
  assert.ok(!state.records.some((record) => record.event === 'request_completed'))
})

test('a replaced observer is not removed by the old window disposal', () => {
  const listeners: Record<string, unknown> = {}
  const webRequest = Object.fromEntries(
    ['onSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'].map((name) => [
      name,
      (listener: unknown) => {
        listeners[name] = listener
      },
    ])
  )
  const contents = { id: 17, session: { webRequest } } as unknown as WebContents
  const first = installNetworkDiagnostics(
    contents,
    () => BASE,
    () => undefined
  )
  const second = installNetworkDiagnostics(
    contents,
    () => BASE,
    () => undefined
  )
  first()
  assert.ok(Object.values(listeners).every((listener) => typeof listener === 'function'))
  second()
  assert.ok(Object.values(listeners).every((listener) => listener === null))
})

test('a failed native diagnostic sink does not escape observation callbacks', () => {
  const listeners: Record<string, ((details: unknown) => void) | null> = {}
  const webRequest = Object.fromEntries(
    ['onSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'].map((name) => [
      name,
      (listener: ((details: unknown) => void) | null) => {
        listeners[name] = listener
      },
    ])
  )
  const contents = { id: 17, session: { webRequest } } as unknown as WebContents
  const dispose = installNetworkDiagnostics(
    contents,
    () => BASE,
    () => {
      throw new Error('unavailable')
    }
  )
  assert.doesNotThrow(() => {
    listeners.onSendHeaders?.({
      id: 1,
      webContentsId: 17,
      url: `${BASE}/api/serve/sessions`,
      method: 'GET',
      requestHeaders: { [API_DIAGNOSTIC_HEADER]: CORRELATION },
    })
    listeners.onResponseStarted?.({ id: 1, statusCode: 200 })
    listeners.onCompleted?.({ id: 1, statusCode: 200 })
  })
  dispose()
})
