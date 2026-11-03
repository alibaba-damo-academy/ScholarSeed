import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import type { VaultViewBridge } from '../vault.ts'

test('actual standalone protected preload exposes only secret view verbs and validates before invoke', async () => {
  const entry = fileURLToPath(new URL('./vault.ts', import.meta.url))
  const compiled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  let bridge!: VaultViewBridge
  const calls: unknown[][] = []
  const context = createContext({
    TextEncoder,
    require: (name: string) => {
      assert.equal(name, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => {
            assert.equal(key, 'vault')
            bridge = value as VaultViewBridge
            context.bridge = value
          },
        },
        ipcRenderer: {
          invoke: (...values: unknown[]) => {
            calls.push(values)
            return Promise.resolve({ ok: true })
          },
        },
      }
    },
  })
  runInContext(compiled.outputFiles[0].text, context)
  assert.deepEqual(Object.keys(bridge).sort(), ['cancel', 'confirmReset', 'seed', 'submit'])
  await bridge.seed()
  assert.equal(calls.length, 1)
  const request = {
    kind: 'unlock' as const,
    password: 'secret',
    sessionId: 'session',
    generation: 1,
    requestId: 'request',
    path: '/private',
  }
  const invalid = await bridge.submit(request)
  assert.equal(invalid.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(
    (
      await runInContext(
        'bridge.submit({kind:"unlock",password:"short",sessionId:"session",generation:1,requestId:"request"})',
        context
      )
    ).ok,
    true
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[1][0], 'vault-view:submit')
  const source = readFileSync(entry, 'utf8')
  assert.equal(source.includes("from './index'"), false)
})
