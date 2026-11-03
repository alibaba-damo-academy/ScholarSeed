const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { runInNewContext } = require('node:vm')
const { verifyExecution, waitForExecution, READY } = require('../execution.cjs')

function run(script, options = {}) {
  return waitForExecution(process.execPath, ['-e', script], {
    startTimeout: 30000, exitTimeout: 1000, log() {}, ...options,
  })
}
const ready = `process.stdout.write(${JSON.stringify(READY + '\n')})`

test('first-exec wait is separate from the post-readiness deadline', async () => {
  const result = await run(`setTimeout(() => { ${ready} }, 250)`, { exitTimeout: 100 })
  assert.equal(result.status, 'passed')
  assert.ok(result.ready_seconds >= 0.25)
})

test('a child that never becomes ready is killed and reaped', async () => {
  await assert.rejects(run('setInterval(() => {}, 1000)', { startTimeout: 100 }), error => {
    assert.match(error.message, /did not become ready/)
    assert.equal(error.evidence.signal, 'SIGKILL')
    assert.throws(() => process.kill(error.evidence.pid, 0), /ESRCH/)
    return true
  })
})

test('readiness cannot hide a hanging process or a failed exit', async () => {
  await assert.rejects(run(`${ready}; setInterval(() => {}, 1000)`, { exitTimeout: 100 }), /did not exit/)
  await assert.rejects(run(`${ready}; process.exitCode = 7`), /handshake failed/)
})

test('missing executable, missing readiness and unexpected output fail closed', async () => {
  await assert.rejects(waitForExecution('/nonexistent/scholarseed-node', [], { log() {} }), /ENOENT/)
  await assert.rejects(run(''), /handshake failed/)
  await assert.rejects(run(`${ready}; console.log('extra')`), /handshake failed/)
  await assert.rejects(run("process.stdout.write('x'.repeat(5000))"), /exceeded limit/)
})

test('first execution rejects missing metadata and changed input before launch', async t => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-input-'))
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }))
  fs.mkdirSync(path.join(resources, 'backend/browser'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'backend/browser/node'), 'not the frozen executable', { mode: 0o755 })
  await assert.rejects(verifyExecution(resources, null), /input is missing/)
  await assert.rejects(verifyExecution(resources, { path: 'backend/browser/node', executable_sha256: 'wrong' }), /differs from frozen/)
})

test('signed macOS waits for execution after trust and blocks content on failure; other lanes do not', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../verify.cjs'), 'utf8')
  const declaration = source.slice(source.indexOf('async function verifyApplication('), source.indexOf('\nfunction runtimeReuseEvidence('))
  const events = []
  let rejectExecution = false
  let unsigned = false
  const verify = runInNewContext(`${declaration}\nverifyApplication`, {
    verifyIdentity() {}, unsignedPackageCheck: () => unsigned,
    macTrust() { events.push('trust'); return {} },
    layout: () => ({ resources: '/fixture/resources' }),
    verifyExecution: async () => { events.push('execution'); if (rejectExecution) throw new Error('execution denied'); return {status: 'passed'} },
    verifyContent: async () => { events.push('content'); return { current: {}, imports: {}, browser: {}, closure: {} } },
    verifyWindowsSignature() { return {} },
  })
  const frozen = { platform: 'darwin', signingRequired: true }
  const result = await verify('/fixture/app', frozen, false)
  assert.deepEqual(events.splice(0), ['trust', 'execution', 'content'])
  assert.equal(result.trust.execution.status, 'passed')
  rejectExecution = true
  await assert.rejects(verify('/fixture/app', frozen, false), /execution denied/)
  assert.deepEqual(events.splice(0), ['trust', 'execution'])
  rejectExecution = false
  await verify('/fixture/app', { platform: 'darwin', signingRequired: false }, false)
  assert.deepEqual(events.splice(0), ['trust', 'execution', 'content'])
  await verify('/fixture/app', { platform: 'win32', signingRequired: false }, false)
  assert.deepEqual(events.splice(0), ['content'])
  unsigned = true
  const candidate = await verify('/fixture/app', { platform: 'darwin', signingRequired: false }, false)
  assert.deepEqual(events.splice(0), ['content'])
  assert.equal(candidate.trust, null)
})
