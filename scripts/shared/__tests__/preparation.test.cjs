const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')
const test = require('node:test')
const { resolveExample } = require('../examples.cjs')
const { prepareExample } = require('../preparation.cjs')

async function contractServer(operation, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scholarseed-preparation-')))
  const workspace = join(root, '项目 workspace')
  mkdirSync(workspace)
  const calls = []
  const files = new Map()
  let projectCount = 0
  let operationReads = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    response.setHeader('content-type', 'application/json')
    const send = value => response.end(JSON.stringify(value))
    if (url.pathname === '/api/content/projects' && request.method === 'GET') {
      if (Object.hasOwn(options, 'catalog')) return send(options.catalog)
      const projects = (options.projects ?? []).filter(project => !project.archived || url.searchParams.get('includeArchived') === 'true')
      return send({ workspaceRoot: options.workspaceMismatch ? root : workspace, projects })
    }
    if (url.pathname === '/api/content/projects/directory') return send({ root: options.previewOutside ? root : join(workspace, `project-${projectCount + 1}`) })
    if (url.pathname === '/api/content/projects' && request.method === 'POST') {
      projectCount++
      response.statusCode = 202
      return send({ operation: String(projectCount).padStart(32, '0'), state: 'queued' })
    }
    if (url.pathname.startsWith('/api/content/operations/')) {
      operationReads++
      const identity = url.pathname.split('/').at(-1)
      const project = { id: `project-${Number(identity)}`, name: `Project ${Number(identity)}`, root: options.createdOutside ? root : join(workspace, `project-${Number(identity)}`), layout: 'managed' }
      mkdirSync(project.root, { recursive: true })
      if (operationReads === 1 && Object.hasOwn(options, 'invalidSuccessOnce')) return send({ operation: identity, state: 'succeeded', result: options.invalidSuccessOnce })
      if (options.onOperation) options.onOperation()
      return send({ operation: identity, state: options.failed ? 'failed' : 'succeeded', error: options.failed ? 'fixture_failure' : null, result: project })
    }
    if (url.pathname === '/api/resource/tree') return send({ root: join(workspace, url.searchParams.get('project')), resource_root: 'resources', total: options.nonEmptyResources ? 1 : 0, nodes: options.nonEmptyResources ? [{ path: 'resources/existing.md' }] : [], linked_roots: {} })
    if (url.pathname === '/api/resource/node') {
      if (options.fileFailure) { response.statusCode = 409; return send({ detail: 'fixture_conflict' }) }
      const parent = body.parent || 'resources'
      const name = body.action === 'create_document' && !body.name.endsWith('.md') ? body.name + '.md' : body.name
      const path = `${parent}/${name}`
      if (body.action === 'create_document') files.set(`${body.project}:${path}`, Buffer.from(body.content ?? ''))
      return send({ action: body.action, node: { path, name, kind: body.action === 'create_folder' ? 'dir' : 'file' } })
    }
    if (url.pathname === '/api/resource/write') {
      if (options.fileFailure) { response.statusCode = 409; return send({ detail: 'fixture_conflict' }) }
      files.set(`${body.project}:${body.path}`, Buffer.from(body.content))
      return send({ path: body.path, saved: true })
    }
    if (url.pathname === '/api/resource/import') {
      if (options.importConflict) return send({ status: 'needs_resolution', mode: 'copy', conflicts: [] })
      const source = body.sources[0]
      const name = basename(source)
      const target = `${body.target_dir || 'resources'}/${name}`
      files.set(`${body.project}:${target}`, readFileSync(source))
      return send({ status: 'completed', mode: 'copy', project_id: body.project, imported: [{ path: target, name, kind: 'file' }] })
    }
    if (url.pathname === '/api/resource/raw') {
      response.setHeader('content-type', 'application/octet-stream')
      return response.end(options.corrupt ? Buffer.from('changed') : files.get(`${url.searchParams.get('project')}:${url.searchParams.get('path')}`))
    }
    response.statusCode = 404
    return send({ detail: 'fixture_unknown_route' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await operation({ baseUrl: `http://127.0.0.1:${server.address().port}`, workspace, calls, files, root }) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
}

test('public HTTP preparation maps the shared plan without browser or filesystem writes', async () => contractServer(async context => {
  const plan = resolveExample()
  const result = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan })
  assert.equal(result.status, 'ready')
  assert.equal(result.contentDigest, plan.contentDigest)
  assert.equal(result.projects[0].key, plan.projects[0].key)
  assert.equal(result.projects[0].files.length, plan.projects[0].files.length)
  assert.equal(result.projects[0].files.find(file => file.id === 'document').path, 'resources/sample.md')
  assert.equal(result.projects[0].files.find(file => file.id === 'code').path, 'resources/sample.ts')
  assert.equal(context.calls.filter(call => call.path === '/api/resource/node' && call.body.action === 'create_document').length, 0)
  assert.equal(context.calls.filter(call => call.path === '/api/content/projects' && call.method === 'POST').length, 1)
}))

test('evaluation input preparation copies verified binary samples and creates nested folders', async () => contractServer(async context => {
  const plan = resolveExample({ projectId: 'evaluation' })
  const result = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan })
  assert.equal(result.status, 'ready')
  assert.equal(result.projects[0].files.length, plan.projects[0].files.length)
  assert.deepEqual(result.projects[0].files.filter(file => ['pdf', 'image', 'workbook'].includes(file.id)).map(file => file.path), ['resources/sample.pdf', 'resources/icon.png', 'resources/sample.xlsx'])
  assert.equal(context.calls.filter(call => call.path === '/api/resource/import').length, 3)
  assert.equal(context.calls.filter(call => call.path === '/api/resource/node' && call.body.action === 'create_folder').length, 2)
}))

test('binary preparation preserves the failed receipt and does not retry a conflict', async () => contractServer(async context => {
  const plan = resolveExample({ projectId: 'evaluation' })
  await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan }), error => error.code === 'preparation_import_invalid' && error.receipt.status === 'failed' && error.receipt.projects.length === 1)
  assert.equal(context.calls.filter(call => call.path === '/api/resource/import').length, 1)
}, { importConflict: true }))

test('empty workspace creates nothing and repeated templates get different product identities', async () => contractServer(async context => {
  const empty = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample({ workspaceId: 'empty' }) })
  assert.deepEqual(empty.projects, [])
  assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
  const pair = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample({ workspaceId: 'pair' }) })
  assert.deepEqual(pair.projects.map(project => project.key), ['first', 'second'])
  assert.equal(new Set(pair.projects.map(project => project.id)).size, 2)
}))

test('empty preparation verifies the archived-inclusive catalog without unrelated resource reads', async () => contractServer(async context => {
  const result = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample({ workspaceId: 'empty' }) })
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.projects, [])
  assert.deepEqual(context.calls, [{ method: 'GET', path: '/api/content/projects', query: { includeArchived: 'true' }, body: null }])
  assert.equal(context.files.size, 0)
}))

for (const archived of [false, true]) test(`empty preparation rejects an existing ${archived ? 'archived' : 'active'} project without mutations`, async () => contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample({ workspaceId: 'empty' }) }), error => {
      assert.equal(error.name, 'PreparationError')
      assert.equal(error.code, 'preparation_workspace_not_empty')
      assert.equal(error.receipt.status, 'failed')
      assert.deepEqual(error.receipt.projects, [])
      return true
    })
    assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(context.calls.length, 1)
}, { projects: [{ id: 'existing-project', archived }] }))

test('malformed project catalogs cannot establish an empty workspace or submit mutations', async () => {
  for (const catalog of [null, [], {}, { projects: null }, { projects: {} }, { projects: [null] }, { projects: [{}] }, { projects: [{ id: 1 }] }, { projects: [{ id: '' }] }, { projects: [{ id: ' ' }] }, { projects: [{ id: 'same' }, { id: 'same' }] }]) await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample({ workspaceId: 'empty' }) }), error => {
      assert.equal(error.name, 'PreparationError')
      assert.equal(error.code, 'preparation_catalog_invalid')
      assert.equal(error.receipt.status, 'failed')
      return true
    })
    assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
  }, { catalog })
})

test('default and pair preparation add their entities without requiring an empty catalog', async () => contractServer(async context => {
  for (const plan of [resolveExample(), resolveExample({ workspaceId: 'pair' })]) {
    const result = await prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan })
    assert.equal(result.status, 'ready')
    assert.equal(result.projects.length, plan.projects.length)
    assert.ok(result.projects.every(project => project.id !== 'existing-project'))
  }
  assert.equal(context.calls.filter(call => call.path === '/api/content/projects' && call.method === 'POST').length, 3)
}, { projects: [{ id: 'existing-project', archived: true }] }))

test('wrong runtime workspace rejects before mutations', async () => contractServer(async context => {
  await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample() }), /workspace/)
  assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
}, { workspaceMismatch: true }))

test('product failure, partial preparation and corrupt readback never report ready or retry mutations', async () => {
  for (const options of [{ failed: true }, { fileFailure: true }, { corrupt: true }]) await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample() }), error => {
      assert.equal(error.name, 'PreparationError')
      assert.equal(error.receipt.status, 'failed')
      return true
    })
    assert.equal(context.calls.filter(call => call.path === '/api/content/projects' && call.method === 'POST').length, 1)
  }, options)
})

test('remote endpoints and linked isolation roots reject safely', async () => contractServer(async context => {
  await assert.rejects(() => prepareExample({ baseUrl: 'https://example.com', workspace: context.workspace, plan: resolveExample() }), /endpoint/)
  const linked = join(context.root, 'linked')
  symlinkSync(context.workspace, linked, 'dir')
  await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: linked, plan: resolveExample() }), /workspace/)
  assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
}))

test('all media and text round trips are checked before any project mutation', async () => contractServer(async context => {
  const original = resolveExample()
  const first = original.projects[0]
  const binaryPlan = { ...original, projects: [{ ...first, files: [{ ...first.files[0], mediaType: 'application/octet-stream' }] }] }
  await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: binaryPlan }), /binary_not_supported/)
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x61]), Buffer.from([0x61, 0])]) {
    const sourcePath = join(context.root, 'invalid-text')
    writeFileSync(sourcePath, bytes)
    const file = { ...first.files[0], sourcePath, sourceRoot: context.root, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const plan = { ...original, projects: [{ ...first, files: [first.files[0], file] }] }
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan }), /utf8_required/)
  }
  assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
}))

test('project roots outside the nominated workspace never receive resource writes', async () => {
  await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample() }), /outside_workspace/)
    assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
  }, { previewOutside: true })
  await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample() }), /outside_workspace/)
    assert.equal(context.calls.filter(call => call.path === '/api/resource/node').length, 0)
  }, { createdOutside: true })
})

test('an aborted caller does not submit a new project', async () => contractServer(async context => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample(), signal: controller.signal }), error => error.name === 'PreparationError')
  assert.equal(context.calls.filter(call => call.method === 'POST').length, 0)
}))

test('invalid succeeded terminal results are rejected once and never replaced by a later response', async () => {
  for (const invalid of [null, undefined]) await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample() }), error => {
      assert.equal(error.code, 'preparation_operation_result_invalid')
      assert.equal(error.receipt.status, 'failed')
      assert.match(error.receipt.projects[0].operation, /^[a-f0-9]{32}$/)
      return true
    })
    assert.equal(context.calls.filter(call => call.path.startsWith('/api/content/operations/')).length, 1)
    assert.equal(context.calls.filter(call => call.path === '/api/resource/node').length, 0)
  }, { invalidSuccessOnce: invalid })
})

test('abort after submission preserves the accepted operation without repeating the mutation', async () => {
  const controller = new AbortController()
  await contractServer(async context => {
    await assert.rejects(() => prepareExample({ baseUrl: context.baseUrl, workspace: context.workspace, plan: resolveExample(), signal: controller.signal }), error => {
      assert.equal(error.name, 'PreparationError')
      assert.equal(error.receipt.status, 'failed')
      assert.match(error.receipt.projects[0].operation, /^[a-f0-9]{32}$/)
      return true
    })
    assert.equal(context.calls.filter(call => call.path === '/api/content/projects' && call.method === 'POST').length, 1)
    assert.equal(context.calls.filter(call => call.path === '/api/resource/node').length, 0)
  }, { onOperation: () => controller.abort() })
})
