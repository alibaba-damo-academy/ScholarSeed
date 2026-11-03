const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const library = process.env.SCHOLARSEED_LEASE_LIBRARY

test('Windows Job retains and drains an external descendant after its leader exits', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async () => {
  assert.ok(library, 'select the actual compiled SCHOLARSEED_LEASE_LIBRARY')
  const api = require(library)
  const script = `process.stdin.once('data',()=>{
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    child.once('spawn',()=>{console.log(child.pid);child.unref();process.exit(0)});
  })`
  const leader = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(leader, 'exit')
  let family
  try {
    await once(leader, 'spawn')
    family = api.openFamily(leader.pid)
    assert.equal(family.active(), 1)
    assert.throws(() => family.close(), { code: 'ERR_PROCESS_FAMILY_BUSY' })
    leader.stdin.end('start')
    const [code] = await exited
    assert.equal(code, 0)
    assert.ok(family.active() >= 1, 'descendant remains owned after leader exit')
    family.terminate()
    const deadline = Date.now() + 5000
    while (family.active() && Date.now() < deadline) await delay(25)
    assert.equal(family.active(), 0)
    family.close()
    assert.throws(() => family.active(), { code: 'ERR_PROCESS_FAMILY_CLOSED' })
    family = undefined
  } finally {
    if (family) { family.terminate(); while(family.active()) await delay(25); family.close() }
    if (leader.exitCode === null) leader.kill()
  }
})

test('Windows installation binding distinguishes an empty root from a failed observation', {
  skip: process.platform !== 'win32',
}, () => {
  assert.ok(library, 'select the actual compiled SCHOLARSEED_LEASE_LIBRARY')
  const api = require(library)
  const root = mkdtempSync(join(tmpdir(), 'installation-'))
  try {
    assert.doesNotThrow(() => api.assertUpdateInstallationIdle(root, 'no-such-application.exe'))
    assert.throws(() => api.assertUpdateInstallationIdle(join(root, 'absent'), 'ScholarSeed.exe'), {
      code: 'ERR_UPDATE_INSTALLATION_QUERY',
    })
    assert.throws(() => api.assertUpdateInstallationIdle('', 'ScholarSeed.exe'), {
      code: 'ERR_UPDATE_INSTALLATION_ARGUMENT',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
