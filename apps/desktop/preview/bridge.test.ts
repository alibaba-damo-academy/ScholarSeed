import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreviewBridge, previewScenarioSimulation, previewStatePath, readPreviewState, readPreviewAccountState } from './bridge.ts'
import { defaultRendererPreferences, sanitizeRendererPreferences } from '../src/preferences.ts'
import { unavailablePermissionRecords } from '../src/permissions.ts'
import { PreviewAccount } from './accounts.ts'
import { PREVIEW_STORAGE_READ, previewDirectoryPicker } from './directory.ts'

test('virtual root synchronization rejects native paths, checks transport receipts and never claims OS authority', async () => {
  const requests: { url: string; body: unknown }[] = []
  const diagnostics: string[] = []
  let response = Response.json({ ok: true })
  const bridge = createPreviewBridge({ instance: 'roots-bridge', scene: 'page-home', preferences: defaultRendererPreferences('zh'), request: async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return response
  }, diagnostic: detail => { diagnostics.push(detail.kind) } })
  assert.equal(await bridge.addAuthorizedRoot('external', '/Users/private'), false)
  assert.equal(requests.length, 0)
  assert.equal(await bridge.syncAuthorizedRoots('workspace', ['/preview/workspace']), true)
  assert.equal(requests.length, 1)
  assert.equal(new URL(requests[0].url, 'http://preview.local').searchParams.get('previewInstance'), 'roots-bridge')
  assert.deepEqual(requests[0].body, { scope: 'workspace', roots: ['/preview/workspace'], mode: 'replace' })
  response = Response.json({ ok: false }, { status: 422 })
  assert.equal(await bridge.addAuthorizedRoot('external', '/preview/unknown'), false)
  response = Response.json({ ok: 'not-a-boolean' })
  assert.equal(await bridge.syncAuthorizedRoots('workspace', []), false)
  assert.ok(diagnostics.every(kind => kind.startsWith('virtual-roots-')))
})

test('storage bridge exposes immutable virtual overview and explicit chooser results without native authority', async () => {
  const storage = { config: { home: '/preview/home', runtimeStore: '/preview/home/runtime', configured: false, canChangeDataHome: false, firstLaunchEligible: false }, choices: [{ id: 'workspace', label: 'Virtual workspace', path: '/preview/virtual/workspace' }] }
  const responseConfig = structuredClone(storage.config)
  const diagnostics: string[] = []
  const bridge = createPreviewBridge({ instance: 'storage-bridge', scene: 'settings-storage-states', preferences: defaultRendererPreferences('zh'), storage, request: async () => Response.json(responseConfig), diagnostic: detail => { diagnostics.push(detail.kind) } })
  storage.config.home = '/preview/changed'
  const config = await bridge.storageConfig()
  assert.equal(config.home, '/preview/home')
  config.home = '/preview/mutated'
  assert.equal((await bridge.storageConfig()).home, '/preview/home')
  const unsubscribe = previewDirectoryPicker.subscribe(() => {})
  try {
    const selected = bridge.pickDir()
    previewDirectoryPicker.finish('workspace')
    assert.equal(await selected, '/preview/virtual/workspace')
    const exclusive = bridge.pickDir()
    const duplicate = bridge.pickDir()
    previewDirectoryPicker.finish('workspace')
    assert.deepEqual(await Promise.all([exclusive, duplicate]), ['/preview/virtual/workspace', null])
    const cancelled = bridge.pickDir()
    previewDirectoryPicker.finish(null)
    assert.equal(await cancelled, null)
    assert.equal(diagnostics.filter(kind => kind === 'virtual-directory-picker-selected').length, 2)
    assert.equal(diagnostics.filter(kind => kind === 'virtual-directory-picker-cancelled').length, 2)
    assert.deepEqual(await bridge.commitDataHome('/preview/home'), { ok: false, reason: 'unsupported' })
  } finally { previewDirectoryPicker.finish(null); unsubscribe() }
})

test('storage bridge rereads the instance transport and rejects failed or invalid receipts without bootstrap fallback', async () => {
  const storage = { config: { home: '/preview/home', runtimeStore: null, configured: false, canChangeDataHome: false, firstLaunchEligible: false }, choices: [{ id: 'workspace', label: 'Virtual workspace', path: '/preview/virtual/workspace' }] }
  const calls: { url: string; credentials: RequestCredentials | undefined; cache: RequestCache | undefined }[] = []
  let response = (): Response => Response.json(storage.config)
  const bridge = createPreviewBridge({ instance: 'fresh-storage', scene: 'settings-storage-states', preferences: defaultRendererPreferences('zh'), storage, request: async (input, init) => {
    calls.push({ url: String(input), credentials: init?.credentials, cache: init?.cache })
    return response()
  } })
  assert.equal((await bridge.storageConfig()).home, '/preview/home')
  response = () => Response.json({ ...storage.config, home: '/preview/updated' })
  assert.equal((await bridge.storageConfig()).home, '/preview/updated')
  const failedResponse = Response.json({ detail: PREVIEW_STORAGE_READ.failure }, { status: 503 })
  response = () => failedResponse
  await assert.rejects(bridge.storageConfig(), /503/)
  assert.equal(failedResponse.bodyUsed, true)
  response = () => Response.json({ ...storage.config, home: '/Users/private' })
  await assert.rejects(bridge.storageConfig(), /Invalid preview storage bootstrap/)
  assert.equal(calls.length, 4)
  for (const call of calls) {
    const url = new URL(call.url, 'http://preview.local')
    assert.equal(url.pathname, PREVIEW_STORAGE_READ.configPath)
    assert.equal(url.searchParams.get('previewInstance'), 'fresh-storage')
    assert.equal(call.credentials, 'omit')
    assert.equal(call.cache, 'no-store')
  }
})

test('account bridge accepts only its validated ephemeral bootstrap and never adopts supplied credentials', async () => {
  const account = new PreviewAccount('account-bridge', 'ready')
  const preferences = defaultRendererPreferences('zh')
  const state = await readPreviewAccountState(Response.json({ preferences, account: account.bootstrap() }), 'account-bridge', 'ready')
  const bridge = createPreviewBridge({ instance: 'account-bridge', scene: 'settings-account-ready', preferences: state.preferences, account: state.account, simulation: { account: 'ready' }, request: async () => { throw new Error('Unexpected network request') } })
  assert.equal(await bridge.getAuthToken(), state.account!.capability)
  assert.equal((await bridge.setAuthToken('a-real-token-must-never-be-adopted')).ok, false)
  assert.equal(await bridge.getAuthToken(), state.account!.capability)
  assert.equal((await bridge.setAuthToken('')).ok, true)
  assert.equal(await bridge.getAuthToken(), '')
  await assert.rejects(readPreviewAccountState(Response.json({ preferences, account: account.bootstrap() }), 'another-instance', 'ready'), /Invalid preview account bootstrap/)
  await assert.rejects(readPreviewAccountState(Response.json({ preferences }), 'account-bridge', 'ready'), /Invalid preview account bootstrap/)
})

test('declared permission failures remain retryable failures without real network or authority changes', async () => {
  let requests = 0
  const bridge = createPreviewBridge({
    instance: 'permissions-failed', scene: 'settings-permissions-failed',
    preferences: defaultRendererPreferences('zh'), simulation: { permissions: 'failed' },
    request: async () => { requests++; throw new Error('Unexpected network request') },
  })
  await assert.rejects(bridge.systemPermissions(), /preview_permissions_query_failed/)
  await assert.rejects(bridge.systemPermissions(), /preview_permissions_query_failed/)
  assert.equal(await bridge.openSystemPermission('screen'), false)
  assert.equal(requests, 0)
})

test('permission policy comes from the selected catalog scene rather than arbitrary URL flags', async () => {
  assert.deepEqual(previewScenarioSimulation('settings-permissions-states', 'settings-permissions'), { permissions: 'normal' })
  assert.deepEqual(previewScenarioSimulation('settings-permissions-pending', 'settings-permissions'), { permissions: 'delayed' })
  assert.deepEqual(previewScenarioSimulation('settings-permissions-failed', 'settings-permissions'), { permissions: 'failed' })
  assert.equal(previewScenarioSimulation('settings-permissions-failed', 'page-home'), undefined)
  assert.equal(previewScenarioSimulation('permissions-failed', 'settings-permissions'), undefined)
  assert.equal(previewScenarioSimulation('settings-permissions-failed', 'unknown-page'), undefined)
  const bridge = createPreviewBridge({ instance: 'normal', scene: 'settings-permissions-states', preferences: defaultRendererPreferences('zh'), simulation: { permissions: 'normal' }, request: async () => { throw new Error('Unexpected network request') } })
  assert.deepEqual(await bridge.systemPermissions(), { platform: 'browser', permissions: unavailablePermissionRecords() })
})

test('a declared delayed permission query eventually returns the same honest unavailable snapshot', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const bridge = createPreviewBridge({
    instance: 'permissions-delayed', scene: 'settings-permissions-pending',
    preferences: defaultRendererPreferences('zh'), simulation: { permissions: 'delayed' },
    request: async () => { throw new Error('Unexpected network request') },
  })
  let completed = false
  const result = bridge.systemPermissions().then(snapshot => { completed = true; return snapshot })
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1_999)
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  assert.deepEqual(await result, { platform: 'browser', permissions: unavailablePermissionRecords() })
})

test('preview bridge keeps identity and preferences in its scene namespace without browser globals', async () => {
  const preferences = defaultRendererPreferences('zh')
  const requests: { url: string; init?: RequestInit }[] = []
  const bridge = createPreviewBridge({
    instance: 'tab-one',
    scene: 'conversation-approval',
    preferences,
    request: async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({ preferences })
    },
  })
  await bridge.setAuthToken('must-not-persist')
  assert.equal(await bridge.getAuthToken(), '')
  await bridge.openExternal('https://example.com')
  assert.deepEqual(await bridge.saveFileCopy({ suggestedName: 'output.txt', bytes: new Uint8Array() }), { ok: false, error: 'preview_download_unavailable' })
  assert.equal(requests.length, 0)
  await bridge.savePreferences(preferences)
  assert.equal(requests[0].url, previewStatePath('tab-one', 'conversation-approval'))
  assert.equal(requests[0].init?.method, 'POST')
  assert.deepEqual(await bridge.getDeviceInfo(), { device_id: 'tab-one', device_label: 'ScholarSeed Preview' })
})

test('preview bridge rejects malformed preference responses rather than silently replacing state', async () => {
  const bridge = createPreviewBridge({ instance: 'tab', scene: 'page-home', preferences: defaultRendererPreferences('en'), request: async () => Response.json({}) })
  await assert.rejects(bridge.reconcilePreferences(), /invalid/)
})

test('preview initialization exposes unavailable surface diagnostics without hiding protocol errors', async () => {
  await assert.rejects(readPreviewState(Response.json({ code: 'preview_surface_unavailable', pageId: 'settings-account', scene: 'settings-account-default' }, { status: 501 })), /501.*preview_surface_unavailable.*settings-account.*settings-account-default/)
  await assert.rejects(readPreviewState(new Response('not JSON', { status: 500 })), /500/)
  await assert.rejects(readPreviewState(Response.json({})), /invalid/)
  const preferences = defaultRendererPreferences('zh')
  assert.deepEqual(await readPreviewState(Response.json({ preferences })), sanitizeRendererPreferences(preferences))
})

test('explicit page identity reaches the state boundary without depending on the referrer', async () => {
  const pageId = 'unknown-preview-page'
  const requests: string[] = []
  const bridge = createPreviewBridge({
    instance: 'page-boundary', scene: 'page-home', pageId,
    preferences: defaultRendererPreferences('zh'),
    request: async input => {
      const url = String(input)
      requests.push(url)
      const query = new URL(url, 'http://127.0.0.1').searchParams
      return query.get('page') === pageId
        ? Response.json({ code: 'preview_unknown_page', pageId, scene: 'page-home' }, { status: 400 })
        : Response.json({ preferences: defaultRendererPreferences('zh') })
    },
  })
  await assert.rejects(bridge.reconcilePreferences(), /400.*preview_unknown_page.*unknown-preview-page.*page-home/)
  assert.equal(new URL(requests[0], 'http://127.0.0.1').searchParams.get('page'), pageId)
})
test('browser settings simulation uses instance-scoped typed requests without enabling the native browser', async () => {
  const calls: { path: string; instance: string | null; body: unknown; credentials?: RequestCredentials }[] = []
  const policy = { revision: 1, agentBrowserUseEnabled: false, sites: [] }
  const bridge = createPreviewBridge({
    instance: 'browser-settings-bridge', scene: 'settings-browser-ready',
    preferences: defaultRendererPreferences('zh'), simulation: { browser: { seed: 'sample' } },
    request: async (input, init) => {
      const url = new URL(String(input), 'http://preview.local')
      calls.push({ path: url.pathname, instance: url.searchParams.get('previewInstance'), body: JSON.parse(String(init?.body)), credentials: init?.credentials })
      return Response.json({ ok: true, policy })
    },
  })
  assert.deepEqual(await bridge.browser.policy({ kind: 'read' }), { ok: true, policy })
  assert.deepEqual(calls, [{ path: '/__preview/browser/policy', instance: 'browser-settings-bridge', body: { kind: 'read' }, credentials: 'omit' }])
  assert.equal(bridge.browserEnabled, false)
  assert.equal((await bridge.browser.snapshot()).ok, false)
  assert.equal((await bridge.browser.dispatch({ kind: 'automation', enabled: true })).ok, false)
  assert.equal((await bridge.browser.downloads({ kind: 'choose-directory' })).ok, false)
  assert.equal(calls.length, 1)
})

test('browser surface bridge projects only simulated snapshots and commands without exposing native helpers', async () => {
  const calls: { path: string; instance: string | null; body: unknown }[] = []
  const snapshot = { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
  const bridge = createPreviewBridge({
    instance: 'browser-surface-bridge', scene: 'browser-blank', pageId: 'page-browser',
    preferences: defaultRendererPreferences('zh'), simulation: { browser: { seed: 'empty', surface: { seed: 'empty' } } },
    request: async (input, init) => {
      const url = new URL(String(input), 'http://preview.local')
      calls.push({ path: url.pathname, instance: url.searchParams.get('previewInstance'), body: JSON.parse(String(init?.body)) })
      assert.equal(init?.credentials, 'omit')
      return Response.json({ ok: true, snapshot })
    },
  })
  assert.deepEqual(await bridge.browser.snapshot(), { ok: true, snapshot })
  assert.deepEqual(await bridge.browser.dispatch({ kind: 'open' }), { ok: true, snapshot })
  assert.deepEqual(calls, [
    { path: '/__preview/browser/snapshot', instance: 'browser-surface-bridge', body: {} },
    { path: '/__preview/browser/command', instance: 'browser-surface-bridge', body: { kind: 'open' } },
  ])
  assert.equal(bridge.browserEnabled, false)
  for (const key of ['page', 'frames', 'subscribeReveal', 'subscribeFind']) assert.equal(key in bridge.browser, false)
  assert.equal(bridge.menu, undefined)
})
