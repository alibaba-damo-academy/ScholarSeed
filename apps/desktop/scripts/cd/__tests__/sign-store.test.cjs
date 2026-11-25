const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {registryCommand} = require('./signing.fixture.cjs')
const {hashFile} = require('../../shared/build-state.cjs')
const { signedRuntimeStore } = require('../mac-sign-store.cjs')
const {macComponentVersions} = require('../mac-component-versions.cjs')

const key = 'ab'.repeat(32)
const posix = {skip: process.platform === 'win32' && 'macOS cache uses POSIX directory rename semantics'}
const neverRestore = () => assert.fail('unexpected archive restoration')
const read = file => fs.readFileSync(file, 'utf8')

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac sign cache-')))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  const registry = path.join(dir, 'registry')
  fs.mkdirSync(registry, {mode: 0o700})
  const command = registryCommand(registry)
  function runner(name, shared = true, kind = 'python', target = 'darwin-arm64', environment = {}) {
    return signedRuntimeStore(path.join(dir, name), shared ? command : undefined, kind, target, environment)
  }
  function source(name, value) {
    const filename = path.join(dir, name)
    fs.writeFileSync(filename, value, {flag: 'wx', mode: 0o600})
    return filename
  }
  let downloads = 0
  const download = () => path.join(dir, 'download-' + ++downloads)
  return {dir, registry, runner, source, download}
}

test('local-only signing persists the first verified bytes across builds', posix, t => {
  const {runner, source, download} = fixture(t)
  const first = runner('persistent', false)
  assert.equal(first.lookup(key, download(), neverRestore), null)
  assert.equal(first.publish(key, source('one', 'first'), download(), neverRestore), false)
  const nextBuild = runner('persistent', false)
  const restored = []
  assert.equal(nextBuild.lookup(key, download(), file => restored.push(read(file))), 'local')
  assert.equal(nextBuild.publish(key, source('two', 'later'), download(), file => restored.push(read(file))), true)
  assert.deepEqual(restored, ['first', 'first'])
})

test('two cold runners converge on the published winner and a fresh runner retains it', posix, t => {
  const {runner, source, download, registry} = fixture(t)
  const one = runner('one'), two = runner('two')
  // Interleave the build transactions deterministically: both see a miss before either signs.
  assert.equal(one.lookup(key, download(), neverRestore), null)
  assert.equal(two.lookup(key, download(), neverRestore), null)
  const winner = source('winner.zip', 'timestamp one')
  const loser = source('loser.zip', 'timestamp two')
  assert.equal(one.publish(key, winner, download(), neverRestore), false)
  const restored = []
  const restore = file => restored.push(read(file))
  assert.equal(two.publish(key, loser, download(), restore), true)
  assert.equal(read(loser), 'timestamp two')
  assert.equal(two.lookup(key, download(), restore), 'local')
  assert.equal(runner('three').lookup(key, download(), restore), 'registry')
  assert.equal(runner('three').lookup(key, download(), restore), 'local')
  assert.deepEqual(restored, Array(4).fill('timestamp one'))
  assert.deepEqual(read(path.join(registry, 'calls')).trim().split('\n'), [
    'fetch 3', 'fetch 3', 'publish 0', 'publish 4', 'fetch 0', 'confirm 0', 'fetch 0', 'confirm 0',
  ])
})

test('local-only and shared caches use separate namespaces under the same root', posix, t => {
  const {runner, source, download} = fixture(t)
  const local = runner('same', false)
  local.publish(key, source('offline', 'local signature'), download(), neverRestore)
  const shared = runner('same')
  assert.equal(shared.lookup(key, download(), neverRestore), null)
  shared.publish(key, source('online', 'shared signature'), download(), neverRestore)
  assert.equal(local.lookup(key, download(), file => assert.equal(read(file), 'local signature')), 'local')
  assert.equal(shared.lookup(key, download(), file => assert.equal(read(file), 'shared signature')), 'local')
  assert.equal(runner('other-root', false).lookup(key, download(), neverRestore), null)
})

test('a hot signing cache backfills a purged version and converges on a different verified winner', posix, t => {
  const {registry, runner, source, download} = fixture(t)
  const store = runner('hot')
  const signed = source('before.zip', 'original signature')
  store.publish(key, signed, download(), neverRestore)
  const folder = path.join(registry, 'darwin-arm64', 'python', macComponentVersions().python)
  fs.rmSync(folder, {recursive: true})
  const restored = []
  const restore = file => restored.push(read(file))
  assert.equal(store.lookup(key, download(), restore), 'local')
  assert.equal(read(path.join(folder, 'component.zip')), 'original signature')
  fs.rmSync(folder, {recursive: true})
  runner('new-winner').publish(key, source('new.zip', 'new signature'), download(), neverRestore)
  assert.equal(store.lookup(key, download(), restore), 'registry')
  assert.equal(store.lookup(key, download(), restore), 'local')
  assert.deepEqual(restored, ['original signature', 'new signature', 'new signature'])
  assert.equal(read(path.join(registry, 'calls')), 'publish 0\nconfirm 3\npublish 0\npublish 0\nconfirm 4\nfetch 0\nconfirm 0\n')
})

test('a different unregistered signing archive must pass the active policy before publication or local retention', posix, t => {
  const {dir, registry, runner, source, download} = fixture(t)
  const store = runner('recovery')
  const folder = path.join(registry, 'darwin-arm64', 'python', macComponentVersions().python)
  fs.mkdirSync(folder, {recursive: true})
  const orphan = path.join(folder, 'component.zip')
  const receipt = path.join(folder, 'receipt.json')
  fs.writeFileSync(orphan, 'invalid signature')
  const local = source('ours.zip', 'separately verified signature')
  assert.equal(store.lookup(key, download(), neverRestore), null)
  function verify(archive) {
    assert.equal(fs.existsSync(receipt), false, 'public fetch cannot discover the candidate during verification')
    if (read(archive) !== 'valid signature') throw new Error('signature differs from active policy')
  }
  assert.throws(() => store.publish(key, local, download(), verify), /active policy/)
  assert.equal(fs.existsSync(receipt), false)
  assert.equal(fs.existsSync(path.join(dir, 'recovery', 'shared-v3', 'python', 'darwin-arm64', macComponentVersions().python, key)), false)
  fs.writeFileSync(orphan, 'valid signature')
  assert.equal(store.publish(key, local, download(), verify), true)
  assert.equal(JSON.parse(read(receipt)).inputSha256, key)
  assert.equal(store.lookup(key, download(), archive => assert.equal(read(archive), 'valid signature')), 'local')
  assert.equal(read(path.join(registry, 'calls')), 'fetch 3\npublish 5\nrecover 0\npublish 5\nrecover 0\npublish 0\nconfirm 0\n')
  fs.rmSync(receipt)
  fs.writeFileSync(orphan, 'new invalid signature')
  assert.throws(() => store.lookup(key, download(), verify), /active policy/)
  assert.equal(fs.existsSync(receipt), false)
})

test('a verified v2 local signing entry can provision the selected private version', posix, t => {
  const {dir, registry, runner, source, download} = fixture(t)
  const previous = path.join(dir, 'previous-scope')
  const legacy = path.join(previous, 'shared-v2', 'frameworks', 'darwin-x86_64', key)
  fs.mkdirSync(legacy, {recursive: true, mode: 0o700})
  const zip = source('framework.zip', 'signed frameworks')
  fs.copyFileSync(zip, path.join(legacy, 'component.zip'))
  fs.writeFileSync(path.join(legacy, 'receipt.json'), JSON.stringify({
    schema: 2, inputs: {kind: 'frameworks', target: 'darwin-x86_64', key},
    inventory: {archiveSha256: hashFile(zip), archiveBytes: fs.statSync(zip).size},
  }))
  const env = {SCHOLARSEED_MAC_SIGN_PREVIOUS_CACHE: previous}
  const restore = file => assert.equal(read(file), read(zip))
  const version = macComponentVersions().electron.replace(/-r\d+$/, '-r1')
  for (const label of [version, '44.3.0-r9']) {
    if (label !== version) env.SCHOLARSEED_CI_CACHE_VERSION_DARWIN_X86_64_FRAMEWORKS = label
    const store = runner('same', true, 'frameworks', 'darwin-x86_64', env)
    assert.equal(store.lookup(key, download(), restore), 'local')
    assert.equal(read(path.join(registry, 'darwin-x86_64', 'frameworks', label, 'component.zip')), read(zip))
    assert.equal(store.lookup(key, download(), restore), 'local')
  }
  fs.writeFileSync(path.join(legacy, 'receipt.json'), 'unrelated corrupt v2 entry')
  assert.equal(runner('another', true, 'frameworks', 'darwin-x86_64', env).lookup(key, download(), restore), 'registry')
  assert.equal(read(path.join(registry, 'calls')), 'fetch 3\npublish 0\nconfirm 0\nfetch 3\npublish 0\nconfirm 0\nfetch 0\n')
})

test('a different signing input needs its own revision even on the original runner', posix, t => {
  const {registry, runner, source, download} = fixture(t)
  const file = source('first.zip', 'production signature')
  const otherKey = 'bc'.repeat(32)
  const first = runner('machine')
  first.publish(key, file, download(), neverRestore)
  assert.throws(() => first.lookup(otherKey, download(), neverRestore), /registry fetch failed/)
  const second = runner('machine', true, 'python', 'darwin-arm64', {SCHOLARSEED_CI_CACHE_VERSION_DARWIN_ARM64_PYTHON: '3.14.10-r7'})
  assert.equal(second.lookup(otherKey, download(), neverRestore), null)
  second.publish(otherKey, file, download(), neverRestore)
  const receipt = version => JSON.parse(read(path.join(registry, 'darwin-arm64', 'python', version, 'receipt.json'))).inputSha256
  assert.equal(receipt(macComponentVersions().python), key)
  assert.equal(receipt('3.14.10-r7'), otherKey)
  assert.throws(() => runner('wrong', true, 'python', 'darwin-arm64', {
    SCHOLARSEED_CI_CACHE_VERSION_DARWIN_ARM64_PYTHON: '3.14.11-r1',
  }), /Invalid private CI cache version/)
})

test('corrupt local bytes stop before restore, and failed remote verification never warms a runner', posix, t => {
  const {runner, source, download, registry} = fixture(t)
  const store = runner('one')
  store.publish(key, source('good', 'verified signature'), download(), neverRestore)
  assert.equal(store.lookup(key, download(), file => fs.writeFileSync(file, 'corrupt')), 'local')
  assert.throws(() => store.lookup(key, download(), neverRestore), /digest mismatch/)
  assert.equal(read(path.join(registry, 'calls')), 'publish 0\nconfirm 0\n')
  const fresh = runner('two')
  const verify = () => { throw new Error('codesign verification failed') }
  assert.throws(() => fresh.lookup(key, download(), verify), /codesign verification failed/)
  assert.equal(fresh.lookup(key, download(), file => assert.equal(read(file), 'verified signature')), 'registry')
})

test('reject invalid registry configuration and publish keys before writing to either store', posix, t => {
  const {dir, runner, source, download, registry} = fixture(t)
  assert.throws(() => signedRuntimeStore(path.join(dir, 'null-command'), 'null', 'python', 'darwin-arm64'), /registry command/)
  const archive = source('signed', 'bytes')
  for (const shared of [true, false]) {
    const store = runner('invalid', shared)
    assert.throws(() => store.publish('../other', archive, download(), neverRestore), /key/)
  }
  assert.equal(fs.existsSync(path.join(dir, 'invalid', 'other')), false)
  assert.equal(fs.existsSync(path.join(registry, 'calls')), false)
})

test('identical input keys have separate signing receipts for each kind and canonical target', posix, t => {
  const {dir, runner, source, download} = fixture(t)
  for (const [kind, target] of [['python', 'darwin-arm64'], ['texlive', 'darwin-arm64'], ['python', 'darwin-x86_64']]) {
    const data = kind + '-' + target
    const file = source(data, data)
    const local = runner('machine', true, kind, target)
    assert.equal(local.lookup(key, download(), neverRestore), null)
    assert.equal(local.publish(key, file, download(), neverRestore), false)
    const version = macComponentVersions()[kind]
    const folder = path.join(dir, 'machine', 'shared-v3', kind, target, version, key)
    assert.equal(read(path.join(folder, hashFile(file) + '.zip')), data)
    assert.deepEqual(JSON.parse(read(path.join(folder, 'receipt.json'))), {
      schema: 3, inputs: {kind, target, version, key}, inventory: {archiveSha256: hashFile(file), archiveBytes: data.length},
    })
    const verify = archive => assert.equal(read(archive), data)
    assert.equal(local.lookup(key, download(), verify), 'local')
    assert.equal(runner('fresh', true, kind, target).lookup(key, download(), verify), 'registry')
  }
})

test('flat v1 entries stay cold and forged v2 receipt identities cannot be restored', posix, t => {
  const {dir, runner, source, download} = fixture(t)
  const file = source('old-code', 'previous signature')
  const store = runner('machine', false)
  const legacy = path.join(dir, 'machine', 'local-v1', key)
  fs.mkdirSync(legacy, {recursive: true, mode: 0o700})
  fs.copyFileSync(file, path.join(legacy, 'signed.zip'))
  fs.writeFileSync(path.join(legacy, 'sha256'), hashFile(file) + '\n')
  assert.equal(store.lookup(key, download(), neverRestore), null)
  store.publish(key, file, download(), neverRestore)
  const filename = path.join(dir, 'machine', 'local-v2', 'python', 'darwin-arm64', key, 'receipt.json')
  const original = read(filename)
  for (const [section, field, value] of [
    ['inputs', 'kind', 'texlive'], ['inputs', 'target', 'darwin-x86_64'], ['inputs', 'key', 'bc'.repeat(32)],
    ['inventory', 'archiveSha256', 'dd'.repeat(32)], ['inventory', 'archiveBytes', 1],
  ]) {
    const invalid = JSON.parse(original)
    invalid[section][field] = value
    fs.writeFileSync(filename, JSON.stringify(invalid))
    assert.throws(() => store.lookup(key, download(), neverRestore), /receipt|digest mismatch/)
  }
})

test('invalid kind, target, or redirected parent cannot access local or remote signing entries', posix, t => {
  const {dir, runner, source, download, registry} = fixture(t)
  for (const [kind, target] of [['../python', 'darwin-arm64'], ['browser', 'darwin-arm64'],
    ['electron', '../darwin-arm64'], ['electron', 'darwin-x64'], ['frameworks', 'win32-x86_64']]) {
    assert.throws(() => runner('invalid', true, kind, target), /kind or target/)
  }
  assert.equal(fs.existsSync(path.join(dir, 'invalid')), false)
  const store = runner('machine')
  const kindFolder = path.join(dir, 'machine', 'shared-v3', 'python')
  fs.renameSync(kindFolder, kindFolder + '-real')
  fs.symlinkSync(kindFolder + '-real', kindFolder, 'dir')
  const archive = source('signed-archive', 'test bytes')
  assert.throws(() => store.lookup(key, download(), neverRestore), /invalid build state object/)
  assert.throws(() => store.publish(key, archive, download(), neverRestore), /invalid build state object/)
  assert.throws(() => runner('machine'), /invalid build state object/)
  assert.equal(fs.existsSync(path.join(registry, 'calls')), false)
})
