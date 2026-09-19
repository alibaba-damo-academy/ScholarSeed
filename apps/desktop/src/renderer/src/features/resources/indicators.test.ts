import assert from 'node:assert/strict'
import test from 'node:test'
import { resourceTreeIndicators, type ResourceNode } from './state.ts'
import type { DocumentSession } from '../workbench/workspace.ts'

function file(overrides: Partial<NonNullable<ResourceNode['version']>> = {}): ResourceNode {
  return { kind: 'file', name: 'notes.md', path: 'resources/notes.md', version: {
    managementState: 'managed', snapshotState: 'saved', needsReview: false,
    drifted: false, pendingOrigin: null, ...overrides
  } }
}
function session(project: string, overrides: Partial<DocumentSession> = {}): DocumentSession {
  return { id: project, source: { kind: 'project', project, path: 'resources/notes.md' }, dirty: true, saveState: 'dirty', ...overrides } as DocumentSession
}
test('tree hides saved and pending version state while retaining review with exact project identity', () => {
  const node = file({ snapshotState: 'pending', needsReview: true })
  const result = resourceTreeIndicators(node, 'first', [session('second'), session('first')])
  assert.equal(result.dirty, true)
  assert.equal('pendingVersion' in result, false)
  assert.equal(result.needsReview, true)
  assert.equal(resourceTreeIndicators(node, 'third', [session('second')]).dirty, false)
  assert.equal(resourceTreeIndicators(node, 'first', [session('first', { dirty: false })]).dirty, false)
})
test('normal/excluded/oversized states stay quiet; warnings aggregate without exposing pending versions', () => {
  assert.deepEqual(resourceTreeIndicators(file(), 'first', []).warnings, [])
  assert.equal('pendingVersion' in resourceTreeIndicators(file(), 'first', []), false)
  for (const managementState of ['ignored', 'oversized', 'unsupported', 'migration_required'] as const) {
    assert.deepEqual(resourceTreeIndicators(file({ managementState, snapshotState: null }), 'first', []).warnings, [])
  }
  const result = resourceTreeIndicators(file({ managementState: 'oversized', snapshotState: 'pending', needsReview: true, drifted: true }), 'first', [session('first', { saveState: 'error' })])
  assert.deepEqual(result.warnings, ['versionBadge.drifted', 'treeStatus.saveError'])
  assert.equal('pendingVersion' in result, false)
  assert.equal(result.needsReview, true)
})
test('saving preserves dirty marker; clean conflicts never fabricate disk edits; directories have no file indicators', () => {
  assert.equal(resourceTreeIndicators(file(), 'first', [session('first', { saveState: 'saving' })]).dirty, true)
  const conflict = resourceTreeIndicators(file(), 'first', [session('first', { dirty: false, saveState: 'conflict' })])
  assert.equal(conflict.dirty, false)
  assert.deepEqual(conflict.warnings, ['treeStatus.saveConflict'])
  assert.equal(resourceTreeIndicators({ ...file(), kind: 'dir' }, 'first', [session('first')]).session, undefined)
})

test('Git files preserve editor dirty/errors and hide book version/review signals', () => {
  const node = file({ managementState: 'git', snapshotState: 'pending', drifted: true, needsReview: true })
  const result = resourceTreeIndicators(node, 'first', [session('first', { dirty: true, saveState: 'error' })])
  assert.equal(result.dirty, true)
  assert.equal('pendingVersion' in result, false)
  assert.equal(result.needsReview, false)
  assert.deepEqual(result.warnings, ['treeStatus.saveError'])
})
