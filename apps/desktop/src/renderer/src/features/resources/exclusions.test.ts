import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { exclusionExplanation, groupedExclusions } from './exclusions.ts'

test('every server default exclusion has a specific explanation', () => {
  const source = readFileSync(new URL('../../../../../../serve/service/chat/constants.py', import.meta.url), 'utf8')
  const defaults = source.match(/DEFAULT_VERSION_IGNORE_PATTERNS: tuple\[str, \.\.\.\] = \(([\s\S]*?)\n\)/)![1]
  const patterns = [...defaults.matchAll(/"([^"]+)"/g)].map(match => match[1])
  assert.ok(patterns.length > 40)
  for (const pattern of patterns) assert.notEqual(exclusionExplanation(pattern).kind, 'custom', pattern)
})
test('unknown patterns and exceptions are not misrepresented as defaults', () => {
  assert.equal(exclusionExplanation('reports/**').kind, 'custom')
  assert.equal(exclusionExplanation('!reports/').kind, 'exception')
  assert.equal(exclusionExplanation('notes/').kind, 'folder')
})

test('logs aggregate by meaning without mutating policy order', () => {
  const patterns = ['*.log', '*.pid', 'log/', '*.log.*', 'logs/', '!reports/']
  const before = [...patterns]
  const groups = groupedExclusions(patterns)
  assert.deepEqual(groups[0].patterns, ['*.log', 'log/', '*.log.*', 'logs/'])
  assert.deepEqual(patterns, before)
  assert.equal(groups[2].explanation.kind, 'exception')
})

test('custom patterns named like categories keep their own explanations', () => {
  const groups = groupedExclusions(['*.log', 'logs', '!logs/'])
  assert.equal(groups.length, 3)
  assert.equal(groups[1].explanation.kind, 'custom')
})
