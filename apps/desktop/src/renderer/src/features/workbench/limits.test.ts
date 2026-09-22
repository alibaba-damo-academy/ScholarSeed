import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MARKDOWN_VISUAL_MAX_BYTES,
  editorPerformanceFor,
  usesLightweightTextState
} from './limits.ts'

test('large Monaco documents retain tokenization while expensive helpers are disabled', () => {
  const oneMiB = 1024 * 1024
  const sixtyFourMiB = 64 * oneMiB
  const large = editorPerformanceFor(sixtyFourMiB)
  assert.equal(large.largeFileOptimizations, false)
  assert.ok(large.maxTokenizationLineLength > sixtyFourMiB)
  assert.equal(large.folding, false)
  assert.equal(large.bracketPairColorization.enabled, false)

  const small = editorPerformanceFor(4096)
  assert.equal(small.largeFileOptimizations, false)
  assert.equal(small.folding, true)
})

test('code and oversized Markdown use the lightweight text state path', () => {
  assert.equal(usesLightweightTextState('code', 4096), true)
  assert.equal(usesLightweightTextState('markdown', MARKDOWN_VISUAL_MAX_BYTES), false)
  assert.equal(usesLightweightTextState('markdown', MARKDOWN_VISUAL_MAX_BYTES + 1), true)
})
