import assert from 'node:assert/strict'
import test from 'node:test'

import { viewerPolicy } from './policy.ts'

test('Office-family viewers share one exclusive non-relocatable runtime group', () => {
  for (const viewer of ['office', 'spreadsheet'] as const) {
    assert.deepEqual(viewerPolicy(viewer), {
      defaultViewKind: 'preview',
      exclusiveGroup: 'office',
      canMove: false,
      canSplit: false,
      canCompareInParallel: false
    })
  }
})

test('ordinary viewers retain layout operations', () => {
  assert.deepEqual(viewerPolicy('markdown'), {
    defaultViewKind: 'edit',
    exclusiveGroup: null,
    canMove: true,
    canSplit: true,
    canCompareInParallel: true
  })
})
