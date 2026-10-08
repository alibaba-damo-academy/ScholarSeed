import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LARGE_EDITOR_BYTES,
  LARGE_EDITOR_LINES,
  MARKDOWN_VISUAL_MAX_BYTES,
  countEditorLines,
  editorPerformanceFor,
  usesLightweightTextState
} from './limits.ts'

test('large Monaco documents enable large file optimization and disable expensive helpers', () => {
  const largeByBytes = editorPerformanceFor(LARGE_EDITOR_BYTES + 1, 1)
  assert.equal(largeByBytes.largeFileOptimizations, true)
  assert.equal(largeByBytes.folding, false)
  assert.equal(largeByBytes.bracketPairColorization.enabled, false)

  const largeByLines = editorPerformanceFor(4096, LARGE_EDITOR_LINES + 1)
  assert.equal(largeByLines.largeFileOptimizations, true)
  assert.equal(largeByLines.folding, false)
  assert.equal(largeByLines.bracketPairColorization.enabled, false)

  const small = editorPerformanceFor(4096, 2)
  assert.equal(small.largeFileOptimizations, false)
  assert.equal(small.folding, true)
})

test('large file thresholds preserve their exact boundary', () => {
  const boundary = editorPerformanceFor(LARGE_EDITOR_BYTES, LARGE_EDITOR_LINES)
  assert.equal(boundary.largeFileOptimizations, false)
  assert.equal(boundary.folding, true)
})

test('line counting stops after crossing the large editor threshold', () => {
  assert.equal(countEditorLines('first\nsecond'), 2)
  assert.equal(countEditorLines('\n'.repeat(LARGE_EDITOR_LINES)), LARGE_EDITOR_LINES + 1)
})

test('code and oversized Markdown use the lightweight text state path', () => {
  assert.equal(MARKDOWN_VISUAL_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(usesLightweightTextState('code', 4096), true)
  assert.equal(usesLightweightTextState('markdown', MARKDOWN_VISUAL_MAX_BYTES), false)
  assert.equal(usesLightweightTextState('markdown', MARKDOWN_VISUAL_MAX_BYTES + 1), true)
})
