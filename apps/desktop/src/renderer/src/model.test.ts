import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactBelongsToResources, type SessionArtifact } from './model.ts'

test('only artifacts that landed in the resource library invalidate the resource ledger', () => {
  // file_changed fires for every write under a session's private output dir; those
  // artifacts carry no saved_to and belong to the conversation view, not the tree.
  assert.equal(artifactBelongsToResources(undefined), false)
  assert.equal(artifactBelongsToResources(null), false)
  assert.equal(artifactBelongsToResources({} as SessionArtifact), false)
  assert.equal(artifactBelongsToResources({ saved_to: '' }), false)
  assert.equal(artifactBelongsToResources({ saved_to: 'resources/report.md' }), true)
})
