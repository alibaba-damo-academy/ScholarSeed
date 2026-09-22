// Contract fixtures only; real Electron and installers are separate acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { artifact, bundledCodex, publishRuntime, resolveVendoredCodex, verifyArchive } = require('./codex.cjs')

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

test('runtime publication and integrity checks precede executable probing', () => {
  const source = fs.readFileSync(path.join(__dirname, 'codex.cjs'), 'utf8')
  const publication = source.indexOf('await publishRuntime(runtime, directory, { platform })')
  const verification = source.indexOf('await digest(cached,')
  const probe = source.indexOf('const probe = spawnSync(executable,')
  assert.ok(publication > 0 && publication < verification && verification < probe)
  assert.ok(source.includes('const executable = path.join(directory, packageManifest.entrypoint)'))
})

test('vendored manifest selects only reviewed platforms', () => {
  const desktop = path.resolve(__dirname, '..')
  const mac = artifact(desktop, 'darwin', 'arm64')
  const intelMac = artifact(desktop, 'darwin', 'x64')
  const windows = artifact(desktop, 'win32', 'x64')
  assert.equal(mac.version, '0.155.1')
  assert.equal(mac.target, 'aarch64-apple-darwin')
  assert.equal(intelMac.target, 'x86_64-apple-darwin')
  assert.equal(windows.target, 'x86_64-pc-windows-msvc')
  for (const selected of [mac, intelMac, windows]) {
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
    fs.writeFileSync(path.join(bin, 'codex'), 'fixture', { mode: 0o700 })
    assert.equal(bundledCodex(root), path.join(bin, 'codex'))
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('Intel macOS runtime probe tolerates Rosetta bootstrap latency', {
  skip: process.env.SCHOLARSEED_NATIVE_MATRIX !== '1'
}, async () => {
  const desktop = path.resolve(__dirname, '..')
  const runtime = await resolveVendoredCodex(desktop, 'darwin', 'x64')
  assert.equal(runtime.reported_version, '0.155.1')
})
