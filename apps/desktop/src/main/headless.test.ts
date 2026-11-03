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
    async () => {
      events.push('stop')
    },
    (code) => events.push(`exit:${code}`)
  )

  assert.deepEqual(events, ['check', 'stop', 'exit:1'])
})

test('does not exit until asynchronous backend shutdown finishes', async () => {
  const events: string[] = []
  let finishStop: () => void = () => undefined
  const stopping = new Promise<void>((resolve) => {
    finishStop = resolve
  })
  const check = finishHeadlessCheck(
    async () => 0,
    async () => {
      events.push('stop-requested')
      await stopping
      events.push('stopped')
    },
    (code) => events.push(`exit:${code}`)
  )
  await Promise.resolve()
  assert.deepEqual(events, ['stop-requested'])
  finishStop()
  await check
  assert.deepEqual(events, ['stop-requested', 'stopped', 'exit:0'])
})

test('shutdown failure does not claim successful exit', async () => {
  let exited = false
  await assert.rejects(
    finishHeadlessCheck(
      async () => 0,
      async () => {
        throw new Error('child still alive')
      },
      () => {
        exited = true
      }
    ),
    /child still alive/
  )
  assert.equal(exited, false)
})
