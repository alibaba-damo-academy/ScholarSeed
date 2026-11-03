import assert from 'node:assert/strict'
import test from 'node:test'

import { clampFloatingOffset, isRecorderDragBlockedTarget } from './drag.ts'

test('feedback recorder floating offset stays inside the viewport', () => {
  const bounds = { baseLeft: 900, baseTop: 700, width: 80, height: 60 }
  const viewport = { width: 1000, height: 800 }

  assert.deepEqual(clampFloatingOffset(bounds, { x: 200, y: 200 }, viewport), { x: 4, y: 24 })
  assert.deepEqual(clampFloatingOffset(bounds, { x: 200, y: 200 }, viewport, 0), { x: 20, y: 40 })
  assert.deepEqual(clampFloatingOffset(bounds, { x: -1000, y: -1000 }, viewport), { x: -884, y: -684 })
})

test('feedback recorder whole-surface drag excludes interactive descendants', () => {
  const surface = new EventTarget()
  const target = (matched: EventTarget | null): EventTarget => ({
    closest: () => matched
  }) as unknown as EventTarget

  assert.equal(isRecorderDragBlockedTarget(target(new EventTarget()), surface), true)
  assert.equal(isRecorderDragBlockedTarget(target(surface), surface), false)
  assert.equal(isRecorderDragBlockedTarget(target(null), surface), false)
  assert.equal(isRecorderDragBlockedTarget(null), false)
})
