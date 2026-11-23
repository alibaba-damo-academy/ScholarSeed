import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttentionItem } from '../../attention.ts'
import { attentionRequest, matchingAttentionAnchors, sessionNeedsAttention, visibleAttentionIds } from './attention.ts'

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

function completed(id: string, fields: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    session_id: 'session',
    item_id: id,
    turn_id: id,
    request_id: null,
    kind: 'completed',
    source_seq: 1,
    revision: 1,
    created_at: 1,
    title: '',
    body: '',
    ...fields,
  }
}

test('a visibility inspection reads its DOM snapshot and indexes each lookup field once', () => {
  const reminders = Array.from({ length: 400 }, (_, index) => completed(String(index)))
  let scans = 0
  let itemReads = 0
  let visibleId = '399'
  const anchors = reminders.map(({ id }) => ({
    get messageItemId() {
      itemReads++
      return id
    },
    visible: () => id === visibleId,
  }))
  const inspect = (sessionId: string, lastSeq: number) =>
    visibleAttentionIds(
      { sessionId, lastSeq },
      reminders,
      () => {
        scans++
        return anchors
      },
      (anchor) => anchor.visible()
    )

  assert.deepEqual(inspect('other', 1), [])
  assert.deepEqual(inspect('session', 0), [])
  assert.equal(scans, 0)
  assert.deepEqual(inspect('session', 1), ['399'])
  assert.equal(scans, 1)
  assert.equal(itemReads, 400)

  visibleId = '0'
  assert.deepEqual(inspect('session', 1), ['0'])
  assert.equal(scans, 2)
  assert.equal(itemReads, 800)
})

test('batched reads honor anchor priority, document order, visibility and recovery sequence', () => {
  const reminders = [
    completed('hidden', { turn_id: 'turn' }),
    completed('fallback', { item_id: null, turn_id: 'turn' }),
    completed('duplicate'),
    completed('failed', { kind: 'failed', item_id: 'agent', turn_id: 'turn' }),
    completed('pending', { request_id: 'held', turn_id: 'turn' }),
    completed('missing', { request_id: 'absent', item_id: 'agent' }),
    completed('recovery', { anchor_kind: 'recovery', incident_id: 'current', source_seq: 2 }),
    completed('stale', { anchor_kind: 'recovery', incident_id: 'older', source_seq: 2 }),
    completed('future', { item_id: 'agent', source_seq: 3 }),
    completed('foreign', { session_id: 'other', item_id: 'agent' }),
  ]
  const anchors = [
    { messageTurnId: 'turn', messageKind: 'agent', messageItemId: 'hidden', visible: false },
    { messageTurnId: 'turn', messageKind: 'agent', messageItemId: 'agent', visible: true },
    { messageTurnId: 'turn', messageKind: 'error', visible: false },
    { messageItemId: 'duplicate', visible: false },
    { messageItemId: 'duplicate', visible: true },
    { interactionRequestId: 'held', visible: true },
    { recoverySessionId: 'session', recoveryIncidentId: 'current', visible: true },
    { recoverySessionId: 'session', recoveryIncidentId: 'older', visible: true },
  ]
  const ids = visibleAttentionIds(
    { sessionId: 'session', lastSeq: 1, recoveryIncidentId: 'current', recoverySourceSeq: 2 },
    reminders,
    () => anchors,
    (anchor) => anchor.visible
  )
  assert.deepEqual(ids, ['fallback', 'duplicate', 'pending', 'recovery'])
})
