const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const {createRequire} = require('node:module')
const { sha256, executableDigest } = require('../../shared/digest.cjs')
const { inspectBrowser, assertMatchingNodes, assertCompatibleNode, containedFile, prepareDirectory, assertAbsent } = require('../browser.cjs')

test('the reviewed lower-floor Node must satisfy every installed driver engine', () => {
  const node = {version: 'v22.23.4'}
  assert.doesNotThrow(() => assertCompatibleNode(node, [{node_engine: '>=20'}, {node_engine: '>=18'}]))
  assert.throws(() => assertCompatibleNode(node, [{node_engine: '>=24'}]), /engine/)
})

test('browser archive acquisition forwards the explicitly isolated artifact environment', async () => {
  const filename = path.resolve(__dirname, '../browser.cjs'), realRequire = createRequire(filename)
  const module = {exports: {}}, environment = {SCHOLARSEED_ARTIFACT_CACHE: path.join(os.tmpdir(), 'browser-artifacts')}
  let captured
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __dirname: path.dirname(filename),
    require: name => name === '../../../../scripts/shared/artifacts.cjs' ? {
      artifactCache: selected => selected.SCHOLARSEED_ARTIFACT_CACHE,
      ensureArtifact: async (destination, artifact, options) => {captured = {destination, options}; throw new Error('acquisition intercepted')}
    } : realRequire(name)}, {filename})
  await assert.rejects(module.exports.prepareBrowser(path.join(os.tmpdir(), 'browser-resources'), 'arm64', environment), /acquisition intercepted/)
  assert.equal(captured.options.environment, environment)
  assert.ok(captured.destination.startsWith(environment.SCHOLARSEED_ARTIFACT_CACHE + path.sep))
})

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
  const license = path.join(root, 'backend/browser/LICENSE.node')
  fs.writeFileSync(license, 'reviewed Node license')
  const frozen = { path: relative, sha256: await sha256(filename),
    license_sha256: await sha256(license),
    executable_sha256: await executableDigest(filename), consumers: [{source: 'duplicate'}], saved_bytes: 10 }
  assert.equal((await inspectBrowser(root, frozen)).saved_bytes, 10)
  await assert.rejects(inspectBrowser(root, null), /inventory is missing/)
  await assert.rejects(inspectBrowser(root, {...frozen, sha256: 'changed'}), /unsigned browser Node bytes differ/)
  await assert.rejects(inspectBrowser(root, {...frozen, license_sha256: 'changed'}), /license differs/)
  fs.writeFileSync(path.join(root, 'duplicate'), 'duplicate')
  await assert.rejects(inspectBrowser(root, frozen), /duplicate browser Node/)
  fs.unlinkSync(path.join(root, 'duplicate'))
  fs.appendFileSync(filename, 'changed')
  await assert.rejects(inspectBrowser(root, frozen), /differs from frozen/)
})
