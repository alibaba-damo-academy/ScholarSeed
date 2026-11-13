const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const test = require('node:test')

const library = process.env.SCHOLARSEED_REPAIR_LIBRARY
const fixtureLibrary = process.env.SCHOLARSEED_REPAIR_FIXTURE_LIBRARY
if (process.platform !== 'darwin' || !library || !fixtureLibrary)
  throw new Error('Native repair tests require both the shipped Darwin repair.node and isolated fixture')
const production = require(library)
const repair = require(fixtureLibrary)

function qualify(config, implementation = repair) {
  try {
    return implementation.open(JSON.stringify(config))
  } catch (error) {
    error.message = `${error.code} systemCode=${error.systemCode}`
    throw error
  }
}

function fixture(context) {
  repair.processScope([], 0)
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-repair-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = (value) => {
    fs.mkdirSync(value, { recursive: true, mode: 0o700 })
    return value
  }
  const bundle = (value) => {
    directory(path.join(value, 'Contents'))
    return value
  }
  const identity = (value) => {
    const metadata = fs.lstatSync(value)
    return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid }
  }
  const capture = (value, contents = true) => ({
    path: value,
    parent: identity(path.dirname(value)),
    item: identity(value),
    ...(contents ? { contents: identity(path.join(value, 'Contents')) } : {}),
  })
  const source = bundle(path.join(root, 'cache', 'update.new', 'ScholarSeed.app'))
  const oldSource = bundle(path.join(root, 'cache', 'update.old', 'ScholarSeed.app'))
  const target = bundle(path.join(root, 'installed', 'ScholarSeed.app'))
  const owned = directory(path.join(root, 'shipit-candidate.fixture'))
  const candidate = bundle(path.join(owned, 'ScholarSeed.app'))
  const preparation = directory(path.join(root, 'preparation'))
  const cleanup = directory(path.join(root, 'cleanup'))
  const roots = ['home', 'profile', 'workspace'].map((name) => directory(path.join(root, name)))
  const binding = (character) => ({
    schema: 1,
    requestId: character.repeat(64),
    sha512: 'b'.repeat(128),
    size: 1,
    candidate: character,
  })
  const targetCapture = capture(target)
  const journal = {
    schema: '1',
    record: {
      source: capture(oldSource),
      target: targetCapture,
      directory: capture(owned, false),
      candidate: capture(candidate),
      attempts: 1,
      state: 'ready',
      binding: binding('a'),
      failure: { code: 60, target: targetCapture },
    },
  }
  fs.rmSync(path.dirname(oldSource), { recursive: true })
  fs.rmSync(owned, { recursive: true })
  fs.renameSync(target, `${target}.old`)
  bundle(target)
  const journalPath = path.join(preparation, 'journal.plist')
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', journalPath, '-'], {
    input: JSON.stringify(journal),
  })
  fs.chmodSync(journalPath, 0o600)
  const cleanupJournal = path.join(cleanup, 'journal.plist')
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', cleanupJournal, '-'], {
    input: JSON.stringify({ schema: '1', records: [] }),
  })
  fs.chmodSync(cleanupJournal, 0o600)
  for (const owner of [preparation, cleanup])
    fs.writeFileSync(path.join(owner, 'lock'), '', { mode: 0o600 })
  const state = path.join(root, 'cache', 'ShipItState.plist')
  fs.writeFileSync(
    state,
    JSON.stringify({
      binding: binding('c'),
      bundleIdentifier: 'com.scholarseed.desktop',
      updateBundleURL: pathToFileURL(source).href,
      targetBundleURL: pathToFileURL(target).href,
      installationAuthorized: false,
      launchAfterInstallation: false,
      useUpdateBundleName: true,
    }),
    { mode: 0o600 }
  )
  const config = {
    schema: 1,
    mode: 'orphan',
    preparation,
    cleanup,
    source,
    target,
    state,
    binding: binding('c'),
    selection: {
      schema: 1,
      paths: roots,
      identities: roots.map((value) => {
        const metadata = fs.statSync(value, { bigint: true })
        return `posix:${metadata.dev.toString(16).padStart(16, '0')}:${metadata.ino.toString(16).padStart(16, '0')}`
      }),
    },
  }
  return { config, journalPath, state, preparation, journal }
}

test('shipped repair library exposes no process-scope or fault-injection controls', (context) => {
  assert.deepEqual(Object.getOwnPropertyNames(production), ['open'])
  assert.notEqual(fs.realpathSync(library), fs.realpathSync(fixtureLibrary))
  assert.notEqual(path.dirname(fs.realpathSync(library)), path.dirname(fs.realpathSync(fixtureLibrary)))
  const current = fixture(context)
  for (const extra of [{ processScope: [] }, { mappingDenials: 0 }]) {
    assert.throws(() => qualify({ ...current.config, ...extra }, production),
      (error) => error.code === 'ERR_TERMINAL_ARGUMENT')
  }
})

test('test process scope accepts only live direct children and cannot change while locked', (context) => {
  const current = fixture(context)
  for (const scope of [[process.pid], [process.ppid], [-1]]) {
    assert.throws(() => repair.processScope(scope, 0), (error) => error.code === 'ERR_FIXTURE_SCOPE')
  }
  assert.throws(() => repair.processScope([], process.pid), (error) => error.code === 'ERR_FIXTURE_SCOPE')
  const holder = qualify(current.config)
  try {
    assert.throws(() => repair.processScope([], 0), (error) => error.code === 'ERR_FIXTURE_SCOPE')
  } finally { holder.close() }
  assert.doesNotThrow(() => repair.processScope([], 0))
})

test('background repair planning never claims process absence or exposes mutation authority', (context) => {
  const current = fixture(context)
  const before = fs.readFileSync(current.journalPath)
  assert.throws(
    () => qualify({ ...current.config, mode: 'orphan-plan', park: true }, production),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  assert.throws(
    () =>
      qualify({
        ...current.config,
        mode: 'orphan-plan',
        expected: { kind: 'orphan-preparation-plan' },
      }, production),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  const holder = qualify({ ...current.config, mode: 'orphan-plan' }, production)
  try {
    assert.equal(JSON.parse(holder.observe()).proof.kind, 'orphan-preparation-plan')
    assert.equal(holder.repair, undefined)
    assert.deepEqual(fs.readFileSync(current.journalPath), before)
  } finally {
    holder.close()
  }
})

test('native repair rejects malformed envelopes and non-explicit parking before opening records', (context) => {
  for (const value of ['[]', 'null', '1', '{}', 'invalid'])
    assert.throws(
      () => production.open(value),
      (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
    )
  const current = fixture(context)
  assert.throws(
    () => production.open(JSON.stringify({ ...current.config, park: false })),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  assert.throws(
    () => production.open(JSON.stringify({ ...current.config, park: 1 })),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
})

test('native orphan qualification observes the machine failure shape under real locks without changing it', (context) => {
  const current = fixture(context)
  const before = fs.readFileSync(current.journalPath)
  const nativeState = fs.readFileSync(current.state)
  const holder = qualify(current.config)
  try {
    const result = JSON.parse(holder.observe())
    assert.equal(result.proof.kind, 'orphan-preparation-observation')
    assert.equal(result.proof.binding.requestId, current.config.binding.requestId)
    assert.deepEqual(Buffer.from(result.proof.journalBytes, 'base64'), before)
    assert.throws(
      () => repair.open(JSON.stringify(current.config)),
      (error) => error.code === 'ERR_TERMINAL_BUSY'
    )
    assert.throws(
      () => holder.repair(),
      (error) => error.code === 'ERR_TERMINAL_OBSERVATION'
    )
    assert.deepEqual(fs.readFileSync(current.journalPath), before)
    assert.deepEqual(fs.readFileSync(current.state), nativeState)
  } finally {
    holder.close()
  }
})

test('native orphan qualification resumes only its exact archived proof after both native records are retired', (context) => {
  const current = fixture(context)
  const holder = qualify(current.config)
  let proof
  try {
    proof = JSON.parse(holder.observe()).proof
  } finally {
    holder.close()
  }
  fs.writeFileSync(
    path.join(current.preparation, `superseded-${proof.journal.sha256}.plist`),
    Buffer.from(proof.journalBytes, 'base64'),
    { mode: 0o600 }
  )
  fs.writeFileSync(
    path.join(current.preparation, `superseded-state-${proof.state.sha256}.plist`),
    Buffer.from(proof.stateBytes, 'base64'),
    { mode: 0o600 }
  )
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', current.journalPath, '-'], {
    input: JSON.stringify({ schema: '1', record: {} }),
  })
  fs.chmodSync(current.journalPath, 0o600)
  fs.unlinkSync(current.state)
  const resumed = qualify({ ...current.config, expected: proof })
  try {
    assert.deepEqual(JSON.parse(resumed.observe()).proof, proof)
  } finally {
    resumed.close()
  }
  fs.writeFileSync(current.state, Buffer.from(proof.stateBytes, 'base64'), { mode: 0o600 })
  assert.throws(
    () => repair.open(JSON.stringify({ ...current.config, expected: proof })),
    (error) => error.code === 'ERR_TERMINAL_OBSERVATION'
  )
})

test('native handoff-only selection uses real persistent directory identities without a launch context', (context) => {
  const current = fixture(context)
  const native = require(path.join(path.dirname(library), 'lease.node'))
  current.config.selection.schema = 2
  current.config.selection.identities = current.config.selection.paths.map((directory) => {
    const pin = native.pin(directory, false)
    try {
      return native.persistentIdentity(pin)
    } finally {
      native.release(pin)
    }
  })
  const holder = qualify(current.config)
  try {
    const proof = JSON.parse(holder.observe()).proof
    assert.equal(proof.selection.schema, 2)
    assert.match(proof.selection.sha256, /^[a-f0-9]{64}$/)
  } finally {
    holder.close()
  }
})

async function withDeletedImage(directory, inspect, anonymousExecutable = false) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const executable = path.join(directory, 'mapped-sleep')
  execFileSync('/usr/bin/xcrun', ['clang', '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-x', 'c', '-', '-o', executable], {
    input: '#include <stdio.h>\n#include <unistd.h>\n#include <sys/mman.h>\n' +
      `int main(void) { ${anonymousExecutable ? 'if (mmap(0, getpagesize(), PROT_READ | PROT_EXEC, MAP_PRIVATE | MAP_ANON, -1, 0) == MAP_FAILED) return 2;' : ''} puts("ready"); fflush(stdout); for (;;) pause(); }\n`,
  })
  // Local fixture only, following the native contract executable recipe.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', executable])
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', executable])
  const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = once(child, 'exit')
  const ready = once(child.stdout, 'data')
  try {
    assert.equal((await Promise.race([ready.then(([data]) => data.toString()), finished.then(([code, signal]) => `exited:${code}:${signal}`)])).trim(), 'ready')
    fs.unlinkSync(executable)
    await inspect(child)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    child.kill('SIGTERM')
    await finished
  }
}

test('real kernel mappings allow deleted third-party images, refuse owned images and unknown anonymous executable memory', async (context) => {
  const current = fixture(context)
  const probe = path.join(path.dirname(current.config.state), 'mappings-probe')
  execFileSync('/usr/bin/xcrun', ['clang', '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64',
    '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-deprecated-declarations',
    '-framework', 'Foundation', path.join(__dirname, 'preflight.test.m'), '-o', probe])
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', probe])
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', probe])
  // Includes boundary/permission/submap rejection contracts on both architectures.
  execFileSync(probe, [path.join(path.dirname(probe), 'preflight-fixture')])
  for (const [owned, anonymousExecutable, expected] of [[false, false, 'absent'], [true, false, 'active'], [false, true, 'unknown']]) {
    const directory = owned ? path.join(current.config.target, 'Contents', 'MacOS') : path.join(path.dirname(current.config.source), 'third-party')
    await withDeletedImage(directory, (child) => {
      const observed = JSON.parse(execFileSync(probe, ['--mappings', String(child.pid), `${current.config.target}/Contents/`], { encoding: 'utf8' }))
      context.diagnostic(JSON.stringify({ arch: process.arch, expected, ...observed }))
      assert.equal(observed.activity, expected)
      assert.equal(observed.live, expected !== 'unknown')
      assert.equal(observed.mappings > 0, expected !== 'unknown')
      assert.ok(observed.mappingReads >= 1 && observed.mappingReads <= 2)
      if (expected !== 'unknown') {
        assert.equal(observed.mappingReads, 2)
        assert.equal(observed.mappingError, 0)
      }
    }, anonymousExecutable)
  }
})

test('deleted third-party image does not hide a running owned image or block unrelated recovery', async (context) => {
  const current = fixture(context)
  const foreign = path.join(path.dirname(current.config.source), 'third-party')
  const owned = path.join(current.config.target, 'Contents', 'MacOS')
  await withDeletedImage(foreign, async (thirdParty) => {
    repair.processScope([thirdParty.pid], 0)
    const holder = qualify(current.config)
    try { assert.equal(JSON.parse(holder.observe()).proof.kind, 'orphan-preparation-observation') }
    finally { holder.close() }
    await withDeletedImage(owned, (application) => {
      // Both inventory orders must retain the owned process rejection.
      for (const scope of [[thirdParty.pid, application.pid], [application.pid, thirdParty.pid]]) {
        repair.processScope(scope, 0)
        assert.throws(() => qualify(current.config), (error) => error.code === 'ERR_TERMINAL_OBSERVATION')
      }
    })
  })
})

test('denied mapped evidence fails closed without mutating native records', async (context) => {
  const current = fixture(context)
  const before = fs.readFileSync(current.journalPath)
  const state = fs.readFileSync(current.state)
  const entries = fs.readdirSync(current.preparation).sort()
  await withDeletedImage(path.join(path.dirname(current.config.source), 'permission-denied'), (child) => {
    repair.processScope([child.pid], child.pid)
    assert.throws(() => qualify(current.config), (error) =>
      error.code === 'ERR_TERMINAL_OBSERVATION' && error.systemCode === os.constants.errno.EBUSY)
    assert.ok(repair.mappingDenials() > 0, 'the ENOENT fallback must reach the injected EPERM')
    assert.deepEqual(fs.readFileSync(current.journalPath), before)
    assert.deepEqual(fs.readFileSync(current.state), state)
    assert.deepEqual(fs.readdirSync(current.preparation).sort(), entries)
    repair.processScope([child.pid], 0)
    const holder = qualify(current.config)
    try { assert.equal(JSON.parse(holder.observe()).proof.kind, 'orphan-preparation-observation') }
    finally { holder.close() }
  })
})

test('unknown anonymous executable memory rejects recovery through the real bridge', async (context) => {
  const current = fixture(context)
  await withDeletedImage(path.join(path.dirname(current.config.source), 'anonymous-executable'), (child) => {
    repair.processScope([child.pid], 0)
    assert.throws(() => qualify(current.config), (error) => error.code === 'ERR_TERMINAL_OBSERVATION')
  }, true)
})
