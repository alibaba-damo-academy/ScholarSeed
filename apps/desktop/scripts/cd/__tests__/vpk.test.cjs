const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { manifest, prepare, invocation, assertVersion, check } = require('../vpk.cjs')

const prepared = {
  version: manifest.version, executable: path.resolve('private/dotnet.exe'),
  prefix: [path.resolve('private/vpk/tools/net8.0/any/vpk.dll')],
  environment: { DOTNET_ROOT: path.resolve('private'), DOTNET_ROOT_X64: path.resolve('private'), DOTNET_MULTILEVEL_LOOKUP: '0' },
}

test('macOS and backend-only builds do not prepare Windows tooling', async () => {
  for (const configuration of [{ platform: 'darwin', stage: 'dmg' }, { platform: 'win32', stage: 'backend' }])
    assert.equal(await prepare(configuration, { ensureArtifact: () => assert.fail('must not download') }), null)
})

test('Windows uses the prepared framework when PATH and global runtime are unavailable', () => {
  const command = invocation(prepared, {}, { PATH: '', DOTNET_ROOT: '/global/dotnet7' })
  check(command, (executable, args, options) => {
    assert.equal(executable, prepared.executable)
    assert.deepEqual(args, [...prepared.prefix, '-h'])
    assert.equal(options.env.PATH, '')
    assert.equal(options.env.DOTNET_ROOT, prepared.environment.DOTNET_ROOT)
    assert.equal(options.env.DOTNET_MULTILEVEL_LOOKUP, '0')
    assert.equal(options.windowsHide, true)
    return `Velopack CLI ${manifest.version}, for distributing applications.\r\n`
  })
})

test('missing prepared tooling fails explicitly instead of resolving vpk from PATH', () => {
  assert.throws(() => invocation(null), /requires prepared official/)
  assert.throws(() => invocation({ ...prepared, version: '0.0.0' }), /requires prepared official/)
})

test('explicit DLL overrides still use the reviewed private framework', () => {
  const command = invocation(prepared, { vpk: 'reviewed/vpk.dll' }, { SCHOLARSEED_DOTNET: 'unreviewed.exe' })
  assert.equal(command.executable, prepared.executable)
  assert.deepEqual(command.prefix, [path.resolve('reviewed/vpk.dll')])
  const executable = invocation(prepared, { vpk: 'reviewed/vpk.exe' }, {})
  assert.equal(executable.executable, path.resolve('reviewed/vpk.exe'))
  assert.deepEqual(executable.prefix, [])
})

test('tool version matching accepts exact official help and rejects adjacent/prerelease versions', () => {
  assertVersion(`Velopack CLI ${manifest.version}, for distributing applications.`)
  assertVersion(`Velopack ${manifest.version}\r\n`)
  for (const output of ['Velopack CLI 1.2.1610,', 'Velopack CLI 1.2.161-beta,', 'Velopack CLI 1.2.160,', 'dotnet 8.0.32'])
    assert.throws(() => assertVersion(output), /must be exactly/)
})

test('reviewed official archives use verified vendor mirrors with the same identity', () => {
  assert.equal(manifest.entrypoint, 'tools/net8.0/any/vpk.dll')
  assert.deepEqual(manifest.archives.map(item => item.name), ['vpk', 'libc', 'dotnet'])
  for (const artifact of manifest.archives) {
    assert.equal(new URL(artifact.url).protocol, 'https:')
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
    assert.ok(artifact.bytes > 0)
    assert.equal(artifact.mirrors.length, 1)
    const mirror = new URL(artifact.mirrors[0])
    assert.equal(mirror.origin, 'https://deep-rd.oss-cn-hangzhou.aliyuncs.com')
    assert.equal(path.posix.basename(mirror.pathname), artifact.filename)
    assert.ok(mirror.pathname.startsWith('/scholarseed-vendor/vendor/'))
  }
})

test('tampered prepopulated archive fails before execution and removes its owned extraction tree', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-reject-'))
  try {
    await assert.rejects(prepare({ platform: 'win32', stage: 'exe', runDirectory: directory }, {
      ensureArtifact: async filename => fs.writeFileSync(filename, 'tampered archive'),
      execFileSync: () => assert.fail('unverified archive must never execute'),
    }), /invalid official tool archive/)
    assert.deepEqual(fs.readdirSync(directory), [])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('download failures are fatal and clean only their tool preparation directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-download-'))
  fs.writeFileSync(path.join(directory, 'unrelated'), 'retain')
  try {
    await assert.rejects(prepare({ platform: 'win32', stage: 'exe', runDirectory: directory }, {
      ensureArtifact: async () => { throw new Error('HTTP 503') },
    }), /HTTP 503/)
    assert.deepEqual(fs.readdirSync(directory), ['unrelated'])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
