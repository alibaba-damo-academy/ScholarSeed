// Contract fixtures only; the real staged toolchain is proved by the packaging
// oracle (skills/community/literature-review/scripts/smoke_publication.py).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  artifact, bundledTexlive, digest, resolveVendoredTexlive, stagedBinDirectory, stagedEngines
} = require('./texlive.cjs')

const DESKTOP = path.resolve(__dirname, '..')
const VENDOR_MANIFEST = path.join(DESKTOP, '..', '..', 'scripts', 'vendor', 'texlive', 'manifest.json')
const ARCHIVE_NAME = JSON.parse(fs.readFileSync(VENDOR_MANIFEST, 'utf8')).targets['darwin-arm64'].archive

function writeVendorFixture(root, payload, sidecar) {
  const desktopRoot = path.join(root, 'checkout', 'apps', 'desktop')
  const vendor = path.join(root, 'checkout', 'scripts', 'vendor', 'texlive')
  fs.mkdirSync(desktopRoot, { recursive: true })
  fs.mkdirSync(vendor, { recursive: true })
  const archive = path.join(vendor, ARCHIVE_NAME)
  fs.writeFileSync(archive, payload)
  fs.writeFileSync(`${archive}.sha256`, sidecar)
  fs.writeFileSync(path.join(vendor, 'manifest.json'),
    fs.readFileSync(VENDOR_MANIFEST, 'utf8'))
  return desktopRoot
}

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
  assert.equal(path.basename(win.archive), 'texlive-2026-windows.tar.gz')
  assert.equal(win.bin_relative, 'texlive/bin/windows')
  assert.equal(win.machine, 'x86_64')
  assert.deepEqual(win.executables, ['xelatex', 'pdflatex', 'bibtex', 'kpsewhich'])
  // Linux is not a supported Desktop target.
  assert.throws(() => artifact(DESKTOP, 'linux', 'x64'), /no bundled TeX Live distribution/)
})

test('the committed archive matches its sidecar', async () => {
  const selected = artifact(DESKTOP, 'darwin', 'arm64')
  assert.equal(await digest(selected.archive), selected.sha256)
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

test('a tampered archive is rejected before extraction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-contract-'))
  try {
    const desktopRoot = writeVendorFixture(root, 'not the reviewed payload',
      `${'0'.repeat(64)}  ${ARCHIVE_NAME}\n`)
    await assert.rejects(() => resolveVendoredTexlive(desktopRoot, 'darwin', 'arm64'),
      /SHA-256 mismatch/)
    // A sidecar that does not name its own archive is rejected before hashing.
    writeVendorFixture(root, 'not the reviewed payload', `${'0'.repeat(64)}  other.tar.gz\n`)
    assert.throws(() => artifact(desktopRoot, 'darwin', 'arm64'), /sidecar is invalid/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unpulled LFS pointer names the missing payload, not a checksum mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-lfs-'))
  try {
    const pointer = ['version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'0'.repeat(64)}`].join('\n')
    const desktopRoot = writeVendorFixture(root, pointer,
      `${'0'.repeat(64)}  ${ARCHIVE_NAME}\n`)
    assert.throws(() => artifact(desktopRoot, 'darwin', 'arm64'), /unresolved Git LFS pointer/)
    // The pointer is recognised before hashing, so the failure never degrades
    // into the "SHA-256 mismatch" that a corrupt archive reports.
    await assert.rejects(() => resolveVendoredTexlive(desktopRoot, 'darwin', 'arm64'),
      /unresolved Git LFS pointer/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
