// Build-hook contracts; not native signed-package acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { removeTemporary } = require('../../shared/temporary-cleanup.cjs')

const source = fs.readFileSync(path.join(__dirname, '../verify.cjs'), 'utf8')
const content = source.slice(source.indexOf('async function verifyContent('), source.indexOf('\n/** Static checks'))
const hook = source.slice(source.indexOf('async function verify(builderContext)'), source.indexOf('\nmodule.exports = verify'))

function fixture(platform = 'darwin', signingRequired = true, allowExecution = false) {
  const events = []
  let changed = false
  const frozen = { platform, signingRequired, productName: 'ScholarSeed', runDirectory: '/build',
    native: {}, closure: {}, notices: {}, browser: {}, config: { sha256: 'digest' },
    product: { sha256: 'digest', config: {} }, lockSha256: 'digest',
    binaries: { codex: { sha256: 'digest' }, rg: { sha256: 'digest', executable_sha256: 'digest' } },
    texlive: { executables: [], reported: [] },
    pythonDependencies: { requirements_sha256: 'digest', inventory_sha256: 'digest', verifier_sha256: 'digest', bytecode: {} },
  }
  const current = { resources: '/app/resources', executable: '/app/main', python: '/app/python',
    codex: '/app/codex', rg: '/app/rg', skillPython: '/app/skill-python' }
  const probe = name => { events.push(name); if (!allowExecution) throw new Error(`premature runtime: ${name}`) }
  const sandbox = {
    path, process, fs: { constants: fs.constants, accessSync() {} },
    context: () => frozen, layout: () => current, verifyIdentity() {},
    unsignedPackageCheck: () => false,
    verifyExecution: async () => probe('first-execution'),
    shipit: { verify: async () => events.push('shipit') },
    verifyNotices() {}, verifyAsarClosure: () => ({ asar_bytes: 1 }), readNative() {},
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
  return { ...functions, frozen, events, change: () => { changed = true } }
}

for (const signingRequired of [true, false]) {
  test(`macOS afterPack validates frozen content without executing runtime (signed lane=${signingRequired})`, async () => {
    const f = fixture('darwin', signingRequired)
    await f.verify({ appOutDir: '/out' })
    assert.ok(f.events.includes('inventory:false'))
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

test('Windows afterPack retains component inventory verification', async () => {
  const f = fixture('win32')
  f.frozen.components = {}
  await f.verify({ appOutDir: '/out' })
  assert.ok(f.events.includes('components'))
  assert.ok(!f.events.some(e => typeof e === 'string' && e.startsWith('inventory:')))
})

for (const signed of [true, false]) {
  test(`final macOS verification preserves every runtime gate (signed=${signed})`, async () => {
    const f = fixture('darwin', signed, true)
    await f.verifyContent('/app', f.frozen, signed)
    assert.deepEqual(f.events.filter(e => !e.startsWith('inventory:')), ['shipit', 'browser', 'tex', 'python', 'python-identity', 'python', 'bytecode'])
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
