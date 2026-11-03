import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactBelongsToResources, artifactIsDeliverable, type SessionArtifact } from './model.ts'

test('delivery lists admit explicit publications without guessing from file roles or suffixes', () => {
  const base: SessionArtifact = {
    artifact_id: 'publication',
    publication_id: 'publication',
    path: 'result.json',
    name: 'result.json',
    role: 'final',
    status: 'available',
  }
  for (const role of ['final', 'intermediate', 'supporting'] as const) {
    assert.equal(artifactIsDeliverable({ ...base, role }), true)
    assert.equal(artifactIsDeliverable({ ...base, role, publication_id: undefined }), false)
  }
  assert.equal(artifactIsDeliverable({ ...base, role: undefined }), false)
  assert.equal(artifactIsDeliverable({ ...base, status: 'deleted' }), false)
  assert.equal(artifactIsDeliverable({ ...base, change: 'delete' }), false)
  assert.equal(artifactIsDeliverable({ ...base, path: 'code.py', name: 'code.py' }), true)
  assert.equal(artifactIsDeliverable({ ...base, path: 'DATA', name: 'DATA', size: 0 }), true)
  assert.equal(
    artifactIsDeliverable({ ...base, name: 'input.csv', publication_id: undefined }),
    false
  )
})

test('only artifacts that landed in the resource library invalidate the resource ledger', () => {
  // file_changed fires for every write under a session's private output dir; those
  // artifacts carry no saved_to and belong to the conversation view, not the tree.
  assert.equal(artifactBelongsToResources(undefined), false)
  assert.equal(artifactBelongsToResources(null), false)
  assert.equal(artifactBelongsToResources({} as SessionArtifact), false)
  assert.equal(artifactBelongsToResources({ saved_to: '' }), false)
  assert.equal(artifactBelongsToResources({ saved_to: 'resources/report.md' }), true)
})
