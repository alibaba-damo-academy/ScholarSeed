import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BackgroundNavigation,
  loadTraySnapshot,
  navigateTray,
  navigateAttention,
} from './background.ts'
import type { Project, ServeSession } from '../api'

const project: Project = { id: 'project', name: '研究', path: '/research' }
const projects = async () => ({ default: '/workspace', projects: [project] })
const title = (session: { title: string }): string => session.title
const row = (id: string, activity: number, path = project.path): ServeSession =>
  ({
    session_id: id,
    title: id,
    mtime: activity,
    project_path: path,
  }) as ServeSession
const session = async () => ({
  session_id: 'task',
  title: '研究任务',
  title_fallback: null,
  runtime_workdir: '/research/session',
  project_path: project.path,
  runtime_id: 'codex',
  running: false,
})

function navigation() {
  const calls: unknown[] = []
  return {
    calls,
    actions: {
      selectProject: (id: string) => {
        calls.push(['project', id])
      },
      openWorkbenchView: (view: string) => {
        calls.push(['view', view])
      },
      openPanelSession: (node: { id: string; projectPath?: string | null }) => {
        calls.push(['session', node.id, node.projectPath])
      },
      startPanelDraft: (seed?: { projectId?: string | null }) => {
        calls.push(['draft', seed?.projectId])
      },
      openSettings: (page: unknown) => {
        calls.push(['settings', page])
      },
    },
    publish: (listing: Project[]) => {
      calls.push(['projects', listing.length])
    },
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const attention = async () => ({
  ...(await session()),
  focus: { kind: 'completed' as const, request_id: null, turn_id: 'turn', item_id: 'result' },
})

test('a newer tray action retires an in-flight notification without navigation or settings changes', async () => {
  const requests = new BackgroundNavigation()
  const pending = deferred<Awaited<ReturnType<typeof attention>>>()
  const { actions, calls, publish } = navigation()
  const first = navigateAttention(
    'notice',
    { projects, attention: () => pending.promise },
    actions,
    () => ({ projects: [project], sessions: [] }),
    publish,
    requests.begin()
  )
  assert.equal(
    await navigateTray(
      { kind: 'literature' },
      { projects, session },
      actions,
      publish,
      requests.begin()
    ),
    true
  )
  pending.resolve(await attention())
  assert.equal(await first, false)
  assert.deepEqual(calls, [['view', 'literature']])
})

test('a newer notification retires a tray session lookup and preserves the notification focus', async () => {
  const requests = new BackgroundNavigation()
  const pending = deferred<Awaited<ReturnType<typeof session>>>()
  const entered = deferred<void>()
  const { actions, calls, publish } = navigation()
  const first = navigateTray(
    { kind: 'session', projectId: project.id, sessionId: 'old' },
    {
      projects,
      session: () => {
        entered.resolve()
        return pending.promise
      },
    },
    actions,
    publish,
    requests.begin()
  )
  await entered.promise
  let focus: unknown
  const opened = await navigateAttention(
    'notice',
    { projects, attention },
    {
      ...actions,
      openPanelSession: (node, target) => {
        focus = target
        actions.openPanelSession(node)
      },
    },
    () => ({ projects: [project], sessions: [] }),
    publish,
    requests.begin()
  )
  assert.equal(opened, true)
  const latestCalls = [...calls]
  pending.resolve(await session())
  assert.equal(await first, false)
  assert.deepEqual(calls, latestCalls)
  assert.deepEqual(focus, {
    kind: 'completed',
    requestId: null,
    turnId: 'turn',
    itemId: 'result',
    incidentId: undefined,
  })
})

test('late notification project refresh cannot publish or replace a newer draft', async () => {
  const requests = new BackgroundNavigation()
  const pending = deferred<Awaited<ReturnType<typeof projects>>>()
  const entered = deferred<void>()
  const { actions, calls, publish } = navigation()
  const first = navigateAttention(
    'notice',
    {
      attention,
      projects: () => {
        entered.resolve()
        return pending.promise
      },
    },
    actions,
    () => ({ projects: [], sessions: [] }),
    publish,
    requests.begin()
  )
  await entered.promise
  await navigateTray(
    { kind: 'create', projectId: project.id },
    { projects, session },
    actions,
    publish,
    requests.begin()
  )
  const latestCalls = [...calls]
  pending.resolve(await projects())
  assert.equal(await first, false)
  assert.deepEqual(calls, latestCalls)
})

test('lifecycle invalidation retires a notification awaiting its destination', async () => {
  const requests = new BackgroundNavigation()
  const pending = deferred<Awaited<ReturnType<typeof attention>>>()
  const { actions, calls, publish } = navigation()
  const first = navigateAttention(
    'notice',
    { projects, attention: () => pending.promise },
    actions,
    () => ({ projects: [project], sessions: [] }),
    publish,
    requests.begin()
  )
  requests.invalidate()
  pending.resolve(await attention())
  assert.equal(await first, false)
  assert.deepEqual(calls, [])
})

test('menu reads its remembered project and three latest conversations, not other scopes', async () => {
  let options: unknown
  const result = await loadTraySnapshot(
    project.id,
    {
      projects,
      sessions: async (query) => {
        options = query
        return [
          row('old', 1),
          row('new', 50),
          row('middle', 30),
          row('second', 40),
          row('other', 100, '/other'),
        ]
      },
    },
    title
  )
  assert.deepEqual(options, { scope: 'project', projectPath: project.path, limit: 3 })
  assert.deepEqual(result, {
    project: { id: project.id, name: project.name },
    sessions: [
      { id: 'new', title: 'new' },
      { id: 'second', title: 'second' },
      { id: 'middle', title: 'middle' },
    ],
  })
})

test('no project never chooses an unrelated project, and read errors are not empty lists', async () => {
  const sessions = async () => {
    throw new Error('unexpected session read')
  }
  assert.deepEqual(await loadTraySnapshot(null, { projects, sessions }, title), {
    project: null,
    sessions: [],
  })
  assert.deepEqual(await loadTraySnapshot('removed', { projects, sessions }, title), {
    project: null,
    sessions: [],
  })
  assert.equal(
    await loadTraySnapshot(project.id, { projects: async () => null, sessions }, title),
    null
  )
  assert.equal(
    await loadTraySnapshot(project.id, { projects, sessions: async () => null }, title),
    null
  )
  assert.deepEqual(
    await loadTraySnapshot(project.id, { projects, sessions: async () => [] }, title),
    {
      project: { id: project.id, name: project.name },
      sessions: [],
    }
  )
})

test('each refresh reads renamed project and conversation titles from source', async () => {
  let name = '旧项目'
  let task = '旧任务'
  const readers = {
    projects: async () => ({ default: '', projects: [{ ...project, name }] }),
    sessions: async () => [{ ...row('task', 1), title: task }],
  }
  assert.equal((await loadTraySnapshot(project.id, readers, title))?.sessions[0].title, task)
  name = '新项目'
  task = '新任务'
  const refreshed = await loadTraySnapshot(project.id, readers, title)
  assert.equal(refreshed?.project?.name, name)
  assert.equal(refreshed?.sessions[0].title, task)
})

test('new conversation switches project then opens its draft, without executing a turn', async () => {
  const { actions, calls, publish } = navigation()
  assert.equal(
    await navigateTray(
      { kind: 'create', projectId: project.id },
      { projects, session },
      actions,
      publish,
      () => true
    ),
    true
  )
  assert.deepEqual(calls, [
    ['projects', 1],
    ['project', project.id],
    ['view', 'resource'],
    ['draft', project.id],
  ])
})

test('conversation navigation restores authoritative metadata before opening the project', async () => {
  const { actions, calls, publish } = navigation()
  assert.equal(
    await navigateTray(
      { kind: 'session', projectId: project.id, sessionId: 'task' },
      { projects, session },
      actions,
      publish,
      () => true
    ),
    true
  )
  assert.deepEqual(calls, [
    ['projects', 1],
    ['project', project.id],
    ['view', 'resource'],
    ['session', 'task', project.path],
  ])
})

test('removed, archived, unavailable and mismatched targets never navigate', async () => {
  for (const candidate of [
    null,
    { ...project, archived_at: 1 },
    { ...project, available: false },
  ]) {
    const { actions, calls, publish } = navigation()
    assert.equal(
      await navigateTray(
        { kind: 'project', projectId: project.id },
        {
          projects: async () => ({ default: '', projects: candidate ? [candidate] : [] }),
          session,
        },
        actions,
        publish,
        () => true
      ),
      false
    )
    assert.deepEqual(calls, [])
  }
  const { actions, calls, publish } = navigation()
  assert.equal(
    await navigateTray(
      { kind: 'session', projectId: project.id, sessionId: 'task' },
      {
        projects,
        session: async () => ({ ...(await session()), project_path: '/other' }),
      },
      actions,
      publish,
      () => true
    ),
    false
  )
  assert.deepEqual(calls, [])
})

test('late navigation cannot overwrite a newer action or unmounted renderer', async () => {
  let current = true
  const { actions, calls, publish } = navigation()
  assert.equal(
    await navigateTray(
      { kind: 'project', projectId: project.id },
      {
        projects: async () => {
          current = false
          return projects()
        },
        session,
      },
      actions,
      publish,
      () => current
    ),
    false
  )
  assert.deepEqual(calls, [])
})

test('literature overview uses the existing global navigation without a project lookup', async () => {
  const { actions, calls, publish } = navigation()
  assert.equal(
    await navigateTray(
      { kind: 'literature' },
      {
        projects: async () => {
          throw new Error('unexpected lookup')
        },
        session,
      },
      actions,
      publish,
      () => true
    ),
    true
  )
  assert.deepEqual(calls, [['view', 'literature']])
})
