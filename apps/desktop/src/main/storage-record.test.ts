import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeStoragePointer, STORAGE_CONFIG_MAX_BYTES } from './storage-record.ts'

test('pointer inspection uses explicit platform path rules without touching the filesystem', () => {
  for (const [platform, root] of [
    ['darwin', '/nonexistent/ScholarSeed'],
    ['win32', 'C:\\nonexistent\\ScholarSeed'],
    ['win32', '\\\\server\\share\\ScholarSeed'],
  ] as const) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: root }))
    const before = Buffer.from(bytes)
    assert.deepEqual(decodeStoragePointer(bytes, platform), { schemaVersion: 1, dataHome: root })
    assert.deepEqual(bytes, before)
  }
  assert.equal(decodeStoragePointer(null, 'win32'), null)
  for (const [platform, root] of [
    ['win32', '/posix/root'],
    ['darwin', 'C:\\windows'],
    ['win32', 'C:relative'],
    ['darwin', 'relative'],
    ['win32', '\\\\?\\C:\\private'],
  ] as const) {
    assert.throws(() =>
      decodeStoragePointer(
        Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: root })),
        platform
      )
    )
  }
})

test('pointer inspection rejects unsupported schema, malformed UTF-8 and oversized bytes', () => {
  for (const value of [
    null,
    [],
    {},
    { schemaVersion: 2, dataHome: '/private' },
    { schemaVersion: true, dataHome: '/private' },
    { schemaVersion: 1, dataHome: '/private\0escape' },
  ])
    assert.throws(() => decodeStoragePointer(Buffer.from(JSON.stringify(value)), 'darwin'))
  assert.throws(() => decodeStoragePointer(Buffer.from([0xff]), 'darwin'))
  assert.throws(() => decodeStoragePointer(Buffer.alloc(STORAGE_CONFIG_MAX_BYTES + 1), 'darwin'))
})
