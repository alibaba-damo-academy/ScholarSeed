import assert from 'node:assert/strict'
import type { FeedbackSubmissionRequest } from '../../feedback.ts'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import { flushApiDiagnostics } from './app/api/diagnostics.ts'
import { renderFeedback } from './contracts/feedback.ts'
import { describeTurnAdmissionFailure, turnAdmissionFeedback } from './input.ts'
import {
  formatApplicationRequestFailure,
  permissionModeFeedback,
  permissionModeSelectedFeedback,
  formatRuntimeStatus,
} from './runtime.ts'

import {
  adoptProject,
  createManagedProject,
  serviceErrorDetail,
  openSession,
  loadSessionCatalog,
  listSessions,
  listAllSessions,
  listProjects,
  setSessionArchived,
  deleteSession,
  readNavigationSession,
  confirmUnknownTurn,
  checkSessionRecovery,
  requestFailureFeedback,
  postTurn,
  postSide,
  sendQueuedMessage,
  setMode,
  setSessionModel,
  createSubscriptionProfile,
  parseOpenSessionResponse,
  classifySessionResumeFailure,
  interruptSession,
  respondHil,
  DiagnosticOperationError,
  getDiagnosticPolicy,
  getBackendHealth,
  prepareRuntime,
  getSkillDocument,
  getSkills,
  getMarketplace,
  getMarketplaceLabels,
  clearMarketplaceCache,
  getGlobalPermissionMode,
  setGlobalPermissionMode,
  DEFAULT_GLOBAL_PERMISSION_MODE,
  GLOBAL_PERMISSION_MODES,
  SkillCatalogError,
  SkillDocumentError,
  setSkillActive,
  deleteQueuedMessage,
  submitFeedback,
  uploadAttachmentFile,
  getSessionFiles,
} from './api.ts'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../skills.ts'

test('marketplace reuses catalogue pages and labels and coalesces concurrent visits', async () => {
  clearMarketplaceCache()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        deviceSkills: async (request: { operation: string }) => {
          requests.push(request)
          return {
            status: 200,
            body: JSON.stringify(
              request.operation === 'marketplace-labels'
                ? { labels: [] }
                : { items: [], nextCursor: null, registry: 'https://hub.example' }
            ),
          }
        },
      },
    },
  })
  try {
    await Promise.all([getMarketplace('cache-visit'), getMarketplace('cache-visit')])
    await getMarketplace('cache-visit')
    assert.equal(requests.length, 1)
    await Promise.all([getMarketplaceLabels('zh-CN'), getMarketplaceLabels('zh-CN')])
    await getMarketplaceLabels('zh-CN')
    assert.equal(requests.length, 2)
    await getMarketplace('cache-visit', 'next')
    await getMarketplace('cache-visit', '', 'research')
    await getMarketplace('cache-visit', '', '', 'zh-CN')
    await getMarketplace('cache-other')
    await getMarketplaceLabels('en-US')
    assert.equal(requests.length, 7)
  } finally {
    clearMarketplaceCache()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('marketplace expires, bounds and invalidates cached responses without retaining failures', async (context) => {
  clearMarketplaceCache()
  context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let requests = 0
  let fail = false
  let release: (() => void) | undefined
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        deviceSkills: async () => {
          requests += 1
          const failed = fail
          if (release)
            await new Promise<void>((resolve) => {
              release = resolve
            })
          return {
            status: failed ? 503 : 200,
            body: JSON.stringify({ items: [], nextCursor: null, registry: 'https://hub.example' }),
          }
        },
      },
    },
  })
  try {
    await getMarketplace('expiry')
    context.mock.timers.tick(6 * 60 * 1000)
    await getMarketplace('expiry')
    assert.equal(requests, 2)
    clearMarketplaceCache()
    await getMarketplace('expiry')
    assert.equal(requests, 3)
    fail = true
    await assert.rejects(getMarketplace('failure'))
    fail = false
    await getMarketplace('failure')
    assert.equal(requests, 5)
    for (let index = 0; index < 100; index += 1) await getMarketplace(`bounded-${index}`)
    await getMarketplace('expiry')
    assert.equal(requests, 106)
    release = () => {}
    const oldRequest = getMarketplace('late')
    clearMarketplaceCache()
    const releaseOld = release
    release = undefined
    await getMarketplace('late')
    releaseOld()
    await oldRequest
    await getMarketplace('late')
    assert.equal(requests, 108)
  } finally {
    clearMarketplaceCache()
    context.mock.timers.reset()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('session output browsing selects the output projection without changing workspace browsing', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '', addAuthorizedRoot: async () => true },
    },
  })
  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url))
      return Response.json({ root: '/session', items: [] })
    }
    await getSessionFiles('task', 'outputs', undefined, 2, true)
    await getSessionFiles('task', 'attachments')
    assert.equal(
      requests[0],
      '/api/serve/sessions/task/files?path=outputs&offset=2&outputs_only=true'
    )
    assert.equal(requests[1], '/api/serve/sessions/task/files?path=attachments')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('live task and mapped project catalogs bypass browser cache locks without changing other request defaults', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: { path: string; options?: RequestInit }[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '', syncAuthorizedRoots: async () => true } },
  })
  try {
    globalThis.fetch = async (url, options) => {
      const path = String(url)
      requests.push({ path, options })
      return Response.json(
        path.startsWith('/api/content/projects')
          ? { projects: [], current: '', workspaceRoot: '/workspace' }
          : path.startsWith('/api/serve/sessions')
            ? { sessions: [], next_cursor: null }
            : { mode: 'ask' }
      )
    }
    assert.equal((await loadSessionCatalog({ archived: true })).ok, true)
    assert.ok(await listProjects(true))
    await getGlobalPermissionMode()
    assert.equal(requests[0].options?.cache, 'no-store')
    assert.equal(requests[1].options?.cache, 'no-store')
    assert.equal(requests[2].options?.cache, undefined)
    assert.ok(requests.every((request) => request.options?.credentials === 'include'))
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('read-only recent-session queries preserve the global authorized roots', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const synchronized: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncAuthorizedRoots: async (...args: unknown[]) => {
          synchronized.push(args)
        },
      },
    },
  })
  try {
    globalThis.fetch = async (url) => {
      const query = new URL(String(url), 'http://localhost').searchParams
      assert.equal(query.get('scope'), 'project')
      assert.equal(query.get('limit'), '3')
      return Response.json({
        sessions: [{ session_id: 'recent', runtime_workdir: '/recent' }],
        next_cursor: 'older',
      })
    }
    const sessions = await listSessions(
      { scope: 'project', projectPath: '/project', limit: 3 },
      { synchronizeRoots: false }
    )
    assert.equal(sessions?.[0].session_id, 'recent')
    assert.deepEqual(synchronized, [])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('project archive pagination preserves its filter and does not replace authorized roots', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const synchronized: unknown[] = []
  const cursors: Array<string | null> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncAuthorizedRoots: async (...args: unknown[]) => {
          synchronized.push(args)
        },
      },
    },
  })
  try {
    globalThis.fetch = async (url) => {
      const query = new URL(String(url), 'http://localhost').searchParams
      assert.equal(query.get('scope'), 'project')
      assert.equal(query.get('project_path'), 'C:\\项目')
      assert.equal(query.get('archived'), 'true')
      cursors.push(query.get('cursor'))
      return Response.json(
        query.has('cursor')
          ? { sessions: [{ session_id: 'second', runtime_workdir: '/second' }], next_cursor: null }
          : { sessions: [{ session_id: 'first', runtime_workdir: '/first' }], next_cursor: 'next' }
      )
    }
    const rows = await listAllSessions(
      { scope: 'project', projectPath: 'C:\\项目', archived: true },
      () => true,
      { synchronizeRoots: false }
    )
    assert.deepEqual(
      rows?.map((row) => row.session_id),
      ['first', 'second']
    )
    assert.deepEqual(cursors, [null, 'next'])
    assert.deepEqual(synchronized, [])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('delete requires a matching acknowledgement after stopping the task', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), '/api/serve/sessions/task')
      assert.equal(options?.method, 'DELETE')
      return Response.json({ ok: true, session_id: 'task' })
    }
    assert.deepEqual(await deleteSession('task'), { ok: true, status: 200 })
    globalThis.fetch = async () => Response.json({ ok: true, session_id: 'other' })
    assert.equal((await deleteSession('task')).ok, false)
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 409 })
    assert.deepEqual(await deleteSession('task'), { ok: false, status: 409 })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('archive requires a matching acknowledgement and preserves an explicit archive filter', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '', syncAuthorizedRoots: async () => {} } },
  })
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), '/api/serve/sessions/task/archive')
      assert.equal(options?.method, 'PUT')
      assert.deepEqual(JSON.parse(String(options?.body)), { archived: true })
      return Response.json({ ok: true, session_id: 'task', archived: true })
    }
    assert.equal((await setSessionArchived('task', true)).ok, true)
    globalThis.fetch = async () => Response.json({ ok: true, session_id: 'other', archived: true })
    assert.equal((await setSessionArchived('task', true)).ok, false)
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url), 'http://localhost').searchParams.get('archived'), 'true')
      return Response.json({ sessions: [], next_cursor: null })
    }
    assert.deepEqual(await listAllSessions({ archived: true }), [])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('complete catalogs cross 500 rows and synchronize authorization only after the last page', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const synchronized: Array<{ scope: string; roots: string[] }> = []
  const cursors: Array<string | null> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncAuthorizedRoots: async (scope: string, roots: string[]) => {
          synchronized.push({ scope, roots })
        },
      },
    },
  })
  try {
    const first = Array.from({ length: 500 }, (_, index) => ({
      session_id: `task-${index}`,
      runtime_workdir: `/task-${index}`,
    }))
    globalThis.fetch = async (url) => {
      assert.equal(synchronized.length, 0)
      const query = new URL(String(url), 'http://localhost').searchParams
      cursors.push(query.get('cursor'))
      assert.equal(query.get('scope'), 'all')
      assert.equal(query.get('include_last_agent_reply'), 'true')
      return Response.json(
        query.has('cursor')
          ? {
              sessions: [
                { ...first[0], runtime_workdir: '/changed' },
                { session_id: 'tail', runtime_workdir: '/tail' },
              ],
              next_cursor: null,
            }
          : { sessions: first, next_cursor: 'next-page' }
      )
    }
    const rows = await listAllSessions({ scope: 'all', limit: 500, includeAgentReplyAt: true })
    assert.deepEqual(cursors, [null, 'next-page'])
    assert.equal(rows?.length, 501)
    assert.equal(rows?.[0].runtime_workdir, '/task-0')
    assert.deepEqual(synchronized, [
      { scope: 'session', roots: [...first.map((row) => row.runtime_workdir), '/tail'] },
    ])
    synchronized.length = 0
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return calls === 1
        ? Response.json({ sessions: first, next_cursor: 'tail' })
        : new Response('', { status: 503 })
    }
    assert.equal(await listAllSessions(), null)
    assert.equal(calls, 2)
    assert.equal(synchronized.length, 0)
    calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return Response.json({ sessions: first, next_cursor: 'loop' })
    }
    assert.equal(await listAllSessions(), null)
    assert.equal(calls, 2)
    calls = 0
    assert.equal(await listAllSessions({}, () => false), null)
    assert.equal(calls, 1)
    assert.equal(synchronized.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('session catalog forwards the opaque cursor and retains continuation metadata', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '', syncAuthorizedRoots: async () => {} } },
  })
  try {
    let requested = ''
    globalThis.fetch = async (url) => {
      requested = String(url)
      return Response.json({ sessions: [], total: 0, next_cursor: 'next/page=' })
    }
    const result = await loadSessionCatalog({
      scope: 'project',
      projectPath: '/project',
      limit: 10,
      cursor: 'last/page=',
    })
    const query = new URL(requested, 'http://localhost').searchParams
    assert.equal(query.get('cursor'), 'last/page=')
    assert.equal(query.get('project_path'), '/project')
    assert.equal(query.get('limit'), '10')
    assert.equal(result.ok && result.catalog.next_cursor, 'next/page=')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('session catalog preserves structured failures when the host bridge cannot synchronize roots', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncAuthorizedRoots: () => {
          throw new Error('bridge unavailable')
        },
      },
    },
  })
  try {
    globalThis.fetch = async () => Response.json({ sessions: [], next_cursor: null })
    assert.deepEqual(await loadSessionCatalog(), {
      ok: false,
      failure: { kind: 'transport', retryable: true },
    })
    assert.equal(await listAllSessions(), null)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('project catalogs preserve directory creation independently from registration time', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '', syncAuthorizedRoots: async () => {} } },
  })
  try {
    const project = {
      id: 'imported',
      name: 'Imported',
      root: '/imported',
      layout: 'legacy',
      available: true,
      created_at: 200,
      directory_created_at: 10,
    }
    globalThis.fetch = async () =>
      Response.json({ projects: [project], workspaceRoot: '/workspace' })
    const listing = await listProjects()
    assert.equal(listing?.projects[0].added_at, 200)
    assert.equal(listing?.projects[0].directory_created_at, 10)
    globalThis.fetch = async () => Response.json(project)
    const adopted = await adoptProject('/imported', 'Imported')
    assert.equal(adopted?.added_at, 200)
    assert.equal(adopted?.directory_created_at, 10)
    globalThis.fetch = async () =>
      Response.json({
        projects: [{ ...project, directory_created_at: null, available: false }],
        workspaceRoot: '/workspace',
      })
    assert.equal((await listProjects())?.projects[0].directory_created_at, null)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('project creation preserves backend-managed roots and explicit selected directory paths', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  const requests: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push({ url: String(input), body })
    return new Response(
      JSON.stringify({ id: 'project', name: body.name, root: body.path ?? '/managed/project' })
    )
  }
  try {
    assert.equal((await createManagedProject('Managed'))?.path, '/managed/project')
    for (const path of ['/tmp/研究项目', 'C:\\Research\\项目']) {
      assert.equal((await adoptProject(path, 'Selected'))?.path, path)
    }
    assert.deepEqual(requests, [
      { url: '/api/content/projects', body: { name: 'Managed' } },
      { url: '/api/content/projects/adopt', body: { path: '/tmp/研究项目', name: 'Selected' } },
      {
        url: '/api/content/projects/adopt',
        body: { path: 'C:\\Research\\项目', name: 'Selected' },
      },
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('basic health supports older attached Serve without bypassing failures', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    for (const status of [200, 404, 405, 401, 403, 500, 503]) {
      const requests: string[] = []
      globalThis.fetch = async (input) => {
        requests.push(String(input))
        return new Response(JSON.stringify({ ok: true, workbench_ready: true }), {
          status: requests.length === 1 ? status : 200,
        })
      }
      const result = await getBackendHealth()
      const legacy = status === 404 || status === 405
      assert.equal(result?.ok ?? false, status === 200 || legacy)
      assert.deepEqual(
        requests,
        legacy ? ['/api/healthz/backend', '/api/healthz'] : ['/api/healthz/backend']
      )
    }
    globalThis.fetch = async () => new Response('{}', { status: 404 })
    assert.equal(await getBackendHealth(), null)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('backend health shares its abort deadline with the legacy response body', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  globalThis.fetch = async (_input, init) => {
    signals.push(init!.signal!)
    if (signals.length === 1) return new Response('{}', { status: 404 })
    return {
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          })
          controller.abort()
        }),
    } as Response
  }
  try {
    assert.equal(await getBackendHealth(controller.signal), null)
    assert.deepEqual(signals, [controller.signal, controller.signal])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('preparation and first open preserve caller cancellation alongside their deadlines', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    for (const opening of [false, true]) {
      const controller = new AbortController()
      let requestSignal: AbortSignal | undefined
      globalThis.fetch = async (_input, init) =>
        new Promise((_resolve, reject) => {
          requestSignal = init!.signal!
          requestSignal.addEventListener('abort', () => reject(requestSignal!.reason), {
            once: true,
          })
          controller.abort(new DOMException('cancelled', 'AbortError'))
        })
      const pending = opening
        ? openSession({
            modelId: 'model',
            prepareRuntime: true,
            serviceInstanceId: 'instance',
            signal: controller.signal,
          })
        : prepareRuntime(
            {
              requestId: 'request',
              modelId: 'model',
              serviceInstanceId: 'instance',
              persistDefault: false,
            },
            controller.signal
          )
      if (opening) assert.equal('session_id' in (await pending)!, false)
      else await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(requestSignal?.aborted, true)
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('navigation fetches metadata without posting a runtime open', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  const requests: { url: string; method: string }[] = []
  const sessionId = 'saved/session'
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(
      JSON.stringify({
        session_id: sessionId,
        title: 'Saved task',
        title_fallback: null,
        runtime_workdir: '/workspace',
        project_path: null,
        runtime_id: 'codex',
        running: false,
      }),
      { status: 200 }
    )
  }
  try {
    const result = await readNavigationSession(sessionId)
    assert.ok('session_id' in result)
    assert.equal(result.session_id, sessionId)
    assert.equal(result.running, false)
    assert.equal(requests.length, 1)
    assert.ok(requests[0].url.endsWith('/api/serve/sessions/saved%2Fsession/navigation'))
    assert.equal(requests[0].method, 'GET')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('navigation preserves the missing-session code from the access guard', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: 'session not found', code: 'session_not_found' }), {
      status: 404,
    })
  try {
    const result = await readNavigationSession('deleted-session')
    assert.ok('error' in result)
    assert.equal(result.status, 404)
    assert.equal(result.code, 'session_not_found')
    assert.equal(result.detail, 'session not found')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('navigation rejects metadata for another session', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        session_id: 'other',
        title: 'Other',
        title_fallback: null,
        runtime_workdir: '/workspace',
        project_path: null,
        runtime_id: 'codex',
        running: false,
      }),
      { status: 200 }
    )
  try {
    const result = await readNavigationSession('saved')
    assert.ok('error' in result)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

for (const absolutePath of [
  '/workspace/session/attachments/image.png',
  'C:\\workspace\\session\\attachments\\image.png',
]) {
  test(`attachment upload preserves native and preview paths separately: ${absolutePath}`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        scholarseed: { getApiBase: () => '' },
        setTimeout,
        clearTimeout,
      },
    })
    const file = new File(['clipboard image'], 'image.png', { type: 'image/png' })
    const relativePath = 'attachments/image.png'
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/api/serve/sessions/session%2Fid/attachments')
        assert.equal(init?.method, 'POST')
        assert.equal(await ((init?.body as FormData).get('file') as File).text(), await file.text())
        return Response.json({
          absolute_path: absolutePath,
          relative_path: relativePath,
          name: file.name,
          media_type: file.type,
        })
      }
      const uploaded = await uploadAttachmentFile('session/id', file)
      assert.equal(uploaded?.path, absolutePath)
      assert.equal(uploaded?.relative_path, relativePath)
      assert.equal(uploaded?.media_type, file.type)
    } finally {
      globalThis.fetch = previousFetch
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}
for (const sessionId of [null, 'feedback-session']) {
  test(`feedback without diagnostic consent excludes logs and trace: ${sessionId}`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        scholarseed: {
          getApiBase: () => '',
          syncUpdateDiagnostics: async () => {
            assert.fail('no consent')
          },
          submitFeedback: async (request: FeedbackSubmissionRequest) => {
            assert.equal(request.description, 'Feedback test')
            assert.equal(request.includeLogs, false)
            assert.equal(request.includeTrace, false)
            assert.equal(request.sessionId, sessionId)
            assert.equal(request.images.length, 1)
            assert.equal(new TextDecoder().decode(request.images[0].bytes), 'screenshot')
            return { ok: true, id: 'feedback-ticket' }
          },
        },
        setTimeout,
        clearTimeout,
      },
    })
    try {
      globalThis.fetch = async () => {
        assert.fail('Desktop feedback must not use local HTTP')
      }
      assert.deepEqual(
        await submitFeedback({
          description: 'Feedback test',
          includeLogs: false,
          includeTrace: false,
          sessionId,
          images: [new File(['screenshot'], 'screenshot.png', { type: 'image/png' })],
        }),
        { ok: true, id: 'feedback-ticket' }
      )
    } finally {
      globalThis.fetch = previousFetch
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}

test('feedback consent forwards logs, trace, and only the selected session', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncUpdateDiagnostics: async () => {
          assert.fail('host owns diagnostic collection')
        },
        submitFeedback: async (request: FeedbackSubmissionRequest) => {
          assert.equal(request.includeLogs, true)
          assert.equal(request.includeTrace, true)
          assert.equal(request.sessionId, 'selected-session')
          return { ok: true, id: 'feedback-ticket' }
        },
      },
      setTimeout,
      clearTimeout,
    },
  })
  try {
    globalThis.fetch = async () => {
      assert.fail('Desktop feedback must not use local HTTP')
    }
    assert.deepEqual(
      await submitFeedback({
        description: 'Feedback test',
        includeLogs: true,
        includeTrace: true,
        sessionId: 'selected-session',
      }),
      { ok: true, id: 'feedback-ticket' }
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('queue withdrawal preserves business errors and uncertain transport results', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      setTimeout,
      clearTimeout,
    },
  })
  try {
    for (const [status, error] of [
      [404, 'session_not_found'],
      [409, 'queued_message_not_editable'],
    ] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error }), { status })
      const result = await deleteQueuedMessage('session', 'message')
      assert.equal(result.ok, false)
      assert.equal(result.status, status)
      assert.equal(result.error, error)
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }))
    assert.equal((await deleteQueuedMessage('session', 'message')).ok, true)
    globalThis.fetch = async () => {
      throw new TypeError('connection lost')
    }
    const unknown = await deleteQueuedMessage('session', 'message')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.status, 0)
    globalThis.fetch = async () => new Response('invalid response')
    assert.equal((await deleteQueuedMessage('session', 'message')).ok, false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('only successful skill preference mutations invalidate open catalogs', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: unknown[] = []
  const events: string[] = []
  let status = 200
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        deviceSkills: async (request: unknown) => {
          requests.push(request)
          return { status, body: '{}' }
        },
      },
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    },
  })
  try {
    assert.equal(await setSkillActive('literature-review', false), true)
    status = 503
    assert.equal(await setSkillActive('literature-review', true), false)
    assert.deepEqual(requests, [
      { operation: 'toggle', name: 'literature-review', enabled: false },
      { operation: 'toggle', name: 'literature-review', enabled: true },
    ])
    assert.deepEqual(events, [SKILL_CATALOG_CHANGED_EVENT])
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('all permission choices can be restored and persisted as the new-session default', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; body: string }> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      setTimeout,
      clearTimeout,
    },
  })
  try {
    globalThis.fetch = async (_input, init) => {
      requests.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      const requested = init?.body ? JSON.parse(String(init.body)).mode : 'ask'
      return new Response(
        JSON.stringify({ ok: true, mode: requested, modes: GLOBAL_PERMISSION_MODES })
      )
    }
    assert.deepEqual(GLOBAL_PERMISSION_MODES, ['ask', 'safe_auto', 'bypassPermissions'])
    assert.equal(DEFAULT_GLOBAL_PERMISSION_MODE, 'safe_auto')
    assert.equal((await getGlobalPermissionMode())?.mode, 'ask')
    assert.equal((await setGlobalPermissionMode('bypassPermissions'))?.mode, 'bypassPermissions')
    assert.deepEqual(requests, [
      { method: 'GET', body: '' },
      { method: 'POST', body: '{"mode":"bypassPermissions"}' },
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('locally generated skill failures carry stable classes and preserve HTTP status', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { deviceSkills: async () => ({ status: 503, body: '{}' }) },
    },
  })
  try {
    await assert.rejects(
      getSkillDocument('user-named-skill'),
      (error) =>
        error instanceof SkillDocumentError &&
        error.status === 503 &&
        error.message === 'skill_document_unavailable'
    )
    await assert.rejects(
      getSkills(),
      (error) =>
        error instanceof SkillCatalogError &&
        error.status === 503 &&
        error.message === 'skill_catalog_unavailable'
    )
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('diagnostic fallback is distinguishable from original server diagnostics', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503 })
    await assert.rejects(
      getDiagnosticPolicy('session'),
      (error) => error instanceof DiagnosticOperationError && error.status === 503
    )
    const original = '原始诊断: diagnostic_operation_failed'
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: original }), { status: 503 })
    await assert.rejects(
      getDiagnosticPolicy('session'),
      (error) =>
        error instanceof Error &&
        !(error instanceof DiagnosticOperationError) &&
        error.message === original
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('session resume accepts waiting HIL and submits complete answers without reconnecting', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const requests: Array<{ url: string; body: unknown }> = []
  const answers = { literature_type: 'Published only', search_scope: 'Adjust' }
  const pendingHil = [
    {
      request_id: 'request-hil',
      kind: 'user_input',
      turn_id: 'turn-waiting',
      item_id: 'item-hil',
      questions: Object.keys(answers).map((id) => ({
        id,
        header: id,
        question: id,
        options: [{ label: 'Default' }, { label: answers[id as keyof typeof answers] }],
      })),
    },
  ]
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      setTimeout,
      clearTimeout,
    },
  })
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return Response.json(
        url.endsWith('/open')
          ? {
              session_id: 'session-1',
              running: true,
              active_turn_id: 'turn-waiting',
              last_turn_id: 'turn-waiting',
              last_turn_status: 'waiting',
              unknown_outcome: false,
              uncertain_operations: [],
              pending_hil: pendingHil,
            }
          : { ok: true, request_id: 'request-hil' }
      )
    }
    const opened = await openSession({ resumeSessionId: 'session-1' })
    assert.ok(opened && !('error' in opened))
    assert.equal(opened.last_turn_status, 'waiting')
    assert.deepEqual(opened.pending_hil, pendingHil)
    const requestId = opened.pending_hil?.[0]?.request_id
    assert.equal(requestId, 'request-hil')
    assert.ok(requestId)
    assert.equal((await respondHil(opened.session_id, requestId, { answers })).ok, true)
    assert.deepEqual(requests, [
      { url: '/api/serve/sessions/open', body: { resume_session_id: 'session-1' } },
      { url: '/api/serve/sessions/session-1/hil/request-hil', body: { answers } },
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('invalid recovery stays rejected but can retry with a stable diagnostic code', () => {
  const invalid = parseOpenSessionResponse({})
  assert.ok('error' in invalid)
  assert.equal(invalid.code, 'invalid_session_recovery_snapshot')
  assert.equal(invalid.error, 'invalid_session_recovery_snapshot')
  assert.equal(classifySessionResumeFailure(invalid).terminal, false)
})

test('empty HIL and interruption errors leave presentation to the caller while preserving original diagnostics', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 })
    assert.equal((await interruptSession('session')).error, '')
    assert.equal((await respondHil('session', 'request', { option_id: 'yes' })).error, '')
    const original = 'Upstream 原始诊断'
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: { message: original } }), { status: 200 })
    assert.equal((await interruptSession('session')).error, original)
    assert.equal((await respondHil('session', 'request', { option_id: 'yes' })).error, original)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('model profile requests preserve auth events and raw HTTP diagnostics without localized state', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    },
  })
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    assert.deepEqual(await createSubscriptionProfile(), {
      ok: false,
      error: '',
      code: 'authentication_required',
      status: 401,
    })
    assert.deepEqual(events, ['scholarseed:auth-required'])
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: '原始拒绝原因' }), { status: 400 })
    assert.deepEqual(await createSubscriptionProfile(), {
      ok: false,
      error: '原始拒绝原因',
      code: 'http_failure',
      status: 400,
    })
    globalThis.fetch = async () => {
      throw new Error('network unavailable')
    }
    assert.deepEqual(await createSubscriptionProfile(), {
      ok: false,
      error: 'network unavailable',
      code: 'network_failure',
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

async function requestTranslations() {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { conversation: zh, components: componentsZh },
      en: { conversation: en, components: componentsEn },
    },
  })
  return locale
}

test('service HTTP fallbacks carry producer provenance and retain same-named raw diagnostics', async () => {
  const locale = await requestTranslations()
  const fallback = await serviceErrorDetail(new Response('', { status: 503 }))
  assert.equal(fallback.message, '503 request failed')
  assert.deepEqual(fallback.applicationFailure, {
    key: 'request.httpFailure',
    status: 503,
    statusText: '',
  })
  assert.ok(fallback.applicationFailure)
  const stored = requestFailureFeedback(fallback.applicationFailure)
  assert.equal(renderFeedback(locale, stored), '请求失败（503），请稍后重试。')
  await locale.changeLanguage('en')
  assert.equal(renderFeedback(locale, stored), 'Request failed (503). Please try again later.')
  assert.equal(fallback.message, '503 request failed')
  for (const response of [
    new Response('503 request failed', { status: 503 }),
    Response.json({ detail: '503 request failed', code: 'unknown_upstream' }, { status: 503 }),
    Response.json({ detail: { detail: '原诊断', code: 'request_timeout' } }, { status: 503 }),
  ]) {
    const original = await serviceErrorDetail(response)
    assert.equal(original.applicationFailure, undefined)
    assert.ok(original.message.includes('request'))
  }
  const status = await serviceErrorDetail(
    new Response('', { status: 503, statusText: 'RAW status reason' })
  )
  assert.equal(status.message, '503 RAW status reason')
  assert.ok(status.applicationFailure)
  assert.equal(
    renderFeedback(locale, requestFailureFeedback(status.applicationFailure)),
    'Request failed (503). Please try again later.'
  )
})

test('session open distinguishes local timeout and empty failures without reclassifying diagnostic strings', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    },
  })
  try {
    const locale = await requestTranslations()
    await locale.changeLanguage('en')
    for (const cause of [
      new Error(''),
      new Error('request failed'),
      new DOMException('upstream timeout detail', 'TimeoutError'),
    ]) {
      globalThis.fetch = async () => {
        throw cause
      }
      const opened = await openSession({ resumeSessionId: 'session' })
      assert.ok(opened && 'error' in opened)
      const resume = classifySessionResumeFailure(opened)
      assert.equal(resume.status, 0)
      assert.equal(resume.terminal, false)
      assert.equal(
        opened.error,
        cause instanceof DOMException ? 'request_timeout' : 'request failed'
      )
      if (cause instanceof DOMException) {
        assert.equal(resume.code, 'request_timeout')
        assert.deepEqual(resume.applicationFailure, {
          key: 'request.timeout',
          diagnostic: 'upstream timeout detail',
        })
        assert.equal(
          formatRuntimeStatus(
            { key: 'resume.stopped', reason: resume.applicationFailure },
            locale.getFixedT(null, 'conversation')
          ),
          `${en.resume.stopped}: Request timed out`
        )
      } else if (cause.message) assert.equal(resume.applicationFailure, undefined)
      else assert.deepEqual(resume.applicationFailure, { key: 'request.failed' })
    }
    globalThis.fetch = async () => new Response('', { status: 401 })
    const unauthorized = await openSession()
    assert.ok(unauthorized && 'error' in unauthorized)
    assert.equal(unauthorized.error, 'authentication required')
    assert.equal(classifySessionResumeFailure(unauthorized).terminal, true)
    assert.deepEqual(events, ['scholarseed:auth-required'])
    assert.deepEqual(unauthorized.applicationFailure, { key: 'request.authentication' })
    const empty = classifySessionResumeFailure({ status: 429, error: '', detail: '' })
    assert.equal(empty.message, 'request failed')
    assert.equal(empty.terminal, false)
    assert.deepEqual(empty.applicationFailure, { key: 'request.failed' })
    const upstream = classifySessionResumeFailure({
      status: 503,
      code: 'request_timeout',
      error: 'request_timeout',
      detail: 'request_timeout',
    })
    assert.equal(upstream.applicationFailure, undefined)
    assert.equal(upstream.message, 'request_timeout')
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('unknown-turn confirmation preserves decision requests, raw errors, and generated fallback provenance', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body })
      return Response.json({ ok: false, code: 'confirmation_pending' })
    }
    const local = await confirmUnknownTurn('session/id', 'turn/id')
    assert.equal(local.error, 'turn unknown confirmation failed')
    assert.equal(local.code, 'confirmation_pending')
    assert.deepEqual(local.applicationFailure, { key: 'retry.continueUnconfirmed' })
    assert.deepEqual(calls, [
      {
        url: '/api/serve/sessions/session%2Fid/turns/turn%2Fid/confirm-unknown',
        method: 'POST',
        body: '{"decision":"continue_without_replay"}',
      },
    ])
    globalThis.fetch = async () =>
      Response.json({ ok: false, error: 'turn unknown confirmation failed' })
    const raw = await confirmUnknownTurn('session', 'turn')
    assert.equal(raw.applicationFailure, undefined)
    assert.equal(raw.error, local.error)
    globalThis.fetch = async () => {
      throw new Error('原始确认错误')
    }
    assert.deepEqual(await confirmUnknownTurn('session', 'turn'), {
      ok: false,
      error: '原始确认错误',
    })
    globalThis.fetch = async () =>
      Response.json({ ok: true, turn_id: 'turn', resolution: 'continue_without_replay' })
    assert.deepEqual(await confirmUnknownTurn('session', 'turn'), {
      ok: true,
      turn_id: 'turn',
      resolution: 'continue_without_replay',
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('recovery inspection never sends a turn and rejects malformed clearance', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  try {
    globalThis.fetch = async (url, init) => {
      requests.push(`${init?.method} ${url}`)
      return Response.json({ ok: true, recovery_blocked: false, recovery_pending: false })
    }
    assert.deepEqual(await checkSessionRecovery('session/id'), {
      ok: true,
      recovery_blocked: false,
      recovery_pending: false,
    })
    assert.deepEqual(requests, ['POST /api/serve/sessions/session%2Fid/recovery/check'])
    for (const result of [
      { ok: false, recovery_blocked: true, recovery_pending: true, error: 'turn_recovery_blocked' },
      { ok: true, recovery_blocked: false, recovery_pending: true, activity_active: true },
    ]) {
      globalThis.fetch = async () => Response.json(result)
      assert.deepEqual(await checkSessionRecovery('session/id'), result)
    }
    globalThis.fetch = async () => Response.json({ ok: true, recovery_blocked: false })
    assert.deepEqual(await checkSessionRecovery('session/id'), {
      ok: false,
      recovery_blocked: true,
      recovery_pending: true,
      error: 'invalid_recovery_check',
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('failed turn continuation carries its origin without changing ordinary messages', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
    },
  })
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)))
      return Response.json({ ok: true, accepted: true, disposition: 'started' })
    }
    await postTurn('session', [{ type: 'text', text: '继续' }], 'default', {
      clientUserMessageId: 'retry',
      continueTurnId: 'failed-turn',
    })
    await postTurn('session', [{ type: 'text', text: 'ordinary' }], 'default', {
      clientUserMessageId: 'ordinary',
    })
    assert.equal(requests[0].continue_turn_id, 'failed-turn')
    assert.equal('continue_turn_id' in requests[1], false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('HTTP fallback provenance survives every service-error adapter without changing requests or failure events', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: Array<CustomEvent> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      dispatchEvent: (event: CustomEvent) => {
        events.push(event)
        return true
      },
    },
  })
  try {
    globalThis.fetch = async () => new Response('', { status: 503 })
    const submitted = await postTurn('session', [{ type: 'text', text: '用户消息' }])
    assert.ok(submitted)
    const results = [
      submitted,
      await postSide('session', 'queued'),
      await sendQueuedMessage('session', 'queued'),
      await interruptSession('session'),
      await respondHil('session', 'hil', { option_id: 'deny' }),
      await setSessionModel('session', 'model'),
      await setMode('session', 'ask'),
      await confirmUnknownTurn('session', 'turn'),
      await openSession(),
    ]
    for (const result of results) {
      assert.ok(result && 'applicationFailure' in result)
      assert.deepEqual(result.applicationFailure, {
        key: 'request.httpFailure',
        status: 503,
        statusText: '',
      })
      assert.equal('ok' in result ? result.ok : undefined, 'status' in result ? undefined : false)
    }
    assert.equal(events.length, 1)
    assert.ok(
      events.every(
        (event) => event.detail.message === '503 request failed' && event.detail.code === undefined
      )
    )
    const locale = await requestTranslations()
    await locale.changeLanguage('en')
    assert.equal(
      renderFeedback(locale, turnAdmissionFeedback(submitted)),
      'Request failed (503). Please try again later.'
    )
    assert.equal(
      describeTurnAdmissionFailure(locale.getFixedT(null, 'components'), submitted),
      'Request failed (503). Please try again later.'
    )
    const mode = await setMode('session', 'ask')
    assert.equal(mode.error, undefined)
    assert.equal(mode.detail, '503 request failed')
    assert.equal(
      renderFeedback(locale, permissionModeFeedback(mode)),
      'Request failed (503). Please try again later.'
    )
    const diagnostic = requestFailureFeedback({
      key: 'request.timeout',
      diagnostic: '<raw>&{{message}}',
    })
    assert.equal(renderFeedback(locale, diagnostic), 'Request timed out')
    assert.equal(
      formatApplicationRequestFailure(
        { key: 'request.timeout', diagnostic: '<raw>&{{message}}' },
        locale.getFixedT(null, 'conversation')
      ),
      renderFeedback(locale, diagnostic)
    )
    const selected = permissionModeSelectedFeedback('safe_auto')
    assert.equal(
      renderFeedback(locale, selected),
      'Selected “Approve for me”. Applies to the next turn.'
    )
    await locale.changeLanguage('zh')
    assert.equal(
      renderFeedback(locale, selected),
      componentsZh.composer.modeSelected.replace('{{mode}}', componentsZh.composer.autoPermission)
    )
    assert.equal(
      renderFeedback(locale, permissionModeSelectedFeedback('vendor_raw_mode')),
      componentsZh.composer.modeSelected.replace('{{mode}}', 'vendor_raw_mode')
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('handled queue conflicts do not publish raw backend failures', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: CustomEvent[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      dispatchEvent: (event: CustomEvent) => {
        events.push(event)
        return true
      },
    },
  })
  try {
    globalThis.fetch = async () =>
      Response.json({ error: 'turn_outcome_unconfirmed' }, { status: 409 })
    assert.deepEqual(await sendQueuedMessage('session', 'queued'), {
      ok: false,
      error: 'turn_outcome_unconfirmed',
    })
    assert.equal(events.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('turn submission marks HTTP admission failures as rejected and transport failures as unknown', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const events: Array<CustomEvent> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: { getApiBase: () => '' },
      dispatchEvent: (event: CustomEvent) => {
        events.push(event)
        return true
      },
    },
  })
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          detail: 'resource review required',
          code: 'resource_review_required',
        },
        { status: 409 }
      )
    assert.deepEqual(await postTurn('session', [{ type: 'text', text: '重试' }]), {
      ok: false,
      error: 'resource_review_required',
      code: 'resource_review_required',
      submissionOutcome: 'rejected',
      issues: undefined,
    })
    assert.equal(events.at(-1)?.detail.code, 'resource_review_required')
    const locale = await requestTranslations()
    assert.equal(
      renderFeedback(locale, turnAdmissionFeedback(events.at(-1)?.detail)),
      zh.request.resourceReviewRequired
    )
    await locale.changeLanguage('en')
    assert.equal(
      renderFeedback(locale, turnAdmissionFeedback(events.at(-1)?.detail)),
      en.request.resourceReviewRequired
    )

    globalThis.fetch = async () => {
      throw new Error('connection lost')
    }
    assert.deepEqual(await postTurn('session', [{ type: 'text', text: '重试' }]), {
      ok: false,
      error: 'connection lost',
      submissionOutcome: 'unknown',
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('history-load recovery explanations redraw without translating raw server diagnostics', async () => {
  const locale = await requestTranslations()
  const stored = requestFailureFeedback({ key: 'request.historyUnavailable' })
  assert.equal(renderFeedback(locale, stored), '历史记录未能加载')
  await locale.changeLanguage('en')
  assert.equal(renderFeedback(locale, stored), 'The task history could not be loaded.')
  assert.equal(renderFeedback(locale, '历史记录未能加载'), '历史记录未能加载')
})

test('session catalog failures retain safe route and phase evidence without changing recovery decisions', async (context) => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalInfo = console.info
  const records: string[] = []
  const secret = 'private-path-token-and-response'
  let bridgeFailure = false
  flushApiDiagnostics()
  console.info = (...values: unknown[]) => records.push(values.join(' '))
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        syncAuthorizedRoots: () => {
          if (bridgeFailure) throw new Error(secret)
          return Promise.resolve(true)
        },
      },
    },
  })
  context.after(() => {
    flushApiDiagnostics()
    globalThis.fetch = originalFetch
    console.info = originalInfo
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const cases = [
    {
      response: () => new Response(secret, { status: 503 }),
      kind: 'http',
      retryable: true,
      status: 503,
      reason: 'http-error',
    },
    {
      response: () => {
        throw new TypeError(secret)
      },
      kind: 'transport',
      retryable: true,
      status: null,
      reason: 'network-error',
    },
    {
      response: () => new Response(secret),
      kind: 'schema',
      retryable: false,
      status: 200,
      reason: 'invalid-json',
    },
    {
      response: () => {
        const response = Response.json({ sessions: [] })
        response.json = async () => {
          throw new TypeError(secret)
        }
        return response
      },
      kind: 'schema',
      retryable: false,
      status: 200,
      reason: 'response-read-error',
    },
    {
      response: () => Response.json({ detail: secret }),
      kind: 'schema',
      retryable: false,
      status: 200,
      reason: 'invalid-schema',
    },
    {
      response: () => Response.json({ sessions: [] }),
      kind: 'transport',
      retryable: true,
      status: 200,
      reason: 'client-projection-error',
      bridge: true,
    },
  ]
  for (const scenario of cases) {
    flushApiDiagnostics()
    records.length = 0
    bridgeFailure = scenario.bridge ?? false
    globalThis.fetch = async () => scenario.response()
    const result = await loadSessionCatalog({
      scope: 'project',
      projectPath: secret,
      query: secret,
    })
    assert.deepEqual(result, {
      ok: false,
      failure: {
        kind: scenario.kind,
        retryable: scenario.retryable,
        ...(scenario.kind === 'http' ? { status: scenario.status } : {}),
      },
    })
    assert.equal(records.length, 1, scenario.reason)
    assert.deepEqual(
      { ...JSON.parse(records[0].replace('[api-request] ', '')), elapsedMs: 0 },
      {
        route: '/api/serve/sessions',
        method: 'GET',
        status: scenario.status,
        reason: scenario.reason,
        elapsedMs: 0,
        suppressedCount: 0,
      }
    )
    assert.ok(!records.join('').includes(secret))
  }
  flushApiDiagnostics()
  records.length = 0
  bridgeFailure = false
  globalThis.fetch = async () => Response.json({ sessions: [] })
  assert.equal((await loadSessionCatalog()).ok, true)
  assert.equal(records.length, 0)
})
