import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { previewOfficeFrameUrl } from './frames.ts'
import { previewHeaders, previewOfficeHeaders, previewRequestAllowed, previewEntryHtml, requirePreviewDevelopment, servePreviewOfficeFrame } from './plugin.ts'

test('only the dedicated Office child policy enables reviewed engine dynamic compilation', () => {
  const main = previewHeaders('localhost:4900')
  const child = previewOfficeHeaders('localhost:4900')
  assert.ok(!main['Content-Security-Policy'].includes("'unsafe-eval'"))
  assert.ok(child['Content-Security-Policy'].includes("'unsafe-eval'"))
  assert.equal(child['Content-Security-Policy'].replace(" 'unsafe-eval'", ''), main['Content-Security-Policy'])
  assert.equal(child['Cross-Origin-Embedder-Policy'], 'require-corp')
  assert.equal(child['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(child['Cache-Control'], 'no-store')
})

test('the fixed Office route serves only its reviewed bootstrap and never reflects input HTML', async () => {
  const server = createServer((request, response) => {
    if (!servePreviewOfficeFrame(request, response)) response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const url = previewOfficeFrameUrl(origin, { token: randomUUID(), locale: 'en' })
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.ok(response.headers.get('content-security-policy')?.includes("'unsafe-eval'"))
    const html = await response.text()
    assert.ok(html.includes('preview/office.ts'))
    assert.ok(!html.includes(url.searchParams.get('token')!))
    assert.ok(!html.includes('src/main.tsx'))
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    assert.equal((await fetch(url, { headers: { referer: 'https://example.com/' } })).status, 403)
    url.searchParams.set('html', '<script>external()</script>')
    const invalid = await fetch(url)
    assert.equal(invalid.status, 400)
    assert.ok(!(await invalid.text()).includes('external()'))
    assert.equal((await fetch(origin + '/__preview/office-frame/other')).status, 404)
  } finally { server.closeAllConnections(); server.close() }
})

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
