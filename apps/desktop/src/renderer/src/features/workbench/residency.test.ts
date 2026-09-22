import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateDocumentResidentBytes,
  selectLfsEvictions,
  shouldMountDocumentView,
  trimTextHistory
} from './residency.ts'

test('LFS evicts the least selected resident background session first', () => {
  const evictions = selectLfsEvictions(
    [
      {
        id: 'frequent',
        residentBytes: 8,
        selectionCount: 3,
        lastSelectedSequence: 4,
        protected: false
      },
      {
        id: 'least',
        residentBytes: 8,
        selectionCount: 1,
        lastSelectedSequence: 3,
        protected: false
      },
      {
        id: 'visible',
        residentBytes: 8,
        selectionCount: 0,
        lastSelectedSequence: 1,
        protected: true,
        budgeted: false
      }
    ],
    { maxBackgroundSessions: 1, maxBackgroundBytes: 16 }
  )

  assert.deepEqual(evictions, ['least'])
})

test('LFS breaks equal-frequency ties by the oldest selection', () => {
  const evictions = selectLfsEvictions(
    [
      {
        id: 'newer',
        residentBytes: 8,
        selectionCount: 1,
        lastSelectedSequence: 7,
        protected: false
      },
      {
        id: 'older',
        residentBytes: 8,
        selectionCount: 1,
        lastSelectedSequence: 2,
        protected: false
      }
    ],
    { maxBackgroundSessions: 1, maxBackgroundBytes: 16 }
  )

  assert.deepEqual(evictions, ['older'])
})

test('LFS converges both count and byte budgets without selecting protected sessions', () => {
  const evictions = selectLfsEvictions(
    [
      {
        id: 'protected',
        residentBytes: 128,
        selectionCount: 0,
        lastSelectedSequence: 0,
        protected: true,
        budgeted: false
      },
      {
        id: 'first',
        residentBytes: 64,
        selectionCount: 1,
        lastSelectedSequence: 1,
        protected: false
      },
      {
        id: 'second',
        residentBytes: 64,
        selectionCount: 2,
        lastSelectedSequence: 2,
        protected: false
      },
      {
        id: 'third',
        residentBytes: 64,
        selectionCount: 3,
        lastSelectedSequence: 3,
        protected: false
      }
    ],
    { maxBackgroundSessions: 2, maxBackgroundBytes: 64 }
  )

  assert.deepEqual(evictions, ['first', 'second'])
})

test('protected background bytes still force every safe session out of the budget', () => {
  const evictions = selectLfsEvictions(
    [
      {
        id: 'dirty',
        residentBytes: 128,
        selectionCount: 1,
        lastSelectedSequence: 1,
        protected: true
      },
      {
        id: 'clean',
        residentBytes: 64,
        selectionCount: 1,
        lastSelectedSequence: 2,
        protected: false
      }
    ],
    { maxBackgroundSessions: 1, maxBackgroundBytes: 64 }
  )

  assert.deepEqual(evictions, ['clean'])
})

test('resident byte estimates count shared snapshots and equal strings once', () => {
  const bytes = new Uint8Array(32)
  assert.equal(
    estimateDocumentResidentBytes({
      bytes,
      savedBytes: bytes,
      text: 'draft',
      savedText: 'draft'
    }),
    42
  )
})

test('suspended edit tabs unmount while resident edit tabs stay mounted', () => {
  assert.equal(shouldMountDocumentView(false, 'edit', 'resident'), true)
  assert.equal(shouldMountDocumentView(false, 'edit', 'suspended'), false)
  assert.equal(shouldMountDocumentView(true, 'edit', 'restoring'), true)
  assert.equal(shouldMountDocumentView(false, 'preview', 'resident'), false)
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
