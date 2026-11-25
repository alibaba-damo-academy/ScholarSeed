const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { signedRuntimeStore } = require('../mac-sign-store.cjs')

const key = 'ab'.repeat(32)
const posix = {skip: process.platform === 'win32' && 'macOS cache uses POSIX directory rename semantics'}
const neverRestore = () => assert.fail('unexpected archive restoration')
const read = file => fs.readFileSync(file, 'utf8')

// Run in a separate Node process to exercise the actual argv/exit-code boundary.
function registryProvider() {
  const fs = require('node:fs')
  const path = require('node:path')
  const [root, operation, keyFlag, key, archiveFlag, archive] = process.argv.slice(1)
  if (keyFlag !== '--key' || archiveFlag !== '--archive' || !/^[a-f0-9]{64}$/.test(key) || !path.isAbsolute(archive))
    throw new Error('invalid provider arguments')
  const entry = path.join(root, key)
  let code = 0
  if (operation === 'fetch') {
    if (fs.existsSync(entry)) fs.copyFileSync(entry, archive, fs.constants.COPYFILE_EXCL)
    else code = 3
  } else if (operation === 'publish') {
    try {
      fs.copyFileSync(archive, entry, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!fs.readFileSync(archive).equals(fs.readFileSync(entry))) code = 4
    }
  } else throw new Error('unknown operation')
  fs.appendFileSync(path.join(root, 'calls'), operation + ' ' + code + '\n')
  process.exitCode = code
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac sign cache-')))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  const registry = path.join(dir, 'registry')
  fs.mkdirSync(registry, {mode: 0o700})
  const command = JSON.stringify([process.execPath, '-e', '(' + registryProvider.toString() + ')()', '--', registry])
  function runner(name, shared = true) {
    return signedRuntimeStore(path.join(dir, name), shared ? command : undefined)
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
    'fetch 3', 'fetch 3', 'publish 0', 'publish 4', 'fetch 0', 'fetch 0',
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

test('corrupt local bytes stop before restore, and failed remote verification never warms a runner', posix, t => {
  const {runner, source, download, registry} = fixture(t)
  const store = runner('one')
  store.publish(key, source('good', 'verified signature'), download(), neverRestore)
  assert.equal(store.lookup(key, download(), file => fs.writeFileSync(file, 'corrupt')), 'local')
  assert.throws(() => store.lookup(key, download(), neverRestore), /digest mismatch/)
  assert.equal(read(path.join(registry, 'calls')), 'publish 0\n')
  const fresh = runner('two')
  const verify = () => { throw new Error('codesign verification failed') }
  assert.throws(() => fresh.lookup(key, download(), verify), /codesign verification failed/)
  assert.equal(fresh.lookup(key, download(), file => assert.equal(read(file), 'verified signature')), 'registry')
})

test('reject invalid registry configuration and publish keys before writing to either store', posix, t => {
  const {dir, runner, source, download, registry} = fixture(t)
  assert.throws(() => signedRuntimeStore(path.join(dir, 'null-command'), 'null'), /registry command/)
  const archive = source('signed', 'bytes')
  for (const shared of [true, false]) {
    const store = runner('invalid', shared)
    assert.throws(() => store.publish('../other', archive, download(), neverRestore), /key/)
  }
  assert.equal(fs.existsSync(path.join(dir, 'invalid', 'other')), false)
  assert.equal(fs.existsSync(path.join(registry, 'calls')), false)
})
