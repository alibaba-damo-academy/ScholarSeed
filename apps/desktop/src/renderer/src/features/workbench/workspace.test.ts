import { createInstance } from 'i18next'
import { documentDisplayTitle } from '../../delivery.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOCUMENT_LOAD_FAILURE_KIND,
  documentIdFor,
  recordTargetFor,
  isDocumentLoadFailure,
  isMissingDocumentFailure,
  type LoadedDocument,
  viewerFromProjection
} from './api.ts'
import type { LiteratureDocumentSource } from '../../contracts/workbench.ts'
import { findLeaf, nodeTabCount } from './layout.ts'
import {
  DocumentWorkspace,
  DocumentWorkspaceRegistry,
  documentTextReveal,
  focusedSelectionPresentation,
  tabIdsForClose,
  type DocumentLoader,
  type RestoredProjectFile,
  type SelectionViewport
} from './workspace.ts'

const source = { kind: 'project' as const, path: 'notes/readme.md' }

const undiscoveredVersioning = {
  file_id: null,
  version_id: null,
  working_revision: null,
  disk_revision: null,
  can_version: true,
  can_diff: false,
  can_preview_history: false,
  management_state: 'managed' as const,
  snapshot_state: 'pending' as const,
  pending: null,
  drifted: false
}

const managedVersioning = {
  file_id: 'file-notes',
  version_id: 'version-1',
  working_revision: 'sha256:saved',
  disk_revision: 'sha256:saved',
  can_version: true,
  can_diff: true,
  can_preview_history: true,
  management_state: 'managed' as const,
  snapshot_state: 'saved' as const,
  pending: null,
  drifted: false
}

const viewport: SelectionViewport = {
  rect: { left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 },
  point: { x: 110, y: 40 },
  visible: false
}

test('artifact MIME projections select Markdown and image viewers without a render hint', () => {
  for (const [mediaType, expected] of [
    ['text/markdown', 'markdown'],
    ['text/x-markdown; charset=utf-8', 'markdown'],
    ['image/png', 'image'],
    ['image/jpeg', 'image']
  ] as const) {
    assert.equal(viewerFromProjection({
      kind: 'session-artifact',
      sessionId: 'session',
      artifactId: 'publication',
      path: 'artifact',
      mediaType
    }), expected)
  }
})

test('session Python artifacts use the existing code viewer', () => {
  assert.equal(viewerFromProjection({
    kind: 'session-artifact',
    sessionId: 'session-python',
    artifactId: 'artifact-python',
    path: 'quick_sort.py',
    mediaType: 'text/x-python'
  }), 'code')
})

test('content-inferred code viewer remains editable without a known extension', async () => {
  const workspace = new DocumentWorkspace({
    async load(requested): Promise<LoadedDocument> {
      const markdown = requested.path.endsWith('.md')
      return {
        documentId: 'project:current:Dockerfile',
        source: requested,
        viewer: 'code',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: false,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:dockerfile',
        mediaType: 'application/octet-stream',
        contentKind: 'text',
        bytes: new TextEncoder().encode('FROM python:3.13\n')
      }
    },
    async commit() {
      return { ok: false, error: 'unavailable' }
    }
  })

  const tabId = await workspace.open({ kind: 'project', path: 'Dockerfile' }, 'edit')
  const snapshot = workspace.getSnapshot()
  const session = snapshot.sessions[snapshot.tabs[tabId].sessionId]

  assert.equal(snapshot.tabs[tabId].viewKind, 'edit')
  assert.equal(session.text, 'FROM python:3.13\n')
  assert.equal(session.capabilities.can_edit, true)
})

test('unsupported binary files remain in preview mode', async () => {
  const workspace = new DocumentWorkspace({
    async load(requested): Promise<LoadedDocument> {
      return {
        documentId: 'project:current:opaque',
        source: requested,
        viewer: 'unsupported',
        processor: null,
        capabilities: {
          can_preview: false,
          can_edit: false,
          can_select: false,
          can_annotate: false,
          can_save: false,
          can_version: false,
          can_diff: false,
          pending: ['binary_preview_unsupported']
        },
        revision: 'sha256:opaque',
        mediaType: 'application/octet-stream',
        contentKind: 'binary',
        bytes: new Uint8Array()
      }
    },
    async commit() {
      return { ok: false, error: 'unavailable' }
    }
  })

  const tabId = await workspace.open({ kind: 'project', path: 'opaque' }, 'edit')

  assert.equal(workspace.getSnapshot().tabs[tabId].viewKind, 'preview')
})

function textSelection(sessionId: string, revision: string, text = 'Draft') {
  return {
    document_id: 'project:current:notes/readme.md',
    document_session_id: sessionId,
    revision,
    status: 'exact' as const,
    text,
    locator: {
      kind: 'text' as const,
      start_line: 0,
      start_column: 2,
      end_line: 0,
      end_column: 2 + text.length
    }
  }
}

function loader(): DocumentLoader {
  let revision = 1
  return {
    async load(requested = source): Promise<LoadedDocument> {
      const bytes = new TextEncoder().encode('# Draft\n')
      return {
        documentId: `project:current:${requested.path}`,
        source: requested,
        viewer: 'markdown',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: false,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:initial',
        mediaType: 'text/markdown',
        bytes
      }
    },
    async commit() {
      revision += 1
      return { ok: true as const, revision: `sha256:saved-${revision}` }
    }
  }
}

test('clean binary sessions share one immutable baseline snapshot', async () => {
  const pdfSource = { kind: 'project' as const, path: 'paper.pdf' }
  const workspace = new DocumentWorkspace({
    async load() {
      return {
        documentId: 'project:current:paper.pdf',
        source: pdfSource,
        viewer: 'pdf' as const,
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: false,
          can_select: true,
          can_annotate: true,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:pdf',
        mediaType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }
    },
    async commit() {
      return { ok: false as const, error: 'unavailable' }
    }
  })

  const tabId = await workspace.open(pdfSource, 'preview')
  const session = workspace.getSnapshot().sessions[workspace.getSnapshot().tabs[tabId].sessionId]

  assert.equal(session.bytes, session.savedBytes)
  assert.deepEqual(Array.from(session.bytes), [1, 2, 3])
})

test('failed document loads preserve typed evidence and can be retried in place', async () => {
  let attempts = 0
  const successful = loader()
  const workspace = new DocumentWorkspace({
    ...successful,
    async load(requested) {
      attempts += 1
      if (attempts === 1) {
        return {
          kind: DOCUMENT_LOAD_FAILURE_KIND,
          code: 'literature_attachment_unreadable',
          message: '附件当前无法读取',
          retryable: true,
          status: 422
        }
      }
      return successful.load(requested)
    }
  })

  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const failed = workspace.getSnapshot().sessions[sessionId]
  assert.equal(failed.loadState, 'error')
  assert.equal(failed.loadFailure?.code, 'literature_attachment_unreadable')
  assert.equal(await workspace.retryLoad(sessionId), true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].loadState, 'ready')
  assert.equal(workspace.getSnapshot().sessions[sessionId].loadFailure, null)
  assert.equal(attempts, 2)
})

test('missing document failures are classified separately from retryable load failures', () => {
  const missing = {
    kind: DOCUMENT_LOAD_FAILURE_KIND,
    code: 'document_http_error',
    message: 'document_http_error:404',
    retryable: false,
    status: 404
  }
  const transient = {
    kind: DOCUMENT_LOAD_FAILURE_KIND,
    code: 'document_http_error',
    message: 'document_http_error:503',
    retryable: true,
    status: 503
  }
  assert.equal(isDocumentLoadFailure(missing), true)
  assert.equal(isMissingDocumentFailure(missing), true)
  assert.equal(isMissingDocumentFailure(transient), false)
})

test('project registry isolates tabs, layout, focus, and dirty sessions for identical paths', async () => {
  const registry = new DocumentWorkspaceRegistry(loader())
  const first = registry.forProject('project-one')
  const second = registry.forProject('project-two')

  const firstTab = await first.open({ ...source, project: 'project-one' }, 'edit')
  const firstSession = first.getSnapshot().tabs[firstTab].sessionId
  first.updateText(firstSession, '# project one draft')
  const secondTab = await second.open({ ...source, project: 'project-two' }, 'edit')

  assert.notEqual(first, second)
  assert.equal(first.getSnapshot().focusedTabId, firstTab)
  assert.equal(first.getSnapshot().sessions[firstSession].dirty, true)
  assert.deepEqual(Object.keys(first.getSnapshot().tabs), [firstTab])
  assert.deepEqual(Object.keys(second.getSnapshot().tabs), [secondTab])
  const home = registry.forProject(null)
  assert.deepEqual(Object.keys(home.getSnapshot().tabs), [])
  assert.equal(registry.forProject('project-one'), first)
  assert.equal(registry.forProject('project-one').getSnapshot().focusedTabId, firstTab)
  assert.equal(registry.forProject('project-one').getSnapshot().sessions[firstSession].text, '# project one draft')
  assert.equal(registry.forProject('project-one').getSnapshot().sessions[firstSession].dirty, true)
})

test('saveFocused commits only the focused dirty save-capable session through ordinary save', async () => {
  const commits: string[] = []
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async commit(requested, bytes, revision) {
      commits.push(requested.path)
      return base.commit(requested, bytes, revision)
    }
  })
  const firstTab = await workspace.open({ ...source, path: 'notes/first.md' }, 'edit')
  const firstSession = workspace.getSnapshot().tabs[firstTab].sessionId
  workspace.updateText(firstSession, '# first draft')
  const secondTab = await workspace.open({ ...source, path: 'notes/second.md' }, 'edit')
  const secondSession = workspace.getSnapshot().tabs[secondTab].sessionId
  workspace.updateText(secondSession, '# second draft')

  assert.equal(await workspace.saveFocused(), true)
  assert.deepEqual(commits, ['notes/second.md'])
  assert.equal(workspace.getSnapshot().sessions[firstSession].dirty, true)
  assert.equal(workspace.getSnapshot().sessions[secondSession].dirty, false)
})

test('saveAll saves every dirty writable document and stops on the first failure', async () => {
  const commits: string[] = []
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async commit(requested, bytes, revision) {
      commits.push(requested.path)
      if (requested.path === 'notes/blocked.md') return { ok: false, error: 'failed' as const }
      return base.commit(requested, bytes, revision)
    }
  })
  const firstTab = await workspace.open({ ...source, path: 'notes/first.md' }, 'edit')
  const firstSession = workspace.getSnapshot().tabs[firstTab].sessionId
  workspace.updateText(firstSession, '# first draft')
  const blockedTab = await workspace.open({ ...source, path: 'notes/blocked.md' }, 'edit')
  const blockedSession = workspace.getSnapshot().tabs[blockedTab].sessionId
  workspace.updateText(blockedSession, '# blocked draft')
  const lastTab = await workspace.open({ ...source, path: 'notes/last.md' }, 'edit')
  const lastSession = workspace.getSnapshot().tabs[lastTab].sessionId
  workspace.updateText(lastSession, '# last draft')

  assert.equal(await workspace.saveAll(), false)
  assert.deepEqual(commits, ['notes/first.md', 'notes/blocked.md'])
  assert.equal(workspace.getSnapshot().sessions[firstSession].dirty, false)
  assert.equal(workspace.getSnapshot().sessions[blockedSession].dirty, true)
  assert.equal(workspace.getSnapshot().sessions[lastSession].dirty, true)
})

test('disk save refreshes version state without claiming a new saved version', async () => {
  const base = loader()
  const pending = { ...managedVersioning, snapshot_state: 'pending' as const }
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, versioning: managedVersioning }
    },
    async versioning() { return pending }
  })
  const tab = await workspace.open(source, 'edit')
  const session = workspace.getSnapshot().tabs[tab].sessionId
  workspace.updateText(session, '# changed')
  assert.equal(await workspace.save(session), true)
  assert.equal(workspace.getSnapshot().sessions[session].versioning?.snapshot_state, 'pending')
  assert.equal(workspace.getSnapshot().sessions[session].versioning?.version_id, 'version-1')
})

test('resource actions detect dirty editors and keep explicit project identities separate', async () => {
  const workspace = new DocumentWorkspace(loader())
  const requested = { ...source, project: 'project-one' }
  const tab = await workspace.open(requested, 'edit')
  const session = workspace.getSnapshot().tabs[tab].sessionId
  assert.equal(workspace.hasResourceChanges('project-one', 'file', [requested.path]), false)
  workspace.updateText(session, '# pending editor draft')
  assert.equal(workspace.hasResourceChanges('project-one', 'file', [requested.path]), true)
  assert.equal(workspace.hasResourceChanges('project-two', 'file', [requested.path]), false)
  assert.equal(workspace.hasResourceChanges('project-one', 'file', ['different/path']), false)
})

test('a missing post-save capability cannot retain the old saved-version status', async () => {
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, versioning: managedVersioning }
    },
    async versioning() { return null }
  })
  const tab = await workspace.open(source, 'edit')
  const session = workspace.getSnapshot().tabs[tab].sessionId
  workspace.updateText(session, '# saved bytes, metadata unavailable')
  assert.equal(await workspace.save(session), true)
  assert.equal(workspace.getSnapshot().sessions[session].versioning, null)
  assert.equal(workspace.getSnapshot().sessions[session].dirty, false)
})

test('successful seal capability refresh preserves an edit made while capability is loading', async () => {
  let release!: (value: typeof managedVersioning) => void
  const pending = new Promise<typeof managedVersioning>((resolve) => { release = resolve })
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, versioning: undiscoveredVersioning }
    },
    versioning: async () => pending
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const documentId = workspace.getSnapshot().sessions[sessionId].documentId
  const refreshing = workspace.refreshVersioning(sessionId, documentId)
  workspace.updateText(sessionId, '# Edited while refreshing\n')
  const edited = workspace.getSnapshot().sessions[sessionId]
  release(managedVersioning)

  assert.equal(await refreshing, true)
  const refreshed = workspace.getSnapshot().sessions[sessionId]
  assert.equal(refreshed.versioning?.can_preview_history, true)
  assert.equal(refreshed.versioning?.file_id, 'file-notes')
  assert.strictEqual(refreshed.bytes, edited.bytes)
  assert.equal(refreshed.text, edited.text)
  assert.equal(refreshed.revision, edited.revision)
  assert.equal(refreshed.dirty, true)
  assert.equal(refreshed.saveState, 'dirty')
  assert.equal(refreshed.changeVersion, edited.changeVersion)
})

test('failed version capability refresh leaves the complete session unchanged', async () => {
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, versioning: undiscoveredVersioning }
    },
    versioning: async () => null
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const before = workspace.getSnapshot().sessions[sessionId]

  assert.equal(await workspace.refreshVersioning(sessionId, before.documentId), false)
  assert.strictEqual(workspace.getSnapshot().sessions[sessionId], before)
})

test('project path reconciliation reloads a clean open preview in place', async () => {
  let revision = 'sha256:before'
  let text = '# Before\n'
  let loads = 0
  const projectSource = { kind: 'project' as const, project: 'project-1', path: source.path }
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      loads += 1
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      return {
        ...loaded,
        documentId: documentIdFor(requested),
        source: requested,
        revision,
        bytes: new TextEncoder().encode(text)
      }
    }
  })
  const tabId = await workspace.open(projectSource, 'preview')
  const before = workspace.getSnapshot()
  const sessionId = before.tabs[tabId].sessionId
  workspace.setTabViewState(tabId, { scrollTop: 120 })
  revision = 'sha256:after'
  text = '# After\n'

  await workspace.reconcileProjectPaths('project-1', [source.path])

  const after = workspace.getSnapshot()
  assert.equal(loads, 2)
  assert.equal(after.tabs[tabId].sessionId, sessionId)
  assert.deepEqual(after.tabs[tabId].viewState, { scrollTop: 120 })
  assert.equal(after.sessions[sessionId].text, '# After\n')
  assert.equal(after.sessions[sessionId].revision, 'sha256:after')
  assert.equal(after.sessions[sessionId].changeVersion, before.sessions[sessionId].changeVersion + 1)
  assert.equal(after.sessions[sessionId].dirty, false)
})

test('project rescan reloads changed linked previews and leaves other projects untouched', async () => {
  const revisions = new Map([
    ['project-1', 'sha256:before'],
    ['project-2', 'sha256:other']
  ])
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      const project = requested.kind === 'project' ? requested.project ?? 'current' : 'current'
      const revision = revisions.get(project) ?? 'sha256:unknown'
      return {
        ...loaded,
        documentId: documentIdFor(requested),
        source: requested,
        revision,
        bytes: new TextEncoder().encode(`# ${revision}\n`)
      }
    }
  })
  const linked = await workspace.open(
    { kind: 'project', project: 'project-1', path: 'resources/linked.md' },
    'preview'
  )
  const other = await workspace.open(
    { kind: 'project', project: 'project-2', path: 'resources/linked.md' },
    'preview'
  )
  const linkedSession = workspace.getSnapshot().tabs[linked].sessionId
  const otherSession = workspace.getSnapshot().tabs[other].sessionId
  revisions.set('project-1', 'sha256:after')

  await workspace.reconcileProject('project-1')

  const state = workspace.getSnapshot()
  assert.equal(state.sessions[linkedSession].text, '# sha256:after\n')
  assert.equal(state.sessions[linkedSession].revision, 'sha256:after')
  assert.equal(state.sessions[linkedSession].externalChange, true)
  assert.equal(state.sessions[otherSession].revision, 'sha256:other')
})

test('project rescan checks disk revision before marking an unsaved editor conflicted', async () => {
  let diskRevision = 'sha256:before'
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return {
        ...loaded,
        documentId: documentIdFor(requested),
        source: requested,
        revision: diskRevision,
        bytes: new TextEncoder().encode(`# ${diskRevision}\n`)
      }
    }
  })
  const tabId = await workspace.open(
    { kind: 'project', project: 'project-1', path: 'resources/linked.md' },
    'edit'
  )
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Unsaved\n')

  await workspace.reconcileProject('project-1')
  assert.equal(workspace.getSnapshot().sessions[sessionId].saveState, 'dirty')

  diskRevision = 'sha256:external'
  await workspace.reconcileProject('project-1')
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(session.text, '# Unsaved\n')
  assert.equal(session.saveState, 'conflict')
})

test('project rescan cannot restore a stale path after the document is relocated', async () => {
  let loads = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const call = ++loads
      const loaded = await base.load(requested)
      assert.ok(loaded)
      if (call > 1) await pending
      return {
        ...loaded,
        documentId: 'project:project-1:asset:linked',
        source: requested,
        revision: call > 1 ? 'sha256:after' : 'sha256:before',
        bytes: new TextEncoder().encode(call > 1 ? '# After\n' : '# Before\n')
      }
    }
  })
  const tabId = await workspace.open(
    { kind: 'project', project: 'project-1', path: 'resources/linked.md' },
    'preview'
  )
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const scanning = workspace.reconcileProject('project-1')
  await Promise.resolve()
  await workspace.relocateProjectPath(
    'project-1',
    'resources/linked.md',
    'resources/renamed.md',
    'renamed.md'
  )
  release()

  await scanning

  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(session.source.path, 'resources/renamed.md')
  assert.equal(session.text, '# Before\n')
  assert.equal(workspace.getSnapshot().tabs[tabId].title, 'renamed.md')
})

test('external path events are scoped to their project before refreshing a preview', async () => {
  const base = loader()
  let loads = 0
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      loads += 1
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, documentId: documentIdFor(requested), source: requested }
    }
  })
  await workspace.open(
    { kind: 'project', project: 'project-2', path: 'resources/linked.md' },
    'preview'
  )

  await workspace.observeExternal('project-1', 'resources/linked.md')

  assert.equal(loads, 1)
})

test('project path reconciliation preserves unsaved edits as a conflict', async () => {
  let loads = 0
  const projectSource = { kind: 'project' as const, project: 'project-1', path: source.path }
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      loads += 1
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, documentId: documentIdFor(requested), source: requested }
    }
  })
  const tabId = await workspace.open(projectSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Unsaved\n')

  await workspace.reconcileProjectPaths('project-1', [source.path])

  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(loads, 1)
  assert.equal(session.text, '# Unsaved\n')
  assert.equal(session.dirty, true)
  assert.equal(session.saveState, 'conflict')
})

test('project path reconciliation never overwrites an edit made while reloading', async () => {
  let loads = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const projectSource = { kind: 'project' as const, project: 'project-1', path: source.path }
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      loads += 1
      const loaded = await base.load(requested)
      assert.ok(loaded)
      if (loads > 1) await pending
      return {
        ...loaded,
        documentId: documentIdFor(requested),
        source: requested,
        revision: loads > 1 ? 'sha256:after' : 'sha256:before',
        bytes: new TextEncoder().encode(loads > 1 ? '# After\n' : '# Before\n')
      }
    }
  })
  const tabId = await workspace.open(projectSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const synchronizing = workspace.reconcileProjectPaths('project-1', [source.path])
  await Promise.resolve()
  workspace.updateText(sessionId, '# Edited during reload\n')
  release()

  await synchronizing

  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(loads, 2)
  assert.equal(session.text, '# Edited during reload\n')
  assert.equal(session.dirty, true)
  assert.equal(session.saveState, 'conflict')
})

test('a stale reload cannot turn a newer clean reload into a conflict', async () => {
  let loads = 0
  let releaseStale!: () => void
  const stalePending = new Promise<void>((resolve) => { releaseStale = resolve })
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const call = ++loads
      const loaded = await base.load(requested)
      assert.ok(loaded)
      if (call === 2) await stalePending
      return {
        ...loaded,
        documentId: documentIdFor(requested),
        source: requested,
        revision: `sha256:load-${call}`,
        bytes: new TextEncoder().encode(call === 3 ? '# Newer reload\n' : '# Stale reload\n')
      }
    }
  })
  const tabId = await workspace.open(
    { kind: 'project', project: 'project-1', path: source.path },
    'preview'
  )
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const stale = workspace.reload(sessionId)
  await Promise.resolve()
  const newer = workspace.reload(sessionId)

  assert.equal(await newer, true)
  releaseStale()
  assert.equal(await stale, false)

  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(session.text, '# Newer reload\n')
  assert.equal(session.dirty, false)
  assert.equal(session.saveState, 'clean')
})

test('unexpected version capability failure is observable and leaves the session unchanged', async () => {
  const workspace = new DocumentWorkspace({
    ...loader(),
    versioning: async () => { throw new Error('capability failed') }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const before = workspace.getSnapshot().sessions[sessionId]

  await assert.rejects(
    workspace.refreshVersioning(sessionId, before.documentId),
    /capability failed/
  )
  assert.strictEqual(workspace.getSnapshot().sessions[sessionId], before)
})

test('external change clearing is guarded by the archived document identity', async () => {
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, externalChange: true }
    }
  })
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const session = workspace.getSnapshot().sessions[sessionId]

  workspace.clearExternalChange(sessionId, 'project:current:another.md')
  assert.equal(workspace.getSnapshot().sessions[sessionId].externalChange, true)
  workspace.clearExternalChange(sessionId, session.documentId)
  assert.equal(workspace.getSnapshot().sessions[sessionId].externalChange, false)
})

test('closing a document invalidates its pending version capability refresh', async () => {
  let release!: (value: typeof managedVersioning) => void
  const pending = new Promise<typeof managedVersioning>((resolve) => { release = resolve })
  const workspace = new DocumentWorkspace({ ...loader(), versioning: async () => pending })
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const documentId = workspace.getSnapshot().sessions[sessionId].documentId
  const refreshing = workspace.refreshVersioning(sessionId, documentId)
  workspace.requestClose(tabId)
  release(managedVersioning)

  assert.equal(await refreshing, false)
  assert.equal(workspace.getSnapshot().sessions[sessionId], undefined)
})

test('an older version capability response cannot overwrite a newer response', async () => {
  const releases: Array<(value: typeof managedVersioning) => void> = []
  const workspace = new DocumentWorkspace({
    ...loader(),
    versioning: async () => new Promise((resolve) => { releases.push(resolve) })
  })
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const documentId = workspace.getSnapshot().sessions[sessionId].documentId
  const older = workspace.refreshVersioning(sessionId, documentId)
  const newer = workspace.refreshVersioning(sessionId, documentId)
  const latest = { ...managedVersioning, version_id: 'version-3', working_revision: 'sha256:three' }
  releases[1](latest)
  assert.equal(await newer, true)
  releases[0]({ ...managedVersioning, version_id: 'version-2', working_revision: 'sha256:two' })

  assert.equal(await older, false)
  assert.equal(workspace.getSnapshot().sessions[sessionId].versioning?.version_id, 'version-3')
})

test('a successful reload invalidates an older capability response for the same document', async () => {
  let release!: (value: typeof managedVersioning) => void
  const pending = new Promise<typeof managedVersioning>((resolve) => { release = resolve })
  const base = loader()
  let loadCount = 0
  const reloadedVersioning = {
    ...managedVersioning,
    version_id: 'version-reloaded',
    working_revision: 'sha256:reloaded'
  }
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      loadCount += 1
      return {
        ...loaded,
        versioning: loadCount === 1 ? undiscoveredVersioning : reloadedVersioning
      }
    },
    versioning: async () => pending
  })
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const documentId = workspace.getSnapshot().sessions[sessionId].documentId
  const refreshing = workspace.refreshVersioning(sessionId, documentId)

  assert.equal(await workspace.reload(sessionId), true)
  release({ ...managedVersioning, version_id: 'version-stale' })

  assert.equal(await refreshing, false)
  assert.equal(
    workspace.getSnapshot().sessions[sessionId].versioning?.version_id,
    'version-reloaded'
  )
})

test('plain reload preserves edits made while disk content is loading', async () => {
  const base = loader()
  let block = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      if (block) await pending
      return loaded
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  block = true
  const reloading = workspace.reload(sessionId)
  workspace.updateText(sessionId, '# New draft during reload\n')
  release()
  assert.equal(await reloading, false)
  const current = workspace.getSnapshot().sessions[sessionId]
  assert.equal(current.text, '# New draft during reload\n')
  assert.equal(current.dirty, true)
  assert.equal(current.saveState, 'conflict')
})

test('a capability response for an old document identity cannot update a restored path', async () => {
  let release!: (value: typeof managedVersioning) => void
  const pending = new Promise<typeof managedVersioning>((resolve) => { release = resolve })
  const base = loader()
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return {
        ...loaded,
        documentId: `project:current:${requested.path}`,
        source: requested,
        versioning: undiscoveredVersioning
      }
    },
    versioning: async () => pending
  })
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const documentId = workspace.getSnapshot().sessions[sessionId].documentId
  const refreshing = workspace.refreshVersioning(sessionId, documentId)
  const restored = await workspace.reconcileRestoredFiles('current', [{
    fileId: 'file-notes',
    versionId: 'version-restored',
    previousPath: source.path,
    path: 'notes/restored.md',
    state: 'present'
  }])
  assert.deepEqual(restored, { synchronized: ['file-notes'], conflicted: [], failed: [] })
  release(managedVersioning)

  assert.equal(await refreshing, false)
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(session.source.path, 'notes/restored.md')
  assert.equal(session.versioning?.can_preview_history, false)
})

test('runtime capability restriction preserves session bytes, dirty state and selection capability', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Changed\n')
  const before = workspace.getSnapshot().sessions[sessionId]
  workspace.restrictEditing(sessionId, 'Native editing is not safe')
  const after = workspace.getSnapshot().sessions[sessionId]
  assert.equal(after.capabilities.can_edit, false)
  assert.equal(after.capabilities.can_save, false)
  assert.equal(after.capabilities.can_select, true)
  assert.equal(after.bytes, before.bytes)
  assert.equal(after.dirty, true)
  assert.equal(after.saveState, 'dirty')
})

test('Markdown source and visual modes reuse one tab and one document session', async () => {
  const workspace = new DocumentWorkspace(loader())
  const editId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[editId].sessionId
  const initialRevision = workspace.getSnapshot().sessions[sessionId].revision
  const previewId = await workspace.open(source, 'preview')
  const state = workspace.getSnapshot()
  assert.equal(Object.keys(state.sessions).length, 1)
  assert.equal(Object.keys(state.tabs).length, 1)
  assert.equal(previewId, editId)
  assert.equal(state.tabs[editId].viewKind, 'preview')
  assert.equal(state.tabs[editId].sessionId, sessionId)
  assert.equal(state.sessions[sessionId].revision, initialRevision)
  workspace.updateText(sessionId, '# Changed\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].dirty, true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].text, '# Changed\n')
})

test('text reveal opens Markdown source, reuses its tab, and advances the request sequence', async () => {
  const workspace = new DocumentWorkspace(loader())
  const editId = await workspace.open(source, 'edit')
  const reveal = {
    kind: 'find' as const,
    query: 'Draft',
    source_revision: 'sha256:search-result'
  }

  const first = await workspace.revealText(source, reveal)
  const firstState = workspace.getSnapshot()
  assert.equal(first, editId)
  assert.equal(firstState.tabs[first].viewKind, 'preview')
  assert.deepEqual(firstState.tabs[first].viewState?.documentTextReveal, {
    ...reveal,
    sequence: 1
  })

  const second = await workspace.revealText(source, reveal)
  assert.equal(second, first)
  assert.equal(documentTextReveal(workspace.getSnapshot().tabs[second])?.sequence, 2)
  assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 1)
})

test('project relocation preserves the stable session, tab and PDF view state', async () => {
  const pdfSource = { kind: 'project' as const, path: 'papers/original.pdf', project: 'project-1' }
  const relocatedVersioning = {
    ...managedVersioning,
    snapshot_state: 'pending' as const,
    pending: {
      file_id: managedVersioning.file_id,
      revision: 2,
      origin: 'user' as const,
      review: null
    }
  }
  let capabilityPath = ''
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load() {
      const loaded = await loader().load(pdfSource)
      assert.ok(loaded)
      return {
        ...loaded,
        documentId: 'project:project-1:asset:pdf-asset',
        source: { ...pdfSource, assetId: 'pdf-asset' },
        viewer: 'pdf',
        versioning: managedVersioning
      }
    },
    async versioning(requested) {
      capabilityPath = requested.path
      return relocatedVersioning
    }
  })
  const tabId = await workspace.open(pdfSource, 'preview')
  assert.equal(await workspace.open(pdfSource, 'preview'), tabId)
  const before = workspace.getSnapshot()
  const sessionId = before.tabs[tabId].sessionId
  workspace.setTabViewState(tabId, { page: 3, mode: 'width', sidebar: true })
  await workspace.relocateProjectPath(
    'project-1',
    'papers/original.pdf',
    'archive/renamed.pdf',
    'renamed.pdf'
  )
  const after = workspace.getSnapshot()
  assert.equal(after.tabs[tabId].sessionId, sessionId)
  assert.equal(after.tabs[tabId].title, 'renamed.pdf')
  assert.deepEqual(after.tabs[tabId].viewState, { page: 3, mode: 'width', sidebar: true })
  assert.equal(after.sessions[sessionId].documentId, 'project:project-1:asset:pdf-asset')
  assert.equal(after.sessions[sessionId].source.path, 'archive/renamed.pdf')
  assert.equal(capabilityPath, 'archive/renamed.pdf')
  assert.equal(after.sessions[sessionId].versioning?.snapshot_state, 'pending')
})

test('project relocation never changes a same-path session from another project', async () => {
  const first = { kind: 'project' as const, path: 'papers/report.pdf', project: 'project-1' }
  const second = { kind: 'project' as const, path: 'papers/report.pdf', project: 'project-2' }
  const workspace = new DocumentWorkspace(loader())
  await workspace.open(first, 'preview')
  await workspace.open(second, 'preview')

  workspace.relocateProjectPath('project-1', first.path, 'archive/report.pdf')

  const paths = Object.values(workspace.getSnapshot().sessions)
    .map(session => [session.source.kind === 'project' ? session.source.project : null, session.source.path])
  assert.ok(paths.some(([project, path]) => project === 'project-1' && path === 'archive/report.pdf'))
  assert.ok(paths.some(([project, path]) => project === 'project-2' && path === 'papers/report.pdf'))
})

test('project subtree dirty checks include descendants but isolate prefixes and projects', async () => {
  const workspace = new DocumentWorkspace(loader())
  const dirtyTab = await workspace.open(
    { kind: 'project', project: 'project-1', path: 'folder/child.md' },
    'edit'
  )
  await workspace.open(
    { kind: 'project', project: 'project-1', path: 'folder-copy/child.md' },
    'edit'
  )
  await workspace.open(
    { kind: 'project', project: 'project-2', path: 'folder/child.md' },
    'edit'
  )
  const sessionId = workspace.getSnapshot().tabs[dirtyTab].sessionId
  workspace.updateText(sessionId, '# Dirty\n')

  assert.equal(workspace.hasDirtyProjectPath('project-1', 'folder'), true)
  assert.equal(workspace.hasDirtyProjectPath('project-1', 'folder-copy'), false)
  assert.equal(workspace.hasDirtyProjectPath('project-2', 'folder'), false)
})

test('project subtree close removes all descendants and preserves same-prefix siblings', async () => {
  const workspace = new DocumentWorkspace(loader())
  await workspace.open({ kind: 'project', project: 'project-1', path: 'folder/a.md' }, 'preview')
  await workspace.open({ kind: 'project', project: 'project-1', path: 'folder/sub/b.md' }, 'preview')
  await workspace.open({ kind: 'project', project: 'project-1', path: 'folder-copy/c.md' }, 'preview')
  await workspace.open({ kind: 'project', project: 'project-2', path: 'folder/d.md' }, 'preview')

  assert.equal(workspace.requestCloseProjectPath('project-1', 'folder'), true)
  const remaining = Object.values(workspace.getSnapshot().sessions).map((session) => [
    session.source.kind === 'project' ? session.source.project : null,
    session.source.path
  ])
  assert.deepEqual(remaining, [
    ['project-1', 'folder-copy/c.md'],
    ['project-2', 'folder/d.md']
  ])
})

test('closing a deleted literature attachment reaches every project workspace', async () => {
  const registry = new DocumentWorkspaceRegistry(loader())
  const first = registry.forProject('project-one')
  const second = registry.forProject('project-two')
  const primary: LiteratureDocumentSource = {
    kind: 'literature',
    literatureId: 'paper',
    attachmentId: 'primary',
    recordTarget: { owner: 'literature_attachment', scope_id: 'paper', subject_id: 'primary' },
    path: 'primary.pdf'
  }
  await first.open(primary, 'preview')
  await first.open({ ...primary, attachmentId: 'slides', path: 'slides.pdf' }, 'preview')
  await second.open({ ...primary, path: 'primary-copy.pdf' }, 'preview')

  // 文献是全库维度: 同一份附件可能同时开在别的项目工作区里, 删除附件时必须
  // 全部收掉, 否则界面继续留着一个指向已不存在字节的标签。
  assert.equal(registry.closeLiteratureAttachment('paper', 'primary'), true)
  assert.deepEqual(
    Object.values(first.getSnapshot().sessions).map((session) => session.source.path),
    ['slides.pdf']
  )
  assert.deepEqual(Object.keys(second.getSnapshot().tabs), [])
  // 收干净之后再收是空操作, 不能误报“关掉了”。
  assert.equal(registry.closeLiteratureAttachment('paper', 'primary'), false)
  assert.equal(registry.closeLiteratureAttachment('other-paper', 'slides'), false)
  assert.deepEqual(
    Object.values(first.getSnapshot().sessions).map((session) => session.source.path),
    ['slides.pdf']
  )
})

test('discarding a project subtree closes dirty descendants without another confirmation', async () => {
  const workspace = new DocumentWorkspace(loader())
  const dirty = await workspace.open(
    { kind: 'project', project: 'project-1', path: 'folder/a.md' },
    'edit'
  )
  await workspace.open(
    { kind: 'project', project: 'project-1', path: 'folder/sub/b.md' },
    'edit'
  )
  await workspace.open(
    { kind: 'project', project: 'project-1', path: 'folder-copy/c.md' },
    'edit'
  )
  await workspace.open(
    { kind: 'project', project: 'project-2', path: 'folder/d.md' },
    'edit'
  )
  const dirtySessionId = workspace.getSnapshot().tabs[dirty].sessionId
  workspace.updateText(dirtySessionId, '# Unsaved\n')

  assert.equal(workspace.discardProjectPath('project-1', 'folder'), true)
  const remaining = Object.values(workspace.getSnapshot().sessions).map((session) => [
    session.source.kind === 'project' ? session.source.project : null,
    session.source.path
  ])
  assert.deepEqual(remaining, [
    ['project-1', 'folder-copy/c.md'],
    ['project-2', 'folder/d.md']
  ])
  assert.equal(workspace.getSnapshot().pendingClose, null)
})

test('code files normalize preview requests into one editable tab', async () => {
  const codeSource = { kind: 'project' as const, path: 'source/main.c' }
  const codeLoader: DocumentLoader = {
    ...loader(),
    async load() {
      const loaded = await loader().load(codeSource)
      assert.ok(loaded)
      return { ...loaded, viewer: 'code', source: codeSource, documentId: 'project:current:source/main.c' }
    }
  }
  const workspace = new DocumentWorkspace(codeLoader)
  const first = await workspace.open(codeSource, 'preview')
  const second = await workspace.open(codeSource, 'edit')
  const state = workspace.getSnapshot()
  assert.equal(first, second)
  assert.equal(Object.keys(state.tabs).length, 1)
  assert.equal(state.tabs[first].viewKind, 'edit')
})

test('spreadsheet requests normalize into one tab without preview mode', async () => {
  const spreadsheetSource = { kind: 'project' as const, path: 'results.csv' }
  const spreadsheetLoader: DocumentLoader = {
    ...loader(),
    async load() {
      const loaded = await loader().load(spreadsheetSource)
      assert.ok(loaded)
      return {
        ...loaded,
        viewer: 'spreadsheet' as const,
        source: spreadsheetSource,
        documentId: 'project:current:results.csv'
      }
    }
  }
  const workspace = new DocumentWorkspace(spreadsheetLoader)
  const first = await workspace.open(spreadsheetSource, 'preview')
  const second = await workspace.open(spreadsheetSource, 'edit')
  const state = workspace.getSnapshot()

  assert.equal(first, second)
  assert.equal(Object.keys(state.tabs).length, 1)
  assert.equal(state.tabs[first].viewKind, 'edit')
})

function officeLoader(): DocumentLoader {
  return {
    async load(requested): Promise<LoadedDocument> {
      const markdown = requested.path.endsWith('.md')
      return {
        documentId: `project:current:${requested.path}`,
        source: requested,
        viewer: markdown ? 'markdown' : requested.path.endsWith('.xlsx') ? 'spreadsheet' : 'office',
        processor: requested.path.endsWith('.xlsx') ? 'xlsx' : null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: false,
          can_diff: false,
          pending: []
        },
        revision: `sha256:${requested.path}`,
        mediaType: markdown
          ? 'text/markdown'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentKind: markdown ? 'text' : 'binary',
        bytes: markdown ? new TextEncoder().encode('# Notes') : new Uint8Array([1, 2, 3])
      }
    },
    async commit(_source, _bytes, revision) {
      return { ok: true, revision }
    }
  }
}

test('opening another Office-family document replaces the clean owner', async () => {
  const workspace = new DocumentWorkspace(officeLoader())
  const first = await workspace.open({ kind: 'project', path: 'first.docx' }, 'edit')
  const second = await workspace.open({ kind: 'project', path: 'second.xlsx' }, 'edit')
  const state = workspace.getSnapshot()

  assert.equal(state.tabs[first], undefined)
  assert.ok(state.tabs[second])
  assert.equal(Object.values(state.sessions).filter((session) => (
    session.viewer === 'office' || session.viewer === 'spreadsheet'
  )).length, 1)
})

test('Office-family replacement stays on the current owner until the candidate is loaded', async () => {
  let releaseCandidate: (() => void) | undefined
  const candidateGate = new Promise<void>((resolve) => { releaseCandidate = resolve })
  const base = officeLoader()
  const deferredLoader: DocumentLoader = {
    ...base,
    async load(requested) {
      if (requested.path === 'second.xlsx') await candidateGate
      return base.load(requested)
    }
  }
  const workspace = new DocumentWorkspace(deferredLoader)
  const first = await workspace.open({ kind: 'project', path: 'first.docx' }, 'edit')
  const opening = workspace.open({ kind: 'project', path: 'second.xlsx' }, 'edit')

  assert.deepEqual(Object.keys(workspace.getSnapshot().tabs), [first])
  assert.equal(workspace.getSnapshot().focusedTabId, first)
  assert.deepEqual(workspace.getSnapshot().pendingExclusiveOpen, { requestId: 2, ownerTabId: first })

  releaseCandidate?.()
  const second = await opening
  const state = workspace.getSnapshot()
  assert.deepEqual(Object.keys(state.tabs), [second])
  assert.equal(state.focusedTabId, second)
  assert.equal(state.pendingExclusiveOpen, null)
})

test('the latest Office-family request wins when candidate loads finish out of order', async () => {
  const releases = new Map<string, () => void>()
  const base = officeLoader()
  const deferredLoader: DocumentLoader = {
    ...base,
    async load(requested) {
      if (requested.path !== 'first.docx') {
        await new Promise<void>((resolve) => { releases.set(requested.path, resolve) })
      }
      return base.load(requested)
    }
  }
  const workspace = new DocumentWorkspace(deferredLoader)
  await workspace.open({ kind: 'project', path: 'first.docx' }, 'edit')
  const secondOpening = workspace.open({ kind: 'project', path: 'second.xlsx' }, 'edit')
  const thirdOpening = workspace.open({ kind: 'project', path: 'third.pptx' }, 'edit')

  assert.deepEqual(workspace.getSnapshot().pendingExclusiveOpen, {
    requestId: 3,
    ownerTabId: workspace.getSnapshot().focusedTabId
  })

  releases.get('third.pptx')?.()
  const third = await thirdOpening
  releases.get('second.xlsx')?.()
  await secondOpening

  const state = workspace.getSnapshot()
  assert.deepEqual(Object.keys(state.tabs), [third])
  assert.equal(state.sessions[state.tabs[third].sessionId].source.path, 'third.pptx')
  assert.equal(state.pendingExclusiveOpen, null)
})

test('canceling a dirty Office replacement keeps the original owner', async () => {
  const workspace = new DocumentWorkspace(officeLoader())
  const first = await workspace.open({ kind: 'project', path: 'first.docx' }, 'edit')
  const firstSession = workspace.getSnapshot().tabs[first].sessionId
  workspace.setExternalDirty(firstSession, true)
  const candidate = await workspace.open({ kind: 'project', path: 'second.docx' }, 'edit')

  assert.deepEqual(workspace.getSnapshot().pendingClose, { tabId: first, sessionId: firstSession })
  await workspace.resolveClose('cancel')
  const state = workspace.getSnapshot()
  assert.ok(state.tabs[first])
  assert.equal(state.tabs[candidate], undefined)
  assert.equal(state.focusedTabId, first)
})

test('the registry replaces a clean Office owner across project workspaces', async () => {
  const registry = new DocumentWorkspaceRegistry(officeLoader())
  const firstWorkspace = registry.forProject('first-project')
  const secondWorkspace = registry.forProject('second-project')
  await firstWorkspace.open({ kind: 'project', project: 'first-project', path: 'first.docx' }, 'edit')
  await secondWorkspace.open({ kind: 'project', project: 'second-project', path: 'second.docx' }, 'edit')

  assert.equal(Object.keys(firstWorkspace.getSnapshot().tabs).length, 0)
  assert.equal(Object.keys(secondWorkspace.getSnapshot().tabs).length, 1)
})

test('the registry rejects a cross-project Office replacement while the owner is dirty', async () => {
  const registry = new DocumentWorkspaceRegistry(officeLoader())
  const firstWorkspace = registry.forProject('first-project')
  const secondWorkspace = registry.forProject('second-project')
  const owner = await firstWorkspace.open(
    { kind: 'project', project: 'first-project', path: 'first.docx' },
    'edit'
  )
  firstWorkspace.setExternalDirty(firstWorkspace.getSnapshot().tabs[owner].sessionId, true)
  const candidate = await secondWorkspace.open(
    { kind: 'project', project: 'second-project', path: 'second.docx' },
    'edit'
  )

  assert.ok(firstWorkspace.getSnapshot().tabs[owner])
  assert.equal(secondWorkspace.getSnapshot().tabs[candidate], undefined)
})

test('Office-family tabs reject every layout relocation API', async () => {
  const workspace = new DocumentWorkspace(officeLoader())
  const office = await workspace.open({ kind: 'project', path: 'report.docx' }, 'edit')
  const markdown = await workspace.open({ kind: 'project', path: 'notes.md' }, 'edit')

  assert.equal(workspace.canRelocateTab(office), false)
  assert.equal(workspace.canSplitTab(office, 'right', false), false)
  assert.deepEqual(workspace.moveTargetsForTab(office), [])
  assert.equal(workspace.reorderTab(office, markdown, 'after'), false)
  assert.equal(await workspace.moveTabToTab(office, markdown, 'before'), false)
})

test('explicit conflict overwrite retries with the latest revision and closes the tab', async () => {
  let revision = 'sha256:initial'
  let commits = 0
  const conflictLoader: DocumentLoader = {
    ...loader(),
    async load(requested) {
      const loaded = await loader().load(requested)
      assert.ok(loaded)
      return { ...loaded, revision }
    },
    async commit(_source, _bytes, expectedRevision) {
      commits += 1
      if (expectedRevision !== revision) return { ok: false, error: 'conflict' }
      revision = 'sha256:overwritten'
      return { ok: true, revision }
    }
  }
  const workspace = new DocumentWorkspace(conflictLoader)
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Local\n')
  revision = 'sha256:external'
  workspace.requestClose(tabId)
  await workspace.resolveClose('save')
  assert.equal(workspace.getSnapshot().sessions[sessionId].saveState, 'conflict')
  assert.ok(workspace.getSnapshot().pendingClose)

  await workspace.resolveClose('overwrite')
  assert.equal(commits, 2)
  assert.equal(workspace.getSnapshot().tabs[tabId], undefined)
})

test('failed save keeps the close decision available so discard can finish closing', async () => {
  const workspace = new DocumentWorkspace({
    ...loader(),
    async commit() {
      return { ok: false, error: 'failed' }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Changed\n')
  workspace.requestClose(tabId)

  await workspace.resolveClose('save')
  assert.deepEqual(workspace.getSnapshot().pendingClose, { tabId, sessionId })
  assert.equal(workspace.getSnapshot().sessions[sessionId].saveState, 'error')

  await workspace.resolveClose('discard')
  assert.equal(workspace.getSnapshot().tabs[tabId], undefined)
})

test('selection presentation is isolated by tab and exposed only for the focused tab', async () => {
  const workspace = new DocumentWorkspace(loader())
  const previewId = await workspace.open(source, 'preview')
  const editId = await workspace.splitTab(previewId, 'right', false)
  assert.ok(editId)
  const sessionId = workspace.getSnapshot().tabs[previewId].sessionId
  const session = workspace.getSnapshot().sessions[sessionId]

  workspace.focusTab(previewId)
  workspace.setSelection(previewId, textSelection(sessionId, session.revision), viewport)

  const selected = workspace.getSnapshot()
  assert.equal(selected.sessions[sessionId].selection?.text, 'Draft')
  assert.equal(selected.selectionPresentations[previewId]?.tabId, previewId)
  assert.equal(selected.selectionPresentations[editId], undefined)
  assert.equal(focusedSelectionPresentation(selected)?.tab.id, previewId)
  assert.equal(focusedSelectionPresentation(selected)?.presentation.point.x, 110)
  assert.equal(focusedSelectionPresentation(selected)?.presentation.visible, false)

  workspace.focusTab(editId)
  assert.equal(focusedSelectionPresentation(workspace.getSnapshot()), null)
  assert.ok(workspace.getSnapshot().selectionPresentations[previewId])

  workspace.setSelection(editId, textSelection(sessionId, session.revision), viewport)
  assert.ok(workspace.getSnapshot().selectionPresentations[previewId])
  assert.ok(workspace.getSnapshot().selectionPresentations[editId])
  workspace.focusTab(previewId)
  assert.equal(focusedSelectionPresentation(workspace.getSnapshot())?.tab.id, previewId)

  workspace.setSelection(editId, textSelection(sessionId, session.revision, 'Different'), viewport)
  workspace.focusTab(previewId)
  assert.equal(focusedSelectionPresentation(workspace.getSnapshot()), null)
  assert.ok(workspace.getSnapshot().selectionPresentations[previewId])
})

test('selection clear removes the shared semantic anchor and every tab presentation for its session', async () => {
  const workspace = new DocumentWorkspace(loader())
  const previewId = await workspace.open(source, 'preview')
  const editId = await workspace.splitTab(previewId, 'right', false)
  assert.ok(editId)
  const sessionId = workspace.getSnapshot().tabs[previewId].sessionId
  const session = workspace.getSnapshot().sessions[sessionId]

  workspace.setSelection(previewId, textSelection(sessionId, session.revision), viewport)
  workspace.setSelection(editId, textSelection(sessionId, session.revision, 'Draft'), viewport)
  workspace.setSelection(editId, null)

  const state = workspace.getSnapshot()
  assert.equal(state.sessions[sessionId].selection, null)
  assert.equal(state.selectionPresentations[previewId], undefined)
  assert.equal(state.selectionPresentations[editId], undefined)
})

test('content changes invalidate semantic selection and discard viewport presentation', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const session = workspace.getSnapshot().sessions[sessionId]

  workspace.setSelection(tabId, textSelection(sessionId, session.revision), viewport)
  workspace.updateText(sessionId, '# Changed\n')

  const state = workspace.getSnapshot()
  assert.equal(state.sessions[sessionId].selection?.status, 'stale')
  assert.equal(state.selectionPresentations[tabId], undefined)
  assert.equal(focusedSelectionPresentation(state), null)
})

test('save invalidates the pre-commit selection revision and clears its presentation', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Changed\n')
  const dirty = workspace.getSnapshot().sessions[sessionId]
  workspace.setSelection(tabId, textSelection(sessionId, dirty.revision, 'Changed'), viewport)

  assert.equal(await workspace.save(sessionId), true)

  const state = workspace.getSnapshot()
  assert.equal(state.sessions[sessionId].selection?.status, 'stale')
  assert.equal(state.selectionPresentations[tabId], undefined)
  assert.notEqual(state.sessions[sessionId].revision, dirty.revision)
})

test('closing one projection removes only its presentation while the session anchor survives', async () => {
  const workspace = new DocumentWorkspace(loader())
  const previewId = await workspace.open(source, 'preview')
  const editId = await workspace.splitTab(previewId, 'right', false)
  assert.ok(editId)
  const sessionId = workspace.getSnapshot().tabs[previewId].sessionId
  const session = workspace.getSnapshot().sessions[sessionId]
  workspace.focusTab(previewId)
  workspace.setSelection(previewId, textSelection(sessionId, session.revision), viewport)

  workspace.requestClose(previewId)

  const state = workspace.getSnapshot()
  assert.equal(state.tabs[previewId], undefined)
  assert.ok(state.tabs[editId])
  assert.ok(state.sessions[sessionId].selection)
  assert.equal(state.selectionPresentations[previewId], undefined)
  assert.equal(focusedSelectionPresentation(state), null)
})

test('moving a tab across areas preserves the document session', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const target = findLeaf(workspace.getSnapshot().layout.areas.secondary, 'secondary-root')
  assert.ok(target)
  assert.equal(await workspace.moveTab(tabId, 'secondary', target.id, 'center'), true)
  const moved = workspace.getSnapshot()
  assert.equal(findLeaf(moved.layout.areas.secondary, target.id)?.tabIds.includes(tabId), true)
  assert.equal(moved.tabs[tabId].sessionId, sessionId)
  assert.ok(moved.sessions[sessionId])
})

test('reordering tabs stays within one leaf and preserves the active tab', async () => {
  const workspace = new DocumentWorkspace(loader())
  const first = await workspace.open({ ...source, path: 'notes/first.md' }, 'edit')
  const second = await workspace.open({ ...source, path: 'notes/second.md' }, 'edit')
  const third = await workspace.open({ ...source, path: 'notes/third.md' }, 'edit')
  const leaf = findLeaf(workspace.getSnapshot().layout.areas.primary, 'primary-root')
  assert.ok(leaf)
  assert.deepEqual(leaf.tabIds, [first, second, third])

  assert.equal(workspace.reorderTab(first, third, 'after'), true)
  let state = workspace.getSnapshot()
  assert.deepEqual(findLeaf(state.layout.areas.primary, 'primary-root')?.tabIds, [second, third, first])
  assert.equal(findLeaf(state.layout.areas.primary, 'primary-root')?.activeTabId, third)
  assert.equal(state.focusedTabId, third)

  assert.equal(workspace.reorderTab(first, second, 'before'), true)
  state = workspace.getSnapshot()
  assert.deepEqual(findLeaf(state.layout.areas.primary, 'primary-root')?.tabIds, [first, second, third])
  assert.equal(findLeaf(state.layout.areas.primary, 'primary-root')?.activeTabId, third)
  assert.equal(state.focusedTabId, third)
  assert.equal(workspace.reorderTab(first, first, 'before'), false)
})

test('reordering rejects a target in another leaf', async () => {
  const workspace = new DocumentWorkspace(loader())
  const first = await workspace.open({ ...source, path: 'notes/first.md' }, 'edit')
  const second = await workspace.open({ ...source, path: 'notes/second.md' }, 'edit')
  assert.ok(await workspace.splitTab(second, 'right', true))

  assert.equal(workspace.reorderTab(first, second, 'before'), false)
})

test('moving a tab onto a tab in another leaf preserves the requested insertion position', async () => {
  const workspace = new DocumentWorkspace(loader())
  const leftFirst = await workspace.open({ ...source, path: 'notes/left-first.md' }, 'edit')
  const rightFirst = await workspace.open({ ...source, path: 'notes/right-first.md' }, 'edit')
  assert.ok(await workspace.splitTab(rightFirst, 'right', true))
  const rightSecond = await workspace.open({ ...source, path: 'notes/right-second.md' }, 'edit')
  const before = workspace.getSnapshot()
  const rightLocation = before.focusedLeaf
  assert.ok(rightLocation)
  const rightLeaf = findLeaf(before.layout.areas[rightLocation.area], rightLocation.leafId)
  assert.ok(rightLeaf?.tabIds.includes(rightFirst))
  assert.ok(rightLeaf?.tabIds.includes(rightSecond))

  assert.equal(await workspace.moveTabToTab(leftFirst, rightSecond, 'before'), true)
  const moved = workspace.getSnapshot()
  const targetLeaf = findLeaf(moved.layout.areas[rightLocation.area], rightLocation.leafId)
  assert.deepEqual(targetLeaf?.tabIds, [rightFirst, leftFirst, rightSecond])
  assert.equal(targetLeaf?.activeTabId, leftFirst)
  assert.equal(moved.focusedTabId, leftFirst)
})

test('closing only the last dirty view requires an explicit choice', async () => {
  const workspace = new DocumentWorkspace(loader())
  const previewId = await workspace.open(source, 'preview')
  const editId = await workspace.splitTab(previewId, 'right', false)
  assert.ok(editId)
  workspace.setTabView(editId, 'edit')
  const sessionId = workspace.getSnapshot().tabs[editId].sessionId
  workspace.updateText(sessionId, '# Changed\n')

  workspace.requestClose(editId)
  assert.equal(workspace.getSnapshot().pendingClose, null)
  assert.ok(workspace.getSnapshot().sessions[sessionId])

  workspace.requestClose(previewId)
  assert.deepEqual(workspace.getSnapshot().pendingClose, { tabId: previewId, sessionId })
  await workspace.resolveClose('cancel')
  assert.ok(workspace.getSnapshot().tabs[previewId])

  workspace.requestClose(previewId)
  await workspace.resolveClose('discard')
  assert.equal(workspace.getSnapshot().sessions[sessionId], undefined)
})

test('tab close scopes follow the selected tab order', () => {
  const tabIds = ['left-a', 'left-b', 'selected', 'right-a', 'right-b']
  assert.deepEqual(tabIdsForClose(tabIds, 'selected', 'current'), ['selected'])
  assert.deepEqual(tabIdsForClose(tabIds, 'selected', 'others'), ['left-a', 'left-b', 'right-a', 'right-b'])
  assert.deepEqual(tabIdsForClose(tabIds, 'selected', 'left'), ['left-a', 'left-b'])
  assert.deepEqual(tabIdsForClose(tabIds, 'selected', 'right'), ['right-a', 'right-b'])
  assert.deepEqual(tabIdsForClose(tabIds, 'selected', 'all'), tabIds)
  assert.deepEqual(tabIdsForClose(tabIds, 'missing', 'all'), [])
})

test('bulk close removes clean tabs and confirms dirty documents in order', async () => {
  const workspace = new DocumentWorkspace(loader())
  const cleanId = await workspace.open({ ...source, path: 'notes/clean.md' }, 'edit')
  const firstDirtyId = await workspace.open({ ...source, path: 'notes/first.md' }, 'edit')
  const secondDirtyId = await workspace.open({ ...source, path: 'notes/second.md' }, 'edit')
  const firstSessionId = workspace.getSnapshot().tabs[firstDirtyId].sessionId
  const secondSessionId = workspace.getSnapshot().tabs[secondDirtyId].sessionId
  workspace.updateText(firstSessionId, '# First changed\n')
  workspace.updateText(secondSessionId, '# Second changed\n')

  workspace.requestCloseTabs([cleanId, firstDirtyId, secondDirtyId])
  assert.equal(workspace.getSnapshot().tabs[cleanId], undefined)
  assert.deepEqual(workspace.getSnapshot().pendingClose, {
    tabId: firstDirtyId,
    sessionId: firstSessionId
  })

  await workspace.resolveClose('discard')
  assert.equal(workspace.getSnapshot().tabs[firstDirtyId], undefined)
  assert.deepEqual(workspace.getSnapshot().pendingClose, {
    tabId: secondDirtyId,
    sessionId: secondSessionId
  })

  await workspace.resolveClose('cancel')
  assert.ok(workspace.getSnapshot().tabs[secondDirtyId])
  assert.equal(workspace.getSnapshot().pendingClose, null)
})

test('binary editor save delegate supplies bytes before the shared CAS commit', async () => {
  let committed = new Uint8Array()
  const officeSource = { kind: 'project' as const, path: 'draft.docx' }
  const officeLoader: DocumentLoader = {
    async load() {
      return {
        documentId: 'project:current:draft.docx',
        source: officeSource,
        viewer: 'office',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:office-initial',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([1, 2, 3])
      }
    },
    async commit(_source, bytes) {
      committed = new Uint8Array(bytes)
      return { ok: true, revision: 'sha256:office-saved' }
    }
  }
  const workspace = new DocumentWorkspace(officeLoader)
  const tabId = await workspace.open(officeSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.setExternalDirty(sessionId, true)
  workspace.registerSaveDelegate(sessionId, async () => new Uint8Array([4, 5, 6]))

  assert.equal(await workspace.save(sessionId), true)
  assert.deepEqual(Array.from(committed), [4, 5, 6])
  assert.equal(workspace.getSnapshot().sessions[sessionId].dirty, false)
})

test('save delegate prepares the latest editor snapshot before the commit boundary', async () => {
  let committed = ''
  const workspace = new DocumentWorkspace({
    ...loader(),
    async commit(_source, bytes) {
      committed = new TextDecoder().decode(bytes)
      return { ok: true, revision: 'sha256:prepared' }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Observed before editor flush\n')
  workspace.registerSaveDelegate(sessionId, {
    prepare: () => workspace.updateText(sessionId, '# Latest editor snapshot\n'),
    serialize: async () => new TextEncoder().encode('# Latest editor snapshot\n')
  })

  assert.equal(await workspace.save(sessionId), true)
  assert.equal(committed, '# Latest editor snapshot\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].savedText, '# Latest editor snapshot\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].dirty, false)
})

test('save delegate awaits save-only formatting before capturing the committed text', async () => {
  let releaseFormat!: () => void
  const formatting = new Promise<void>((resolve) => { releaseFormat = resolve })
  let committed = ''
  const workspace = new DocumentWorkspace({
    ...loader(),
    async commit(_source, bytes) {
      committed = new TextDecoder().decode(bytes)
      return { ok: true, revision: 'sha256:formatted' }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  let editorText = '# unformatted'
  workspace.updateText(sessionId, editorText)
  workspace.registerSaveDelegate(sessionId, {
    prepare: () => workspace.updateText(sessionId, editorText),
    beforeSave: async () => {
      await formatting
      editorText = '# Formatted\n'
    },
    serialize: async () => new TextEncoder().encode(editorText)
  })

  const saving = workspace.save(sessionId)
  await Promise.resolve()
  assert.equal(committed, '')
  releaseFormat()

  assert.equal(await saving, true)
  assert.equal(committed, '# Formatted\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].savedText, '# Formatted\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].dirty, false)
})

test('save-only formatting does not run for a clean document', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  let formats = 0
  workspace.registerSaveDelegate(sessionId, {
    prepare: () => {},
    beforeSave: async () => { formats += 1 },
    serialize: async () => new TextEncoder().encode('# Draft\n')
  })

  assert.equal(await workspace.save(sessionId), true)
  assert.equal(formats, 0)
})

test('successful user save refreshes the pending snapshot projection once', async () => {
  const base = loader()
  let capabilityLoads = 0
  const savedVersioning = {
    ...managedVersioning,
    snapshot_state: 'pending' as const,
    working_revision: 'sha256:saved-2',
    disk_revision: 'sha256:saved-2'
  }
  const workspace = new DocumentWorkspace({
    ...base,
    async load(requested) {
      const loaded = await base.load(requested)
      assert.ok(loaded)
      return { ...loaded, versioning: managedVersioning }
    },
    async versioning() {
      capabilityLoads += 1
      return savedVersioning
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Save working snapshot\n')

  assert.equal(await workspace.save(sessionId), true)
  assert.equal(capabilityLoads, 1)
  assert.equal(workspace.getSnapshot().sessions[sessionId].versioning?.version_id, managedVersioning.version_id)
  assert.equal(workspace.getSnapshot().sessions[sessionId].versioning?.snapshot_state, 'pending')
  assert.equal(workspace.getSnapshot().sessions[sessionId].versioning?.working_revision, 'sha256:saved-2')
})

test('a change made while CAS save is in flight stays dirty after the older snapshot commits', async () => {
  let releaseCommit!: () => void
  const pendingCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
  const delayedLoader: DocumentLoader = {
    ...loader(),
    async commit() {
      await pendingCommit
      return { ok: true, revision: 'sha256:saved-first-change' }
    }
  }
  const workspace = new DocumentWorkspace(delayedLoader)
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# First change\n')

  const saving = workspace.save(sessionId)
  await Promise.resolve()
  workspace.updateText(sessionId, '# Second change\n')
  releaseCommit()

  assert.equal(await saving, true)
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.equal(session.text, '# Second change\n')
  assert.equal(session.savedText, '# First change\n')
  assert.equal(session.dirty, true)
  assert.equal(session.saveState, 'dirty')
})

test('concurrent saves for one document share a single CAS transaction', async () => {
  let commits = 0
  let releaseCommit!: () => void
  const pendingCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
  const workspace = new DocumentWorkspace({
    ...loader(),
    async commit() {
      commits += 1
      await pendingCommit
      return { ok: true, revision: 'sha256:single-flight' }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Saved once\n')

  const first = workspace.save(sessionId)
  const second = workspace.save(sessionId)
  await Promise.resolve()
  assert.equal(commits, 1)
  releaseCommit()

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].revision, 'sha256:single-flight')
  assert.equal(workspace.getSnapshot().sessions[sessionId].saveState, 'clean')
})

test('the resolved project identity from open is retained for later saves', async () => {
  const requested = { kind: 'project' as const, path: 'notes/readme.md' }
  const canonical = { ...requested, project: 'project-resolved' }
  let committedProject: string | null | undefined
  const workspace = new DocumentWorkspace({
    async load() {
      const loaded = await loader().load(requested)
      assert.ok(loaded)
      return {
        ...loaded,
        documentId: 'project:project-resolved:notes/readme.md',
        source: canonical
      }
    },
    async commit(committedSource, _bytes, revision) {
      committedProject = committedSource.kind === 'project' ? committedSource.project : undefined
      return { ok: true, revision }
    }
  })
  const tabId = await workspace.open(requested, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Canonical project\n')

  assert.equal(await workspace.save(sessionId), true)
  assert.equal(committedProject, 'project-resolved')
})

test('an Office change made while its save delegate is serializing stays dirty', async () => {
  let releaseSerialization!: (bytes: Uint8Array) => void
  const serialized = new Promise<Uint8Array>((resolve) => { releaseSerialization = resolve })
  const officeSource = { kind: 'project' as const, path: 'draft.docx' }
  const workspace = new DocumentWorkspace({
    async load() {
      return {
        documentId: 'project:draft.docx',
        source: officeSource,
        revision: 'sha256:office',
        bytes: new Uint8Array([1]),
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        viewer: 'office',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        }
      }
    },
    async commit() {
      return { ok: true, revision: 'sha256:office-saved' }
    }
  })
  const tabId = await workspace.open(officeSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.setExternalDirty(sessionId, true)
  workspace.registerSaveDelegate(sessionId, () => serialized)

  const saving = workspace.save(sessionId)
  await Promise.resolve()
  workspace.setExternalDirty(sessionId, true)
  releaseSerialization(new Uint8Array([2]))

  assert.equal(await saving, true)
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.deepEqual(Array.from(session.savedBytes), [2])
  assert.equal(session.dirty, true)
  assert.equal(session.saveState, 'dirty')
})

test('dirty Office tabs reject cross-pane moves without serializing', async () => {
  let commits = 0
  const officeSource = { kind: 'project' as const, path: 'draft.docx' }
  const officeLoader: DocumentLoader = {
    async load() {
      return {
        documentId: 'project:current:draft.docx',
        source: officeSource,
        viewer: 'office',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:office-initial',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([1, 2, 3])
      }
    },
    async commit() {
      commits += 1
      return { ok: true, revision: 'sha256:office-saved' }
    }
  }
  const workspace = new DocumentWorkspace(officeLoader)
  const tabId = await workspace.open(officeSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.setExternalDirty(sessionId, true)
  let serializations = 0
  workspace.registerSaveDelegate(sessionId, async () => {
    serializations += 1
    return new Uint8Array([4, 5, 6])
  })

  assert.equal(await workspace.moveTab(tabId, 'secondary', 'secondary-root', 'center'), false)

  const state = workspace.getSnapshot()
  assert.equal(findLeaf(state.layout.areas.secondary, 'secondary-root')?.tabIds.includes(tabId), false)
  assert.deepEqual(Array.from(state.sessions[sessionId].bytes), [1, 2, 3])
  assert.equal(state.sessions[sessionId].dirty, true)
  assert.equal(commits, 0)
  assert.equal(serializations, 0)
})

test('splitting duplicates only the tab projection and shares the document session', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'preview')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId

  const splitTabId = await workspace.splitTab(tabId, 'right', false)
  assert.ok(splitTabId)
  const state = workspace.getSnapshot()
  assert.notEqual(splitTabId, tabId)
  assert.equal(state.tabs[splitTabId].sessionId, sessionId)
  assert.equal(state.layout.areas.primary.kind, 'split')
  assert.equal(nodeTabCount(state.layout.areas.primary), 2)
  assert.equal(Object.keys(state.sessions).length, 1)
})

test('closing the focused right split restores the selected tab from the remaining left pane', async () => {
  const workspace = new DocumentWorkspace(loader())
  const leftTabId = await workspace.open(source, 'preview')
  const rightTabId = await workspace.splitTab(leftTabId, 'right', false)
  assert.ok(rightTabId)
  assert.equal(workspace.getSnapshot().focusedTabId, rightTabId)

  workspace.requestClose(rightTabId)

  const state = workspace.getSnapshot()
  assert.equal(state.layout.areas.primary.kind, 'leaf')
  assert.equal(state.focusedTabId, leftTabId)
  assert.equal(state.focusedLeaf?.leafId, state.layout.areas.primary.id)
  assert.equal(state.layout.areas.primary.activeTabId, leftTabId)
})

test('closing the only literature document does not focus an unrelated resource document', async () => {
  const workspace = new DocumentWorkspace(loader())
  const resourceTabId = await workspace.open(source, 'preview')
  const literatureTabId = await workspace.open({
    kind: 'literature',
    literatureId: 'paper-1',
    attachmentId: 'attachment-1',
    recordTarget: {
      owner: 'literature_attachment',
      scope_id: 'paper-1',
      subject_id: 'attachment-1'
    },
    path: 'papers/paper.pdf'
  }, 'preview')
  assert.equal(workspace.getSnapshot().focusedTabId, literatureTabId)

  workspace.requestClose(literatureTabId)

  const state = workspace.getSnapshot()
  assert.ok(state.tabs[resourceTabId])
  assert.equal(state.focusedTabId, null)
})

test('the same document view opens as a new projection in another focused leaf', async () => {
  const workspace = new DocumentWorkspace(loader())
  const firstTabId = await workspace.open(source, 'preview')
  const splitTabId = await workspace.splitTab(firstTabId, 'right', false)
  assert.ok(splitTabId)
  const root = workspace.getSnapshot().layout.areas.primary
  assert.equal(root.kind, 'split')
  if (root.kind !== 'split' || root.second.kind !== 'leaf') return

  workspace.focusLeaf('primary', root.second.id)
  const secondTabId = await workspace.open(source, 'edit')
  const state = workspace.getSnapshot()
  assert.notEqual(secondTabId, firstTabId)
  assert.equal(secondTabId, splitTabId)
  assert.equal(Object.keys(state.tabs).length, 2)
  assert.equal(state.tabs[secondTabId].viewKind, 'edit')
  assert.equal(state.tabs[secondTabId].sessionId, state.tabs[firstTabId].sessionId)
  assert.equal(findLeaf(state.layout.areas.primary, root.second.id)?.tabIds.includes(secondTabId), true)
})

test('splitting an editable Office tab is rejected', async () => {
  const officeSource = { kind: 'project' as const, path: 'draft.docx' }
  const workspace = new DocumentWorkspace({
    async load() {
      return {
        documentId: 'project:current:draft.docx',
        source: officeSource,
        viewer: 'office',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:office-initial',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([1, 2, 3])
      }
    },
    async commit(_source, _bytes, revision) {
      return { ok: true, revision }
    }
  })
  const editTabId = await workspace.open(officeSource, 'edit')
  const previewTabId = await workspace.splitTab(editTabId, 'right', false)
  assert.equal(previewTabId, null)
  const state = workspace.getSnapshot()
  assert.equal(state.tabs[editTabId].viewKind, 'edit')
  assert.equal(Object.keys(state.tabs).length, 1)
})

test('reopening the same Office document preserves its sole editor tab', async () => {
  const officeSource = { kind: 'project' as const, path: 'draft.docx' }
  const workspace = new DocumentWorkspace({
    async load() {
      return {
        documentId: 'project:current:draft.docx',
        source: officeSource,
        viewer: 'office',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: true,
          can_diff: false,
          pending: []
        },
        revision: 'sha256:office-initial',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([1])
      }
    },
    async commit(_source, _bytes, revision) {
      return { ok: true, revision }
    }
  })
  const editTabId = await workspace.open(officeSource, 'edit')
  const sessionId = workspace.getSnapshot().tabs[editTabId].sessionId
  workspace.setExternalDirty(sessionId, true)
  const nextEditTabId = await workspace.open(officeSource, 'edit')
  const state = workspace.getSnapshot()
  assert.equal(nextEditTabId, editTabId)
  assert.equal(state.tabs[nextEditTabId].viewKind, 'edit')
  assert.equal(state.sessions[sessionId].dirty, true)
  assert.equal(Object.keys(state.tabs).length, 1)
})

test('Markdown mode switches preserve undo, redo, revision, and save state', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const initialRevision = workspace.getSnapshot().sessions[sessionId].revision

  workspace.updateText(sessionId, '# First\n')
  workspace.setTabView(tabId, 'preview')
  workspace.updateText(sessionId, '# Second\n')
  workspace.setTabView(tabId, 'edit')
  assert.equal(workspace.undo(sessionId), true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].text, '# First\n')
  assert.equal(workspace.redo(sessionId), true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].text, '# Second\n')
  assert.equal(workspace.getSnapshot().sessions[sessionId].revision, initialRevision)
  assert.equal(await workspace.save(sessionId), true)
  assert.equal(workspace.getSnapshot().sessions[sessionId].revision, 'sha256:saved-2')
  assert.equal(workspace.getSnapshot().sessions[sessionId].saveState, 'clean')
  assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 1)
})

test('leaving Markdown visual edit prepares the latest editor snapshot', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.registerSaveDelegate(sessionId, {
    prepare: () => workspace.updateText(sessionId, '# Latest visual edit\n'),
    serialize: async () => new TextEncoder().encode('# Latest visual edit\n')
  })

  workspace.setTabView(tabId, 'preview')

  assert.equal(workspace.getSnapshot().sessions[sessionId].text, '# Latest visual edit\n')
})

test('split and move reuses the tab and empty split leaves collapse on close', async () => {
  const workspace = new DocumentWorkspace(loader())
  const firstTabId = await workspace.open(source, 'preview')
  const editTabId = await workspace.splitTab(firstTabId, 'bottom', false)
  assert.ok(editTabId)
  workspace.setTabView(editTabId, 'edit')

  assert.equal(workspace.getSnapshot().layout.areas.primary.kind, 'split')
  assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 2)

  workspace.requestClose(editTabId)
  const state = workspace.getSnapshot()
  assert.equal(state.layout.areas.primary.kind, 'leaf')
  assert.deepEqual(state.layout.areas.primary.tabIds, [firstTabId])
})

test('new files open in the leaf most recently focused by the user', async () => {
  const dynamicLoader: DocumentLoader = {
    async load(requested) {
      return {
        documentId: `project:current:${requested.path}`,
        source: requested,
        viewer: 'markdown',
        processor: null,
        capabilities: {
          can_preview: true,
          can_edit: true,
          can_select: true,
          can_annotate: false,
          can_save: true,
          can_version: false,
          can_diff: false,
          pending: []
        },
        revision: `sha256:${requested.path}`,
        mediaType: 'text/markdown',
        bytes: new TextEncoder().encode(requested.path)
      }
    },
    async commit(_source, _bytes, revision) {
      return { ok: true, revision }
    }
  }
  const workspace = new DocumentWorkspace(dynamicLoader)
  const first = await workspace.open({ kind: 'project', path: 'first.md' }, 'preview')
  const projection = await workspace.splitTab(first, 'right', false)
  assert.ok(projection)
  const root = workspace.getSnapshot().layout.areas.primary
  assert.equal(root.kind, 'split')
  if (root.kind !== 'split' || root.second.kind !== 'leaf') return

  workspace.focusLeaf('primary', root.second.id)
  const second = await workspace.open({ kind: 'project', path: 'second.md' }, 'preview')
  assert.equal(findLeaf(workspace.getSnapshot().layout.areas.primary, root.second.id)?.tabIds.includes(second), true)
  assert.equal(findLeaf(workspace.getSnapshot().layout.areas.primary, root.first.kind === 'leaf' ? root.first.id : '')?.tabIds.includes(first), true)
})

test('viewer state belongs to the tab and survives movement without dirtying the file', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'preview')
  workspace.setTabViewState(tabId, { scale: 2, page: 3 })
  const copy = await workspace.splitTab(tabId, 'right', false)
  assert.ok(copy)
  workspace.setTabViewState(copy, { scale: 1, page: 1 })
  await workspace.moveTab(tabId, 'secondary', 'secondary-root', 'center')
  assert.deepEqual(workspace.getSnapshot().tabs[tabId].viewState, { scale: 2, page: 3 })
  assert.deepEqual(workspace.getSnapshot().tabs[copy].viewState, { scale: 1, page: 1 })
  const session = workspace.getSnapshot().sessions[workspace.getSnapshot().tabs[tabId].sessionId]
  assert.equal(session.dirty, false)
  workspace.requestClose(tabId)
  assert.equal(workspace.getSnapshot().tabs[tabId], undefined)
})

const restoredFile = (overrides: Partial<RestoredProjectFile> = {}): RestoredProjectFile => ({
  fileId: 'file-notes',
  previousPath: source.path,
  path: source.path,
  state: 'present',
  ...overrides
})

test('restore reconciliation reloads clean sessions without replacing their tabs or view state', async () => {
  let revision = 'sha256:before'
  let loads = 0
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      loads += 1
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      return {
        ...loaded,
        revision,
        bytes: new TextEncoder().encode(revision === 'sha256:before' ? '# Before\n' : '# Restored\n'),
        versioning: loads === 1 ? {
          file_id: 'file-notes', version_id: revision, working_revision: revision,
          disk_revision: revision, can_version: true, can_diff: true,
          can_preview_history: true, management_state: 'managed', drifted: false, snapshot_state: 'saved', pending: null
        } : undefined
      }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  workspace.setTabViewState(tabId, { line: 4, column: 2, scrollTop: 120 })
  const before = workspace.getSnapshot()
  const sessionId = before.tabs[tabId].sessionId
  revision = 'sha256:restored'

  const result = await workspace.reconcileRestoredFiles('current', [
    restoredFile({ versionId: 'version-restored' })
  ])
  const after = workspace.getSnapshot()
  assert.deepEqual(result, { synchronized: ['file-notes'], conflicted: [], failed: [] })
  assert.equal(after.tabs[tabId].sessionId, sessionId)
  assert.deepEqual(after.tabs[tabId].viewState, { line: 4, column: 2, scrollTop: 120 })
  assert.deepEqual(after.layout, before.layout)
  assert.equal(after.focusedTabId, before.focusedTabId)
  assert.equal(after.sessions[sessionId].text, '# Restored\n')
  assert.equal(after.sessions[sessionId].revision, 'sha256:restored')
  assert.equal(after.sessions[sessionId].versioning?.disk_revision, 'sha256:restored')
  assert.equal(after.sessions[sessionId].versioning?.version_id, 'version-restored')
  assert.equal(after.sessions[sessionId].externalChange, false)
})

test('restore reconciliation keeps existing unsaved memory and enters conflict handling', async () => {
  let loads = 0
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      loads += 1
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      return {
        ...loaded,
        versioning: {
          file_id: 'file-notes', version_id: 'version-1', working_revision: loaded.revision,
          disk_revision: loaded.revision, can_version: true, can_diff: true,
          can_preview_history: true, management_state: 'managed', drifted: false, snapshot_state: 'saved', pending: null
        }
      }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# Unsaved\n')

  const result = await workspace.reconcileRestoredFiles('current', [restoredFile()])
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.deepEqual(result, { synchronized: [], conflicted: ['file-notes'], failed: [] })
  assert.equal(loads, 1)
  assert.equal(session.text, '# Unsaved\n')
  assert.equal(session.dirty, true)
  assert.equal(session.saveState, 'conflict')
})

test('restore reload never overwrites an edit made while disk content is loading', async () => {
  let loadCount = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      loadCount += 1
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      if (loadCount > 1) await pending
      return {
        ...loaded,
        revision: loadCount > 1 ? 'sha256:restored' : 'sha256:before',
        bytes: new TextEncoder().encode(loadCount > 1 ? '# Restored\n' : '# Before\n'),
        versioning: {
          file_id: 'file-notes', version_id: 'version-1', working_revision: loaded.revision,
          disk_revision: loaded.revision, can_version: true, can_diff: true,
          can_preview_history: true, management_state: 'managed', drifted: false, snapshot_state: 'saved', pending: null
        }
      }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  const synchronizing = workspace.reconcileRestoredFiles('current', [restoredFile()])
  await Promise.resolve()
  workspace.updateText(sessionId, '# Edited during reload\n')
  release()

  const result = await synchronizing
  const session = workspace.getSnapshot().sessions[sessionId]
  assert.deepEqual(result, { synchronized: [], conflicted: ['file-notes'], failed: [] })
  assert.equal(session.text, '# Edited during reload\n')
  assert.equal(session.saveState, 'conflict')
})

test('Delivery reconciliation refreshes every restored open file in one workspace', async () => {
  const revisions = new Map([
    ['a.md', 'sha256:a-before'],
    ['b.md', 'sha256:b-before']
  ])
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      const path = requested.path
      const revision = revisions.get(path) ?? `sha256:${path}`
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      return {
        ...loaded,
        revision,
        bytes: new TextEncoder().encode(revision),
        versioning: {
          file_id: `file-${path}`, version_id: revision, working_revision: revision,
          disk_revision: revision, can_version: true, can_diff: true,
          can_preview_history: true, management_state: 'managed', drifted: false, snapshot_state: 'saved', pending: null
        }
      }
    }
  })
  const tabA = await workspace.open({ kind: 'project', path: 'a.md' }, 'edit')
  const tabB = await workspace.open({ kind: 'project', path: 'b.md' }, 'edit')
  revisions.set('a.md', 'sha256:a-restored')
  revisions.set('b.md', 'sha256:b-restored')

  const result = await workspace.reconcileRestoredFiles('current', [
    restoredFile({ fileId: 'file-a.md', previousPath: 'a.md', path: 'a.md' }),
    restoredFile({ fileId: 'file-b.md', previousPath: 'b.md', path: 'b.md' })
  ])
  const state = workspace.getSnapshot()
  assert.deepEqual(result, {
    synchronized: ['file-a.md', 'file-b.md'], conflicted: [], failed: []
  })
  assert.equal(state.sessions[state.tabs[tabA].sessionId].revision, 'sha256:a-restored')
  assert.equal(state.sessions[state.tabs[tabB].sessionId].revision, 'sha256:b-restored')
})

test('tombstone restore keeps the open tab and history available while clearing disk content', async () => {
  const workspace = new DocumentWorkspace({
    ...loader(),
    async load(requested) {
      const loaded = await loader().load(requested)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      return {
        ...loaded,
        versioning: {
          file_id: 'file-notes', version_id: 'version-present',
          working_revision: loaded.revision, disk_revision: loaded.revision,
          can_version: true, can_diff: true, can_preview_history: true,
          management_state: 'managed', drifted: false, snapshot_state: 'saved', pending: null
        }
      }
    }
  })
  const tabId = await workspace.open(source, 'edit')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId

  const result = await workspace.reconcileRestoredFiles('current', [
    restoredFile({ state: 'tombstone', versionId: 'version-deleted' })
  ])
  const state = workspace.getSnapshot()
  const session = state.sessions[sessionId]
  assert.deepEqual(result, { synchronized: ['file-notes'], conflicted: [], failed: [] })
  assert.ok(state.tabs[tabId])
  assert.equal(session.loadState, 'ready')
  assert.equal(session.deleted, true)
  assert.equal(session.text, '')
  assert.equal(session.versioning?.can_preview_history, true)
  assert.equal(session.versioning?.can_version, false)
  assert.equal(session.versioning?.version_id, 'version-deleted')
})

test('attachment citations reuse the source tab across handles and distinguish same-name files', async () => {
  const dependencies = loader()
  const originalLoad = dependencies.load
  dependencies.load = async requested => {
    const loaded = await originalLoad(requested)
    return loaded && { ...loaded, source: requested, revision: requested.kind === 'session-file' && requested.path.includes('second-paper') ? 'sha256:different' : 'sha256:initial', documentId: documentIdFor(requested), viewer: 'pdf' }
  }
  const workspace = new DocumentWorkspace(dependencies)
  const citation = {
    handle: 'first', project_id: '', path: 'paper.pdf', title: 'paper.pdf',
    revision: 'sha256:initial', quote: 'Original text', version_bound: true,
    state: 'exact' as const, source_kind: 'attachment', source_id: 'attachments/first-paper.pdf',
    source_session_id: 'session', answer_id: 'answer', answer_revision: 'answer-revision',
    content_level: 'fulltext', pages: [{ page: 1, quads: [[0.2, 0.5, 0.8, 0.6]] }], matches: [],
    presentation: { version: 1, mode: 'structured_text' as const, precision: 'region' as const, text: 'Original text', quality_reasons: [], manual_check: false }
  }
  const first = await workspace.revealCitation(citation, { pages: citation.pages })
  const second = await workspace.revealCitation({ ...citation, handle: 'second' }, { pages: [{ ...citation.pages[0], page: 7 }] })
  assert.equal(second, first)
  assert.equal(workspace.getSnapshot().tabs[first].viewState?.page, 7)
  const library = await workspace.revealCitation({ ...citation, handle: 'library', source_kind: 'literature', source_id: 'literature:paper' }, { pages: [{ ...citation.pages[0], page: 4 }] })
  assert.equal(library, first)
  assert.equal(workspace.getSnapshot().tabs[first].viewState?.page, 4)
  const other = await workspace.revealCitation({ ...citation, handle: 'third', revision: 'sha256:different', source_id: 'attachments/second-paper.pdf' }, { pages: citation.pages })
  assert.notEqual(other, first)
  assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 2)
})

test('literature citations carry the cited attachment annotation owner into the opened PDF', async () => {
  const dependencies = loader()
  const originalLoad = dependencies.load
  dependencies.load = async requested => {
    const loaded = await originalLoad(requested)
    return loaded && { ...loaded, source: requested, revision: 'sha256:initial', documentId: documentIdFor(requested), viewer: 'pdf' }
  }
  const workspace = new DocumentWorkspace(dependencies)
  const recordTarget = { owner: 'literature_attachment' as const, scope_id: 'paper', subject_id: 'primary-pdf' }
  const tabId = await workspace.revealCitation({
    handle: 'library', project_id: 'project', path: 'paper.pdf', title: 'Paper',
    revision: 'sha256:initial', quote: 'Original text', version_bound: true,
    state: 'exact' as const, source_kind: 'literature', source_id: 'paper', record_target: recordTarget,
    source_session_id: 'session', answer_id: 'answer', answer_revision: 'answer-revision',
    content_level: 'fulltext', pages: [{ page: 2, quads: [[0.2, 0.5, 0.8, 0.6]] }], matches: [],
    presentation: { version: 1, mode: 'structured_text' as const, precision: 'region' as const, text: 'Original text', quality_reasons: [], manual_check: false }
  })
  const state = workspace.getSnapshot()
  const opened = state.sessions[state.tabs[tabId].sessionId].source
  assert.equal(opened.kind, 'session-file')
  assert.deepEqual(recordTargetFor(opened), recordTarget)
})

test('citation preview has independent page state and rejects changed source bytes', async () => {
  const main = new DocumentWorkspace(loader())
  await main.open(source, 'edit')
  const before = main.getSnapshot()
  const preview = new DocumentWorkspace(loader())
  const citation = {
    handle: 'read-handle', project_id: 'project', path: 'paper.pdf', title: 'Paper',
    revision: 'sha256:initial', quote: 'Original text', version_bound: true,
    state: 'exact' as const, source_kind: 'file', source_id: 'paper.pdf', content_level: 'fulltext',
    pages: [{ page: 3, quads: [[0.2, 0.5, 0.8, 0.6]] }], matches: [],
    presentation: { version: 1, mode: 'structured_text' as const, precision: 'region' as const, text: 'Original text', quality_reasons: [], manual_check: false }
  }
  const tabId = await preview.revealCitation(citation, { pages: citation.pages })
  assert.equal(preview.getSnapshot().tabs[tabId].viewState?.page, 3)
  assert.equal(main.getSnapshot(), before)
  await assert.rejects(preview.revealCitation({ ...citation, revision: 'sha256:changed' }), /source_revision_changed/)
})

test('PDF citation reuse is scoped, version-bound and preserves the project annotation owner in both orders', async () => {
  const dependencies = loader()
  const originalLoad = dependencies.load
  dependencies.load = async requested => {
    const loaded = await originalLoad(requested)
    return loaded && { ...loaded, source: requested, documentId: documentIdFor(requested), viewer: 'pdf' }
  }
  const citation = {
    handle: 'attachment', project_id: '', scope_project_id: 'project', path: 'paper.pdf', title: 'paper.pdf',
    revision: 'sha256:initial', quote: 'Original text', version_bound: true,
    state: 'exact' as const, source_kind: 'attachment', source_id: 'attachments/paper.pdf',
    source_session_id: 'session', answer_id: 'answer', answer_revision: 'answer-revision',
    content_level: 'fulltext', pages: [{ page: 1, quads: [[0.2, 0.5, 0.8, 0.6]] }], matches: [],
    presentation: { version: 1, mode: 'structured_text' as const, precision: 'region' as const, text: 'Original text', quality_reasons: [], manual_check: false }
  }
  const projectCitation = { ...citation, source_kind: 'file', project_id: 'project', path: 'resources/paper.pdf' }
  for (const attachmentFirst of [true, false]) {
    const workspace = new DocumentWorkspace(dependencies)
    const first = await workspace.revealCitation(attachmentFirst ? citation : projectCitation, { pages: citation.pages })
    const second = await workspace.revealCitation(attachmentFirst ? projectCitation : citation, { pages: citation.pages })
    assert.equal(first, second)
    assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 1)
    const session = workspace.getSnapshot().sessions[workspace.getSnapshot().tabs[first].sessionId]
    assert.deepEqual(session.source, { kind: 'project', project: 'project', path: 'resources/paper.pdf' })
    const repeated = await Promise.all([workspace.revealCitation(citation), workspace.revealCitation(citation)])
    assert.deepEqual(repeated, [first, first])
    assert.notEqual(await workspace.revealCitation({ ...citation, scope_project_id: 'other' }), first)
  }
  const workspace = new DocumentWorkspace(dependencies)
  const attachment = { kind: 'session-file' as const, sessionId: 'session', path: citation.source_id }
  const first = await workspace.open(attachment, 'preview')
  const imported = await workspace.openImported({ kind: 'project', project: 'project', path: projectCitation.path }, attachment)
  assert.equal(first, imported)
  assert.equal(Object.keys(workspace.getSnapshot().sessions).length, 1)
  const separate = await workspace.open({ kind: 'project', project: 'project', path: 'resources/copy.pdf' }, 'edit')
  assert.notEqual(separate, imported)
})


test('fallback tab titles change language without reopening or changing document state', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit', '', undefined, 'untitledArtifact')
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# unsaved draft')
  const before = workspace.getSnapshot()
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: {
    zh: { conversation: { delivery: { untitled: '未命名产物' } } },
    en: { conversation: { delivery: { untitled: 'Untitled artifact' } } }
  } })
  const t = locale.getFixedT(null, 'conversation')
  assert.equal(documentDisplayTitle(before.tabs[tabId], t, locale.getFixedT(null, 'workbench')), '未命名产物')
  await locale.changeLanguage('en')
  assert.equal(documentDisplayTitle(before.tabs[tabId], t, locale.getFixedT(null, 'workbench')), 'Untitled artifact')
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(before.tabs[tabId].sessionId, sessionId)
  assert.equal(before.sessions[sessionId].title, '')
  assert.equal(before.sessions[sessionId].dirty, true)
  assert.equal(before.sessions[sessionId].text, '# unsaved draft')
  assert.equal(await workspace.open(source, 'edit', '', undefined, 'untitledArtifact'), tabId)
  assert.equal(documentDisplayTitle({ title: '' }, t, locale.getFixedT(null, 'workbench')), '')
})

test('baseline display metadata retains raw filename and open document state across locales', async () => {
  const workspace = new DocumentWorkspace(loader())
  const tabId = await workspace.open(source, 'edit', '修改前 · 研究.md', undefined, { kind: 'reviewBaseline', filename: '研究.md' })
  const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
  workspace.updateText(sessionId, '# unsaved baseline draft')
  const before = workspace.getSnapshot()
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: {
    zh: { workbench: { snapshot: { baselineTitle: '修改前 · {{title}}' } } },
    en: { workbench: { snapshot: { baselineTitle: 'Before changes · {{title}}' } } }
  } })
  const conversation = locale.getFixedT(null, 'conversation')
  const workbench = locale.getFixedT(null, 'workbench')
  assert.equal(documentDisplayTitle(before.tabs[tabId], conversation, workbench), '修改前 · 研究.md')
  await locale.changeLanguage('en')
  assert.equal(documentDisplayTitle(before.tabs[tabId], conversation, workbench), 'Before changes · 研究.md')
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(before.tabs[tabId].title, '修改前 · 研究.md')
  assert.equal(before.sessions[sessionId].title, '修改前 · 研究.md')
  assert.equal(before.sessions[sessionId].dirty, true)
  assert.equal(before.sessions[sessionId].text, '# unsaved baseline draft')
  assert.equal(await workspace.open(source, 'edit', '修改前 · 研究.md', undefined, { kind: 'reviewBaseline', filename: '研究.md' }), tabId)
})


test('four-pane limits reject duplicate and drag splits while close releases the slot', async () => {
  const workspace = new DocumentWorkspace(loader())
  const first = await workspace.open(source, 'preview')
  const right = await workspace.splitTab(first, 'right', false)
  assert.ok(right)
  assert.equal(workspace.canSplitTab(first, 'right', false), false)
  const bottomLeft = await workspace.splitTab(first, 'bottom', false)
  const bottomRight = await workspace.splitTab(right, 'bottom', false)
  assert.ok(bottomLeft)
  assert.ok(bottomRight)
  const before = workspace.getSnapshot()
  assert.equal(await workspace.splitTab(first, 'bottom', false), null)
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(await workspace.moveTab(first, 'primary', before.focusedLeaf!.leafId, 'right'), false)
  assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 4)
  workspace.requestClose(bottomLeft)
  assert.equal(workspace.canSplitTab(first, 'bottom', false), true)
  assert.ok(await workspace.splitTab(first, 'bottom', false))
})

test('directional tab moves use existing adjacent panes at the four-pane limit', async () => {
  const workspace = new DocumentWorkspace(loader())
  const first = await workspace.open(source, 'preview')
  const right = await workspace.splitTab(first, 'right', false)
  const bottomLeft = await workspace.splitTab(first, 'bottom', false)
  const bottomRight = right ? await workspace.splitTab(right, 'bottom', false) : null
  assert.ok(right)
  assert.ok(bottomLeft)
  assert.ok(bottomRight)

  assert.equal(workspace.canMoveTab(first, 'right'), true)
  assert.equal(workspace.canMoveTab(first, 'bottom'), true)
  assert.equal(await workspace.moveTabToAdjacent(first, 'right'), true)

  const state = workspace.getSnapshot()
  const moved = state.focusedLeaf && findLeaf(state.layout.areas[state.focusedLeaf.area], state.focusedLeaf.leafId)
  assert.ok(moved?.tabIds.includes(first))
  assert.ok(moved?.tabIds.includes(right))
  assert.equal(workspace.canMoveTab(first, 'right'), false)
})


test('opening a file into an unavailable extra area keeps the tab in an existing pane', async () => {
  const workspace = new DocumentWorkspace(loader())
  const first = await workspace.open(source, 'preview')
  const right = await workspace.splitTab(first, 'right', false)
  assert.ok(right)
  const opened = await workspace.open({ ...source, path: 'notes/another.md' }, 'preview', 'another', 'secondary')
  const state = workspace.getSnapshot()
  assert.equal(nodeTabCount(state.layout.areas.secondary), 0)
  assert.equal(nodeTabCount(state.layout.areas.primary), 3)
  assert.ok(state.focusedLeaf)
  assert.ok(findLeaf(state.layout.areas.primary, state.focusedLeaf.leafId)?.tabIds.includes(opened))
})
