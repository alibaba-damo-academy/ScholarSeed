import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewDiagnostics, PREVIEW_DIAGNOSTIC_LIMIT } from './diagnostics.ts'

test('request diagnostics are bounded and snapshots do not expose mutable records', () => {
  const diagnostics = new PreviewDiagnostics()
  for (let index = 0; index < PREVIEW_DIAGNOSTIC_LIMIT + 2; index++) {
    diagnostics.record({ method: 'GET', path: '/api/serve/sessions', status: 200, durationMs: index, outcome: 'completed' })
  }
  const snapshot = diagnostics.snapshot()
  assert.equal(snapshot.length, PREVIEW_DIAGNOSTIC_LIMIT)
  assert.equal(snapshot[0].sequence, 3)
  snapshot[0].status = 500
  snapshot.length = 0
  assert.equal(diagnostics.snapshot()[0].status, 200)
  assert.deepEqual(new PreviewDiagnostics().snapshot(), [])
})

test('diagnostics discard query strings and never retain headers or response payloads', () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.record({ method: 'POST', path: '/api/serve/sessions?token=secret', status: 409, durationMs: 1.234, outcome: 'aborted', body: 'private message', headers: { authorization: 'secret' } } as Parameters<PreviewDiagnostics['record']>[0])
  assert.deepEqual(diagnostics.snapshot(), [{ sequence: 1, method: 'POST', path: '/api/serve/sessions', status: 409, durationMs: 1.234, outcome: 'aborted' }])
})
