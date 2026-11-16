import assert from 'node:assert/strict'
import test from 'node:test'

import {
  unavailablePermissionRecords,
  systemPermissionSettingsUrl,
  type SystemPermissionTarget,
} from './permissions.ts'

test('planned permissions are represented honestly and are not actionable', () => {
  const records = unavailablePermissionRecords()
  assert.deepEqual(
    records.map((record) => record.id),
    ['screen', 'accessibility', 'microphone', 'automation', 'location']
  )
  assert.ok(
    records.every(
      (record) =>
        record.status === 'unavailable' &&
        !record.implemented &&
        !record.actionable &&
        record.detailCode === 'not-implemented' &&
        record.detail === undefined
    )
  )
})

test('file permission navigation is fixed per OS and cannot grant broader permissions', () => {
  assert.equal(
    systemPermissionSettingsUrl('darwin', 'files-folders'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
  )
  assert.equal(
    systemPermissionSettingsUrl('win32', 'files-folders'),
    'ms-settings:privacy-broadfilesystemaccess'
  )
  assert.equal(systemPermissionSettingsUrl('linux', 'files-folders'), null)
  assert.equal(systemPermissionSettingsUrl('darwin', 'full-disk'), null)
  for (const target of ['https://example.com', '__proto__', 'constructor']) {
    assert.equal(systemPermissionSettingsUrl('darwin', target as SystemPermissionTarget), null)
  }
  assert.equal(systemPermissionSettingsUrl('__proto__', 'notifications'), null)
})
