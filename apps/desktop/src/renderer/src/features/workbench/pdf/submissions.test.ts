import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceSubmission } from './submissions.ts'

test('reselect during submission waits for its task id and cancellation before submitting', async () => {
  const events: string[] = []
  let acknowledge!: (task: { task_id: string; status: string }) => void
  const previous = new Promise<{ task_id: string; status: string }>(resolve => { acknowledge = resolve })
  const replacement = replaceSubmission(previous, () => true,
    async () => { events.push('submit'); return { task_id: 'new', status: 'pending' } },
    async id => { events.push(`cancel:${id}`) })
  assert.deepEqual(events, [])
  acknowledge({ task_id: 'old', status: 'running' })
  assert.equal((await replacement)?.task_id, 'new')
  assert.deepEqual(events, ['cancel:old', 'submit'])
})

test('a superseded intermediate crop is never submitted but its predecessor is cancelled', async () => {
  const events: string[] = []
  const result = await replaceSubmission(Promise.resolve({ task_id: 'old', status: 'pending' }),
    () => false,
    async () => { throw new Error('stale crop submitted') },
    async id => { events.push(id) })
  assert.equal(result, undefined)
  assert.deepEqual(events, ['old'])
})

test('cancellation failure blocks replacement instead of starting competing work', async () => {
  await assert.rejects(replaceSubmission(Promise.resolve({ task_id: 'old', status: 'running' }),
    () => true,
    async () => { throw new Error('must not submit') },
    async () => { throw new Error('cancel failed') }), /cancel failed/)
})

test('completed or rejected submissions permit a new crop without cancellation', async () => {
  for (const previous of [Promise.resolve({ task_id: 'old', status: 'completed' }), Promise.reject(new Error('rejected'))]) {
    const result = await replaceSubmission(previous, () => true,
      async () => ({ task_id: 'new', status: 'pending' }),
      async () => { throw new Error('nothing to cancel') })
    assert.equal(result?.task_id, 'new')
  }
})
