import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchResourceTree } from './api.ts'

test('resource tree refreshes bypass the browser cache', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    let cache: RequestCache | undefined
    globalThis.fetch = async (_url, init) => {
      cache = init?.cache
      return Response.json({
        root: '/project',
        resource_root: '/project/resources',
        nodes: [],
        total: 0,
        offset: 0,
        linked_roots: {},
      })
    }
    assert.deepEqual(await fetchResourceTree('project'), {
      root: '/project',
      resourceRoot: '/project/resources',
      nodes: [],
      total: 0,
      offset: 0,
    })
    assert.equal(cache, 'no-store')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('resource tree pages carry the operation signal through response reading', async (context) => {
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  context.after(() => {
    globalThis.window = originalWindow
  })
  const operation = new AbortController()
  const received: Array<AbortSignal | null | undefined> = []
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    received.push(init.signal)
    const response = Response.json({})
    response.json = async () => {
      if (received.length === 2) operation.abort()
      init.signal?.throwIfAborted()
      return { root: '/project', resource_root: '/project/resources', nodes: [] }
    }
    return response
  })
  assert.ok(await fetchResourceTree('project', undefined, 0, operation.signal))
  assert.equal(await fetchResourceTree('project', 'resources/dir', 100, operation.signal), null)
  assert.deepEqual(received, [operation.signal, operation.signal])
})
