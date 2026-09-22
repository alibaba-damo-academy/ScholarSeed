import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssistantContextCandidate,
  AssistantContextRef
} from '../../contracts/assistant.ts'
import {
  INITIAL_AI_PANEL_STATE,
  beginContextCandidateLoad,
  contextRefMatchesCandidate,
  mergeContextCandidates,
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

test('manual file addition promotes a versioned automatic ref instead of duplicating it', () => {
  const automatic = ref('automatic', 'case1.md', 'current_document')
  const candidate: AssistantContextCandidate = {
    kind: 'file',
    source_id: 'case1.md',
    label: 'case1.md',
    retention: 'session',
    origin: 'explicit'
  }

  const result = mergeContextCandidates([automatic], [candidate], [], () => 'new')

  assert.equal(contextRefMatchesCandidate(automatic, candidate), true)
  assert.deepEqual(result.acceptedRefIds, ['automatic'])
  assert.deepEqual(result.refs, [{
    ...automatic,
    source_revision: null,
    retention: 'session',
    origin: 'explicit'
  }])
  assert.equal(result.changed, true)
})

test('manual file addition collapses existing unsubmitted duplicate refs', () => {
  const automatic = ref('automatic', 'case1.md', 'current_document')
  const explicit = { ...ref('explicit', 'case1.md', 'explicit'), retention: 'session' as const }
  const result = mergeContextCandidates([automatic, explicit], [{
    kind: 'file', source_id: 'case1.md', label: 'case1.md', retention: 'session', origin: 'explicit'
  }], [], () => 'new')

  assert.deepEqual(result.refs.map((item) => item.ref_id), ['explicit'])
  assert.deepEqual(result.acceptedRefIds, ['explicit'])
})

test('opening another file preserves manually added and submitted refs', () => {
  const explicit = { ...ref('explicit', 'case1.md', 'explicit'), retention: 'session' as const }
  const submitted = ref('submitted', 'queued.md', 'current_document')
  const automatic = ref('automatic', 'old.md', 'current_document')
  const result = mergeContextCandidates([explicit, submitted, automatic], [{
    kind: 'file', source_id: 'case2.md', label: 'case2.md', origin: 'current_document'
  }], ['submitted'], () => 'new')

  assert.deepEqual(result.refs.map((item) => item.ref_id), ['explicit', 'submitted', 'new'])
  assert.deepEqual(result.acceptedRefIds, ['new'])
})

test('manual addition does not mutate a submitted automatic ref', () => {
  const submitted = ref('submitted', 'case1.md', 'current_document')
  const result = mergeContextCandidates([submitted], [{
    kind: 'file', source_id: 'case1.md', label: 'case1.md', retention: 'session', origin: 'explicit'
  }], ['submitted'], () => 'new')

  assert.deepEqual(result.refs.map((item) => item.ref_id), ['submitted', 'new'])
  assert.equal(result.refs[0].origin, 'current_document')
  assert.equal(result.refs[1].origin, 'explicit')
})

test('context candidate reload preserves visible rows for the same source only', () => {
  const candidate: AssistantContextCandidate = {
    kind: 'file',
    source_id: 'paper.md',
    label: 'paper.md',
    origin: 'explicit'
  }
  const current = {
    ...structuredClone(INITIAL_AI_PANEL_STATE),
    contextPickerOpen: true,
    contextPickerSource: 'resource',
    contextCandidates: [candidate]
  }

  assert.deepEqual(beginContextCandidateLoad(current, 'resource'), {
    ...current,
    open: true,
    contextPickerOpen: true,
    contextPickerSource: 'resource',
    contextCandidates: [candidate],
    contextCandidatesLoading: true,
    contextError: null
  })
  assert.deepEqual(beginContextCandidateLoad(current, 'literature'), {
    ...current,
    open: true,
    contextPickerOpen: true,
    contextPickerSource: 'literature',
    contextCandidates: [],
    contextCandidatesLoading: true,
    contextError: null
  })
})
