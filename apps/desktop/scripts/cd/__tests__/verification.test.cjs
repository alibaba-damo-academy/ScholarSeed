// Build-hook contracts; not native signed-package acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')
const { hostArch } = require('../../shared/target.cjs')
const { removeTemporary } = require('../../shared/temporary-cleanup.cjs')

const source = fs.readFileSync(path.join(__dirname, '../verify.cjs'), 'utf8')
const content = source.slice(source.indexOf('async function verifyContent('), source.indexOf('\n/** Static checks'))
const hook = source.slice(source.indexOf('async function verify(builderContext)'), source.indexOf('\nmodule.exports = verify'))

for (const scenario of ['distribution', 'resource fork', 'local', 'oversized legacy ZIP']) {
  test(`macOS installer hook measures its update archives: ${scenario}`, {skip: process.platform !== 'darwin'}, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-compression-'))
    t.after(() => removeTemporary(directory))
    const app = path.join(directory, 'ScholarSeed.app')
    const installer = path.join(directory, 'ScholarSeed.dmg')
    fs.mkdirSync(app)
    fs.writeFileSync(path.join(app, 'payload'), Buffer.alloc(128 * 1024, 'abc'))
    const hasFork = scenario === 'resource fork'
    if (hasFork) fs.writeFileSync(path.join(app, 'payload', '..namedfork', 'rsrc'), 'fork')
    fs.writeFileSync(installer, 'fixture')
    fs.writeFileSync(path.join(directory, 'app.json'), JSON.stringify({path: app}))
    const lane = scenario === 'local' ? 'local' : 'distribution'
    const frozen = {
      platform: 'darwin', arch: hostArch(), installer: 'dmg', stage: 'dmg', productName: 'ScholarSeed',
      runDirectory: directory, signingRequired: lane === 'distribution', lane,
    }
    const packed = []
    let publishedSize
    const nativeRequire = createRequire(require.resolve('../verify.cjs'))
    const verify = runInNewContext(`${source}
      context = () => frozen
      command = runCommand
      verifyApplication = async () => ({signature_valid: true, trust: {stapled: true}})
      verify`, {
      module: {exports: {}}, __dirname: path.dirname(require.resolve('../verify.cjs')), process, frozen,
      require: name => name === './dmg.cjs' ? {
        verifyImage: async (_image, mounted, context, check) => ({
          checked: await check(mounted, context, true), installed_check: {},
        }),
      } : nativeRequire(name),
      runCommand(executable, args) {
        if (executable === 'hdiutil') return
        if (executable === path.join(app, 'Contents/Resources/backend/python/bin/python3')) {
          const python = developmentPython(path.resolve(__dirname, '../../../../..'), process.env.VENV)
          execFileSync(python, args)
          publishedSize = fs.statSync(args.at(-1)).size
          return
        }
        const result = execFileSync(executable, args, {encoding: 'utf8'}).trim()
        if (args[0] !== '-c') return result
        const level = Number(args[args.indexOf('--zlibCompressionLevel') + 1])
        const archive = args.at(-1)
        if (scenario === 'oversized legacy ZIP' && level === 1) fs.truncateSync(archive, 1024 ** 3)
        packed.push({level, resourceMode: args.find(arg => ['--norsrc', '--sequesterRsrc'].includes(arg)), size: fs.statSync(archive).size})
      },
    })
    const verifying = verify({artifactPaths: [installer]})
    if (scenario === 'oversized legacy ZIP') {
      await assert.rejects(verifying, /smaller than 1 GiB/)
      assert.deepEqual(packed.map(x => x.level), [1])
      assert.ok(!fs.existsSync(path.join(directory, 'installer.json')))
      return
    }
    await verifying
    const read = name => JSON.parse(fs.readFileSync(path.join(directory, name)))
    if (lane === 'local') {
      assert.deepEqual(packed, [])
      assert.ok(!fs.existsSync(path.join(directory, 'scholarseed-update.zip')))
      assert.ok(!fs.existsSync(path.join(directory, 'macos-update-zip.json')))
      return
    }
    assert.deepEqual(packed.map(x => x.level), [1, 6])
    assert.deepEqual(packed.map(x => x.resourceMode), ['--sequesterRsrc', hasFork ? '--sequesterRsrc' : '--norsrc'])
    assert.equal(read('installer.json').installed_check.update_archive.size, packed[0].size)
    const zip = read('macos-update-zip.json')
    const bytes = fs.readFileSync(path.join(directory, 'scholarseed-update.zip'))
    assert.ok(packed[1].size < packed[0].size)
    assert.equal(zip.archive_budget.size, publishedSize)
    assert.equal(zip.size, bytes.length)
    assert.equal(zip.size, publishedSize)
    for (const hash of ['sha256', 'sha512'])
      assert.equal(zip[hash], createHash(hash).update(bytes).digest('hex'))
  })
}

test('signed Velopack receipt failure preserves the primary failure and cleans retired sandboxes', async () => {
  const mainError = new Error('installed application check failed')
  const receiptError = new Error('registry readback failed')
  for (const primaryFails of [true, false]) {
    const removed = []
    const diagnostics = []
    const directories = ['/install', '/runtime']
    const body = source.slice(source.indexOf('async function verifyVelopackInstaller('), source.indexOf('async function verify(builderContext)'))
    const verifyInstaller = runInNewContext(`${body}\nverifyVelopackInstaller`, {
      path, process, fs: { mkdirSync() {}, statSync: () => ({ size: 1 }) }, CHECK_TIMEOUT_MS: 1000,
      acceptance: { withVerificationMutex: action => action() },
      assertCleanInstallation() {},
      createPackageCheckDirectory: () => directories.shift(),
      packageCheckEnvironment: () => ({ APPDATA: '/roaming', LOCALAPPDATA: '/local' }),
      recordCiInstallation() {}, runInstaller() {},
      verifyApplication: async () => { if (primaryFails) throw mainError },
      buildState: { hashFile: () => 'hash' }, verifyWindowsSignature: () => true,
      runPackageCheck: async () => ({}), layout: () => ({}), verifyComponentContent: async () => ({}),
      runtimeReuseEvidence: () => ({}), sha256: async () => 'hash', sha512: async () => 'hash',
      retireVelopack: async () => ({ complete: true }),
      completeCiInstallation: () => { throw receiptError },
      removeTemporary: directory => removed.push(directory),
      bestEffortRemoveTemporary: directory => removed.push(directory),
      console: { error: message => diagnostics.push(message) },
    })
    await assert.rejects(verifyInstaller('/setup.exe', {
      platform: 'win32', updateEngine: 'velopack', appId: 'scholarseed',
      runDirectory: '/out', signingRequired: true, product: { config: {} },
      launcher: { uninstaller: { file: 'Update.exe', sha256: 'hash' } },
    }), error => error === (primaryFails ? mainError : receiptError))
    assert.deepEqual(removed, ['/runtime', '/install'])
    assert.ok(diagnostics.some(message => message.includes(receiptError.message)))
  }
})

function fixture(platform = 'darwin', signingRequired = true, allowExecution = false) {
  const events = []
  const files = { bridgeChecks: [], closures: [], nativeDirectories: [] }
  let changed = false
  let incompatible = false
  let retiredOffice = false
  let residualAsar = false
  const frozen = { platform, signingRequired, productName: 'ScholarSeed', runDirectory: '/build',
    native: {}, closure: {}, notices: {}, browser: {}, config: { sha256: 'digest' },
    product: { sha256: 'digest', config: {} },
    binaries: { codex: { sha256: 'digest' }, rg: { sha256: 'digest', executable_sha256: 'digest' } },
    texlive: { executables: [], reported: [] },
    pythonDependencies: { requirements_sha256: 'digest', inventory_sha256: 'digest', verifier_sha256: 'digest', bytecode: {} },
  }
  const current = { resources: '/app/resources', executable: '/app/main', python: '/app/python',
    codex: '/app/codex', rg: '/app/rg', skillPython: '/app/skill-python' }
  const probe = name => { events.push(name); if (!allowExecution) throw new Error(`premature runtime: ${name}`) }
  const sandbox = {
    path, process, fs: { constants: fs.constants, accessSync() {}, existsSync: () => retiredOffice },
    context: () => frozen, layout: () => current, verifyIdentity() {},
    unsignedPackageCheck: () => false,
    verifyExecution: async () => probe('first-execution'),
    shipit: { verify: async () => events.push('shipit') },
    verifyNotices() {},
    APPLICATION_LAYOUT: { asar: 'asar', directory: 'directory' },
    applicationLayout: (resources, format) => ({
      nativeDirectory: path.join(resources, format === 'directory' ? 'app' : 'app.asar.unpacked', 'out', 'main'),
    }),
    assertBridgeApplication(application) {
      files.bridgeChecks.push(application)
      if (residualAsar) throw new Error('bridge contains an ASAR')
    },
    verifyAsarClosure() { files.closures.push('asar'); return { asar_bytes: 1 } },
    verifyDirectoryClosure() { files.closures.push('directory'); return {} },
    readNative(_directory, _frozen, libraries) { files.nativeDirectories.push(libraries) },
    verifyMacOSTree: () => {
      events.push('macos')
      if (incompatible) throw new Error('payload requires macOS 14.0')
      return {minimum: '13.0', files: []}
    },
    inspectBrowser: async (_root, _browser, signed) => { events.push(`inventory:${signed}`); return {} },
    verifyBrowser: async () => probe('browser'),
    sha256: async () => changed ? 'changed' : 'digest', executableDigest: async () => 'digest',
    stagedEngines: () => ['/app/tex'], probeTexlive: async () => { probe('tex'); return [] },
    command: () => { probe('python'); return '{}' }, verifyPython: () => probe('python-identity'),
    inspectBytecode: () => { probe('bytecode'); return {} }, verifySignedRuntime() {},
    REQUIREMENTS_FILENAME: 'requirements', INVENTORY_FILENAME: 'inventory', VERIFIER_FILENAME: 'verifier',
    RUNTIME_PROBE_SCRIPT: '', atomicJSON: (_filename, value) => events.push(value),
    readHandoff() {}, readLauncher() {},
    verifyComponentArchives: async () => { events.push('components'); return {current, imports: null, browser: null, closure: {}} },
  }
  const functions = runInNewContext(`${content}\n${hook}\n({verifyContent, verify})`, sandbox)
  return { ...functions, frozen, events, files,
    change: () => { changed = true },
    rejectMinimum: () => { incompatible = true },
    includeRetiredOffice: () => { retiredOffice = true },
    includeResidualAsar: () => { residualAsar = true },
  }
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform} packaging rejects stale Office resources before runtime execution`, async () => {
    const f = fixture(platform)
    f.includeRetiredOffice()
    await assert.rejects(f.verifyContent('/app', f.frozen), /retired Office runtime/)
    assert.ok(!f.events.includes('first-execution'))
  })
}

test('afterPack rejects an incompatible native payload before any runtime execution', async () => {
  const f = fixture()
  f.rejectMinimum()
  await assert.rejects(f.verify({appOutDir: '/out'}), /requires macOS 14.0/)
  assert.ok(!f.events.includes('first-execution'))
  assert.ok(!f.events.includes('browser'))
})

for (const signingRequired of [true, false]) {
  test(`macOS afterPack validates frozen content without executing runtime (signed lane=${signingRequired})`, async () => {
    const f = fixture('darwin', signingRequired)
    await f.verify({ appOutDir: '/out' })
    assert.ok(f.events.includes('inventory:false'))
    assert.ok(f.events.includes('macos'))
    assert.ok(!f.events.includes('first-execution'))
    const receipt = f.events.at(-1)
    assert.equal(receipt.imports, null)
    assert.equal(receipt.signature_valid, false)
    f.change()
    await assert.rejects(f.verify({ appOutDir: '/out' }), /differ from frozen/)
  })
}

test('final content verification still requires browser execution', async () => {
  const f = fixture()
  await assert.rejects(f.verifyContent('/app', f.frozen, true), /premature runtime: browser/)
})

test('macOS bridge verifies the directory closure and native paths before and after packing', async () => {
  const f = fixture('darwin', true, true)
  f.frozen.applicationLayout = 'directory'
  await f.verify({ appOutDir: '/out' })
  await f.verifyContent('/mounted/ScholarSeed.app', f.frozen, true)
  assert.deepEqual(f.files.bridgeChecks, ['/out/ScholarSeed.app', '/mounted/ScholarSeed.app'])
  assert.deepEqual(f.files.closures, ['directory', 'directory'])
  assert.deepEqual(f.files.nativeDirectories, Array(2).fill(path.join('/app/resources', 'app', 'out', 'main')))
})

test('macOS bridge content verification stops before reading the closure if an ASAR remains', async () => {
  const f = fixture()
  f.frozen.applicationLayout = 'directory'
  f.includeResidualAsar()
  await assert.rejects(f.verify({ appOutDir: '/out' }), /bridge contains an ASAR/)
  assert.deepEqual(f.files.closures, [])
  assert.deepEqual(f.files.nativeDirectories, [])
})

test('Windows afterPack retains component inventory verification', async () => {
  const f = fixture('win32')
  f.frozen.components = {}
  await f.verify({ appOutDir: '/out' })
  assert.ok(f.events.includes('components'))
  assert.ok(!f.events.some(e => typeof e === 'string' && e.startsWith('inventory:')))
  assert.deepEqual(f.files.closures, ['asar'])
  assert.deepEqual(f.files.nativeDirectories, [path.join('/app/resources', 'app.asar.unpacked', 'out', 'main')])
})

for (const signed of [true, false]) {
  test(`final macOS verification preserves every runtime gate (signed=${signed})`, async () => {
    const f = fixture('darwin', signed, true)
    await f.verifyContent('/app', f.frozen, signed)
    assert.deepEqual(f.events.filter(e => !e.startsWith('inventory:')), ['shipit', 'macos', 'browser', 'tex', 'python', 'python-identity', 'python', 'bytecode'])
  })
}

const retirement = source.slice(source.indexOf('function retirementResidue('), source.indexOf('\nasync function retireVelopack('))

function retirementFixture() {
  return runInNewContext(`${retirement}\n({waitForRetirement})`, {
    fs, setTimeout, removeTemporary,
    UNINSTALL_RETIREMENT_TIMEOUT_MS: 120_000,
    UNINSTALL_RETIREMENT_POLL_MS: 20,
    UNINSTALL_RETIREMENT_RECLAIM_MS: 1_000,
    UNINSTALL_RETIREMENT_RECLAIM_INTERVAL_MS: 100,
  })
}

test('retirement passes when the engine removes the install root itself', async () => {
  const { waitForRetirement } = retirementFixture()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-retire-'))
  fs.mkdirSync(path.join(directory, 'current'))
  setTimeout(() => fs.rmSync(directory, {recursive: true, force: true}), 50)
  const result = await waitForRetirement(directory, 5_000)
  assert.equal(result.complete, true)
  assert.equal(result.reclaimedMs, null)
  assert.equal(fs.existsSync(directory), false)
})

test('retirement reclaims a root the engine emptied but could not remove', async () => {
  const { waitForRetirement } = retirementFixture()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-retire-'))
  const result = await waitForRetirement(directory, 200)
  assert.equal(result.complete, true)
  assert.notEqual(result.reclaimedMs, null)
  assert.equal(fs.existsSync(directory), false)
})

test('retirement still fails while files remain in the install root', async () => {
  const { waitForRetirement } = retirementFixture()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-retire-'))
  fs.writeFileSync(path.join(directory, 'Update.exe'), 'residue')
  await assert.rejects(waitForRetirement(directory, 200), error => error.code === 'UNINSTALL_RETIREMENT_TIMEOUT')
  assert.equal(fs.readFileSync(path.join(directory, 'Update.exe'), 'utf8'), 'residue')
  fs.rmSync(directory, {recursive: true, force: true})
})
