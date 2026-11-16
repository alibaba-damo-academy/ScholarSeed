import assert from 'node:assert/strict'
import test from 'node:test'
import { answerIdentifier } from './bindings.ts'

test('native answer identity preserves message IDs and falls back to event sequences', () => {
  assert.equal(answerIdentifier('item:answer', 7), 'item:answer')
  assert.equal(answerIdentifier(undefined, 7), 'answer:7')
  assert.equal(answerIdentifier(null, 0), 'answer:0')
  assert.equal(answerIdentifier(), null)
})
