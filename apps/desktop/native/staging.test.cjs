const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { prepareNative, readNative, nativeSignatureGuard } = require('../scripts/cd/seal.cjs')
const policy = require('./toolchain.json')
const { LIBRARIES } = require('./libraries.cjs')

const electron = process.env.SCHOLARSEED_LEASE_ELECTRON
assert.ok(electron && path.isAbsolute(electron), 'select the real Electron executable')
assert.equal(process.versions.node, policy.node)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-staging-'))
const output = path.join(root, 'compiled')
const signing = {
  mode: process.platform === 'darwin' ? 'ad-hoc-local-only' : 'unsigned-dev',
}
let frozen
test.before(async () => {
  frozen = await prepareNative({
    directory: output,
    signing,
    artifacts: JSON.parse(process.env.SCHOLARSEED_NATIVE_ARTIFACTS || '{}'),
  })
})
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

function copy(t) {
  const directory = fs.mkdtempSync(path.join(root, 'copy-'))
  fs.cpSync(output, directory, { recursive: true })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('real compiler and signer freeze final bytes without rewriting provenance', (t) => {
  const files = readNative(output, frozen)
  const build = JSON.parse(files.get('build.json'))
  for (const name of LIBRARIES) {
    const finalSha = crypto.createHash('sha256').update(files.get(name)).digest('hex')
    assert.equal(frozen.libraries.find(item => item.path === `out/main/${name}`).sha256, finalSha)
    const originalSha = build.libraries.find(item => item.path === name).sha256
    if (process.platform === 'darwin') assert.notEqual(originalSha, finalSha)
    else assert.equal(originalSha, finalSha)
  }
  assert.equal(build.signed, false)
  assert.deepEqual(frozen.signing, signing)
  assert.ok(Object.isFrozen(frozen))
  t.diagnostic(JSON.stringify({ platform: process.platform, original: build.libraries, frozen }))
})

test('actual Node and Electron load both prepared libraries and enumerate system font files', () => {
  const driver = path.join(root, 'load.cjs')
  fs.writeFileSync(
    driver,
    `process.on('uncaughtException', error => { console.error(error); process.exit(1); });
const api = require(${JSON.stringify(path.join(output, 'lease.node'))});
const fonts = require(${JSON.stringify(path.join(output, 'fonts.node'))});
const policy = ${JSON.stringify(policy.electron)};
if (process.env.SCHOLARSEED_STAGING_HOST === 'electron') {
  if (process.versions.electron !== policy || !require('electron').app) throw new Error('Electron host required');
} else if (process.versions.electron) throw new Error('Node host required');
const lease = api.acquire(${JSON.stringify(path.join(root, 'loaded.lock'))}, true);
api.release(lease);
fonts.enumerateFonts().then(catalog => {
  if (!Array.isArray(catalog) || !catalog.length || catalog.some(face => !face.path || !face.postscriptName)) throw new Error('Native font enumeration failed');
  console.log('native-staging-loaded:' + catalog.length);
  process.exit(0);
}).catch(error => { console.error(error); process.exit(1); });
`
  )
  for (const host of [process.execPath, electron]) {
    const result = execFileSync(
      host,
      [...(host === electron ? [`--user-data-dir=${path.join(root, 'profile')}`] : []), driver],
      {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          SCHOLARSEED_STAGING_HOST: host === electron ? 'electron' : 'node',
        },
      }
    )
    assert.match(result, /native-staging-loaded/)
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, [driver], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 20000,
        env: { ...process.env, SCHOLARSEED_STAGING_HOST: 'electron' },
      }),
    /Electron host required/
  )
})

test('unsupported or incomplete signing policy fails before creating output', async () => {
  const directory = path.join(root, 'must-not-exist')
  for (const invalid of [
    undefined,
    {},
    { mode: 'distribution' },
    { mode: 'developer-id' },
    { mode: 'authenticode' },
  ]) {
    await assert.rejects(prepareNative({ directory, signing: invalid }), /signing|publisher/)
    assert.equal(fs.existsSync(directory), false)
  }
})

test('a frozen target or signing policy cannot be relabelled', () => {
  for (const changed of [
    { libraries: frozen.libraries.map((item, index) => index === 0 ? { ...item, path: 'out/preload/lease.node' } : item) },
    { libraries: frozen.libraries.slice(0, 1) },
    { libraries: [frozen.libraries[0], frozen.libraries[0]] },
    { platform: 'linux' },
    { arch: 'other' },
    { signing: { mode: 'unsigned' } },
    ...frozen.libraries.map(changed => ({ libraries: frozen.libraries.map(item => item === changed ? { ...item, sha256: '0'.repeat(64) } : item) })),
    { manifestSha256: '0'.repeat(64) },
  ])
    assert.throws(() => readNative(output, { ...frozen, ...changed }))
})

for (const name of ['native.json', 'build.json', ...LIBRARIES, 'NODE-LICENSE.txt']) {
  test(`modified ${name} is rejected before supplying bundle bytes`, (t) => {
    const directory = copy(t)
    fs.appendFileSync(path.join(directory, name), 'tampered')
    assert.throws(() => readNative(directory, frozen), /digest/)
  })
}

test('unlisted resources are rejected', (t) => {
  const directory = copy(t)
  fs.writeFileSync(path.join(directory, 'extra.node'), 'not allowed')
  assert.throws(() => readNative(directory, frozen), /inventory/)
})

for (const name of LIBRARIES) {
  test(`hardlinked ${name} bytes are rejected despite identical digest`, (t) => {
    const directory = copy(t)
    const filename = path.join(directory, name)
    fs.unlinkSync(filename)
    fs.linkSync(path.join(output, name), filename)
    assert.throws(() => readNative(directory, frozen), /single-link/)
  })
}

test('symbolic artifact leaves cannot redirect verified resources', (t) => {
  const directory = copy(t)
  const filename = path.join(directory, 'NODE-LICENSE.txt')
  fs.unlinkSync(filename)
  try {
    fs.symlinkSync(path.join(output, 'NODE-LICENSE.txt'), filename, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM')
      return t.skip('host denies symbolic-link creation')
    throw error
  }
  assert.throws(() => readNative(directory, frozen), /single-link/)
})

for (const boundary of ['openSync', 'readFileSync']) {
  test(`same-byte replacement during ${boundary} rejects changed identity`, (t) => {
    const directory = copy(t)
    const filename = path.join(directory, 'native.json')
    const original = fs[boundary]
    const content = fs.readFileSync(filename)
    let replaced = false
    fs[boundary] = function (...args) {
      const target = boundary === 'openSync' ? args[0] === filename : typeof args[0] === 'number'
      if (!replaced && target) {
        replaced = true
        fs.renameSync(filename, path.join(directory, 'previous.json'))
        fs.writeFileSync(filename, content)
      }
      return original.apply(this, args)
    }
    try {
      assert.throws(() => readNative(directory, frozen), /changed while/)
      assert.equal(replaced, true)
    } finally {
      fs[boundary] = original
    }
  })
}


test('packaged provenance verifies both external ASAR libraries and rejects extra copies', (t) => {
  const directory = copy(t)
  const evidence = path.join(directory, 'evidence')
  fs.mkdirSync(evidence)
  for (const name of fs.readdirSync(output)) {
    if (!LIBRARIES.includes(name)) fs.copyFileSync(path.join(output, name), path.join(evidence, name))
  }
  const files = readNative(evidence, frozen, directory)
  for (const name of LIBRARIES) {
    const library = path.join(directory, name)
    assert.equal(files.get(name).equals(fs.readFileSync(library)), true)
    fs.copyFileSync(library, path.join(evidence, name))
    assert.throws(() => readNative(evidence, frozen, directory), /inventory/)
    fs.unlinkSync(path.join(evidence, name))
    fs.writeFileSync(library, Buffer.from('replaced native library'))
    assert.throws(() => readNative(evidence, frozen, directory), /digest/)
    fs.writeFileSync(library, files.get(name))
  }
})

test('native signature preservation binds one app and verifies bytes before and after signing', (t) => {
  const directory = copy(t)
  const app = path.join(directory, 'ScholarSeed.app')
  const resources = path.join(app, 'Contents', 'Resources')
  const libraryDirectory = path.join(resources, 'app.asar.unpacked', 'out', 'main')
  const evidence = path.join(resources, 'native')
  fs.mkdirSync(libraryDirectory, { recursive: true })
  fs.mkdirSync(evidence)
  for (const [name, content] of readNative(output, frozen))
    fs.writeFileSync(path.join(LIBRARIES.includes(name) ? libraryDirectory : evidence, name), content)
  const guard = nativeSignatureGuard(app, frozen)
  for (const name of LIBRARIES) {
    assert.equal(guard.ignore(path.join(libraryDirectory, name)), true)
    assert.equal(guard.ignore(path.join(directory, 'Other.app', 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main', name)), false)
    assert.equal(guard.ignore(path.join(resources, 'Nested.app', 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main', name)), false)
  }
  guard.verify()
  fs.writeFileSync(path.join(libraryDirectory, 'fonts.node'), Buffer.from('changed'))
  assert.throws(() => guard.verify(), /digest/)
  assert.throws(() => nativeSignatureGuard(app, frozen), /digest/)
})
