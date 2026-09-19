import assert from 'node:assert/strict'
import test from 'node:test'

import { unavailablePermissionRecords } from './permissions.ts'

test('planned permissions are represented honestly and are not actionable', () => {
  const records = unavailablePermissionRecords()
  assert.deepEqual(records.map((record) => record.id), [
    'screen',
    'accessibility',
    'microphone',
    'automation',
    'location'
  ])
  assert.ok(records.every((record) => (
    record.status === 'unavailable' && !record.implemented && !record.actionable
    && record.detailCode === 'not-implemented' && record.detail === undefined
  )))
})
