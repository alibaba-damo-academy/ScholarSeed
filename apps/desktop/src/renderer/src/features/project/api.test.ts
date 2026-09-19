import assert from 'node:assert/strict'
import test from 'node:test'

import { listExternalRoots } from './api.ts'

const payload = (projectId: string, sourcePath: string) => ({
  roots: [{
    root_id: `root-${projectId}`,
    project_id: projectId,
    mount_path: 'resources/source.txt',
    source_path: sourcePath,
    kind: 'file',
    authorized_at: 1,
    available: true
  }],
  writableRoots: [`/projects/${projectId}`, sourcePath]
})

test('external root listing waits until Electron has replaced its authorization snapshot', async () => {
  let finishSync: ((value: boolean) => void) | undefined
  const synchronized = new Promise<boolean>((resolve) => { finishSync = resolve })
  const calls: Array<{ scope: string; roots: string[] }> = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (scope: string, roots: string[]) => {
          calls.push({ scope, roots })
          return synchronized
        }
      }
    },
    fetch: async () => Response.json(payload('project-1', '/external/source.txt'))
  })

  let settled = false
  const listing = listExternalRoots('project-1').then((result) => {
    settled = true
    return result
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)
  assert.deepEqual(calls, [{
    scope: 'external',
    roots: ['/projects/project-1', '/external/source.txt']
  }])

  finishSync?.(true)
  assert.deepEqual(await listing, {
    roots: [{
      rootId: 'root-project-1',
      projectId: 'project-1',
      mountPath: 'resources/source.txt',
      sourcePath: '/external/source.txt',
      kind: 'file',
      authorizedAt: 1,
      available: true
    }],
    writableRoots: ['/projects/project-1', '/external/source.txt']
  })
})

test('a stale project response cannot replace the newer project authorization snapshot', async () => {
  let finishFirst: ((response: Response) => void) | undefined
  const firstResponse = new Promise<Response>((resolve) => { finishFirst = resolve })
  const synchronized: string[][] = []
  Object.assign(globalThis, {
    window: {
      scholarseed: {
        getApiBase: () => 'http://serve.test',
        syncAuthorizedRoots: async (_scope: string, roots: string[]) => {
          synchronized.push(roots)
          return true
        }
      }
    },
    fetch: async (input: string) => input.includes('project-a')
      ? firstResponse
      : Response.json(payload('project-b', '/external/b.txt'))
  })

  const stale = listExternalRoots('project-a')
  const current = listExternalRoots('project-b')
  assert.equal((await current)?.roots[0]?.projectId, 'project-b')
  finishFirst?.(Response.json(payload('project-a', '/external/a.txt')))
  assert.equal(await stale, null)
  assert.deepEqual(synchronized, [['/projects/project-b', '/external/b.txt']])
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
        }
      }
    },
    fetch: async () => {
      fetches += 1
      return Response.json(payload('project-shared', '/external/shared.txt'))
    }
  })

  const first = listExternalRoots('project-shared')
  const second = listExternalRoots('project-shared')
  assert.equal(first, second)
  assert.equal((await first)?.roots[0]?.projectId, 'project-shared')
  assert.equal((await second)?.roots[0]?.projectId, 'project-shared')
  assert.equal(fetches, 1)
  assert.deepEqual(synchronized, [['/projects/project-shared', '/external/shared.txt']])
})
