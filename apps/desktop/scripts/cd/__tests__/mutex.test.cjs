// Real cross-process Windows leases; no installer or user process is killed.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const acceptance = require('../acceptance.cjs')

const windows = { skip: process.platform !== 'win32' }
const modulePath = JSON.stringify(require.resolve('../acceptance.cjs'))
function worker(t, code) {
  const child = spawn(process.execPath, ['-e', `const a=require(${modulePath});${code}`], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited })
  return { child, exited, output: () => output }
}
async function observed(worker, message) {
  for (let n = 0; n < 150; n++) {
    if (worker.output().includes(message)) return
    if (worker.child.exitCode !== null) break
    await delay(100)
  }
  assert.fail(`worker did not report ${message}: ${worker.output()}`)
}

test('verification lease preserves callback results and failures', async () => {
  assert.equal(await acceptance.withVerificationMutex(() => 42), 42)
  await assert.rejects(acceptance.withVerificationMutex(() => { throw new Error('probe failed') }), /probe failed/)
  assert.equal(await acceptance.withVerificationMutex(() => 'released'), 'released')
})

test('Windows verification queues independent processes and reuses nested leases', windows, async t => {
  let contender
  await acceptance.withVerificationMutex(async () => {
    assert.equal(await acceptance.withVerificationMutex(() => 'nested'), 'nested')
    await assert.rejects(acceptance.installationMutex(100), /acceptance is busy/)
    contender = worker(t, "a.withVerificationMutex(()=>console.log('entered')).catch(e=>{console.error(e);process.exitCode=1})")
    await observed(contender, 'verification.lock')
    await delay(500)
    assert.equal(contender.output().includes('entered'), false)
  })
  assert.equal((await contender.exited)[0], 0, contender.output())
  assert.match(contender.output(), /entered/)
})

test('Windows verification releases the lease when its owner is cancelled', windows, async t => {
  const owner = worker(t, "a.withVerificationMutex(()=>new Promise(()=>{console.log('owned');setInterval(()=>{},1000)})).catch(e=>{console.error(e);process.exitCode=1})")
  await observed(owner, 'owned')
  owner.child.kill()
  await owner.exited
  const release = await acceptance.installationMutex(5000)
  await release()
})

test('a cancelled Windows waiter never acquires and strands the lease', windows, async t => {
  await acceptance.withVerificationMutex(async () => {
    const waiter = worker(t, "a.withVerificationMutex(()=>new Promise(()=>{console.log('unexpected');setInterval(()=>{},1000)})).catch(e=>{console.error(e);process.exitCode=1})")
    await observed(waiter, 'verification.lock')
    await delay(500)
    waiter.child.kill()
    await waiter.exited
    assert.equal(waiter.output().includes('unexpected'), false)
  })
  const release = await acceptance.installationMutex(5000)
  await release()
})

test('Windows mutex validates its bounded wait', windows, async () => {
  for (const wait of [-1, NaN, Infinity, 0.5, 1800001])
    await assert.rejects(acceptance.installationMutex(wait), /invalid verification mutex wait/)
})
