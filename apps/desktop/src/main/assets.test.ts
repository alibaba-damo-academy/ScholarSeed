import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import test from 'node:test'
import { byteRange, serveAssets } from './assets.ts'

test('asset host serves real files, ranges and isolation headers without API fallback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-assets-')))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<main>ready</main>')
  await writeFile(join(root, 'assets', 'worker.wasm'), '0123456789')
  const host = await serveAssets(root)
  try {
    const index = await fetch(host.url)
    assert.equal(await index.text(), '<main>ready</main>')
    assert.equal(index.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
    assert.equal(index.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp')
    assert.equal(index.headers.get('X-Content-Type-Options'), 'nosniff')
    const file = host.url + '/assets/worker.wasm'
    const partial = await fetch(file, { headers: { Range: 'bytes=2-5' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('Content-Type'), 'application/wasm')
    assert.equal(partial.headers.get('Content-Range'), 'bytes 2-5/10')
    assert.equal(await partial.text(), '2345')
    const head = await fetch(file, { method: 'HEAD' })
    assert.equal(head.headers.get('Content-Length'), '10')
    assert.equal(await head.text(), '')
    assert.equal((await fetch(file, { headers: { Range: 'bytes=99-' } })).status, 416)
    assert.equal((await fetch(host.url + '/api/healthz')).status, 404)
    assert.equal((await fetch(host.url + '/missing.js')).status, 404)
    assert.equal((await fetch(host.url, { method: 'POST' })).status, 405)
  } finally {
    await host.close()
    await host.close()
    await rm(root, { recursive: true })
  }
})

test('asset host rejects hostile Host, traversal and symlink resources', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-assets-')))
  await writeFile(join(root, 'index.html'), 'index')
  await mkdir(join(root, 'assets'))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'desktop-outside-')))
  await writeFile(join(outside, 'private.js'), 'private')
  await symlink(join(outside, 'private.js'), join(root, 'assets', 'linked.js'))
  await symlink(outside, join(root, 'assets', 'external'), 'junction')
  const host = await serveAssets(root)
  const status = (path: string, hostname?: string): Promise<number> => new Promise((resolve, reject) => {
    const call = request(host.url + '/', {
      path,
      headers: hostname ? { Host: hostname } : {},
    }, response => {
      response.resume()
      resolve(response.statusCode!)
    })
    call.on('error', reject)
    call.end()
  })
  try {
    assert.equal(await status('/', 'attacker.invalid'), 403)
    for (const path of ['/%2e%2e/index.html', '/assets/../index.html', '/%00', '/C:%5cfile'])
      assert.equal(await status(path), 403, path)
    assert.equal(await status('/assets/linked.js'), 404)
    assert.equal(await status('/assets/external/private.js'), 404)
  } finally {
    await host.close()
    await rm(root, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

test('Office component is bound independently from renderer resources', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-assets-')))
  const renderer = join(root, 'renderer')
  const office = join(root, 'component')
  await mkdir(renderer)
  await mkdir(office)
  await writeFile(join(renderer, 'index.html'), 'index')
  await writeFile(join(office, 'runtime.js'), 'office')
  const host = await serveAssets(renderer)
  try {
    assert.equal((await fetch(host.url + '/office/runtime.js')).status, 404)
    await host.setOfficeRoot(office)
    const response = await fetch(host.url + '/office/runtime.js')
    assert.equal(response.headers.get('Content-Type'), 'text/javascript')
    assert.equal(await response.text(), 'office')
  } finally {
    await host.close()
    await rm(root, { recursive: true })
  }
})

test('single byte ranges cover suffix, open end and invalid inputs', () => {
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(byteRange('bytes=3-', 10), { start: 3, end: 9 })
  assert.deepEqual(byteRange('bytes=0-99', 10), { start: 0, end: 9 })
  for (const value of ['bytes=9-1', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-', 'invalid'])
    assert.throws(() => byteRange(value, 10), value)
})
