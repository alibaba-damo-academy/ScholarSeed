import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { createVaultDebugPolicy, type VaultDebugEvidence } from './vaultdebug.ts'

test('actual debug admission implementation exists', () => {
  assert.equal(existsSync(new URL('./vaultdebug.ts', import.meta.url)), true)
})

const normal: VaultDebugEvidence = { trustedStartup: true, argv: ['electron', 'app'], execArgv: [], nodeOptions: undefined,
  commandLine: { hasSwitch: () => false }, inspectorUrl: () => undefined, contents: () => [] }
test('actually destroyed custody is skipped, unknown destruction fails closed and live retired debugger remains unsafe', () => {
  const destroyed = { isDestroyed: () => true, isDevToolsOpened: () => { throw new Error('unavailable') }, debugger: { isAttached: () => true } }
  assert.equal(createVaultDebugPolicy({ ...normal, contents: () => [destroyed] })(), null)
  assert.equal(createVaultDebugPolicy({ ...normal, contents: () => [{ ...destroyed, isDestroyed: () => { throw new Error('unknown') } }] })(), 'debug_unknown')
  assert.equal(createVaultDebugPolicy({ ...normal, contents: () => [{ ...destroyed, isDestroyed: () => false, isDevToolsOpened: () => false }] })(), 'debug_unsafe')
})
test('normal trusted startup is safe; port zero, pipe, argv, execArgv and NODE_OPTIONS debug are unsafe', () => {
  assert.equal(createVaultDebugPolicy(normal)(), null)
  for (const variant of [
    { commandLine: { hasSwitch: (name: string) => name === 'remote-debugging-port' } },
    { argv: ['--remote-debugging-port=0'] }, { argv: ['--remote-debugging-pipe'] },
    { execArgv: ['--inspect-brk=0'] }, { nodeOptions: '--inspect-wait' }, { nodeOptions: '"--inspect=0"' }
  ]) assert.equal(createVaultDebugPolicy({ ...normal, ...variant })(), 'debug_unsafe')
  assert.equal(createVaultDebugPolicy({ ...normal, nodeOptions: '--title=inspect' })(), null)
})
test('dynamic inspector and actual product debugger are checked each operation; missing evidence fails closed', () => {
  let inspector: string | undefined
  let attached = false
  const check = createVaultDebugPolicy({ ...normal, inspectorUrl: () => inspector,
    contents: () => [{ isDestroyed: () => false, isDevToolsOpened: () => false, debugger: { isAttached: () => attached } }] })
  assert.equal(check(), null)
  inspector = 'ws://127.0.0.1:0'; assert.equal(check(), 'debug_unsafe')
  inspector = undefined; attached = true; assert.equal(check(), 'debug_unsafe')
  assert.equal(createVaultDebugPolicy({ ...normal, trustedStartup: false })(), 'debug_unknown')
  assert.equal(createVaultDebugPolicy({ ...normal, nodeOptions: '"unterminated' })(), 'debug_unknown')
  assert.equal(createVaultDebugPolicy({ ...normal, inspectorUrl: () => { throw new Error('secret') } })(), 'debug_unknown')
})
