const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const sealing = require('../../cd/seal.cjs')
const leaseModule = import('../lease.mjs')
const {
  compileNative,
  nativeBuildDirectory,
  cleanupNativeBuild,
  validateDarwinToolchain,
  supportsNoDefaultConfig,
  invoke,
} = require('../native.cjs')

async function explicitContractEntry(failure) {
  const filename = path.resolve(__dirname, '../../ci/native-contract.cjs')
  const scopedRequire = createRequire(filename)
  const calls = []
  const messages = { logs: [], errors: [] }
  const state = {
    exitCode: 0,
    argv: [process.execPath, filename],
    versions: process.versions,
    platform: process.platform,
  }
  const module = { exports: {} }
  const compile = async (options) => {
    calls.push({ ...options, outputExists: fs.existsSync(options.directory) })
    if (failure) throw failure
    return {}
  }
  const requireFixture = (name) =>
    name === '../shared/native.cjs' ? { compileNative: compile } : scopedRequire(name)
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInNewContext({
    require: requireFixture,
    module,
    __dirname: path.dirname(filename),
    process: state,
    console: {
      log: (value) => messages.logs.push(value),
      error: (value) => messages.errors.push(value),
    },
  })
  state.exitCode = await module.exports.main([])
  return { calls, messages, state }
}

test('explicit native contract entry requests directory checks in a new output directory', async () => {
  const result = await explicitContractEntry()
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].runDirectoryContract, true)
  assert.equal(result.calls[0].outputExists, false)
  assert.equal(result.state.exitCode, 0)
  assert.equal(result.messages.errors.length, 0)
  assert.equal(result.messages.logs.length, 1)
  assert.equal(fs.existsSync(result.calls[0].directory), false)
})

test('explicit directory contract failures remain failures, including SIGKILL', async () => {
  const failure = Object.assign(new Error('directory-test terminated'), { signal: 'SIGKILL' })
  const result = await explicitContractEntry(failure)
  assert.equal(result.state.exitCode, 1)
  assert.deepEqual(result.messages.logs, [])
  assert.deepEqual(result.messages.errors, [failure.message])
})

test('directory contract opt-in rejects ambiguous non-boolean values before compilation', async () => {
  for (const value of ['true', 'false', 1, null, {}]) {
    await assert.rejects(compileNative({ runDirectoryContract: value }), TypeError)
  }
})

test('native contracts follow the outer Electron command, not the inner Vite build', async (t) => {
  const { nativeLease } = await leaseModule
  const previous = process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST
  const context = process.env.SCHOLARSEED_BUILD_CONTEXT
  delete process.env.SCHOLARSEED_BUILD_CONTEXT
  t.after(() => {
    if (previous === undefined) delete process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST
    else process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST = previous
    if (context !== undefined) process.env.SCHOLARSEED_BUILD_CONTEXT = context
  })
  for (const [command, override, expected] of [
    ['serve', undefined, false],
    ['serve', '1', true],
    ['build', undefined, true],
    ['build', '0', true],
    [undefined, undefined, true],
  ]) {
    if (override === undefined) delete process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST
    else process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST = override
    let actual
    const stopped = new Error('stop before native compilation')
    const preparation = t.mock.method(sealing, 'prepareNative', async (options) => {
      actual = options.runContract
      throw stopped
    })
    const plugin = nativeLease({ command })
    plugin.configResolved?.({ command: 'build', mode: 'development' })
    await assert.rejects(plugin.buildStart(), (error) => error === stopped)
    preparation.mock.restore()
    assert.equal(actual, expected, `outer=${command}, override=${override}`)
  }
})

test('native build uses a fixed private root with a unique run directory', (t) => {
  const first = nativeBuildDirectory({ TMPDIR: '/private/tmp' })
  const second = nativeBuildDirectory({ TMPDIR: '/private/tmp' })
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true })
    fs.rmSync(second, { recursive: true, force: true })
  })
  assert.notEqual(first, second)
  assert.match(first, /[\\/]scholarseed-native-build[\\/]run-[^\\/]+$/)
  assert.match(second, /[\\/]scholarseed-native-build[\\/]run-[^\\/]+$/)
})

test('native build accepts an explicit private root for scanner configuration', (t) => {
  const root = '/private/tmp/scholarseed-native-build-test'
  const directory = nativeBuildDirectory({ SCHOLARSEED_NATIVE_BUILD_ROOT: root })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.match(directory, /[\\/]scholarseed-native-build-test[\\/]run-[^\\/]+$/)
})

test('older Apple clang help does not enable unsupported no-default-config', () => {
  assert.equal(supportsNoDefaultConfig('OPTIONS:\n  -Wall Enable warnings\n'), false)
  assert.equal(supportsNoDefaultConfig('  --no-default-config Disable default config\n'), true)
})

test('Apple toolchains are accepted by capability floors rather than exact build strings', () => {
  for (const [compiler, sdk] of [
    ['Apple clang version 16.0.0 (clang-1600.0.26.6)', '15.0'],
    ['Apple clang version 21.0.0 (clang-2100.1.1.101)', '26.5'],
    ['Apple clang version 22.0.0 (clang-2200.0.1)', '27.0'],
    ['Apple clang version 14.0.0 (clang-1400.0.1)', '13.0'],
  ]) {
    assert.doesNotThrow(() =>
      validateDarwinToolchain(compiler, { path: '/SDK/MacOSX.sdk', version: sdk }, '13.0')
    )
  }
})

test('invalid compiler/SDK identities and SDKs below the deployment target fail closed', () => {
  const compiler = 'Apple clang version 21.0.0 (clang-2100.1.1.101)'
  for (const [clang, sdk, path] of [
    ['clang version 21.0.0', '26.5', '/SDK'],
    ['', '26.5', '/SDK'],
    [compiler, 'unknown', '/SDK'],
    [compiler, '12.9', '/SDK'],
    [compiler, '26.5', 'relative/SDK'],
  ]) {
    assert.throws(() => validateDarwinToolchain(clang, { path, version: sdk }, '13.0'))
  }
  assert.throws(() =>
    validateDarwinToolchain(compiler, { path: '/SDK', version: '13.0' }, '13.0.1')
  )
})

test('native command failures expose exit code and complete streams without changing the error', () => {
  const stdout = 'native stdout 中文\n\n'
  const stderr = 'native stderr\r\nlast line without newline'
  assert.throws(
    () =>
      invoke(
        process.execPath,
        [
          '-e',
          `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(23)`,
        ],
        { ...process.env, PRIVATE_NATIVE_ENV: 'PRIVATE_NATIVE_ENV_VALUE' }
      ),
    (error) => {
      assert.equal(error.status, 23)
      assert.equal(error.signal, null)
      assert.equal(error.stdout, stdout)
      assert.equal(error.stderr, stderr)
      assert.match(error.message, /"exitCode":23/)
      assert.match(error.message, /"signal":null/)
      assert.ok(error.message.includes(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`))
      assert.match(error.message, /"outputMayBeTruncated":false/)
      assert.ok(!error.message.includes('PRIVATE_NATIVE_ENV_VALUE'))
      return true
    }
  )
})
test('native command termination retains platform exit and signal metadata in the build error', () => {
  const expectedStatus = process.platform === 'win32' ? 1 : null
  const expectedSignal = process.platform === 'win32' ? null : 'SIGTERM'
  assert.throws(
    () =>
      invoke(
        process.execPath,
        [
          '-e',
          'process.stdout.write("before termination\\n", () => process.kill(process.pid, "SIGTERM"))',
        ],
        process.env
      ),
    (error) => {
      assert.equal(error.status, expectedStatus)
      assert.equal(error.signal, expectedSignal)
      assert.ok(error.message.includes(`"exitCode":${JSON.stringify(expectedStatus)}`))
      assert.ok(error.message.includes(`"signal":${JSON.stringify(expectedSignal)}`))
      assert.ok(error.message.includes('before termination\n'))
      return true
    }
  )
})
test('native cleanup retains the original command failure and secondary cleanup diagnostics', (t) => {
  const failure = Object.assign(new Error('blocked executable\n[native-command] details'), { code: 'UNKNOWN' })
  const cleanup = Object.assign(new Error('locked build directory'), { code: 'EPERM' })
  t.mock.method(fs, 'rmSync', () => { throw cleanup })
  cleanupNativeBuild('unused-build-fixture', failure)
  assert.equal(failure.code, 'UNKNOWN')
  assert.match(failure.message, /blocked executable\n\[native-command\] details/)
  assert.match(failure.message, /\[native-cleanup\] locked build directory/)
  assert.equal(failure.cleanupError, cleanup)
})

test('native cleanup failure still rejects an otherwise successful build', (t) => {
  const cleanup = Object.assign(new Error('locked build directory'), { code: 'EPERM' })
  t.mock.method(fs, 'rmSync', () => { throw cleanup })
  assert.throws(() => cleanupNativeBuild('unused-build-fixture'), error => error === cleanup)
})

test('native successful commands retain their trimmed output contract', () => {
  assert.equal(
    invoke(process.execPath, ['-e', 'process.stdout.write(" result \\n")'], process.env),
    'result'
  )
})

test('native runtime option errors preserve their actual status and complete stderr', () => {
  assert.throws(
    () => invoke(process.execPath, [], { ...process.env, NODE_OPTIONS: '--no-such-native-option' }),
    (error) => {
      assert.equal(error.status, 9)
      assert.match(error.message, /"exitCode":9/)
      assert.ok(error.message.includes(error.stderr))
      return true
    }
  )
})
