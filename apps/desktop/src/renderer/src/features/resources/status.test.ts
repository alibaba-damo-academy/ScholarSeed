import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResourceReviewBatch, ResourceReviewBatchMember } from './api.ts'
import { reviewOutcome, reviewProgress } from './status.ts'

function member(
  fileId: string,
  overrides: Partial<ResourceReviewBatchMember> = {}
): ResourceReviewBatchMember {
  return {
    file_id: fileId,
    review_id: `review-${fileId}`,
    path: `${fileId}.md`,
    pending_revision: 1,
    state: 'pending',
    origin: 'agent',
    action: null,
    error: null,
    base: { object_id: 'base', state: 'present', path: `${fileId}.md`, mode_bits: 420, annotation_object_id: null },
    candidate: { object_id: 'candidate', state: 'present', path: `${fileId}.md`, mode_bits: 420, annotation_object_id: null },
    base_revision: 'sha256:base',
    candidate_revision: 'sha256:candidate',
    edited_by_user: false,
    result_version_id: null,
    ...overrides
  }
}

function batch(members: ResourceReviewBatchMember[]): ResourceReviewBatch {
  return {
    id: 'batch-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    group_id: 'group-1',
    state: members.some((item) => item.state === 'failed') ? 'failed' : 'completed',
    created_at_ms: 1,
    updated_at_ms: 2,
    members
  }
}

test('review progress keeps reviewed, pending and failed as disjoint counts', () => {
  const current = batch([
    member('a', { state: 'completed', action: 'accept' }),
    member('b', { state: 'pending' }),
    member('c', { state: 'failed', action: 'reject', error: 'disk_conflict' })
  ])
  const decided = new Set(['a', 'b', 'c'])

  assert.deepEqual(reviewProgress(current, (fileId) => decided.has(fileId)), {
    reviewed: 2,
    pending: 0,
    failed: 1
  })
})

test('review outcome reports accepted, revised, rejected and failed members', () => {
  const current = batch([
    member('a', { state: 'completed', action: 'accept' }),
    member('b', { state: 'completed', action: 'accept' }),
    member('c', { state: 'completed', action: 'reject' }),
    member('d', { state: 'completed', action: 'revise' }),
    member('e', { state: 'failed', action: 'accept', error: 'disk_conflict' })
  ])

  assert.deepEqual(reviewOutcome(current), {
    accepted: 2,
    revised: 1,
    rejected: 1,
    failed: 1
  })
})
