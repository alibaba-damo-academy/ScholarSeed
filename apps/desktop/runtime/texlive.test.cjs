// Contract fixtures only; the real staged toolchain is proved by the packaging
// oracle (skills/community/literature-review/scripts/smoke_publication.py).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const {
  artifact, bundledTexlive, cacheDirectory, publishCache, stagedBinDirectory, stagedEngines,
  vendoredTexliveLocation
} = require('./texlive.cjs')

const DESKTOP = path.resolve(__dirname, '..')
test('execution resources preserve font discovery without granting writable paths', () => {
  const tex = require('./texlive.cjs')
  const options = {
    binDirectory: path.resolve(os.tmpdir(), 'reviewed-tex', 'bin', 'universal-darwin'),
    environment: { HOME: path.resolve(os.tmpdir(), 'font-user') },
    platform: 'darwin', version: '2026', archiveSha256: 'a'.repeat(64)
  }
  const resources = tex.texliveExecutionResources(options)
  assert.deepEqual(Object.keys(resources).sort(), ['archiveSha256', 'fontDirectories', 'version'])
  assert.equal(resources.fontDirectories.length, 6)
  assert.deepEqual(resources.fontDirectories.slice(-3), [
    '/System/Library/Fonts', '/Library/Fonts', path.join(options.environment.HOME, 'Library', 'Fonts')
  ])
  assert.ok(Object.isFrozen(resources))
  assert.ok(Object.isFrozen(resources.fontDirectories))
  options.environment.HOME = '/different-user'
  assert.ok(!resources.fontDirectories.includes('/different-user/Library/Fonts'))
  assert.throws(() => tex.texliveExecutionResources({ ...options, archiveSha256: 'invalid' }))
  assert.throws(() => tex.texliveExecutionResources({ ...options, version: '../2026' }))
  assert.equal(tex.texliveExecutionResources({ ...options, systemFonts: false }).fontDirectories.length, 3)
})
test('cancelled extraction waits for actual subprocess close before cleanup', async () => {
  const child = new EventEmitter()
  const module = { exports: {} }
  const directory = __dirname
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'texlive.cjs'), 'utf8'), {
    module, process, Buffer, __dirname: directory,
    require(name) {
      if (name === 'node:child_process') return {
        spawn(executable, args, options) {
          assert.equal(options.killSignal, 'SIGKILL')
          options.signal.addEventListener('abort', () => child.emit('error', new Error('cancelled')))
          return child
        }
      }
      return require(name.startsWith('.') ? path.join(directory, name) : name)
    }
  })
  const controller = new AbortController()
  const extraction = module.exports.extractArchive('tar', 'archive', 'stage', controller.signal)
  let finished = false
  const result = assert.rejects(extraction, /cancelled/).then(() => { finished = true })
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  child.emit('close', null, 'SIGKILL')
  await result
})
test('TeX location is frozen from the reviewed manifest before cold provisioning', () => {
  const cache = path.join(os.tmpdir(), 'texlive-not-provisioned')
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']]) {
    const selected = artifact(DESKTOP, platform, arch)
    const location = vendoredTexliveLocation(DESKTOP, platform, arch, { SCHOLARSEED_ARTIFACT_CACHE: cache })
    assert.equal(location.binDirectory, path.join(cache, 'texlive', selected.sha256, ...selected.bin_relative.split('/')))
    assert.equal(location.sha256, selected.sha256)
  }
})
test('development cache uses user artifact paths, not checkout depth or platform labels', () => {
  const selected = artifact(DESKTOP, 'darwin', 'arm64')
  const macCache = cacheDirectory(selected, {}, 'darwin')
  const localAppData = path.resolve(os.tmpdir(), 'local')
  const customCache = path.resolve(os.tmpdir(), 'custom-cache')
  assert.equal(macCache, path.join(os.homedir(), '.cache', 'scholarseed', 'artifacts', 'texlive', selected.sha256))
  assert.equal(cacheDirectory(selected, { LOCALAPPDATA: localAppData }, 'win32'),
    path.join(localAppData, 'ScholarSeed', 'cache', 'artifacts', 'texlive', selected.sha256))
  for (const platform of ['darwin', 'win32']) {
    assert.equal(cacheDirectory(selected, { SCHOLARSEED_ARTIFACT_CACHE: customCache }, platform),
      path.join(customCache, 'texlive', selected.sha256))
  }
  assert.notEqual(cacheDirectory({ ...selected, sha256: '0'.repeat(64) }, {}, 'darwin'), macCache)
})

test('concurrent cache publication accepts only the same archive receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-cache-'))
  const destination = path.join(root, 'destination')
  const digest = 'a'.repeat(64)
  try {
    const first = fs.mkdtempSync(path.join(root, 'stage-'))
    fs.writeFileSync(path.join(first, 'archive.sha256'), `${digest}\n`)
    fs.writeFileSync(path.join(first, 'payload'), 'first')
    publishCache(first, destination, digest)
    const second = fs.mkdtempSync(path.join(root, 'stage-'))
    fs.writeFileSync(path.join(second, 'archive.sha256'), `${digest}\n`)
    publishCache(second, destination, digest)
    assert.equal(fs.existsSync(second), false)
    assert.equal(fs.readFileSync(path.join(destination, 'payload'), 'utf8'), 'first')
    for (const receipt of ['different', null]) {
      const stage = fs.mkdtempSync(path.join(root, 'stage-'))
      if (receipt === null) fs.unlinkSync(path.join(destination, 'archive.sha256'))
      else fs.writeFileSync(path.join(destination, 'archive.sha256'), receipt)
      assert.throws(() => publishCache(stage, destination, digest))
      assert.equal(fs.existsSync(stage), true)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('vendored manifest selects platform-specific archives', () => {
  const arm = artifact(DESKTOP, 'darwin', 'arm64')
  const intel = artifact(DESKTOP, 'darwin', 'x64')
  const win = artifact(DESKTOP, 'win32', 'x64')
  assert.equal(arm.texlive, '2026')
  assert.equal(arm.bin_relative, 'texlive/bin/universal-darwin')
  // One archive serves both macOS targets because the binaries are universal,
  // which is what keeps the vendor rule "same release for every architecture".
  assert.equal(arm.archive, intel.archive)
  assert.equal(arm.machine, 'arm64')
  assert.equal(intel.machine, 'x86_64')
  assert.deepEqual(arm.executables, ['xelatex', 'pdflatex', 'bibtex', 'kpsewhich'])
  // Windows has its own archive with platform-specific binaries and .fmt files.
  assert.equal(win.texlive, '2026')
  assert.ok(path.isAbsolute(win.archive))
  assert.equal(path.basename(win.archive), 'texlive-2026-windows-r3.tar.gz')
  assert.equal(win.bin_relative, 'texlive/bin/windows')
  assert.equal(win.machine, 'x86_64')
  assert.deepEqual(win.executables, ['xelatex', 'pdflatex', 'bibtex', 'kpsewhich'])
  for (const selected of [arm, intel, win]) {
    assert.match(selected.url, /^https:\/\//)
    assert.match(selected.sha256, /^[a-f0-9]{64}$/)
    assert.ok(selected.bytes > 0)
  }
  // Linux is not a supported Desktop target.
  assert.throws(() => artifact(DESKTOP, 'linux', 'x64'), /no bundled TeX Live distribution/)
})

test('staged layout is platform-correct and needs no manifest', () => {
  assert.equal(stagedBinDirectory('/resources', 'darwin'),
    path.join('/resources', 'backend', 'texlive', 'bin', 'universal-darwin'))
  assert.equal(stagedBinDirectory('/resources', 'win32'),
    path.join('/resources', 'backend', 'texlive', 'bin', 'windows'))
  assert.throws(() => stagedBinDirectory('/resources', 'linux'), /no bundled TeX Live layout/)
  assert.deepEqual(stagedEngines('/resources', 'darwin', ['xelatex', 'bibtex']),
    [path.join('/resources', 'backend', 'texlive', 'bin', 'universal-darwin', 'xelatex'),
      path.join('/resources', 'backend', 'texlive', 'bin', 'universal-darwin', 'bibtex')])
  assert.deepEqual(stagedEngines('/resources', 'win32', ['xelatex']),
    [path.join('/resources', 'backend', 'texlive', 'bin', 'windows', 'xelatex.exe')])
  assert.throws(() => bundledTexlive('/does-not-exist', 'darwin'))
})

test('TeX writable cache is outside the frozen tree, with explicit font discovery', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tex = require('./texlive.cjs')
  const binDirectory = path.join(root, 'tree & 字体', 'bin', 'windows')
  const writableRoot = tex.texliveStateRoot(path.join(root, 'runtime'), '2026-r3')
  const environment = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\User' }
  const env = tex.prepareTexliveEnvironment({ binDirectory, writableRoot, environment, platform: 'win32' })
  assert.ok(env.TEXMFVAR.startsWith(writableRoot))
  assert.equal(env.TEXMFSYSVAR, undefined)
  const config = fs.readFileSync(env.FONTCONFIG_FILE, 'utf8')
  assert.equal((config.match(/<cachedir>/g) || []).length, 1)
  assert.ok(config.includes('&amp;'))
  assert.ok(config.includes('Microsoft'))
  assert.ok(!config.includes('<include'))
  assert.deepEqual(tex.prepareTexliveEnvironment({ binDirectory, writableRoot, environment, platform: 'win32' }), env)
  assert.notEqual(tex.texliveStateRoot(path.join(root, 'runtime'), '2026-r4'), writableRoot)
  const paths = fs.readFileSync(path.join(DESKTOP, '..', 'serve', 'service', 'paths.py'), 'utf8')
  for (const name of ['RUNTIME_CACHE_DIRNAME', 'TEXLIVE_CACHE_DIRNAME']) assert.ok(paths.includes(`${name} = "${tex[name]}"`))
})

test('TeX state uses the selected runtime root and leaves old home caches untouched', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-state-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tex = require('./texlive.cjs')
  const oldRuntime = path.join(root, 'home', 'runtime')
  fs.mkdirSync(oldRuntime, { recursive: true })
  const oldCache = path.join(oldRuntime, 'cache', 'texlive', 'legacy')
  fs.mkdirSync(oldCache, { recursive: true })
  const marker = path.join(oldCache, 'keep.txt')
  fs.writeFileSync(marker, 'existing user data')
  const installedRuntime = path.join(root, 'installation', 'runtime')
  const binDirectory = path.join(installedRuntime, 'texlive', '2026-r3', 'texlive', 'bin', 'windows')
  const writableRoot = tex.texliveStateRoot(installedRuntime, '2026-r3')
  assert.equal(writableRoot, path.join(installedRuntime, 'cache', 'texlive', '2026-r3'))
  const environment = tex.prepareTexliveEnvironment({ binDirectory, writableRoot, environment: {}, platform: 'win32' })
  for (const value of Object.values(environment)) {
    assert.ok(value === writableRoot || value.startsWith(writableRoot + path.sep))
  }
  assert.deepEqual(fs.readdirSync(writableRoot).sort(), ['fontconfig', 'fonts.conf', 'identity.json', 'texmf-config', 'texmf-var'])
  const fontConfiguration = fs.readFileSync(environment.FONTCONFIG_FILE, 'utf8')
  assert.ok(fontConfiguration.includes(`<cachedir>${path.join(writableRoot, 'fontconfig')}</cachedir>`))
  assert.equal(fs.readFileSync(marker, 'utf8'), 'existing user data')
  assert.deepEqual(fs.readdirSync(oldRuntime), ['cache'])
  assert.deepEqual(fs.readdirSync(oldCache), ['keep.txt'])
  assert.equal(fs.existsSync(path.join(installedRuntime, 'texlive')), false)
})

test('version cache has a readable root and rejects unsafe versions', () => {
  const tex = require('./texlive.cjs')
  const runtime = path.resolve(os.tmpdir(), 'runtime')
  assert.equal(tex.texliveStateRoot(runtime, '2026-r3'), path.join(runtime, 'cache', 'texlive', '2026-r3'))
  for (const version of ['', '..', '../2026', '2026/other', '2026\\other', '2026:', '2026.']) {
    assert.throws(() => tex.texliveStateRoot(runtime, version), /version/)
  }
})

test('version cache records full identity, reuses it, and preserves mismatched state', t => {
  const tex = require('./texlive.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const writableRoot = path.join(root, '2026-r3')
  const options = { binDirectory: path.join(root, 'tree', 'bin', 'windows'), writableRoot,
    version: '2026-r3', environment: { SystemRoot: 'C:\\Windows' }, platform: 'win32' }
  const first = tex.prepareTexliveEnvironment(options)
  const receiptPath = path.join(writableRoot, 'identity.json')
  const receipt = fs.readFileSync(receiptPath, 'utf8')
  assert.match(JSON.parse(receipt).fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(JSON.parse(receipt).version, options.version)
  const marker = path.join(first.TEXMFVAR, 'keep.txt')
  fs.writeFileSync(marker, 'active compiler cache')
  assert.deepEqual(tex.prepareTexliveEnvironment(options), first)
  for (const changed of [{ binDirectory: options.binDirectory + '-other' },
    { environment: { SystemRoot: 'D:\\Windows' } }, { systemFonts: false }, { version: '2026-r4' }, { archiveSha256: 'a'.repeat(64) }]) {
    assert.throws(() => tex.prepareTexliveEnvironment({ ...options, ...changed }), /identity conflict/)
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), receipt)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'active compiler cache')
  }
  fs.unlinkSync(receiptPath)
  assert.throws(() => tex.prepareTexliveEnvironment(options), /unidentified/)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'active compiler cache')
})

test('cache preparation resumes after identity publication without rewriting warm files', t => {
  const tex = require('./texlive.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { writableRoot: path.join(root, '2026-r3'), binDirectory: path.join(root, 'bin'), version: '2026-r3' }
  const environment = tex.prepareTexliveEnvironment(options)
  const identity = path.join(options.writableRoot, 'identity.json')
  const bytes = fs.readFileSync(identity)
  fs.unlinkSync(environment.FONTCONFIG_FILE)
  fs.rmdirSync(environment.TEXMFVAR)
  assert.deepEqual(tex.prepareTexliveEnvironment(options), environment)
  assert.deepEqual(fs.readFileSync(identity), bytes)
  const before = fs.statSync(environment.FONTCONFIG_FILE).mtimeMs
  tex.prepareTexliveEnvironment(options)
  assert.equal(fs.statSync(environment.FONTCONFIG_FILE).mtimeMs, before)
  fs.writeFileSync(identity, '{invalid')
  assert.throws(() => tex.prepareTexliveEnvironment(options), /identity conflict/)
  assert.equal(fs.readFileSync(identity, 'utf8'), '{invalid')
})


test('concurrent processes publish one complete identity and matching configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-concurrent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { writableRoot: path.join(root, '2026-r3'), binDirectory: path.join(root, 'bin'), version: '2026-r3' }
  const program = `const tex = require(process.argv[1]);
    try { tex.prepareTexliveEnvironment(JSON.parse(process.argv[2])) }
    catch (error) { console.error(error.message); process.exitCode = 1 }`
  const run = value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, path.join(__dirname, 'texlive.cjs'), JSON.stringify(value)],
      { env: process.env, windowsHide: true })
    let error = ''
    child.stderr.on('data', data => { error += data })
    child.on('error', reject)
    child.on('close', code => resolve({ code, error }))
  })
  const same = await Promise.all(Array.from({ length: 4 }, () => run(options)))
  assert.deepEqual(same, Array.from({ length: 4 }, () => ({ code: 0, error: '' })))
  const original = fs.readFileSync(path.join(options.writableRoot, 'identity.json'), 'utf8')
  const races = await Promise.all([run(options), run({ ...options, binDirectory: path.join(root, 'other') })])
  assert.equal(races[0].code, 0)
  assert.equal(races[1].code, 1)
  assert.match(races[1].error, /identity conflict/)
  assert.equal(fs.readFileSync(path.join(options.writableRoot, 'identity.json'), 'utf8'), original)
  assert.ok(!fs.readdirSync(options.writableRoot).some(name => name.endsWith('.tmp')))
})

test('update retirement leaves the normal initializer able to rebuild the same version', t => {
  const tex = require('./texlive.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cache = path.join(root, 'runtime', 'cache', 'texlive')
  const binDirectory = path.join(root, 'runtime', 'texlive', '2026-r3', 'texlive', 'bin', 'windows')
  const writableRoot = tex.texliveStateRoot(path.join(root, 'runtime'), '2026-r3')
  const options = { binDirectory: path.join(root, 'runtime', 'texlive', '2026-r3', 'texlive', 'bin', 'windows'),
    writableRoot, platform: 'win32', version: '2026-r3', environment: {} }
  const expected = tex.prepareTexliveEnvironment(options)
  fs.writeFileSync(path.join(writableRoot, 'texmf-var', 'stale'), 'old compiler state')
  // Native Windows tests own retirement/deletion safety. This contract checks
  // the real initializer with an absent active namespace and a retained old one.
  fs.renameSync(cache, `${cache}.retired`)
  assert.deepEqual(tex.prepareTexliveEnvironment(options), expected)
  assert.equal(fs.existsSync(path.join(writableRoot, 'texmf-var', 'stale')), false)
  assert.equal(fs.existsSync(path.join(`${cache}.retired`, path.relative(cache, writableRoot), 'texmf-var', 'stale')), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(writableRoot, 'identity.json'), 'utf8')).version, '2026-r3')
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform} retains the version root; only macOS supports exclusive rebuild`, t => {
    const tex = require('./texlive.cjs')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-relocation-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const writableRoot = tex.texliveStateRoot(path.join(root, 'runtime'), '2026-r3')
    const options = { binDirectory: path.join(root, 'old', 'bin', platform), writableRoot,
      platform, version: '2026-r3', archiveSha256: 'a'.repeat(64), environment: {} }
    const first = tex.prepareTexliveEnvironment(options)
    const inode = fs.statSync(writableRoot).ino
    const marker = path.join(first.TEXMFVAR, 'old-state')
    fs.writeFileSync(marker, 'compiler state')
    assert.equal(tex.texliveEnvironmentCurrent(options), true)
    assert.deepEqual(tex.prepareTexliveEnvironment(options), first)
    assert.equal(fs.existsSync(marker), true)
    const moved = { ...options, binDirectory: path.join(root, 'new', 'bin', platform) }
    assert.equal(tex.texliveEnvironmentCurrent(moved), false)
    assert.throws(() => tex.prepareTexliveEnvironment(moved), /identity conflict/)
    if (platform === 'win32') {
      assert.throws(() => tex.rebuildTexliveEnvironment(moved), /macOS-only/)
      assert.equal(fs.readFileSync(marker, 'utf8'), 'compiler state')
      return
    }
    assert.deepEqual(tex.rebuildTexliveEnvironment(moved), first)
    assert.equal(fs.statSync(writableRoot).ino, inode)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(tex.texliveEnvironmentCurrent(moved), true)
    assert.equal(tex.texliveEnvironmentCurrent(options), false)
    assert.ok(fs.readFileSync(first.FONTCONFIG_FILE, 'utf8').includes(path.join(root, 'new')))
    // Simulate an interrupted deletion/publication. Rebuild is restartable.
    fs.unlinkSync(path.join(writableRoot, 'identity.json'))
    assert.equal(tex.texliveEnvironmentCurrent(moved), false)
    tex.rebuildTexliveEnvironment(moved)
    assert.equal(tex.texliveEnvironmentCurrent(moved), true)
  })
}

test('macOS rebuild preflights all contents and preserves unknown or linked entries', t => {
  const tex = require('./texlive.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-rebuild-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { binDirectory: path.join(root, 'bin'), writableRoot: path.join(root, 'cache'),
    platform: 'darwin', version: '2026', archiveSha256: 'a'.repeat(64), environment: {} }
  const env = tex.prepareTexliveEnvironment(options)
  const receipt = fs.readFileSync(path.join(options.writableRoot, 'identity.json'), 'utf8')
  const unknown = path.join(options.writableRoot, 'user-file')
  fs.writeFileSync(unknown, 'preserve')
  assert.throws(() => tex.rebuildTexliveEnvironment(options), /unknown/)
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve')
  fs.unlinkSync(unknown)
  const outside = path.join(root, 'outside')
  fs.writeFileSync(outside, 'outside')
  const link = path.join(env.TEXMFVAR, 'linked')
  fs.linkSync(outside, link)
  assert.throws(() => tex.rebuildTexliveEnvironment(options), /unsafe/)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
  assert.equal(fs.readFileSync(path.join(options.writableRoot, 'identity.json'), 'utf8'), receipt)
  fs.unlinkSync(link)
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, link)
    assert.throws(() => tex.rebuildTexliveEnvironment(options), /unsafe/)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
  }
})
