import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeNavigationLocation } from '../../navigation.ts'
import { openResourceTarget, resolveNavigationLocation, restoredWorkbenchTab } from './navigation.ts'

const PROJECTS = [{ id: 'project-a', path: '/project/a' }, { id: 'project-b', path: '/project/b' }]
const SAVED = sanitizeNavigationLocation({ view: 'resource', projectId: 'project-a', sessionId: 'session-a', sessionProjectId: 'project-a', aiPanelOpen: true })!
const SESSION = { id: 'session-a', projectPath: '/project/a', openable: true, container: false }

for (const initialProject of [null, 'project-b', 'project-a']) {
  test(`resource target navigates before opening from ${initialProject ?? 'global literature'}`, () => {
    let project = initialProject
    let view = 'literature'
    const events: string[] = []
    openResourceTarget({
      selectProject: (projectId) => { project = projectId; events.push('select') },
      openWorkbenchView: (nextView) => { view = nextView; events.push('view') },
      openResourceFile: (path, projectId) => {
        assert.equal(project, 'project-a')
        assert.equal(projectId, project)
        assert.equal(view, 'resource')
        assert.equal(path, 'answer.md')
        events.push('open')
      }
    }, { projectId: 'project-a', path: 'answer.md' })
    assert.deepEqual(events, ['select', 'view', 'open'])
  })
}

test('a saved project page restores only the matching durable session', () => {
  assert.deepEqual(resolveNavigationLocation(SAVED, PROJECTS, () => SESSION), SAVED)
  assert.equal(resolveNavigationLocation(SAVED, PROJECTS, () => ({ ...SESSION, projectPath: '/project/b' })).sessionId, null)
  assert.equal(resolveNavigationLocation(SAVED, PROJECTS, () => ({ ...SESSION, openable: false })).sessionId, null)
  assert.equal(resolveNavigationLocation(SAVED, PROJECTS, () => undefined).view, 'resource')
})

test('removed projects return home without resurrecting sessions or documents', () => {
  const restored = resolveNavigationLocation({ ...SAVED, settingsPage: 'skills' }, [], () => SESSION)
  assert.equal(restored.view, 'home')
  assert.equal(restored.projectId, null)
  assert.equal(restored.sessionId, null)
  assert.equal(restored.target, null)
  assert.equal(restored.settingsPage, 'skills')
})

test('document restoration cannot cross the saved project boundary', () => {
  const target = { kind: 'document', viewKind: 'edit', title: 'note', source: { kind: 'project', project: 'project-b', path: 'note.md' } } as const
  assert.equal(resolveNavigationLocation({ ...SAVED, target }, PROJECTS, () => SESSION).target, null)
})

test('global literature does not select a session from a project', () => {
  const saved = { ...SAVED, view: 'literature', projectId: null, sessionProjectId: null } as const
  assert.equal(resolveNavigationLocation(saved, PROJECTS, () => SESSION).sessionId, null)
  assert.equal(resolveNavigationLocation(saved, PROJECTS, () => ({ ...SESSION, projectPath: null })).sessionId, SESSION.id)
})

test('a docked conversation retains its own project while another project supplies the document surface', () => {
  const saved = { ...SAVED, sessionProjectId: 'project-b' }
  const restored = resolveNavigationLocation(saved, PROJECTS, () => ({ ...SESSION, projectPath: '/project/b' }))
  assert.equal(restored.projectId, 'project-a')
  assert.equal(restored.sessionId, SESSION.id)
  assert.equal(restored.sessionProjectId, 'project-b')
})

test('fixed and durable search tabs restore while ephemeral web searches fall back', () => {
  assert.equal(restoredWorkbenchTab('literature', [])?.id, 'literature')
  assert.equal(restoredWorkbenchTab('projects', [])?.id, 'projects')
  assert.equal(restoredWorkbenchTab('literature-search:search-a', [{ id: 'search-a', query: 'papers' }])?.id, 'literature-search:search-a')
  assert.equal(restoredWorkbenchTab('literature-search:deleted', []), null)
  assert.equal(restoredWorkbenchTab('web-search:ephemeral', []), null)
})
