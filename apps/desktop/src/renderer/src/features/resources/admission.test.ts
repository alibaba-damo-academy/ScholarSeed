import assert from 'node:assert/strict'
import test from 'node:test'
import { admitResourceVersion } from './api.ts'
import { previewFileVersionSettings } from './settings.ts'

test('manual admission sends the observed disk revision and idempotency key, preserving server failures', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => '' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), '/api/serve/resources/version-admission?project=p+1')
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'request-1')
      assert.deepEqual(JSON.parse(String(init?.body)), { path: 'data/custom.raw', expected_disk_revision: 'observed-revision' })
      return Response.json({ error: { code: 'disk_revision_conflict' } }, { status: 409 })
    }
    assert.deepEqual(await admitResourceVersion('p 1', 'data/custom.raw', 'observed-revision', 'request-1'), { ok: false, error: 'disk_revision_conflict' })
  } finally { globalThis.fetch = original; globalThis.window = originalWindow }
})

test('policy preview carries the selected mode, file-size limit and both rule lists', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => '' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { mode: 'blacklist', max_versions_per_file: 100, max_file_size_kb: 1024, include_patterns: '*.md', ignore_patterns: '*.tmp' })
      return Response.json({ mode: 'blacklist', added_files: 2, removed_files: 1, added_paths: [{ project_id: 'p', path: 'custom.raw' }], removed_paths: [{ project_id: 'p', path: 'a.tmp' }], token: 'scope-token' })
    }
    const result = await previewFileVersionSettings(100, 1024, '*.md', '*.tmp', 'blacklist')
    assert.equal(result.ok, true)
    if (result.ok) { assert.equal(result.result.added_files, 2); assert.equal(result.result.token, 'scope-token') }
  } finally { globalThis.fetch = original; globalThis.window = originalWindow }
})
