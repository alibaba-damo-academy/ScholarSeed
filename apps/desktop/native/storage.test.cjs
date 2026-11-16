const assert = require('node:assert/strict')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { test, after, before } = require('node:test')
const { compileNative } = require('../scripts/shared/native.cjs')
const { migrateLegacyHome, transferLegacyHome } = require('../src/main/legacy.ts')
const { observeStorageBindings } = require('../src/main/storagebinding.ts')
const policy = require('./toolchain.json')

const LIBRARY = 'lease.node'
let directory
let native

const windowsFixtureRoot = process.env.SCHOLARSEED_STORAGE_TEST_ROOT
if (process.platform === 'win32' && !windowsFixtureRoot) {
  test('Windows native storage contracts release the DLL before cleanup', (context) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'ss-storage-native-'))
    try {
      const environment = { ...process.env, SCHOLARSEED_STORAGE_TEST_ROOT: root }
      delete environment.NODE_TEST_CONTEXT
      const output = execFileSync(
        process.execPath,
        ['--experimental-transform-types', '--test', __filename],
        { encoding: 'utf8', env: environment }
      )
      assert.match(output, /native legacy retirement: normal/)
      context.diagnostic(output)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
} else {
  storageContracts()
}

function storageContracts() {
  before(async (context) => {
    assert.equal(process.versions.node, policy.node)
    directory =
      windowsFixtureRoot || mkdtempSync(join(realpathSync(tmpdir()), 'ss-storage-native-'))
    const output = join(directory, 'native')
    const build = await compileNative({ directory: output })
    context.diagnostic(JSON.stringify({ storageNativeBuild: build }))
    native = require(join(output, LIBRARY))
  })

  after(() => {
    if (directory && !windowsFixtureRoot) rmSync(directory, { recursive: true, force: true })
  })

  function homes() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ss-legacy-')))
    const source = join(root, 'old'),
      target = join(root, 'new')
    mkdirSync(source)
    mkdirSync(target)
    mkdirSync(join(source, 'nested'))
    writeFileSync(join(source, 'config.json'), '{"owned":true}')
    writeFileSync(join(source, 'nested', 'document.txt'), 'user document')
    return { root, source, target }
  }

  for (const mode of [
    'normal',
    'interrupted retirement',
    'new source file',
    'missing destination',
  ]) {
    test(`native legacy retirement: ${mode}`, async () => {
      const { root, source, target } = homes()
      const coordinator = join(root, 'coordinator')
      try {
        if (mode !== 'normal') transferLegacyHome(source, target)
        if (mode === 'interrupted retirement') rmSync(join(source, 'config.json'))
        if (mode === 'new source file') {
          writeFileSync(join(source, 'new-user-file'), 'must survive')
          await assert.rejects(
            migrateLegacyHome(native, coordinator, source, target),
            /source changed/
          )
          assert.equal(readFileSync(join(source, 'new-user-file'), 'utf8'), 'must survive')
          assert.equal(existsSync(join(source, 'config.json')), true)
          return
        }
        if (mode === 'missing destination') {
          rmSync(join(target, 'nested', 'document.txt'))
          await assert.rejects(migrateLegacyHome(native, coordinator, source, target))
          assert.equal(
            readFileSync(join(source, 'nested', 'document.txt'), 'utf8'),
            'user document'
          )
          assert.equal(existsSync(join(source, 'config.json')), true)
          return
        }
        const result = await migrateLegacyHome(native, coordinator, source, target)
        assert.equal(result?.retired, mode === 'normal' ? 2 : 1)
        assert.deepEqual(readdirSync(source), [])
        assert.equal(readFileSync(join(target, 'nested', 'document.txt'), 'utf8'), 'user document')
        assert.equal(
          JSON.parse(readFileSync(join(target, '.desktop-legacy-migration.json'), 'utf8')).phase,
          'retired'
        )
        writeFileSync(join(target, 'config.json'), 'new active settings')
        assert.equal(await migrateLegacyHome(native, coordinator, source, target), null)
        assert.equal(readFileSync(join(target, 'config.json'), 'utf8'), 'new active settings')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
  test('real native binding distinguishes same-path replacement', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'ss-binding-'))
    try {
      const home = join(root, 'home')
      const userData = join(root, 'profile')
      mkdirSync(home)
      mkdirSync(userData)
      const source = { home, userData, sessionData: userData, source: { kind: 'default' } }
      const before = observeStorageBindings(native, source)
      renameSync(home, home + '-old')
      mkdirSync(home)
      const after = observeStorageBindings(native, source)
      assert.notEqual(
        before.find((binding) => binding.path === home).identity,
        after.find((binding) => binding.path === home).identity
      )
      assert.deepEqual(
        before.find((binding) => binding.path === userData),
        after.find((binding) => binding.path === userData)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
