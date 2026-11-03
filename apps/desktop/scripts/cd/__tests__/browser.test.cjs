const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sha256, executableDigest } = require('../../shared/digest.cjs')
const { inspectBrowser, assertMatchingNodes, containedFile, prepareDirectory, assertAbsent } = require('../browser.cjs')

test('Node sharing requires identical bytes and identities satisfying every driver engine', () => {
  const first = { sha256: 'a'.repeat(64), distribution: 'first', node_engine: '>=20',
    identity: { platform: 'darwin', arch: 'arm64', version: 'v24.1.0' } }
  const second = { ...first, distribution: 'second' }
  assert.doesNotThrow(() => assertMatchingNodes([first, second]))
  assert.throws(() => assertMatchingNodes([]), /different Node/)
  assert.throws(() => assertMatchingNodes([first]), /different Node/)
  assert.throws(() => assertMatchingNodes([first, { ...second, sha256: 'b'.repeat(64) }]), /different Node/)
  assert.throws(() => assertMatchingNodes([first, { ...second, identity: { ...first.identity, arch: 'x64' } }]), /different Node/)
  assert.throws(() => assertMatchingNodes([first, { ...second, node_engine: '>=26' }]), /engine/)
})

test('staging deletion candidates must be exact contained regular executables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-inventory-'))
  try {
    const node = path.join(root, 'node')
    fs.writeFileSync(node, 'fixture', { mode: 0o755 })
    assert.equal(containedFile(root, 'node'), node)
    assert.throws(() => containedFile(root, '../node'), /escapes/)
    assert.throws(() => containedFile(root, node), /escapes/)
    assert.throws(() => containedFile(root, 'missing'), /ENOENT/)
    fs.symlinkSync(process.execPath, path.join(root, 'alias'))
    assert.throws(() => containedFile(root, 'alias'), /regular/)
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
    assert.throws(() => assertAbsent(path.join(root, 'dangling')), /duplicate/)
    assert.doesNotThrow(() => assertAbsent(path.join(root, 'missing')))
    fs.mkdirSync(path.join(root, 'outside'))
    fs.mkdirSync(path.join(root, 'resources'))
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'resources/backend'))
    assert.throws(() => prepareDirectory(path.join(root, 'resources'), 'backend/browser'), /ancestor/)
    assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), [])
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

// An executable that would fail if invoked: static validation must only read it.
test('pre-sign browser inventory checks bytes and duplicate removal without launching Node', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-static-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const relative = 'backend/browser/node'
  fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true })
  const filename = path.join(root, relative)
  fs.writeFileSync(filename, 'not an executable image', { mode: 0o755 })
  const frozen = { path: relative, sha256: await sha256(filename),
    executable_sha256: await executableDigest(filename), consumers: [{source: 'duplicate'}], saved_bytes: 10 }
  assert.equal((await inspectBrowser(root, frozen)).saved_bytes, 10)
  await assert.rejects(inspectBrowser(root, null), /inventory is missing/)
  await assert.rejects(inspectBrowser(root, {...frozen, sha256: 'changed'}), /unsigned browser Node bytes differ/)
  fs.writeFileSync(path.join(root, 'duplicate'), 'duplicate')
  await assert.rejects(inspectBrowser(root, frozen), /duplicate browser Node/)
  fs.unlinkSync(path.join(root, 'duplicate'))
  fs.appendFileSync(filename, 'changed')
  await assert.rejects(inspectBrowser(root, frozen), /differs from frozen/)
})
