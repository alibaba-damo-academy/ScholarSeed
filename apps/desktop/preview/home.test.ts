import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import test, { type TestContext } from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { homeSeed, homeSessionPage, PreviewHomeRead, PREVIEW_HOME } from './home.ts'
import { createPreviewService } from './service.ts'
import { pdfeNavigationGroup, PDFE_PAGE_GROUPS } from './hierarchy.ts'
import { PROJECT_NAME_MAX } from '../src/renderer/src/contracts/content.ts'
import { PREVIEW_LOGIN } from './accounts.ts'
import { pdfeTitle, pdfePageMatches, pdfePageIdentityMatches, pdfeScenarioMatches, pdfeNavigationPages, pdfeNavigationScenarios, pdfeStateLabel, type PdfeTranslate } from './collaboration.ts'
import { createLocalization } from '../src/localization/engine.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

const LIFECYCLE_TIMEOUT_MS = 10_000
const LIFECYCLE_POLL_MS = 10

test('project center project read failure persists until explicit recovery without changing data', async context => {
  const runtime = await centerRuntime(context)
  const instance = 'center-project-read'
  assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-project-read-failed' })).status, 200)
  const before = (await runtime.call(instance, '/__preview/state')).body
  for (const query of ['', '?includeArchived=true', '']) assert.equal((await runtime.call(instance, '/api/content/projects' + query)).status, 503)
  assert.equal((await runtime.call(instance, '/__preview/home/projects/recover', {})).status, 200)
  assert.equal((await runtime.call(instance, '/__preview/home/projects/recover', {})).status, 200)
  assert.equal((await runtime.call(instance, '/api/content/projects')).status, 200)
  const after = (await runtime.call(instance, '/__preview/state')).body
  assert.deepEqual(after.projects, before.projects)
  assert.deepEqual(after.sessions, before.sessions)
  assert.deepEqual(after.preferences, before.preferences)
  assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-project-read-failed' })).status, 200)
  assert.equal((await runtime.call(instance, '/api/content/projects')).status, 503)
  assert.equal((await runtime.call('normal-project-read', '/__preview/home/projects/recover', {})).status, 409)
})

test('project center first-load failures cover concurrent renderer reads before retry', async () => {
  const reader = new PreviewHomeRead('fail-once')
  const outcomes = await Promise.all([reader.read(new AbortController().signal), reader.read(new AbortController().signal)])
  assert.deepEqual(outcomes, ['failed', 'failed'])
  assert.equal(await reader.read(new AbortController().signal), 'ready')
  reader.dispose()
})

test('project center delayed task reads cancel on abort and disposal', async () => {
  const reader = new PreviewHomeRead('delayed')
  const first = new AbortController()
  const second = new AbortController()
  const aborted = reader.read(first.signal)
  const disposed = reader.read(second.signal)
  first.abort()
  assert.equal(await aborted, 'cancelled')
  reader.dispose()
  assert.equal(await disposed, 'cancelled')
  assert.equal(await reader.read(new AbortController().signal), 'cancelled')
})

test('project center task read failure is isolated, retryable and rearmed by reset', async context => {
  const runtime = await centerRuntime(context)
  const instance = 'center-task-retry'
  const other = 'center-task-normal'
  const listing = '/api/serve/sessions?scope=all&include_last_agent_reply=true&limit=' + PREVIEW_HOME.sessionPage
  assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-task-retry' })).status, 200)
  assert.equal((await runtime.call(other, '/__preview/reset', { pageId: 'page-home', scene: 'home-states' })).status, 200)
  assert.equal((await runtime.call(instance, '/api/serve/sessions?scope=project')).status, 200)
  assert.equal((await runtime.call(instance, listing)).status, 503)
  const retried = await runtime.call(instance, listing)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.sessions.length, 1)
  assert.equal((await runtime.call(other, listing)).status, 200)
  assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-task-retry' })).status, 200)
  assert.equal((await runtime.call(instance, listing)).status, 503)
})

async function centerRuntime(context: TestContext, observeUpload?: () => void) {
  const service = createPreviewService()
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/api/content/projects?') && request.headers['transfer-encoding'] === 'chunked') request.once('data', () => observeUpload?.())
    service.middleware(request, response, () => response.writeHead(404).end())
  })
  context.after(async () => {
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const call = async (instance: string, path: string, body?: unknown, method?: string) => {
    const response = await fetch(origin + path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ previewInstance: instance }), {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { service, origin, call }
}

for (const boundary of ['reset', 'delete', 'dispose'] as const) {
  test('project center rejects uploaded requests admitted before instance ' + boundary, { timeout: LIFECYCLE_TIMEOUT_MS }, async context => {
    let observeUpload!: () => void
    const uploaded = new Promise<void>(resolve => { observeUpload = resolve })
    const runtime = await centerRuntime(context, observeUpload)
    const instance = 'center-upload-' + boundary
    assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-empty' })).status, 200)
    const late = httpRequest(runtime.origin + '/api/content/projects?' + new URLSearchParams({ previewInstance: instance }), { method: 'POST', headers: { 'content-type': 'application/json' } })
    context.after(() => late.destroy())
    const result = once(late, 'response')
    late.write('{"name":')
    await uploaded
    if (boundary === 'reset') assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-no-tasks' })).status, 200)
    else if (boundary === 'delete') assert.equal((await runtime.call(instance, '/__preview/state', undefined, 'DELETE')).status, 200)
    else runtime.service.dispose()
    late.end('"Late project"}')
    const [response] = await result
    assert.equal(response.statusCode, 409)
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { detail: 'preview_instance_reset' })
    if (boundary === 'dispose') assert.equal((await runtime.call(instance, '/__preview/state')).status, 503)
    else {
      const state = await runtime.call(instance, '/__preview/state?page=page-home&scene=home-empty')
      assert.equal(state.status, 200)
      assert.equal(state.body.projects.length, boundary === 'reset' ? 3 : 0)
      assert.deepEqual(state.body.sessions, [])
      assert.ok(state.body.projects.every((project: { name: string }) => project.name !== 'Late project'))
    }
  })
}

for (const boundary of ['reset', 'delete'] as const) {
  test('project center cancels running creation on ' + boundary + ' without affecting another instance', { timeout: LIFECYCLE_TIMEOUT_MS }, async context => {
    const runtime = await centerRuntime(context)
    const instance = 'center-operation-' + boundary
    const other = instance + '-other'
    for (const id of [instance, other]) assert.equal((await runtime.call(id, '/__preview/reset', { pageId: 'page-home', scene: 'home-create' })).status, 200)
    const submitted = await runtime.call(instance, '/api/content/projects', { name: 'Cancelled project' })
    assert.equal(submitted.status, 202)
    const operationPath = '/api/content/operations/' + submitted.body.operation
    const awaitOperation = async (id: string, path: string, target: string) => {
      const deadline = performance.now() + LIFECYCLE_TIMEOUT_MS
      do {
        const response = await runtime.call(id, path)
        assert.equal(response.status, 200)
        if (response.body.state === target) return response.body
        assert.notEqual(response.body.state, 'failed', JSON.stringify(response.body))
        await new Promise(resolve => setTimeout(resolve, LIFECYCLE_POLL_MS))
      } while (performance.now() < deadline)
      assert.fail('Operation did not reach ' + target)
    }
    await awaitOperation(instance, operationPath, 'running')
    if (boundary === 'reset') assert.equal((await runtime.call(instance, '/__preview/reset', { pageId: 'page-home', scene: 'home-empty' })).status, 200)
    else assert.equal((await runtime.call(instance, '/__preview/state', undefined, 'DELETE')).status, 200)
    assert.equal((await runtime.call(instance, '/__preview/state?page=page-home&scene=home-empty')).status, 200)
    const retained = await runtime.call(other, '/api/content/projects', { name: 'Independent project' })
    assert.equal(retained.status, 202)
    const completed = await awaitOperation(other, '/api/content/operations/' + retained.body.operation, 'succeeded')
    assert.equal(completed.result.name, 'Independent project')
    const state = await runtime.call(instance, '/__preview/state')
    assert.deepEqual(state.body.projects, [])
    assert.deepEqual(state.body.sessions, [])
    assert.equal((await runtime.call(instance, operationPath)).status, 404)
    assert.deepEqual((await runtime.call(other, '/api/content/projects')).body.projects.map((project: { name: string }) => project.name), ['Independent project'])
  })
}

test('page navigation groups actual product targets rather than implementation surface types', () => {
  const group = (id: string) => pdfeNavigationGroup(PREVIEW_CATALOG.find(page => page.id === id)!).id
  assert.equal(group('page-home'), 'center')
  assert.equal(group('page-projects'), 'center')
  assert.equal(group('surface-project-form'), 'center')
  assert.equal(group('surface-approval'), 'conversation')
  assert.equal(group('viewer-pdf'), 'workspace')
  assert.equal(group('settings-models'), 'settings')
  assert.equal(PREVIEW_CATALOG.find(page => page.id === 'page-home')!.title, '项目中心')
  for (const page of PREVIEW_CATALOG) assert.ok(PDFE_PAGE_GROUPS.includes(pdfeNavigationGroup(page)))
})

test('home sample policies preserve project ownership and reject impossible or unbounded catalogs', () => {
  const project = { id: 'sample', name: 'Example', root: '/preview/example', created_at: 1, layout: 'managed' as const, available: true }
  assert.deepEqual(homeSeed(project, { projects: 0, tasks: 0 }), { projects: [], tasks: [] })
  const dense = homeSeed(project, { projects: PREVIEW_HOME.projects, tasks: PREVIEW_HOME.tasks })
  assert.equal(new Set(dense.projects.map(project => project.id)).size, PREVIEW_HOME.projects)
  assert.ok(dense.tasks.every(task => dense.projects.some(project => project.root === task.project)))
  for (const policy of [{ projects: 0, tasks: 1 }, { projects: -1, tasks: 0 }, { projects: 1, tasks: Infinity }, { projects: PREVIEW_HOME.maximumProjects + 1, tasks: 0 }]) assert.throws(() => homeSeed(project, policy))
})

test('project-center labels and search use localized resources and counts from the actual scenario policy', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-home')!
  for (const language of ['zh', 'en'] as const) {
    const translate = createLocalization(language, { zh: { preview: zh }, en: { preview: en } }).getFixedT(null, 'preview' as never) as unknown as PdfeTranslate
    assert.equal(pdfeTitle(page, translate), language === 'zh' ? zh.pageProjectCenter : en.pageProjectCenter)
    for (const scenario of page.scenarios) {
      assert.ok(scenario.titleKey, scenario.id)
      const title = pdfeTitle(scenario, translate)
      assert.ok(!title.includes('{{'), title)
      assert.ok(title.includes(String(scenario.home!.projects)), title)
      assert.ok(title.includes(String(scenario.home!.tasks)), title)
      assert.ok(pdfePageMatches(page, title, 'all', translate))
    }
    const changed = { ...page.scenarios[0], home: { projects: 99, tasks: 88 } }
    assert.ok(pdfeTitle(changed, translate).includes('99'))
    assert.ok(pdfeTitle(changed, translate).includes('88'))
    assert.equal(pdfeTitle({ title: 'unchanged' }, translate), 'unchanged')
    assert.equal(pdfePageMatches(page, 'not-a-scene', 'all', translate), false)
    const archive = language === 'zh' ? '归档' : 'Archive'
    assert.equal(pdfePageIdentityMatches(page, archive, translate), false)
    assert.equal(pdfePageMatches(page, archive, 'all', translate), true)
    assert.ok(page.scenarios.some(scene => pdfeScenarioMatches(scene, archive, translate) && scene.id === 'home-project-actions'))
    const navigation = pdfeNavigationScenarios(page, page.id, 'home-states', '', translate)
    assert.ok(navigation.every(scene => !scene.aliasOf))
    assert.equal(navigation.length, page.scenarios.filter(scene => !scene.aliasOf).length)
    assert.deepEqual([...new Set(navigation.filter(scene => scene.section === 'areaDaily').map(scene => scene.group ?? scene.id))], ['homeRegularGroup', 'home-empty', 'home-no-tasks'])
    assert.ok(pdfeNavigationScenarios(page, page.id, 'home-create', '', translate).some(scene => scene.id === 'home-create'))
    for (const alias of page.scenarios.filter(scene => scene.aliasOf)) {
      const current = pdfeNavigationScenarios(page, page.id, alias.id, '', translate)
      assert.ok(current.some(scene => scene.id === alias.id))
      assert.ok(!current.some(scene => scene.id === alias.aliasOf), 'current aliases replace their equivalent navigation row')
      assert.equal(current.length, navigation.length)
      assert.equal(new Set(current.map(scene => scene.aliasOf ?? scene.id)).size, current.length)
      assert.deepEqual(pdfeNavigationScenarios(page, page.id, alias.id, alias.aliasOf!, translate).map(scene => scene.id), [alias.aliasOf])
    }
    assert.deepEqual(pdfeNavigationScenarios(page, page.id, 'home-states', 'home-create', translate).map(scene => scene.id), ['home-create'])
    assert.ok(pdfeNavigationScenarios(page, page.id, 'home-states', archive, translate).some(scene => scene.capabilityKeys?.includes('tryProjectActions')))
    const pages = pdfeNavigationPages(PREVIEW_CATALOG, '', translate)
    for (const id of ['page-projects', 'viewer-projects']) assert.ok(!pages.some(candidate => candidate.id === id))
    const form = pages.find(candidate => candidate.id === 'surface-project-form')!
    assert.deepEqual(form.navigation, { parentPage: page.id, section: 'areaDaily' })
    const searched = pdfeNavigationPages(PREVIEW_CATALOG, pdfeTitle(form, translate), translate)
    assert.ok(searched.some(candidate => candidate.id === page.id))
    assert.ok(searched.some(candidate => candidate.id === form.id))
    assert.equal(pdfeStateLabel('unknown-state', translate), 'unknown-state')
  }
  assert.deepEqual([...new Set(page.scenarios.map(scenario => scenario.section))], ['areaDaily', 'areaBoundaries', 'areaRecovery'])
  for (const scene of page.scenarios.filter(scenario => scenario.section === 'areaRecovery')) assert.ok(scene.home?.read || scene.home?.projectRead)
  for (const id of ['home-empty', 'home-no-tasks']) assert.equal(page.scenarios.find(scenario => scenario.id === id)?.section, 'areaDaily')
  for (const scene of page.scenarios.filter(scenario => scenario.aliasOf)) {
    const canonical = page.scenarios.find(candidate => candidate.id === scene.aliasOf)
    assert.ok(canonical && !canonical.aliasOf)
    assert.deepEqual(scene.home, canonical.home)
    assert.deepEqual(scene.simulation, canonical.simulation)
  }
})

test('session paging crosses the real batch boundary without truncation and rejects stale cursors', () => {
  const rows = Array.from({ length: PREVIEW_HOME.sessionPage + 1 }, (_, index) => index)
  const first = homeSessionPage(rows, String(PREVIEW_HOME.sessionPage), null, 'owned')
  assert.equal(first.sessions.length, PREVIEW_HOME.sessionPage)
  const second = homeSessionPage(rows, String(PREVIEW_HOME.sessionPage), first.next_cursor, 'owned')
  assert.equal(second.sessions.length, 1)
  assert.deepEqual([...first.sessions, ...second.sessions], rows)
  assert.equal(second.next_cursor, null)
  for (const cursor of ['other:500', 'owned:-1', 'owned:9999', 'owned:NaN']) assert.throws(() => homeSessionPage(rows, '500', cursor, 'owned'))
})

test('home seeds are reproducible and long-content policies preserve identities and ownership', () => {
  const base = { id: 'sample', name: 'Example', root: '/preview/example', created_at: 1, layout: 'managed' as const, available: true }
  const policy = { projects: 3, tasks: PREVIEW_HOME.taskPage + 1 }
  const standard = homeSeed(base, policy)
  assert.deepEqual(homeSeed({ ...base, created_at: 999 }, policy), standard)
  const long = homeSeed(base, { ...policy, content: 'long' })
  assert.deepEqual(long.projects.map(project => [project.id, project.root]), standard.projects.map(project => [project.id, project.root]))
  assert.deepEqual(long.tasks.map(task => [task.index, task.project]), standard.tasks.map(task => [task.index, task.project]))
  assert.ok(long.projects.every(project => project.name.length > base.name.length))
  assert.ok(long.projects.every(project => project.name.length === PROJECT_NAME_MAX))
  assert.ok(long.tasks.every((task, index) => task.title.length > standard.tasks[index].title.length))
  assert.deepEqual(base, { id: 'sample', name: 'Example', root: '/preview/example', created_at: 1, layout: 'managed', available: true })
  assert.throws(() => homeSeed(base, { ...policy, content: 'unsupported' } as never))
})

test('every project center button seeds the declared real HTTP project and task catalogs, with reset isolation', async () => {
  const service = createPreviewService()
  const server = createServer((request, response) => service.middleware(request, response, () => response.writeHead(404).end()))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const read = async (path: string, body?: unknown, expectedStatus = 200) => {
    const response = await fetch(origin + path, { headers: { referer: origin + '/?previewInstance=center-check', 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    assert.equal(response.status, expectedStatus, path)
    return response.json()
  }
  try {
    const page = PREVIEW_CATALOG.find(page => page.id === 'page-home')!
    for (const scene of page.scenarios) {
      assert.ok(scene.home, scene.id)
      await read('/__preview/reset', { pageId: page.id, scene: scene.id })
      if (scene.home.projectRead === 'failed') {
        assert.deepEqual(await read('/api/content/projects', undefined, 503), { detail: PREVIEW_HOME.projectReadFailure })
        await read(PREVIEW_HOME.recoveryPath, {})
      }
      const projects = (await read('/api/content/projects')).projects
      assert.equal(projects.length, scene.home.projects, scene.id)
      const sessions = []
      let cursor: string | null = null
      do {
        const result = await read('/api/serve/sessions?scope=all&limit=' + PREVIEW_HOME.sessionPage + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
        assert.equal(result.total, scene.home.tasks, scene.id)
        sessions.push(...result.sessions)
        cursor = result.next_cursor
      } while (cursor)
      assert.equal(sessions.length, scene.home.tasks, scene.id)
      assert.equal(new Set(sessions.map(session => session.session_id)).size, sessions.length)
      assert.ok(sessions.every(session => projects.some((project: { root: string }) => project.root === session.project_path)), scene.id)
    }
    await read('/__preview/reset', { pageId: page.id, scene: 'home-empty' })
    assert.deepEqual((await read('/api/content/projects')).projects, [])
    assert.deepEqual((await read('/api/serve/sessions')).sessions, [])
    for (const scene of ['home-empty', 'home-no-tasks', 'home-dense']) {
      await read('/__preview/reset', { pageId: page.id, scene })
      const before = await read('/__preview/state')
      assert.equal(before.account?.mode, 'ready')
      const other = await read('/__preview/state?previewInstance=other-center&page=page-home&scene=home-states')
      const anonymous = await read(PREVIEW_LOGIN.path, { mode: 'anonymous' })
      assert.equal(anonymous.account.mode, 'anonymous')
      assert.equal(anonymous.account.capability, null)
      assert.equal((await read('/api/auth/me')).auth, false)
      assert.deepEqual(anonymous.projects, before.projects)
      assert.deepEqual(anonymous.sessions.map((session: { session_id: string }) => session.session_id), before.sessions.map((session: { session_id: string }) => session.session_id))
      assert.deepEqual(anonymous.preferences, before.preferences)
      const restored = await read(PREVIEW_LOGIN.path, { mode: 'ready' })
      assert.equal(restored.account.mode, 'ready')
      assert.equal((await read('/api/auth/me')).auth, true)
      assert.notEqual(restored.account.capability, before.account.capability)
      assert.deepEqual(restored.projects, before.projects)
      const unchanged = await read('/__preview/state?previewInstance=other-center')
      assert.deepEqual(unchanged.account, other.account)
      const rejected = await fetch(origin + '/api/account/me?previewInstance=center-check', { headers: { authorization: 'Bearer ' + before.account.capability } })
      assert.equal(rejected.status, 401)
      const accepted = await fetch(origin + '/api/account/me?previewInstance=center-check', { headers: { authorization: 'Bearer ' + restored.account.capability } })
      assert.equal(accepted.status, 200)
    }
    for (const body of [{ mode: 'failed' }, { mode: 'ready', token: 'real-token' }, {}]) {
      const rejected = await fetch(origin + PREVIEW_LOGIN.path + '?previewInstance=center-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(rejected.status, 400)
    }
    await read('/__preview/reset', { pageId: 'page-conversation', scene: 'conversation-stream' })
    const available = await fetch(origin + PREVIEW_LOGIN.path + '?previewInstance=center-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'anonymous' }) })
    assert.equal(available.status, 200)
    assert.equal((await available.json()).login, 'anonymous')
  } finally {
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
