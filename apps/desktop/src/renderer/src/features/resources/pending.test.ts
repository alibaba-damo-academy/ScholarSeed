import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResourceCapability, ResourcePending } from './api.ts'
import { fetchVersionedFiles, sealResourceSnapshot, fetchResourceReviewConflict,
  reconcileResourceReview, reviewConflictMatches } from './api.ts'
import { snapshotSaveMessage } from './pending.ts'

const path = 'resources/deleted.docx'
const pending: ResourcePending = { file_id: 'file', revision: 3, origin: 'user', review: null }
const capability: ResourceCapability = {
  file_id: 'file', version_id: 'version',
  working_revision: null, disk_revision: null,
  can_version: false, can_diff: false, can_preview_history: true,
  management_state: 'managed', drifted: false, snapshot_state: 'pending', pending
}

test('snapshot save messages preserve provenance and review/external/saved precedence', () => {
  for (const origin of ['user', 'agent', 'external', 'restore'] as const) {
    assert.equal(snapshotSaveMessage({ ...capability, pending: { ...pending, origin } }, false),
      `snapshotSave.${origin}`)
  }
  const saved = { ...capability, snapshot_state: 'saved' as const, pending: null }
  assert.equal(snapshotSaveMessage(saved, false), 'snapshotSave.saved')
  assert.equal(snapshotSaveMessage(saved, true), 'snapshotSave.adoptExternal')
  assert.equal(snapshotSaveMessage(null, false), 'snapshotSave.save')
  const review = { ...capability, pending: { ...pending, review: { id: 'review' } } } as ResourceCapability
  assert.equal(snapshotSaveMessage(review, true), 'snapshotSave.review')
  assert.equal(snapshotSaveMessage(review, false), 'snapshotSave.review')
})

test('review conflict preview and reconciliation retain exact token and stable retry key', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  const preview = { file_id: 'file', review_id: 'review', pending_revision: 3,
    disk: { object_id: null, state: 'tombstone' as const, path, mode_bits: null, annotation_object_id: null }, token: 'opaque-complete-cas' }
  try {
    let posts = 0
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url))
      assert.equal(parsed.searchParams.get('project'), 'project / one')
      assert.equal(init?.credentials, 'include')
      if (init?.method !== 'POST') {
        assert.equal(parsed.pathname, '/api/resource/files/file/review/conflict')
        assert.equal(init?.cache, 'no-store')
        return Response.json(preview)
      }
      posts += 1
      assert.equal(parsed.pathname, '/api/resource/files/file/review/reconcile')
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'stable-resolution')
      assert.deepEqual(JSON.parse(String(init.body)), { action: 'keep_current', token: preview.token })
      return Response.json({ error: { code: 'review_revision_conflict' } }, { status: 409 })
    }
    assert.deepEqual(await fetchResourceReviewConflict('project / one', 'file'), preview)
    assert.deepEqual(await reconcileResourceReview('project / one', 'file', 'keep_current', preview.token, 'stable-resolution'),
      { ok: false, error: 'review_revision_conflict' })
    assert.equal(posts, 1, 'conflicts must not silently re-preflight or retry')
    const reviewPending = { ...pending, review: { id: 'review' } } as ResourcePending
    assert.equal(reviewConflictMatches(preview, reviewPending), true)
    assert.equal(reviewConflictMatches({ ...preview, file_id: 'other' }, reviewPending), false)
    assert.equal(reviewConflictMatches({ ...preview, review_id: 'other' }, reviewPending), false)
    assert.equal(reviewConflictMatches({ ...preview, pending_revision: 4 }, reviewPending), false)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('deleted history enumeration preserves project, state and file identity cursor', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    const page = { items: [{ file_id: 'deleted-file', path, state: 'tombstone', version_id: 'v3' }], next_cursor: null }
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url))
      assert.equal(parsed.pathname, '/api/resource/files')
      assert.equal(parsed.searchParams.get('project'), 'project / one')
      assert.equal(parsed.searchParams.get('state'), 'tombstone')
      assert.equal(parsed.searchParams.get('after_file_id'), 'prior-file')
      return Response.json(page)
    }
    assert.deepEqual(await fetchVersionedFiles('project / one', 'tombstone', 'prior-file'), page)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('snapshot seal carries exact pending and nullable disk/version fences with a stable retry key', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    let calls = 0
    globalThis.fetch = async (url, init) => {
      calls += 1
      assert.equal(new URL(String(url)).pathname, '/api/resource/files/file/versions')
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'stable-seal-key')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        path, origin: 'user', expected_disk_revision: null,
        expected_version_id: 'version', expected_pending_revision: 3
      })
      return Response.json({ error: { code: 'pending_revision_conflict' } }, { status: 409 })
    }
    const current = { ...capability, can_version: true }
    assert.deepEqual(await sealResourceSnapshot('project', path, current, 'stable-seal-key'),
      { ok: false, error: 'pending_revision_conflict' })
    assert.equal(calls, 1)
    assert.equal((await sealResourceSnapshot('project', path, { ...current, drifted: true }, 'blocked')).ok, false)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('raw external pending snapshots save complete versions without preview capability', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => '' } } as Window & typeof globalThis
  try {
    const raw = { ...capability, file_id: 'raw-file', can_version: true, can_preview_history: false,
      disk_revision: 'raw-revision', pending: { ...pending, file_id: 'raw-file', origin: 'external' as const } }
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), '/api/resource/files/raw-file/versions?project=project')
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'raw-save-key')
      assert.deepEqual(JSON.parse(String(init?.body)), { path: 'custom.raw', origin: 'external_confirmed',
        expected_disk_revision: 'raw-revision', expected_version_id: 'version', expected_pending_revision: 3 })
      return Response.json({})
    }
    assert.deepEqual(await sealResourceSnapshot('project', 'custom.raw', raw, 'raw-save-key', 'external_confirmed'), { ok: true })
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})
