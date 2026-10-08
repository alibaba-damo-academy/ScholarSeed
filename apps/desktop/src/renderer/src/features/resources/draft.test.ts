import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResourceReviewBatch, ResourceReviewBatchMember } from './api.ts'
import {
  resolveExpectedDiskRevision,
  resolveReviewAction,
  resolveReviewUndoSource,
  ReviewUndoSource,
  ReviewDraftStore,
  shouldRestoreReviewCandidate,
  shouldSaveReviewDraft
} from './draft.ts'

function member(overrides: Partial<ResourceReviewBatchMember> = {}): ResourceReviewBatchMember {
  return {
    file_id: 'file-1',
    review_id: 'review-1',
    path: 'resources/notes.md',
    pending_revision: 1,
    state: 'pending',
    origin: 'agent',
    action: null,
    error: null,
    base: { object_id: 'base', state: 'present', path: 'resources/notes.md', mode_bits: 420, annotation_object_id: null },
    candidate: { object_id: 'candidate', state: 'present', path: 'resources/notes.md', mode_bits: 420, annotation_object_id: null },
    base_revision: 'sha256:base',
    candidate_revision: 'sha256:candidate',
    edited_by_user: false,
    result_version_id: null,
    ...overrides
  }
}

function batch(overrides: Partial<ResourceReviewBatch> = {}): ResourceReviewBatch {
  return {
    id: 'batch-1', session_id: 'session-1', turn_id: 'turn-1', group_id: 'group-1',
    state: 'open', created_at_ms: 1, updated_at_ms: 1, members: [member()], ...overrides
  }
}

test('review draft remains editable until commit and is isolated by project', () => {
  const store = new ReviewDraftStore()
  const current = member()
  store.hydrate('project-a', batch())
  store.choose('project-a', 'batch-1', current, 'accept', 'sha256:candidate')
  assert.equal(store.choice('project-a', 'batch-1', current.file_id)?.action, 'accept')
  store.choose('project-a', 'batch-1', current, 'reject', 'sha256:candidate')
  assert.equal(store.choice('project-a', 'batch-1', current.file_id)?.action, 'reject')
  assert.equal(store.choice('project-b', 'batch-1', current.file_id), null)
})

test('hydrate keeps a decision across pending revision changes but invalidates review identity', () => {
  const store = new ReviewDraftStore()
  const original = batch()
  store.hydrate('project', original)
  store.choose('project', original.id, original.members[0], 'accept', 'sha256:candidate')
  store.hydrate('project', { ...original, updated_at_ms: 2 })
  assert.equal(store.choice('project', original.id, 'file-1')?.action, 'accept')
  store.hydrate('project', { ...original, members: [member({ pending_revision: 2 })] })
  assert.equal(store.choice('project', original.id, 'file-1')?.pendingRevision, 2)
  store.hydrate('project', { ...original, members: [member({ review_id: 'replacement-review' })] })
  assert.equal(store.choice('project', original.id, 'file-1'), null)
})

test('complete decisions requires every open member exactly once', () => {
  const store = new ReviewDraftStore()
  const second = member({ file_id: 'file-2', review_id: 'review-2', path: 'resources/two.md' })
  const current = batch({ members: [member(), second] })
  store.hydrate('project', current)
  store.choose('project', current.id, current.members[0], 'accept', 'sha256:candidate')
  assert.equal(store.decisions('project', current), null)
  store.choose('project', current.id, second, 'reject', 'sha256:two')
  const decisions = store.decisions('project', current)
  assert.equal(decisions?.length, 2)
  assert.equal(decisions?.[1].expected_disk_revision, 'sha256:two')
  store.clearBatch('project', current.id)
  assert.equal(store.decidedCount('project', current.id), 0)
})

test('completed members stay decided when a failed batch is resumed', () => {
  const store = new ReviewDraftStore()
  const accepted = member({ state: 'completed', action: 'accept' })
  const remaining = member({ file_id: 'file-2', review_id: 'review-2' })
  const current = batch({ state: 'failed', members: [accepted, remaining] })
  store.hydrate('project', current)
  assert.equal(store.choice('project', current.id, accepted.file_id)?.action, 'accept')
  store.choose('project', current.id, remaining, 'reject', remaining.candidate_revision)
  assert.equal(store.decisions('project', current)?.length, 2)
})

test('accepting changed disk content keeps the Agent candidate intent', () => {
  const current = member()
  assert.equal(resolveReviewAction('accept', current, current.candidate_revision), 'accept')
  assert.equal(resolveReviewAction('accept', current, 'sha256:external'), 'accept')
  assert.equal(resolveReviewAction('reject', current, 'sha256:external'), 'reject')
  assert.equal(resolveReviewAction('revise', current, 'sha256:external'), 'revise')
})

test('external content is observed without creating a user decision', () => {
  const current = member()
  const store = new ReviewDraftStore()
  const currentBatch = batch({ members: [current] })
  store.hydrate('project', currentBatch)
  assert.equal(store.choice('project', currentBatch.id, current.file_id), null)
  assert.equal(store.decidedCount('project', currentBatch.id), 0)
})

test('undo restores the Agent candidate only for persisted external revisions', () => {
  const current = member()
  assert.equal(shouldRestoreReviewCandidate(null, current), false)
  assert.equal(shouldRestoreReviewCandidate({
    action: 'revise',
    reviewId: current.review_id,
    pendingRevision: current.pending_revision,
    candidateRevision: current.candidate_revision,
    expectedDiskRevision: 'sha256:external'
  }, current), true)
  assert.equal(shouldRestoreReviewCandidate({
    action: 'revise',
    reviewId: current.review_id,
    pendingRevision: current.pending_revision,
    candidateRevision: current.candidate_revision,
    expectedDiskRevision: current.candidate_revision
  }, current), false)
})

test('external revision rollback takes priority over a dirty editor marker', () => {
  const current = member()
  const external = {
    action: 'revise' as const,
    reviewId: current.review_id,
    pendingRevision: current.pending_revision,
    candidateRevision: current.candidate_revision,
    expectedDiskRevision: 'sha256:external'
  }
  const memory = { ...external, expectedDiskRevision: current.candidate_revision }
  assert.equal(resolveReviewUndoSource(external, current, true, 'sha256:external'), ReviewUndoSource.Candidate)
  assert.equal(resolveReviewUndoSource(external, current, false, 'sha256:external'), ReviewUndoSource.Candidate)
  assert.equal(resolveReviewUndoSource(null, current, false, 'sha256:external'), ReviewUndoSource.Candidate)
  assert.equal(resolveReviewUndoSource(memory, current, true, current.candidate_revision), ReviewUndoSource.Memory)
  assert.equal(resolveReviewUndoSource(memory, current, false, current.candidate_revision), null)
})

test('clearing one review choice preserves other file decisions', () => {
  const store = new ReviewDraftStore()
  const first = member()
  const second = member({ file_id: 'file-2', review_id: 'review-2' })
  const currentBatch = batch({ members: [first, second] })
  store.choose('project', currentBatch.id, first, 'accept', first.candidate_revision)
  store.choose('project', currentBatch.id, second, 'reject', second.candidate_revision)
  store.clearChoice('project', currentBatch.id, first.file_id)
  assert.equal(store.choice('project', currentBatch.id, first.file_id), null)
  assert.equal(store.choice('project', currentBatch.id, second.file_id)?.action, 'reject')
})

test('the review snapshot wins over a stale open editor revision', () => {
  const current = member()
  assert.equal(
    resolveExpectedDiskRevision(current, 'sha256:external', 'sha256:stale-editor'),
    'sha256:external'
  )
  assert.equal(
    resolveExpectedDiskRevision(current, undefined, 'sha256:editor'),
    'sha256:editor'
  )
})

test('only in-memory review revisions need saving before commit', () => {
  assert.equal(shouldSaveReviewDraft('revise', true), true)
  assert.equal(shouldSaveReviewDraft('revise', false), false)
  assert.equal(shouldSaveReviewDraft('accept', true), false)
  assert.equal(shouldSaveReviewDraft('reject', true), false)
})
