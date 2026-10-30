import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createPreviewService } from './service.ts'
import { PREVIEW_CATALOG } from './catalog.ts'

test('global Mock appearance and login survive navigation and resets without overriding fixed account policies', async context => {
  const service = createPreviewService()
  const server = createServer((request, response) => service.middleware(request, response, () => response.writeHead(404).end()))
  context.after(async () => {
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const call = async (path: string, body?: unknown, instance = 'global-settings') => {
    const response = await fetch('http://127.0.0.1:' + address.port + path + '?previewInstance=' + instance, {
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    assert.equal(response.status, 200, path)
    return response.json()
  }
  const initial = await call('/__preview/reset', { pageId: 'page-home', scene: 'home-states' })
  await call('/__preview/state', { preferences: { ...initial.preferences, theme: 'dark', language: 'en' } })
  await call('/__preview/account', { mode: 'anonymous' })
  for (const pageId of ['page-conversation', 'page-resource', 'page-home']) {
    const page = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)!
    const state = await call('/__preview/reset', { pageId, scene: page.scenarios[0].id })
    assert.equal(state.preferences.theme, 'dark')
    assert.equal(state.preferences.language, 'en')
    assert.equal(state.preferences.lastLocation.view, page.target?.view)
    assert.equal(state.login, 'anonymous')
    assert.equal(state.account.mode, 'anonymous')
    assert.deepEqual((await call('/__preview/state')).preferences, state.preferences)
  }
  for (const page of PREVIEW_CATALOG) for (const scenario of page.scenarios.filter(candidate => candidate.simulation?.account)) {
    const state = await call('/__preview/reset', { pageId: page.id, scene: scenario.id })
    assert.equal(state.account.mode, scenario.simulation!.account)
    assert.equal(state.login, 'anonymous')
    const changed = await call('/__preview/account', { mode: 'ready' })
    assert.equal(changed.login, 'ready')
    assert.equal(changed.account.mode, scenario.simulation!.account)
    await call('/__preview/account', { mode: 'anonymous' })
  }
  const home = await call('/__preview/reset', { pageId: 'page-home', scene: 'home-states' })
  assert.equal(home.account.mode, 'anonymous')
  const separate = await call('/__preview/state', undefined, 'global-settings-separate')
  assert.equal(separate.preferences.theme, initial.preferences.theme)
  assert.equal(separate.preferences.language, initial.preferences.language)
  assert.equal(separate.login, 'ready')
})
