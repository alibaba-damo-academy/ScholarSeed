import assert from 'node:assert/strict'
import { test } from 'node:test'

import { restoreActionKey, systemTrashKey } from './trash.ts'

test('selects the system trash term for each desktop platform', () => {
  assert.equal(systemTrashKey('darwin'), 'systemTrash.darwin')
  assert.equal(systemTrashKey('win32'), 'systemTrash.win32')
  assert.equal(systemTrashKey('linux'), 'systemTrash.fallback')
  assert.equal(systemTrashKey('web'), 'systemTrash.fallback')
  assert.equal(restoreActionKey('darwin'), 'restoreAction.darwin')
  assert.equal(restoreActionKey('win32'), 'restoreAction.win32')
  assert.equal(restoreActionKey('linux'), 'restoreAction.fallback')
})
