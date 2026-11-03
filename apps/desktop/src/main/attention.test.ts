import assert from 'node:assert/strict'
import test from 'node:test'
import { AttentionDelivery } from './attention.ts'
import type { AttentionSnapshot } from '../attention.ts'

const snapshot = (revision: number, ids: number[] = [revision]): AttentionSnapshot => ({
  epoch: 'scope', revision, unread_count: ids.length, by_session: { session: ids.length },
  items: ids.map((value) => ({ id: `reminder-${value}`, session_id: 'session', kind: 'completed',
    title: 'Task', body: 'Result', created_at: value, source_seq: value, revision: value,
    request_id: null, turn_id: 'turn', item_id: null })),
})

function fixture() {
  const submitted: string[] = []
  const persisted: number[] = []
  const counts: number[] = []
  let foreground = false
  let persistenceFailure = false
  const delivery = new AttentionDelivery({
    persist: (cursor) => { if (persistenceFailure) throw new Error('disk'); persisted.push(cursor.revision) },
    foreground: () => foreground,
    show: (item) => { assert.ok((persisted.at(-1) ?? -1) >= item.revision); submitted.push(item.id) },
    reconcile: (state) => counts.push(state.unread_count),
  })
  return { delivery, submitted, persisted, counts,
    focus: (value: boolean) => { foreground = value },
    fail: () => { persistenceFailure = true },
  }
}

test('cold startup restores counts without replaying historical notifications', () => {
  const state = fixture()
  state.delivery.accept(snapshot(1))
  assert.deepEqual(state.submitted, [])
  assert.deepEqual(state.counts, [1])
  state.delivery.accept(snapshot(2))
  state.delivery.accept(snapshot(2))
  assert.deepEqual(state.submitted, ['reminder-2'])
})

test('foreground suppression is permanent but does not suppress unread counts', () => {
  const state = fixture()
  state.delivery.accept(snapshot(0, []))
  state.focus(true)
  state.delivery.accept(snapshot(1))
  state.focus(false)
  state.delivery.accept(snapshot(1))
  state.delivery.accept(snapshot(2, [1, 2]))
  assert.deepEqual(state.submitted, ['reminder-2'])
  assert.equal(state.counts.at(-1), 2)
})

test('changing owner or backend epoch restores counts without leaking old deliveries', () => {
  const state = fixture()
  state.delivery.accept(snapshot(0, []))
  state.delivery.accept({ ...snapshot(8), epoch: 'other-owner' })
  assert.deepEqual(state.submitted, [])
  state.delivery.accept({ ...snapshot(9), epoch: 'other-owner' })
  assert.deepEqual(state.submitted, ['reminder-9'])
})

test('durable delivery intent is required before submitting notifications', () => {
  const state = fixture()
  state.delivery.accept(snapshot(0, []))
  state.fail()
  assert.throws(() => state.delivery.accept(snapshot(1)), /disk/)
  assert.deepEqual(state.submitted, [])
  assert.equal(state.counts.at(-1), 1)
})

test('read-only changes reconcile native surfaces without re-delivery', () => {
  const state = fixture()
  state.delivery.accept(snapshot(0, []))
  state.delivery.accept(snapshot(1))
  state.delivery.accept(snapshot(2, []))
  assert.deepEqual(state.submitted, ['reminder-1'])
  assert.equal(state.counts.at(-1), 0)
})

test('foreground is rechecked before each notification in the same feed snapshot', () => {
  const decisions: string[] = []
  let focused = false
  const delivery = new AttentionDelivery({
    persist() {},
    reconcile() {},
    foreground: () => focused,
    show: () => { focused = true },
    decision: (_item, decision) => decisions.push(decision),
  })
  delivery.accept(snapshot(0, []))
  delivery.accept(snapshot(2, [1, 2]))
  assert.deepEqual(decisions, ['submit', 'foreground'])
})

test('session deletion still reconciles unread surfaces when the event revision is unchanged', () => {
  const state = fixture()
  state.delivery.accept(snapshot(1, [1]))
  state.delivery.accept(snapshot(1, []))
  assert.deepEqual(state.counts, [1, 0])
  assert.deepEqual(state.submitted, [])
})
