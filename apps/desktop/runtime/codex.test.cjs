// Contract fixtures only; real Electron and installers are separate acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { artifact, bundledCodex, CACHE_VALIDATION, completeRuntime, publishRuntime, resolveVendoredCodex, verifyArchive } = require('./codex.cjs')
const REVIEWED_CODEX_VERSION = '0.165.0'

test('Windows Codex component version follows the official vendored release', () => {
  const bindings = JSON.parse(fs.readFileSync(path.join(__dirname, 'versions.json'), 'utf8'))
  const vendored = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/vendor/codex/manifest.json'), 'utf8'))
  const version = bindings.components.codex.version
  const revision = /^(.*)-r([1-9][0-9]*)$/.exec(version)
  assert.ok(revision, 'Codex component must have a reviewed positive revision')
  assert.equal(revision[1], vendored.version,
    'review CI component-version-observed.json when upgrading official Codex')
})

function cacheFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-contract-')))
  const desktop = path.join(root, 'apps', 'desktop')
  const vendor = path.join(root, 'scripts', 'vendor', 'codex')
  fs.mkdirSync(desktop, { recursive: true })
  fs.mkdirSync(vendor, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/vendor/codex/manifest.json')))
  const selected = manifest.artifacts[`${process.platform}-${process.arch}`]
  const archive = Buffer.from('invalid archive, contract fixture only')
  selected.sha256 = crypto.createHash('sha256').update(archive).digest('hex')
  selected.integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64')
  selected.bytes = archive.length
  fs.writeFileSync(path.join(vendor, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(vendor, selected.file), archive)
  const directory = path.join(desktop, 'node_modules/.cache/scholarseed/codex',
    `${manifest.version}-${process.platform}-${process.arch}-${selected.sha256}`)
  const entrypoint = 'bin/codex'
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true })
  const executable = path.join(directory, entrypoint)
  fs.writeFileSync(executable, 'not an executable', { mode: 0o755 })
  const receipt = {
    archive_sha256: selected.sha256, reported_version: manifest.version, entrypoint,
    files: [{ path: entrypoint, mode: 0o755,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') }],
  }
  fs.writeFileSync(path.join(directory, 'resolve-receipt.json'), JSON.stringify(receipt))
  return { root, desktop, directory, executable }
}

test('launch cache validation verifies inventory without executing; default still executes', async () => {
  const fixture = cacheFixture()
  try {
    const release = await resolveVendoredCodex(
      fixture.desktop, process.platform, process.arch, () => {}, CACHE_VALIDATION.integrity)
    assert.equal(release.path, fixture.executable)
    await assert.rejects(resolveVendoredCodex(fixture.desktop))
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
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
      fs.rmSync(fixture.root, { recursive: true, force: true })
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
    fs.rmSync(fixture.root, { recursive: true, force: true })
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
      fs.rmSync(fixture.root, { recursive: true, force: true })
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
    assert.equal(selected.version, REVIEWED_CODEX_VERSION)
    assert.equal(selected.file, `codex-${REVIEWED_CODEX_VERSION}-${selected.key}.tgz`)
    assert.ok(selected.url.endsWith(`/${selected.file}`))
    assert.match(selected.url, /^https:\/\//)
    assert.match(selected.sha256, /^[a-f0-9]{64}$/)
    assert.ok(selected.bytes > 0)
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
