// Contract fixtures only; real Electron and installers are separate acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { artifact, bundledCodex, resolveVendoredCodex, verifyArchive } = require('./codex.cjs')

test('vendored manifest selects only reviewed platforms', () => {
  const desktop = path.resolve(__dirname, '..')
  const mac = artifact(desktop, 'darwin', 'arm64')
  const intelMac = artifact(desktop, 'darwin', 'x64')
  const windows = artifact(desktop, 'win32', 'x64')
  assert.equal(mac.version, '0.153.4')
  assert.equal(mac.target, 'aarch64-apple-darwin')
  assert.equal(intelMac.target, 'x86_64-apple-darwin')
  assert.equal(windows.target, 'x86_64-pc-windows-msvc')
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

test('Intel macOS runtime probe tolerates Rosetta bootstrap latency', async () => {
  const desktop = path.resolve(__dirname, '..')
  const runtime = await resolveVendoredCodex(desktop, 'darwin', 'x64')
  assert.equal(runtime.reported_version, '0.153.4')
})
