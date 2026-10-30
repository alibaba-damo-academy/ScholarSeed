import assert from 'node:assert/strict'
import test from 'node:test'
import { currentRuntimeReconfiguration, getSharedRuntimeReconfiguration, getRuntimeReconfiguration } from './api.ts'
import { RECONFIGURATION_RECOVERY, reconfigurationRecovery } from '../../reconfiguration.ts'

test('shared host recovery waits across sessions and unknown reads without treating them as retry failures', () => {
  assert.equal(reconfigurationRecovery('accepted', false), RECONFIGURATION_RECOVERY.wait)
  assert.equal(reconfigurationRecovery('accepted', true), RECONFIGURATION_RECOVERY.wait)
  assert.equal(reconfigurationRecovery(undefined, true), RECONFIGURATION_RECOVERY.wait)
  assert.equal(reconfigurationRecovery('restart_required', false), RECONFIGURATION_RECOVERY.blocked)
  assert.equal(reconfigurationRecovery(null, true), RECONFIGURATION_RECOVERY.proceed)
  assert.equal(reconfigurationRecovery('applied', true), RECONFIGURATION_RECOVERY.proceed)
  assert.equal(reconfigurationRecovery('rejected', true), RECONFIGURATION_RECOVERY.proceed)
})

test('runtime observation only reads and rejects mismatched or unknown operation responses', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  const sessionId = 'b'.repeat(32)
  const requestId = '12345678-1234-1234-1234-123456789abc'
  let status = 503
  let payload = {
    session_id: sessionId, request_id: requestId, model_id: 'target', state: 'applied', error: '',
  }
  const methods: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout, clearTimeout, scholarseed: { getApiBase: () => '' },
  } })
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? 'GET')
    return new Response(status === 204 ? null : JSON.stringify(payload), { status })
  }
  try {
    await assert.rejects(currentRuntimeReconfiguration(sessionId), /runtime_reconfiguration_unknown/)
    status = 200
    assert.equal((await currentRuntimeReconfiguration(sessionId))?.state, 'applied')
    assert.equal((await getRuntimeReconfiguration(sessionId, requestId)).request_id, requestId)
    await assert.rejects(getRuntimeReconfiguration('c'.repeat(32), requestId))
    await assert.rejects(getRuntimeReconfiguration(sessionId, '87654321-1234-1234-1234-123456789abc'))
    payload = { ...payload, state: 'unknown' }
    await assert.rejects(currentRuntimeReconfiguration(sessionId))
    status = 204
    assert.equal(await currentRuntimeReconfiguration(sessionId), undefined)
    assert.ok(methods.every(method => method === 'GET'))
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('shared recovery deadline covers a stalled fetch and response body', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout, clearTimeout, scholarseed: { getApiBase: () => '' },
  } })
  try {
    const fetchController = new AbortController()
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      assert.ok(signal)
      assert.equal(signal, fetchController.signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const stalledFetch = getSharedRuntimeReconfiguration(fetchController.signal)
    fetchController.abort()
    await assert.rejects(stalledFetch)

    const bodyController = new AbortController()
    let requests = 0
    let bodyReady: () => void = () => undefined
    const ready = new Promise<void>(resolve => { bodyReady = resolve })
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal
      assert.ok(signal)
      assert.equal(signal, bodyController.signal)
      requests += 1
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        bodyReady()
      } }))
    }
    const stalledBody = getSharedRuntimeReconfiguration(bodyController.signal)
    await ready
    bodyController.abort()
    await assert.rejects(stalledBody)
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
