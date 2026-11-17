import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { FAVICON_MAX_BYTES, faviconScript, loadFavicon } from './favicon.ts'

test('isolated-page favicon script has no privileged or module dependencies', async () => {
  const script = faviconScript('https://example.org/icon.png', 'https://example.org/')!
  const icon = await runInNewContext(script, {
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    AbortSignal,
    Uint8Array,
  })
  assert.deepEqual([...icon.bytes], [1, 2, 3])
  assert.equal(icon.mediaType, 'image/png')
  assert.equal(faviconScript('http://127.0.0.1/icon.png', 'https://example.org/'), null)
})

test('favicon loading rejects private and local sources without a request', async () => {
  const forbidden = async () => {
    throw new Error('Unexpected request')
  }
  for (const source of [
    'file:///tmp/icon.png',
    'http://127.0.0.1/icon.png',
    'http://localhost/icon.png',
  ])
    assert.equal(await loadFavicon(source, 'https://example.org/', forbidden), null)
})

test('favicon loading limits bytes and raster formats and forbids redirects', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const result = await loadFavicon(
    'https://example.org/icon.png',
    'https://example.org/page',
    async (_url, init) => {
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      return new Response(bytes, { headers: { 'content-type': 'image/png' } })
    }
  )
  assert.deepEqual(result?.bytes, bytes)
  assert.equal(result?.mediaType, 'image/png')
  assert.equal(
    await loadFavicon(
      'https://example.org/icon.svg',
      'https://example.org/',
      async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
    ),
    null
  )
  assert.equal(
    await loadFavicon(
      'https://example.org/icon.png',
      'https://example.org/',
      async () =>
        new Response(new Uint8Array(FAVICON_MAX_BYTES + 1), {
          headers: { 'content-type': 'image/png' },
        })
    ),
    null
  )
})
