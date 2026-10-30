import assert from 'node:assert/strict'
import test from 'node:test'
import { createAvailabilityPolicy } from '../../app/policy.ts'

import {
  activeNavigationTabId,
  mergeNavigationTabOrder,
  reorderNavigationTabOrder,
  restoreProjectWorkbenchTab,
  synchronizeWorkbenchTab,
  closeTab,
  FIXED_TAB_BY_VIEW,
  fixedTabForView,
  openFixedTab,
  LITERATURE_TAB,
  literatureNavigation,
  literatureSearchTab,
  openLiteratureSearchTabs,
  openWorkbenchTab,
  newProjectTab,
  OVERVIEW_TAB,
  projectExplorerTab,
  reviewTab,
  selectProjectTab,
  resolveProjectTabSelection,
  tabMatchesProject,
  tabVisibleInCurrentView,
  versionDiffTab,
  type WorkbenchTab,
} from './tabs.ts'

test('project literature navigation selects the project files category without a separate library', () => {
  const navigation = literatureNavigation([OVERVIEW_TAB], 'project-1')
  assert.equal(navigation.mainView, 'resource')
  const selected = navigation.tabs.find((tab) => tab.id === navigation.activeTab)!
  assert.equal(selected.kind, 'library')
  assert.equal(selected.projectId, 'project-1')
  assert.equal(selected.libraryCategory, 'literature')
  assert.equal(
    navigation.tabs.some((tab) => tab.kind === 'literature'),
    false
  )
  const repeated = literatureNavigation(navigation.tabs, 'project-1')
  assert.equal(repeated.activeTab, selected.id)
  assert.equal(repeated.tabs.length, navigation.tabs.length)
  const other = literatureNavigation(repeated.tabs, 'project-2')
  assert.notEqual(other.activeTab, selected.id)
  assert.equal(other.tabs.find((tab) => tab.id === other.activeTab)?.projectId, 'project-2')
})

test('project literature reuses an existing project files tab and leaves global browsing intact', () => {
  const existing: WorkbenchTab = {
    id: 'chosen-files',
    kind: 'library',
    title: 'Files',
    closable: true,
    projectId: 'project-1',
    libraryCategory: 'outputs',
  }
  const project = literatureNavigation([OVERVIEW_TAB, existing], 'project-1')
  assert.equal(project.activeTab, existing.id)
  assert.equal(project.tabs.length, 2)
  assert.equal(project.tabs[1].libraryCategory, 'literature')
  assert.equal(existing.libraryCategory, 'outputs')
  const global = literatureNavigation(project.tabs, null)
  assert.equal(global.mainView, 'literature')
  assert.equal(global.activeTab, LITERATURE_TAB.id)
  assert.equal(global.tabs.filter((tab) => tab.kind === 'literature').length, 1)
})

test('new navigation tabs append after documents and retain their position after selection', () => {
  const explorer = { id: 'explorer' }
  const document = { id: 'document' }
  const first = { id: 'new-first' }
  const second = { id: 'new-second' }
  const opened = mergeNavigationTabOrder(['explorer', 'document'], [[explorer, first], [document]])
  assert.deepEqual(
    opened.map((tab) => tab.id),
    ['explorer', 'document', 'new-first']
  )
  const selected = { ...first, kind: 'library' }
  const next = mergeNavigationTabOrder(
    opened.map((tab) => tab.id),
    [[explorer, selected, second], [document]]
  )
  assert.deepEqual(
    next.map((tab) => tab.id),
    ['explorer', 'document', 'new-first', 'new-second']
  )
})

test('navigation reorder changes only the visible subset and preserves hidden pane positions', () => {
  assert.deepEqual(
    reorderNavigationTabOrder(['first', 'hidden', 'second', 'third'], ['third', 'first', 'second']),
    ['third', 'hidden', 'first', 'second']
  )
  assert.deepEqual(
    reorderNavigationTabOrder(['first', 'second'], ['second', 'document', 'first']),
    ['second', 'first']
  )
})

test('navigation ordering preserves document drag order and removes closed tabs', () => {
  const explorer = { id: 'explorer' }
  const first = { id: 'first' }
  const second = { id: 'second' }
  const draft = { id: 'draft' }
  const previous = ['explorer', 'first', 'draft', 'second']
  const reordered = mergeNavigationTabOrder(previous, [
    [explorer, draft],
    [second, first],
  ]).map((tab) => tab.id)
  assert.deepEqual(reordered, ['explorer', 'second', 'draft', 'first'])
  assert.deepEqual(
    mergeNavigationTabOrder(reordered, [[explorer, draft], [second]]).map((tab) => tab.id),
    ['explorer', 'second', 'draft']
  )
  assert.deepEqual(
    mergeNavigationTabOrder(previous, [[explorer, draft], [second]]).map((tab) => tab.id),
    ['explorer', 'draft', 'second']
  )
})

test('project return restores its surface rather than promoting an embedded preview', () => {
  const explorer = projectExplorerTab('first', 'Explorer')
  const other = projectExplorerTab('second', 'Explorer')
  const tabs = [OVERVIEW_TAB, explorer, other]
  const documents = {
    focusedTabId: 'preview',
    tabs: { preview: { embedded: true }, standalone: {} },
  }
  assert.equal(restoreProjectWorkbenchTab('first', explorer.id, tabs, documents), explorer.id)
  assert.equal(restoreProjectWorkbenchTab('second', other.id, tabs, documents), other.id)
  assert.equal(restoreProjectWorkbenchTab('first', 'standalone', tabs, documents), 'standalone')
  assert.equal(restoreProjectWorkbenchTab('first', 'closed', tabs, documents), OVERVIEW_TAB.id)
  assert.equal(restoreProjectWorkbenchTab('first', other.id, tabs, documents), OVERVIEW_TAB.id)
  assert.equal(restoreProjectWorkbenchTab('first', 'preview', tabs, documents), OVERVIEW_TAB.id)
  assert.equal(
    restoreProjectWorkbenchTab('first', undefined, tabs, {
      ...documents,
      focusedTabId: 'standalone',
    }),
    'standalone'
  )
})

test('project explorer tabs retain separate identities across project switches', () => {
  const first = projectExplorerTab('first project', 'Explorer')
  const second = projectExplorerTab('second project', 'Explorer')
  const legacy: WorkbenchTab = {
    id: 'explorer',
    kind: 'explorer',
    title: 'Explorer',
    closable: true,
    projectId: 'first project',
  }
  const opened = openWorkbenchTab([OVERVIEW_TAB, legacy, first], 'resource', second)
  assert.notEqual(first.id, second.id)
  assert.equal(tabMatchesProject(first, 'second project'), false)
  assert.equal(tabMatchesProject(second, 'second project'), true)
  assert.equal(opened.find((tab) => tab.id === second.id)?.projectId, 'second project')
  assert.strictEqual(openWorkbenchTab(opened, 'resource', second), opened)
  assert.equal(projectExplorerTab('first project', 'Explorer').id, first.id)
})

test('tab synchronization cannot overwrite a new project, view or user selection', () => {
  const observed = { homeSelectedProjectId: 'first', mainView: 'resource', activeTab: 'missing' }
  for (const changed of [
    { homeSelectedProjectId: 'second' },
    { mainView: 'home' },
    { activeTab: 'selected' },
  ]) {
    const current = { ...observed, ...changed }
    assert.deepEqual(synchronizeWorkbenchTab(current, observed, 'overview'), {})
  }
  assert.deepEqual(synchronizeWorkbenchTab(observed, observed, 'overview'), {
    activeTab: 'overview',
  })
  assert.deepEqual(synchronizeWorkbenchTab(observed, observed, observed.activeTab), {})
})

test('opening a literature result or restored search preserves the fixed list tab', () => {
  for (const projectId of [null, 'project-1']) {
    const search = literatureSearchTab('search-1', 'query', projectId)
    const opened = openWorkbenchTab([OVERVIEW_TAB], 'literature', search)
    assert.deepEqual(opened, [OVERVIEW_TAB, LITERATURE_TAB, search])
    assert.strictEqual(openWorkbenchTab(opened, 'literature', search), opened)
  }
})

test('opening search tasks repairs a missing fixed tab even when the search already exists', () => {
  const task = { id: 'search-1', query: 'query', projectId: 'project-1' }
  const search = literatureSearchTab(task.id, task.query, task.projectId)
  for (const tabs of [[OVERVIEW_TAB], [OVERVIEW_TAB, search]]) {
    const opened = openLiteratureSearchTabs(tabs, [task])
    assert.equal(opened.filter((tab) => tab.id === LITERATURE_TAB.id).length, 1)
    assert.equal(opened.filter((tab) => tab.id === search.id).length, 1)
    assert.equal(opened.find((tab) => tab.id === search.id)?.projectId, task.projectId)
  }
})

test('views without a fixed tab and empty search restoration keep existing navigation', () => {
  const tabs = [OVERVIEW_TAB]
  assert.strictEqual(openWorkbenchTab(tabs, 'resource', OVERVIEW_TAB), tabs)
  assert.strictEqual(openLiteratureSearchTabs(tabs, []), tabs)
})

test('project library remains visible in the project workbench and not in global literature', () => {
  assert.equal(tabVisibleInCurrentView('library', 'resource'), true)
  assert.equal(tabVisibleInCurrentView('library', 'literature'), false)
})

test('new project tabs are independent, closable and scoped to their project', () => {
  const first = newProjectTab('project-1')
  const second = newProjectTab('project-1')
  assert.notEqual(first.id, second.id)
  assert.equal(first.kind, 'new_tab')
  assert.equal(first.closable, true)
  assert.equal(tabMatchesProject(first, 'project-1'), true)
  assert.equal(tabMatchesProject(first, 'project-2'), false)
  assert.equal(tabVisibleInCurrentView(first.kind, 'resource'), true)
  assert.equal(tabVisibleInCurrentView(first.kind, 'literature'), false)
  assert.equal(
    closeTab([OVERVIEW_TAB, first, second], first.id, first.id, { view: 'resource' }).activeId,
    second.id
  )
})

test('choosing a project surface replaces only the selected blank tab', () => {
  const first = newProjectTab('project-1')
  const second = newProjectTab('project-1')
  const initial = [OVERVIEW_TAB, first, second]
  const files = selectProjectTab(initial, first.id, 'library')
  assert.equal(files.length, initial.length)
  assert.equal(files[1].id, first.id)
  assert.equal(files[1].kind, 'library')
  assert.equal(files[1].titleFallback, 'projectFiles')
  assert.equal(files[1].projectId, first.projectId)
  assert.equal(files[2], second)

  const explorer = selectProjectTab(files, second.id, 'explorer')
  assert.equal(explorer[2].id, second.id)
  assert.equal(explorer[2].kind, 'explorer')
  assert.equal(explorer[2].titleFallback, 'projectExplorer')
  assert.strictEqual(selectProjectTab(explorer, first.id, 'explorer'), explorer)
  assert.strictEqual(selectProjectTab(explorer, 'missing', 'library'), explorer)
})

test('project surface selection activates an existing same-project tab without replacing the blank', () => {
  for (const kind of ['library', 'explorer'] as const) {
    const blank = newProjectTab('project-1')
    const surface = { ...newProjectTab('project-1'), kind }
    const tabs = [OVERVIEW_TAB, surface, blank]
    const selection = resolveProjectTabSelection(tabs, blank.id, kind)
    assert.strictEqual(selection.tabs, tabs)
    assert.equal(selection.activeTab, surface.id)
    assert.equal(blank.kind, 'new_tab')
  }
})

test('project surface selection does not reuse another project or another surface kind', () => {
  for (const kind of ['library', 'explorer'] as const) {
    const blank = newProjectTab('project-1')
    const otherProject = { ...newProjectTab('project-2'), kind }
    const otherKind = {
      ...newProjectTab('project-1'),
      kind: kind === 'library' ? 'explorer' : 'library',
    } as WorkbenchTab
    const tabs = [OVERVIEW_TAB, otherProject, otherKind, blank]
    const selection = resolveProjectTabSelection(tabs, blank.id, kind)
    assert.equal(selection.activeTab, blank.id)
    assert.equal(selection.tabs[3].kind, kind)
    assert.equal(selection.tabs[1], otherProject)
    assert.equal(selection.tabs[2], otherKind)
  }
})

test('browser is a non-closable global workbench surface retained across views', () => {
  const browser = FIXED_TAB_BY_VIEW.browser
  assert.ok(browser)
  assert.equal(browser.closable, false)
  assert.equal(browser.kind, 'browser')
  const tabs = openFixedTab([OVERVIEW_TAB], browser)
  assert.equal(openFixedTab(tabs, browser), tabs)
  for (const project of [null, 'alpha', 'beta'])
    assert.equal(tabMatchesProject(browser, project), true)
  assert.equal(
    tabVisibleInCurrentView(browser.kind, 'browser', createAvailabilityPolicy(true)),
    true
  )
  assert.equal(
    tabVisibleInCurrentView(browser.kind, 'browser', createAvailabilityPolicy(false)),
    false
  )
  assert.equal(fixedTabForView('browser', createAvailabilityPolicy(false)), undefined)
  assert.equal(fixedTabForView('browser', createAvailabilityPolicy(true)), browser)
  assert.deepEqual(
    openWorkbenchTab([OVERVIEW_TAB], 'browser', browser, createAvailabilityPolicy(false)),
    [OVERVIEW_TAB]
  )
  for (const view of ['home', 'projects', 'resource', 'literature', 'writing']) {
    assert.equal(tabVisibleInCurrentView(browser.kind, view), false)
  }
  assert.equal(tabVisibleInCurrentView('file', 'browser'), false)
})

test('project-scoped tabs are hidden outside their owner and remain available on return', () => {
  const tab = { ...OVERVIEW_TAB, projectId: 'alpha' }
  assert.equal(tabMatchesProject(tab, 'alpha'), true)
  assert.equal(tabMatchesProject(tab, 'beta'), false)
  assert.equal(tabMatchesProject(tab, null), false)
  assert.equal(tabMatchesProject(tab, 'alpha'), true)
  assert.equal(tabMatchesProject(OVERVIEW_TAB, 'beta'), true)
  assert.equal(tabMatchesProject({ ...tab, projectId: null }, null), true)
  assert.equal(tabMatchesProject({ ...tab, projectId: null }, 'alpha'), false)
})

test('version diff tabs follow their owning project and remain available on return', () => {
  const tab = versionDiffTab(DIFF_REFERENCE)

  assert.equal(tab.projectId, DIFF_REFERENCE.project)
  assert.equal(tabMatchesProject(tab, DIFF_REFERENCE.project), true)
  assert.equal(tabMatchesProject(tab, 'p2'), false)
  assert.equal(tabMatchesProject(tab, null), false)
  assert.equal(tabMatchesProject(tab, DIFF_REFERENCE.project), true)
})

test('the active workbench tab wins over a stale focused document', () => {
  const visibleTabs = new Set(['web-search:result', 'notes.md'])

  assert.equal(
    activeNavigationTabId(
      'web-search:result',
      visibleTabs,
      'notes.md',
      'overview',
      new Set(['notes.md'])
    ),
    'web-search:result'
  )
})

test('document navigation follows workspace focus instead of a stale requested document', () => {
  const documentIds = new Set(['first.md', 'second.md'])
  const visibleIds = new Set(['overview', ...documentIds])

  assert.equal(
    activeNavigationTabId('first.md', visibleIds, 'second.md', 'overview', documentIds),
    'second.md'
  )
  assert.equal(
    activeNavigationTabId('second.md', visibleIds, 'first.md', 'overview', documentIds),
    'first.md'
  )
})

test('an active non-document workbench tab keeps priority over workspace document focus', () => {
  const documentIds = new Set(['first.md', 'second.md'])
  const visibleIds = new Set(['web-search:result', ...documentIds])

  assert.equal(
    activeNavigationTabId('web-search:result', visibleIds, 'second.md', 'overview', documentIds),
    'web-search:result'
  )
})

test('a visible focused document is used only after the requested tab disappears', () => {
  const visibleTabs = new Set(['overview', 'notes.md'])

  assert.equal(
    activeNavigationTabId(
      'web-search:closed',
      visibleTabs,
      'notes.md',
      'overview',
      new Set(['notes.md'])
    ),
    'notes.md'
  )
})

test('navigation uses its owning fallback when neither requested nor focused tabs are visible', () => {
  assert.equal(
    activeNavigationTabId(
      'missing',
      new Set(['overview']),
      'closed.md',
      'overview',
      new Set(['closed.md'])
    ),
    'overview'
  )
})

const DIFF_REFERENCE = {
  project: 'p1',
  fileId: 'f1',
  path: 'resources/sp9/note.md',
  historicalVersionId: 'v3',
  currentVersionId: 'v8',
  historicalSequence: 3,
  processor: null,
}
const WEB_TAB: WorkbenchTab = {
  id: 'web-search:1',
  kind: 'web_search',
  title: 'web',
  closable: true,
}
const DOCUMENT_TAB_ID = 'resources/sp9/note.md'

test('review tab stays independent from its document and can be closed', () => {
  const review = reviewTab('project-1', 'batch-1', 2)

  assert.equal(tabVisibleInCurrentView(review.kind, 'resource'), true)
  assert.equal(review.projectId, 'project-1')
  assert.equal(tabMatchesProject(review, 'project-1'), true)
  assert.equal(tabMatchesProject(review, 'project-2'), false)
  assert.equal(tabMatchesProject(review, null), false)
  assert.equal(review.title, '审阅修改 · 2')
  assert.equal(review.closable, true)
  assert.equal(
    activeNavigationTabId(
      review.id,
      new Set([review.id, DOCUMENT_TAB_ID]),
      DOCUMENT_TAB_ID,
      'overview',
      new Set([DOCUMENT_TAB_ID])
    ),
    review.id
  )

  const closed = closeTab([OVERVIEW_TAB, review], review.id, review.id, {
    view: 'resource',
    viewFallbackId: DOCUMENT_TAB_ID,
  })

  assert.equal(closed.activeId, DOCUMENT_TAB_ID)
  assert.deepEqual(closed.tabs, [OVERVIEW_TAB])
})

test('closing the active tab never hands over to a tab hidden in the current view', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', '郑云杰', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, diff.id, diff.id, {
    view: 'resource',
    viewFallbackId: DOCUMENT_TAB_ID,
  })

  assert.equal(closed.activeId, DOCUMENT_TAB_ID)
  assert.equal(closed.tabs.length, 3)
})

test('a same-view right neighbour wins over a cross-view right neighbour', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, diff, search, WEB_TAB]

  const closed = closeTab(tabs, diff.id, diff.id, { view: 'resource', viewFallbackId: null })

  assert.equal(closed.activeId, WEB_TAB.id)
})

test('the same-view search falls back left when only cross-view tabs remain on the right', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, WEB_TAB, search, diff]

  const closed = closeTab(tabs, diff.id, diff.id, { view: 'resource', viewFallbackId: null })

  assert.equal(closed.activeId, WEB_TAB.id)
})

test('closing a literature search tab stays inside the literature view', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, search.id, search.id, { view: 'literature', viewFallbackId: null })

  assert.equal(closed.activeId, LITERATURE_TAB.id)
})

test('without same-view tabs or a fallback the view fixed tab takes over', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, diff.id, diff.id, { view: 'resource', viewFallbackId: null })

  assert.equal(closed.activeId, OVERVIEW_TAB.id)
})

test('closing without a view context keeps the positional neighbour semantics', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, diff.id, diff.id)

  assert.equal(closed.activeId, search.id)
})

test('closing an inactive tab leaves the active tab untouched', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', 'q', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, search.id, diff.id, { view: 'resource', viewFallbackId: null })

  assert.equal(closed.activeId, search.id)
  assert.equal(closed.tabs.length, 3)
})
