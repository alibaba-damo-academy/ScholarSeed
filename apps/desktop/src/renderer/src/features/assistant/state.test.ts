import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssistantContextCandidate,
  AssistantContextRef
} from '../../contracts/assistant.ts'
import {
  contextRefMatchesCandidate,
  replaceCurrentDocumentRefs
} from './state.ts'

const ref = (
  refId: string,
  sourceId: string,
  origin: AssistantContextRef['origin']
): AssistantContextRef => ({
  ref_id: refId,
  kind: 'file',
  source_id: sourceId,
  source_revision: `${sourceId}-revision`,
  label: sourceId,
  retention: 'next_turn',
  origin
})

test('current document replacement preserves explicit and submitted refs', () => {
  const refs = [
    ref('automatic', 'first.md', 'current_document'),
    ref('submitted', 'queued.md', 'current_document'),
    ref('explicit', 'pinned.md', 'explicit')
  ]

  assert.deepEqual(
    replaceCurrentDocumentRefs(refs, ['submitted']).map((item) => item.ref_id),
    ['submitted', 'explicit']
  )
})

test('automatic current document reuses an explicit source across revisions', () => {
  const explicit = ref('explicit', 'pinned.md', 'explicit')
  const candidate: AssistantContextCandidate = {
    kind: 'file',
    source_id: 'pinned.md',
    source_revision: 'new-revision',
    label: 'pinned.md',
    retention: 'next_turn',
    origin: 'current_document'
  }

  assert.equal(contextRefMatchesCandidate(explicit, candidate), true)
  assert.equal(
    contextRefMatchesCandidate(
      ref('automatic', 'pinned.md', 'current_document'),
      candidate
    ),
    false
  )
})
