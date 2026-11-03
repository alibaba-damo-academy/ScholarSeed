import assert from 'node:assert/strict'
import test from 'node:test'

import { LEAN_ABBREVIATIONS, matchAbbreviation } from './abbreviations.ts'

test('matches a greek abbreviation at the cursor', () => {
  assert.deepEqual(matchAbbreviation('def x := \\alpha'), { start: 9, replacement: 'α', cursorOffset: 1 })
})

test('matches symbol-style keys', () => {
  assert.deepEqual(matchAbbreviation('n \\<='), { start: 2, replacement: '≤', cursorOffset: 1 })
})

test('matches subscripts and superscripts', () => {
  assert.deepEqual(matchAbbreviation('h\\_1'), { start: 1, replacement: '₁', cursorOffset: 1 })
  assert.deepEqual(matchAbbreviation('x\\^2'), { start: 1, replacement: '²', cursorOffset: 1 })
})

test('reports the snippet caret offset for cursor markers', () => {
  assert.deepEqual(matchAbbreviation('\\{}'), { start: 0, replacement: '{}', cursorOffset: 1 })
})

test('only the trailing token is considered', () => {
  assert.deepEqual(matchAbbreviation('\\beta \\alpha'), { start: 6, replacement: 'α', cursorOffset: 1 })
})

test('aliases resolve to the same character', () => {
  assert.equal(LEAN_ABBREVIATIONS['le'], LEAN_ABBREVIATIONS['leq'])
  assert.equal(LEAN_ABBREVIATIONS['to'], LEAN_ABBREVIATIONS['rightarrow'])
  assert.equal(LEAN_ABBREVIATIONS['N'], LEAN_ABBREVIATIONS['nat'])
})

test('returns null outside an abbreviation token', () => {
  for (const input of ['', '\\', 'alpha', '\\nope', 'x \\mapsto ', 'C:\\temp']) {
    assert.equal(matchAbbreviation(input), null, input)
  }
})

test('table is single-line snippet data keyed by bare tokens', () => {
  const entries = Object.entries(LEAN_ABBREVIATIONS)
  assert.ok(entries.length >= 1000)
  for (const [key, value] of entries) {
    assert.ok(key.length > 0)
    assert.ok(value.length > 0, key)
    assert.ok(!value.includes('\n'), key)
    assert.ok(value.split('$CURSOR').length <= 2, key)
  }
})
