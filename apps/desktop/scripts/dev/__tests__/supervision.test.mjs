import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptReload, developmentArguments, finishHost, spawnWorker, nativeCache, main } from '../supervision.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import execution from '../../../../../scripts/shared/execution.cjs'
import debugging from '../../../../../scripts/dev/desktop.cjs'
import source from '../../../../../scripts/shared/source.cjs'

test('initial development watches source before snapshot or any compilation and closes the watcher on failure', async context => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarseed-startup-watch-'))
  const repo = await fs.realpath(temporary)
  const root = path.join(repo, 'apps', 'desktop')
  const isolation = { root: path.join(repo, 'debug'), home: path.join(repo, 'home'), profile: path.join(repo, 'profile') }
  for (const directory of [root, ...Object.values(isolation)]) await fs.mkdir(directory, { recursive: true })
  const previousHome = process.env.SCHOLARSEED_HOME
  process.env.SCHOLARSEED_HOME = isolation.home
  context.after(async () => {
    if (previousHome === undefined) delete process.env.SCHOLARSEED_HOME
    else process.env.SCHOLARSEED_HOME = previousHome
    await fs.rm(temporary, { recursive: true, force: true })
  })
  const stopped = new Error('stop before compilation')
  let watching = false
  let closed = false
  context.mock.method(debugging, 'debugPaths', () => isolation)
  context.mock.method(debugging, 'watchRestartSources', observed => {
    assert.equal(observed, repo)
    watching = true
    return () => { closed = true }
  })
  context.mock.method(source, 'developmentSourceSnapshot', () => {
    assert.equal(watching, true)
    throw stopped
  })
  await assert.rejects(main(['--remoteDebuggingPort', '43210', '--',
    '--remote-debugging-address=127.0.0.1', `--user-data-dir=${isolation.profile}`], root), error => error === stopped)
  assert.equal(closed, true)
  assert.deepEqual(await fs.readdir(isolation.root), [])
})

async function cacheFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarseed-native-cache-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'node_modules'))
  return fs.realpath(root)
}

test('native cache reuses identical bytes and concurrent publication without replacing loaded paths', async context => {
  const root = await cacheFixture(context)
  const bytes = Buffer.from('native fixture')
  const results = await Promise.all(Array.from({ length: 8 }, () => nativeCache(bytes, root)))
  assert.equal(new Set(results.map(result => result.library)).size, 1)
  assert.equal(await fs.readFile(results[0].library, 'utf8'), 'native fixture')
  const before = await fs.stat(results[0].library, { bigint: true })
  const reused = await nativeCache(bytes, root)
  assert.equal((await fs.stat(reused.library, { bigint: true })).ino, before.ino)
  const changed = await nativeCache(Buffer.from('next native fixture'), root)
  assert.notEqual(changed.directory, reused.directory)
  assert.equal(await fs.readFile(reused.library, 'utf8'), 'native fixture')
  assert.equal((await fs.readdir(path.dirname(reused.directory))).length, 2)
})

test('native cache rejects corrupted or linked entries without replacing them', async context => {
  const root = await cacheFixture(context)
  const bytes = Buffer.from('native fixture')
  const entry = await nativeCache(bytes, root)
  await fs.writeFile(entry.library, 'external content')
  await assert.rejects(nativeCache(bytes, root), /cache/)
  assert.equal(await fs.readFile(entry.library, 'utf8'), 'external content')
  await fs.unlink(entry.library)
  const other = path.join(root, 'other')
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'retained.node'), bytes)
  await fs.symlink(other, entry.library, 'junction')
  await assert.rejects(nativeCache(bytes, root), /cache/)
  assert.equal(await fs.realpath(entry.library), await fs.realpath(other))
  assert.equal(await fs.readFile(path.join(other, 'retained.node'), 'utf8'), bytes.toString())
})

test('native cache refuses redirected ancestors and unexpected files in digest directory', async context => {
  const root = await cacheFixture(context)
  const bytes = Buffer.from('native fixture')
  const entry = await nativeCache(bytes, root)
  await fs.writeFile(path.join(entry.directory, 'external'), 'retain')
  await assert.rejects(nativeCache(bytes, root), /cache/)
  const cache = path.join(root, 'node_modules/.cache')
  const retained = path.join(root, 'retained-cache')
  await fs.rename(cache, retained)
  await fs.symlink(retained, cache, 'junction')
  await assert.rejects(nativeCache(bytes, root), /cache/)
  assert.equal(await fs.readFile(path.join(entry.directory.replace(cache, retained), 'external'), 'utf8'), 'retain')
})

function fixture() {
  const events = []
  const messages = []
  let revision = 1
  const instance = { control: {
    quiesceIfIdle: async () => { events.push('idle'); return 'generation' },
    resume: async () => { events.push('resume') },
    exit: async () => { events.push('exit') }
  } }
  const state = { instance, pending: null, dirty: true, disabled: false }
  const operations = {
    canRestart: true,
    snapshot: () => revision,
    unchanged: (left, right) => left === right,
    compile: async () => { events.push('compile'); return {} },
    dispose: async () => { events.push('dispose') },
    stopped: async () => { events.push('stopped') },
    publish: async () => { events.push('publish'); return {
      commit: async () => { events.push('commit') }, rollback: async () => { events.push('rollback') }
    } },
    launch: async () => { events.push('launch'); return { control: instance.control } },
    ready: async () => { events.push('ready') },
    report: message => { events.push('report'); messages.push(message) },
    rejected: error => error.message === 'busy'
  }
  return { state, operations, events, messages, change: () => { revision++ } }
}

test('reload compiles before admission and publishes only after actual stop', async () => {
  const { state, operations, events } = fixture()
  await attemptReload(state, operations)
  assert.deepEqual(events, ['compile', 'idle', 'exit', 'stopped', 'publish', 'launch', 'ready', 'commit', 'dispose', 'report'])
  assert.equal(state.pending, null)
})

test('busy retains the compiled candidate and never rebuilds while retrying', async () => {
  const { state, operations, events } = fixture()
  state.instance.control.quiesceIfIdle = async () => { throw new Error('busy') }
  await attemptReload(state, operations)
  await attemptReload(state, operations)
  assert.equal(events.filter(event => event === 'compile').length, 1)
  assert.equal(events.includes('exit'), false)
  assert.ok(state.pending)
})

test('changed source after admission resumes and preserves the original instance', async () => {
  const { state, operations, events, change } = fixture()
  state.instance.control.quiesceIfIdle = async () => { change(); return 'generation' }
  await attemptReload(state, operations)
  assert.ok(events.includes('resume'))
  assert.equal(events.includes('exit'), false)
  assert.equal(events.includes('publish'), false)
  assert.equal(state.dirty, true)
})

test('compile failure and unknown admission never stop the current instance', async () => {
  for (const stage of ['compile', 'idle']) {
    const { state, operations, events } = fixture()
    if (stage === 'compile') operations.compile = async () => { throw new Error('syntax') }
    else state.instance.control.quiesceIfIdle = async () => { throw new Error('unknown') }
    await attemptReload(state, operations)
    assert.equal(events.includes('exit'), false)
    assert.equal(events.includes('publish'), false)
    assert.equal(state.disabled, stage === 'idle')
  }
})

test('an unconfirmed child exit prevents publication and disables automatic reload', async () => {
  const { state, operations, events } = fixture()
  operations.stopped = async () => { throw new Error('still live') }
  await attemptReload(state, operations)
  assert.equal(events.includes('publish'), false)
  assert.equal(state.disabled, true)
})

test('live replacement readiness failure preserves pending publication without killing or rollback', async () => {
  const { state, operations, events } = fixture()
  operations.ready = async () => { throw new Error('readiness unknown') }
  await attemptReload(state, operations)
  assert.equal(events.includes('rollback'), false)
  assert.ok(state.publication)
  assert.equal(state.disabled, true)
})

test('restart without a platform family proof is refused before admission', async () => {
  const { state, operations, events } = fixture()
  operations.canRestart = false
  await attemptReload(state, operations)
  assert.deepEqual(events, ['report'])
  assert.equal(state.disabled, true)
})

test('host accepts only the isolated debug argument shape', () => {
  const args = ['--remoteDebuggingPort', '9222', '--', '--remote-debugging-address=127.0.0.1', '--user-data-dir=/tmp/profile']
  assert.equal(developmentArguments(args).port, 9222)
  for (const invalid of [[], [...args, '--no-sandbox'], args.map(value => value === '9222' ? '0' : value), args.map(value => value === '--user-data-dir=/tmp/profile' ? '--user-data-dir=relative' : value)]) {
    assert.throws(() => developmentArguments(invalid))
  }
})

test('source mutation during compilation never requests admission', async () => {
  const { state, operations, events, change } = fixture()
  operations.compile = async () => { change(); return {} }
  await attemptReload(state, operations)
  assert.deepEqual(events, ['dispose', 'report'])
  assert.equal(state.dirty, true)
})

test('source snapshot failures are diagnosed separately from candidate compilation errors', async () => {
  const { state, operations, messages } = fixture()
  let snapshots = 0
  operations.snapshot = () => { if (++snapshots > 1) throw new Error('source in motion'); return 1 }
  await attemptReload(state, operations)
  assert.ok(messages.some(message => /source snapshot/i.test(message)))
  assert.equal(messages.some(message => /compilation failed/i.test(message)), false)
})

test('source mutation after old exit restores the old launch without publishing', async () => {
  const { state, operations, events, change } = fixture()
  operations.stopped = async () => { events.push('stopped'); change() }
  await attemptReload(state, operations)
  assert.equal(events.includes('publish'), false)
  assert.ok(events.includes('launch'))
  assert.equal(state.dirty, true)
})

test('a replacement which actually exited rolls back before restarting old outputs', async () => {
  const { state, operations, events } = fixture()
  let launches = 0
  operations.launch = async () => { events.push('launch'); launches++; return { control: {} } }
  operations.ready = async () => { events.push('ready'); if (launches === 1) throw new Error('child exited') }
  operations.terminated = () => true
  await attemptReload(state, operations)
  assert.ok(events.indexOf('rollback') > events.indexOf('stopped', events.indexOf('launch')))
  assert.equal(launches, 2)
  assert.equal(state.publication, null)
  assert.equal(state.pending, null)
})

test('interruption after compilation never exits or replaces the original child', async () => {
  const { state, operations, events } = fixture()
  let interrupted = false
  operations.compile = async () => { interrupted = true; return {} }
  operations.interrupted = () => interrupted
  await attemptReload(state, operations)
  assert.equal(events.includes('idle'), false)
  assert.equal(events.includes('exit'), false)
  assert.equal(events.includes('launch'), false)
})

test('interruption after old exit never launches a replacement', async () => {
  const { state, operations, events } = fixture()
  let interrupted = false
  operations.stopped = async () => { interrupted = true }
  operations.interrupted = () => interrupted
  await attemptReload(state, operations)
  assert.equal(events.includes('publish'), false)
  assert.equal(events.includes('launch'), false)
})

test('proven publication rollback restarts old outputs after their original process stopped', async () => {
  const { state, operations, events } = fixture()
  operations.publish = async () => { events.push('publish'); throw new Error('restored') }
  operations.publicationRestored = error => error.message === 'restored'
  await attemptReload(state, operations)
  assert.ok(events.includes('launch'))
  assert.ok(events.includes('ready'))
  assert.equal(state.pending, null)
})

test('replacement launch rejection rolls back only after the stopped-instance proof', async () => {
  const { state, operations, events } = fixture()
  let attempts = 0
  operations.launch = async () => { events.push('launch'); if (++attempts === 1) throw new Error('not spawned'); return {} }
  operations.terminated = () => true
  await attemptReload(state, operations)
  assert.ok(events.includes('rollback'))
  assert.equal(attempts, 2)
  assert.equal(state.publication, null)
})

function shutdownFixture() {
  const events = []
  const state = { instance: { result: { status: 0 }, control: { close: () => { events.push('control-close') } } }, publication: null }
  const operations = {
    interrupted: false,
    closeWatcher: () => { events.push('watcher-close') },
    signal: () => { events.push('signal') },
    stopped: async () => { events.push('stopped') },
    receipt: async phase => { events.push('receipt-' + phase) },
    closeRenderer: async () => { events.push('renderer-close') },
    dispose: async () => { events.push('dispose') },
    removeReceipt: async () => { events.push('receipt-remove') }
  }
  return { state, operations, events }
}

test('natural child exit still proves family termination before removing its receipt', async () => {
  const { state, operations, events } = shutdownFixture()
  assert.equal(await finishHost(state, operations), null)
  assert.ok(events.indexOf('stopped') < events.indexOf('control-close'))
  assert.ok(events.includes('receipt-remove'))
  assert.equal(events.includes('signal'), false)
})

test('unconfirmed shutdown records ownership before closing IPC and always returns reserved status', async () => {
  const { state, operations, events } = shutdownFixture()
  operations.stopped = async () => { throw new Error('group retained') }
  assert.equal(await finishHost(state, operations), execution.PROCESS_TREE_UNCONFIRMED_EXIT)
  assert.ok(events.indexOf('receipt-retained') < events.indexOf('control-close'))
  assert.equal(events.includes('receipt-remove'), false)
  assert.equal(events.includes('dispose'), false)
})

test('cleanup failures cannot hide the reserved unconfirmed status or remove ownership evidence', async () => {
  for (const failure of ['closeWatcher', 'closeRenderer', 'dispose', 'removeReceipt']) {
    const { state, operations, events } = shutdownFixture()
    operations[failure] = async () => { throw new Error(failure) }
    assert.equal(await finishHost(state, operations), execution.PROCESS_TREE_UNCONFIRMED_EXIT)
    assert.ok(events.includes('receipt-retained'))
  }
  const { state, operations } = shutdownFixture()
  state.instance.control.close = () => { throw new Error('IPC cleanup uncertain') }
  assert.equal(await finishHost(state, operations), execution.PROCESS_TREE_UNCONFIRMED_EXIT)
})

test('known stopped replacement rolls back its pending publication before cleanup', async () => {
  const { state, operations, events } = shutdownFixture()
  state.publication = { rollback: async options => {
    assert.equal(options.previousStopped, true)
    events.push('rollback')
  } }
  assert.equal(await finishHost(state, operations), null)
  assert.ok(events.indexOf('stopped') < events.indexOf('rollback'))
  assert.ok(events.indexOf('rollback') < events.indexOf('control-close'))
  assert.equal(state.publication, null)
})

test('rollback failure retains pending outputs and its ownership receipt', async () => {
  const { state, operations, events } = shutdownFixture()
  state.publication = { rollback: async () => { throw new Error('canonical changed') } }
  assert.equal(await finishHost(state, operations), execution.PROCESS_TREE_UNCONFIRMED_EXIT)
  assert.ok(state.publication)
  assert.equal(events.includes('receipt-remove'), false)
  assert.equal(events.includes('dispose'), false)
})

test('explicit interruption still terminates an occupied Job after its worker has exited', async () => {
  const { state, operations, events } = shutdownFixture()
  state.instance.family = { active: () => 1 }
  operations.interrupted = 'SIGINT'
  assert.equal(await finishHost(state, operations), null)
  assert.ok(events.includes('signal'))
})

test('real worker creation is gated by native assignment before forwarding bootstrap', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarseed-worker-host-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const evidence = path.join(root, 'started')
  await fs.writeFile(path.join(root, 'index.js'), `process.stdin.once('data',()=>{require('node:fs').writeFileSync(${JSON.stringify(evidence)},'started');process.exit(7)})`)
  let assignments = 0
  const family = { active: () => 0, close: () => {}, terminate: () => {} }
  const instance = spawnWorker({ executable: process.execPath, root,
    settings: { port: 9222, profile: path.join(root, 'profile') }, environment: { ...process.env, NODE_OPTIONS: '--require=scholarseed-missing-preload' },
    bootstrap: Buffer.from('{"version":1,"port":1,"token":"' + 'a'.repeat(64) + '"}\n'),
    control: { close: () => {} }, native: { openFamily: pid => { assert.ok(pid > 0); assignments++; return family } }
  })
  context.after(async () => {
    if (!instance.result) { instance.child.kill(); await instance.closed }
    instance.child.stdin.destroy()
  })
  await instance.prepared
  await instance.closed
  assert.equal(assignments, 1)
  assert.equal(instance.family, family)
  assert.equal(instance.result.status, 7)
  assert.equal(instance.protocolError, false)
  assert.equal(await fs.readFile(evidence, 'utf8'), 'started')
})

test('failed native assignment cannot release the real worker to spawn a child', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarseed-worker-refusal-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const evidence = path.join(root, 'started')
  await fs.writeFile(path.join(root, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(evidence)},'bad')`)
  const instance = spawnWorker({ executable: process.execPath, root,
    settings: { port: 9222, profile: path.join(root, 'profile') }, environment: { ...process.env, NODE_OPTIONS: '' },
    bootstrap: Buffer.from('{}\n'), control: { close: () => {} },
    native: { openFamily: () => { throw new Error('native family attach rejected') } }
  })
  await assert.rejects(instance.prepared)
  await instance.closed
  instance.child.stdin.destroy()
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
})
