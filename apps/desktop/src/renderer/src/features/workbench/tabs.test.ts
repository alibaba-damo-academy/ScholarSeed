import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeNavigationTabId,
  closeTab,
  LITERATURE_TAB,
  literatureSearchTab,
  OVERVIEW_TAB,
  reviewTab,
  tabMatchesProject,
  tabVisibleInCurrentView,
  versionDiffTab,
  type WorkbenchTab
} from './tabs.ts'

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
    activeNavigationTabId('web-search:result', visibleTabs, 'notes.md', 'overview'),
    'web-search:result'
  )
})

test('a visible focused document is used only after the requested tab disappears', () => {
  const visibleTabs = new Set(['overview', 'notes.md'])

  assert.equal(
    activeNavigationTabId('web-search:closed', visibleTabs, 'notes.md', 'overview'),
    'notes.md'
  )
})

test('navigation uses its owning fallback when neither requested nor focused tabs are visible', () => {
  assert.equal(
    activeNavigationTabId('missing', new Set(['overview']), 'closed.md', 'overview'),
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
  processor: null
}
const WEB_TAB: WorkbenchTab = { id: 'web-search:1', kind: 'web_search', title: 'web', closable: true }
const DOCUMENT_TAB_ID = 'resources/sp9/note.md'

test('review tab stays independent from its document and can be closed', () => {
  const review = reviewTab('project-1', 'batch-1', 2)

  assert.equal(tabVisibleInCurrentView(review.kind, 'resource'), true)
  assert.equal(review.title, '审阅修改 · 2')
  assert.equal(review.closable, true)
  assert.equal(
    activeNavigationTabId(review.id, new Set([review.id, DOCUMENT_TAB_ID]), DOCUMENT_TAB_ID, 'overview'),
    review.id
  )

  const closed = closeTab(
    [OVERVIEW_TAB, review],
    review.id,
    review.id,
    { view: 'resource', viewFallbackId: DOCUMENT_TAB_ID }
  )

  assert.equal(closed.activeId, DOCUMENT_TAB_ID)
  assert.deepEqual(closed.tabs, [OVERVIEW_TAB])
})

test('closing the active tab never hands over to a tab hidden in the current view', () => {
  const diff = versionDiffTab(DIFF_REFERENCE)
  const search = literatureSearchTab('s1', '郑云杰', 'p1')
  const tabs = [OVERVIEW_TAB, LITERATURE_TAB, search, diff]

  const closed = closeTab(tabs, diff.id, diff.id, { view: 'resource', viewFallbackId: DOCUMENT_TAB_ID })

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
