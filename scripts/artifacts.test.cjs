const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { test } = require('node:test')
const { ensureArtifact } = require('./artifacts.cjs')

test('artifact download is verified, cached and restored without another request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-artifact-'))
  const payload = Buffer.from('reviewed runtime artifact')
  let requests = 0
  const server = http.createServer((request, response) => {
    requests += 1
    response.writeHead(200, { 'content-length': payload.length })
    response.end(payload)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = server.address().port
    const destination = path.join(root, 'checkout', 'runtime.bin')
    const environment = { SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'cache') }
    const artifact = {
      url: `http://127.0.0.1:${port}/runtime.bin`,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      bytes: payload.length,
      mode: 0o755
    }
    await ensureArtifact(destination, artifact, { environment })
    assert.deepEqual(fs.readFileSync(destination), payload)
    assert.equal(fs.statSync(destination).mode & 0o777, 0o755)
    fs.unlinkSync(destination)
    await ensureArtifact(destination, artifact, { environment })
    assert.deepEqual(fs.readFileSync(destination), payload)
    assert.equal(requests, 1)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('artifact download rejects bytes that differ from reviewed metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-artifact-invalid-'))
  const server = http.createServer((request, response) => response.end('modified'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const destination = path.join(root, 'runtime.bin')
    await assert.rejects(ensureArtifact(destination, {
      url: `http://127.0.0.1:${server.address().port}/runtime.bin`,
      sha256: '0'.repeat(64),
      bytes: 8
    }, { environment: { SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'cache') } }),
    /failed verification/)
    assert.equal(fs.existsSync(destination), false)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent artifact requests publish one verified destination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-artifact-concurrent-'))
  const payload = Buffer.alloc(64 * 1024, 7)
  const server = http.createServer((request, response) => response.end(payload))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const destination = path.join(root, 'runtime.bin')
    const environment = { SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'cache') }
    const artifact = {
      url: `http://127.0.0.1:${server.address().port}/runtime.bin`,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      bytes: payload.length
    }
    await Promise.all(Array.from({ length: 4 }, () =>
      ensureArtifact(destination, artifact, { environment })))
    assert.deepEqual(fs.readFileSync(destination), payload)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
