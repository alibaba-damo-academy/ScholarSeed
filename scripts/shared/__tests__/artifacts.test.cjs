const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { test } = require('node:test')
const { ensureArtifact } = require('../artifacts.cjs')

test('cancelled preparation stops streaming, does not retry and removes unpublished bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-artifact-abort-'))
  const controller = new AbortController()
  let requests = 0
  const server = http.createServer((request, response) => {
    requests += 1
    response.writeHead(200)
    response.write('partial')
    controller.abort()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const cache = path.join(root, 'cache')
    const destination = path.join(root, 'runtime.bin')
    await assert.rejects(ensureArtifact(destination, {
      url: `http://127.0.0.1:${server.address().port}/runtime.bin`,
      sha256: '0'.repeat(64), bytes: 100
    }, { environment: { SCHOLARSEED_ARTIFACT_CACHE: cache }, signal: controller.signal }),
    { name: 'AbortError' })
    assert.equal(requests, 1)
    assert.equal(fs.existsSync(destination), false)
    assert.deepEqual(fs.readdirSync(cache), [])
  } finally {
    server.closeAllConnections()
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

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

test('failed mirrors and a transient upstream response fall back to verified bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-mirror-'))
  const payload = Buffer.from('pinned bytes')
  const requests = []
  let upstream = 0
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url === '/mirror' || ++upstream === 1) {
      res.writeHead(503)
      res.end()
      return
    }
    res.end(payload)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const dest = path.join(root, 'artifact')
    await ensureArtifact(
      dest,
      {
        url: `${base}/upstream`,
        mirrors: [`${base}/mirror`],
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
        bytes: payload.length,
      },
      { environment: { SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'cache') } },
    )
    assert.deepEqual(requests, [
      '/mirror',
      '/mirror',
      '/upstream',
      '/upstream',
    ])
    assert.deepEqual(fs.readFileSync(dest), payload)
  } finally {
    server.closeAllConnections()
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('timeouts and corrupt mirror bytes do not publish or expose URL secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-timeout-'))
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bad')) res.end('tampered')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const dest = path.join(root, 'artifact')
    await assert.rejects(
      ensureArtifact(
        dest,
        {
          url: `${base}/hang?secret=do-not-log`,
          mirrors: [`${base}/bad?secret=do-not-log`],
          sha256: '0'.repeat(64),
          bytes: 8,
        },
        {
          timeoutMs: 30,
          attempts: 1,
          environment: { SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'cache') },
        },
      ),
      (error) => {
        assert.match(error.message, /failed verification/)
        assert.match(error.message, /TimeoutError/)
        assert.doesNotMatch(error.message, /do-not-log|secret=/)
        return true
      },
    )
    assert.equal(fs.existsSync(dest), false)
    assert.deepEqual(fs.readdirSync(path.join(root, 'cache')), [])
  } finally {
    server.closeAllConnections()
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
