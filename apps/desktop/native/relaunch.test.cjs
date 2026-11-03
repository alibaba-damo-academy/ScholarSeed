const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { execFileSync } = require('node:child_process')
const native = require(process.env.SCHOLARSEED_LEASE_LIBRARY)
const {
  SquirrelInstallation,
  discardOnTerminalSquirrelFailure,
  readSquirrelHandoff,
} = require('../src/main/squirrel.ts')
const {
  persistUpdateLaunch,
  restoreUpdateLaunch,
  updateLaunchDirectory,
} = require('../src/main/relaunch.ts')

const SOURCE = '202610120719'
const TARGET = '202610121003'
const CANDIDATE = 'release-candidate'
const NOW = 1000
const DAY = 24 * 60 * 60 * 1000
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'update-launch-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const coordinator = path.join(root, 'coordination')
  const selection = {
    home: path.join(root, 'home'),
    userData: path.join(root, 'profile 中文'),
    workspace: path.join(root, 'workspace'),
  }
  for (const p of [coordinator, ...Object.values(selection)]) fs.mkdirSync(p, { mode: 0o700 })
  const identity = {
    uid: os.userInfo().uid,
    application: path.join(root, 'ScholarSeed.app'),
    bundleId: 'com.scholarseed.desktop',
    build: SOURCE,
  }
  const persist = () =>
    persistUpdateLaunch(native, coordinator, identity, selection, TARGET, CANDIDATE, NOW)
  const restore = (build = TARGET, explicit = {}) =>
    restoreUpdateLaunch(native, coordinator, { ...identity, build }, explicit)
  return {
    root,
    coordinator,
    selection,
    identity,
    persist,
    restore,
    record: path.join(updateLaunchDirectory(coordinator, identity.application), 'context.json'),
  }
}

test(
  'persistent identity comes from the pinned directory and survives a new process',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    const pin = native.pin(f.selection.workspace, false)
    const stable = native.persistentIdentity(pin)
    assert.match(stable, /^darwin:[a-f0-9]{32}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{8}$/)
    const metadata = fs.statSync(f.selection.workspace, { bigint: true })
    assert.equal(BigInt(`0x${stable.split(':')[2]}`), metadata.ino)
    const child = execFileSync(
      process.execPath,
      [
        '-e',
        'const n=require(process.argv[1]);const p=n.pin(process.argv[2],false);try{process.stdout.write(n.persistentIdentity(p))}finally{n.release(p)}',
        process.env.SCHOLARSEED_LEASE_LIBRARY,
        f.selection.workspace,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(child, stable)
    fs.renameSync(f.selection.workspace, `${f.selection.workspace}-old`)
    fs.mkdirSync(f.selection.workspace, { mode: 0o700 })
    // The existing pin must still observe the original inode, not reopen the path.
    assert.equal(native.persistentIdentity(pin), stable)
    native.release(pin)
    assert.throws(() => native.persistentIdentity(pin), { code: 'ERR_LEASE_CLOSED' })
    const replacement = native.pin(f.selection.workspace, false)
    try {
      assert.notEqual(native.persistentIdentity(replacement), stable)
    } finally {
      native.release(replacement)
    }
  }
)

test(
  'native update context restores when only runtime device numbers are renumbered',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    f.persist()
    const changedDevice = Object.create(native)
    Object.defineProperty(changedDevice, 'lineage', {
      value: (pin) =>
        native.lineage(pin).map((id) => id.replace(/^posix:[^:]+:/, 'posix:ffffffffffffffff:')),
    })
    const restored = restoreUpdateLaunch(
      changedDevice,
      f.coordinator,
      { ...f.identity, build: TARGET },
      {}
    )
    assert.equal(restored.context.schema, 2)
    assert.equal(restored.context.workspace, f.selection.workspace)
    restored.complete()
    assert.equal(fs.existsSync(f.record), false)
  }
)

test(
  'native one-shot restore preserves physical home/profile/workspace and waits for target',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    assert.equal(f.restore(), null)
    f.persist()
    const recovery = f.restore(SOURCE)
    assert.equal(recovery.context.home, f.selection.home)
    recovery.complete()
    assert.ok(fs.existsSync(f.record))
    const result = f.restore()
    assert.deepEqual(
      [result.context.home, result.context.userData, result.context.workspace],
      Object.values(f.selection)
    )
    result.complete()
    assert.equal(f.restore(), null)
  }
)
test(
  'replacement, wrong target and symlink record fail closed before selecting defaults',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    f.persist()
    assert.throws(() => f.restore('202610121004'), /build differs/)
    fs.renameSync(f.selection.userData, `${f.selection.userData}-old`)
    fs.mkdirSync(f.selection.userData, { mode: 0o700 })
    assert.throws(() => f.restore(), /directory was replaced/)
    fs.rmSync(f.record)
    fs.symlinkSync(path.join(f.root, 'missing'), f.record)
    assert.throws(() => f.restore())
  }
)
test(
  'explicit startup conflicts and aged records preserve the original profile',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    f.persist()
    assert.throws(
      () => f.restore(TARGET, { userData: '/Users/explicit/profile' }),
      /selection differs/
    )
    assert.equal(fs.existsSync(f.record), true)
    const record = JSON.parse(fs.readFileSync(f.record, 'utf8'))
    fs.writeFileSync(f.record, JSON.stringify({ ...record, at: Date.now() - DAY * 2 }), {
      mode: 0o600,
    })
    const recovered = f.restore(TARGET, { home: f.selection.home })
    assert.equal(recovered.context.userData, f.selection.userData)
    recovered.complete()
    assert.equal(fs.existsSync(f.record), false)
  }
)

test(
  'interrupted publication is ignored and identical native retry retains the original context',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    fs.mkdirSync(path.dirname(f.record), { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${f.record}.crashed.tmp`, '{', { mode: 0o600 })
    assert.equal(f.restore(), null)
    f.persist()
    const before = fs.readFileSync(f.record)
    f.persist()()
    assert.deepEqual(fs.readFileSync(f.record), before)
    const restored = f.restore()
    const changed = JSON.parse(fs.readFileSync(f.record, 'utf8'))
    changed.candidate = 'different-candidate'
    fs.writeFileSync(f.record, JSON.stringify(changed), { mode: 0o600 })
    assert.throws(() => restored.complete(), /context changed/)
    assert.ok(fs.existsSync(f.record))
  }
)

test(
  'native installed-target handoff fences old cleanup and validates directory identity',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    f.persist()
    // Rollback must retain the original bytes, including valid legacy formatting.
    fs.writeFileSync(f.record, JSON.stringify(JSON.parse(fs.readFileSync(f.record)), null, 2), {
      mode: 0o600,
    })
    const original = fs.readFileSync(f.record)
    const previous = f.restore()
    const installed = { ...f.identity, build: TARGET }
    const publish = () =>
      persistUpdateLaunch(
        native,
        f.coordinator,
        installed,
        f.selection,
        '202610131003',
        'next-candidate',
        NOW + 1,
        []
      )
    fs.renameSync(f.selection.workspace, `${f.selection.workspace}-old`)
    fs.mkdirSync(f.selection.workspace, { mode: 0o700 })
    const before = fs.readFileSync(f.record)
    assert.throws(publish, /identity or storage differs/)
    assert.deepEqual(fs.readFileSync(f.record), before)
    fs.rmdirSync(f.selection.workspace)
    fs.renameSync(`${f.selection.workspace}-old`, f.selection.workspace)
    const cancel = publish()
    assert.equal(JSON.parse(fs.readFileSync(f.record)).candidate, 'next-candidate')
    assert.throws(() => previous.complete(), /context changed/)
    cancel()
    assert.deepEqual(fs.readFileSync(f.record), original)
    assert.equal(f.restore().context.userData, f.selection.userData)
    previous.complete()
    assert.equal(fs.existsSync(f.record), false)
  }
)

test(
  'native retry cancellation retains context but terminal Squirrel failure consumes it',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t)
    f.persist()
    const retry = f.persist()
    retry()
    assert.equal(fs.existsSync(f.record), true)
    const handoff = path.join(f.root, 'handoff.json')
    const archivePath = path.join(f.root, 'application.zip')
    const bytes = Buffer.from('protocol fixture, not product acceptance')
    fs.writeFileSync(archivePath, bytes)
    const updater = new EventEmitter()
    updater.setFeedURL = () => {}
    updater.checkForUpdates = () => updater.emit('error', new Error('native rejection'))
    updater.quitAndInstall = () => assert.fail('terminal failure cannot restart')
    let cleanup = retry
    const installation = new SquirrelInstallation(updater, handoff, (event) => {
      cleanup = discardOnTerminalSquirrelFailure(event, cleanup)
    })
    await assert.rejects(
      installation.prepare(
        {
          path: archivePath,
          size: bytes.length,
          sha512: createHash('sha512').update(bytes).digest('hex'),
        },
        {
          version: '0.3.0',
          buildNumber: TARGET,
          candidate: CANDIDATE,
          at: NOW,
          state: 'requested',
        },
        async () => () => {}
      ),
      /outcome unknown/
    )
    assert.equal(readSquirrelHandoff(handoff).state, 'failed')
    assert.equal(cleanup, undefined)
    assert.equal(fs.existsSync(f.record), false)
  }
)

test(
  'Squirrel handoff publication failure restores the previous native launch context',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t)
    f.persist()
    const original = fs.readFileSync(f.record)
    const previous = f.restore()
    const handoff = path.join(f.root, 'handoff.json')
    fs.mkdirSync(handoff, { mode: 0o700 })
    const archivePath = path.join(f.root, 'application.zip')
    const bytes = Buffer.from('handoff failure protocol fixture')
    fs.writeFileSync(archivePath, bytes)
    const updater = new EventEmitter()
    updater.setFeedURL = () => {}
    updater.checkForUpdates = () => assert.fail('handoff must be durable before native start')
    const installation = new SquirrelInstallation(updater, handoff, () => {})
    let cancel
    await assert.rejects(
      installation.prepare(
        {
          path: archivePath,
          size: bytes.length,
          sha512: createHash('sha512').update(bytes).digest('hex'),
        },
        {
          version: '0.3.0',
          buildNumber: '202610131003',
          candidate: 'next',
          at: NOW,
          state: 'requested',
        },
        async () => () => {
          cancel = persistUpdateLaunch(
            native,
            f.coordinator,
            { ...f.identity, build: TARGET },
            f.selection,
            '202610131003',
            'next',
            NOW + 1,
            []
          )
        }
      )
    )
    assert.equal(installation.committed, false)
    cancel()
    installation.dispose()
    assert.deepEqual(fs.readFileSync(f.record), original)
    assert.equal(f.restore().context.userData, f.selection.userData)
    previous.complete()
    assert.equal(fs.existsSync(f.record), false)
  }
)

test(
  'native replacement rollback is fenced and never resurrects a consumed context',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    f.persist()
    const original = fs.readFileSync(f.record)
    const replace = () =>
      persistUpdateLaunch(
        native,
        f.coordinator,
        { ...f.identity, build: TARGET },
        f.selection,
        '202610131003',
        'next',
        NOW + 1,
        []
      )
    const cancel = replace()
    const next = fs.readFileSync(f.record)
    fs.writeFileSync(f.record, JSON.stringify({ ...JSON.parse(next), candidate: 'other' }), {
      mode: 0o600,
    })
    const changed = fs.readFileSync(f.record)
    assert.throws(cancel, /context changed/)
    assert.deepEqual(fs.readFileSync(f.record), changed)
    fs.writeFileSync(f.record, next, { mode: 0o600 })
    discardOnTerminalSquirrelFailure('native-error', cancel)
    assert.deepEqual(fs.readFileSync(f.record), original)
    const second = replace()
    restoreUpdateLaunch(
      native,
      f.coordinator,
      { ...f.identity, build: '202610131003' },
      {}
    ).complete()
    second()
    assert.equal(fs.existsSync(f.record), false)
  }
)
