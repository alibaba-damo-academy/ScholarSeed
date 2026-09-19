import assert from 'node:assert/strict'
import test from 'node:test'

import { clampFloatingOffset } from './drag.ts'

test('feedback recorder floating offset stays inside the viewport', () => {
  const bounds = { baseLeft: 900, baseTop: 700, width: 80, height: 60 }
  const viewport = { width: 1000, height: 800 }

  assert.deepEqual(clampFloatingOffset(bounds, { x: 200, y: 200 }, viewport), { x: 4, y: 24 })
  assert.deepEqual(clampFloatingOffset(bounds, { x: -1000, y: -1000 }, viewport), { x: -884, y: -684 })
})
