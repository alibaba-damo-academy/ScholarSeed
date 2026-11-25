

// Contract fixtures only; real Electron and installers are separate acceptance.
const { after, before, test } = require('node:test')

const assert = require('node:assert/strict')

const fs = require('node:fs')

const os = require('node:os')

const path = require('node:path')

const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { runInNewContext } = require('node:vm')
const { nativeTar } = require('../../../scripts/shared/python.cjs')
const { verifyMacOSTree } = require('../scripts/shared/macos.cjs')
const { ensurePrivateDirectory } = require('../scripts/shared/build-state.cjs')

const { artifact, bundledCodex, CACHE_VALIDATION, completeRuntime, publishRuntime, resolveVendoredCodex, stageVendoredCodex, verifyArchive } = require('./codex.cjs')

const REVIEWED_CODEX_VERSION = '0.171.0'

// Distribution CI passes real registry settings down to child processes. Each
// synthetic resolver test opts in to its own provider.
const inheritedRegistry = {}
before(() => {
  for (const key of ['SCHOLARSEED_CODEX_REGISTRY_COMMAND', 'SCHOLARSEED_CODEX_REGISTRY_SCOPE']) {
    if (process.env[key] !== undefined) inheritedRegistry[key] = process.env[key]
    delete process.env[key]
  }
})
after(() => Object.assign(process.env, inheritedRegistry))

test('Windows and macOS packaging preserve official prebuilt Codex without compiling', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/cd/build.cjs'), 'utf8')
  const start = source.indexOf('async function runtimeBinaries(')
  const end = source.indexOf('\nfunction frozenProductConfiguration(', start)
  assert.ok(start >= 0 && end > start)
  for (const platform of ['win32', 'darwin']) {
    const official = {path: 'reviewed-codex', root: 'reviewed-root', files: [],
      reported_version: REVIEWED_CODEX_VERSION,
      source: {package: '@openai/codex', distribution: 'verified-download'}}
    const resolved = []
    const prepare = runInNewContext(source.slice(start, end) + '\nruntimeBinaries', {
      DESKTOP: 'desktop', REPO: 'repository', console,
      loadDependencies: () => ({
        resolveVendoredCodex: async (...args) => { resolved.push(args.slice(0, 3)); return official },
        verify: {sha256: async () => 'reviewed-digest'}
      }),
      ensureRipgrep: async () => ({executable: 'reviewed-rg'}),
      executableDigest: async () => 'reviewed-rg-digest',
      command: () => `codex-cli ${REVIEWED_CODEX_VERSION}`,
      dedicatedCodex: {prepareDedicatedRuntime: () => assert.fail('packaging must not compile Codex')}
    })
    const result = await prepare({platform, arch: 'x86_64'})
    assert.deepEqual(resolved, [['desktop', platform, 'x64']])
    assert.equal(result.codex.path, official.path)
    assert.equal(result.codex.source, official.source)
    assert.equal(result.codex.files, official.files)
  }
})

function packagingFixture(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-packaging-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'upstream'), destination = path.join(root, 'product')
  const payloads = {
    'bin/codex': 'core runtime',
    'codex-package.json': '{"entrypoint":"bin/codex"}',
    'codex-resources/voice/bin/codex-voice-host': 'voice executable',
    'codex-resources/voice/lib/model.bin': 'voice resource',
    'codex-resources/voice-other/keep.bin': 'unrelated resource',
  }
  const files = Object.entries(payloads).map(([relative, data]) => {
    const filename = path.join(source, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, data, { mode: 0o755 })
    return { path: relative, mode: 0o755, sha256: crypto.createHash('sha256').update(data).digest('hex') }
  })
  const receipt = { archive_sha256: 'a'.repeat(64), reported_version: REVIEWED_CODEX_VERSION,
    entrypoint: 'bin/codex', files }
  const receiptPath = path.join(source, 'resolve-receipt.json')
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  return { root, source, destination, receipt, receiptPath,
    runtime: { root: source, path: path.join(source, receipt.entrypoint), files,
      reported_version: REVIEWED_CODEX_VERSION,
      source: { package: '@openai/codex', distribution: 'verified-download', archive_sha256: receipt.archive_sha256 } } }
}

test('macOS packaging excludes only voice and records the exact upstream projection', context => {
  const fixture = packagingFixture(context)
  const original = fs.readFileSync(fixture.receiptPath)
  const projection = stageVendoredCodex(fixture.runtime, fixture.destination, 'darwin')
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.destination, 'resolve-receipt.json')))
  const excluded = fixture.receipt.files.filter(file => file.path.startsWith('codex-resources/voice/'))
  assert.equal(fs.existsSync(path.join(fixture.destination, 'codex-resources/voice')), false)
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'codex-resources/voice-other/keep.bin'), 'utf8'), 'unrelated resource')
  assert.deepEqual(receipt.files, fixture.receipt.files.filter(file => !excluded.includes(file)))
  assert.equal(receipt.archive_sha256, fixture.receipt.archive_sha256)
  assert.equal(receipt.entrypoint, fixture.receipt.entrypoint)
  assert.deepEqual(receipt.packaging, projection)
  assert.equal(projection.source_receipt_sha256, crypto.createHash('sha256').update(original).digest('hex'))
  assert.deepEqual(projection.excluded_files.map(({ bytes, ...file }) => file), excluded)
  for (const file of projection.excluded_files) assert.equal(file.bytes, fs.statSync(path.join(fixture.source, file.path)).size)
  for (const file of receipt.files) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture.destination, file.path))).digest('hex'), file.sha256)
  }
  assert.deepEqual(fs.readFileSync(fixture.receiptPath), original)
  assert.equal(fs.readFileSync(path.join(fixture.source, excluded[0].path), 'utf8'), 'voice executable')
})

test('Windows packaging retains the full payload and byte-identical receipt', context => {
  const fixture = packagingFixture(context)
  assert.equal(stageVendoredCodex(fixture.runtime, fixture.destination, 'win32'), null)
  assert.deepEqual(fs.readFileSync(path.join(fixture.destination, 'resolve-receipt.json')), fs.readFileSync(fixture.receiptPath))
  for (const file of fixture.receipt.files) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.destination, file.path)), fs.readFileSync(path.join(fixture.source, file.path)))
  }
})

test('packaging rejects changed retained or excluded files and unrecorded inputs', context => {
  for (const relative of ['bin/codex', 'codex-resources/voice/bin/codex-voice-host', 'unexpected']) {
    const fixture = packagingFixture(context)
    fs.writeFileSync(path.join(fixture.source, relative), 'changed')
    assert.throws(() => stageVendoredCodex(fixture.runtime, fixture.destination, 'darwin'), /inventory changed/)
    assert.equal(fs.existsSync(fixture.destination), false)
  }
})

test('packaging refuses redirected files and unrelated existing destinations', context => {
  const fixture = packagingFixture(context)
  fs.mkdirSync(fixture.destination)
  fs.writeFileSync(path.join(fixture.destination, 'user-file'), 'preserve')
  assert.throws(() => stageVendoredCodex(fixture.runtime, fixture.destination, 'darwin'), /destination/)
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'user-file'), 'utf8'), 'preserve')
  fs.rmSync(fixture.destination, { recursive: true })
  fs.unlinkSync(path.join(fixture.source, 'bin/codex'))
  fs.symlinkSync(process.execPath, path.join(fixture.source, 'bin/codex'))
  assert.throws(() => stageVendoredCodex(fixture.runtime, fixture.destination, 'darwin'), /invalid build state/)
})

test('packaging is bound to the frozen source receipt and supported platform', context => {
  const fixture = packagingFixture(context)
  assert.throws(() => stageVendoredCodex({ ...fixture.runtime, source: { ...fixture.runtime.source, archive_sha256: 'b'.repeat(64) } }, fixture.destination, 'darwin'), /receipt/)
  assert.throws(() => stageVendoredCodex(fixture.runtime, fixture.destination, 'linux'), /platform/)
  assert.equal(fs.existsSync(fixture.destination), false)
})

test('excluding voice never bypasses the floor for an unrelated real Mach-O', { skip: process.platform !== 'darwin' }, context => {
  const fixture = packagingFixture(context)
  const source = path.join(fixture.root, 'probe.c')
  const binary = path.join(fixture.source, 'unrelated-high.o')
  fs.writeFileSync(source, 'int gate_probe(void) { return 0; }\n')
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch
  execFileSync('/usr/bin/clang', ['-target', `${architecture}-apple-macos14.0`, '-c', source, '-o', binary])
  fixture.receipt.files.push({ path: 'unrelated-high.o', mode: 0o755,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') })
  fs.writeFileSync(fixture.receiptPath, JSON.stringify(fixture.receipt))
  stageVendoredCodex(fixture.runtime, fixture.destination, 'darwin')
  assert.throws(() => verifyMacOSTree(fixture.destination), /unrelated-high.o requires macOS 14/)
})

test('Windows Codex component version follows the official vendored release', () => {
  const bindings = JSON.parse(fs.readFileSync(path.join(__dirname, 'versions.json'), 'utf8'))
  const vendored = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/vendor/codex/manifest.json'), 'utf8'))
  const version = bindings.components.codex.version
  const revision = /^(.*)-r([1-9][0-9]*)$/.exec(version)
  assert.ok(revision, 'Codex component must have a reviewed positive revision')
  assert.equal(revision[1], vendored.artifacts['win32-x64'].version ?? vendored.version,
    'review CI component-version-observed.json when upgrading official Codex')
})

function cacheFixture({ platform = process.platform, arch = process.arch, reviewedArchive = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-contract-')))
  const desktop = path.join(root, 'apps', 'desktop')
  const vendor = path.join(root, 'scripts', 'vendor', 'codex')
  fs.mkdirSync(desktop, { recursive: true })
  fs.mkdirSync(vendor, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/vendor/codex/manifest.json')))
  const key = `${platform}-${arch}`
  const selected = manifest.artifacts[key]
  const version = selected.version ?? manifest.version
  const entrypoint = 'bin/codex'
  const contents = { [entrypoint]: 'not an executable' }
  const archive = path.join(vendor, selected.file)
  if (reviewedArchive) {
    contents[entrypoint] = '#!/bin/sh\nprintf "probe\\n" >> "$CODEX_TEST_PROBE_FILE"\nprintf "codex-cli ' + version + '\\n"\n'
    contents['codex-package.json'] = JSON.stringify({ target: selected.target, entrypoint })
    const prefix = `package/vendor/${selected.target}/`
    for (const [name, content] of Object.entries(contents)) {
      const member = path.join(root, prefix, name)
      fs.mkdirSync(path.dirname(member), { recursive: true })
      fs.writeFileSync(member, content)
    }
    execFileSync(nativeTar(), ['-czf', archive, '-C', root, ...Object.keys(contents).map(name => prefix + name)])
  } else {
    fs.writeFileSync(archive, 'invalid archive, contract fixture only')
  }
  const bytes = fs.readFileSync(archive)
  selected.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  selected.integrity = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64')
  selected.bytes = bytes.length
  selected.url = 'http://127.0.0.1:1/unavailable'
  const cache = ensurePrivateDirectory(path.join(root, 'cache'))
  const directory = path.join(cache, `${version}-${key}-${selected.sha256}`)
  const executable = path.join(directory, entrypoint)
  const files = Object.entries(contents).map(([name, content]) => {
    const filename = path.join(directory, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, content, { mode: 0o755 })
    return { path: name, sha256: crypto.createHash('sha256').update(content).digest('hex'), mode: 0o755 }
  })
  const receipt = { archive_sha256: selected.sha256, reported_version: version, entrypoint, files }
  const receiptBytes = JSON.stringify(receipt)
  fs.writeFileSync(path.join(directory, 'resolve-receipt.json'), receiptBytes)
  if (platform === 'darwin') selected.receiptSha256 = crypto.createHash('sha256').update(receiptBytes).digest('hex')
  const manifestFile = path.join(vendor, 'manifest.json')
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  const previous = process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE
  process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE = cache
  const dispose = () => {
    if (previous === undefined) delete process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE
    else process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, desktop, directory, executable, archive, manifestFile, selected, dispose }
}

function runFixtureRegistry() {
  const fs = require('node:fs')
  const path = require('node:path')
  const [state, operation, ...args] = process.argv.slice(2)
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]))
  const directory = options['--root']
  if (args.length !== 6 || !path.isAbsolute(directory) ||
      !['darwin-arm64', 'darwin-x86_64'].includes(options['--target']) || !/^[a-f0-9]{64}$/.test(options['--key'])) {
    throw new Error('invalid Codex registry invocation')
  }
  fs.appendFileSync(path.join(state, 'calls'), JSON.stringify({ operation, ...options }) + '\n')
  if (fs.existsSync(path.join(state, 'fail-' + operation))) process.exit(9)
  const shared = path.join(state, 'shared')
  if (operation === 'fetch') {
    if (!fs.existsSync(shared)) process.exit(3)
    fs.cpSync(shared, directory, { recursive: true })
  } else if (operation === 'publish') {
    if (fs.existsSync(path.join(state, 'delay-publish'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    fs.cpSync(directory, shared, { recursive: true })
  } else throw new Error('unknown operation')
}

function registryFixture(context, { platform = 'darwin', arch = 'arm64' } = {}) {
  const fixture = cacheFixture({ platform, arch, reviewedArchive: true })
  const script = path.join(fixture.root, 'registry.cjs')
  fs.writeFileSync(script, '(' + runFixtureRegistry.toString() + ')()')
  const probe = path.join(fixture.root, 'probe')
  const environment = {
    CODEX_TEST_PROBE_FILE: probe,
    SCHOLARSEED_ARTIFACT_CACHE: path.join(fixture.root, 'artifacts'),
    SCHOLARSEED_CODEX_REGISTRY_COMMAND: JSON.stringify([process.execPath, script, fixture.root]),
    SCHOLARSEED_CODEX_REGISTRY_SCOPE: 'a'.repeat(64),
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fixture.dispose()
  })
  const callsPath = path.join(fixture.root, 'calls')
  const calls = () => fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const resolve = validation => resolveVendoredCodex(fixture.desktop, platform, arch, () => {}, validation)
  return { ...fixture, probe, calls, resolve, shared: path.join(fixture.root, 'shared') }
}

test('macOS Codex pins require a lowercase SHA-256 string for each architecture', () => {
  for (const arch of ['arm64', 'x64']) {
    const fixture = cacheFixture({ platform: 'darwin', arch })
    try {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestFile))
      assert.equal(artifact(fixture.desktop, 'darwin', arch).receiptSha256, fixture.selected.receiptSha256)
      for (const invalid of [undefined, 'a'.repeat(63), 'A'.repeat(64), [fixture.selected.receiptSha256]]) {
        manifest.artifacts['darwin-' + arch].receiptSha256 = invalid
        fs.writeFileSync(fixture.manifestFile, JSON.stringify(manifest))
        assert.throws(() => artifact(fixture.desktop, 'darwin', arch))
      }
    } finally { fixture.dispose() }
  }
})

test('macOS backfills a warm Codex cache, retries failed publication and confirms each scope once', async context => {
  const fixture = registryFixture(context, { arch: 'x64' })
  const failure = path.join(fixture.root, 'fail-publish')
  fs.writeFileSync(failure, '')
  await assert.rejects(fixture.resolve(CACHE_VALIDATION.integrity))
  assert.deepEqual(fixture.calls().map(call => call.operation), ['publish'])
  fs.unlinkSync(failure)
  fs.unlinkSync(fixture.archive)
  await fixture.resolve(CACHE_VALIDATION.integrity)
  await fixture.resolve(CACHE_VALIDATION.integrity)
  assert.deepEqual(fixture.calls().map(call => call.operation), ['publish', 'publish'])
  process.env.SCHOLARSEED_CODEX_REGISTRY_SCOPE = 'b'.repeat(64)
  await fixture.resolve(CACHE_VALIDATION.integrity)
  await fixture.resolve(CACHE_VALIDATION.integrity)
  const calls = fixture.calls()
  assert.deepEqual(calls.map(call => call.operation), ['publish', 'publish', 'publish'])
  for (const call of calls) {
    assert.equal(call['--target'], 'darwin-x86_64')
    assert.equal(call['--key'], fixture.selected.receiptSha256)
  }
})

test('macOS restores a pinned Codex tree on a fresh runner without using the vendor artifact', {
  skip: process.platform === 'win32',
}, async context => {
  const fixture = registryFixture(context)
  fs.renameSync(fixture.directory, fixture.shared)
  fs.unlinkSync(fixture.archive)
  const fetch = context.mock.method(globalThis, 'fetch', () => assert.fail('unexpected vendor fetch'))
  const resolved = await fixture.resolve()
  assert.equal(resolved.path, fixture.executable)
  assert.equal(resolved.reported_version, REVIEWED_CODEX_VERSION)
  assert.equal(fs.readFileSync(fixture.probe, 'utf8'), 'probe\n')
  fs.writeFileSync(path.join(fixture.root, 'fail-fetch'), '')
  await fixture.resolve(CACHE_VALIDATION.integrity)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(fixture.calls().map(call => [call.operation, call['--target'], call['--key']]),
    [['fetch', 'darwin-arm64', fixture.selected.receiptSha256]])
})

test('macOS rejects modified shared Codex bytes and forged receipts before executing or using the vendor', async context => {
  for (const forgeReceipt of [false, true]) {
    await context.test(forgeReceipt ? 'self-consistent forged receipt' : 'modified executable', async sub => {
      const fixture = registryFixture(sub)
      fs.renameSync(fixture.directory, fixture.shared)
      const executable = path.join(fixture.shared, 'bin/codex')
      fs.appendFileSync(executable, '\n# modified\n')
      if (forgeReceipt) {
        const receiptPath = path.join(fixture.shared, 'resolve-receipt.json')
        const receipt = JSON.parse(fs.readFileSync(receiptPath))
        receipt.files.find(file => file.path === receipt.entrypoint).sha256 =
          crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
        fs.writeFileSync(receiptPath, JSON.stringify(receipt))
      }
      await assert.rejects(fixture.resolve())
      assert.equal(fs.existsSync(fixture.probe), false)
      assert.equal(fs.existsSync(fixture.directory), false)
      assert.deepEqual(fixture.calls().map(call => call.operation), ['fetch'])
    })
  }
})

test('macOS takes the vendor path only after an explicit registry miss', { skip: process.platform === 'win32' }, async context => {
  const fixture = registryFixture(context)
  fs.rmSync(fixture.directory, { recursive: true })
  const failure = path.join(fixture.root, 'fail-fetch')
  fs.writeFileSync(failure, '')
  await assert.rejects(fixture.resolve())
  assert.deepEqual(fixture.calls().map(call => call.operation), ['fetch'])
  assert.equal(fs.existsSync(fixture.probe), false)
  fs.unlinkSync(failure)
  await fixture.resolve()
  await fixture.resolve(CACHE_VALIDATION.integrity)
  assert.deepEqual(fixture.calls().map(call => call.operation), ['fetch', 'fetch', 'publish'])
  assert.equal(fs.readFileSync(fixture.probe, 'utf8'), 'probe\n')
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(
    path.join(fixture.shared, 'resolve-receipt.json'))).digest('hex'), fixture.selected.receiptSha256)
})

test('a different reviewed receipt blocks a cold archive before its first executable probe', async context => {
  const fixture = registryFixture(context)
  fs.rmSync(fixture.directory, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestFile))
  manifest.artifacts['darwin-arm64'].receiptSha256 = 'f'.repeat(64)
  fs.writeFileSync(fixture.manifestFile, JSON.stringify(manifest))
  await assert.rejects(fixture.resolve(), /receipt/i)
  assert.equal(fs.existsSync(fixture.probe), false)
  assert.equal(fs.existsSync(path.join(fixture.directory, 'resolve-receipt.json')), false)
  assert.deepEqual(fixture.calls().map(call => call.operation), ['fetch'])
})


test('separate resolver processes backfill the shared Codex cache once', async context => {
  const fixture = registryFixture(context)
  fs.writeFileSync(path.join(fixture.root, 'delay-publish'), '')
  const run = require('node:util').promisify(require('node:child_process').execFile)
  const code = `const {resolveVendoredCodex, CACHE_VALIDATION} = require(process.argv[1])
    resolveVendoredCodex(process.argv[2], 'darwin', 'arm64', () => {}, CACHE_VALIDATION.integrity)
      .catch(error => {console.error(error); process.exitCode = 1})`
  const args = ['-e', code, require.resolve('./codex.cjs'), fixture.desktop]
  await Promise.all([run(process.execPath, args), run(process.execPath, args)])
  assert.deepEqual(fixture.calls().map(call => call.operation), ['publish'])
})

test('Windows resolves its Codex runtime without invoking a configured macOS registry', async context => {
  const fixture = registryFixture(context, { platform: 'win32', arch: 'x64' })
  const resolved = await fixture.resolve(CACHE_VALIDATION.integrity)
  assert.equal(resolved.path, fixture.executable)
  assert.deepEqual(fixture.calls(), [])
})


test('launch cache validation verifies inventory without executing; default still executes', async () => {
  const fixture = cacheFixture()
  try {
    const release = await resolveVendoredCodex(
      fixture.desktop, process.platform, process.arch, () => {}, CACHE_VALIDATION.integrity)
    assert.equal(release.path, fixture.executable)
    await assert.rejects(resolveVendoredCodex(fixture.desktop))
  } finally {
    fixture.dispose()
  }
})

test('launch cache verification refuses changed bytes, extra files and linked inventory', async () => {
  for (const mutation of [
    fixture => fs.appendFileSync(fixture.executable, 'changed'),
    fixture => fs.writeFileSync(path.join(fixture.directory, 'extra'), 'extra'),
    fixture => {
      fs.renameSync(fixture.executable, fixture.executable + '-target')
      fs.symlinkSync(fixture.executable + '-target', fixture.executable)
    },
    fixture => {
      const receipt = path.join(fixture.directory, 'resolve-receipt.json')
      const content = JSON.parse(fs.readFileSync(receipt))
      content.reported_version = '0.0.0'
      fs.writeFileSync(receipt, JSON.stringify(content))
    },
  ]) {
    const fixture = cacheFixture()
    try {
      mutation(fixture)
      await assert.rejects(resolveVendoredCodex(
        fixture.desktop, process.platform, process.arch, () => {}, CACHE_VALIDATION.integrity))
    } finally {
      fixture.dispose()
    }
  }
})

test('Windows publication retries transient locks with a bounded budget', async () => {
  const delays = []
  let attempts = 0
  await publishRuntime('source', 'destination', {
    platform: 'win32',
    rename: () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    },
    delay: async milliseconds => delays.push(milliseconds)
  })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [250, 500])
  attempts = 0
  await assert.rejects(publishRuntime('source', 'destination', {
    platform: 'win32',
    rename: () => {
      attempts += 1
      throw Object.assign(new Error('locked'), { code: 'EPERM' })
    },
    delay: async () => {}
  }), /locked/)
  assert.equal(attempts, 7)
})

test('publication preserves permanent errors and macOS immediate failure', async () => {
  for (const [platform, code] of [['darwin', 'EBUSY'], ['win32', 'ENOENT']]) {
    await assert.rejects(publishRuntime('source', 'destination', {
      platform,
      rename: () => { throw Object.assign(new Error('denied'), { code }) },
      delay: async () => assert.fail('must not retry')
    }), /denied/)
  }
})

test('runtime verification precedes publication and execution only follows publication', () => {
  const source = fs.readFileSync(path.join(__dirname, 'codex.cjs'), 'utf8')
  const publication = source.indexOf('await publishRuntime(runtime, directory, { platform })')
  const verification = source.indexOf('await digest(cached,')
  const completion = source.indexOf('await completeRuntime(directory, selected,')
  assert.ok(verification > 0 && verification < publication && publication < completion)
  assert.ok(!source.includes('spawnSync(executable,'))
})

test('published runtime is verified and probed at its final path before readiness', async () => {
  const fixture = cacheFixture()
  const receiptPath = path.join(fixture.directory, 'resolve-receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath))
  fs.unlinkSync(receiptPath)
  try {
    let probes = 0
    await completeRuntime(fixture.directory,
      { sha256: receipt.archive_sha256, version: receipt.reported_version }, receipt, {
        probe: async (executable, version) => {
          probes += 1
          assert.equal(executable, fixture.executable)
          assert.equal(version, receipt.reported_version)
          assert.equal(fs.existsSync(receiptPath), false)
        }
      })
    assert.equal(probes, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath)), receipt)
  } finally {
    fixture.dispose()
  }
})

test('failed final-path probes and changed inventories never receive a readiness receipt', async () => {
  for (const failure of ['probe', 'before-probe', 'during-probe']) {
    const fixture = cacheFixture()
    const receiptPath = path.join(fixture.directory, 'resolve-receipt.json')
    const receipt = JSON.parse(fs.readFileSync(receiptPath))
    fs.unlinkSync(receiptPath)
    if (failure === 'before-probe') fs.appendFileSync(fixture.executable, 'changed')
    try {
      let probes = 0
      await assert.rejects(completeRuntime(fixture.directory,
        { sha256: receipt.archive_sha256, version: receipt.reported_version }, receipt, {
          probe: async () => {
            probes += 1
            if (failure === 'probe') throw new Error('probe failed')
            fs.appendFileSync(fixture.executable, 'changed')
          }
        }), failure === 'probe' ? /probe failed/ : /inventory changed/)
      assert.equal(probes, failure === 'before-probe' ? 0 : 1)
      assert.equal(fs.existsSync(receiptPath), false)
    } finally {
      fixture.dispose()
    }
  }
})

test('vendored manifest selects only reviewed platforms', () => {
  const desktop = path.resolve(__dirname, '..')
  const mac = artifact(desktop, 'darwin', 'arm64')
  const intelMac = artifact(desktop, 'darwin', 'x64')
  const windows = artifact(desktop, 'win32', 'x64')
  assert.equal(mac.target, 'aarch64-apple-darwin')
  assert.equal(intelMac.target, 'x86_64-apple-darwin')
  assert.equal(windows.target, 'x86_64-pc-windows-msvc')
  for (const selected of [mac, intelMac, windows]) {
    const expected = selected.key === 'win32-x64' ? REVIEWED_WINDOWS_CODEX_VERSION : REVIEWED_CODEX_VERSION
    assert.equal(selected.version, expected)
    assert.equal(selected.file, `codex-${expected}-${selected.key}.tgz`)
    assert.ok(selected.url.endsWith(`/${selected.file}`))
    assert.match(selected.url, /^https:\/\//)
    assert.match(selected.sha256, /^[a-f0-9]{64}$/)
    assert.ok(selected.bytes > 0)
    if (selected !== windows) assert.match(selected.receiptSha256, /^[a-f0-9]{64}$/)
  }
  assert.throws(() => artifact(desktop, 'win32', 'arm64'), /Unsupported/)
})

test('archive integrity is checked again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-contract-'))
  try {
    const archive = path.join(root, 'archive')
    fs.writeFileSync(archive, 'original')
    const integrity = `sha512-${crypto.createHash('sha512').update('original').digest('base64')}`
    await verifyArchive(archive, integrity)
    fs.writeFileSync(archive, 'modified')
    await assert.rejects(() => verifyArchive(archive, integrity), /integrity mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('installed selection has no external fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-installed-contract-'))
  try {
    assert.throws(() => bundledCodex(root), /ENOENT/)
    const bin = path.join(root, 'backend/codex-runtime/bin')
    fs.mkdirSync(bin, { recursive: true })
    const entry = process.platform === 'win32' ? 'codex.exe' : 'codex'
    fs.writeFileSync(path.join(bin, entry), 'fixture', { mode: 0o700 })
    assert.equal(bundledCodex(root), path.join(bin, entry))
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('Intel macOS runtime probe tolerates Rosetta bootstrap latency', {
  skip: process.env.SCHOLARSEED_NATIVE_MATRIX !== '1' || process.platform !== 'darwin'
}, async () => {
  const desktop = path.resolve(__dirname, '..')
  const runtime = await resolveVendoredCodex(desktop, 'darwin', 'x64')
  assert.equal(runtime.reported_version, REVIEWED_CODEX_VERSION)
})

// Uses the reviewed native executable, never a fake version command.
test('persistent runtime survives checkout replacement and rejects changed bytes', {
  skip: process.env.SCHOLARSEED_NATIVE_MATRIX !== '1'
}, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persistent-')))
  const previous = process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE
  process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE = path.join(root, 'cache')
  try {
    const messages = []
    const source = path.resolve(__dirname, '..')
    const coldStarted = Date.now()
    const first = await resolveVendoredCodex(source, process.platform, process.arch, line => { messages.push(line); console.log(line) })
    console.log(`cold runtime: ${Date.now() - coldStarted}ms`)
    const desktop = path.join(root, 'checkout', 'apps', 'desktop')
    const vendor = path.join(root, 'checkout', 'scripts', 'vendor', 'codex')
    fs.mkdirSync(desktop, { recursive: true })
    fs.mkdirSync(vendor, { recursive: true })
    fs.copyFileSync(path.join(source, '../../scripts/vendor/codex/manifest.json'), path.join(vendor, 'manifest.json'))
    const hitStarted = Date.now()
    const second = await resolveVendoredCodex(desktop, process.platform, process.arch, line => { messages.push(line); console.log(line) })
    console.log(`cross-checkout hit: ${Date.now() - hitStarted}ms`)
    assert.equal(second.path, first.path)
    assert.match(messages.at(-1), /\(cached\)/)
    fs.appendFileSync(second.path, 'changed')
    fs.writeFileSync(path.join(second.root, 'unexpected.dll'), 'unexpected')
    const third = await resolveVendoredCodex(desktop, process.platform, process.arch, line => { messages.push(line); console.log(line) })
    assert.equal(third.sha256, first.sha256)
    assert.equal(fs.existsSync(path.join(third.root, 'unexpected.dll')), false)
    assert.doesNotMatch(messages.at(-1), /\(cached\)/)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(third.path)).digest('hex'), first.sha256)
  } catch (error) {
    console.error('native cache validation failed:', error)
    throw error
  } finally {
    if (previous === undefined) delete process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE
    else process.env.SCHOLARSEED_CODEX_RUNTIME_CACHE = previous
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 })
  }
})

const REVIEWED_WINDOWS_CODEX_VERSION = '0.171.0'

test('platform pins use the same reviewed Codex version', () => {
  const desktop = path.resolve(__dirname, '..')
  assert.equal(artifact(desktop, 'darwin', 'arm64').version, REVIEWED_CODEX_VERSION)
  assert.equal(artifact(desktop, 'darwin', 'x64').version, REVIEWED_CODEX_VERSION)
  assert.equal(artifact(desktop, 'win32', 'x64').version, REVIEWED_WINDOWS_CODEX_VERSION)
})
