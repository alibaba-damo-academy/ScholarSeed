import assert from 'node:assert/strict'
import test from 'node:test'

import { cellText, columnName, rangeText, needsSourceReference } from './cells.ts'

test('locale-independent evidence delegates ambiguous Excel date and float serialization to the source', () => {
  assert.equal(needsSourceReference(new Date('1899-12-30T01:02:03Z')), true)
  assert.equal(needsSourceReference({ formula: '1/3', result: 1 / 3 }), true)
  assert.equal(needsSourceReference(1e-7), true)
  assert.equal(needsSourceReference(42), false)
  assert.equal(needsSourceReference('42'), false)
})

test('cell evidence preserves formula cache, booleans, rich text and UTF-16 text', () => {
  assert.equal(cellText({ formula: '1+1', result: 2 }), '2')
  assert.equal(cellText({ formula: '1+1' }), '')
  assert.equal(cellText(true), 'True')
  assert.equal(cellText({ richText: [{ text: '证据' }, { text: '😀' }] }), '证据😀')
  assert.equal(cellText(new Date('2026-10-14T01:02:03Z')), '2026-10-14T01:02:03')
  assert.equal(columnName(27), 'AA')
})

test('range evidence trims only trailing empty rows and columns like the source processor', () => {
  assert.equal(rangeText([['', 'A', ''], ['B', 'C', ''], ['', '', '']]), '\tA\nB\tC')
  assert.equal(rangeText([['', '']]), '')
})
