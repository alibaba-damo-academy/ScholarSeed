const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const test = require('node:test')
const {
  parseArguments,
  main,
  validateRecoveryInputs,
  RECOVERY_SUITES,
} = require('../native-contract.cjs')
const policy = require('../../../native/toolchain.json')
const macosTest = process.platform === 'darwin' ? test : test.skip

function events(suites, outcome = 'passed') {
  const keys = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites', 'topLevel']
  const counts = (total) =>
    Object.fromEntries(
      keys.map((key) => [key, ['tests', 'topLevel', outcome].includes(key) ? total : 0])
    )
  const values = [{ type: 'ci:node-start', schemaVersion: 1, nodeVersion: `v${policy.node}` }]
  for (const [index, file] of suites.entries()) {
    if (outcome === 'empty') continue
    const data = { file, name: 'fixture case', testId: index + 1, nesting: 0, line: 10, column: 1 }
    values.push({ type: 'test:start', data })
    values.push({
      type: outcome === 'failed' ? 'test:fail' : 'test:pass',
      data: {
        ...data,
        ...(outcome === 'skipped' ? { skip: 'fixture skip' } : {}),
        details: { type: 'test', duration_ms: 1 },
      },
    })
    values.push({
      type: 'test:summary',
      data: { file, counts: counts(1), success: outcome !== 'failed', duration_ms: 1 },
    })
  }
  values.push({
    type: 'test:summary',
    data: {
      counts: counts(outcome === 'empty' ? 0 : suites.length),
      success: outcome !== 'failed',
      duration_ms: 1,
    },
  })
  values.push({ type: 'ci:node-end' })
  return values.map((value) => JSON.stringify(value)).join('\n') + '\n'
}

function fixture(context, overrides = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-gate-contract-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, 'tool')
  const calls = []
  let resolved = 0,
    snapshotted = 0
  const source = {
    schemaVersion: 1,
    valid: true,
    commit: 'a'.repeat(40),
    head: 'HEAD',
    indexFingerprint: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64),
    clean: false,
    files: 1,
  }
  const tool = {
    lease: path.join(output, 'native', 'lease.node'),
    terminal: path.join(output, 'terminal.node'),
    manifestSha256: 'd'.repeat(64),
  }
  const runtime = {
    platform: 'darwin',
    nodeVersion: policy.node,
    validate: async (options) => {
      calls.push('validate')
      return options
    },
    build: async (selected) => {
      calls.push('build')
      assert.equal(selected, output)
      fs.mkdirSync(output, { mode: 0o700 })
      return tool
    },
    resolve: (selected) => {
      calls.push('resolve')
      assert.equal(selected, output)
      resolved++
      return tool
    },
    source: () => {
      calls.push('source')
      snapshotted++
      return source
    },
    launch: (executable, args, options) => {
      calls.push('launch')
      assert.equal(executable, process.execPath)
      assert.ok(args.includes('--test-concurrency=1'))
      assert.deepEqual(
        args.filter((argument) => argument.endsWith('.test.cjs')),
        RECOVERY_SUITES
      )
      assert.equal(options.env.NODE_OPTIONS, undefined)
      assert.equal(options.env.SCHOLARSEED_LEASE_LIBRARY, tool.lease)
      assert.equal(options.env.SCHOLARSEED_TERMINAL_LIBRARY, tool.terminal)
      assert.equal(options.env.SCHOLARSEED_RECOVERY_TOOL, output)
      assert.equal(options.env.SCHOLARSEED_TERMINAL_HEADERS_ARCHIVE, path.join(root, 'headers'))
      const report = args
        .find(
          (argument) =>
            argument.startsWith('--test-reporter-destination=') &&
            argument !== '--test-reporter-destination=stdout'
        )
        .split('=')
        .slice(1)
        .join('=')
      const suites = overrides.omitSuite ? RECOVERY_SUITES.slice(0, -1) : RECOVERY_SUITES
      fs.writeFileSync(
        report,
        events(
          suites.map((filename) => path.resolve(options.cwd, filename)),
          overrides.outcome
        )
      )
      return {
        status: overrides.status ?? 0,
        signal: null,
        stdout: 'fixture stdout',
        stderr: 'fixture stderr',
      }
    },
    log: () => {},
    error: () => {},
    ...overrides.runtime,
  }
  const argv = [
    '--recovery-maintenance',
    '--output',
    output,
    '--headers',
    path.join(root, 'headers'),
    '--license',
    path.join(root, 'license'),
  ]
  return {
    root,
    output,
    calls,
    runtime,
    argv,
    source,
    tool,
    resolved: () => resolved,
    snapshotted: () => snapshotted,
  }
}

test('native gate parser accepts only explicit maintenance scope and preserves default mode', () => {
  assert.deepEqual(parseArguments([]), { mode: 'default' })
  assert.deepEqual(parseArguments(['--help']), { mode: 'help' })
  assert.deepEqual(
    parseArguments([
      '--recovery-maintenance',
      '--output',
      '/new',
      '--headers',
      '/headers',
      '--license',
      '/license',
    ]),
    { mode: 'recovery', output: '/new', headers: '/headers', license: '/license' }
  )
  for (const args of [
    ['--output', '/new'],
    ['--recovery-maintenance'],
    ['--recovery-maintenance', '--output', '/new', '--headers', '/headers'],
    [
      '--recovery-maintenance',
      '--output',
      '/one',
      '--output',
      '/two',
      '--headers',
      '/headers',
      '--license',
      '/license',
    ],
    ['--unknown'],
  ]) {
    assert.throws(() => parseArguments(args), /argument/)
  }
})

test('help and rejected platform or Node prerequisites have no build side effects', async (context) => {
  const current = fixture(context)
  assert.equal(await main(['--help'], current.runtime), 0)
  assert.deepEqual(current.calls, [])
  for (const selected of [{ platform: 'win32' }, { platform: 'linux' }, { nodeVersion: '0.0.0' }]) {
    assert.equal(await main(current.argv, { ...current.runtime, ...selected }), 1)
    assert.deepEqual(current.calls, [])
    assert.equal(fs.existsSync(current.output), false)
  }
})

macosTest(
  'maintenance dispatch requires all three real suite observations and post-checks source',
  async (context) => {
    const current = fixture(context)
    assert.equal(await main(current.argv, current.runtime), 0)
    assert.equal(current.resolved(), 2)
    assert.equal(current.snapshotted(), 2)
    assert.deepEqual(current.calls, [
      'validate',
      'source',
      'build',
      'resolve',
      'launch',
      'resolve',
      'source',
    ])
    const report = JSON.parse(
      fs.readFileSync(path.join(current.output, 'native-gate.json'), 'utf8')
    )
    assert.equal(report.status, 'passed')
    assert.equal(report.observation.counts.tests, 3)
    assert.equal(fs.statSync(path.join(current.output, 'native-gate.json')).mode & 0o777, 0o600)
  }
)

for (const outcome of ['empty', 'skipped', 'failed']) {
  macosTest(`${outcome} observations cannot pass even with child exit zero`, async (context) => {
    const current = fixture(context, { outcome })
    assert.equal(await main(current.argv, current.runtime), 1)
    assert.equal(current.resolved(), 2)
    assert.equal(fs.existsSync(current.output), true)
    const report = JSON.parse(
      fs.readFileSync(path.join(current.output, 'native-gate.json'), 'utf8')
    )
    assert.equal(report.status, 'failed')
    assert.equal(report.observation.counts.tests, outcome === 'empty' ? 0 : 3)
  })
}

macosTest(
  'nonzero child exit remains failed and preserves diagnostic artifacts',
  async (context) => {
    const current = fixture(context, { status: 19 })
    assert.equal(await main(current.argv, current.runtime), 1)
    assert.equal(fs.readFileSync(path.join(current.output, 'stdout.log'), 'utf8'), 'fixture stdout')
    assert.equal(fs.readFileSync(path.join(current.output, 'stderr.log'), 'utf8'), 'fixture stderr')
    assert.equal(fs.existsSync(current.output), true)
  }
)

macosTest('post-run source drift and changed maintenance receipts fail closed', async (context) => {
  const current = fixture(context)
  let reads = 0
  current.runtime.source = () => ({
    ...current.source,
    fingerprint: (++reads === 1 ? 'c' : 'e').repeat(64),
  })
  assert.equal(await main(current.argv, current.runtime), 1)
  const second = fixture(context)
  let resolutions = 0
  second.runtime.resolve = () => ({
    ...second.tool,
    manifestSha256: (++resolutions === 1 ? 'd' : 'e').repeat(64),
  })
  assert.equal(await main(second.argv, second.runtime), 1)
})

macosTest(
  'input verification is bounded and output must be a new canonical private path',
  async (context) => {
    const current = fixture(context)
    const headers = path.join(current.root, 'headers'),
      license = path.join(current.root, 'license')
    fs.writeFileSync(headers, 'headers', { mode: 0o600 })
    fs.writeFileSync(license, 'license', { mode: 0o600 })
    const description = (filename) => ({
      bytes: fs.statSync(filename).size,
      sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    })
    const selectedPolicy = { headers: description(headers), license: description(license) }
    assert.deepEqual(
      await validateRecoveryInputs({ output: current.output, headers, license }, selectedPolicy),
      { output: current.output, headers, license }
    )
    fs.appendFileSync(headers, 'changed')
    await assert.rejects(
      () => validateRecoveryInputs({ output: current.output, headers, license }, selectedPolicy),
      /input|artifact/
    )
    fs.writeFileSync(headers, 'headers')
    fs.mkdirSync(current.output, { mode: 0o700 })
    await assert.rejects(
      () => validateRecoveryInputs({ output: current.output, headers, license }, selectedPolicy),
      /new|exist/
    )
  }
)

macosTest(
  'an omitted native suite cannot be replaced by successful counts from other suites',
  async (context) => {
    const current = fixture(context, { omitSuite: true })
    assert.equal(await main(current.argv, current.runtime), 1)
    const report = JSON.parse(
      fs.readFileSync(path.join(current.output, 'native-gate.json'), 'utf8')
    )
    assert.equal(report.observation.counts.tests, 2)
    assert.equal(report.status, 'failed')
  }
)

test('default gate retains its original compiler request and cleanup on failure', async (context) => {
  const current = fixture(context)
  const run = path.join(current.root, 'default')
  fs.mkdirSync(run)
  let options
  assert.equal(
    await main([], {
      ...current.runtime,
      legacyRun: () => run,
      compile: async (value) => {
        options = value
        throw new Error('native fixture failure')
      },
    }),
    1
  )
  assert.deepEqual(options, { directory: path.join(run, 'native'), runDirectoryContract: true })
  assert.equal(fs.existsSync(run), false)
})
