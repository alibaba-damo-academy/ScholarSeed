const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { observeSpawn } = require('./observations.cjs')

const CHILD_TIMEOUT_MS = 5000
const PRIVATE_MODE = 0o600
const FAILURE_EXIT = 23
const SECRET = 'observation-environment-must-not-be-recorded'

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native observations '))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, evidence: path.join(directory, 'observation.json') }
}

function options(directory) {
  return Object.freeze({
    cwd: directory,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, SCHOLARSEED_OBSERVATION_SECRET: SECRET },
  })
}

test('actual Node spawn preserves arguments and cwd while recording only scoped observations', (context) => {
  const { directory, evidence } = fixture(context)
  const args = Object.freeze([
    '-e',
    'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))',
    'argument with spaces',
    '引号 " and spaces',
  ])
  const selected = options(directory)
  const before = JSON.stringify(selected)
  const result = observeSpawn(process.execPath, args, selected, evidence)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.equal(result.error, undefined)
  assert.deepEqual(JSON.parse(result.stdout), {
    args: args.slice(2),
    cwd: fs.realpathSync(directory),
  })
  assert.equal(JSON.stringify(selected), before)
  const observation = result.observation
  assert.equal(observation.command, process.execPath)
  assert.deepEqual(observation.args, args)
  assert.equal(observation.cwd, directory)
  assert.equal(observation.process.pid, result.pid)
  assert.equal(observation.process.parentPid, process.pid)
  assert.equal(observation.process.parentUid, process.getuid?.() ?? null)
  assert.equal(observation.process.requestedUid, process.getuid?.() ?? null)
  assert.equal(observation.result.status, 0)
  assert.equal(observation.result.signal, null)
  assert.equal(observation.result.error, null)
  assert.deepEqual(observation.evidence.errors, [])
  assert.equal(observation.evidence.basis,
    'serialized-errors-are-not-a-write-flush-close-receipt;use-returned-observation')
  assert(Number.isFinite(observation.timing.elapsedMs) && observation.timing.elapsedMs >= 0)
  assert.equal(new Date(observation.timing.calledAt).toISOString(), observation.timing.calledAt)
  assert.equal(new Date(observation.timing.returnedAt).toISOString(), observation.timing.returnedAt)
  assert(Date.parse(observation.timing.returnedAt) >= Date.parse(observation.timing.calledAt))
  assert.equal(observation.timing.basis, 'spawnSync-call-window-not-termination-time')
  const digest = createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')
  const info = fs.statSync(process.execPath, { bigint: true })
  for (const snapshot of Object.values(observation.executable)) {
    assert.equal(snapshot.path, process.execPath)
    assert.equal(snapshot.sha256, digest)
    assert.equal(snapshot.stat.inode, String(info.ino))
    assert.equal(snapshot.stat.size, String(info.size))
    assert.equal(snapshot.stableDuringRead, true)
  }
  const serialized = fs.readFileSync(evidence, 'utf8')
  assert.deepEqual(JSON.parse(serialized), observation)
  assert.equal(serialized.includes(SECRET), false)
  assert.equal(Object.hasOwn(observation, 'env'), false)
  assert.equal(Object.hasOwn(observation, 'options'), false)
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(evidence).mode & 0o777, PRIVATE_MODE)
})

test('nonzero Node exits remain nonzero and the child executes exactly once', (context) => {
  const { directory, evidence } = fixture(context)
  const marker = path.join(directory, 'executions')
  const result = observeSpawn(
    process.execPath,
    ['-e', `require('node:fs').appendFileSync(process.argv[1],'once');process.exit(${FAILURE_EXIT})`, marker],
    options(directory),
    evidence
  )
  assert.equal(result.status, FAILURE_EXIT)
  assert.equal(result.signal, null)
  assert.equal(result.observation.result.status, FAILURE_EXIT)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once')
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), result.observation)
})

test('self-terminated Node signals preserve the actual spawn result without repeating execution', (context) => {
  const { directory, evidence } = fixture(context)
  const marker = path.join(directory, 'executions')
  const result = observeSpawn(
    process.execPath,
    ['-e', "require('node:fs').appendFileSync(process.argv[1],'once');process.kill(process.pid,'SIGTERM')", marker],
    options(directory),
    evidence
  )
  assert.equal(result.error, undefined)
  assert.equal(result.observation.result.status, result.status)
  assert.equal(result.observation.result.signal, result.signal)
  assert.equal(result.observation.result.error, null)
  if (process.platform !== 'win32') {
    assert.equal(result.status, null)
    assert.equal(result.signal, 'SIGTERM')
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once')
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), result.observation)
})

test('an absent executable retains the original spawn error and both failed identity snapshots', (context) => {
  const { directory, evidence } = fixture(context)
  const executable = path.join(directory, 'absent executable')
  const result = observeSpawn(executable, ['argument with spaces'], options(directory), evidence)
  assert.equal(result.status, null)
  assert.equal(result.signal, null)
  assert.equal(result.error.code, 'ENOENT')
  const recorded = result.observation.result.error
  for (const field of ['name', 'message', 'code', 'errno', 'syscall', 'path', 'spawnargs'])
    assert.deepEqual(recorded[field], result.error[field])
  assert.equal(Object.hasOwn(recorded, 'stack'), false)
  assert.equal(result.observation.executable.before.error.code, 'ENOENT')
  assert.equal(result.observation.executable.after.error.code, 'ENOENT')
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), result.observation)
})

test('an existing observation refuses execution without replacing evidence', (context) => {
  const { directory, evidence } = fixture(context)
  const marker = path.join(directory, 'must-not-execute')
  fs.writeFileSync(evidence, 'preserved', { mode: PRIVATE_MODE })
  assert.throws(
    () => observeSpawn(
      process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1],'executed')", marker],
      options(directory),
      evidence
    ),
    { code: 'EEXIST' }
  )
  assert.equal(fs.existsSync(marker), false)
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'preserved')
})

for (const method of ['writeFileSync', 'fsyncSync', 'closeSync']) {
  test(`${method} evidence failure preserves the real child result and reports incomplete persistence`, (context) => {
    const { directory, evidence } = fixture(context)
    const marker = path.join(directory, 'executions')
    const failure = Object.assign(new Error('injected observation persistence failure'), { code: 'EIO' })
    const original = fs[method]
    context.mock.method(fs, method, (...args) => {
      if (typeof args[0] === 'number') {
        if (method !== 'closeSync') throw failure
        const opened = fs.fstatSync(args[0]), located = fs.statSync(evidence)
        if (opened.dev === located.dev && opened.ino === located.ino) {
          original(...args)
          throw failure
        }
      }
      return original(...args)
    })
    const result = observeSpawn(
      process.execPath,
      ['-e', "require('node:fs').appendFileSync(process.argv[1],'once')", marker],
      options(directory),
      evidence
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
    assert.equal(result.error, undefined)
    assert.equal(result.observation.result.status, 0)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'once')
    assert.deepEqual(result.observation.evidence.errors, [{
      operation: method === 'writeFileSync' ? 'write' : method === 'fsyncSync' ? 'flush' : 'close',
      error: { name: 'Error', message: failure.message, code: failure.code },
    }])
    assert.equal(result.observation.evidence.path, evidence)
  })
}
