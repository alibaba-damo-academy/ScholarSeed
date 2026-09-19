import assert from 'node:assert/strict'
import test from 'node:test'

import { finishHeadlessCheck } from './headless.ts'

test('stops the managed backend before exiting with the exact failed check code', async () => {
  const events: string[] = []

  await finishHeadlessCheck(
    async () => {
      events.push('check')
      return 1
    },
    () => events.push('stop'),
    (code) => events.push(`exit:${code}`)
  )

  assert.deepEqual(events, ['check', 'stop', 'exit:1'])
})
