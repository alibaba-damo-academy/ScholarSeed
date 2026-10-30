const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const WORKER = path.resolve(__dirname, '../worker.cjs')
const BOOTSTRAP = Buffer.from('{"version":1,"port":12345,"token":"' + 'a'.repeat(64) + '"}\n')

function message(child, phase) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('worker phase timed out: ' + phase)) }, 5000)
    const receive = value => { if (value.phase === phase) { cleanup(); resolve(value) } }
    const cleanup = () => { clearTimeout(timer); child.removeListener('message', receive) }
    child.on('message', receive)
  })
}

async function fixture(context, code = 7) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scholarseed worker ' 中文-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const evidence = path.join(root, 'evidence.json')
  await fs.writeFile(path.join(root, 'index.js'), `
const fs = require('node:fs')
process.stdin.once('data', bytes => {
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ argv: process.argv.slice(2), bytes: bytes.toString() }))
  process.exit(${code})
})
`)
  const child = spawn(process.execPath, [WORKER, '--executable', process.execPath, '--root', root, '--port', '9222', '--profile', path.join(root, 'profile')], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' }
  })
  const closed = once(child, 'close')
  const waiting = message(child, 'waiting')
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  })
  return { child, closed, evidence, waiting }
}

test('real worker cannot launch before grant and preserves exact child arguments and exit status', async context => {
  const { child, closed, evidence, waiting } = await fixture(context)
  await waiting
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
  const spawned = message(child, 'spawned')
  child.stdin.write(Buffer.concat([Buffer.from([1]), BOOTSTRAP]))
  assert.ok((await spawned).pid > 0)
  assert.equal((await closed)[0], 7)
  const result = JSON.parse(await fs.readFile(evidence, 'utf8'))
  assert.equal(result.bytes, BOOTSTRAP.toString())
  assert.deepEqual(result.argv.slice(0, 2), ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1'])
  assert.equal(result.argv.at(-1), '--development-control')
})

test('invalid start byte never launches the real child', async context => {
  const { child, closed, evidence, waiting } = await fixture(context)
  await waiting
  child.stdin.end(Buffer.concat([Buffer.from([0]), BOOTSTRAP]))
  assert.equal((await closed)[0], 125)
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
})

test('oversized bootstrap never launches the real child', async context => {
  const { child, closed, evidence, waiting } = await fixture(context)
  await waiting
  child.stdin.end(Buffer.concat([Buffer.from([1]), Buffer.alloc(4097, 120)]))
  assert.equal((await closed)[0], 125)
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
})

test('unknown private control cannot authorize a child launch', async context => {
  const { child, closed, evidence, waiting } = await fixture(context)
  await waiting
  child.send({ operation: 'execute', command: 'not authorized' })
  assert.equal((await closed)[0], 125)
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
})

test('an explicit private stop before grant cannot race into a child launch', async context => {
  const { child, closed, evidence, waiting } = await fixture(context)
  await waiting
  child.send({ operation: 'stop', signal: 'SIGTERM' })
  assert.equal((await closed)[0], 143)
  await assert.rejects(fs.stat(evidence), { code: 'ENOENT' })
})

test('Windows native Job accounts for worker descendants until exact empty-family proof', {
  skip: process.platform !== 'win32', timeout: 15000
}, async context => {
  const library = process.env.SCHOLARSEED_LEASE_LIBRARY
  assert.ok(library, 'provide the exact Owner-compiled SCHOLARSEED_LEASE_LIBRARY')
  const native = require(library)
  const { child, closed, evidence, waiting } = await fixture(context)
  const root = path.dirname(evidence)
  await fs.writeFile(path.join(root, 'index.js'), `
process.stdin.once('data', () => {
  const descendant=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:false})
  descendant.once('spawn',()=>process.exit(7))
})
`)
  let family
  try {
    await waiting
    family = native.openFamily(child.pid)
    assert.equal(family.active(), 1)
    child.stdin.write(Buffer.concat([Buffer.from([1]), BOOTSTRAP]))
    assert.equal((await closed)[0], 7)
    assert.ok(family.active() > 0)
    assert.throws(() => family.close(), { code: 'ERR_PROCESS_FAMILY_BUSY' })
    family.terminate()
    const deadline = Date.now() + 5000
    while (family.active() && Date.now() < deadline) await delay(25)
    assert.equal(family.active(), 0)
    family.close()
    family = null
  } finally {
    if (family) {
      family.terminate()
      const deadline = Date.now() + 5000
      while (family.active() && Date.now() < deadline) await delay(25)
      if (!family.active()) family.close()
    }
  }
})
