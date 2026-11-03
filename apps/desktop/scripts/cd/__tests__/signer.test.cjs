const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runInNewContext } = require('node:vm')

function fixture(failures, guardFailure = false) {
  const calls = { options: [], delays: [], verified: 0 }
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../signer.cjs'), 'utf8')
  runInNewContext(source, { module, console: { warn() {} }, require(name) {
    if (name === '@electron/osx-sign') return { async signAsync(options) {
      calls.options.push(options)
      const failure = failures.shift()
      if (failure) throw failure
    } }
    if (name === 'node:timers/promises') return { async setTimeout(ms) { calls.delays.push(ms) } }
    if (name === './macho.cjs') return { signableIgnore: () => name => name.endsWith('.txt') }
    if (name === './sign.cjs') return { frozenContext: () => ({ native: {} }) }
    if (name === './seal.cjs') return { nativeSignatureGuard: () => ({
      ignore: name => name.endsWith('.node'),
      verify() {
        calls.verified++
        if (guardFailure) throw new Error('native signature input changed')
      },
    }) }
    throw new Error('unexpected dependency: ' + name)
  } })
  return { sign: module.exports, calls }
}

const timestampFailure = () => new Error('Command failed: codesign --sign identity --timestamp app: The timestamp service is not available.')
const options = { app: '/app', identity: 'identity', timestamp: 'http://timestamp.apple.com/ts01' }

test('timestamp failure retries the same signing policy and retains native exclusions', async () => {
  const f = fixture([timestampFailure(), null])
  await f.sign(options)
  assert.equal(f.calls.options.length, 2)
  assert.deepEqual(f.calls.delays, [2000])
  for (const actual of f.calls.options) {
    assert.equal(actual.identity, options.identity)
    assert.equal(actual.timestamp, options.timestamp)
    assert.equal(actual.ignore('lease.node'), true)
    assert.equal(actual.ignore('resource.txt'), true)
    assert.equal(actual.ignore('ScholarSeed'), false)
  }
  assert.ok(f.calls.verified >= 2)
})

test('persistent timestamp failure stops after three attempts and preserves the final error', async () => {
  const errors = [timestampFailure(), timestampFailure(), timestampFailure()]
  const final = errors.at(-1)
  const f = fixture([...errors])
  await assert.rejects(f.sign(options), error => error === final)
  assert.equal(f.calls.options.length, 3)
  assert.deepEqual(f.calls.delays, [2000, 5000])
})

test('certificate and other signing failures are never retried', async () => {
  for (const message of ['identity not found', 'invalid signature', 'timestamp verification failed']) {
    const failure = new Error(message)
    const f = fixture([failure])
    await assert.rejects(f.sign(options), error => error === failure)
    assert.equal(f.calls.options.length, 1)
    assert.deepEqual(f.calls.delays, [])
  }
})

test('a frozen native artifact changed during signing prevents another signing attempt', async () => {
  const f = fixture([timestampFailure()], true)
  await assert.rejects(f.sign(options), /native signature input changed/)
  assert.equal(f.calls.options.length, 1)
})

test('successful signing verifies frozen native artifacts without retrying', async () => {
  const f = fixture([])
  await f.sign(options)
  assert.equal(f.calls.options.length, 1)
  assert.equal(f.calls.verified, 1)
  assert.deepEqual(f.calls.delays, [])
})
