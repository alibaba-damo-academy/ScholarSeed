import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserRegistry } from './browser.ts'
import type { CdpBroker } from './cdp.ts'
import { createLegacyBrowserHost } from './browserhost.ts'

test('legacy host keeps UI, Agent, history and automation under one owner', async () => {
  const calls: string[] = []
  const registry = {
    snapshot: () => ({ tabs: [], activeTabId: null, automation: { enabled: false, port: null } }),
    historyAgent: { revokeAll: () => calls.push('revoke') },
    setApiBase: async () => { calls.push('api-base') },
    dispose: async () => { calls.push('registry-dispose') }
  } as unknown as BrowserRegistry
  const broker = {
    start: async () => ({ port: 1234 }), stop: async () => { calls.push('broker-stop') },
    copyEndpoint: () => undefined, syncTargets: async () => undefined
  } as CdpBroker
  let automation = { enabled: false, port: null as number | null }
  const host = createLegacyBrowserHost(registry, broker, () => automation)
  assert.equal(host.ui, registry)
  assert.equal(host.agent, registry)
  assert.equal(host.historyAgent, registry.historyAgent)
  assert.equal(typeof host.automation.start, 'function')
  automation = { enabled: true, port: 1234 }
  assert.deepEqual(host.snapshot().automation, automation)
  await host.setApiBase('http://127.0.0.1:10000')
  await host.dispose()
  assert.deepEqual(calls, ['api-base', 'broker-stop', 'registry-dispose'])
})

test('disposing a host drains an in-flight start before stopping and blocks later starts', async () => {
  const calls: string[] = []
  let releaseStart!: () => void
  const pendingStart = new Promise<void>(resolve => { releaseStart = resolve })
  const registry = { historyAgent: {}, snapshot: () => ({ tabs: [], activeTabId: null }),
    setApiBase: async () => {}, dispose: async () => { calls.push('registry-dispose') } } as unknown as BrowserRegistry
  const broker = { start: async () => { calls.push('start'); await pendingStart; return { port: 1234 } },
    stop: async () => { calls.push('stop') }, copyEndpoint: () => {}, syncTargets: async () => {} } as CdpBroker
  const host = createLegacyBrowserHost(registry, broker, () => ({ enabled: false, port: null }))
  const starting = host.automation.start()
  await Promise.resolve()
  const disposing = host.dispose()
  assert.deepEqual(calls, ['start'])
  assert.throws(() => host.automation.start(), /desktop_bridge_unavailable/)
  releaseStart()
  await starting
  await disposing
  assert.deepEqual(calls, ['start', 'stop', 'registry-dispose'])
})
