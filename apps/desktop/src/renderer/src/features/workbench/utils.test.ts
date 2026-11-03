import assert from 'node:assert/strict'
import test from 'node:test'

import { showUnsavedIndicator } from './utils.ts'

for (const autoSave of [true, false]) {
  for (const dirty of [true, false]) {
    test(`unsaved indicator: autoSave=${autoSave}, dirty=${dirty}`, () => {
      assert.equal(showUnsavedIndicator(dirty, autoSave), dirty && !autoSave)
    })
  }
}

test('switching the indicator policy preserves pending edits and save failures', () => {
  for (const saveState of ['dirty', 'saving', 'error', 'conflict']) {
    const session = Object.freeze({ dirty: true, saveState })
    assert.equal(showUnsavedIndicator(session.dirty, true), false)
    assert.equal(showUnsavedIndicator(session.dirty, false), true)
    assert.deepEqual(session, { dirty: true, saveState })
  }
})
