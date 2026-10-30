import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionSnapshot } from './attention.ts'

const snapshot = {
  epoch: 'owner', revision: 3, unread_count: 1, by_session: { session: 1 },
  items: [{ id: 'reminder', session_id: 'session', kind: 'waiting', title: 'Task',
    body: 'Choose scope', request_id: 'request', turn_id: 'turn', item_id: null,
    created_at: 10, source_seq: 7, revision: 2 }],
}

test('global notification feed validates counts and navigation identity types', () => {
  assert.equal(attentionSnapshot(snapshot), snapshot)
  assert.throws(() => attentionSnapshot({ ...snapshot, unread_count: 2 }))
  assert.throws(() => attentionSnapshot({ ...snapshot, by_session: { other: 1 } }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], request_id: {} }] }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], kind: 'interrupted' }] }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], revision: 4 }] }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], source_seq: undefined }] }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], source_seq: -1 }] }))
  assert.throws(() => attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], incident_id: {} }] }))
  assert.equal(attentionSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], incident_id: 'incident' }] }).items[0].incident_id, 'incident')
})
