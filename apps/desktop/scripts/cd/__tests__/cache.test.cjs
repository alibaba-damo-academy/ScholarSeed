const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const cache = require('../cache.cjs')
const wheels = require('../wheels.cjs')
const state = require('../../shared/build-state.cjs')
const { protectWindowsVerificationDirectory } = require('../verification-directory.cjs')
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-cache-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  return root
}
test('immutable tool/wheel cache verifies every byte on reuse and keys all inputs', t => {
  const root = fixture(t); let builds = 0
  const populate = directory => { builds++; fs.writeFileSync(path.join(directory, 'artifact'), 'valid') }
  const first = cache.materialize(root, 'tools', {sdk: 'a', target: 'windows'}, populate)
  assert.equal(cache.materialize(root, 'tools', {sdk: 'a', target: 'windows'}, populate), first)
  assert.equal(builds, 1)
  cache.materialize(root, 'tools', {sdk: 'b', target: 'windows'}, populate)
  assert.equal(builds, 2)
  fs.writeFileSync(path.join(first, 'artifact'), 'wrong')
  assert.throws(() => cache.materialize(root, 'tools', {sdk: 'a', target: 'windows'}, populate), /inventory mismatch/)
  assert.equal(builds, 2)
})
test('failed population cannot become a hit and incomplete receipts fail closed', t => {
  const root = fixture(t), input = {version: 1}
  assert.throws(() => cache.materialize(root, 'tools', input, directory => {
    fs.writeFileSync(path.join(directory, 'partial'), 'bytes'); throw new Error('interrupted')
  }), /interrupted/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), [])
  fs.mkdirSync(path.join(root, 'tools', cache.key(input)), {mode: 0o700})
  assert.throws(() => cache.materialize(root, 'tools', input, () => assert.fail()), /incomplete/)
})
test('tool cache rejects archive changes before extracting or using cached tools', t => {
  const root = fixture(t), archive = path.join(root, 'sdk.zip')
  fs.writeFileSync(archive, 'official')
  const expected = {sha256: state.hashFile(archive), bytes: 8}
  fs.writeFileSync(archive, 'modified')
  assert.throws(() => cache.expanded(archive, expected, {SCHOLARSEED_ARTIFACT_CACHE: path.join(root, 'artifacts')}, () => assert.fail()), /differs from policy/)
})
test('wheel source binds package data and ignores only disposable build residue', t => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, 'pyproject.toml'), 'metadata')
  fs.writeFileSync(path.join(root, 'module.py'), 'source')
  const first = wheels.source(root)
  fs.mkdirSync(path.join(root, 'build')); fs.writeFileSync(path.join(root, 'build', 'old'), 'discarded')
  fs.mkdirSync(path.join(root, 'pkg.egg-info')); fs.writeFileSync(path.join(root, 'pkg.egg-info', 'old'), 'discarded')
  assert.equal(wheels.source(root), first)
  fs.mkdirSync(path.join(root, 'package')); fs.writeFileSync(path.join(root, 'package', 'data.json'), '{}')
  assert.notEqual(wheels.source(root), first)
  const second = wheels.source(root)
  fs.writeFileSync(path.join(root, 'package', 'data.json'), '{"changed":true}')
  assert.notEqual(wheels.source(root), second)
})
test('build cache refuses symlink or hardlink substitution', t => {
  const root = fixture(t)
  const data = cache.materialize(root, 'tools', {}, directory => fs.writeFileSync(path.join(directory, 'tool'), 'original'))
  fs.linkSync(path.join(data, 'tool'), path.join(root, 'alias'))
  assert.throws(() => cache.materialize(root, 'tools', {}, () => assert.fail()), /invalid build state/)
})
test('concurrent publishers converge without overwriting a completed entry', async t => {
  const root = fixture(t)
  state.ensurePrivateDirectory(path.join(root, 'tools'))
  const {spawn} = require('node:child_process')
  const program = 'const fs=require("node:fs"),path=require("node:path"),c=require(process.argv[1]);c.materialize(process.argv[2],"tools",{sdk:1},d=>fs.writeFileSync(path.join(d,"binary"),"same bytes"))'
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, require.resolve('../cache.cjs'), root], {stdio: 'ignore'})
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`publisher failed ${code}`)))
  })
  await Promise.all([run(), run()])
  assert.equal(fs.readdirSync(path.join(root, 'tools')).length, 1)
  const data = cache.materialize(root, 'tools', {sdk: 1}, () => assert.fail())
  assert.equal(fs.readFileSync(path.join(data, 'binary'), 'utf8'), 'same bytes')
})
test('Windows private state checks work under the host policy and reject foreign writers', {
  skip: process.platform !== 'win32' ? 'Requires Windows ACL commands' : false,
}, async testContext => {
  const parent = path.resolve(sourceDirectory, '../../../../tmp')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'acl-'))
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }))
  protectWindowsVerificationDirectory(root)
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
  const grant = (filename, rights) => execFileSync(icacls, [filename, '/grant:r', `*S-1-1-0:${rights}`])
  await testContext.test('private directories and files with literal Unicode paths pass', () => {
    const directory = path.join(root, "书深'[state]")
    state.ensurePrivateDirectory(directory)
    const filename = path.join(directory, 'receipt.json')
    fs.writeFileSync(filename, '{}')
    state.assertPrivateFile(filename)
  })
  await testContext.test('missing SystemRoot is rejected without PATH fallback', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'system-root-fallback'))
    assert.throws(() => execFileSync(process.execPath, [
      '-e', 'delete process.env.SystemRoot; require(process.argv[1]).assertPrivateDirectory(process.argv[2])',
      require.resolve('../../shared/build-state.cjs'), directory,
    ], { stdio: 'pipe', windowsHide: true }), /canonical OS-provided SystemRoot/)
  })
  await testContext.test('foreign read access does not confer write authority', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'readable'))
    grant(directory, '(R)')
    state.assertPrivateDirectory(directory)
  })
  for (const rights of ['(W)', '(D)', '(WDAC)', '(WO)']) {
    await testContext.test(`foreign leaf ${rights} is rejected`, () => {
      const directory = state.ensurePrivateDirectory(path.join(root, rights.slice(1, -1)))
      grant(directory, rights)
      assert.throws(() => state.assertPrivateDirectory(directory), /writable or replaceable private state ACL/)
    })
  }
  await testContext.test('foreign file writers are rejected', () => {
    const filename = path.join(root, 'receipt.json')
    fs.writeFileSync(filename, '{}')
    grant(filename, '(W)')
    assert.throws(() => state.assertPrivateFile(filename), /writable or replaceable private state ACL/)
  })
  await testContext.test('private leaves do not mask a replaceable ancestor', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'ancestor'))
    const leaf = state.ensurePrivateDirectory(path.join(directory, 'leaf'))
    grant(directory, '(DC)')
    assert.throws(() => state.assertPrivateDirectory(leaf), /writable or replaceable private state ACL/)
  })
  await testContext.test('inherited foreign writers are rejected', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'inherited'))
    grant(directory, '(OI)(CI)(W)')
    const leaf = path.join(directory, 'leaf')
    fs.mkdirSync(leaf)
    assert.throws(() => state.assertPrivateDirectory(leaf), /writable or replaceable private state ACL/)
  })
  await testContext.test('ancestor create rights alone do not replace private children', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'create-only'))
    const leaf = state.ensurePrivateDirectory(path.join(directory, 'leaf'))
    grant(directory, '(W)')
    state.assertPrivateDirectory(leaf)
  })
  await testContext.test('ancestor generic write alone does not replace private children', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'generic-write'))
    const leaf = state.ensurePrivateDirectory(path.join(directory, 'leaf'))
    grant(directory, '(GW)')
    state.assertPrivateDirectory(leaf)
  })
  await testContext.test('ancestor generic all can replace private children and is rejected', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'generic-all'))
    const leaf = state.ensurePrivateDirectory(path.join(directory, 'leaf'))
    grant(directory, '(GA)')
    assert.throws(() => state.assertPrivateDirectory(leaf), /writable or replaceable private state ACL/)
  })
  await testContext.test('inherit-only grants do not apply to the checked leaf', () => {
    const directory = state.ensurePrivateDirectory(path.join(root, 'inherit-only'))
    grant(directory, '(OI)(CI)(IO)(W)')
    state.assertPrivateDirectory(directory)
  })
})
