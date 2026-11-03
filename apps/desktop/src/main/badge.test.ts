import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { badgeBitmap, badgeLabel, BADGE_SIZE, watchBadgeRestore } from './badge.ts'

test('Windows overlay counts have explicit bounded glyphs without changing source counts', () => {
  assert.equal(badgeLabel(0), '0')
  assert.equal(badgeLabel(99), '99')
  assert.equal(badgeLabel(123), '99+')
  assert.equal(badgeBitmap(123).length, BADGE_SIZE * BADGE_SIZE * 4)
  assert.ok(badgeBitmap(123).some((byte) => byte !== 0))
  assert.ok(badgeBitmap(0).every((byte) => byte === 0))
  assert.throws(() => badgeBitmap(-1), RangeError)
})

test('taskbar restoration reapplies unchanged counts and detaches with its window owner', () => {
  const window = new EventEmitter()
  const applied: number[] = []
  let count = -1
  const stop = watchBadgeRestore(window, () => count, (value) => applied.push(value))
  window.emit('show')
  assert.deepEqual(applied, [])
  count = 4
  window.emit('show')
  window.emit('restore')
  count = 0
  window.emit('show')
  assert.deepEqual(applied, [4, 4, 0])
  stop()
  window.emit('restore')
  assert.equal(window.listenerCount('show'), 0)
  assert.equal(window.listenerCount('restore'), 0)
  assert.deepEqual(applied, [4, 4, 0])
})
