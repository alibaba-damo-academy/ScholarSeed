import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createPreviewService } from './service.ts'
import { PREVIEW_HOME } from './home.ts'
import { recentTasks } from '../src/renderer/src/features/home/catalog.ts'

const OBSERVATION_TIMEOUT_MS = 10_000
const POLL_MS = 10

test('Mock task dates stay stable on reads and drive real project-center sorting', { timeout: OBSERVATION_TIMEOUT_MS }, async context => {
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
  const origin = 'http://127.0.0.1:' + address.port
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path + (path.includes('?') ? '&' : '?') + 'previewInstance=temporal-proof', {
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, path + ': ' + response.status)
    return response.json()
  }
  const initial = await call('/__preview/reset', { pageId: 'page-home', scene: 'home-states' })
  const seeded = initial.sessions[0]
  assert.equal(seeded.created_at, PREVIEW_HOME.seedTime)
  assert.equal(seeded.last_agent_reply_at, null)
  assert.equal(seeded.mtime, seeded.created_at)
  const dates = (sessions: { session_id: string; created_at: number; last_agent_reply_at: number | null; mtime: number }[]) => sessions.map(session => ({ id: session.session_id, created: session.created_at, replied: session.last_agent_reply_at, modified: session.mtime }))
  const listed = await call('/api/serve/sessions?scope=all')
  const repeated = await call('/api/serve/sessions?scope=all')
  assert.deepEqual(dates(listed.sessions), dates(initial.sessions))
  assert.deepEqual(dates(repeated.sessions), dates(initial.sessions))
  const opened = await call('/api/serve/sessions/open', { project_path: initial.projects[0].root })
  const beforeReply = await call('/api/serve/sessions?scope=all')
  const projects = initial.projects.map((project: { id: string; name: string; root: string }) => ({ id: project.id, name: project.name, path: project.root }))
  const newest = beforeReply.sessions.find((session: { session_id: string }) => session.session_id === opened.session_id)
  assert.ok(newest.created_at > seeded.created_at)
  assert.equal(newest.last_agent_reply_at, null)
  assert.equal(recentTasks(projects, beforeReply.sessions, '')[0].session_id, newest.session_id)
  await call('/api/serve/sessions/' + seeded.session_id + '/turns', { input: [{ type: 'text', text: 'Mock temporal ordering proof' }] })
  const deadline = performance.now() + OBSERVATION_TIMEOUT_MS
  let afterReply
  do {
    afterReply = await call('/api/serve/sessions?scope=all')
    const current = afterReply.sessions.find((session: { session_id: string }) => session.session_id === seeded.session_id)
    if (current.last_turn_status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  } while (performance.now() < deadline)
  const replied = afterReply.sessions.find((session: { session_id: string }) => session.session_id === seeded.session_id)
  assert.equal(replied.last_turn_status, 'completed')
  assert.equal(replied.created_at, seeded.created_at)
  assert.ok(replied.last_agent_reply_at > seeded.created_at)
  assert.ok(replied.mtime >= replied.last_agent_reply_at)
  assert.equal(recentTasks(projects, afterReply.sessions, '')[0].session_id, seeded.session_id)
  assert.deepEqual(dates((await call('/api/serve/sessions?scope=all')).sessions), dates(afterReply.sessions))
  const restored = await call('/__preview/reset', { pageId: 'page-home', scene: 'home-states' })
  assert.deepEqual(dates(restored.sessions), dates(initial.sessions))
})
