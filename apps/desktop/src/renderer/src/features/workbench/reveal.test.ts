import assert from 'node:assert/strict'
import test from 'node:test'
import { selectionLocator, textSelectionRange } from './reveal.ts'

test('selection locator accepts each supported viewer and rejects malformed coordinates', () => {
  const valid = [
    { kind: 'markdown', start: 0, end: 4, source_map_version: 'md-source-v1' },
    { kind: 'text', start_line: 0, start_column: 0, end_line: 1, end_column: 3 },
    { kind: 'pdf', page: 2, quads: [[0, 0, 0.5, 0.1]] },
    { kind: 'writer', format: 'doc', paragraph: 'paragraph-1', start: 0, end: 3 },
    { kind: 'writer', format: 'docx', paragraph: 'paragraph-2', start: 0, end: 3 },
    { kind: 'writer', paragraph: 'paragraph-2', start: 0, end: 3 },
    { kind: 'calc', sheet: 'Sheet 2', range: 'A1:B3' },
    { kind: 'impress', slide: 2, shape: 'shape-1', start: 0, end: 3 },
  ]
  for (const locator of valid) assert.equal(selectionLocator(locator), locator)
  for (const invalid of [
    null,
    {},
    { kind: 'unknown' },
    { ...valid[0], end: -1 },
    { ...valid[1], start_line: -1 },
    { ...valid[2], quads: [[NaN]] },
    { ...valid[3], format: 'exe' },
  ])
    assert.equal(selectionLocator(invalid), undefined)
})

test('text navigation converts persisted zero-based UTF-16 positions to editor coordinates', () => {
  assert.deepEqual(
    textSelectionRange({
      kind: 'text',
      start_line: 0,
      start_column: 0,
      end_line: 2,
      end_column: 7,
    }),
    { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 8 }
  )
})
