import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchResourceVersions, restoreResourceDelivery, restoreResourceVersion, decideResourceReview, type ResourcePending } from '../resources/api.ts'
import { buildHistoryDiff, restoredDeliveryFiles } from './history.ts'
import {
  commitDocument,
  documentIdFor,
  isDocumentLoadFailure,
  loadDocument,
  type DocumentSource
} from './api.ts'

test('review baseline opens immutable bytes with response MIME and read-only capabilities', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  const source: DocumentSource = {
    kind: 'review-base', project: 'project / one', fileId: 'file/one', reviewId: 'review/one',
    path: 'before.docx', revision: 'sha256:baseline'
  }
  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url))
      assert.equal(parsed.pathname, '/api/resource/files/file%2Fone/review/review%2Fone/base')
      assert.equal(parsed.searchParams.get('project'), 'project / one')
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      })
    }
    const loaded = await loadDocument(source)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.viewer, 'office')
    assert.equal(loaded.revision, 'sha256:baseline')
    assert.equal(loaded.capabilities.can_edit, false)
    assert.equal(loaded.capabilities.can_save, false)
    assert.equal(loaded.capabilities.can_version, false)
    assert.notEqual(documentIdFor(source), documentIdFor({ ...source, reviewId: 'new-review' }))
    assert.deepEqual(await commitDocument(source, new Uint8Array(), 'sha256:baseline'),
      { ok: false, error: 'unavailable' })
    globalThis.fetch = async () => new Response(null, { status: 404 })
    const missing = await loadDocument(source)
    assert.equal(isDocumentLoadFailure(missing), true)
    if (!isDocumentLoadFailure(missing)) assert.fail('expected a typed load failure')
    assert.equal(missing.status, 404)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('history diff preserves common lines and marks line replacements', () => {
  assert.deepEqual(buildHistoryDiff('alpha\nbeta\ngamma', 'alpha\ndelta\ngamma'), [
    { kind: 'same', text: 'alpha' },
    { kind: 'removed', text: 'beta' },
    { kind: 'added', text: 'delta' },
    { kind: 'same', text: 'gamma' }
  ])
})

test('deleted file history previews the immutable version using its response MIME', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).pathname, '/api/resource/versions/v2/content')
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      })
    }
    const loaded = await loadDocument({ kind: 'version', project: 'project', versionId: 'v2',
      path: 'deleted.docx', revision: 'sha256:original' })
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded?.viewer, 'office')
    assert.equal(loaded?.capabilities.can_edit, false)
    assert.equal(loaded?.capabilities.can_save, false)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('history diff handles creation and deletion', () => {
  assert.deepEqual(buildHistoryDiff('', 'new'), [{ kind: 'added', text: 'new' }])
  assert.deepEqual(buildHistoryDiff('old', ''), [{ kind: 'removed', text: 'old' }])
})

test('whole-file review preserves snapshot fencing, retry identity and errors', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'retry-key')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        path: 'source.docx', review_id: 'review', pending_revision: 3, expected_disk_revision: 'sha256:candidate'
      })
      return Response.json({ error: { code: 'pending_revision_conflict' } }, { status: 409 })
    }
    const snapshot = { object_id: 'sha256:candidate', path: 'source.docx', state: 'present' as const,
      mode_bits: 384, annotation_object_id: null }
    const pending: ResourcePending = { file_id: 'file', revision: 3, origin: 'agent', review: {
      id: 'review', group_id: 'group', session_id: 'session', first_turn_id: 'turn', turn_id: 'turn',
      terminal_outcome: 'completed', origin: 'agent', base: snapshot, candidate: snapshot,
      base_revision: 'sha256:base', candidate_revision: 'sha256:candidate', edited_by_user: false
    } }
    assert.deepEqual(await decideResourceReview('project', 'source.docx', pending, 'accept',
      'sha256:candidate', 'retry-key'), { ok: false, error: 'pending_revision_conflict' })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('version history preserves the server cursor and sends the selected page', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).searchParams.get('cursor'), '51')
      return Response.json({ versions: [], next_cursor: 1 })
    }
    assert.deepEqual(await fetchResourceVersions('project', 'file', 51), { versions: [], next_cursor: 1 })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('delivery workspace synchronization uses only versions actually restored by the backend', () => {
  const versions = [
    {
      id: 'version-restored', file_id: 'file-a', sequence: 3, object_id: 'sha256:a',
      state: 'present' as const, path: 'renamed/a.md', origin: 'delivery_revert',
      created_at_ms: 1, source_delivery_id: 'delivery-1'
    }
  ]
  assert.deepEqual(restoredDeliveryFiles({
    delivery_id: 'delivery-1',
    preflight_token: 'token',
    members: [
      { file_id: 'file-a', path: 'a.md', target_path: 'renamed/a.md', expected_revision: null, observed_revision: null, conflict: false },
      { file_id: 'file-b', path: 'b.md', target_path: 'b.md', expected_revision: null, observed_revision: 'sha256:b', conflict: true }
    ]
  }, { versions, skipped_file_ids: ['file-b'] }), [{
    fileId: 'file-a', versionId: 'version-restored', previousPath: 'a.md',
    path: 'renamed/a.md', state: 'present'
  }])
})

test('restore mutations preserve authoritative receipts and backend failure codes', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    let requests = 0
    globalThis.fetch = async () => {
      requests += 1
      if (requests === 1) {
        return Response.json({ version: {
          id: 'version-4', file_id: 'file-a', sequence: 4, object_id: 'sha256:a',
          state: 'present', path: 'a.md', origin: 'restore', created_at_ms: 1,
          source_delivery_id: null
        } })
      }
      return Response.json({ error: { code: 'delivery_restore_conflict', message: 'conflict' } }, {
        status: 409
      })
    }
    const single = await restoreResourceVersion('project', 'version-1', 'strict', 'token')
    assert.equal(single.ok && single.result.id, 'version-4')
    assert.deepEqual(await restoreResourceDelivery(
      'project', 'delivery-1', 'strict', 'token'
    ), { ok: false, error: 'delivery_restore_conflict' })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
