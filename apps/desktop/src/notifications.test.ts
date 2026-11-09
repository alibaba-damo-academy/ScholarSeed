import assert from 'node:assert/strict'
import test from 'node:test'
import { DirtyRefresh, notificationFrame, NotificationStream } from './notifications.ts'

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

test('snapshot failure retries independently and success stops requests', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const applied: number[] = []
  const refresh = new DirtyRefresh(
    async () => {
      attempts++
      if (attempts === 1) throw new Error('503')
      return attempts
    },
    (value) => applied.push(value)
  )
  refresh.invalidate()
  context.mock.timers.tick(0)
  await flush()
  context.mock.timers.tick(30_000)
  await flush()
  assert.deepEqual(applied, [2])
  context.mock.timers.tick(120_000)
  await flush()
  assert.equal(attempts, 2)
  refresh.stop()
})

test('in-flight invalidation catches up serially and stop rejects late results', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const resolve: Array<(value: number) => void> = []
  const applied: number[] = []
  const refresh = new DirtyRefresh(
    () => new Promise<number>((done) => resolve.push(done)),
    (value) => applied.push(value)
  )
  refresh.invalidate()
  context.mock.timers.tick(0)
  refresh.invalidate()
  refresh.invalidate()
  assert.equal(resolve.length, 1)
  resolve[0](1)
  await flush()
  context.mock.timers.tick(0)
  assert.equal(resolve.length, 2)
  refresh.stop()
  resolve[1](2)
  await flush()
  assert.deepEqual(applied, [1])
})

test('frames reject unknown topics and malformed payloads', () => {
  assert.throws(() =>
    notificationFrame('changed', { instance_id: 'one', changes: [{ topic: 'secret' }] })
  )
  assert.equal(notificationFrame('ready', { instance_id: 'one', changes: [] }).reset, true)
})

test('backend reset discards the previous snapshot even if abort is ignored', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const resolve: Array<(value: number) => void> = []
  const applied: number[] = []
  const refresh = new DirtyRefresh(
    () => new Promise<number>((done) => resolve.push(done)),
    (value) => applied.push(value)
  )
  refresh.invalidate()
  context.mock.timers.tick(0)
  refresh.invalidate(true)
  resolve[0](1)
  await flush()
  context.mock.timers.tick(0)
  resolve[1](2)
  await flush()
  assert.deepEqual(applied, [2])
  refresh.stop()
})

test('authentication failure retires the stream without reconnecting', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  let invalidated = 0
  const stream = new NotificationStream(
    async () => {
      requests++
      return new Response(null, { status: 401 })
    },
    () => assert.fail('no old state'),
    () => {
      invalidated++
    }
  )
  stream.start()
  await flush()
  context.mock.timers.tick(120_000)
  await flush()
  assert.equal(requests, 1)
  assert.equal(invalidated, 1)
  stream.stop()
})
