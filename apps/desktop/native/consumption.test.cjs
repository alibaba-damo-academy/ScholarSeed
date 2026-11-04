const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { beginDomains } = require('./domains.cjs')
const policy = require('./toolchain.json')

const library = process.env.SCHOLARSEED_LEASE_LIBRARY
assert.ok(library && path.isAbsolute(library), 'select the actual canonical compiled library')
assert.equal(process.versions.node, policy.node)
const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(library), 'build.json'), 'utf8'))
assert.equal(receipt.schema, 2)
assert.equal(receipt.platform, process.platform)
assert.equal(receipt.arch, process.arch)
assert.equal(receipt.napi, policy.napi)
assert.equal(receipt.signed, false)
const digest = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
for (const name of ['directory.c', 'directory.h', 'lease.c']) {
  assert.equal(receipt.sources[name], digest(path.join(__dirname, name)), name)
}
assert.equal(
  receipt.libraries.find((entry) => entry.path === path.basename(library))?.sha256,
  digest(library)
)
const api = require(library)
const macosTest = process.platform === 'darwin' ? test : test.skip
const RECORD = 'context.json'
const PAYLOAD = Buffer.from('{"candidate":"old-transaction"}\n')
const TIMEOUT_MS = 2000

function fixture(context, bytes = PAYLOAD) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'consumption-fixture-'))
  const root = path.join(base, 'records')
  const coordinator = path.join(base, 'coordinator')
  api.release(api.pin(coordinator, true))
  const pin = api.pin(root, true)
  const domains = beginDomains(api, coordinator, [root], true)
  domains.occupy()
  const filename = path.join(root, RECORD)
  fs.writeFileSync(filename, bytes, { mode: 0o600 })
  const stat = fs.statSync(filename, { bigint: true })
  context.after(() => {
    domains.close()
    api.release(pin)
    fs.rmSync(base, { recursive: true, force: true })
  })
  return {
    base,
    root,
    pin,
    filename,
    device: String(stat.dev),
    inode: String(stat.ino),
    consume: (expected = bytes, device = String(stat.dev), inode = String(stat.ino)) =>
      api.consumeAt(pin, RECORD, expected, device, inode),
  }
}

test('native consumption exports a formal platform-gated capability', () => {
  assert.equal(typeof api.consumeAt, 'function')
  if (process.platform !== 'darwin') {
    assert.throws(() => api.consumeAt(undefined, RECORD, PAYLOAD, '0', '0'), {
      code: 'ERR_LEASE_PLATFORM',
    })
  }
})

macosTest('byte mismatch preserves the original record and unrelated content', (context) => {
  const current = fixture(context)
  fs.writeFileSync(path.join(current.root, 'unrelated.json'), 'preserve', { mode: 0o600 })
  assert.throws(() => current.consume(Buffer.from('different')), { code: 'ERR_LEASE_CHANGED' })
  assert.deepEqual(fs.readFileSync(current.filename), PAYLOAD)
  assert.equal(fs.readFileSync(path.join(current.root, 'unrelated.json'), 'utf8'), 'preserve')
})

macosTest(
  'exact consumption removes only the named record and missing is never success',
  (context) => {
    const current = fixture(context)
    const other = path.join(current.root, 'other.json')
    fs.writeFileSync(other, 'preserve', { mode: 0o600 })
    assert.equal(current.consume(), undefined)
    assert.equal(fs.existsSync(current.filename), false)
    assert.equal(fs.readFileSync(other, 'utf8'), 'preserve')
    assert.throws(() => current.consume(), { code: 'ERR_LEASE_MISSING' })
  }
)

macosTest('new bytes on the same inode cannot be consumed by an old request', (context) => {
  const current = fixture(context)
  fs.writeFileSync(current.filename, Buffer.from('{"candidate":"new-transaction"}\n'))
  assert.equal(String(fs.statSync(current.filename, { bigint: true }).ino), current.inode)
  assert.throws(() => current.consume(), { code: 'ERR_LEASE_CHANGED' })
  assert.match(fs.readFileSync(current.filename, 'utf8'), /new-transaction/)
})

macosTest(
  'replacement inode with identical bytes cannot be consumed by an old request',
  (context) => {
    const current = fixture(context)
    const replacement = path.join(current.root, 'replacement.json')
    fs.writeFileSync(replacement, PAYLOAD, { mode: 0o600 })
    assert.notEqual(String(fs.statSync(replacement, { bigint: true }).ino), current.inode)
    fs.renameSync(replacement, current.filename)
    assert.throws(() => current.consume(), { code: 'ERR_LEASE_CHANGED' })
    assert.deepEqual(fs.readFileSync(current.filename), PAYLOAD)
  }
)

macosTest('wrong device or inode refuses deletion', (context) => {
  const current = fixture(context)
  assert.throws(() => current.consume(PAYLOAD, String(BigInt(current.device) + 1n)), {
    code: 'ERR_LEASE_CHANGED',
  })
  assert.throws(
    () => current.consume(PAYLOAD, current.device, String(BigInt(current.inode) + 1n)),
    { code: 'ERR_LEASE_CHANGED' }
  )
  assert.deepEqual(fs.readFileSync(current.filename), PAYLOAD)
})

macosTest(
  'oversized existing record is refused without truncation or unbounded allocation',
  (context) => {
    const current = fixture(context)
    const oversized = 1024 * 1024 + 1
    fs.truncateSync(current.filename, oversized)
    assert.throws(() => current.consume(), { code: 'ERR_LEASE_SIZE' })
    assert.equal(fs.statSync(current.filename).size, oversized)
  }
)

macosTest('closed pins and ordinary lease handles cannot authorize consumption', (context) => {
  const current = fixture(context)
  const closed = api.pin(current.root, false)
  api.release(closed)
  assert.throws(() => api.consumeAt(closed, RECORD, PAYLOAD, current.device, current.inode), {
    code: 'ERR_LEASE_CLOSED',
  })
  const ordinary = api.acquireAt(current.pin, 'other-lock', true)
  try {
    assert.throws(() => api.consumeAt(ordinary, RECORD, PAYLOAD, current.device, current.inode), {
      code: 'ERR_LEASE_ARGUMENT',
    })
  } finally {
    api.release(ordinary)
  }
  assert.deepEqual(fs.readFileSync(current.filename), PAYLOAD)
})

macosTest('invalid arguments and zero-byte coordination slots cannot be consumed', (context) => {
  const current = fixture(context)
  for (const expected of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1), 'not a Buffer']) {
    assert.throws(() => current.consume(expected), { code: 'ERR_LEASE_ARGUMENT' })
  }
  for (const identity of ['', '-1', '1.5', ' 1', '01', '0x10', '18446744073709551616']) {
    assert.throws(() => current.consume(PAYLOAD, identity), { code: 'ERR_LEASE_ARGUMENT' })
    assert.throws(() => current.consume(PAYLOAD, current.device, identity), {
      code: 'ERR_LEASE_ARGUMENT',
    })
  }
  for (const name of ['../context.json', '/context.json', '.', 'with/slash', 'with\0nul']) {
    assert.throws(() => api.consumeAt(current.pin, name, PAYLOAD, current.device, current.inode), {
      code: 'ERR_LEASE_ARGUMENT',
    })
  }
  api.release(api.acquireAt(current.pin, 'context-write', true))
  const slot = fs.statSync(path.join(current.root, 'context-write'), { bigint: true })
  assert.throws(
    () =>
      api.consumeAt(
        current.pin,
        'context-write',
        Buffer.from('x'),
        String(slot.dev),
        String(slot.ino)
      ),
    { code: 'ERR_LEASE_SIZE' }
  )
  assert.equal(fs.statSync(path.join(current.root, 'context-write')).size, 0)
  assert.deepEqual(fs.readFileSync(current.filename), PAYLOAD)
})

for (const kind of ['hardlink', 'symlink', 'directory', 'permissions']) {
  macosTest(`${kind} record is preserved rather than consumed`, (context) => {
    const current = fixture(context)
    const other = path.join(current.root, 'other')
    if (kind === 'hardlink') fs.linkSync(current.filename, other)
    if (kind === 'symlink') {
      fs.renameSync(current.filename, other)
      fs.symlinkSync(other, current.filename)
    }
    if (kind === 'directory') {
      fs.unlinkSync(current.filename)
      fs.mkdirSync(current.filename, { mode: 0o700 })
    }
    if (kind === 'permissions') fs.chmodSync(current.filename, 0o666)
    const before = fs.readdirSync(current.root).sort()
    assert.throws(() => current.consume())
    assert.deepEqual(fs.readdirSync(current.root).sort(), before)
    if (kind === 'symlink') assert.deepEqual(fs.readFileSync(other), PAYLOAD)
  })
}

macosTest('renamed pinned directory and substituted namespace are refused', (context) => {
  const current = fixture(context)
  const moved = path.join(current.base, 'moved')
  fs.renameSync(current.root, moved)
  fs.mkdirSync(current.root, { mode: 0o700 })
  fs.writeFileSync(current.filename, 'new namespace', { mode: 0o600 })
  assert.throws(() => current.consume(), { code: 'ERR_LEASE_CHANGED' })
  assert.deepEqual(fs.readFileSync(path.join(moved, RECORD)), PAYLOAD)
  assert.equal(fs.readFileSync(current.filename, 'utf8'), 'new namespace')
})

macosTest('FIFO is rejected in an externally time-limited native process', (context) => {
  const current = fixture(context)
  fs.unlinkSync(current.filename)
  const made = spawnSync('/usr/bin/mkfifo', [current.filename], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  })
  assert.equal(made.status, 0, made.stderr)
  const stat = fs.lstatSync(current.filename, { bigint: true })
  const script = `const api=require(process.argv[1]);const pin=api.pin(process.argv[2],false);
    try{api.consumeAt(pin,'context.json',Buffer.from('x'),process.argv[3],process.argv[4]);process.exitCode=2}
    catch(error){process.exitCode=error.code==='ERR_LEASE_FILE'?0:3}
    finally{api.release(pin)}`
  const result = spawnSync(
    process.execPath,
    ['-e', script, library, current.root, String(stat.dev), String(stat.ino)],
    {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    }
  )
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.lstatSync(current.filename).isFIFO(), true)
})
