const sourceDirectory = require('node:path').dirname(__dirname)
// Compiler/signer fixtures verify sealing order, not real native/signing acceptance.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { runInNewContext } = require('node:vm')
const { createRequire } = require('node:module')
const { libraries } = require('../../../native/libraries.cjs')
const source = fs.readFileSync(path.join(sourceDirectory, 'seal.cjs'), 'utf8')
const sourceRequire = createRequire(path.join(sourceDirectory, 'seal.cjs'))
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function fixture(t, platform = 'win32', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-batch-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const names = libraries(platform)
  for (const name of names) fs.writeFileSync(path.join(directory, name), name)
  const build = { schema: 2, signed: false, directory, platform, arch: 'x86_64', licenses: [],
    libraries: names.map(name => ({ path: name, sha256: digest(path.join(directory, name)) })) }
  fs.writeFileSync(path.join(directory, 'build.json'), JSON.stringify(build))
  if (options.changed) fs.appendFileSync(path.join(directory, names.at(-1)), 'changed before signing')
  const calls = { batches: [], verified: [], codesigned: [] }
  const module = { exports: {} }
  runInNewContext(source, { module, Buffer, process: { platform }, require(name) {
    if (name === '../shared/native.cjs') return { compileNative: async () => build }
    if (name === '../../native/libraries.cjs') return { LIBRARIES: names, BUNDLED_LIBRARIES: names.map(n => `out/main/${n}`) }
    if (name === './windows-sign.cjs') return {
      async signFiles(files) {
        calls.batches.push([...files])
        for (const file of files) assert.equal(digest(file), build.libraries.find(item => item.path === path.basename(file)).sha256)
        if (options.signFailure) throw new Error('batch rejected')
        for (const file of files) fs.appendFileSync(file, ':signed')
      },
      verify(file, publisher) {
        assert.equal(publisher, 'fixture publisher')
        calls.verified.push(file)
        assert.match(fs.readFileSync(file, 'utf8'), /:signed$/)
      },
    }
    if (name === 'node:child_process') return { spawnSync(executable, args) {
      assert.equal(platform, 'darwin')
      assert.equal(executable, '/usr/bin/codesign')
      if (args[0] === '--force') {
        calls.codesigned.push(args.at(-1))
        assert.equal(args[2], '-')
        fs.appendFileSync(args.at(-1), ':adhoc')
      }
      return { status: 0, stdout: args[0] === '--display' ? 'Signature=adhoc' : '' }
    } }
    return sourceRequire(name)
  } })
  return { ...module.exports, directory, names, calls, build,
    signing: platform === 'win32' ? { mode: 'authenticode', publisher: 'fixture publisher' } : { mode: 'ad-hoc-local-only' } }
}

test('Windows validates all compiler outputs, signs one batch, then verifies and freezes each library', async t => {
  const f = fixture(t)
  const frozen = await f.prepareNative({ signing: f.signing })
  assert.deepEqual(f.calls.batches, [f.names.map(name => path.join(f.directory, name))])
  for (const name of f.names) {
    const filename = path.join(f.directory, name)
    assert.ok(f.calls.verified.filter(file => file === filename).length >= 2)
    assert.equal(frozen.libraries.find(item => item.path === `out/main/${name}`).sha256, digest(filename))
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'build.json'))), f.build)
  f.readNative(f.directory, frozen)
})

test('a changed final compiler output prevents the entire batch from being submitted', async t => {
  const f = fixture(t, 'win32', { changed: true })
  await assert.rejects(f.prepareNative({ signing: f.signing }), /compiler output changed/)
  assert.equal(f.calls.batches.length, 0)
  assert.equal(fs.existsSync(path.join(f.directory, 'native.json')), false)
})

test('a rejected signing batch never publishes a frozen manifest', async t => {
  const f = fixture(t, 'win32', { signFailure: true })
  await assert.rejects(f.prepareNative({ signing: f.signing }), /batch rejected/)
  assert.equal(fs.existsSync(path.join(f.directory, 'native.json')), false)
})

test('macOS keeps per-library codesign and does not invoke the Windows batch signer', async t => {
  const f = fixture(t, 'darwin')
  const frozen = await f.prepareNative({ signing: f.signing })
  assert.deepEqual(f.calls.codesigned, f.names.map(name => path.join(f.directory, name)))
  assert.equal(f.calls.batches.length, 0)
  assert.equal(frozen.platform, 'darwin')
  f.readNative(f.directory, frozen)
})
