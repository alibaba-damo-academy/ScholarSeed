import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResourceReviewBatch, ResourceReviewBatchMember } from './api.ts'
import { ReviewDraftStore } from './draft.ts'

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

test('hydrate keeps matching choices and invalidates stale review identity', () => {
  const store = new ReviewDraftStore()
  const original = batch()
  store.hydrate('project', original)
  store.choose('project', original.id, original.members[0], 'accept', 'sha256:candidate')
  store.hydrate('project', { ...original, updated_at_ms: 2 })
  assert.equal(store.choice('project', original.id, 'file-1')?.action, 'accept')
  store.hydrate('project', { ...original, members: [member({ pending_revision: 2 })] })
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
