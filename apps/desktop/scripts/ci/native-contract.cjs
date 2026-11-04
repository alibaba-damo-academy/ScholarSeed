const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { compileNative } = require('../shared/native.cjs')
const {
  ensurePrivateDirectory,
  assertPrivateDirectory,
  noLinks,
} = require('../shared/build-state.cjs')
const { buildRecoveryMaintenance, resolveRecoveryMaintenance } = require('../cd/recovery.cjs')
const {
  developmentSourceSnapshot,
  sourceUnchanged,
} = require('../../../../scripts/shared/source.cjs')
const { parseNodeEvents, nodeReporterArgs } = require('../../../../scripts/ci/events.cjs')
const policy = require('../../native/toolchain.json')

const DESKTOP = path.resolve(__dirname, '../..')
const REPOSITORY = path.resolve(DESKTOP, '../..')
const RECOVERY_SUITES = Object.freeze([
  'native/consumption.test.cjs',
  'native/shipit/bridge.test.cjs',
  'native/restoration.test.cjs',
])
const MODE = '--recovery-maintenance'
const PRIVATE_MODE = 0o600
const INPUT_LIMIT = 64 * 1024 * 1024
const OUTPUT_LIMIT = 16 * 1024 * 1024
const TEST_TIMEOUT_MS = 10 * 60_000
const REPORT = 'native-gate.json'
const EVENTS = 'node-events.jsonl'
const HELP =
  'node apps/desktop/scripts/ci/native-contract.cjs [--recovery-maintenance --output NEW_PRIVATE --headers LOCAL --license LOCAL]'

function parseArguments(argv) {
  if (!argv.length) return { mode: 'default' }
  if (argv.length === 1 && argv[0] === '--help') return { mode: 'help' }
  if (argv[0] !== MODE || argv.length !== 7) throw new Error('invalid native contract arguments')
  const fields = { '--output': 'output', '--headers': 'headers', '--license': 'license' }
  const result = { mode: 'recovery' }
  for (let index = 1; index < argv.length; index += 2) {
    if (!Object.hasOwn(fields, argv[index])) throw new Error('invalid native contract arguments')
    const field = fields[argv[index]],
      value = argv[index + 1]
    if (!field || Object.hasOwn(result, field) || !value || value.startsWith('--'))
      throw new Error('invalid native contract arguments')
    result[field] = value
  }
  return result
}

function absolute(filename) {
  if (
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename ||
    filename.includes('\0')
  )
    throw new Error('native contract paths must be canonical absolute paths')
  return filename
}

function readOwnedFile(filename, limit) {
  noLinks(path.dirname(filename))
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  )
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid()) ||
      Number(before.mode) & 0o022 ||
      before.size > BigInt(limit)
    )
      throw new Error('unsafe or oversized native gate input')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const after = fs.fstatSync(descriptor, { bigint: true }),
      located = fs.lstatSync(filename, { bigint: true })
    if (
      BigInt(length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      located.isSymbolicLink() ||
      located.dev !== before.dev ||
      located.ino !== before.ino
    )
      throw new Error('native gate input changed while reading')
    return buffer.subarray(0, length)
  } finally {
    fs.closeSync(descriptor)
  }
}

async function validateRecoveryInputs(options, selectedPolicy = policy) {
  const output = absolute(options.output)
  assertPrivateDirectory(path.dirname(output))
  try {
    fs.lstatSync(output)
    throw new Error('native recovery gate output must be new')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const result = { output }
  for (const name of ['headers', 'license']) {
    const filename = absolute(options[name]),
      expected = selectedPolicy[name]
    if (
      !expected ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 1 ||
      expected.bytes > INPUT_LIMIT
    )
      throw new Error('invalid native input policy')
    const bytes = readOwnedFile(filename, expected.bytes)
    if (
      bytes.length !== expected.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256
    )
      throw new Error(`native ${name} input differs from verified artifact policy`)
    result[name] = filename
  }
  return result
}

function legacyRun() {
  const root = path.join(fs.realpathSync.native(os.tmpdir()), 'scholarseed-native-contract')
  return fs.mkdtempSync(path.join(ensurePrivateDirectory(root), 'run-'))
}

const dependencies = {
  platform: process.platform,
  nodeVersion: process.versions.node,
  validate: validateRecoveryInputs,
  build: buildRecoveryMaintenance,
  resolve: resolveRecoveryMaintenance,
  source: () => developmentSourceSnapshot(REPOSITORY),
  launch: spawnSync,
  compile: compileNative,
  legacyRun,
  log: (value) => console.log(value),
  error: (value) => console.error(value),
}

function privateWrite(directory, name, bytes) {
  assertPrivateDirectory(directory)
  fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: PRIVATE_MODE })
}

function validateObservation(observation) {
  const complete = (summary) =>
    summary.success !== false &&
    summary.counts.tests > 0 &&
    summary.counts.passed === summary.counts.tests &&
    ['failed', 'cancelled', 'skipped', 'todo'].every((name) => summary.counts[name] === 0)
  if (
    observation.nodeVersion !== `v${policy.node}` ||
    !observation.frameworkSuccess ||
    !complete(observation) ||
    observation.records.some((record) => record.status !== 'passed')
  )
    throw new Error('native recovery tests failed, skipped, cancelled or executed zero cases')
  const expected = RECOVERY_SUITES.map((filename) => path.resolve(DESKTOP, filename))
  if (
    observation.fileSummaries.length !== expected.length ||
    expected.some(
      (filename) =>
        observation.fileSummaries.filter(
          (summary) => summary.file === filename && complete(summary)
        ).length !== 1
    )
  )
    throw new Error('native recovery gate did not observe every required suite')
  return observation
}

async function recoveryGate(options, runtime) {
  if (runtime.platform !== 'darwin' || runtime.nodeVersion !== policy.node)
    throw new Error(`recovery maintenance gate requires native macOS and Node ${policy.node}`)
  const selected = await runtime.validate(options)
  const sourceBefore = runtime.source()
  let tool, observation, sourceAfter, child
  const errors = []
  try {
    await runtime.build(selected.output, { headers: selected.headers, license: selected.license })
    tool = runtime.resolve(selected.output)
    const temporary = path.join(selected.output, 'test-tmp')
    fs.mkdirSync(temporary, { mode: 0o700 })
    privateWrite(selected.output, EVENTS, '')
    const args = nodeReporterArgs(
      ['--experimental-transform-types', '--test', '--test-concurrency=1', ...RECOVERY_SUITES],
      path.join(selected.output, EVENTS)
    )
    child = runtime.launch(process.execPath, args, {
      cwd: DESKTOP,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
      env: {
        PATH: '/usr/bin:/bin',
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        SCHOLARSEED_LEASE_LIBRARY: tool.lease,
        SCHOLARSEED_TERMINAL_LIBRARY: tool.terminal,
        SCHOLARSEED_RECOVERY_TOOL: selected.output,
        SCHOLARSEED_TERMINAL_HEADERS_ARCHIVE: selected.headers,
      },
    })
    privateWrite(selected.output, 'stdout.log', child.stdout || '')
    privateWrite(selected.output, 'stderr.log', child.stderr || '')
    const observed = readOwnedFile(path.join(selected.output, EVENTS), OUTPUT_LIMIT).toString(
      'utf8'
    )
    observation = parseNodeEvents(observed, 'native-recovery-maintenance')
    validateObservation(observation)
    if (child.error || child.status !== 0 || child.signal)
      throw new Error(
        `native recovery test command failed: ${child.error?.code || child.signal || child.status}`
      )
  } catch (error) {
    errors.push(error)
  }
  try {
    if (tool) {
      const after = runtime.resolve(selected.output)
      if (
        after.manifestSha256 !== tool.manifestSha256 ||
        after.lease !== tool.lease ||
        after.terminal !== tool.terminal
      )
        throw new Error('maintenance tool receipt changed during tests')
    }
  } catch (error) {
    errors.push(error)
  }
  try {
    sourceAfter = runtime.source()
    if (!sourceUnchanged(sourceBefore, sourceAfter))
      throw new Error('native gate source changed during execution')
  } catch (error) {
    errors.push(error)
  }
  const report = {
    schema: 1,
    mode: 'recovery-maintenance',
    status: errors.length ? 'failed' : 'passed',
    output: selected.output,
    manifestSha256: tool?.manifestSha256 || null,
    sourceBefore,
    sourceAfter,
    child: child
      ? {
          exitCode: child.status,
          signal: child.signal || null,
          errorCode: child.error?.code || null,
        }
      : null,
    observation: observation || null,
    errors: errors.map((error) => ({ code: error.code || null, message: error.message })),
  }
  if (fs.existsSync(selected.output))
    privateWrite(selected.output, REPORT, JSON.stringify(report, null, 2) + '\n')
  if (errors.length)
    throw new AggregateError(
      errors,
      `native recovery gate failed; output retained: ${selected.output}`
    )
  runtime.log(
    `[native-contract] recovery passed: ${selected.output} tests=${observation.counts.tests}`
  )
  return 0
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const runtime = { ...dependencies, ...overrides }
  try {
    const options = parseArguments(argv)
    if (options.mode === 'help') {
      runtime.log(HELP)
      return 0
    }
    if (options.mode === 'recovery') return await recoveryGate(options, runtime)
    const run = runtime.legacyRun(),
      output = path.join(run, 'native')
    try {
      await runtime.compile({ directory: output, runDirectoryContract: true })
      runtime.log(`[native-contract] passed: ${output}`)
      return 0
    } finally {
      fs.rmSync(run, { recursive: true, force: true })
    }
  } catch (error) {
    runtime.error(error.message)
    return 1
  }
}

module.exports = { parseArguments, main, validateRecoveryInputs, RECOVERY_SUITES }

if (require.main === module)
  main().then((code) => {
    process.exitCode = code
  })
