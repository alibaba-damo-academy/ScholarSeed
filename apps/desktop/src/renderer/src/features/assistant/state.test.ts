import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssistantContextCandidate,
  AssistantContextSelection,
  AssistantContextRef,
} from '../../contracts/assistant.ts'
import type { ConvItem } from '../../model.ts'
import {
  INITIAL_AI_PANEL_STATE,
  assistantContextSaveError,
  assistantContextProjection,
  loadedAssistantContext,
  beginContextCandidateLoad,
  contextRefMatchesCandidate,
  mergeContextCandidates,
  replaceCurrentDocumentRefs,
  sentAnswerAnnotationIds,
  submittedContextRefIds,
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
  origin,
})

test('a late context read cannot roll a newer selection back after consumption', () => {
  const selection: AssistantContextSelection = {
    session_id: 'session',
    revision: 3,
    project_policy: 'explicit_only',
    search_scope: 'web',
    refs: [],
    capabilities: [],
    updated_at: 0,
  }
  const panel = loadedAssistantContext(INITIAL_AI_PANEL_STATE, selection, [], [])
  assert.equal(panel.revision, 3)
  assert.equal(panel.contextState, 'ready')
  assert.equal(loadedAssistantContext(panel, { ...selection, revision: 2 }, [], []), panel)
  const switched = loadedAssistantContext(
    panel,
    { ...selection, session_id: 'other', revision: 1 },
    [],
    []
  )
  assert.equal(switched.sessionId, 'other')
  assert.equal(switched.revision, 1)
})

test('settled context removes consumed refs while retaining references for a later turn', () => {
  const consumed = ref('consumed', 'old.pdf', 'explicit')
  const fresh = ref('fresh', 'new.pdf', 'explicit')
  const panel = {
    ...INITIAL_AI_PANEL_STATE,
    sessionId: 'session',
    revision: 2,
    refs: [consumed, fresh],
    submittedRefIds: ['consumed'],
  }
  const selection: AssistantContextSelection = {
    session_id: 'session',
    revision: 3,
    project_policy: 'explicit_only',
    search_scope: 'web',
    refs: [fresh],
    capabilities: [],
    updated_at: 0,
  }
  const settled = loadedAssistantContext(panel, selection, [], ['consumed'])
  assert.deepEqual(settled.refs, [fresh])
  assert.deepEqual(settled.submittedRefIds, [])
  const failed = loadedAssistantContext(settled, null, [], [])
  assert.equal(failed.contextState, 'error')
  assert.deepEqual(failed.refs, [fresh])
})

test('submitted refs include claimed running-turn refs without hiding fresh refs', () => {
  const refs = [
    ref('claimed', 'sent.pdf', 'explicit'),
    ref('queued', 'queued.pdf', 'explicit'),
    ref('fresh', 'new.pdf', 'explicit'),
  ]
  assert.deepEqual(submittedContextRefIds(refs, ['claimed'], ['queued']), ['claimed', 'queued'])
  assert.deepEqual(submittedContextRefIds(refs, [], []), [])
})

test('context receipts hide claimed and locally submitted refs while preserving new annotations', () => {
  const claimed = { ...ref('claimed', 'sent-note', 'explicit'), kind: 'note' as const }
  const fresh = { ...ref('fresh', 'fresh-note', 'explicit'), kind: 'note' as const }
  const queued = ref('queued', 'queued.pdf', 'explicit')
  const selection: AssistantContextSelection = {
    session_id: 'session',
    revision: 2,
    project_policy: 'explicit_only',
    search_scope: 'web',
    refs: [claimed, fresh, queued],
    claimed_ref_ids: ['claimed'],
    capabilities: [],
    updated_at: 1,
  }
  const projection = assistantContextProjection(selection, ['queued'])
  assert.deepEqual(projection.submittedRefIds, ['claimed', 'queued'])
  assert.deepEqual(
    projection.refs.filter((item) => !projection.submittedRefIds.includes(item.ref_id)),
    [fresh]
  )
  assert.equal(projection.revision, selection.revision)
  assert.equal(projection.projectPolicy, selection.project_policy)
  assert.equal(projection.searchScope, selection.search_scope)
  assert.deepEqual(projection.capabilities, selection.capabilities)

  const consumed = assistantContextProjection(
    { ...selection, refs: [fresh], claimed_ref_ids: [] },
    projection.submittedRefIds
  )
  assert.deepEqual(consumed.submittedRefIds, [])
  assert.deepEqual(consumed.refs, [fresh])

  const rejected = assistantContextProjection(
    { ...selection, refs: [claimed, fresh], claimed_ref_ids: [] },
    []
  )
  assert.deepEqual(rejected.submittedRefIds, [])
  assert.deepEqual(rejected.refs, [claimed, fresh])
})

test('context save errors retain server diagnostics and only fall back when absent', () => {
  assert.deepEqual(assistantContextSaveError({ error: 'assistant_claimed_refs_immutable' }), {
    key: 'contextErrors.saveFailed',
    detail: 'assistant_claimed_refs_immutable',
  })
  assert.deepEqual(assistantContextSaveError({ error: 'http_422' }), {
    key: 'contextErrors.saveFailed',
    detail: 'http_422',
  })
  assert.deepEqual(assistantContextSaveError(), { key: 'contextErrors.saveRetry' })
})

test('adding a second PDF quote leaves only the unsent quote visible and preserves the sent quote', () => {
  const first = {
    ...ref('first', 'paper.pdf', 'explicit'),
    kind: 'selection' as const,
    anchor: {
      locator: { kind: 'pdf' as const, page: 1, quads: [[0.1, 0.2, 0.4, 0.3]] },
      selected_text_hash: 'first-hash',
      preview_text: 'quote A',
      snapshot_text: 'quote A',
    },
  }
  const second: AssistantContextCandidate = {
    ...first,
    origin: 'explicit',
    anchor: {
      ...first.anchor,
      selected_text_hash: 'second-hash',
      preview_text: 'quote B',
      snapshot_text: 'quote B',
    },
  }
  const merged = mergeContextCandidates([first], [second], ['first'], () => 'second')
  const submitted = submittedContextRefIds(merged.refs, ['first'], ['first'])
  assert.deepEqual(merged.refs[0], first)
  assert.deepEqual(merged.acceptedRefIds, ['second'])
  assert.deepEqual(
    merged.refs
      .filter((item) => !submitted.includes(item.ref_id))
      .map((item) => item.anchor?.snapshot_text),
    ['quote B']
  )
})

test('same file path from different projects remains two explicit references', () => {
  const first = { ...ref('first', 'resources/results.csv', 'explicit'), project_id: 'project-a' }
  const merged = mergeContextCandidates(
    [first],
    [{ ...first, project_id: 'project-b', origin: 'explicit' }],
    [],
    () => 'second'
  )
  assert.equal(merged.refs.length, 2)
  assert.deepEqual(
    merged.refs.map((item) => item.project_id),
    ['project-a', 'project-b']
  )
  const repeated = mergeContextCandidates(
    merged.refs,
    [{ ...first, project_id: 'project-b', origin: 'explicit' }],
    [],
    () => 'third'
  )
  assert.equal(repeated.refs.length, 2)
})

test('sent annotations follow accepted turns, not optimistic messages', () => {
  const note = { ...ref('note-ref', 'annotation-1', 'explicit'), kind: 'note' as const }
  const message: ConvItem = {
    kind: 'user',
    text: '继续',
    refs: [
      {
        type: 'assistant_context',
        id: note.ref_id,
        title: '注释',
        kind: 'note',
        sourceId: note.source_id,
      },
    ],
  }

  assert.deepEqual([...sentAnswerAnnotationIds([message], [note], [])], [])
  assert.deepEqual([...sentAnswerAnnotationIds([message], [note], [note.ref_id])], [note.source_id])
  assert.deepEqual(
    [...sentAnswerAnnotationIds([{ ...message, turnId: 'turn-1' }], [], [])],
    [note.source_id]
  )
  assert.deepEqual([...sentAnswerAnnotationIds([], [note], [])], [])
})

test('sent annotation remains readonly when another annotation is pending', () => {
  const message: ConvItem = {
    kind: 'user',
    text: '继续',
    turnId: 'turn-1',
    refs: [
      {
        type: 'assistant_context',
        id: 'sent-ref',
        title: '注释',
        kind: 'note',
        sourceId: 'sent-note',
      },
    ],
  }
  const pending = { ...ref('pending-ref', 'pending-note', 'explicit'), kind: 'note' as const }

  assert.deepEqual([...sentAnswerAnnotationIds([message], [pending], [])], ['sent-note'])
})

test('current document replacement preserves explicit and submitted refs', () => {
  const refs = [
    ref('automatic', 'first.md', 'current_document'),
    ref('submitted', 'queued.md', 'current_document'),
    ref('explicit', 'pinned.md', 'explicit'),
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
    origin: 'current_document',
  }

  assert.equal(contextRefMatchesCandidate(explicit, candidate), true)
  assert.equal(
    contextRefMatchesCandidate(ref('automatic', 'pinned.md', 'current_document'), candidate),
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
    origin: 'explicit',
  }

  const result = mergeContextCandidates([automatic], [candidate], [], () => 'new')

  assert.equal(contextRefMatchesCandidate(automatic, candidate), true)
  assert.deepEqual(result.acceptedRefIds, ['automatic'])
  assert.deepEqual(result.refs, [
    {
      ...automatic,
      source_revision: null,
      retention: 'session',
      origin: 'explicit',
    },
  ])
  assert.equal(result.changed, true)
})

test('manual file addition collapses existing unsubmitted duplicate refs', () => {
  const automatic = ref('automatic', 'case1.md', 'current_document')
  const explicit = { ...ref('explicit', 'case1.md', 'explicit'), retention: 'session' as const }
  const result = mergeContextCandidates(
    [automatic, explicit],
    [
      {
        kind: 'file',
        source_id: 'case1.md',
        label: 'case1.md',
        retention: 'session',
        origin: 'explicit',
      },
    ],
    [],
    () => 'new'
  )

  assert.deepEqual(
    result.refs.map((item) => item.ref_id),
    ['explicit']
  )
  assert.deepEqual(result.acceptedRefIds, ['explicit'])
})

test('opening another file preserves manually added and submitted refs', () => {
  const explicit = { ...ref('explicit', 'case1.md', 'explicit'), retention: 'session' as const }
  const submitted = ref('submitted', 'queued.md', 'current_document')
  const automatic = ref('automatic', 'old.md', 'current_document')
  const result = mergeContextCandidates(
    [explicit, submitted, automatic],
    [
      {
        kind: 'file',
        source_id: 'case2.md',
        label: 'case2.md',
        origin: 'current_document',
      },
    ],
    ['submitted'],
    () => 'new'
  )

  assert.deepEqual(
    result.refs.map((item) => item.ref_id),
    ['explicit', 'submitted', 'new']
  )
  assert.deepEqual(result.acceptedRefIds, ['new'])
})

test('manual addition does not mutate a submitted automatic ref', () => {
  const submitted = ref('submitted', 'case1.md', 'current_document')
  const result = mergeContextCandidates(
    [submitted],
    [
      {
        kind: 'file',
        source_id: 'case1.md',
        label: 'case1.md',
        retention: 'session',
        origin: 'explicit',
      },
    ],
    ['submitted'],
    () => 'new'
  )

  assert.deepEqual(
    result.refs.map((item) => item.ref_id),
    ['submitted', 'new']
  )
  assert.equal(result.refs[0].origin, 'current_document')
  assert.equal(result.refs[1].origin, 'explicit')
})

test('context candidate reload preserves visible rows for the same source only', () => {
  const candidate: AssistantContextCandidate = {
    kind: 'file',
    source_id: 'paper.md',
    label: 'paper.md',
    origin: 'explicit',
  }
  const current = {
    ...structuredClone(INITIAL_AI_PANEL_STATE),
    contextPickerOpen: true,
    contextPickerSource: 'resource',
    contextCandidates: [candidate],
  }

  assert.deepEqual(beginContextCandidateLoad(current, 'resource'), {
    ...current,
    open: true,
    contextPickerOpen: true,
    contextPickerSource: 'resource',
    contextCandidates: [candidate],
    contextCandidatesLoading: true,
    contextError: null,
  })
  assert.deepEqual(beginContextCandidateLoad(current, 'literature'), {
    ...current,
    open: true,
    contextPickerOpen: true,
    contextPickerSource: 'literature',
    contextCandidates: [],
    contextCandidatesLoading: true,
    contextError: null,
  })
})
