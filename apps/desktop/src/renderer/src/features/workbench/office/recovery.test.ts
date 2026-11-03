import assert from 'node:assert/strict'
import test from 'node:test'

import { INITIAL_OFFICE_RECOVERY, officeRecovery, officeRetrySeconds } from './recovery.ts'
import { INITIAL_OFFICE_WARMUP_STATUS } from './progress.ts'

const failure = { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'error' as const, error: 'runtime-assets' as const, detail: 'WASM download failed' }

test('asset failure schedules one retry and preserves diagnostic detail', () => {
  const failed = officeRecovery(INITIAL_OFFICE_RECOVERY, { type: 'status', status: failure, now: 1000 })
  assert.equal(failed.retryAt, 16000)
  assert.equal(failed.attempt, 0)
  assert.equal(failed.status.detail, failure.detail)
  assert.equal(officeRetrySeconds(failed, 1500), 15)
  assert.equal(officeRecovery(failed, { type: 'status', status: failure, now: 2000 }), failed)
})

test('retry starts a new frame attempt without completing progress', () => {
  const failed = officeRecovery(INITIAL_OFFICE_RECOVERY, { type: 'status', status: failure, now: 0 })
  const retrying = officeRecovery(failed, { type: 'retry' })
  assert.equal(retrying.attempt, 1)
  assert.equal(retrying.retryAt, null)
  assert.equal(retrying.status.stage, 'permission')
  const reading = officeRecovery(retrying, { type: 'status', status: { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'reading', done: 5, total: 10 }, now: 16000 })
  assert.equal(reading.status.done, 5)
  assert.equal(reading.attempt, 1)
})

test('three failed retries terminate and manual reset restores the budget', () => {
  let state = INITIAL_OFFICE_RECOVERY
  for (const delay of [15000, 45000, 120000]) {
    state = officeRecovery(state, { type: 'status', status: failure, now: 0 })
    assert.equal(state.retryAt, delay)
    state = officeRecovery(state, { type: 'retry' })
  }
  state = officeRecovery(state, { type: 'status', status: failure, now: 0 })
  assert.equal(state.retryAt, null)
  assert.equal(state.status.stage, 'error')
  assert.equal(state.attempt, 3)
  assert.equal(officeRecovery(state, { type: 'reset' }), INITIAL_OFFICE_RECOVERY)
})

test('permission denial and document failure do not automatically retry', () => {
  for (const error of ['font-permission', 'document-load'] as const) {
    const state = officeRecovery(INITIAL_OFFICE_RECOVERY, { type: 'status', status: { ...failure, error }, now: 0 })
    assert.equal(state.retryAt, null)
    assert.equal(state.status.error, error)
  }
})

test('timeout cancels backoff and late progress does not hide the failure', () => {
  const failed = officeRecovery(INITIAL_OFFICE_RECOVERY, { type: 'status', status: failure, now: 0 })
  const timedOut = officeRecovery(failed, { type: 'timeout' })
  assert.equal(timedOut.retryAt, null)
  assert.equal(timedOut.status.error, 'warmup-timeout')
  assert.equal(officeRecovery(timedOut, { type: 'retry' }), timedOut)
  assert.equal(officeRecovery(timedOut, { type: 'status', status: INITIAL_OFFICE_WARMUP_STATUS, now: 0 }), timedOut)
})

test('a ready runtime cancels retries but a later crash is still reported', () => {
  const ready = officeRecovery(INITIAL_OFFICE_RECOVERY, { type: 'status', status: { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'ready' }, now: 0 })
  assert.equal(ready.retryAt, null)
  assert.equal(ready.status.stage, 'ready')
  assert.equal(officeRecovery(ready, { type: 'status', status: failure, now: 0 }).status.stage, 'error')
})
