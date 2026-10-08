import assert from 'node:assert/strict'
import test from 'node:test'

import { INITIAL_LITERATURE_STATE, literatureStateForProjectSwitch } from './state.ts'

test('project switch starts with an empty literature projection', () => {
  const next = literatureStateForProjectSwitch()

  assert.deepEqual(next, INITIAL_LITERATURE_STATE)
  assert.notEqual(next, INITIAL_LITERATURE_STATE)
  assert.equal(next.total, 0)
  assert.deepEqual(next.items, [])
  assert.equal(next.loadState, 'idle')
})
