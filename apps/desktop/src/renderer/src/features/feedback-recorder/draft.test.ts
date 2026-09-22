import assert from 'node:assert/strict'
import test from 'node:test'

import { commitActiveTextDraft, type TextDraft } from './draft.ts'

const draft: TextDraft = {
  id: 1,
  alignRight: false,
  color: '#c00',
  point: { x: 10, y: 20 },
  surfaceX: 10,
  surfaceY: 20,
  value: '这里有问题'
}

test('canvas pointer commits an active text draft without starting another one', () => {
  let committed: TextDraft | undefined
  assert.equal(commitActiveTextDraft(draft, (value) => { committed = value }), true)
  assert.equal(committed, draft)
})

test('canvas pointer may start text input when no draft is active', () => {
  assert.equal(commitActiveTextDraft(null, () => assert.fail('nothing should be committed')), false)
})
