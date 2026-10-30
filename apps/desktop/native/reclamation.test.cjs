const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const policy = require('./toolchain.json')
const { reclaimCoordination } = require('./reclamation.cjs')

const library = process.env.SCHOLARSEED_LEASE_LIBRARY
assert.ok(library && path.isAbsolute(library), 'select the real compiled native library')
assert.equal(process.versions.node, policy.node, 'run with the reviewed Node')
const api = require(library)
const TIMEOUT = 20000
const SUFFIXES = ['admission-a', 'admission-b', 'occupancy-a', 'occupancy-b']
const EMPTY = { removed: 0, busy: false, retained: false }

function fixture(t, suffixes = SUFFIXES) {
  // Native creation establishes the protocol's private Windows DACL; chmod
  // cannot make an inherited Windows temp-directory ACL private.
  const root = path.join(fs.realpathSync(os.tmpdir()), `reclamation-${randomUUID()}`)
  const pin = api.pin(root, true)
  const identity = api.identity(pin).replaceAll(':', '-')
  const name = suffix => `${identity}-${suffix}`
  const file = suffix => path.join(root, name(suffix))
  for (const suffix of suffixes) api.release(api.acquireAt(pin, name(suffix), false))
  t.after(() => {
    api.release(pin)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, pin, identity, name, file, collect: () => api.reclaimAt(pin, identity) }
}

function identities(fx) {
  return Object.fromEntries(SUFFIXES.map(suffix => [suffix, fs.statSync(fx.file(suffix)).ino]))
}

test('idle collection preserves the permanent guard and unrelated files; repeat is existing-only', t => {
  const fx = fixture(t)
  const guard = fs.statSync(fx.file('admission-a')).ino
  fs.writeFileSync(fx.file('families'), '')
  fs.writeFileSync(path.join(fx.root, 'user-content'), 'preserve')
  assert.deepEqual(fx.collect(), { ...EMPTY, removed: 3 })
  assert.equal(fs.statSync(fx.file('admission-a')).ino, guard)
  assert.deepEqual(fs.readdirSync(fx.root).sort(), [fx.name('admission-a'), fx.name('families'), 'user-content'].sort())
  assert.deepEqual(fx.collect(), EMPTY)
})

test('missing guard cannot authorize collection and never gets recreated', t => {
  const fx = fixture(t, ['occupancy-b'])
  assert.deepEqual(fx.collect(), { ...EMPTY, retained: true })
  assert.deepEqual(fs.readdirSync(fx.root), [fx.name('occupancy-b')])
})

test('partial prior collection resumes without recreating missing siblings', t => {
  const fx = fixture(t, ['admission-a', 'occupancy-b'])
  assert.deepEqual(fx.collect(), { ...EMPTY, removed: 1 })
  assert.deepEqual(fx.collect(), EMPTY)
  assert.deepEqual(fs.readdirSync(fx.root), [fx.name('admission-a')])
})

for (const suffix of SUFFIXES) {
  for (const exclusive of [false, true]) {
    test(`held ${exclusive ? 'exclusive' : 'shared'} ${suffix} retains the whole group`, t => {
      const fx = fixture(t)
      const before = identities(fx)
      const held = api.acquireAt(fx.pin, fx.name(suffix), exclusive)
      try {
        assert.deepEqual(fx.collect(), { ...EMPTY, busy: true })
        assert.deepEqual(identities(fx), before)
        if (suffix === 'occupancy-a') {
          // The busy occupancy probe must return without taking admission.
          const admission = api.acquireAt(fx.pin, fx.name('admission-a'), true)
          api.release(admission)
        }
      } finally {
        api.release(held)
      }
      assert.deepEqual(fx.collect(), { ...EMPTY, removed: 3 })
    })
  }
}

for (const unsafe of ['nonempty', 'hardlink', 'directory', 'symlink']) {
  test(`${unsafe} final candidate prevents all sibling deletion`, { skip: unsafe === 'symlink' && process.platform === 'win32' }, t => {
    const fx = fixture(t)
    const candidate = fx.file('occupancy-b')
    const other = path.join(fx.root, 'protected')
    if (unsafe === 'nonempty') fs.writeFileSync(candidate, 'preserve')
    if (unsafe === 'hardlink') fs.linkSync(candidate, other)
    if (unsafe === 'directory') { fs.unlinkSync(candidate); fs.mkdirSync(candidate, { mode: 0o700 }) }
    if (unsafe === 'symlink') { fs.writeFileSync(other, 'preserve'); fs.unlinkSync(candidate); fs.symlinkSync(other, candidate) }
    const before = fs.readdirSync(fx.root).sort()
    assert.deepEqual(fx.collect(), { ...EMPTY, retained: true })
    assert.deepEqual(fs.readdirSync(fx.root).sort(), before)
    if (unsafe === 'nonempty') assert.equal(fs.readFileSync(candidate, 'utf8'), 'preserve')
    if (unsafe === 'symlink') assert.equal(fs.readFileSync(other, 'utf8'), 'preserve')
  })
}

test('nonempty admission and occupancy probe are retained', t => {
  for (const suffix of ['admission-a', 'occupancy-a']) {
    const fx = fixture(t)
    fs.writeFileSync(fx.file(suffix), 'not a vacant protocol slot')
    assert.deepEqual(fx.collect(), { ...EMPTY, retained: true })
    assert.equal(fs.readdirSync(fx.root).length, SUFFIXES.length)
  }
})

test('unsafe sibling permissions retain the complete group', { skip: process.platform === 'win32' }, t => {
  const fx = fixture(t)
  fs.chmodSync(fx.file('occupancy-b'), 0o666)
  assert.deepEqual(fx.collect(), { ...EMPTY, retained: true })
  assert.equal(fs.readdirSync(fx.root).length, SUFFIXES.length)
})

test('rejects malformed identities and project-role pins', t => {
  const fx = fixture(t)
  for (const invalid of ['', '../slot', `${fx.identity}-occupancy-a`, fx.identity.toUpperCase(), 'posix-0-0', 'windows-0000000000000000-0000000000000000']) {
    assert.throws(() => api.reclaimAt(fx.pin, invalid), { code: 'ERR_LEASE_ARGUMENT' })
  }
  const project = api.pin(fx.root, false, 'project')
  try { assert.throws(() => api.reclaimAt(project, fx.identity), { code: 'ERR_LEASE_ARGUMENT' }) }
  finally { api.release(project) }
})

function launch(t, executable, args) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exit = once(child, 'exit').then(([code]) => {
    assert.equal(code, 0, errors)
  })
  // Attach a handler immediately so an early failure is not an unhandled promise.
  exit.catch(() => {})
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  t.after(() => { if (child.exitCode === null) child.kill() })
  return { child, exit, line: async () => {
    const next = await lines.next()
    assert.equal(next.done, false, errors)
    return next.value
  } }
}

test('legacy Python opener retains admission across pre-open gap, then remains protected by occupancy',
  { skip: process.platform === 'win32', timeout: TIMEOUT }, async t => {
    const fx = fixture(t)
    const before = identities(fx)
    const script = `import os,sys,fcntl
root,identity=sys.argv[1:]
guard=os.open(os.path.join(root,identity+'-admission-a'),os.O_RDWR)
fcntl.flock(guard,fcntl.LOCK_SH|fcntl.LOCK_NB)
occupancy=os.open(os.path.join(root,identity+'-occupancy-a'),os.O_RDWR)
assert os.fstat(occupancy).st_nlink == 1
print('opened',flush=True)
sys.stdin.readline()
fcntl.flock(occupancy,fcntl.LOCK_SH|fcntl.LOCK_NB)
os.close(guard)
print('occupied',flush=True)
sys.stdin.readline()
os.close(occupancy)
`
    const peer = launch(t, process.env.SCHOLARSEED_RECLAIM_PYTHON || 'python3', ['-c', script, fx.root, fx.identity])
    assert.equal(await peer.line(), 'opened')
    assert.deepEqual(fx.collect(), { ...EMPTY, busy: true })
    assert.deepEqual(identities(fx), before)
    peer.child.stdin.write('continue\n')
    assert.equal(await peer.line(), 'occupied')
    assert.deepEqual(fx.collect(), { ...EMPTY, busy: true })
    assert.deepEqual(identities(fx), before)
    peer.child.stdin.end('finish\n')
    await peer.exit
    assert.deepEqual(fx.collect(), { ...EMPTY, removed: 3 })
  })

test('two real collectors serialize through the permanent guard', { timeout: TIMEOUT }, async t => {
  const fx = fixture(t)
  const script = `const n=require(process.argv[1]);const p=n.pin(process.argv[2],false);
    console.log('ready');process.stdin.once('data',()=>{let removed=0;
    for(let i=0;i<20;i++)removed+=n.reclaimAt(p,process.argv[3]).removed;
    n.release(p);console.log(JSON.stringify({removed}));});`
  const peers = [0, 1].map(() => launch(t, process.execPath, ['-e', script, library, fx.root, fx.identity]))
  await Promise.all(peers.map(async peer => assert.equal(await peer.line(), 'ready')))
  for (const peer of peers) peer.child.stdin.end('collect\n')
  const results = await Promise.all(peers.map(async peer => JSON.parse(await peer.line())))
  await Promise.all(peers.map(peer => peer.exit))
  assert.equal(results.reduce((sum, result) => sum + result.removed, 0), 3)
  assert.deepEqual(fs.readdirSync(fx.root), [fx.name('admission-a')])
})

test('Node collection preserves a live Python domain, its lock identities and continued IO',
  { timeout: TIMEOUT }, async t => {
    const fx = fixture(t, [])
    const data = `${fx.root}-data`
    const dataPin = api.pin(data, true)
    const identity = api.identity(dataPin).replaceAll(':', '-')
    api.release(dataPin)
    t.after(() => fs.rmSync(data, { recursive: true, force: true }))
    const script = `import os,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from service.platform.storage import DarwinDirectoryNative, LinuxDirectoryNative, WindowsDirectoryNative
from service.platform.domains import Domains
native = {'darwin': DarwinDirectoryNative, 'linux': LinuxDirectoryNative,
          'win32': WindowsDirectoryNative}[sys.platform]()
owner = Domains(native, sys.argv[2], [sys.argv[3]])
owner.occupy()
owner.admit()
print(os.getpid(), flush=True)
try:
    for line in sys.stdin:
        value = line.strip()
        target = Path(sys.argv[3], 'continued')
        with target.open('w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        assert target.read_text() == value
        print(value, flush=True)
finally:
    owner.close()
`
    const python = process.env.SCHOLARSEED_RECLAIM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const peer = launch(t, python, ['-c', script, path.resolve(__dirname, '../../serve'), fx.root, data])
    assert.equal(Number(await peer.line()), peer.child.pid)
    const inventory = () => Object.fromEntries(fs.readdirSync(fx.root)
      .filter(name => /-(?:admission|occupancy)-[ab]$/.test(name)).sort()
      .map(name => {
        const stat = fs.statSync(path.join(fx.root, name), { bigint: true })
        return [name, [stat.dev.toString(), stat.ino.toString(), stat.size.toString()]]
      }))
    const before = inventory()
    assert.ok(Object.keys(before).includes(`${identity}-occupancy-a`))
    for (let round = 0; round < 8; round++) {
      const receipt = reclaimCoordination(api, fx.root)
      assert.equal(receipt.removed, 0)
      assert.ok(receipt.busy > 0)
      assert.deepEqual(receipt.errors, [])
      assert.deepEqual(inventory(), before)
      assert.throws(() => api.acquireAt(fx.pin, `${identity}-occupancy-a`, true), { code: 'ERR_LEASE_BUSY' })
      peer.child.stdin.write(`${round}\n`)
      assert.equal(await peer.line(), String(round))
      assert.equal(fs.readFileSync(path.join(data, 'continued'), 'utf8'), String(round))
      assert.equal(peer.child.exitCode, null)
    }
    peer.child.stdin.end()
    await peer.exit
    assert.ok(reclaimCoordination(api, fx.root).removed > 0)
    assert.ok(fs.existsSync(path.join(fx.root, `${identity}-admission-a`)))
    assert.equal(fs.existsSync(path.join(fx.root, `${identity}-occupancy-a`)), false)
  })

function createGroup(fx, index) {
  const separator = fx.identity.lastIndexOf('-')
  const identity = fx.identity.slice(0, separator + 1) + index.toString(16).padStart(fx.identity.length - separator - 1, '0')
  assert.notEqual(identity, fx.identity)
  for (const suffix of SUFFIXES) api.release(api.acquireAt(fx.pin, `${identity}-${suffix}`, false))
  return identity
}

test('real scanner collects idle groups, preserves active and unsafe groups, ignores nested and malformed entries', t => {
  const fx = fixture(t)
  const active = createGroup(fx, 1)
  const unsafe = createGroup(fx, 2)
  const held = api.acquireAt(fx.pin, `${active}-occupancy-a`, false)
  fs.writeFileSync(path.join(fx.root, `${unsafe}-occupancy-b`), 'unknown record')
  fs.writeFileSync(fx.file('families'), '')
  fs.writeFileSync(path.join(fx.root, 'posix-not-an-identity-occupancy-a'), 'malformed')
  const nested = path.join(fx.root, 'recovery')
  fs.mkdirSync(nested, { mode: 0o700 })
  fs.writeFileSync(path.join(nested, fx.name('occupancy-a')), 'recovery evidence')
  try {
    assert.deepEqual(reclaimCoordination(api, fx.root), {
      removed: 3, busy: 1, retained: 1, examined: 3, complete: true, absent: false, errors: [],
    })
    const inventory = fs.readdirSync(fx.root).sort()
    assert.deepEqual(reclaimCoordination(api, fx.root), {
      removed: 0, busy: 1, retained: 1, examined: 2, complete: true, absent: false, errors: [],
    })
    assert.deepEqual(fs.readdirSync(fx.root).sort(), inventory)
    assert.equal(fs.readFileSync(path.join(nested, fx.name('occupancy-a')), 'utf8'), 'recovery evidence')
    assert.ok(fs.existsSync(fx.file('families')))
    assert.equal(fs.readFileSync(path.join(fx.root, 'posix-not-an-identity-occupancy-a'), 'utf8'), 'malformed')
  } finally { api.release(held) }
  assert.equal(reclaimCoordination(api, fx.root).removed, 3)
})

test('scanner traverses more than 4096 permanent guards without the metadata-list limit', { timeout: TIMEOUT }, t => {
  const fx = fixture(t)
  for (let index = 0; index < 4100; index++) {
    const name = `posix-0000000000000000-${index.toString(16).padStart(16, '0')}-admission-a`
    fs.writeFileSync(path.join(fx.root, name), '', { mode: 0o600 })
  }
  assert.deepEqual(reclaimCoordination(api, fx.root), {
    removed: 3, busy: 0, retained: 0, examined: 1, complete: true, absent: false, errors: [],
  })
  assert.equal(fs.readdirSync(fx.root).length, 4101)
  assert.deepEqual(reclaimCoordination(api, fx.root), {
    removed: 0, busy: 0, retained: 0, examined: 0, complete: true, absent: false, errors: [],
  })
})

test('scanner never creates an absent coordination directory', t => {
  const fx = fixture(t)
  const absent = path.join(fx.root, 'absent')
  assert.deepEqual(reclaimCoordination(api, absent), {
    removed: 0, busy: 0, retained: 0, examined: 0, complete: true, absent: true, errors: [],
  })
  assert.equal(fs.existsSync(absent), false)
})
