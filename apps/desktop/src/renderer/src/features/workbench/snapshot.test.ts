import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./SnapshotReview.tsx', import.meta.url), 'utf8')
test('file-only history reuses snapshot save and review operations without an editor session', () => {
  assert.match(source, /file\?: ResourceHistoryTarget/)
  assert.match(source, /sealResourceSnapshot/)
  assert.match(source, /snapshotSaveMessage/)
  assert.match(source, /if \(session\)/)
  assert.match(source, /decideResourceReview\(project, path/)
})
