// Contract fixtures only; the real staged toolchain is proved by the packaging
// oracle (skills/community/literature-review/scripts/smoke_publication.py).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {
  artifact, bundledTexlive, cacheDirectory, publishCache, stagedBinDirectory, stagedEngines
} = require('./texlive.cjs')

const DESKTOP = path.resolve(__dirname, '..')
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
  assert.equal(path.basename(win.archive), 'texlive-2026-windows.tar.gz')
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
