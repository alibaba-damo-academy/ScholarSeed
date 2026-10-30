import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewFiles } from './files.ts'
import { PreviewVersions } from './versions.ts'
import { loadReviewedRevisions } from './samples.ts'
import { PreviewReviews } from './reviews.ts'

function setup(failOnce = false) {
  const files = new PreviewFiles()
  const versions = new PreviewVersions(files)
  const reviews = new PreviewReviews(versions, { failOnce })
  const baseline = files.read('readme.md')
  const candidate = loadReviewedRevisions()[0].bytes
  const batch = reviews.create({ session_id: 'preview-session', turn_id: 'review-turn', changes: [{ path: 'readme.md', bytes: candidate }] })
  const member = batch.members[0]
  const decision = { file_id: member.file_id, review_id: member.review_id, pending_revision: member.pending_revision, action: 'accept', expected_disk_revision: member.candidate_revision }
  return { files, versions, reviews, baseline, candidate, batch, member, decision }
}

test('review candidates remain immutable pending snapshots rather than public history, with live VFS current', () => {
  const state = setup()
  assert.equal(state.versions.history(state.member.file_id).total, 1)
  assert.equal(state.versions.capability('readme.md').pending?.review?.id, state.member.review_id)
  assert.deepEqual(state.reviews.content(state.batch.id, state.member.file_id, 'base').bytes, state.baseline.bytes)
  assert.deepEqual(state.reviews.content(state.batch.id, state.member.file_id, 'candidate').bytes, state.candidate)
  state.files.write('readme.md', new TextEncoder().encode('external current bytes'))
  assert.equal(new TextDecoder().decode(state.reviews.content(state.batch.id, state.member.file_id, 'current').bytes), 'external current bytes')
  assert.deepEqual(state.reviews.content(state.batch.id, state.member.file_id, 'candidate').bytes, state.candidate)
  state.files.delete('readme.md')
  const missing = state.reviews.content(state.batch.id, state.member.file_id, 'current')
  assert.equal(missing.bytes.length, 0)
  assert.equal(missing.revision, null)
})

test('accept, reject and revise resolve the same file identity with stable replay receipts and no premature versions', () => {
  for (const action of ['accept', 'reject', 'revise']) {
    const state = setup()
    const revised = new TextEncoder().encode('reviewed user revision')
    const body = { decisions: [{ ...state.decision, action, ...(action === 'revise' ? { revised_content: Buffer.from(revised).toString('base64') } : {}) }] }
    const result = state.reviews.commit(state.batch.id, body, 'decision-key')
    assert.equal(result.batch.state, 'completed')
    assert.equal(result.results[0].state, 'completed')
    assert.equal(state.files.read('readme.md').identity, state.member.file_id)
    assert.equal(state.versions.capability('readme.md').pending, null)
    assert.deepEqual(state.files.read('readme.md').bytes, action === 'reject' ? state.baseline.bytes : action === 'revise' ? revised : state.candidate)
    assert.equal(state.versions.history(state.member.file_id).total, action === 'reject' ? 1 : 2)
    assert.equal(result.results[0].version_id === null, action === 'reject')
    state.files.write('readme.md', new TextEncoder().encode('later unrelated write'))
    assert.deepEqual(state.reviews.commit(state.batch.id, body, 'decision-key'), result)
    assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [{ ...state.decision, action: action === 'accept' ? 'reject' : 'accept' }] }, 'decision-key'), { code: 'idempotency_conflict', status: 409 })
  }
})

test('accept explicitly restores the immutable candidate rather than sealing unrelated current bytes', () => {
  const state = setup()
  state.files.write('readme.md', new TextEncoder().encode('external current is not the candidate'))
  const revision = state.files.read('readme.md').revision
  const result = state.reviews.commit(state.batch.id, { decisions: [{ ...state.decision, expected_disk_revision: revision }] }, 'accept-candidate')
  assert.equal(result.batch.state, 'completed')
  assert.deepEqual(state.files.read('readme.md').bytes, state.candidate)
  assert.deepEqual(state.versions.content(result.results[0].version_id!).bytes, state.candidate)
})

test('keep-current reconciliation advances pending identity and revision resolves the retained user draft', () => {
  const state = setup()
  const draft = new TextEncoder().encode('retain this user draft')
  state.files.write('readme.md', draft)
  const conflict = state.reviews.conflict(state.member.file_id)
  state.reviews.reconcile(state.member.file_id, { action: 'keep_current', token: conflict.token }, 'keep-current')
  const member = state.reviews.batch(state.batch.id).members[0]
  assert.equal(member.edited_by_user, true)
  assert.ok(member.pending_revision > state.member.pending_revision)
  const result = state.reviews.commit(state.batch.id, { decisions: [{ ...state.decision, action: 'revise', pending_revision: member.pending_revision, expected_disk_revision: state.files.read('readme.md').revision }] }, 'seal-draft')
  assert.deepEqual(state.versions.content(result.results[0].version_id!).bytes, draft)
})

test('multi-member retry only applies failed members and all returned snapshots are defensive copies', () => {
  const files = new PreviewFiles()
  const versions = new PreviewVersions(files)
  const reviews = new PreviewReviews(versions, { failOnce: true })
  const candidate = loadReviewedRevisions()[0].bytes
  const batch = reviews.create({ session_id: 'session', turn_id: 'turn', changes: [{ path: 'readme.md', bytes: candidate }, { path: 'hello.py', bytes: candidate }] })
  const decisions = batch.members.map(member => ({ file_id: member.file_id, review_id: member.review_id, pending_revision: member.pending_revision, action: 'accept', expected_disk_revision: member.candidate_revision }))
  const first = reviews.commit(batch.id, { decisions }, 'partial')
  assert.equal(first.results.filter(result => result.state === 'completed').length, 1)
  assert.equal(first.results.filter(result => result.state === 'failed').length, 1)
  first.batch.members[0].candidate.object_id = 'mutated outside owner'
  const current = reviews.batch(batch.id)
  assert.notEqual(current.members[0].candidate.object_id, 'mutated outside owner')
  const retried = reviews.commit(batch.id, { decisions }, 'partial')
  assert.equal(retried.batch.state, 'completed')
  for (const member of batch.members) assert.equal(versions.history(member.file_id).total, 2)
})

test('all-member identity and disk fences reject stale or malformed decisions without modifying VFS', () => {
  const state = setup()
  for (const body of [
    { decisions: [] },
    { decisions: [{ ...state.decision, action: 'revise', revised_content: '%%%bad%%%' }] },
    { decisions: [{ ...state.decision, action: 'accept', revised_content: '' }] },
  ]) assert.throws(() => state.reviews.commit(state.batch.id, body, 'invalid'), { code: 'invalid_review_batch_request', status: 422 })
  assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [state.decision, state.decision] }, 'duplicate'), { code: 'review_batch_members_mismatch', status: 409 })
  assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [{ ...state.decision, review_id: 'old-review' }] }, 'old-review'), { code: 'review_batch_member_conflict', status: 409 })
  assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [{ ...state.decision, pending_revision: state.decision.pending_revision + 1 }] }, 'old-pending'), { code: 'review_batch_member_conflict', status: 409 })
  state.files.write('readme.md', new TextEncoder().encode('external conflict'))
  assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [state.decision] }, 'stale-disk'), { code: 'review_disk_revision_conflict', status: 409 })
  assert.equal(new TextDecoder().decode(state.files.read('readme.md').bytes), 'external conflict')
  assert.equal(state.versions.history(state.member.file_id).total, 1)
})

test('reconcile tokens bind pending identity and actual disk, preserving or restoring candidate before decision', () => {
  const state = setup()
  state.files.write('readme.md', new TextEncoder().encode('conflicting version one'))
  const old = state.reviews.conflict(state.member.file_id)
  state.files.write('readme.md', new TextEncoder().encode('conflicting version two'))
  assert.throws(() => state.reviews.reconcile(state.member.file_id, { action: 'restore_candidate', token: old.token }, 'stale-token'), { code: 'preflight_stale', status: 409 })
  const current = state.reviews.conflict(state.member.file_id)
  assert.deepEqual(state.reviews.reconcile(state.member.file_id, { action: 'restore_candidate', token: current.token }, 'restore-key'), { ok: true })
  assert.deepEqual(state.files.read('readme.md').bytes, state.candidate)
  assert.equal(state.versions.history(state.member.file_id).total, 1)
  assert.deepEqual(state.reviews.reconcile(state.member.file_id, { action: 'restore_candidate', token: current.token }, 'restore-key'), { ok: true })
  assert.throws(() => state.reviews.commit(state.batch.id, { decisions: [state.decision] }, 'old-pending'), { code: 'review_batch_member_conflict', status: 409 })
})

test('a declared apply failure exposes failed state and retries without duplicating completed history', () => {
  const state = setup(true)
  const body = { decisions: [state.decision] }
  const failed = state.reviews.commit(state.batch.id, body, 'retryable-key')
  assert.equal(failed.batch.state, 'failed')
  assert.equal(failed.results[0].state, 'failed')
  assert.equal(state.versions.history(state.member.file_id).total, 1)
  const retried = state.reviews.commit(state.batch.id, body, 'retryable-key')
  assert.equal(retried.batch.state, 'completed')
  assert.equal(state.versions.history(state.member.file_id).total, 2)
  assert.equal(state.reviews.list({ state: 'open' }).items.length, 0)
  assert.throws(() => state.reviews.batch('unknown'), { code: 'review_batch_not_found', status: 404 })
})
