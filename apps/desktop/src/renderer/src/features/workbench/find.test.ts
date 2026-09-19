import assert from 'node:assert/strict'
import test from 'node:test'

import { findMatchNeedsTopSpace } from './occlusion.ts'

test('find top space follows the active match and discounts an existing view zone', () => {
  assert.equal(findMatchNeedsTopSpace(12, 68, 12, false), true)
  assert.equal(findMatchNeedsTopSpace(92, 68, 12, false), false)
  assert.equal(findMatchNeedsTopSpace(68, 68, 12, true), true)
  assert.equal(findMatchNeedsTopSpace(148, 68, 12, true), false)
})
