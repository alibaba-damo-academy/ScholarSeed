import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinationReclamation } from './reclamation.ts'
import type { ReclamationNative } from '../../native/reclamation.cjs'

const IDENTITY = 'posix-0000000000000001-0000000000000002'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coordination-trigger-'))
  writeFileSync(join(root, `${IDENTITY}-occupancy-a`), '')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let groups = 0
  let releases = 0
  const logs: string[] = []
  const native = {
    pin: () => ({}),
    release: () => { releases++ },
    reclaimAt: () => { groups++; return { removed: 0, busy: true, retained: false } },
  } as unknown as ReclamationNative
  return { root, native, logs, groups: () => groups, releases: () => releases }
}

test('startup and post-update readiness each attempt collection once; busy is observable', t => {
  const fx = fixture(t)
  const owner = new CoordinationReclamation(fx.native, () => fx.root, line => fx.logs.push(line))
  owner.run('startup')
  owner.run('startup')
  owner.run('ready')
  owner.run('ready')
  assert.equal(fx.groups(), 2)
  assert.equal(fx.releases(), 2)
  assert.ok(fx.logs[0].includes('reason=startup'))
  assert.ok(fx.logs[1].includes('reason=ready'))
  assert.ok(fx.logs.every(line => line.includes('"busy":1')))
})

test('ordinary collection failure reports a diagnostic without failing installed application startup', t => {
  const fx = fixture(t)
  fx.native.pin = () => { throw new Error('permission denied') }
  const owner = new CoordinationReclamation(fx.native, () => fx.root, line => fx.logs.push(line))
  owner.run('startup')
  assert.equal(fx.groups(), 0)
  assert.equal(fx.releases(), 0)
  assert.ok(fx.logs[0].includes('permission denied'))
})

test('uncertain native close forbids continuation and retains the pin', t => {
  const fx = fixture(t)
  const uncertain = Object.assign(new Error('close uncertain'), { code: 'ERR_LEASE_RELEASE' })
  fx.native.reclaimAt = () => { throw uncertain }
  const owner = new CoordinationReclamation(fx.native, () => fx.root, line => fx.logs.push(line))
  assert.throws(() => owner.run('startup'), uncertain)
  assert.equal(fx.releases(), 0)
  assert.ok(fx.logs[0].includes('close uncertain'))
})

test('native parent close errors are promoted to fatal domain release uncertainty', t => {
  const fx = fixture(t)
  fx.native.release = () => { throw Object.assign(new Error('native close failed'), { code: 'ERR_LEASE_NATIVE' }) }
  const owner = new CoordinationReclamation(fx.native, () => fx.root, line => fx.logs.push(line))
  assert.throws(() => owner.run('startup'), { code: 'ERR_DOMAIN_RELEASE' })
  assert.ok(fx.logs[0].includes('release uncertain'))
})
