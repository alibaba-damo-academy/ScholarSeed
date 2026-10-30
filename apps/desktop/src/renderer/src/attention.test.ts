import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionRequest, matchingAttentionAnchors, sessionNeedsAttention } from './attention.ts'

test('attention depends on unread reminders rather than task business status', () => {
  assert.equal(sessionNeedsAttention(0), false)
  assert.equal(sessionNeedsAttention(1), true)
  assert.equal(sessionNeedsAttention(3), true)
})

test('notification can reveal a non-first blocking request without resolving another request', () => {
  const requests = [{ requestId: 'first' }, { requestId: 'second' }]
  assert.equal(attentionRequest(requests, 'second'), requests[1])
  assert.equal(attentionRequest(requests, 'resolved'), requests[0])
  assert.equal(attentionRequest([], 'second'), undefined)
  assert.equal(requests.length, 2)
})

test('completion targets the final assistant, never the first prompt', () => {
  const anchors = [
    { messageTurnId: 'round', messageItemId: 'user', messageKind: 'user' },
    { messageTurnId: 'round', messageItemId: 'partial', messageKind: 'agent' },
    { messageTurnId: 'round', messageItemId: 'final', messageKind: 'agent' },
  ]
  assert.deepEqual(matchingAttentionAnchors(anchors, { turnId: 'round', kind: 'completed' }), [anchors[2]])
  assert.deepEqual(matchingAttentionAnchors(anchors, { turnId: 'round' }), [anchors[0]])
})

test('failure ignores partial assistant anchor and waits for the failure explanation', () => {
  const partial = { messageTurnId: 'round', messageItemId: 'partial', messageKind: 'agent' }
  const failure = { messageTurnId: 'round', messageKind: 'error' }
  const focus = { turnId: 'round', itemId: 'partial', kind: 'failed' as const }
  assert.deepEqual(matchingAttentionAnchors([partial], focus), [])
  assert.deepEqual(matchingAttentionAnchors([partial, failure], focus), [failure])
})

test('a new user request wins over stale message anchors and unmatched requests do not fall back', () => {
  const anchors = [
    { interactionRequestId: 'old' },
    { interactionRequestId: 'new' },
    { messageTurnId: 'round', messageItemId: 'final', messageKind: 'agent' },
  ]
  assert.deepEqual(matchingAttentionAnchors(anchors, { requestId: 'new', itemId: 'final' }), [anchors[1]])
  assert.deepEqual(matchingAttentionAnchors(anchors, { requestId: 'missing', itemId: 'final' }), [])
})

test('blocked recovery targets only its session recovery surface, not partial output or old errors', () => {
  const anchors = [
    { messageTurnId: 'round', messageKind: 'error' },
    { recoverySessionId: 'other-session', recoveryIncidentId: 'incident' },
    { recoverySessionId: 'session', recoveryIncidentId: 'incident' },
    { recoverySessionId: 'session', recoveryIncidentId: 'new-incident' },
  ]
  assert.deepEqual(matchingAttentionAnchors(anchors, {
    sessionId: 'session', turnId: 'round', kind: 'recovery', incidentId: 'incident',
  }), [anchors[2]])
  assert.deepEqual(matchingAttentionAnchors(anchors, {
    sessionId: 'session', kind: 'recovery', incidentId: 'unknown',
  }), [])
})
