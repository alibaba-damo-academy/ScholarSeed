import assert from 'node:assert/strict'
import test from 'node:test'

import {
  selectLruTabClosures,
  trimTextHistory
} from './residency.ts'

test('editor limit closes least recently used eligible tabs first', () => {
  const closures = selectLruTabClosures(
    [
      { id: 'newest', lastSelectedSequence: 9, protected: false },
      { id: 'oldest', lastSelectedSequence: 1, protected: false },
      { id: 'middle', lastSelectedSequence: 5, protected: false }
    ],
    1
  )

  assert.deepEqual(closures, ['oldest', 'middle'])
})

test('editor limit excludes dirty, visible, and newly opened tabs', () => {
  const closures = selectLruTabClosures(
    [
      { id: 'dirty', lastSelectedSequence: 1, protected: true },
      { id: 'clean', lastSelectedSequence: 2, protected: false },
      { id: 'visible', lastSelectedSequence: 3, protected: true }
    ],
    1
  )

  assert.deepEqual(closures, ['clean'])
})

test('editor limit permits overflow when every tab is protected', () => {
  const closures = selectLruTabClosures(
    [
      { id: 'dirty', lastSelectedSequence: 1, protected: true },
      { id: 'visible', lastSelectedSequence: 2, protected: true }
    ],
    1
  )

  assert.deepEqual(closures, [])
})

test('text history trims the globally oldest snapshots to a byte budget', () => {
  const history = {
    past: [
      { text: 'oldest', sequence: 1 },
      { text: 'newer', sequence: 3 }
    ],
    future: [{ text: 'middle', sequence: 2 }]
  }

  trimTextHistory(history, 10)

  assert.deepEqual(history, {
    past: [{ text: 'newer', sequence: 3 }],
    future: []
  })
})
