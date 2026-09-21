import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchResourceTree } from './api.ts'

test('resource tree refreshes bypass the browser cache', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    let cache: RequestCache | undefined
    globalThis.fetch = async (_url, init) => {
      cache = init?.cache
      return Response.json({ root: '/project', nodes: [], total: 0, offset: 0, linked_roots: {} })
    }
    assert.deepEqual(await fetchResourceTree('project'), {
      root: '/project', nodes: [], total: 0, offset: 0
    })
    assert.equal(cache, 'no-store')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
