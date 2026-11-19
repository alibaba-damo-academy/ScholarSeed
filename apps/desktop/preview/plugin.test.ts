import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { previewHeaders, previewRequestAllowed, previewEntryHtml, requirePreviewDevelopment } from './plugin.ts'

test('preview entry is explicit and production builds cannot select the mock environment', () => {
  assert.throws(() => requirePreviewDevelopment('build'), /development/)
  assert.doesNotThrow(() => requirePreviewDevelopment('serve'))
  const html = previewEntryHtml('<script type="module" src="/src/main.tsx"></script>')
  assert.ok(html.includes('/@fs/'))
  assert.ok(html.includes('preview/entry.tsx'))
  assert.ok(!html.includes('src="/src/main.tsx"'))
  assert.throws(() => previewEntryHtml('<html></html>'), /entry/)
  const monaco = '<script type="module" src="/src/monaco.ts"></script>'
  assert.equal(previewEntryHtml(monaco, new URL('../src/renderer/monaco.html', import.meta.url).pathname), monaco)
})

test('preview network policy blocks external origins while allowing only the loopback instance', async () => {
  const server = createServer((request, response) => {
    const allowed = previewRequestAllowed(request)
    response.writeHead(allowed ? 200 : 403, previewHeaders(request.headers.host ?? ''))
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const allowed = await fetch(origin, { headers: { origin } })
    assert.equal(allowed.status, 200)
    assert.match(allowed.headers.get('content-security-policy') ?? '', /connect-src 'self' ws:\/\/127\.0\.0\.1:/)
    assert.equal(allowed.headers.get('referrer-policy'), 'same-origin')
    assert.match(allowed.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/)
    assert.equal((await fetch(origin, { headers: { origin: 'https://example.com' } })).status, 403)
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(origin, { headers: { host: 'example.com' } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    assert.equal(foreignHostStatus, 403)
    assert.equal((await fetch(origin, { headers: { referer: 'https://example.com/' } })).status, 403)
  } finally { server.closeAllConnections(); server.close() }
})
