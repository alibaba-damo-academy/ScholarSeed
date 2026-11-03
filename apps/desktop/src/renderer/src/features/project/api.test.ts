import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listExternalRoots,
  revokeRoot,
  selectExternalRootProject,
  listProjects,
  loadWorkspaceRoot,
} from './api.ts'

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
