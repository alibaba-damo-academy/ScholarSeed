import assert from 'node:assert/strict'
import test from 'node:test'

import { suggestionPosition, sourceNeedsDisclosure } from './utils.ts'

test('suggestion uses its measured height near the viewport bottom', () => {
  assert.deepEqual(suggestionPosition({ left: 800, top: 520 }, { width: 520, height: 368.5 }, { width: 1280, height: 840 }), { left: 748, top: 459.5 })
})

test('suggestion reclamps measured dimensions after growth, dragging and viewport shrink', () => {
  assert.deepEqual(suggestionPosition({ left: -30, top: -90 }, { width: 400, height: 350 }, { width: 600, height: 500 }), { left: 12, top: 12 })
  assert.deepEqual(suggestionPosition({ left: 748, top: 459.5 }, { width: 520, height: 440 }, { width: 800, height: 600 }), { left: 268, top: 148 })
  assert.deepEqual(suggestionPosition({ left: 100, top: 100 }, { width: 376, height: 276 }, { width: 400, height: 300 }), { left: 12, top: 12 })
})

test('source disclosure uses rendered lines including soft wrapping', () => {
  assert.equal(sourceNeedsDisclosure(84, 28), false)
  assert.equal(sourceNeedsDisclosure(56, 28), false)
  assert.equal(sourceNeedsDisclosure(112, 28), true)
})
