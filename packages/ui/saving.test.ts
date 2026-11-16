import assert from 'node:assert/strict'
import test from 'node:test'
import { saveBibtex } from './saving.ts'

test('SDK bibliography saving fails explicitly without consulting an ambient Desktop bridge', async () => {
  assert.deepEqual(await saveBibtex(), { kind: 'failed', error: 'ui_export_not_authorized' })
})
