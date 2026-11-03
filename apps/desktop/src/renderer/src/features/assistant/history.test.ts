import assert from 'node:assert/strict'
import test from 'node:test'
import { listTaskHistory } from './history.ts'

for (const scope of ['project', 'unassigned'] as const) {
  test(`${scope} history orders every page by Agent reply, not creation, activity or pin`, async () => {
    const previousFetch = globalThis.fetch
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const queries: URLSearchParams[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { scholarseed: { getApiBase: () => '', syncAuthorizedRoots: async () => {} } },
    })
    try {
      globalThis.fetch = async (url) => {
        const query = new URL(String(url), 'http://localhost').searchParams
        queries.push(query)
        return Response.json(
          query.has('cursor')
            ? {
                sessions: [
                  {
                    session_id: 'older-task-new-reply',
                    created_at: 1,
                    mtime: 40,
                    last_agent_reply_at: 40,
                  },
                  { session_id: 'same-time', created_at: 9, mtime: 20, last_agent_reply_at: 20 },
                ],
              }
            : {
                sessions: [
                  {
                    session_id: 'unanswered',
                    created_at: 100,
                    mtime: 100,
                    last_agent_reply_at: null,
                  },
                  {
                    session_id: 'pinned-user-activity',
                    pinned: true,
                    created_at: 50,
                    mtime: 90,
                    last_agent_reply_at: 20,
                  },
                  { session_id: 'missing-reply', created_at: 80, mtime: 80 },
                ],
                next_cursor: 'older-page',
              }
        )
      }
      const rows = await listTaskHistory(
        { scope, projectPath: '/test-project', query: 'test', limit: 30 },
        () => true
      )
      assert.deepEqual(
        rows?.map((row) => row.session_id),
        ['older-task-new-reply', 'same-time', 'pinned-user-activity', 'unanswered', 'missing-reply']
      )
      assert.equal(rows?.[0].last_agent_reply_at, 40)
      assert.equal(rows?.[3].last_agent_reply_at, null)
      assert.equal(rows?.[4].last_agent_reply_at, undefined)
      assert.equal(queries.length, 2)
      for (const query of queries) {
        assert.equal(query.get('include_last_agent_reply'), 'true')
        assert.equal(query.get('scope'), scope)
        assert.equal(query.get('query'), 'test')
        assert.equal(query.get('project_path'), scope === 'project' ? '/test-project' : null)
      }
      assert.equal(queries[1].get('cursor'), 'older-page')
      assert.equal(await listTaskHistory({ scope }, () => false), null)
      globalThis.fetch = async () => new Response('', { status: 503 })
      assert.equal(await listTaskHistory({ scope }, () => true), null)
    } finally {
      globalThis.fetch = previousFetch
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}
