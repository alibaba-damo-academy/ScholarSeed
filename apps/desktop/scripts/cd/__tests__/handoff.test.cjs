const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const { policyFor, validatePolicy, assertDependencies, readLauncher, launcherMessages, updateMessages } = require('../handoff.cjs')
const sourceRequire = createRequire(path.join(sourceDirectory, 'handoff.cjs'))

test('handoff policy freezes the actual component envelope and product identity', () => {
  const context = { appId: 'scholarseed', version: '0.2.0', buildNumber: '202610170001',
    productName: 'ScholarSeed', product: { config: { product_id: 'scholarseed',
      bundle_id: 'scholarseed', update_channel: 'preview', build_number: '202610170001' } },
    runtime: { manifestSha256: 'a'.repeat(64), keys: {} } }
  const policy = policyFor(context)
  assert.equal(validatePolicy(policy), policy)
  assert.equal(policy.pack_version, '0.2.0-build.202610170001')
  assert.equal(policy.runtime_sha256, context.runtime.manifestSha256)
  assert.deepEqual(Object.keys(policy.recovery_messages), ['en', 'zh'])
  for (const language of ['en', 'zh']) {
    const source = JSON.parse(fs.readFileSync(path.join(sourceDirectory,
      '../../src/localization/locales', language, 'native.json'), 'utf8'))
    assert.deepEqual(policy.recovery_messages[language], source.updateInterrupted)
    for (const message of Object.values(policy.recovery_messages[language]))
      assert.equal(typeof message === 'string' && message.length > 0, true)
  }
  assert.throws(() => validatePolicy({ ...policy, runtime_sha256: '' }))
  assert.throws(() => validatePolicy({ ...policy, keys: { test: 'invalid' } }))
  assert.throws(() => validatePolicy({ ...policy, recovery_messages: undefined }))
  assert.throws(() => validatePolicy({ ...policy, recovery_messages: {
    ...policy.recovery_messages, zh: { title: 'title', stopped: '', unconfirmed: '' },
  } }))
  assert.throws(() => policyFor({ ...context, runtime: undefined }))
  assert.throws(() => validatePolicy({ ...policy, update_messages: undefined }))
  assert.throws(() => validatePolicy({ ...policy, update_messages: { en: policy.update_messages.en } }))
})

test('update UI freezes bilingual stages and real extraction file and byte parameters', () => {
  for (const [language, text] of Object.entries(updateMessages())) {
    const source = JSON.parse(fs.readFileSync(path.join(sourceDirectory, '../../src/localization/locales', language, 'native.json')))
    assert.equal(text.title, source.updateProgress.title)
    assert.equal(text.installing, source.updateProgress.installing)
    assert.equal(text.restarting, source.updateProgress.restarting)
    assert.equal(text.extracting, source.startup.componentExtracting)
    assert.equal(text.failed, source.updateProgress.failed)
    for (const param of ['{{name}}', '{{percent}}', '{{count}}', '{{total}}']) assert.ok(text.extracting.includes(param))
  }
})

for (const language of ['en', 'zh']) {
  test(`handoff recovery diagnostics identify invalid ${language} locale resources`, () => {
    const filename = path.join(sourceDirectory, '../../src/localization/locales', language, 'native.json')
    const source = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const context = { appId: 'scholarseed', version: '0.2.0', productName: 'ScholarSeed',
      product: { config: { product_id: 'scholarseed', bundle_id: 'scholarseed',
        update_channel: 'preview', build_number: '202610170001' } },
      runtime: { manifestSha256: 'a'.repeat(64), keys: {} } }
    const readError = Object.assign(new Error('locale is unavailable'), { code: 'ENOENT' })
    const cases = [
      { label: 'unreadable locale', key: 'updateInterrupted', read: () => { throw readError }, cause: readError },
      { label: 'invalid JSON', key: 'updateInterrupted', read: () => '{', causeName: 'SyntaxError' },
      ...[undefined, null, [], 'messages'].map(value => ({
        label: `invalid section ${JSON.stringify(value)}`, key: 'updateInterrupted',
        read: () => JSON.stringify({ ...source, updateInterrupted: value }),
      })),
      ...['title', 'stopped', 'unconfirmed'].flatMap(field =>
        [undefined, null, 7, '', ' \t', 'message\0'].map(value => ({
          label: `invalid ${field} ${JSON.stringify(value)}`, key: `updateInterrupted.${field}`,
          read: () => JSON.stringify({ ...source, updateInterrupted: {
            ...source.updateInterrupted, [field]: value,
          } }),
        }))),
    ]
    for (const scenario of cases) {
      const module = { exports: {} }
      const requireMock = name => name === 'node:fs' ? {
        ...fs,
        readFileSync(received, ...options) {
          return received === filename ? scenario.read() : fs.readFileSync(received, ...options)
        },
      } : sourceRequire(name)
      runInNewContext(fs.readFileSync(path.join(sourceDirectory, 'handoff.cjs'), 'utf8'),
        { require: requireMock, module, __dirname: sourceDirectory, process, Buffer })
      assert.throws(() => module.exports.policyFor(context), error => {
        assert.equal(error.message, `invalid native handoff recovery messages: ${filename}#${scenario.key}`)
        if (scenario.cause) assert.equal(error.cause, scenario.cause)
        if (scenario.causeName) assert.equal(error.cause?.name, scenario.causeName)
        return true
      }, scenario.label)
    }
  })
}

test('independent helper cannot acquire historical store dependencies', () => {
  const own = 'scholarseed.local/desktop/updater/handoff\nscholarseed.local/desktop/updater/cmd/handoff\nscholarseed.local/desktop/updater/internal/security'
  assert.doesNotThrow(() => assertDependencies(own))
  assert.throws(() => assertDependencies(`${own}\nscholarseed.local/desktop/updater/store`))
  assert.throws(() => assertDependencies(`${own}\nexample.com/external`))
})

// Exercise orchestration with real temporary files; the Windows factory and Go
// suite are also run on Windows, independently of this child-process fixture.
for (const failure of [null, 'exit', 'spawn']) {
  test(`helper tests use an isolated verification leaf and clean it after ${failure || 'success'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'))
    const frozen = { platform: 'win32', runDirectory: path.join(root, 'deep-build'),
      verificationRoot: root, repo: path.join(root, 'repo') }
    const environment = { TEMP: frozen.runDirectory, TMP: frozen.runDirectory,
      TMPDIR: frozen.runDirectory, GOROOT: 'compiler-root', GOCACHE: 'compiler-cache' }
    let leaf, calls = 0
    const module = { exports: {} }
    const requireMock = name => {
      if (name === './verification-directory.cjs') return {
        createPackageCheckDirectory(received) {
          assert.equal(received, frozen)
          leaf = fs.mkdtempSync(path.join(received.verificationRoot, 'v-'))
          return leaf
        },
      }
      if (name === 'node:child_process') return {
        spawnSync(executable, args, options) {
          calls++
          assert.equal(executable, 'reviewed-go.exe')
          assert.deepEqual(Array.from(args), ['test', '-count=1', '-timeout=5m', './handoff', './cmd/handoff'])
          for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(options.env[key], leaf)
          for (const key of ['GOROOT', 'GOCACHE']) assert.equal(options.env[key], environment[key])
          fs.writeFileSync(path.join(leaf, 'fixture'), 'owned test residue')
          if (failure === 'spawn') throw new Error('spawn failed')
          return { status: failure ? 1 : 0, stderr: failure ? 'test failed' : '', stdout: 'ok' }
        },
      }
      return sourceRequire(name)
    }
    try {
      runInNewContext(fs.readFileSync(path.join(sourceDirectory, 'handoff.cjs'), 'utf8'),
        { require: requireMock, module, __dirname: sourceDirectory, process, Buffer })
      const execute = () => module.exports.testHandoff('reviewed-go.exe', environment, frozen)
      if (failure) assert.throws(execute, /test failed|spawn failed/)
      else execute()
      assert.equal(calls, 1)
      assert.equal(fs.existsSync(leaf), false)
      assert.equal(fs.existsSync(root), true)
      for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(environment[key], frozen.runDirectory)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('build forwards its preflighted verification root to helper tests', () => {
  const source = fs.readFileSync(path.join(sourceDirectory, 'build.cjs'), 'utf8')
  assert.match(source, /prepareHandoff\(\{[^}]*verificationRoot: context\.verificationRoot, repo: context\.repo/s)
})

test('launcher UI freezes both existing localization resources and their progress parameters', () => {
  const messages = launcherMessages()
  assert.deepEqual(Object.keys(messages), ['en', 'zh'])
  for (const [language, text] of Object.entries(messages)) {
    const source = JSON.parse(fs.readFileSync(path.join(sourceDirectory, '../../src/localization/locales', language, 'native.json')))
    assert.equal(text.title, source.startup.title)
    assert.equal(text.brand, source.startup.brand)
    assert.equal(text.elapsed, source.startup.elapsed)
    assert.equal(text.cancel, source.tray.cancel)
    assert.equal(text.downloading, source.startup.componentDownloading)
    assert.match(text.downloading, /\{\{name\}\}/)
    assert.match(text.downloading, /\{\{percent\}\}/)
    assert.ok(Object.values(text).every(value => typeof value === 'string' && value.length > 0))
  }
})

test('launcher verification binds the executable, official DLL and license after packaging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-frozen-'))
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
  try {
    const artifacts = ['ScholarSeed.exe', 'libvelopack.dll', 'LAUNCHER-GO-LICENSE.txt', 'Uninstall.exe'].map(file => {
      const bytes = Buffer.from(`frozen ${file}`)
      fs.writeFileSync(path.join(root, file), bytes)
      return { file, sha256: digest(bytes), bytes: bytes.length }
    })
    const frozen = { schema: 1, ...artifacts[0], library: artifacts[1], license: artifacts[2], uninstaller: artifacts[3],
      signing: { mode: 'unsigned-dev' } }
    assert.equal(readLauncher(root, frozen).path, path.join(root, 'ScholarSeed.exe'))
    for (const artifact of artifacts) {
      const filename = path.join(root, artifact.file)
      const original = fs.readFileSync(filename)
      fs.writeFileSync(filename, Buffer.from('changed'))
      assert.throws(() => readLauncher(root, frozen), /frozen bytes/)
      fs.writeFileSync(filename, original)
    }
    assert.throws(() => readLauncher(root, { ...frozen, file: 'other.exe' }), /frozen launcher/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the shared compiler session includes the launcher without reducing helper tests', () => {
  const module = { exports: {} }
  let calls = 0
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-tests-'))
  const requireMock = name => {
    if (name === './verification-directory.cjs') return { createPackageCheckDirectory() { return fs.mkdtempSync(path.join(root, 'v-')) } }
    if (name === 'node:child_process') return { spawnSync(_executable, args) {
      calls++
      assert.deepEqual(Array.from(args), ['test', '-count=1', '-timeout=5m', './handoff', './cmd/handoff', './cmd/launcher', './cmd/uninstall'])
      return { status: 0, stdout: 'ok' }
    } }
    return sourceRequire(name)
  }
  try {
    runInNewContext(fs.readFileSync(path.join(sourceDirectory, 'handoff.cjs'), 'utf8'),
      { require: requireMock, module, __dirname: sourceDirectory, process, Buffer, URL })
    module.exports.testHandoff('reviewed-go.exe', process.env, {}, true)
    assert.equal(calls, 1)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a fresh checkout can load the packaging entry without npm dependencies', () => {
  const { spawnSync } = require('node:child_process')
  const script = `
    const Module = require('node:module')
    const path = require('node:path')
    const original = Module._load
    Module._load = function (name, ...args) {
      if (!name.startsWith('node:') && !name.startsWith('.') && !path.isAbsolute(name))
        throw new Error('npm dependency loaded before installation: ' + name)
      return original.call(this, name, ...args)
    }
    require(${JSON.stringify(path.join(sourceDirectory, 'build.cjs'))})
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
