const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { assertMatchingNodes, containedFile, prepareDirectory, assertAbsent } = require('./browser.cjs')

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
