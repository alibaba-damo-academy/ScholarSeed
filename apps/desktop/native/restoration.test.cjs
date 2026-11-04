const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { resolveRecoveryMaintenance } = require('../scripts/cd/recovery.cjs')
const { observeSpawn } = require('./observations.cjs')
const policy = require('./toolchain.json')

assert.equal(process.platform, 'darwin')
assert.equal(process.versions.node, policy.node)
const TOOL = process.env.SCHOLARSEED_RECOVERY_TOOL
assert(TOOL && path.isAbsolute(TOOL), 'select the current-source maintenance tool')
const files = resolveRecoveryMaintenance(TOOL)
const native = require(files.lease)
const TIMEOUT = 30000
const FRESH_QUALIFICATIONS = 5

function fixture(context) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'restoration-native-'))
  let completed = false
  context.after(() => {
    if (completed) fs.rmSync(root, { recursive: true, force: true })
    else process.stderr.write(`fixture evidence retained: ${root}\n`)
  })
  const executable = path.join(root, 'fixture')
  const source = path.join(__dirname, 'shipit')
  const compiled = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fblocks',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-framework',
      'Foundation',
      ...['cleanup.m', 'preparation.m', 'readiness.m', 'restoration.fixture.m'].map((name) =>
        path.join(source, name)
      ),
      '-o',
      executable,
    ],
    { encoding: 'utf8', timeout: TIMEOUT }
  )
  assert.equal(compiled.status, 0, compiled.stderr)
  const prepared = observeSpawn(
    executable,
    [path.join(root, 'data')],
    { encoding: 'utf8', timeout: TIMEOUT },
    path.join(root, 'preparation.json')
  )
  const diagnostic = JSON.stringify({
    status: prepared.status,
    signal: prepared.signal,
    error: prepared.error?.code,
    stdout: prepared.stdout,
    stderr: prepared.stderr,
    observation: prepared.observation,
  })
  assert.equal(
    prepared.status,
    0,
    diagnostic
  )
  assert.deepEqual(prepared.observation.evidence.errors, [], diagnostic)
  const options = JSON.parse(prepared.stdout)
  const directory = (name) => {
    const filename = path.join(root, name)
    fs.mkdirSync(filename, { mode: 0o700 })
    return filename
  }
  const coordinator = directory('coordinator'),
    home = directory('home'),
    userData = directory('profile'),
    workspace = directory('projects')
  const identities = [home, userData, workspace].map((filename) => {
    const pin = native.pin(filename, false)
    try {
      return native.persistentIdentity(pin)
    } finally {
      native.release(pin)
    }
  })
  const identity = (filename) => {
    const info = fs.statSync(filename)
    return { dev: info.dev, ino: info.ino, uid: info.uid }
  }
  const capture = (filename) => ({
    path: filename,
    parent: identity(path.dirname(filename)),
    item: identity(filename),
  })
  const contextDirectory = path.join(
    path.dirname(coordinator),
    '.scholarseed-update-launch',
    createHash('sha256').update(options.application).digest('hex')
  )
  fs.mkdirSync(contextDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(home, 'updates'), { mode: 0o700 })
  const contextPath = path.join(contextDirectory, 'context.json')
  const handoff = path.join(home, 'updates', 'squirrel.json')
  const selection = {
    schema: 2,
    uid: process.getuid(),
    application: options.application,
    bundleId: 'com.scholarseed.desktop',
    sourceBuild: '202611031043',
    targetBuild: '202611031329',
    candidate: options.binding.candidate,
    at: 1,
    home,
    userData,
    workspace,
    identities,
  }
  fs.writeFileSync(contextPath, JSON.stringify(selection), { mode: 0o600 })
  fs.writeFileSync(
    handoff,
    JSON.stringify({
      version: '0.3.1',
      buildNumber: selection.targetBuild,
      candidate: selection.candidate,
      at: 1,
      state: 'installing',
      binding: options.binding,
      nativeRequest: {
        source: capture(options.source),
        target: capture(options.application),
        binding: options.binding,
      },
    }),
    { mode: 0o600 }
  )
  fs.writeFileSync(
    path.join(options.application, 'Contents', 'Resources', 'product.json'),
    JSON.stringify({
      bundle_id: selection.bundleId,
      expected_team_id: 'KYG3VP6NVH',
      build_number: selection.sourceBuild,
      release_lane: 'distribution',
    }),
    { mode: 0o600 }
  )
  const scope = {
    application: options.application,
    coordinator,
    handoff,
    nativeState: options.nativeState,
    preparation: options.preparation,
    cleanup: options.cleanup,
    toolDirectory: TOOL,
    expectedTeam: 'KYG3VP6NVH',
    requestId: options.binding.requestId,
  }
  const nativeRecords = [
    path.join(options.preparation, 'journal.plist'),
    path.join(path.dirname(options.source), '.scholarseed-prepare.plist'),
    options.nativeState,
  ]
  const hashes = () =>
    nativeRecords.map((filename) =>
      createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    )
  return {
    root,
    scope,
    contextPath,
    handoff,
    hashes,
    contextDirectory,
    complete: () => {
      completed = true
    },
  }
}

function execute(current, mode) {
  const restoration = pathToFileURL(path.join(__dirname, '../src/main/restoration.ts')).href
  const domains = pathToFileURL(path.join(__dirname, 'domains.cjs')).href
  const program = `
    import { applyTerminalRecovery } from ${JSON.stringify(restoration)};
    import domains from ${JSON.stringify(domains)};
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const native = require(${JSON.stringify(files.lease)});
    const terminal = require(${JSON.stringify(files.terminal)});
    let consumed = false;
    const wrapped = ${mode === 'interrupted' ? `Object.defineProperty(Object.create(native), 'consumeAt', {value(...args) { native.consumeAt(...args); if (!consumed) {consumed=true; process.exit(73)} }})` : 'native'};
    const runtime = {platform:process.platform, uid:process.getuid(), load:()=>({native:wrapped,open:terminal.open}), begin:(api,coordinator,roots)=>domains.beginDomains(api,coordinator,roots,true), verifyApplication:async()=>{}};
    try { console.log(JSON.stringify(await applyTerminalRecovery(${JSON.stringify(current.scope)}, runtime))); }
    catch(error) { console.log(JSON.stringify({code:error.code,mutationPerformed:error.mutationPerformed,nativeCode:error.nativeCode,systemCode:error.systemCode}));process.exitCode=1; }
  `
  return spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', program],
    { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 65536 }
  )
}

function executeQualified(current, mode) {
  for (let attempt = 1; ; attempt++) {
    const result = execute(current, mode)
    fs.writeFileSync(
      path.join(current.root, `${mode}-${attempt}.json`),
      JSON.stringify(
        {
          status: result.status,
          signal: result.signal,
          error: result.error?.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2
      )
    )
    let refusal
    try {
      refusal = JSON.parse(result.stdout)
    } catch {
      return result
    }
    if (
      attempt === FRESH_QUALIFICATIONS ||
      result.signal ||
      result.error ||
      refusal.nativeCode !== 'ERR_TERMINAL_OBSERVATION' ||
      ![os.constants.errno.EAGAIN, os.constants.errno.ESTALE].includes(refusal.systemCode)
    )
      return result
    process.stderr.write(
      `fresh qualification ${attempt} refused; no holder is reused: ${result.stdout}${result.stderr}`
    )
  }
}

test('real owner failure records and same-process maintenance consume only the two TS records', (context) => {
  const current = fixture(context)
  const before = current.hashes()
  const result = executeQualified(current, 'normal')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(JSON.parse(result.stdout).outcome, 'recovered')
  assert.equal(fs.existsSync(current.contextPath), false)
  assert.equal(fs.existsSync(current.handoff), false)
  assert.deepEqual(current.hashes(), before)
  current.complete()
})

test('real process death after context consumption retains a barrier and resumes the exact transaction', (context) => {
  const current = fixture(context)
  const before = current.hashes()
  const stopped = executeQualified(current, 'interrupted')
  assert.equal(stopped.status, 73, stopped.stdout + stopped.stderr)
  assert.equal(fs.existsSync(current.contextPath), false)
  assert.equal(fs.existsSync(current.handoff), true)
  const { beginDomains } = require('./domains.cjs')
  const domains = beginDomains(native, current.scope.coordinator, [current.contextDirectory])
  domains.occupy()
  assert.throws(() => domains.admit(), { code: 'ERR_LEASE_BUSY' })
  domains.close()
  const resumed = executeQualified(current, 'normal')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.equal(fs.existsSync(current.handoff), false)
  assert.deepEqual(current.hashes(), before)
  current.complete()
})
