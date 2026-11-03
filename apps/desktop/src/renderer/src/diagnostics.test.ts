import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installRendererDiagnostics,
  rendererDiagnosticsSnapshot,
  recordRendererCrash,
  rendererHasCrashed,
} from './diagnostics.ts'

test('renderer diagnostics retain the latest 50 redacted console and API records', async () => {
  const originalWindow = globalThis.window
  const originalWarn = console.warn
  const response = Response.json({ ok: true, token: 'response-secret' }, { status: 201 })
  const fetch = async (): Promise<Response> => response
  Object.assign(globalThis, {
    window: {
      fetch,
      location: { href: 'http://localhost/' },
    },
  })
  console.warn = (): void => undefined

  try {
    installRendererDiagnostics()
    assert.equal(rendererHasCrashed(), false)
    recordRendererCrash()
    assert.equal(rendererHasCrashed(), true)
    for (let index = 0; index < 55; index += 1) console.warn('message', index)
    await window.fetch('/api/example?token=query-secret', {
      method: 'POST',
      body: JSON.stringify({ password: 'request-secret', value: 'kept' }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const snapshot = rendererDiagnosticsSnapshot()
    assert.equal(rendererHasCrashed(), true, 'log ring eviction must not erase a render crash')
    assert.equal(snapshot.consoleMessages.length, 50)
    assert.equal(snapshot.consoleMessages[0]?.message, 'message 5')
    assert.equal(snapshot.networkRequests.length, 1)
    assert.equal(snapshot.networkRequests[0]?.path, '/api/example?token=%5Bredacted%5D')
    assert.match(snapshot.networkRequests[0]?.requestBody || '', /"password":"\[redacted\]"/)
    assert.match(snapshot.networkRequests[0]?.requestBody || '', /"value":"kept"/)
    assert.equal(snapshot.networkRequests[0]?.status, 201)
    assert.match(snapshot.networkRequests[0]?.responseBody || '', /"token":"\[redacted\]"/)
  } finally {
    console.warn = originalWarn
    Object.assign(globalThis, { window: originalWindow })
  }
})
