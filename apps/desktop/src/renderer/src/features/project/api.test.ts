import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProject,
  renameProject,
  listProjectFiles,
  readProjectTree,
  listExternalRoots,
  revokeRoot,
  selectExternalRootProject,
  listProjects,
  loadWorkspaceRoot,
} from './api.ts'
import { CONTENT_OPERATION_UNKNOWN, CONTENT_TREE_READ_TIMEOUT_MS } from '../../app/api/content.ts'
import { flushApiDiagnostics } from '../../app/api/diagnostics.ts'

test('project file search bounds the traversal separately from each directory page', async (context) => {
  const deadlines = new Map<AbortSignal, number>()
  const requests: Array<[string | null, string | null, AbortSignal | null | undefined]> = []
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  context.mock.method(AbortSignal, 'timeout', (duration: number) => {
    const signal = new AbortController().signal
    deadlines.set(signal, duration)
    return signal
  })
  context.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const query = new URL(url, 'http://serve.test').searchParams
    const path = query.get('path')
    requests.push([path, query.get('offset'), init?.signal])
    return Response.json({
      root: '/fixture',
      nodes: path
        ? [{ kind: 'file', path: 'folder/note.md' }]
        : [{ kind: 'dir', path: 'folder', available: true }],
      total: 1,
      offset: 0,
    })
  })
  const nodes = await listProjectFiles('project', new AbortController().signal)
  assert.deepEqual(
    nodes?.map(({ path }) => path),
    ['folder/note.md']
  )
  assert.deepEqual(
    requests.map(([path, offset]) => [path, offset]),
    [
      ['', '0'],
      ['folder', '0'],
    ]
  )
  assert.equal(new Set(requests.map(([, , signal]) => signal)).size, 2)
  const [budget, ...pageBudgets] = deadlines.values()
  assert.ok(budget > CONTENT_TREE_READ_TIMEOUT_MS && Number.isFinite(budget))
  assert.deepEqual(pageBudgets, [CONTENT_TREE_READ_TIMEOUT_MS, CONTENT_TREE_READ_TIMEOUT_MS])
})

test('a directory body parsed after the caller aborts is discarded', async (context) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const parsing = Promise.withResolvers<void>()
  const body = Promise.withResolvers<unknown>()
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json() {
      parsing.resolve()
      return body.promise
    },
  }))

  const controller = new AbortController()
  const result = readProjectTree('project', '', 0, controller.signal)
  await parsing.promise
  controller.abort()
  body.resolve({ root: '/fixture', nodes: [], total: 0, offset: 0 })
  assert.equal(await result, null)
})

test('a project write whose response was lost keeps unknown outcome without replaying', async (context) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  context.after(() => {
    flushApiDiagnostics()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  let writes = 0
  context.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes += 1
    throw new TypeError('Connection closed after the write was processed')
  })
  assert.deepEqual(await createProject('new'), {
    ok: false,
    error: CONTENT_OPERATION_UNKNOWN,
    project: undefined,
  })
  assert.equal(writes, 1)
})

test('a damaged synchronous rename receipt is checked once by ID within the original deadline', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  t.after(() => {
    flushApiDiagnostics()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const project = {
    id: 'private/id',
    name: 'New',
    description: 'Edited',
    pinned: false,
    root: '/private',
    layout: 'managed',
    available: true,
  }
  const changes = { description: project.description, pinned: project.pinned }
  const requests: Array<[string, RequestInit]> = []
  let readback: unknown = project
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push([url, init])
    return init.method === 'PATCH'
      ? new Response('{', { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
      : Response.json(readback)
  })
  for (const overrides of [
    null,
    { id: 'other' },
    { pinned: true },
    { name: 'Old' },
    { description: 'Old' },
    { layout: null },
  ]) {
    requests.length = 0
    readback = { ...project, ...overrides }
    const result = await renameProject(project.id, project.name, changes)
    assert.deepEqual(
      result,
      overrides
        ? { ok: false, error: CONTENT_OPERATION_UNKNOWN, project: undefined }
        : { ok: true, project }
    )
    assert.deepEqual(
      requests.map(([url, init]) => [init.method ?? 'GET', url]),
      [
        ['PATCH', '/api/content/projects'],
        ['GET', '/api/content/project?project=private%2Fid'],
      ]
    )
    assert.ok(requests[0][1].signal instanceof AbortSignal)
    assert.equal(requests[1][1].signal, requests[0][1].signal)
    assert.equal(requests[1][1].cache, 'no-store')
  }
})

test('missing creation identity, non-JSON 200 and expired readback remain unconfirmed without another write', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  t.after(() => {
    flushApiDiagnostics()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  const json = { 'Content-Type': 'application/json' }
  const receipts = [
    new Response(null, { status: 403 }),
    new Response('{', { status: 202, headers: json }),
    Response.json({}),
    new Response(null, { status: 204 }),
    new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{', { headers: json }),
  ]
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(init.method ?? 'GET')
    if (init.method) return receipts.shift()
    deadline.abort()
    return Response.json({ id: 'p', name: 'New', root: '/p', layout: 'managed', available: true })
  })
  const unknown = { ok: false, error: CONTENT_OPERATION_UNKNOWN, project: undefined }
  assert.deepEqual(await createProject('New'), { ok: false, error: 'http_403', project: undefined })
  for (let i = 0; i < 3; i++) assert.deepEqual(await createProject('New'), unknown)
  assert.deepEqual(await renameProject('p', 'New'), unknown)
  assert.deepEqual(await renameProject('p', 'New'), unknown)
  assert.deepEqual(requests, ['POST', 'POST', 'POST', 'POST', 'PATCH', 'PATCH', 'GET'])
})

test('a damaged operation read reports the GET once and never repeats the accepted creation', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  flushApiDiagnostics()
  t.after(() => {
    flushApiDiagnostics()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const operation = 'a'.repeat(32)
  const diagnostics: string[] = []
  const calls: string[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => diagnostics.push(args.join(' ')))
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    return init.method === 'POST'
      ? Response.json({ operation }, { status: 202 })
      : new Response('{')
  })
  assert.deepEqual(await createProject('Private name'), {
    ok: false,
    project: undefined,
    error: CONTENT_OPERATION_UNKNOWN,
  })
  assert.deepEqual(calls, [
    'POST /api/content/projects',
    `GET /api/content/operations/${operation}`,
  ])
  const failures = diagnostics
    .filter((line) => line.startsWith('[api-request] '))
    .map((line) => JSON.parse(line.slice('[api-request] '.length)))
  assert.deepEqual(
    failures.map(({ route, method, status, reason }) => [route, method, status, reason]),
    [['/api/content/operations', 'GET', 200, 'invalid-json']]
  )
  assert.ok(!JSON.stringify(failures).includes(operation))
})

test('owned project listings bypass browser cache locks while workspace root keeps the default request cache', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: RequestInit[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async (url, options) => {
      requests.push(options ?? {})
      return Response.json(
        String(url).startsWith('/api/content/projects')
          ? { projects: [], current: '', workspaceRoot: '/workspace' }
          : { root: '/workspace', configured: '' }
      )
    }
    assert.ok(await listProjects(true))
    assert.ok(await listProjects())
    assert.ok(await loadWorkspaceRoot())
    assert.deepEqual(
      requests.map((request) => request.cache),
      ['no-store', 'no-store', undefined]
    )
    assert.ok(requests.every((request) => request.credentials === 'include'))
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

const payload = (projectId: string, sourcePath: string) => ({
  roots: [
    {
      root_id: `root-${projectId}`,
      project_id: projectId,
      mount_path: 'resources/source.txt',
      source_path: sourcePath,
      kind: 'file',
      authorized_at: 1,
      available: true,
    },
  ],
  writableRoots: [`/projects/${projectId}`, sourcePath],
})

test('revocation preserves affected session IDs for immediate interruption', async () => {
  const calls: string[] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async () => true,
      },
    },
    fetch: async (input: string, options?: RequestInit) => {
      calls.push(options?.method || 'GET')
      return Response.json(
        options?.method === 'DELETE'
          ? { revoked: true, agentSessionsAffected: ['idle-session', 'running-session'] }
          : payload('project-revoked', '/external/remaining.txt')
      )
    },
  })
  selectExternalRootProject('project-revoked')
  assert.deepEqual(await revokeRoot('project-revoked', 'linked-root'), {
    ok: true,
    agentSessionsAffected: ['idle-session', 'running-session'],
  })
  assert.deepEqual(calls, ['DELETE', 'GET'])
})

test('external root listing waits until Electron has replaced its authorization snapshot', async () => {
  let finishSync: ((value: boolean) => void) | undefined
  const synchronized = new Promise<boolean>((resolve) => {
    finishSync = resolve
  })
  const calls: Array<{ scope: string; roots: string[] }> = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (scope: string, roots: string[]) => {
          calls.push({ scope, roots })
          return synchronized
        },
      },
    },
    fetch: async () => Response.json(payload('project-1', '/external/source.txt')),
  })
  selectExternalRootProject('project-1')
  calls.length = 0

  let settled = false
  const listing = listExternalRoots('project-1').then((result) => {
    settled = true
    return result
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)
  assert.deepEqual(calls, [
    {
      scope: 'external',
      roots: ['/projects/project-1', '/external/source.txt'],
    },
  ])

  finishSync?.(true)
  assert.deepEqual(await listing, {
    roots: [
      {
        rootId: 'root-project-1',
        projectId: 'project-1',
        mountPath: 'resources/source.txt',
        sourcePath: '/external/source.txt',
        kind: 'file',
        authorizedAt: 1,
        available: true,
      },
    ],
    writableRoots: ['/projects/project-1', '/external/source.txt'],
  })
})

test('authorization acknowledgment gets its own deadline and a timed-out update never grants a listing', async (context) => {
  const deadlines: AbortController[] = []
  const reply = Promise.withResolvers<boolean>()
  const started = Promise.withResolvers<void>()
  context.mock.method(AbortSignal, 'timeout', () => {
    const deadline = new AbortController()
    deadlines.push(deadline)
    return deadline.signal
  })
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          if (roots.length === 0) return true
          started.resolve()
          return reply.promise
        },
      },
    },
    fetch: async () => Response.json(payload('project-phase-budget', '/external/source.txt')),
  })
  selectExternalRootProject('project-phase-budget')
  const listing = listExternalRoots('project-phase-budget')
  await started.promise
  assert.equal(deadlines.length, 2)
  let settled = false
  void listing.then(() => {
    settled = true
  })
  deadlines[0].abort()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  deadlines[1].abort()
  assert.equal(await listing, null)
  reply.resolve(true)
})

test('a stale project response cannot replace the newer project authorization snapshot', async () => {
  let finishFirst: ((response: Response) => void) | undefined
  const firstResponse = new Promise<Response>((resolve) => {
    finishFirst = resolve
  })
  const synchronized: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synchronized.push(roots)
          return true
        },
      },
    },
    fetch: async (input: string) =>
      input.includes('project-a')
        ? firstResponse
        : Response.json(payload('project-b', '/external/b.txt')),
  })

  selectExternalRootProject('project-a')
  const stale = listExternalRoots('project-a')
  selectExternalRootProject('project-b')
  const current = listExternalRoots('project-b')
  assert.equal((await current)?.roots[0]?.projectId, 'project-b')
  finishFirst?.(Response.json(payload('project-a', '/external/a.txt')))
  assert.equal(await stale, null)
  assert.deepEqual(synchronized, [[], [], ['/projects/project-b', '/external/b.txt']])
})

test('concurrent callers for one project share the same authorization barrier', async () => {
  let fetches = 0
  const synchronized: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synchronized.push(roots)
          return true
        },
      },
    },
    fetch: async () => {
      fetches += 1
      return Response.json(payload('project-shared', '/external/shared.txt'))
    },
  })
  selectExternalRootProject('project-shared')
  synchronized.length = 0

  const first = listExternalRoots('project-shared')
  const second = listExternalRoots('project-shared')
  assert.equal(first, second)
  assert.equal((await first)?.roots[0]?.projectId, 'project-shared')
  assert.equal((await second)?.roots[0]?.projectId, 'project-shared')
  assert.equal(fetches, 1)
  assert.deepEqual(synchronized, [['/projects/project-shared', '/external/shared.txt']])
})

test('cancelling a tree waiter leaves shared external authorization to its owner', async (context) => {
  const savedFetch = globalThis.fetch
  const savedWindow = globalThis.window
  let finish: ((response: Response) => void) | undefined
  const response = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const synced: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synced.push(roots)
          return true
        },
      },
    },
    fetch: async () => response,
  })
  context.after(() => {
    selectExternalRootProject(null)
    globalThis.fetch = savedFetch
    globalThis.window = savedWindow
  })
  selectExternalRootProject('tree-project')
  const controller = new AbortController()
  const tree = listExternalRoots('tree-project', controller.signal)
  const shared = listExternalRoots('tree-project')
  controller.abort()
  assert.equal(await tree, null)
  assert.deepEqual(synced, [[]])
  finish?.(Response.json(payload('tree-project', '/external/tree.txt')))
  assert.equal((await shared)?.roots[0]?.projectId, 'tree-project')
  assert.deepEqual(synced, [[], ['/projects/tree-project', '/external/tree.txt']])
})

test('leaving a project fences its response even without another roots request', async () => {
  let finish: ((response: Response) => void) | undefined
  const response = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const synchronized: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synchronized.push(roots)
          return true
        },
      },
    },
    fetch: async () => response,
  })
  selectExternalRootProject('project-a')
  const stale = listExternalRoots('project-a')
  selectExternalRootProject(null)
  selectExternalRootProject('project-a')
  finish?.(Response.json(payload('project-a', '/external/a.txt')))
  assert.equal(await stale, null)
  assert.deepEqual(synchronized, [[], [], []])
})

test('project management can enumerate inactive roots without authorizing them', async () => {
  const synchronized: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synchronized.push(roots)
          return true
        },
      },
    },
    fetch: async () => Response.json(payload('project-a', '/external/a.txt')),
  })
  selectExternalRootProject(null)
  const listing = await listExternalRoots('project-a')
  assert.equal(listing?.roots[0]?.projectId, 'project-a')
  assert.deepEqual(synchronized, [[]])
})
