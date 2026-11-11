const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const test = require('node:test')

const library = process.env.SCHOLARSEED_REPAIR_LIBRARY
if (process.platform !== 'darwin' || !library)
  throw new Error('Native repair tests require the built Darwin repair.node')
const repair = require(library)

function qualify(config) {
  try {
    return repair.open(JSON.stringify(config))
  } catch (error) {
    error.message = `${error.code} systemCode=${error.systemCode}`
    throw error
  }
}

function fixture(context) {
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

test('background repair planning never claims process absence or exposes mutation authority', (context) => {
  const current = fixture(context)
  const before = fs.readFileSync(current.journalPath)
  assert.throws(
    () => qualify({ ...current.config, mode: 'orphan-plan', park: true }),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  assert.throws(
    () =>
      qualify({
        ...current.config,
        mode: 'orphan-plan',
        expected: { kind: 'orphan-preparation-plan' },
      }),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  const holder = qualify({ ...current.config, mode: 'orphan-plan' })
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
      () => repair.open(value),
      (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
    )
  const current = fixture(context)
  assert.throws(
    () => repair.open(JSON.stringify({ ...current.config, park: false })),
    (error) => error.code === 'ERR_TERMINAL_ARGUMENT'
  )
  assert.throws(
    () => repair.open(JSON.stringify({ ...current.config, park: 1 })),
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
