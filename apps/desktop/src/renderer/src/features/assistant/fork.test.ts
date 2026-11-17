import assert from 'node:assert/strict'
import test from 'node:test'

import { forkBoundaryIndex, parseForkOrigin } from './fork.ts'
import type { ActivityRow } from '../../activity.ts'

const inherited = [{ turn_id: 'inherited', item_id: 'answer' }]

test('fork boundary stays after inherited rows including grouped artifacts', () => {
  const rows: ActivityRow[] = [
    {
      kind: 'item',
      key: 'answer',
      item: { kind: 'agent', text: 'answer', turnId: 'inherited', itemId: 'answer' },
    },
    { kind: 'artifacts', key: 'files', turnId: 'inherited', items: [] },
    { kind: 'item', key: 'new', item: { kind: 'user', text: 'new', itemId: 'new' } },
  ]
  assert.equal(forkBoundaryIndex(rows, inherited), 2)
  assert.equal(forkBoundaryIndex(rows.slice(0, 2), inherited), 2)
  assert.equal(forkBoundaryIndex(rows, []), 0)
  assert.equal(forkBoundaryIndex(rows, [{ turn_id: '', item_id: 'new' }]), 3)
})

test('origin parsing rejects false available targets and malformed boundaries', () => {
  const origin = {
    source_session_id: 'actual-child',
    source_product_seq: 12,
    source_turn_id: null,
    inherited_messages: inherited,
    anchor: inherited[0],
    status: 'deleted',
    title: null,
    title_fallback: null,
    navigation: null,
  }
  assert.deepEqual(parseForkOrigin(origin), origin)
  assert.throws(() => parseForkOrigin({ ...origin, status: 'available' }))
  assert.throws(() => parseForkOrigin({ ...origin, inherited_messages: [{ item_id: 1 }] }))
  assert.throws(() => parseForkOrigin({ ...origin, status: 'unknown' }))
  assert.equal(parseForkOrigin(null), null)
})
