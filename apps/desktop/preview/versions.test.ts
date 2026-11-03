import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PreviewFiles } from './files.ts'
import { PreviewVersions, previewVersionRange } from './versions.ts'
import { loadReviewedRevisions } from './samples.ts'

test('immutable content ranges clamp arbitrary-width integers without losing byte precision', () => {
  assert.deepEqual(previewVersionRange('bytes=0-999999999999999999999', 10), [0, 9])
  assert.deepEqual(previewVersionRange('bytes=-999999999999999999999', 10), [0, 9])
  assert.equal(previewVersionRange('bytes=999999999999999999999-', 10), null)
  assert.equal(previewVersionRange('bytes=0-0', 0), null)
  assert.equal(previewVersionRange('bytes=5-4', 10), null)
})

test('immutable version snapshots share VFS identity and current bytes, never unrelated comparison fixtures', () => {
  const files = new PreviewFiles()
  const original = files.read('readme.md')
  const modified = new Uint8Array(readFileSync(new URL('./fixtures/readme.modified.md', import.meta.url)))
  assert.deepEqual(loadReviewedRevisions(), [{ path: 'readme.md', bytes: modified }])
  const versions = new PreviewVersions(files, [{ path: 'readme.md', bytes: modified }])
  const capability = versions.capability('readme.md')
  const history = versions.history(original.identity)
  assert.equal(history.versions.length, 2)
  assert.equal(capability.file_id, original.identity)
  assert.equal(capability.version_id, history.versions[0].id)
  assert.equal(capability.disk_revision, files.read('readme.md').revision)
  assert.equal(capability.snapshot_state, 'saved')
  assert.deepEqual(versions.content(history.versions[1].id).bytes, original.bytes)
  assert.deepEqual(versions.content(capability.version_id!).bytes, files.read('readme.md').bytes)
  const bytes = versions.content(capability.version_id!).bytes
  bytes.fill(0)
  assert.deepEqual(versions.content(capability.version_id!).bytes, modified)
  files.rename('readme.md', 'renamed.md')
  assert.equal(versions.capability('renamed.md').file_id, original.identity)
  assert.equal(versions.history(original.identity).versions[1].path, 'readme.md')
})

test('owned write capacity is checked before changing the single VFS source', () => {
  const files = new PreviewFiles()
  const versions = new PreviewVersions(files)
  const original = files.read('readme.md')
  assert.throws(() => versions.write('readme.md', new Uint8Array(1024 * 1024 + 1).fill(65)), { code: 'file_too_large', status: 413 })
  assert.deepEqual(files.read('readme.md'), original)
  versions.write('readme.md', new TextEncoder().encode('new owned write'))
  assert.equal(versions.capability('readme.md').snapshot_state, 'pending')
})

test('snapshot fences and idempotent receipts remain valid without replaying later writes', () => {
  const files = new PreviewFiles()
  const versions = new PreviewVersions(files)
  const initial = versions.capability('readme.md')
  files.write('readme.md', new TextEncoder().encode('Saved through the owned VFS'))
  versions.observe('readme.md')
  const pending = versions.capability('readme.md')
  assert.equal(pending.snapshot_state, 'pending')
  assert.equal(pending.drifted, false)
  assert.equal(pending.version_id, initial.version_id)
  const fence = { path: 'readme.md', origin: 'user', expected_disk_revision: pending.disk_revision, expected_version_id: pending.version_id, expected_pending_revision: pending.pending!.revision }
  assert.throws(() => versions.seal(initial.file_id!, { ...fence, expected_disk_revision: 'stale' }, 'stale'), { code: 'revision_conflict', status: 412 })
  assert.throws(() => versions.seal(initial.file_id!, { ...fence, expected_version_id: 'stale' }, 'head'), { code: 'version_head_conflict', status: 412 })
  const result = versions.seal(initial.file_id!, fence, 'stable-key')
  assert.equal(versions.capability('readme.md').snapshot_state, 'saved')
  files.write('readme.md', new TextEncoder().encode('Later content'))
  versions.observe('readme.md')
  assert.deepEqual(versions.seal(initial.file_id!, fence, 'stable-key'), result)
  assert.throws(() => versions.seal(initial.file_id!, { ...fence, origin: 'external_confirmed' }, 'stable-key'), { code: 'idempotency_conflict', status: 409 })
  assert.equal(versions.history(initial.file_id!).versions.length, 2)
})

test('history filtering, cursor ordering and unknown version identities follow the real DTO', () => {
  const files = new PreviewFiles()
  const versions = new PreviewVersions(files, [{ path: 'readme.md', bytes: new TextEncoder().encode('changed') }])
  const capability = versions.capability('readme.md')
  const first = versions.history(capability.file_id!, { limit: 1 })
  assert.equal(first.total, 2)
  assert.equal(first.next_cursor, 2)
  assert.equal(versions.history(capability.file_id!, { cursor: first.next_cursor! }).versions[0].sequence, 1)
  assert.equal(versions.history(capability.file_id!, { origin: 'initial_scan' }).total, 1)
  assert.equal(versions.history(capability.file_id!, { q: 'v1' }).total, 1)
  assert.equal(versions.history(capability.file_id!, { order: 'oldest' }).versions[0].sequence, 1)
  assert.equal(versions.history('not-a-file').total, 0)
  assert.throws(() => versions.content('not-a-version'), { code: 'version_not_found', status: 404 })
  assert.throws(() => versions.history(capability.file_id!, { order: 'random' }), { code: 'invalid_version_order', status: 422 })
  assert.equal(versions.capability('sample.bin').can_version, false)
  assert.equal(versions.capability('sample.png').file_id, null)
})
