import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeNavigationLocation } from '../../navigation.ts'
import { HOME_LOCATION } from '../../navigation.ts'
import {
  captureNavigationLocation,
  openResourceTarget,
  openSessionTarget,
  resolveNavigationLocation,
  restoredWorkbenchTab,
  SettingsSurface,
  observeNavigation,
  navigationDiagnostic,
  navigationAttempt,
  NavigationCommit,
} from './navigation.ts'
import { DocumentWorkspace, documentNavigationView } from './features/workbench/workspace.ts'
import { documentIdFor } from './features/workbench/api.ts'
import { projectLibraryNavigation } from './features/workbench/tabs.ts'

test('project files navigation restores only the matching project tab', () => {
  const selected = projectLibraryNavigation([], 'project-a')
  assert.equal(restoredWorkbenchTab(selected.activeTab, [], 'project-a')?.kind, 'library')
  assert.equal(restoredWorkbenchTab(selected.activeTab, [], 'project-a')?.projectId, 'project-a')
  assert.equal(restoredWorkbenchTab(selected.activeTab, [], 'project-b'), null)
})

const PROJECTS = [
  { id: 'project-a', path: '/project/a' },
  { id: 'project-b', path: '/project/b' },
]
const SAVED = sanitizeNavigationLocation({
  view: 'resource',
  projectId: 'project-a',
  sessionId: 'session-a',
  sessionProjectId: 'project-a',
  aiPanelOpen: true,
})!
const SESSION = {
  id: 'session-a',
  title: 'Session A',
  status: 'done' as const,
  projectPath: '/project/a',
  openable: true,
  container: false,
}

test('literature reading in project files captures and restores its surface and exact attachment', async () => {
  const source = {
    kind: 'literature' as const,
    literatureId: 'paper',
    attachmentId: 'supplement',
    path: 'supplement.pdf',
    recordTarget: {
      owner: 'literature_attachment' as const,
      scope_id: 'paper',
      subject_id: 'supplement',
    },
  }
  const loader = {
    async load() {
      return {
        source,
        documentId: documentIdFor(source),
        viewer: 'pdf' as const,
        processor: null,
        bytes: new Uint8Array(),
        revision: 'revision',
        mediaType: 'application/pdf',
        capabilities: {
          can_preview: true,
          can_edit: false,
          can_select: true,
          can_save: false,
          can_annotate: false,
          can_version: false,
          can_diff: false,
          pending: [],
        },
      }
    },
    async commit(): Promise<never> {
      throw new Error('unused')
    },
  }
  const workspace = new DocumentWorkspace(loader)
  const id = await workspace.open(source, 'edit')
  workspace.setTabNavigationView(id, 'resource')
  const captured = captureNavigationLocation(
    {
      mainView: 'resource',
      activeTab: id,
      tabs: [],
      activeSession: null,
      accountSettingsPage: null,
      browserSettingsSection: null,
      aiPanel: { open: true, cover: false },
    } as unknown as Parameters<typeof captureNavigationLocation>[0],
    'project-a',
    workspace.getSnapshot()
  )
  const restored = resolveNavigationLocation(
    sanitizeNavigationLocation(JSON.parse(JSON.stringify(captured)))!,
    PROJECTS,
    () => undefined
  )
  const navigationView = restored.view === 'literature' ? 'literature' : 'resource'
  assert.equal(restored.view, 'resource')
  assert.equal(restored.projectId, 'project-a')
  assert.equal(restored.target?.kind, 'document')
  if (restored.target?.kind !== 'document') throw new Error('missing document')
  assert.deepEqual(restored.target.source, source)
  const reopened = new DocumentWorkspace(loader)
  const reopenedId = await reopened.open(restored.target.source, restored.target.viewKind)
  reopened.setTabNavigationView(reopenedId, navigationView)
  const snapshot = reopened.getSnapshot()
  assert.equal(snapshot.focusedTabId, reopenedId)
  assert.equal(
    documentNavigationView(
      snapshot.tabs[reopenedId],
      snapshot.sessions[snapshot.tabs[reopenedId].sessionId]
    ),
    'resource'
  )
})

test('navigation observation is pure, bounded to one current tag, and strips private state and causes', () => {
  const current = {
    mainView: 'resource',
    activeTab: 'private-path',
    homeSelectedProjectId: 'private-project',
    accountSettingsPage: null as string | null,
    browserSettingsSection: null,
    navigationRestored: true,
    tabs: [{ id: 'private-path', kind: 'explorer', title: 'private-title' }],
  }
  assert.equal(observeNavigation(current, current), current)
  const next = {
    ...current,
    mainView: 'literature',
    activeTab: 'secret-id',
    tabs: [{ id: 'secret-id', kind: 'literature', title: 'secret-title' }],
  }
  const cause = { action: 'restore' as const, request: 1, startedGeneration: 0 }
  const first = observeNavigation(current, next, cause)
  const replay = observeNavigation(current, next, cause)
  assert.deepEqual(first, replay)
  assert.equal(current.mainView, 'resource')
  assert.equal(first.navigationObservation?.generation, 1)
  const serialized = navigationDiagnostic(first.navigationObservation!, 'committed')
  for (const privateText of [
    'private-path',
    'private-project',
    'private-title',
    'secret-id',
    'secret-title',
  ])
    assert.ok(!serialized.includes(privateText))
  assert.match(serialized, /"before":\{"view":"resource","tabKind":"explorer"\}/)
  assert.match(serialized, /"after":\{"view":"literature","tabKind":"literature"\}/)
  const injected = observeNavigation(first, current, {
    ...cause,
    action: 'secret-action',
    body: 'private-body',
  } as unknown as typeof cause)
  assert.match(
    navigationDiagnostic(injected.navigationObservation!, 'committed'),
    /"action":"unattributed"/
  )
  assert.ok(
    !navigationDiagnostic(injected.navigationObservation!, 'committed').includes('private-body')
  )
  assert.equal('previous' in injected.navigationObservation!, false)
  const commit = new NavigationCommit()
  assert.equal(commit.record(undefined), null)
  assert.ok(commit.record(first.navigationObservation))
  assert.equal(commit.record(replay.navigationObservation), null)
  assert.ok(commit.record(injected.navigationObservation))
  assert.equal(commit.record(first.navigationObservation), null)
  const attempt = navigationAttempt(injected, {
    action: 'review',
    request: 9,
    startedGeneration: 0,
  })
  const fence = JSON.parse(navigationDiagnostic(attempt, 'fence-rejected'))
  assert.equal(fence.generation, 2)
  assert.equal(fence.startedGeneration, 0)
  assert.equal(fence.request, 9)
  assert.equal(fence.stage, 'fence-rejected')
  const batched = new NavigationCommit(navigationAttempt(current, { action: 'unattributed' }))
  const committed = JSON.parse(batched.record(injected.navigationObservation)!)
  assert.equal(committed.before.view, 'resource')
  assert.equal(committed.after.view, 'resource')
  assert.equal(committed.evaluatedUpdates, 2)
  assert.equal(batched.record(injected.navigationObservation), null)
  const plainNext = { ...first }
  delete plainNext.navigationObservation
  const retained = observeNavigation(first, plainNext)
  assert.equal(retained.navigationObservation, first.navigationObservation)
  assert.equal(observeNavigation(retained, current).navigationObservation?.sequence, 2)
  const flags = JSON.parse(serialized)
  assert.equal(flags.projectChanged, false)
  assert.equal(flags.focusChanged, true)
  assert.equal(flags.settingsChanged, false)
  const changed = observeNavigation(first, {
    ...first,
    homeSelectedProjectId: 'other-private-project',
    accountSettingsPage: 'models',
  })
  const changedFlags = JSON.parse(navigationDiagnostic(changed.navigationObservation!, 'committed'))
  assert.equal(changedFlags.projectChanged, true)
  assert.equal(changedFlags.settingsChanged, true)
  assert.ok(!JSON.stringify(changedFlags).includes('other-private-project'))
  const action = observeNavigation(current, next, { action: 'workbench' })
  assert.equal(
    JSON.parse(navigationDiagnostic(action.navigationObservation!, 'committed')).source,
    'action'
  )
})

test('session target switches project and document surface before opening the conversation', () => {
  const events: string[] = []
  const actions = {
    selectProject: (projectId: string | null) => events.push(`project:${projectId}`),
    openWorkbenchView: (view: string) => events.push(`view:${view}`),
    openPanelSession: (session: { id: string }) => events.push(`session:${session.id}`),
  }
  assert.equal(openSessionTarget(actions, SESSION, PROJECTS), true)
  assert.deepEqual(events, ['project:project-a', 'view:resource', 'session:session-a'])
  events.length = 0
  openSessionTarget(actions, { ...SESSION, projectPath: null }, PROJECTS)
  assert.deepEqual(events, ['view:literature', 'session:session-a'])
  events.length = 0
  assert.equal(openSessionTarget(actions, { ...SESSION, projectPath: '/removed' }, PROJECTS), false)
  assert.deepEqual(events, [])
  events.length = 0
  openSessionTarget(actions, { ...SESSION, container: true }, PROJECTS)
  openSessionTarget(actions, { ...SESSION, openable: false }, PROJECTS)
  assert.deepEqual(events, [])
})

test('settings surface retires synchronously on accepted batched intents, not duplicate intents', () => {
  const surface = new SettingsSurface(true)
  surface.project({ accountSettingsPage: 'browser', browserSettingsSection: 'history' })
  const first = surface.capture()
  assert.equal(first(), true)
  surface.project({ accountSettingsPage: 'browser', browserSettingsSection: 'history' })
  assert.equal(first(), true)
  surface.project({ accountSettingsPage: 'models' })
  assert.equal(first(), false)
  surface.project({ accountSettingsPage: 'browser', browserSettingsSection: 'history' })
  assert.equal(first(), false)
  const latest = surface.capture()
  surface.project({ accountSettingsPage: null })
  assert.equal(latest(), false)
})

test('notification navigation preserves the resolved current focus without executing business actions', () => {
  const focus = { requestId: 'new-request', turnId: 'round-2', kind: 'waiting' as const }
  let received: unknown
  const actions = {
    selectProject: () => undefined,
    openWorkbenchView: () => undefined,
    openPanelSession: (_session: unknown, target?: unknown) => {
      received = target
    },
  }
  assert.equal(openSessionTarget(actions, SESSION, PROJECTS, focus), true)
  assert.equal(received, focus)
})

test('settings patch admission normalizes unknown, missing and disabled sections', () => {
  const surface = new SettingsSurface(true)
  assert.deepEqual(
    surface.project({ accountSettingsPage: 'browser', browserSettingsSection: 'downloads' }),
    { accountSettingsPage: 'browser', browserSettingsSection: 'overview' }
  )
  assert.deepEqual(surface.project({ browserSettingsSection: 'history' }), {
    accountSettingsPage: 'browser',
    browserSettingsSection: 'history',
  })
  assert.deepEqual(surface.project({ browserSettingsSection: null }), {
    accountSettingsPage: 'browser',
    browserSettingsSection: 'overview',
  })
  assert.deepEqual(surface.project({ accountSettingsPage: 'models' }), {
    accountSettingsPage: 'models',
    browserSettingsSection: null,
  })
  const disabled = new SettingsSurface(false)
  assert.deepEqual(
    disabled.project({ accountSettingsPage: 'browser', browserSettingsSection: 'history' }),
    { accountSettingsPage: null, browserSettingsSection: null }
  )
})

for (const initialProject of [null, 'project-b', 'project-a']) {
  test(`resource target navigates before opening from ${initialProject ?? 'global literature'}`, () => {
    let project = initialProject
    let view = 'literature'
    const events: string[] = []
    openResourceTarget(
      {
        selectProject: (projectId) => {
          project = projectId
          events.push('select')
        },
        openWorkbenchView: (nextView) => {
          view = nextView
          events.push('view')
        },
        openResourceFile: (path, projectId) => {
          assert.equal(project, 'project-a')
          assert.equal(projectId, project)
          assert.equal(view, 'resource')
          assert.equal(path, 'answer.md')
          events.push('open')
        },
      },
      { projectId: 'project-a', path: 'answer.md' }
    )
    assert.deepEqual(events, ['select', 'view', 'open'])
  })
}

test('a saved project page restores only the matching durable session', () => {
  assert.deepEqual(
    resolveNavigationLocation(SAVED, PROJECTS, () => SESSION),
    SAVED
  )
  assert.equal(
    resolveNavigationLocation(SAVED, PROJECTS, () => ({ ...SESSION, projectPath: '/project/b' }))
      .view,
    'home'
  )
  assert.equal(
    resolveNavigationLocation(SAVED, PROJECTS, () => ({ ...SESSION, openable: false })),
    HOME_LOCATION
  )
  assert.deepEqual(
    resolveNavigationLocation(SAVED, PROJECTS, () => undefined),
    HOME_LOCATION
  )
})

test('removed projects return home without resurrecting sessions or documents', () => {
  const restored = resolveNavigationLocation(
    { ...SAVED, settingsPage: 'skills' },
    [],
    () => SESSION
  )
  assert.equal(restored.view, 'home')
  assert.equal(restored.projectId, null)
  assert.equal(restored.sessionId, null)
  assert.equal(restored.target, null)
  assert.equal(restored.settingsPage, null)
})

test('document restoration cannot cross the saved project boundary', () => {
  const target = {
    kind: 'document',
    viewKind: 'edit',
    title: 'note',
    source: { kind: 'project', project: 'project-b', path: 'note.md' },
  } as const
  assert.equal(
    resolveNavigationLocation({ ...SAVED, target }, PROJECTS, () => SESSION).target,
    null
  )
})

test('global literature does not select a session from a project', () => {
  const saved = { ...SAVED, view: 'literature', projectId: null, sessionProjectId: null } as const
  assert.equal(resolveNavigationLocation(saved, PROJECTS, () => SESSION).sessionId, null)
  assert.equal(
    resolveNavigationLocation(saved, PROJECTS, () => ({ ...SESSION, projectPath: null })).sessionId,
    SESSION.id
  )
})

test('a docked conversation retains its own project while another project supplies the document surface', () => {
  const saved = { ...SAVED, sessionProjectId: 'project-b' }
  const restored = resolveNavigationLocation(saved, PROJECTS, () => ({
    ...SESSION,
    projectPath: '/project/b',
  }))
  assert.equal(restored.projectId, 'project-a')
  assert.equal(restored.sessionId, SESSION.id)
  assert.equal(restored.sessionProjectId, 'project-b')
})

test('fixed and durable search tabs restore while ephemeral web searches fall back', () => {
  assert.equal(restoredWorkbenchTab('literature', [])?.id, 'literature')
  assert.equal(restoredWorkbenchTab('projects', [])?.id, 'projects')
  assert.equal(
    restoredWorkbenchTab('literature-search:search-a', [{ id: 'search-a', query: 'papers' }])?.id,
    'literature-search:search-a'
  )
  assert.equal(restoredWorkbenchTab('literature-search:deleted', []), null)
  assert.equal(restoredWorkbenchTab('web-search:ephemeral', []), null)
})
