import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionContentLoaded, attentionRenderedSequence, canReadAttention } from './attention.ts'

test('reading requires foreground, loaded, visible content and no covering surface', () => {
  const ready = { focused: true, visible: true, loaded: true, covered: false }
  assert.equal(canReadAttention(ready), true)
  for (const field of ['focused', 'visible', 'loaded'] as const) {
    assert.equal(canReadAttention({ ...ready, [field]: false }), false)
  }
  assert.equal(canReadAttention({ ...ready, covered: true }), false)
})

test('a newer reminder cannot acknowledge an older visible streaming draft or error', () => {
  assert.equal(attentionContentLoaded(41, 42), false)
  assert.equal(attentionContentLoaded(42, 42), true)
  assert.equal(attentionContentLoaded(43, 42), true)
  assert.equal(attentionContentLoaded(43, 0), false)
  assert.equal(attentionContentLoaded(43, Number.NaN), false)
})

test('a history recovery card proves only its matching incident, not unseen streamed messages', () => {
  const thread = { lastSeq: 10, recoverySourceSeq: 20, recoveryIncidentId: 'current' }
  assert.equal(attentionRenderedSequence(thread, { anchor_kind: 'recovery', incident_id: 'current' }), 20)
  assert.equal(attentionRenderedSequence(thread, { anchor_kind: 'recovery', incident_id: 'old' }), 10)
  assert.equal(attentionRenderedSequence(thread, { anchor_kind: 'completed' }), 10)
  assert.equal(attentionRenderedSequence(thread, { anchor_kind: 'failed', incident_id: 'current' }), 10)
  assert.equal(thread.lastSeq, 10)
})
