import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TRASH_COMPLETION_MAX_ATTEMPTS,
  TRASH_COMPLETION_RETRY_DELAY_MS,
  TRASH_NOT_COMPLETED_ERROR,
  waitForTrashCompletion
} from './trash.ts'

test('waits for a delayed trash completion before reporting success', async () => {
  let requests = 0
  const delays: number[] = []
  const result = await waitForTrashCompletion(
    async () => {
      requests += 1
      return requests < 3
        ? { ok: false, retryable: true, error: TRASH_NOT_COMPLETED_ERROR }
        : { ok: true }
    },
    async (milliseconds) => { delays.push(milliseconds) }
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(requests, 3)
  assert.deepEqual(delays, [TRASH_COMPLETION_RETRY_DELAY_MS, TRASH_COMPLETION_RETRY_DELAY_MS])
})

test('does not retry permanent trash errors', async () => {
  let requests = 0
  let delays = 0
  const result = await waitForTrashCompletion(
    async () => {
      requests += 1
      return { ok: false, retryable: false, error: 'invalid_trash_token' }
    },
    async () => { delays += 1 }
  )

  assert.deepEqual(result, { ok: false, retryable: false, error: 'invalid_trash_token' })
  assert.equal(requests, 1)
  assert.equal(delays, 0)
})

test('returns the last pending error after bounded retries', async () => {
  let requests = 0
  const result = await waitForTrashCompletion(
    async () => {
      requests += 1
      return { ok: false, retryable: true, error: TRASH_NOT_COMPLETED_ERROR }
    },
    async () => undefined
  )

  assert.equal(requests, TRASH_COMPLETION_MAX_ATTEMPTS)
  assert.deepEqual(result, { ok: false, retryable: true, error: TRASH_NOT_COMPLETED_ERROR })
})
