const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')
const vm = require('node:vm')
const {
  pythonRelease, verifyPythonArchive, verifyPython, preparePython,
  verifyDevelopmentPython, verifyDevelopmentPythonAsync, inspectPythonAsync,
  developmentPython, nativeTar, retryFilesystem
} = require('../../../../../scripts/shared/python.cjs')

const REPO = path.resolve(sourceDirectory, '../../../..')
const SUPPORTED_HOST = ['darwin', 'win32'].includes(process.platform)

function asynchronousPolicy() {
  const pending = []
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'scripts/shared/python.cjs'), 'utf8'), {
    module, process, console, Buffer, __dirname: path.join(REPO, 'scripts/shared'),
    require(name) {
      if (name === 'node:child_process') return {
        execFile(executable, args, options, callback) {
          pending.push({ executable, args, options, callback })
        },
        execFileSync() { throw new Error('blocking subprocess is forbidden') }
      }
      return require(name.startsWith('.') ? path.join(REPO, 'scripts/shared', name) : name)
    }
  })
  return { policy: module.exports, pending }
}

test('asynchronous inspection yields and preserves isolated bounded executable invocation', async () => {
  const { policy, pending } = asynchronousPolicy()
  const checking = policy.inspectPythonAsync('python with spaces')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].executable, 'python with spaces')
  assert.deepEqual(Array.from(pending[0].args.slice(0, 3)), ['-I', '-B', '-c'])
  assert.equal(pending[0].options.windowsHide, true)
  assert.equal(pending[0].options.timeout, 15_000)
  assert.notEqual(pending[0].options.shell, true)
  await new Promise(resolve => setImmediate(resolve))
  pending[0].callback(null, '{"python":"3.12.0","scripts":"C:\\\\venv\\\\Scripts"}\r\n')
  assert.equal((await checking).scripts, 'C:\\venv\\Scripts')
})

test('asynchronous inspection rejects malformed output and subprocess failure', async () => {
  for (const [error, output, pattern] of [
    [null, 'not-json', /JSON/],
    [new Error('probe timed out'), '', /probe timed out/],
    [new Error('executable missing'), '', /executable missing/]
  ]) {
    const { policy, pending } = asynchronousPolicy()
    const checking = policy.inspectPythonAsync('python')
    pending[0].callback(error, output)
    await assert.rejects(checking, pattern)
  }
})

test('asynchronous development verification retains receipt, runtime fields and base identity checks', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'python-async-policy-'))
  try {
    const manifestDirectory = path.join(temporary, 'scripts/vendor/python-build-standalone')
    fs.mkdirSync(manifestDirectory, { recursive: true })
    fs.copyFileSync(path.join(REPO, 'scripts/vendor/python-build-standalone/manifest.json'),
      path.join(manifestDirectory, 'manifest.json'))
    const release = pythonRelease(temporary)
    const root = path.join(temporary, '.python', release.sha256)
    const base = path.join(root, 'python')
    const venv = path.join(temporary, 'venv with spaces')
    const other = path.join(temporary, 'other')
    for (const directory of [base, venv, other]) fs.mkdirSync(directory, { recursive: true })
    const receipt = path.join(root, 'archive.sha256')
    fs.writeFileSync(receipt, release.sha256)
    const identity = { python: release.python, sqlite: release.sqlite, platform: release.platform,
      machine: release.machine, base_prefix: base, prefix: base, scripts: base }
    const cases = [
      [{}, {}, null],
      [{ python: '0.0.0' }, {}, /python=/],
      [{ sqlite: '0.0.0' }, {}, /sqlite=/],
      [{ platform: 'foreign' }, {}, /platform=/],
      [{ machine: 'foreign' }, {}, /machine=/],
      [{ base_prefix: other }, {}, /cached Python uses a different base runtime/],
      [{}, { python: '0.0.0' }, /python=/],
      [{}, { sqlite: '0.0.0' }, /sqlite=/],
      [{}, { platform: 'foreign' }, /platform=/],
      [{}, { machine: 'foreign' }, /machine=/],
      [{}, { base_prefix: other }, /base differs/],
      [{}, { prefix: base }, /project virtual environment/]
    ]
    for (const [baseChange, venvChange, failure] of cases) {
      const { policy, pending } = asynchronousPolicy()
      const checking = policy.verifyDevelopmentPythonAsync(temporary, path.join(venv, 'python'))
      const result = failure ? assert.rejects(checking, failure) : checking
      pending[0].callback(null, JSON.stringify({ ...identity, ...baseChange }))
      await new Promise(resolve => setImmediate(resolve))
      if (pending[1]) pending[1].callback(null, JSON.stringify({ ...identity, prefix: venv, ...venvChange }))
      const actual = await result
      if (!failure) assert.equal(actual.scripts, base)
    }
    fs.writeFileSync(receipt, 'wrong archive')
    const { policy, pending } = asynchronousPolicy()
    await assert.rejects(policy.verifyDevelopmentPythonAsync(temporary, venv), /cache does not match/)
    assert.equal(pending.length, 0)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('all declared native archives have immutable download metadata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO,
    'scripts/vendor/python-build-standalone/manifest.json'), 'utf8'))
  for (const key of Object.keys(manifest.targets)) {
    const [platform, arch] = key.split('-')
    const release = pythonRelease(REPO, platform, arch)
    assert.match(release.url, /^https:\/\//)
    assert.match(release.sha256, /^[a-f0-9]{64}$/)
    assert.ok(release.bytes > 0)
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
      assert.deepEqual(await inspectPythonAsync(python), identity)
      assert.equal(identity.sqlite, release.sqlite)
      assert.throws(() => verifyPython(python, { ...release, sqlite: '0.0.0' }), /sqlite=/)
      assert.throws(() => verifyDevelopmentPython(REPO, python), /project virtual environment/)

      const venv = path.join(temporary, 'venv with spaces')
      execFileSync(process.env.UV || 'uv', ['venv', '--no-python-downloads', '--python', python, venv],
        { stdio: 'pipe' })
      const executable = developmentPython(REPO, venv)
      const actual = verifyDevelopmentPython(REPO, executable)
      assert.deepEqual(await verifyDevelopmentPythonAsync(REPO, executable), actual)
      await assert.rejects(verifyDevelopmentPythonAsync(REPO, python), /project virtual environment/)
      assert.equal(actual.python, release.python)
      assert.equal(actual.sqlite, release.sqlite)
      assert.ok(fs.statSync(actual.scripts).isDirectory())
      const namespaced = verifyDevelopmentPython(REPO, path.toNamespacedPath(executable))
      assert.equal(namespaced.python, actual.python)
      assert.equal(fs.realpathSync.native(namespaced.prefix), fs.realpathSync.native(actual.prefix))

      const otherBase = path.join(temporary, 'other base')
      fs.mkdirSync(otherBase)
      execFileSync(nativeTar(), ['-xzf', release.archive, '-C', otherBase], { stdio: 'pipe' })
      const otherPython = path.join(otherBase, ...release.executable.split('/'))
      const otherVenv = path.join(temporary, 'other venv')
      execFileSync(process.env.UV || 'uv', ['venv', '--no-python-downloads', '--python', otherPython, otherVenv],
        { stdio: 'pipe' })
      assert.throws(() => verifyDevelopmentPython(REPO, developmentPython(REPO, otherVenv)),
        /base differs.*pnpm ops pre install python/)
      await assert.rejects(verifyDevelopmentPythonAsync(REPO, developmentPython(REPO, otherVenv)),
        /base differs.*pnpm ops pre install python/)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

test('root npm workspace startup commands include the independent runtime gate', () => {
  const workspace = fs.readFileSync(path.join(REPO, 'scripts', 'shared', 'workspace.cjs'), 'utf8')
  for (const command of ['runBinary', 'desktop', 'serve']) {
    assert.match(workspace, new RegExp(`function ${command}\\(`))
  }
  assert.match(workspace, /checkPython\(\)/)
})
