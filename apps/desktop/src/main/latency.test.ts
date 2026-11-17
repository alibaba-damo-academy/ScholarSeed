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
