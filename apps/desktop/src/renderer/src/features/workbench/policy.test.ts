import assert from 'node:assert/strict'
import test from 'node:test'

import { viewerPolicy } from './policy.ts'

test('read-only Office viewers open in preview and CSV uses editing', () => {
  assert.equal(viewerPolicy('office').defaultViewKind, 'preview')
  assert.equal(viewerPolicy('spreadsheet', 'results.csv').defaultViewKind, 'edit')
})

test('Markdown retains editing as its default view', () => {
  assert.equal(viewerPolicy('markdown').defaultViewKind, 'edit')
})
