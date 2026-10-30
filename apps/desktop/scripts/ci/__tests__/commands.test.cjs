const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { childExitCode, forward, launch } = require('../../../../../scripts/shared/execution.cjs')
const suite = require('../test.cjs')
const pretest = require('../pretest.cjs')
const e2e = require('../e2e.cjs')
const desktopPackage = require('../../../package.json')
const workspacePackage = require('../../../../../package.json')

test('root dev builds the skill pack before starting the isolated product', () => {
  assert.equal(
    workspacePackage.scripts.dev,
    'node scripts/ops-cli.cjs cd build local --target skills && node scripts/ops-cli.cjs dev'
  )
})

test('normal and coverage runs consume the same serial collection without lifecycle recursion', () => {
  const normal = suite.invocation(false)
  const covered = suite.invocation(true)
  assert.equal(normal.executable, process.execPath)
  assert.deepEqual(covered.args.slice(1), [process.execPath, ...normal.args])
  assert.ok(normal.args.includes('--test-concurrency=1'))
  assert.deepEqual(normal.args.slice(3), suite.TEST_FILES)
  assert.equal(new Set(suite.TEST_FILES).size, suite.TEST_FILES.length)
  assert.deepEqual(suite.TEST_FILES.slice(-4), Object.keys(suite.TEST_GLOBS))
})

test('Desktop aliases are removed without deleting the root distribution compatibility contracts', () => {
  for (const alias of ['build:release', 'release', 'package:installer', 'build:check']) {
    assert.equal(Object.hasOwn(desktopPackage.scripts, alias), false)
  }
  for (const contract of ['package:dist', 'package:check', 'package:verify']) {
    assert.equal(workspacePackage.scripts[contract], `node scripts/desktop.cjs ${contract}`)
  }
  assert.equal(desktopPackage.scripts['package:dist'], 'node ../../scripts/cd/distribution.cjs')
  assert.equal(
    desktopPackage.scripts['package:distribution'],
    'node ../../scripts/pre/toolchain.cjs run prepare:python && node scripts/cd/package.cjs release'
  )
})

test('test runner preserves forwarded arguments, launch options and child failure', () => {
  for (const coverage of [false, true]) {
    const forwarded = ['--test-name-pattern', 'with spaces']
    const argv = [...(coverage ? ['--coverage'] : []), ...forwarded]
    let starts = 0
    const status = suite.main(argv, {
      launch(executable, args, options) {
        starts += 1
        assert.deepEqual(args.slice(-2), forwarded)
        assert.equal(executable, process.execPath)
        assert.equal(options.cwd, path.resolve(__dirname, '../../..'))
        assert.equal(options.env, process.env)
        assert.equal(options.stdio, 'inherit')
        return { status: 19 }
      },
    })
    assert.equal(status, 19)
    assert.equal(starts, 1)
  }
})

test('pretest preserves the ordered fail-fast check chain and Desktop cwd', () => {
  const steps = pretest.invocations()
  assert.deepEqual(
    steps.map((step) => step.args),
    [
      [pretest.TOOLCHAIN, 'check'],
      ['--test', ...pretest.CONTRACT_FILES],
      [pretest.TOOLCHAIN, 'run', 'i18n:test'],
    ]
  )
  const calls = []
  const status = pretest.main({
    launch(executable, args, options) {
      calls.push({ executable, args, options })
      return { status: calls.length === 3 ? 17 : 0 }
    },
  })
  assert.equal(status, 17)
  assert.equal(calls.length, 3)
  assert.ok(
    calls.every(
      (call) =>
        call.executable === process.execPath &&
        call.options.cwd === path.resolve(__dirname, '../../..') &&
        call.options.stdio === 'inherit' &&
        call.options.env === process.env
    )
  )
  assert.throws(
    () =>
      pretest.main({
        launch() {
          return { error: new Error('cannot spawn') }
        },
      }),
    /cannot spawn/
  )
})

test('explicit pretest arguments reach only the final localization test', () => {
  const ordinary = pretest.invocations()
  const explicit = pretest.invocations(['--base', 'with spaces'])
  assert.deepEqual(explicit.slice(0, -1), ordinary.slice(0, -1))
  assert.deepEqual(explicit.at(-1).args, [...ordinary.at(-1).args, '--base', 'with spaces'])
})

test('runners preserve shell-equivalent child signal exit codes', () => {
  for (const [signal, expected] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGKILL', 137],
  ]) {
    const options = {
      launch() {
        return { status: null, signal }
      },
    }
    assert.equal(suite.main([], options), expected)
    assert.equal(pretest.main(options), expected)
    assert.equal(e2e.main(['mr'], options), expected)
  }
})

test('shared execution retains numeric, unknown and real child signal statuses', (context) => {
  assert.equal(childExitCode({ status: 0 }), 0)
  assert.equal(childExitCode({ status: 23, signal: 'SIGTERM' }), 23)
  assert.equal(childExitCode({ status: null, signal: 'unknown' }), 1)
  assert.equal(forward(process.execPath, ['-e', 'process.exit(23)']), 23)
  assert.throws(
    () => launch(process.execPath, ['-e', 'process.exit(23)']),
    (error) => error.exitCode === 23 && error.code === 'CHILD_EXIT'
  )
  if (process.platform === 'win32')
    return context.diagnostic(
      'POSIX self-signals require a POSIX host; Windows numeric exit codes checked'
    )
  for (const [signal, expected] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGKILL', 137],
  ]) {
    const args = ['-e', `process.kill(process.pid, ${JSON.stringify(signal)})`]
    const result = spawnSync(process.execPath, args)
    assert.equal(result.status, null)
    assert.equal(result.signal, signal)
    assert.equal(childExitCode(result), expected)
    assert.equal(forward(process.execPath, args), expected)
  }
})

test('E2E builds once before each registered project and blocks tests when build fails', () => {
  for (const [suiteName, project] of [
    ['mr', 'smoke'],
    ['live', 'live'],
    ['update', 'update'],
  ]) {
    const calls = []
    assert.equal(
      e2e.main([suiteName, '--grep', 'with spaces'], {
        launch(executable, args, options) {
          calls.push({ executable, args, options })
          return { status: 0 }
        },
      }),
      0
    )
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].args, [pretest.TOOLCHAIN, 'run', 'build'])
    assert.deepEqual(calls[1].args.slice(1), [
      'test',
      `--project=${project}`,
      '--grep',
      'with spaces',
    ])
    assert.ok(calls[1].args[0].endsWith(path.join('@playwright', 'test', 'cli.js')))
    let starts = 0
    assert.equal(
      e2e.main([suiteName], {
        launch() {
          starts += 1
          return { status: 23 }
        },
      }),
      23
    )
    assert.equal(starts, 1)
  }
  assert.throws(() => e2e.main(['unknown']), /Unknown E2E suite/)
})
