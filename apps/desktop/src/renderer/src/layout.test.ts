import assert from 'node:assert/strict'
import test from 'node:test'
import { createLayoutCoordinator } from './layout.ts'

test('layout batches all projections into prepare, measure and commit phases', () => {
  const frames = new Map<number, () => void>()
  let sequence = 0
  const coordinator = createLayoutCoordinator(
    (callback) => {
      const identifier = ++sequence
      frames.set(identifier, () => {
        frames.delete(identifier)
        callback()
      })
      return sequence
    },
    (frame) => {
      frames.delete(frame)
    }
  )
  const calls: string[] = []
  const browser = coordinator.register({
    prepare: () => {
      calls.push('browser.prepare')
    },
    measure: () => {
      calls.push('browser.measure')
      return () => {
        calls.push('browser.commit')
      }
    },
  })
  const divider = coordinator.register({
    prepare: () => {
      calls.push('divider.prepare')
    },
    measure: () => {
      calls.push('divider.measure')
      return () => {
        calls.push('divider.commit')
      }
    },
  })
  browser.invalidate()
  divider.invalidate()
  assert.equal(frames.size, 1)
  frames.get(sequence)!()
  assert.deepEqual(calls, [
    'browser.prepare',
    'divider.prepare',
    'browser.measure',
    'divider.measure',
    'browser.commit',
    'divider.commit',
  ])
  assert.equal(coordinator.revision, 1)
  browser.invalidate()
  browser.dispose()
  divider.dispose()
  assert.equal(frames.size, 0)
})

test('invalidation during a layout frame schedules a later frame and disposed projections never commit', () => {
  const frames: (() => void)[] = []
  const coordinator = createLayoutCoordinator(
    (callback) => {
      frames.push(callback)
      return frames.length
    },
    () => undefined
  )
  let prepared = 0
  let committed = 0
  const first = coordinator.register({
    prepare: () => {
      prepared++
      if (prepared === 1) first.invalidate()
    },
    measure: () => () => {
      committed++
    },
  })
  const removed = coordinator.register({
    measure: () => () => {
      throw new Error('disposed projection committed')
    },
  })
  removed.dispose()
  frames[0]()
  assert.equal(prepared, 1)
  assert.equal(committed, 1)
  assert.equal(frames.length, 2)
  frames[1]()
  assert.equal(prepared, 2)
  assert.equal(committed, 2)
  first.dispose()
})
