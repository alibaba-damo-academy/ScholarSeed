import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserBridge, type BrowserEnvironment } from './browser.ts'
import { defaultRendererPreferences } from '../../../preferences.ts'

function isolatedBrowserEnvironment() {
  const effects: unknown[][] = []
  const unexpected = async (...args: unknown[]): Promise<never> => {
    effects.push(args)
    assert.fail('unexpected browser environment effect')
  }
  const environment: BrowserEnvironment = {
    platform: 'browser',
    version: 'isolated-version',
    preferences: defaultRendererPreferences('en'),
    reconcilePreferences: unexpected,
    savePreferences: unexpected,
    getAuthToken: unexpected,
    setAuthToken: unexpected,
    getDeviceInfo: unexpected,
    openExternal: unexpected,
    saveFileCopy: unexpected,
    fetch: unexpected,
  }
  return { environment, effects }
}

test('browser environment fixture records effects even when the rejection is swallowed', async () => {
  const fixture = isolatedBrowserEnvironment()
  await fixture.environment.fetch('https://example.invalid').catch(() => undefined)
  assert.deepEqual(fixture.effects, [['https://example.invalid']])
})

test('browser storage is unconfigured and rejects committing a native data home without effects', async () => {
  const fixture = isolatedBrowserEnvironment()
  const bridge = createBrowserBridge(fixture.environment)
  const expected = {
    home: '',
    runtimeStore: null,
    configured: false,
    canChangeDataHome: false,
    firstLaunchEligible: false,
  }
  const config = await bridge.storageConfig()
  assert.deepEqual(config, expected)
  config.home = 'modified-result'
  assert.deepEqual(await bridge.storageConfig(), expected)
  assert.deepEqual(await bridge.commitDataHome('isolated-parent'), {
    ok: false,
    reason: 'unsupported',
  })
  assert.deepEqual(await bridge.storageConfig(), expected)
  assert.deepEqual(fixture.effects, [])
})

test('browser update refresh performs no effects and never creates a candidate', async () => {
  const fixture = isolatedBrowserEnvironment()
  const bridge = createBrowserBridge(fixture.environment)
  const expected = { phase: 'up-to-date', currentVersion: 'isolated-version' }
  assert.deepEqual(await bridge.getUpdateState(), expected)
  assert.equal(await bridge.refreshUpdate(), undefined)
  assert.deepEqual(await bridge.getUpdateState(), expected)
  assert.deepEqual(await bridge.checkUpdate(), expected)
  assert.equal(await bridge.refreshUpdate(), undefined)
  assert.deepEqual(await bridge.getUpdateState(), expected)
  assert.deepEqual(fixture.effects, [])
})

test('browser bridge consumes only injected browser environment', async () => {
  const preferences = defaultRendererPreferences('en')
  const writes: unknown[] = []
  const environment: BrowserEnvironment = {
    platform: 'browser',
    version: 'test',
    preferences,
    reconcilePreferences: async () => preferences,
    savePreferences: async (value) => {
      writes.push(value)
      return value
    },
    getAuthToken: async () => '',
    setAuthToken: async () => ({ ok: true }),
    getDeviceInfo: async () => ({ device_id: 'isolated', device_label: 'Preview' }),
    openExternal: async () => {},
    saveFileCopy: async () => ({ ok: false, error: 'unsupported' }),
    fetch: async () => new Response('{}'),
  }
  const bridge = createBrowserBridge(environment)
  assert.equal(bridge.preferences, preferences)
  assert.equal(await bridge.getAuthToken(), '')
  assert.deepEqual(await bridge.getDeviceInfo(), { device_id: 'isolated', device_label: 'Preview' })
  await bridge.savePreferences(preferences)
  assert.deepEqual(writes, [preferences])
  assert.equal(bridge.browserEnabled, false)
  assert.deepEqual(await bridge.writeClipboardImage(new Uint8Array()), {
    ok: false,
    error: 'clipboard_image_write_unavailable',
  })
  assert.deepEqual(await bridge.readOfficeClipboard(), { ok: false, error: 'clipboard_failed' })
  assert.deepEqual(await bridge.getUpdateState(), { phase: 'up-to-date', currentVersion: 'test' })
})
