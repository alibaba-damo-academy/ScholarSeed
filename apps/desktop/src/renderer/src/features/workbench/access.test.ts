import assert from 'node:assert/strict'
import test from 'node:test'
import { historyAccess } from './history.ts'

test('raw file history remains listable and restorable without content preview', () => {
  assert.deepEqual(historyAccess({ file_id: 'raw-file', can_preview_history: false }), { available: true, canPreview: false })
  assert.deepEqual(historyAccess({ file_id: 'known-file', can_preview_history: true }), { available: true, canPreview: true })
  assert.deepEqual(historyAccess({ file_id: null, can_preview_history: false }), { available: false, canPreview: false })
})
