const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')
const {
  pythonRelease, verifyPythonArchive, verifyPython, preparePython,
  verifyDevelopmentPython, developmentPython, nativeTar, retryFilesystem
} = require('../../../scripts/python.cjs')

const REPO = path.resolve(__dirname, '../../..')
const SUPPORTED_HOST = ['darwin', 'win32'].includes(process.platform)

test('all declared native archives match their exact checked-in checksums', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO,
    'scripts/vendor/python-build-standalone/manifest.json'), 'utf8'))
  for (const key of Object.keys(manifest.targets)) {
    const [platform, arch] = key.split('-')
    const release = pythonRelease(REPO, platform, arch)
    await verifyPythonArchive(release)
    await assert.rejects(verifyPythonArchive({ ...release, sha256: '0'.repeat(64) }), /checksum differs/)
  }
  assert.throws(() => pythonRelease(REPO, 'unsupported', 'unknown'), /no Desktop Python distribution/)
})

test('Windows extraction selects the native executable and Windows venv layout', () => {
  assert.equal(nativeTar('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe')
  assert.throws(() => nativeTar('win32', {}), /SystemRoot/)
  const release = pythonRelease(REPO, 'win32', 'x86_64')
  assert.equal(release.executable, 'python/python.exe')
  assert.equal(release.venvExecutable, 'Scripts/python.exe')
})

test('Python cache publication retries transient Windows filesystem collisions', () => {
  let attempts = 0
  retryFilesystem(() => {
    attempts += 1
    if (attempts < 2) {
      const error = new Error('temporary directory is still busy')
      error.code = 'EPERM'
      throw error
    }
    return 'published'
  })
  assert.equal(attempts, 2)
  assert.throws(() => retryFilesystem(() => {
    const error = new Error('permanent missing source')
    error.code = 'ENOENT'
    throw error
  }), /permanent missing source/)
})

test('real native Python, venv and alternate-base rejection use the shared policy',
  { skip: !SUPPORTED_HOST }, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-python-contract-'))
    try {
      const python = await preparePython(REPO)
      assert.equal(await preparePython(REPO), python)
      const release = pythonRelease(REPO)
      const identity = verifyPython(python, release)
      assert.equal(identity.sqlite, release.sqlite)
      assert.throws(() => verifyPython(python, { ...release, sqlite: '0.0.0' }), /sqlite=/)
      assert.throws(() => verifyDevelopmentPython(REPO, python), /project virtual environment/)

      const venv = path.join(temporary, 'venv with spaces')
      execFileSync(process.env.UV || 'uv', ['venv', '--no-python-downloads', '--python', python, venv],
        { stdio: 'pipe' })
      const executable = developmentPython(REPO, venv)
      const actual = verifyDevelopmentPython(REPO, executable)
      assert.equal(actual.python, release.python)
      assert.equal(actual.sqlite, release.sqlite)
      assert.ok(fs.statSync(actual.scripts).isDirectory())

      const otherBase = path.join(temporary, 'other base')
      fs.mkdirSync(otherBase)
      execFileSync(nativeTar(), ['-xzf', release.archive, '-C', otherBase], { stdio: 'pipe' })
      const otherPython = path.join(otherBase, ...release.executable.split('/'))
      const otherVenv = path.join(temporary, 'other venv')
      execFileSync(process.env.UV || 'uv', ['venv', '--no-python-downloads', '--python', otherPython, otherVenv],
        { stdio: 'pipe' })
      assert.throws(() => verifyDevelopmentPython(REPO, developmentPython(REPO, otherVenv)),
        /base differs.*npm run install:python/)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

test('root npm workspace startup commands include the independent runtime gate', () => {
  const workspace = fs.readFileSync(path.join(REPO, 'scripts', 'workspace.cjs'), 'utf8')
  for (const command of ['runBinary', 'desktop', 'serve']) {
    assert.match(workspace, new RegExp(`function ${command}\\(`))
  }
  assert.match(workspace, /checkPython\(\)/)
})
