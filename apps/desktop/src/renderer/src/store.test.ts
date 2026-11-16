import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { block } from '../../test-helpers/source-contract.ts'
import { DEFAULT_RENDERER_PREFERENCES, defaultRendererPreferences } from '../../preferences.ts'
import { defaultSelectionPrompts, sanitizeSelectionPrompts } from '../../prompts.ts'
import { sanitizeOnboarding } from '../../onboarding.ts'

import { StoreContext } from './storeContext.ts'
import {
  composerDraftKey,
  createComposerDraftStore,
  readComposerDrafts,
  serializeComposerDrafts,
} from './draft.ts'
import { changeProjectLayout, DEFAULT_PROJECT_LAYOUT } from '../../layout.ts'
import {
  closeTab,
  mainViewForWorkbenchTab,
  newProjectTab,
  openFixedTab,
  OVERVIEW_TAB,
  type WorkbenchTab,
  literatureNavigation,
  synchronizeWorkbenchTab,
  shouldRestoreDocumentFocus,
} from './features/workbench/tabs.ts'
import {
  DocumentWorkspace,
  documentNavigationView,
  type DocumentLoader,
} from './features/workbench/workspace.ts'
import { resolveDocumentWorkspaceProject } from './features/workbench/scope.ts'
import { LITERATURE_EXCERPT_VIEW_STATE_KEY } from './contracts/resources.ts'
import { documentIdFor, isDocumentLoadFailure } from './features/workbench/api.ts'
import { expandedResourceAncestors } from './features/resources/lifecycle.ts'
import { observeNavigation, navigationDiagnostic, type NavigationCause } from './navigation.ts'
import { findSessionNode, upsertSessionNode } from './tree.ts'
import type { SessionNode, SessionStatus, Thread } from './model.ts'

const storeSource = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')

test('opening an empty composer with attached context does not replace its draft identity', () => {
  const panel = readFileSync(new URL('./features/assistant/AiPanel.tsx', import.meta.url), 'utf8')
  const effect = block(panel, 'useEffect(() => {\n    if (!ai.open)', 'const sessionTitle')
  for (const attached of [false, true]) {
    let resets = 0
    runInNewContext(effect, {
      useEffect: (callback: () => void) => callback(),
      ai: { open: true, refs: attached ? [{}] : [] },
      state: { activeSession: null, turnLaunch: null, composerRefs: [] },
      composerDraft: createComposerDraftStore(),
      act: {
        startPanelDraft: () => {
          resets += 1
        },
      },
    })
    assert.equal(resets, attached ? 0 : 1)
  }
})

test('preparing task input preserves the workspace visibility without losing its draft or task type', () => {
  for (const open of [false, true]) {
    for (const taskType of [undefined, 'precise_search', 'literature_review', 'research_idea']) {
      let state = {
        aiPanel: { open: false },
        composerTaskType: '',
        workbenchLayout: {
          ...DEFAULT_PROJECT_LAYOUT,
          open,
          swapped: true,
          conversationWidth: 420,
        },
      }
      const composerDraft = { current: createComposerDraftStore() }
      const actions = {} as { askAiFromPanel: (text: string, taskType?: string) => void }
      runInNewContext(
        transformSync(
          `Object.assign(actions, {${block(storeSource, 'askAiFromPanel: (text, taskType) => {', 'prepareContextConversation:')}})`,
          { loader: 'ts' }
        ).code,
        {
          actions,
          composerDraft,
          changeProjectLayout,
          setState: (update: (current: typeof state) => typeof state) => {
            state = update(state)
          },
        }
      )
      actions.askAiFromPanel('Prepared task', taskType)
      assert.equal(state.workbenchLayout.open, open)
      assert.equal(state.workbenchLayout.swapped, true)
      assert.equal(state.workbenchLayout.conversationWidth, 420)
      assert.equal(state.aiPanel.open, true)
      assert.equal(state.composerTaskType, taskType ?? '')
      assert.equal(composerDraft.current.getSnapshot(), 'Prepared task')
    }
  }
})

test('context conversation handoff reveals its composer and preserves drafts without crossing targets', async () => {
  for (const mode of ['ready', 'rejected', 'switched', 'project', 'reset', 'typing', 'failed']) {
    let state = {
      activeSession: 'original',
      homeSelectedProjectId: 'project',
      aiPanel: { open: false },
      workbenchLayout: { ...DEFAULT_PROJECT_LAYOUT, open: true, full: true, floating: 'minimized' },
    }
    const composerDraft = { current: createComposerDraftStore('Existing draft') }
    const target = () => ({
      sessionId: state.activeSession,
      projectId: state.homeSelectedProjectId,
      draftScope: composerDraft.current.getScope(),
    })
    const actions = {
      captureContextTarget: target,
      addContext: async () => {
        if (mode === 'failed') throw new Error('offline')
        if (mode === 'switched') state = { ...state, activeSession: 'other' }
        if (mode === 'project') state = { ...state, homeSelectedProjectId: 'other' }
        if (mode === 'reset') composerDraft.current.reset()
        if (mode === 'typing') composerDraft.current.set('Typed while waiting')
        return { accepted_ref_ids: mode === 'rejected' ? [] : ['reference'] }
      },
    } as {
      captureContextTarget: typeof target
      addContext: () => Promise<{ accepted_ref_ids: string[] }>
      prepareContextConversation: (candidate: unknown, text: string) => Promise<boolean>
    }
    runInNewContext(
      transformSync(
        `Object.assign(actions, {${block(storeSource, 'askAiFromPanel: (text, taskType) => {', 'attachActiveFileToAi:')}})`,
        { loader: 'ts' }
      ).code,
      {
        actions,
        composerDraft,
        actRef: { current: actions },
        setState: (update: (current: typeof state) => typeof state) => {
          state = update(state)
        },
        changeProjectLayout,
      }
    )
    if (mode === 'failed')
      await assert.rejects(actions.prepareContextConversation({}, 'Summary'), /offline/)
    else {
      const ready = await actions.prepareContextConversation({}, 'Summary')
      assert.equal(ready, mode === 'ready' || mode === 'typing')
      if (ready) {
        assert.equal(state.aiPanel.open, true)
        assert.equal(state.workbenchLayout.open, true)
        assert.equal(state.workbenchLayout.full, false)
        assert.notEqual(state.workbenchLayout.floating, 'minimized')
        assert.equal(
          composerDraft.current.getSnapshot(),
          `${mode === 'typing' ? 'Typed while waiting' : 'Existing draft'}\n\nSummary`
        )
      } else
        assert.equal(composerDraft.current.getSnapshot(), mode === 'reset' ? '' : 'Existing draft')
    }
  }
})

test('unavailable navigation does not suspend current draft persistence', () => {
  let suspended = false
  const action = block(storeSource, 'openWorkbenchView: (view, options) =>', 'toggleModulePanel:')
  const compiled = transformSync(
    `const actions = {${action}}; actions.openWorkbenchView('unavailable')`,
    { loader: 'ts' }
  ).code
  runInNewContext(compiled, {
    availabilityPolicy: { routeAvailable: () => false },
    rememberSessionDraft: () => {
      suspended = true
    },
    setState: () => {},
  })
  assert.equal(suspended, false)
})

function sessionDraftHarness() {
  const reference = {
    type: 'file' as const,
    id: 'local-file',
    referenceId: 'registered-file',
    path: '/original/draft.txt',
    title: 'draft.txt',
  }
  const original: SessionNode = { id: 'original', title: 'Original', status: 'dormant' }
  const other: SessionNode = { id: 'other', title: 'Other', status: 'dormant' }
  let state = {
    activeSession: 'original' as string | null,
    composerRefs: [reference],
    composerSubmitRequested: false,
    mainView: 'resource',
    draftGeneration: 0,
    homeSelectedProjectId: 'project',
    tabs: [],
    aiPanel: {
      open: true,
      sessionMenuOpen: false,
      refs: [],
      projectPolicy: 'auto_project',
      searchScope: 'academic',
    },
    sessions: [original, other],
    threads: {},
    recentSessions: [],
  }
  const composerDraft = { current: createComposerDraftStore('Unsent original draft') }
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
  }
  const listeners = new Map<string, () => void>()
  let restore = () => {}
  const result = {} as {
    startPanelDraft: () => void
    openPanelSession: (node: SessionNode) => void
    clearSessionSelection: () => void
    openWorkbenchView: (view: string) => void
    activate: (node: SessionNode) => void
  }
  const compiled = transformSync(
    `${block(storeSource, 'function assistantSessionView', 'function currentScopeKey')}
     ${block(storeSource, 'const sessionDrafts =', 'const expandedAssistantReturns')}
     Object.assign(result, {
       ${block(storeSource, 'startPanelDraft: (seed = {}) => {', 'activateTab:')}
       ${block(storeSource, 'openPanelSession: (node, focus) => {', 'returnHome:')}
       ${block(storeSource, 'clearSessionSelection: () => {', 'captureSettingsSurface:')}
       ${block(storeSource, 'openWorkbenchView: (view, options) =>', 'toggleModulePanel:')}
       activate: (node) => setState(current => activateSession(current, node, 'assistant')),
     })`,
    { loader: 'ts' }
  ).code
  runInNewContext(compiled, {
    result,
    composerDraft,
    composerDraftKey,
    readComposerDrafts,
    serializeComposerDrafts,
    INITIAL_PREFERENCES: {},
    INITIAL_AI_PANEL_STATE: { projectPolicy: 'explicit_only', searchScope: 'web' },
    preferenceWriter: {
      current: {
        submit: ({ composerDrafts }: { composerDrafts: string }) =>
          storage.setItem('drafts', composerDrafts),
      },
    },
    window: {
      localStorage: storage,
      addEventListener: (name: string, callback: () => void) => {
        listeners.set(name, callback)
      },
      removeEventListener: (name: string) => {
        listeners.delete(name)
      },
    },
    state,
    stateRef: {
      get current() {
        return state
      },
    },
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => unknown) => {
      callback()
    },
    useLayoutEffect: (callback: () => void) => {
      restore = callback
    },
    setState: (update: (current: typeof state) => typeof state) => {
      update(state)
      state = update(state)
    },
    rememberScopeConversation: () => {},
    rememberOpenedConversation: () => {},
    conversationScopePath: () => null,
    currentScopeKey: () => null,
    touchRecentSession: (recent: unknown) => recent,
    upsertSessionNode,
    sessionTitleFallback: () => null,
    availabilityPolicy: { routeAvailable: () => true },
    fixedTabForView: () => null,
    activeTabForWorkbenchView: () => 'skills',
    documentWorkspaces: { forProject: () => ({ getSnapshot: () => ({ tabs: {} }) }) },
    assistantProject: (current: typeof state) => ({ projectId: current.homeSelectedProjectId }),
    assistantScopeReset: () => ({ activeSession: null, composerRefs: [] }),
    LITERATURE_SCOPE_KEY: 'literature',
    ASSISTANT_FALLBACK_VIEW: 'resource',
    SURFACE_RESET: {},
    COMPOSER_RESET: { composerRefs: [], composerSubmitRequested: false },
    HOME_RESET: { activeSession: null, composerRefs: [], composerSubmitRequested: false },
  })
  const navigate = (action: () => void) => {
    action()
    restore()
    restore()
  }
  return {
    result,
    composerDraft: composerDraft.current,
    storage,
    reference,
    original,
    other,
    navigate,
    get state() {
      return state
    },
  }
}

test('leaving for a new task restores the same session draft and registered attachment without sending', () => {
  const harness = sessionDraftHarness()
  harness.navigate(() => harness.result.startPanelDraft())
  assert.equal(harness.composerDraft.getSnapshot(), '')
  assert.equal(harness.state.composerRefs.length, 0)
  harness.navigate(() => harness.result.openPanelSession(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Unsent original draft')
  assert.equal(harness.state.composerRefs[0], harness.reference)
  assert.equal(harness.state.composerRefs[0].path, '/original/draft.txt')
  assert.equal(harness.state.composerRefs[0].referenceId, 'registered-file')
  assert.equal(harness.state.composerSubmitRequested, false)
})

test('panel session switches isolate drafts and remember the latest text and explicit clearing', () => {
  const harness = sessionDraftHarness()
  harness.navigate(() => harness.result.openPanelSession(harness.other))
  assert.equal(harness.composerDraft.getSnapshot(), '')
  assert.equal(harness.state.composerRefs.length, 0)
  harness.composerDraft.set('Other draft')
  harness.navigate(() => harness.result.openPanelSession(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Unsent original draft')
  harness.composerDraft.set('Edited original draft')
  harness.navigate(() => harness.result.openPanelSession(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Edited original draft')
  harness.navigate(() => harness.result.openPanelSession(harness.other))
  assert.equal(harness.composerDraft.getSnapshot(), 'Other draft')
  harness.composerDraft.set('')
  harness.navigate(() => harness.result.openPanelSession(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Edited original draft')
  harness.navigate(() => harness.result.openPanelSession(harness.other))
  assert.equal(harness.composerDraft.getSnapshot(), '')
})

test('clearing selection retains the draft for implicit conversation activation', () => {
  const harness = sessionDraftHarness()
  harness.navigate(() => harness.result.clearSessionSelection())
  assert.equal(harness.composerDraft.getSnapshot(), '')
  harness.navigate(() => harness.result.activate(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Unsent original draft')
  assert.equal(harness.state.composerRefs[0], harness.reference)
})

test('scope navigation preserves the original draft when React evaluates the state updater twice', () => {
  const harness = sessionDraftHarness()
  harness.navigate(() => harness.result.openWorkbenchView('skills'))
  assert.equal(harness.composerDraft.getSnapshot(), '')
  assert.equal(harness.state.composerRefs.length, 0)
  harness.navigate(() => harness.result.activate(harness.original))
  assert.equal(harness.composerDraft.getSnapshot(), 'Unsent original draft')
  assert.equal(harness.state.composerRefs[0], harness.reference)
})

test('project literature entry preserves conversation and opens the files literature category', () => {
  const action = block(storeSource, 'openWorkbenchView: (view, options) =>', 'toggleModulePanel:')
  const compiled = transformSync(
    `const actions = {${action}}; actions.openWorkbenchView('literature', { preserveProject: true })`,
    { loader: 'ts', format: 'cjs' }
  ).code
  let state = {
    mainView: 'resource',
    homeSelectedProjectId: 'project',
    activeSession: 'session',
    composerText: 'unsent draft',
    tabs: [],
    activeTab: 'conversation',
    workbenchLayout: { open: false, taskTab: true, swapped: true, full: false },
  }
  runInNewContext(compiled, {
    availabilityPolicy: { routeAvailable: () => true },
    rememberSessionDraft: () => {},
    literatureNavigation,
    SURFACE_RESET: {},
    setState: (update: (current: typeof state) => typeof state) => {
      state = update(state)
    },
  })
  assert.equal(state.mainView, 'resource')
  assert.equal(state.homeSelectedProjectId, 'project')
  assert.equal(state.activeSession, 'session')
  assert.equal(state.composerText, 'unsent draft')
  assert.equal(state.workbenchLayout.open, true)
  assert.equal(state.workbenchLayout.swapped, true)
  assert.deepEqual(state.tabs, literatureNavigation([], 'project').tabs)
})

test('web source navigation reveals a split workspace without losing the conversation or layout preference', () => {
  const action = block(storeSource, 'openWorkbenchView: (view, options) =>', 'toggleModulePanel:')
  const compiled = transformSync(
    `const actions = {${action}}; actions.openWorkbenchView('browser', { preserveProject: true, browserPageId: 'source-page', browserPageOwned: true })`,
    { loader: 'ts', format: 'cjs' }
  ).code
  for (const swapped of [false, true]) {
    for (const full of [false, true]) {
      let state = {
        mainView: 'resource',
        homeSelectedProjectId: 'project',
        activeSession: 'session',
        composerText: 'unsent draft',
        tabs: [] as WorkbenchTab[],
        activeTab: 'conversation',
        workbenchLayout: {
          ...DEFAULT_PROJECT_LAYOUT,
          swapped,
          full,
          conversationFull: full,
          taskTab: full,
        },
      }
      runInNewContext(compiled, {
        availabilityPolicy: { routeAvailable: () => true },
        rememberSessionDraft: () => {},
        fixedTabForView: () => ({ id: 'browser', kind: 'browser', title: 'Browser' }),
        openFixedTab,
        activeTabForWorkbenchView: () => 'browser',
        documentWorkspaces: { forProject: () => ({ getSnapshot: () => ({ tabs: {} }) }) },
        assistantProject: () => ({ projectId: 'project' }),
        SURFACE_RESET: {},
        LITERATURE_SCOPE_KEY: 'literature',
        setState: (update: (current: typeof state) => typeof state) => {
          state = update(state)
        },
      })
      assert.equal(state.workbenchLayout.open, true)
      assert.equal(state.workbenchLayout.full, false)
      assert.equal(state.workbenchLayout.conversationFull, false)
      assert.equal(state.workbenchLayout.taskTab, false)
      assert.equal(state.workbenchLayout.swapped, swapped)
      assert.equal(state.activeSession, 'session')
      assert.equal(state.composerText, 'unsent draft')
      assert.equal(state.homeSelectedProjectId, 'project')
      assert.equal(state.activeTab, 'browser')
      assert.equal(state.tabs[0].browserPageId, 'source-page')
    }
  }
})

const literatureSource = {
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
const documentLoader: DocumentLoader = {
  async load(source) {
    return {
      source,
      documentId: documentIdFor(source),
      viewer: 'pdf',
      processor: null,
      revision: 'revision',
      bytes: new Uint8Array(),
      mediaType: 'application/pdf',
      capabilities: {
        can_preview: true,
        can_edit: false,
        can_select: true,
        can_annotate: false,
        can_save: false,
        can_version: false,
        can_diff: false,
        pending: [],
      },
    }
  },
  async commit() {
    throw new Error('not used')
  },
}

test('activating an existing literature tab preserves the current surface, draft and tab attribution', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const id = await workspace.open(literatureSource, 'edit')
  const action = block(storeSource, 'activateTab: (id, options) => {', 'openVersionDiff:')
  const helper = block(storeSource, 'function mainViewForDocumentSource', '/**')
  const compiled = transformSync(
    `${helper}\nconst actions = {${action}}; actions.activateTab(id)`,
    { loader: 'ts' }
  ).code
  for (const mainView of ['resource', 'literature']) {
    const stateRef = {
      current: {
        mainView,
        homeSelectedProjectId: 'project',
        tabs: [],
        activeTab: 'old',
        activeSession: 'session',
        composerText: 'unsent',
        accountSettingsPage: null,
        browserSettingsSection: null,
        navigationRestored: true,
        aiPanel: { open: true, cover: true },
      },
    }
    let diagnostic = ''
    runInNewContext(compiled, {
      id,
      stateRef,
      availabilityPolicy: { tabIdAvailable: () => true },
      assistantProject: () => ({ projectId: 'project' }),
      documentWorkspaces: { forProject: () => workspace },
      setState: (
        update: (state: typeof stateRef.current) => typeof stateRef.current,
        navigation: NavigationCause
      ) => {
        const next = observeNavigation(stateRef.current, update(stateRef.current), navigation)
        diagnostic = navigationDiagnostic(next.navigationObservation!, 'committed')
        stateRef.current = next
      },
    })
    assert.equal(stateRef.current.mainView, mainView)
    assert.equal(stateRef.current.activeTab, workspace.getSnapshot().focusedTabId)
    assert.equal(stateRef.current.aiPanel.cover, false)
    assert.equal(stateRef.current.composerText, 'unsent')
    assert.equal(stateRef.current.activeSession, 'session')
    assert.equal(JSON.parse(diagnostic).action, 'tab')
    assert.equal(JSON.parse(diagnostic).source, 'action')
    const snapshot = workspace.getSnapshot()
    assert.equal(
      documentNavigationView(snapshot.tabs[id], snapshot.sessions[snapshot.tabs[id].sessionId]),
      mainView
    )
  }
})

test('current document sampling uses the visible focused attachment, never a hidden or unready document', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const id = await workspace.open(literatureSource, 'edit')
  const selector = block(
    storeSource,
    'export function activeDocumentForTurn',
    'export function selectedLiteratureForTurn'
  ).replace('export ', '')
  const compiled = transformSync(`${selector}\nresult.value = activeDocumentForTurn(state)`, {
    loader: 'ts',
  }).code
  const state = { mainView: 'resource', activeTab: id, homeSelectedProjectId: 'project' }
  const sample = (patch = {}, snapshot = workspace.getSnapshot()) => {
    const result: {
      value?: { kind: string; attachment_id?: string; literature_id?: string } | null
    } = {}
    runInNewContext(compiled, {
      state: { ...state, ...patch },
      result,
      documentNavigationView,
      assistantProject: () => ({ projectId: 'project' }),
      documentWorkspaces: { forProject: () => ({ getSnapshot: () => snapshot }) },
    })
    return result.value
  }
  workspace.setTabNavigationView(id, 'resource')
  assert.equal(sample()?.kind, 'literature')
  assert.equal(sample()?.literature_id, 'paper')
  assert.equal(sample()?.attachment_id, 'supplement')
  assert.equal(sample({ activeTab: 'literature' }), null)
  assert.equal(sample({ mainView: 'literature' }), null)
  const snapshot = workspace.getSnapshot()
  const sessionId = snapshot.tabs[id].sessionId
  assert.equal(
    sample(
      {},
      {
        ...snapshot,
        sessions: {
          ...snapshot.sessions,
          [sessionId]: { ...snapshot.sessions[sessionId], loadState: 'loading' },
        },
      }
    ),
    null
  )
  assert.equal(
    sample(
      {},
      {
        ...snapshot,
        sessions: {
          ...snapshot.sessions,
          [sessionId]: {
            ...snapshot.sessions[sessionId],
            source: { kind: 'project', project: 'other', path: 'file.md' },
          },
        },
      }
    ),
    null
  )
})

test('attachment opening refreshes reused navigation without losing page, view state or session identity', async () => {
  let loadGate: Promise<void> = Promise.resolve()
  let startedLoading = (): void => {}
  const workspace = new DocumentWorkspace({
    ...documentLoader,
    async load(source) {
      startedLoading()
      await loadGate
      return documentLoader.load(source)
    },
  })
  const stateRef = {
    current: { mainView: 'literature', activeTab: 'literature', homeSelectedProjectId: 'project' },
  }
  const action = block(storeSource, 'openLiteratureAttachment: async', 'closeLiteratureAttachment:')
  const compiled = transformSync(
    `const actions = {${action}}; result.promise = actions.openLiteratureAttachment('paper', 'supplement', page)`,
    { loader: 'ts' }
  ).code
  let metadataGate: Promise<void> = Promise.resolve()
  workspace.synchronizePageTabs(['library'])
  const activatedTabs: string[] = []
  const open = async (page?: number) => {
    const result: { promise?: Promise<boolean> } = {}
    runInNewContext(compiled, {
      result,
      page,
      stateRef,
      resolveDocumentWorkspaceProject,
      LITERATURE_EXCERPT_VIEW_STATE_KEY,
      LITERATURE_EXCERPT_SOURCE_KIND: 'literature',
      CITATION_VIEW_STATE_KEY: 'citationFocus',
      ANNOTATION_VIEW_STATE_KEY: 'annotationFocus',
      OVERVIEW_TAB: { id: 'overview' },
      assistantProject: () => ({ projectId: 'project' }),
      actRef: { current: { patchLiterature: () => {}, noticeLiterature: () => {} } },
      getLiterature: async () => {
        await metadataGate
        return {
          title: 'Paper',
          attachments: [
            {
              id: 'supplement',
              name: 'supplement.pdf',
              record_target: literatureSource.recordTarget,
              media_type: 'application/pdf',
            },
          ],
        }
      },
      resourceNameParts: (name: string) => ({ basename: name }),
      literatureText: (key: string) => key,
      documentWorkspaces: { forProject: () => workspace },
      setState: (update: (state: typeof stateRef.current) => typeof stateRef.current) => {
        stateRef.current = update(stateRef.current)
        activatedTabs.push(stateRef.current.activeTab)
      },
    })
    return result.promise!
  }
  assert.equal(await open(3), true)
  const id = stateRef.current.activeTab
  assert.deepEqual(activatedTabs, [id])
  const first = workspace.getSnapshot().tabs[id]
  workspace.focusTab('library')
  const workbench = readFileSync(
    new URL('./features/workbench/Workbench.tsx', import.meta.url),
    'utf8'
  )
  const focusEffect = block(workbench, 'useLayoutEffect(() => {', 'const visibleTabs')
  const compiledFocus = transformSync(focusEffect, { loader: 'ts' }).code
  runInNewContext(compiledFocus, {
    useLayoutEffect: (callback: () => void) => callback(),
    workspace,
    pageIds: JSON.stringify(['library']),
    state: stateRef.current,
  })
  assert.equal(workspace.getSnapshot().focusedTabId, id)
  workspace.setTabViewState(id, { ...first.viewState, custom: 'retained' })
  for (const mainView of ['resource', 'literature']) {
    stateRef.current = { ...stateRef.current, mainView }
    assert.equal(await open(), true)
    const snapshot = workspace.getSnapshot()
    const tab = snapshot.tabs[id]
    assert.equal(stateRef.current.mainView, mainView)
    assert.equal(stateRef.current.activeTab, id)
    assert.equal(tab.sessionId, first.sessionId)
    assert.equal(tab.navigationView, mainView)
    assert.equal(tab.viewState?.page, 3)
    assert.equal(tab.viewState?.custom, 'retained')
    assert.equal(
      (tab.viewState?.[LITERATURE_EXCERPT_VIEW_STATE_KEY] as { literatureId: string }).literatureId,
      'paper'
    )
  }
  let release!: () => void
  metadataGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = open(9)
  stateRef.current = {
    ...stateRef.current,
    homeSelectedProjectId: 'other',
    activeTab: 'other-list',
  }
  release()
  assert.equal(await pending, false)
  assert.equal(stateRef.current.activeTab, 'other-list')
  assert.equal(workspace.getSnapshot().tabs[id].viewState?.page, 3)
  workspace.requestClose(id)
  metadataGate = Promise.resolve()
  stateRef.current = {
    mainView: 'resource',
    homeSelectedProjectId: 'project',
    activeTab: 'library',
  }
  loadGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const loading = new Promise<void>((resolve) => {
    startedLoading = resolve
  })
  const opening = open(9)
  await loading
  stateRef.current = {
    ...stateRef.current,
    homeSelectedProjectId: 'other',
    activeTab: 'other-list',
  }
  release()
  assert.equal(await opening, false)
  assert.equal(stateRef.current.activeTab, 'other-list')
  assert.equal(stateRef.current.mainView, 'resource')
  const oldWorkspace = workspace.getSnapshot()
  const oldTab = oldWorkspace.tabs[oldWorkspace.focusedTabId!]
  assert.equal(oldTab.navigationView, undefined)
  assert.equal(oldTab.viewState, undefined)
})

test('foreground split focus, moves and close fallback synchronize once without stealing business tabs', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const projectId = await workspace.open(
    { kind: 'project', project: 'project', path: 'papers/file.pdf' },
    'preview'
  )
  const literatureId = await workspace.open(literatureSource, 'edit')
  workspace.setTabNavigationView(literatureId, 'resource')
  const tabBar = readFileSync(new URL('./shell/TabBar.tsx', import.meta.url), 'utf8')
  const effect = block(tabBar, 'const focusedDocumentTabId', 'const documentTabIds')
  const compiled = transformSync(effect, { loader: 'ts' }).code
  const previousFocus = { current: literatureId as string | null }
  const synchronizedResourceFile = { current: null }
  const state = {
    mainView: 'resource',
    activeTab: literatureId,
    tabs: [],
    aiPanel: { cover: false },
    resource: {
      selected: '',
      tree: [
        {
          path: 'papers',
          name: 'papers',
          kind: 'dir' as const,
          children: [{ path: 'papers/file.pdf', name: 'file.pdf', kind: 'file' as const }],
        },
        { path: 'other', name: 'other', kind: 'dir' as const, children: [] },
      ],
      expanded: {} as Record<string, boolean>,
    },
    composerText: 'unsent',
  }
  const resourceActions = {
    value: null as unknown as {
      selectResourceFile: (path: string) => void
      toggleResourceDir: (path: string) => Promise<void>
    },
  }
  runInNewContext(
    transformSync(
      `result.value = {${block(storeSource, 'selectResourceFile: (path) =>', 'revealResourceFile:')}
      ${block(storeSource, 'toggleResourceDir: async', 'ensureResourceChildren:')}}`,
      { loader: 'ts' }
    ).code,
    {
      result: resourceActions,
      expandedResourceAncestors,
      stateRef: { current: state },
      actRef: { current: { ensureResourceChildren: async () => {} } },
      setState: (update: (current: typeof state) => typeof state) => {
        Object.assign(state, update(state))
      },
    }
  )
  let activations = 0
  const render = () => {
    let refIndex = 0
    runInNewContext(compiled, {
      documents: workspace.getSnapshot(),
      state,
      workspace,
      documentNavigationView,
      shouldRestoreDocumentFocus,
      React: {
        useRef: () => [previousFocus, synchronizedResourceFile][refIndex++],
        useEffect: (effect: () => void) => effect(),
      },
      act: {
        activateTab: (id: string) => {
          activations += 1
          const snapshot = workspace.getSnapshot()
          const tab = snapshot.tabs[id]
          const session = snapshot.sessions[tab.sessionId]
          const view = session.source.kind === 'project' ? 'resource' : state.mainView
          workspace.setTabNavigationView(id, view as 'resource' | 'literature')
          workspace.focusTab(id)
          state.mainView = view
          state.activeTab = id
        },
        selectResourceFile: resourceActions.value.selectResourceFile,
      },
    })
  }
  render()
  assert.equal(activations, 0)
  const splitId = await workspace.splitTab(projectId, 'right', true)
  assert.ok(splitId)
  render()
  assert.equal(state.activeTab, splitId)
  assert.equal(state.resource.selected, 'papers/file.pdf')
  assert.equal(state.resource.expanded.papers, true)
  render()
  assert.equal(activations, 1)
  for (const path of ['other', 'other', 'papers']) {
    await resourceActions.value.toggleResourceDir(path)
    const selectedResource = state.resource
    render()
    assert.equal(state.resource, selectedResource)
    assert.equal(state.resource.selected, path)
  }
  assert.equal(state.resource.expanded.papers, false)
  const root = workspace.getSnapshot().layout.areas.primary
  assert.equal(root.kind, 'split')
  if (root.kind !== 'split' || root.first.kind !== 'leaf') throw new Error('expected split')
  workspace.focusLeaf('primary', root.first.id)
  render()
  assert.equal(state.activeTab, literatureId)
  assert.equal(state.mainView, 'resource')
  assert.equal(await workspace.moveTabToAdjacent(literatureId, 'right'), true)
  render()
  workspace.requestClose(literatureId)
  render()
  assert.equal(state.activeTab, workspace.getSnapshot().focusedTabId)
  assert.equal(state.activeTab, projectId)
  assert.equal(state.resource.selected, 'papers/file.pdf')
  assert.equal(state.resource.expanded.papers, true)
  const beforeStable = activations
  render()
  assert.equal(activations, beforeStable)
  const otherId = await workspace.open(literatureSource, 'edit')
  for (const activeTab of ['literature', 'new-tab']) {
    state.activeTab = activeTab
    render()
    workspace.focusTab(projectId)
    render()
    workspace.focusTab(otherId)
    render()
    assert.equal(state.activeTab, activeTab)
  }
  assert.equal(activations, beforeStable)
  assert.equal(state.composerText, 'unsent')
})

test('closing a citation document returns to the fullscreen assistant without reopening a remaining document', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const fallbackId = await workspace.open(
    { ...literatureSource, attachmentId: 'primary', path: 'primary.pdf' },
    'edit'
  )
  workspace.setTabNavigationView(fallbackId, 'resource')
  const citationId = await workspace.open(literatureSource, 'edit')
  const stateRef = {
    current: {
      mainView: 'resource',
      homeSelectedProjectId: 'project',
      activeTab: fallbackId,
      tabs: [],
      resource: { selected: '' },
      aiPanel: { open: true, cover: true },
    },
  }
  const result = {
    actions: null as unknown as {
      activateTab: (id: string, options?: { returnToExpandedAssistantOnClose: boolean }) => void
    },
  }
  const setState = (update: (current: typeof stateRef.current) => typeof stateRef.current) => {
    stateRef.current = update(stateRef.current)
  }
  runInNewContext(
    transformSync(
      `${block(storeSource, 'function mainViewForDocumentSource', '/**')}
      result.actions = {${block(storeSource, 'activateTab: (id, options) => {', 'openVersionDiff:')}}`,
      { loader: 'ts' }
    ).code,
    {
      result,
      stateRef,
      setState,
      expandedAssistantReturns: { current: new Map() },
      availabilityPolicy: { tabIdAvailable: () => true },
      assistantProject: () => ({ projectId: 'project' }),
      documentWorkspaces: { forProject: () => workspace },
    }
  )
  result.actions.activateTab(citationId, { returnToExpandedAssistantOnClose: true })
  assert.equal(stateRef.current.aiPanel.cover, false)
  const tabBar = readFileSync(new URL('./shell/TabBar.tsx', import.meta.url), 'utf8')
  const compiled = transformSync(
    block(tabBar, 'const focusedDocumentTabId', 'const documentTabIds'),
    { loader: 'ts' }
  ).code
  const previousFocus = { current: citationId }
  const synchronizedResourceFile = { current: null }
  const render = () => {
    let refIndex = 0
    runInNewContext(compiled, {
      documents: workspace.getSnapshot(),
      state: stateRef.current,
      workspace,
      documentNavigationView,
      shouldRestoreDocumentFocus,
      React: {
        useRef: () => [previousFocus, synchronizedResourceFile][refIndex++],
        useEffect: (effect: () => void) => effect(),
      },
      act: result.actions,
    })
  }
  render()
  workspace.requestClose(citationId)
  assert.equal(stateRef.current.aiPanel.cover, true)
  assert.equal(workspace.getSnapshot().focusedTabId, fallbackId)
  render()
  assert.equal(stateRef.current.aiPanel.cover, true)
  const workbench = readFileSync(
    new URL('./features/workbench/Workbench.tsx', import.meta.url),
    'utf8'
  )
  runInNewContext(
    transformSync(block(workbench, '  useEffect(() => {', '  const dockActive ='), {
      loader: 'ts',
    }).code,
    {
      state: stateRef.current,
      activeTabNeedsSync: !workspace.getSnapshot().tabs[stateRef.current.activeTab],
      fallbackTabId: fallbackId,
      synchronizeWorkbenchTab,
      useEffect: (effect: () => void) => effect(),
      set: (update: (current: typeof stateRef.current) => Partial<typeof stateRef.current>) => {
        setState((current) => ({ ...current, ...update(current) }))
      },
    }
  )
  render()
  assert.equal(stateRef.current.activeTab, fallbackId)
  assert.equal(stateRef.current.mainView, 'resource')
  assert.equal(stateRef.current.aiPanel.cover, true)
})

test('business tab closing uses the focused literature reading surface as its fallback', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const id = await workspace.open(literatureSource, 'edit')
  workspace.setTabNavigationView(id, 'resource')
  const helper = block(storeSource, 'function closeTabContext', '/**')
  const compiled = transformSync(`${helper}; result.value = closeTabContext(current)`, {
    loader: 'ts',
  }).code
  for (const mainView of ['resource', 'literature']) {
    const result: { value?: { viewFallbackId: string | null } } = {}
    runInNewContext(compiled, {
      current: { homeSelectedProjectId: 'project', mainView },
      result,
      documentNavigationView,
      documentWorkspaces: { forProject: () => workspace },
    })
    assert.equal(result.value?.viewFallbackId, mainView === 'resource' ? id : null)
  }
})

interface ClosingWorkbenchState {
  mainView: string
  homeSelectedProjectId: string | null
  activeSession: string | null
  activeTab: string
  tabs: WorkbenchTab[]
  resource: { webSearches: Record<string, unknown> }
}

function closeWorkbenchForTest(
  workspaces: ReadonlyMap<string | null, DocumentWorkspace>,
  initial: ClosingWorkbenchState,
  closingId: string
): ClosingWorkbenchState {
  const stateRef = { current: initial }
  const helper = block(storeSource, 'function closeTabContext', '/**')
  const action = block(storeSource, 'closeWorkbenchTab: (id) => {', 'completeResourceReview:')
  runInNewContext(
    transformSync(`${helper}; const actions = {${action}}; actions.closeWorkbenchTab(closingId)`, {
      loader: 'ts',
    }).code,
    {
      closingId,
      stateRef,
      closeTab,
      mainViewForWorkbenchTab,
      newProjectTab,
      openFixedTab,
      OVERVIEW_TAB,
      documentNavigationView,
      assistantProject: () => ({ projectId: null }),
      documentWorkspaces: {
        forProject: (projectId: string | null) => {
          const workspace = workspaces.get(projectId)
          assert.ok(workspace, `unexpected workspace ${projectId}`)
          return workspace
        },
      },
      beginNavigation: () => ({}),
      webSearchInvocations: { current: new Map() },
      setState: (update: (state: ClosingWorkbenchState) => ClosingWorkbenchState) => {
        stateRef.current = update(stateRef.current)
      },
    }
  )
  return stateRef.current
}

const closingBrowser: WorkbenchTab = {
  id: 'browser-to-close',
  kind: 'browser',
  title: 'Browser',
  closable: true,
}

function browserClosingState(
  tabs: WorkbenchTab[] = [OVERVIEW_TAB, closingBrowser]
): ClosingWorkbenchState {
  return {
    mainView: 'browser',
    homeSelectedProjectId: 'project',
    activeSession: null,
    activeTab: closingBrowser.id,
    tabs,
    resource: { webSearches: {} },
  }
}

test('closing a browser restores the focused document and its navigation without losing edits', async () => {
  for (const view of ['resource', 'literature'] as const) {
    for (const source of [
      { kind: 'project' as const, project: 'project', path: 'notes.md' },
      literatureSource,
    ]) {
      if (source.kind === 'project' && view === 'literature') continue
      const workspace = new DocumentWorkspace({
        ...documentLoader,
        async load(source) {
          const loaded = await documentLoader.load(source)
          assert.ok(!isDocumentLoadFailure(loaded))
          return {
            ...loaded,
            text: 'Original body',
            capabilities: { ...loaded.capabilities, can_edit: true },
          }
        },
      })
      const id = await workspace.open(source, 'edit')
      workspace.setTabNavigationView(id, view)
      workspace.setTabViewState(id, { page: 4 })
      workspace.updateText(workspace.getSnapshot().tabs[id].sessionId, 'Unsaved document body')
      const before = workspace.getSnapshot()
      const state = closeWorkbenchForTest(
        new Map([['project', workspace]]),
        browserClosingState(),
        closingBrowser.id
      )
      assert.equal(state.activeTab, id)
      assert.equal(state.mainView, view)
      assert.equal(workspace.getSnapshot(), before)
      assert.equal(before.sessions[before.tabs[id].sessionId].text, 'Unsaved document body')
      assert.equal(before.sessions[before.tabs[id].sessionId].dirty, true)
      assert.equal(before.tabs[id].viewState?.page, 4)
    }
  }
})

test('closing the last browser without a document opens a scoped new tab instead of an invisible overview', () => {
  const workspace = new DocumentWorkspace(documentLoader)
  for (const projectId of ['project', null]) {
    const initial = { ...browserClosingState(), homeSelectedProjectId: projectId }
    const state = closeWorkbenchForTest(
      new Map([[projectId, workspace]]),
      initial,
      closingBrowser.id
    )
    const active = state.tabs.find((tab) => tab.id === state.activeTab)
    assert.equal(active?.kind, 'new_tab')
    assert.equal(active?.projectId, projectId)
    assert.equal(state.mainView, 'resource')
    assert.equal(
      state.tabs.some((tab) => tab.id === closingBrowser.id),
      false
    )
  }
})

test('browser closing does not recover another project document', async () => {
  const own = new DocumentWorkspace(documentLoader)
  const other = new DocumentWorkspace(documentLoader)
  const otherId = await other.open(
    { kind: 'project', project: 'other', path: 'private.md' },
    'edit'
  )
  const state = closeWorkbenchForTest(
    new Map([
      ['project', own],
      ['other', other],
    ]),
    browserClosingState(),
    closingBrowser.id
  )
  assert.notEqual(state.activeTab, otherId)
  assert.equal(state.tabs.find((tab) => tab.id === state.activeTab)?.kind, 'new_tab')
  assert.equal(other.getSnapshot().focusedTabId, otherId)
})

test('closing an inactive browser preserves the active document navigation and focus', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const id = await workspace.open(literatureSource, 'edit')
  workspace.setTabNavigationView(id, 'resource')
  const initial = { ...browserClosingState(), mainView: 'resource', activeTab: id }
  const state = closeWorkbenchForTest(new Map([['project', workspace]]), initial, closingBrowser.id)
  assert.equal(state.activeTab, id)
  assert.equal(state.mainView, 'resource')
  assert.equal(workspace.getSnapshot().focusedTabId, id)
})

test('browser closing resolves a same-pane document to its owning view', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const id = await workspace.open(literatureSource, 'edit')
  workspace.setTabNavigationView(id, 'resource')
  workspace.openPageTab(closingBrowser.id)
  workspace.focusTab(closingBrowser.id)
  const state = closeWorkbenchForTest(
    new Map([['project', workspace]]),
    browserClosingState(),
    closingBrowser.id
  )
  assert.equal(state.activeTab, id)
  assert.equal(state.mainView, 'resource')
})

test('browser closing restores the last focused split without altering the document layout', async () => {
  const workspace = new DocumentWorkspace(documentLoader)
  const first = await workspace.open(literatureSource, 'edit')
  workspace.setTabNavigationView(first, 'resource')
  const split = await workspace.splitTab(first, 'right', false)
  assert.ok(split)
  const snapshot = workspace.getSnapshot()
  for (const focused of [split, first]) {
    workspace.focusTab(focused)
    const state = closeWorkbenchForTest(
      new Map([['project', workspace]]),
      browserClosingState(),
      closingBrowser.id
    )
    assert.equal(state.activeTab, focused)
    assert.equal(state.mainView, 'resource')
    assert.deepEqual(workspace.getSnapshot().layout.areas, snapshot.layout.areas)
    assert.equal(Object.keys(workspace.getSnapshot().tabs).length, 2)
  }
})

test('a project-targeted draft navigates out of global pages before requesting submission', () => {
  const helper = block(storeSource, 'function assistantSessionView', 'function activateSession')
  assert.match(helper, /if \(projectId\) return ASSISTANT_FALLBACK_VIEW/)
  const draft = block(storeSource, 'startDraft: (seed = {}) => {', 'applyModelCatalog:')
  assert.match(draft, /mainView: assistantSessionView\(current, seed\.projectId\)/)
  assert.match(draft, /composerSubmitRequested: seed\.submit \?\? false/)
  assert.match(draft, /homeSelectedProjectId: seed\.projectId \?\? null/)
})

test('an exact draft checks its source before changing the existing draft and selection', () => {
  const action = block(storeSource, 'startDraft: (seed = {}) => {', 'applyModelCatalog:')
  const compiled = transformSync(`const actions = {${action}}; actions.startDraft(seed)`, {
    loader: 'ts',
    format: 'cjs',
  }).code
  for (const available of [false, true]) {
    let state = {
      model: 'previous-model',
      draftModelId: null,
      activeSession: 'original-task',
      modelSelectionGeneration: 4,
      draftGeneration: 2,
      aiPanel: {},
      catalog: { models: [{ key: 'original-model', disabled: !available }] },
    }
    let draft = 'Existing draft'
    const execute = () =>
      runInNewContext(compiled, {
        seed: { modelId: 'original-model', composerText: 'Visible history', submit: false },
        stateRef: {
          get current() {
            return state
          },
        },
        composerDraft: {
          current: {
            reset: (value: string) => {
              draft = value
            },
            set: (value: string) => {
              draft = value
            },
          },
        },
        HOME_RESET: { activeSession: null, draftModelId: null },
        assistantSessionView: () => 'resource',
        rememberScopeConversation: () => {},
        rememberSessionDraft: () => {},
        currentScopeKey: () => null,
        setState: (update: (current: typeof state) => typeof state) => {
          state = update(state)
        },
      })
    if (!available) {
      assert.throws(execute, /draft_model_unavailable/)
      assert.equal(draft, 'Existing draft')
      assert.equal(state.model, 'previous-model')
      assert.equal(state.activeSession, 'original-task')
    } else {
      execute()
      assert.equal(draft, 'Visible history')
      assert.equal(state.model, 'original-model')
      assert.equal(state.draftModelId, 'original-model')
      assert.equal(state.modelSelectionGeneration, 5)
      assert.equal(state.activeSession, null)
      assert.equal(
        (state as typeof state & { composerSubmitRequested: boolean }).composerSubmitRequested,
        false
      )
    }
  }
})

test('catalog refresh preserves an exact draft source even when it disappears or is disabled', () => {
  const action = block(storeSource, 'applyModelCatalog: (catalog) =>', 'setPersonalProfiles:')
  const compiled = transformSync(
    `const actions = {${action}}; actions.applyModelCatalog(catalog)`,
    {
      loader: 'ts',
      format: 'cjs',
    }
  ).code
  for (const models of [
    [{ key: 'original-model', disabled: true }, { key: 'paid-model' }],
    [{ key: 'paid-model' }],
  ]) {
    for (const activeSession of [null, 'attachment-session']) {
      let state = {
        serviceInstanceId: 'service',
        activeSession,
        model: 'original-model',
        draftModelId: 'original-model',
        catalog: {},
      }
      runInNewContext(compiled, {
        catalog: {
          service_instance_id: 'service',
          current_model: 'paid-model',
          available_models: models,
        },
        selectableCatalogModelKey: () => 'paid-model',
        setState: (update: (current: typeof state) => typeof state) => {
          state = update(state)
        },
      })
      assert.equal(state.model, 'original-model')
      assert.equal(state.draftModelId, 'original-model')
    }
  }
})

test('explicit model selection moves the exact draft constraint but reasoning preparation does not', async () => {
  const callback = block(
    storeSource,
    'const prepareModel = useCallback(',
    'const runModelSelection = useCallback('
  )
  const compiled = transformSync(
    `${callback}; result.pending = prepareModel(modelId, persistDefault)`,
    {
      loader: 'ts',
      format: 'cjs',
    }
  ).code
  for (const choice of [
    {
      pinned: 'original-model',
      persistDefault: false,
      modelId: 'original-model',
      expected: 'original-model',
    },
    {
      pinned: 'original-model',
      persistDefault: true,
      modelId: 'chosen-paid-model',
      expected: 'chosen-paid-model',
    },
    {
      pinned: 'original-model',
      persistDefault: true,
      modelId: 'original-model',
      expected: 'original-model',
    },
    { pinned: null, persistDefault: true, modelId: 'chosen-paid-model', expected: null },
  ]) {
    let state = {
      model: 'original-model',
      draftModelId: choice.pinned,
      serviceInstanceId: 'service',
      draftGeneration: 2,
      modelSelectionGeneration: 4,
      homeSelectedProjectId: null,
      activeSession: null,
    }
    const result: { pending?: Promise<unknown> } = {}
    runInNewContext(compiled, {
      result,
      modelId: choice.modelId,
      persistDefault: choice.persistDefault,
      useCallback: (callback: unknown) => callback,
      stateRef: {
        get current() {
          return state
        },
      },
      preparationSequenceRef: { current: 0 },
      preparationIntentRef: { current: null },
      preparationSnapshot: (current: typeof state) => ({
        model: current.draftModelId || current.model,
      }),
      preparationController: () => ({ prepare: () => Promise.resolve({ state: 'applied' }) }),
      preparationContextMatches: () => true,
      PREPARATION_INSTANCE_CHANGED_ERROR: 'instance_changed',
      PREPARATION_SUPERSEDED_ERROR: 'superseded',
      flushSync: (callback: () => void) => callback(),
      setState: (update: (current: typeof state) => typeof state) => {
        state = update(state)
      },
    })
    await result.pending
    assert.equal(state.draftModelId, choice.expected)
    assert.equal(state.model, choice.modelId)
  }
})

test('a skill task retains its description through workbench tab synchronization', () => {
  const helper = block(storeSource, 'function assistantSessionView', 'function activateSession')
  const reset = block(storeSource, 'const HOME_RESET:', 'const SESSION_META')
  const action = block(storeSource, 'startDraft: (seed = {}) => {', 'applyModelCatalog:')
  const setter = block(storeSource, 'const set = useCallback', 'const closeMenus = useCallback')
  const compiled = transformSync(
    `${helper}\n${reset}\n${setter}\nconst actions = {${action}};
    actions.startDraft(seed);
    set((current) => synchronizeWorkbenchTab(current, current, 'restored-document'));
    set((current) => synchronizeWorkbenchTab(current, current, 'restored-document'));
    set((current) => synchronizeWorkbenchTab(current, { ...current, activeTab: 'stale' }, 'other'))`,
    {
      loader: 'ts',
      format: 'cjs',
    }
  ).code
  const reference = { type: 'skill', id: 'test-skill', path: '/skills/test-skill' }
  for (const mainView of ['skills', 'literature', 'home', 'resource']) {
    let state = {
      mainView,
      activeSession: 'old-task',
      workbenchReady: false,
      aiPanel: { open: false },
      composerText: '',
    }
    let draft = ''
    runInNewContext(compiled, {
      ASSISTANT_FALLBACK_VIEW: 'resource',
      useCallback: (callback: unknown) => callback,
      stateRef: { current: state },
      settingsSurface: { current: { project: () => ({}) } },
      availabilityPolicy: { navigationPatch: (_current: unknown, patch: unknown) => patch },
      synchronizeWorkbenchTab,
      SURFACE_RESET: {},
      COMPOSER_RESET: { composerRefs: [], composerSubmitRequested: false },
      seed: {
        projectId: 'selected-project',
        composerText: 'Describe this skill',
        composerRefs: [reference],
        submit: true,
      },
      composerDraft: {
        current: {
          reset: (value: string) => {
            draft = value
          },
          set: (value: string) => {
            draft = value
          },
        },
      },
      setState: (update: (current: typeof state) => typeof state) => {
        state = update(state)
      },
      rememberScopeConversation: () => {},
      window: { localStorage: {} },
      readContinuityRecord: () => ({}),
      rememberContinuity: () => ({}),
      rememberSessionDraft: () => {},
    })
    const result = state as typeof state & {
      homeSelectedProjectId: string
      composerRefs: unknown[]
      composerSubmitRequested: boolean
      activeTab: string
    }
    assert.equal(result.mainView, 'resource')
    assert.equal(result.activeSession, null)
    assert.equal(result.homeSelectedProjectId, 'selected-project')
    assert.equal(result.composerRefs[0], reference)
    assert.equal(result.composerSubmitRequested, true)
    assert.equal(result.activeTab, 'restored-document')
    assert.equal(draft, 'Describe this skill')
  }
})

test('contextual skill navigation preserves the draft and session; global navigation clears scope', () => {
  const action = block(storeSource, 'openWorkbenchView: (view, options) =>', 'toggleModulePanel:')
  const compiled = transformSync(
    `const actions = {${action}}; actions.openWorkbenchView('skills', options)`,
    {
      loader: 'ts',
      format: 'cjs',
    }
  ).code
  for (const preserveProject of [true, false]) {
    let state = {
      mainView: 'resource',
      homeSelectedProjectId: 'project',
      activeSession: 'session',
      tabs: [],
      activeTab: 'conversation',
      accountSettingsPage: null,
      composerRefs: [{ type: 'skill', id: 'selected' }],
    }
    let draft = 'Keep this unsent text'
    runInNewContext(compiled, {
      options: preserveProject ? { preserveProject: true, returnProjectId: 'project' } : undefined,
      availabilityPolicy: { routeAvailable: () => true },
      fixedTabForView: () => null,
      activeTabForWorkbenchView: () => 'skills',
      documentWorkspaces: { forProject: () => ({ getSnapshot: () => ({ tabs: {} }) }) },
      rememberScopeConversation: () => {},
      assistantProject: () => ({ projectId: 'project' }),
      rememberSessionDraft: () => {},
      assistantScopeReset: () => ({ activeSession: null, composerRefs: [] }),
      composerDraft: {
        current: {
          set: (value: string) => {
            draft = value
          },
        },
      },
      SURFACE_RESET: { accountSettingsPage: null },
      LITERATURE_SCOPE_KEY: 'literature',
      setState: (update: (current: typeof state) => typeof state) => {
        state = update(state)
      },
    })
    const result = state as typeof state & { workbenchReturnProjectId: string | null }
    assert.equal(result.mainView, 'skills')
    assert.equal(result.accountSettingsPage, null)
    assert.equal(result.homeSelectedProjectId, preserveProject ? 'project' : null)
    assert.equal(result.activeSession, preserveProject ? 'session' : null)
    assert.equal(result.composerRefs.length, preserveProject ? 1 : 0)
    assert.equal(result.workbenchReturnProjectId, preserveProject ? 'project' : null)
    assert.equal(draft, preserveProject ? 'Keep this unsent text' : '')
  }
})

test('project center restores the remembered project unless explicitly returning to overview', () => {
  const navigation = block(
    storeSource,
    'openProjectCenter: (options) => {',
    'selectProject: (projectId) => {'
  )
  assert.match(navigation, /if \(options\?\.overview\) \{\s*actRef\.current\.returnHome\(\)/)
  const returnHome = block(storeSource, 'returnHome: () => {', 'openProjectCenter:')
  assert.match(returnHome, /rememberedProjectId\.current = null/)
  assert.match(returnHome, /openWorkbenchView\('home'\)/)
  assert.match(navigation, /current\.projects\.some\(\(project\) => project\.id === projectId\)/)
  assert.match(
    navigation,
    /current\.homeSelectedProjectId === projectId && current\.mainView === 'resource'\) return/
  )
  assert.match(navigation, /selectProject\(projectId\)/)
  assert.match(navigation, /openWorkbenchView\('resource', \{ preserveProject: true \}\)/)
  const rail = readFileSync(new URL('./shell/ActivityRail.tsx', import.meta.url), 'utf8')
  const project = readFileSync(
    new URL('./features/project/Navigation.tsx', import.meta.url),
    'utf8'
  )
  assert.match(rail, /view\.key === 'home'\s*\? act\.openProjectCenter\(\)/)
  assert.match(project, /act\.openProjectCenter\(\{ overview: true \}\)/)
})

const initialBlock = block(storeSource, 'const INITIAL: AppState = {', 'const MENU_KEYS')
const menuKeysBlock = block(storeSource, 'const MENU_KEYS', 'const SURFACE_RESET')
const selectorBlock = block(
  storeSource,
  'export const activeThread',
  'export function activeDocumentForTurn'
)
const storeInterface = block(storeSource, 'export interface Store {', 'function PreferenceFailure')

test('the store context is a real React context whose default value is null', () => {
  const context = StoreContext as unknown as {
    $$typeof: symbol
    _currentValue: unknown
    Provider: unknown
    Consumer: unknown
  }
  assert.equal(context.$$typeof, Symbol.for('react.context'))
  // 默认值必须是 null：useApp 才能在 provider 之外显式抛错，而不是把 undefined 当 state 用。
  assert.equal(context._currentValue, null)
  assert.ok(context.Provider)
  assert.ok(context.Consumer)
})

test('the context lives in its own module so store.tsx stays a single Fast Refresh boundary', () => {
  assert.match(storeSource, /import \{ StoreContext \} from '\.\/storeContext'/)
  // store.tsx 里再建一个 context，就会让 provider 与 consumer 分属两个实例（见 storeContext.ts 注释）。
  assert.doesNotMatch(storeSource, /createContext/)
  assert.match(
    storeSource,
    /<StoreContext\.Provider value=\{value\}>\s*<NavigationRecoveryContext\.Provider value=\{act\.returnHome\}>\s*<WebNavigationContext\.Provider value=\{navigateWebPage\}>\s*\{children\}\s*<\/WebNavigationContext\.Provider>\s*<\/NavigationRecoveryContext\.Provider>\s*<\/StoreContext\.Provider>/
  )
  assert.match(storeSource, /const value = useContext\(StoreContext\)/)
  assert.match(storeSource, /if \(!value\) throw new Error\('useApp outside StoreProvider'\)/)
})

test('the store surface exposes the isolated composer draft plus the existing entry points', () => {
  for (const member of [
    'state: AppState',
    'set: (patch: Patch, cause?: NavigationCause) => void',
    'composerDraft: ComposerDraftStore',
    'closeMenus: () => void',
    'act: Actions',
    'patchThread:',
    'appendThread:',
  ]) {
    assert.match(storeInterface, new RegExp(member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const requiredCause = storeInterface.replace('cause?: NavigationCause', 'cause: NavigationCause')
  assert.notEqual(requiredCause, storeInterface)
  assert.doesNotMatch(requiredCause, /set: \(patch: Patch, cause\?: NavigationCause\) => void/)
  const valueBlock = block(storeSource, 'const value = useMemo(', '<StoreContext.Provider')
  assert.match(valueBlock, /composerDraft: composerDraft\.current!/)
  assert.match(
    valueBlock,
    /\[\s*state,\s*getSnapshot,\s*prepareModel,\s*runModelSelection,\s*rememberEffort,\s*set,\s*closeMenus,\s*act,\s*patchThread,\s*appendThread,?\s*\]/
  )
})

test('initial state starts on the home space with no project, session or backend', () => {
  assert.match(initialBlock, /mainView: 'home'/)
  assert.match(initialBlock, /homeSelectedProjectId: null/)
  assert.match(initialBlock, /workspacePath: null/)
  assert.match(initialBlock, /defaultWorkspacePath: null/)
  assert.match(initialBlock, /projects: \[\]/)
  assert.match(initialBlock, /activeSession: null/)
  assert.match(initialBlock, /threads: \{\}/)
  assert.match(initialBlock, /sessions: \[\]/)
  assert.match(initialBlock, /turnLaunch: null/)
  assert.match(initialBlock, /backendReady: false/)
  assert.match(initialBlock, /workspaceLoadState: 'loading'/)
  assert.match(initialBlock, /serviceInstanceId: null/)
  assert.match(initialBlock, /runtimeReadiness: null/)
  assert.match(initialBlock, /runtimeCapabilities: null/)
  assert.match(initialBlock, /foregroundError: null/)
  assert.match(initialBlock, /foregroundNotice: null/)
})

test('initial state starts with an empty composer, the overview tab and closed overlays', () => {
  assert.match(initialBlock, /composerText: ''/)
  assert.match(initialBlock, /composerTaskType: ''/)
  assert.match(initialBlock, /composerRefs: \[\]/)
  assert.match(initialBlock, /tabs: \[OVERVIEW_TAB\]/)
  assert.match(initialBlock, /activeTab: OVERVIEW_TAB\.id/)
  assert.match(initialBlock, /globalSearchOpen: false/)
  assert.match(initialBlock, /globalSearchMode: 'all'/)
  assert.match(initialBlock, /recallOpen: false/)
  assert.match(initialBlock, /loginOpen: false/)
  assert.match(initialBlock, /feedbackOpen: false/)
  assert.match(initialBlock, /accountMenuOpen: false/)
  assert.match(initialBlock, /accountSettingsPage: null/)
  assert.match(initialBlock, /skillUploadOpen: false/)
  assert.match(initialBlock, /workspaceFilesOpen: false/)
  assert.match(initialBlock, /confirmDelete: null/)
  assert.match(initialBlock, /projectForm: null/)
  // 模块面板是唯一默认展开的常驻面板；PDF 侧栏默认收起。
  assert.match(initialBlock, /modulePanelOpen: true/)
  assert.match(initialBlock, /pdfSidePanelOpen: false/)
})

test('permission, collaboration and usage defaults initialize consistently', () => {
  assert.match(initialBlock, /collaborationMode: 'default'/)
  assert.match(initialBlock, /globalPermissionMode: DEFAULT_GLOBAL_PERMISSION_MODE/)
  assert.match(initialBlock, /judgment: 'pending'/)
  assert.match(initialBlock, /usage: EMPTY_USAGE/)
  assert.match(initialBlock, /catalog: EMPTY_CATALOG/)
  assert.match(initialBlock, /resource: INITIAL_RESOURCE_STATE/)
  assert.match(initialBlock, /literature: INITIAL_LITERATURE_STATE/)
  assert.match(initialBlock, /aiPanel: INITIAL_AI_PANEL_STATE/)

  const usage = block(storeSource, 'const EMPTY_USAGE: UsageTotals = {', 'function collectionError')
  const totals = [...usage.matchAll(/(\w+): ([0-9]+)/g)].map(([, field, value]) => [
    field,
    Number(value),
  ])
  assert.ok(totals.length >= 4, 'usage totals lost fields')
  for (const [, value] of totals) assert.equal(value, 0)

  const catalog = block(storeSource, 'const EMPTY_CATALOG: ModelCatalog = {', 'const EMPTY_USAGE')
  assert.match(catalog, /models: \[\]/)
  assert.match(catalog, /hiddenModels: \[\]/)
  assert.match(catalog, /subscriptionGroups: \[\]/)
  assert.match(catalog, /personalProfiles: null/)

  const homeThread = block(storeSource, 'const HOME_THREAD: Thread = {', 'const EMPTY_CATALOG')
  assert.match(homeThread, /id: 'home'/)
  assert.match(homeThread, /conversation: \[\]/)
  assert.match(homeThread, /sessionId: null/)
  assert.match(homeThread, /lastSeq: 0/)
})

test('persisted UX state is rehydrated from the host bridge instead of being hardcoded', () => {
  const initializer = block(storeSource, 'const INITIAL_PREFERENCES =', 'const MENU_KEYS')
  const compiled = transformSync(`${initializer}\nresult.state = INITIAL`, { loader: 'ts' }).code
  for (const language of ['en', 'zh', undefined] as const) {
    const saved = language && {
      ...defaultRendererPreferences(language),
      theme: 'dark',
      sidebarOpen: false,
      desktopNotifications: false,
      soundAlerts: false,
      autoSave: false,
      formatOnSave: true,
      editorWordWrap: false,
      shortcutOverrides: { 'code.save': { key: 's', modifiers: ['primary', 'shift'] } },
      recentFiles: [{ projectId: 'project', path: 'paper.pdf', openedAt: 7 }],
      recentLiterature: [{ id: 'paper', openedAt: 8 }],
      recentSessions: [{ id: 'session', openedAt: 9 }],
      sessionActivityInitialized: true,
      sessionActivitySeen: { session: 10 },
      reasoningPreferences: language === 'en' ? { model: 'high' } : undefined,
      selectionPrompts: { explain: 'Custom instruction', translate: ' ', polish: 42 },
      onboarding: { seen: { home: true, project: false }, recentProjectId: 'project' },
    }
    const preferences = saved ?? DEFAULT_RENDERER_PREFERENCES
    const result: { state: Record<string, unknown> } = { state: {} }
    const shortcuts: unknown[] = []
    runInNewContext(compiled, {
      result,
      window: saved ? { scholarseed: { preferences: saved } } : {},
      DEFAULT_RENDERER_PREFERENCES,
      sanitizeSelectionPrompts,
      sanitizeOnboarding,
      setActiveShortcutOverrides: (value: unknown) => shortcuts.push(value),
      DEFAULT_GLOBAL_PERMISSION_MODE: 'unused',
      DEFAULT_WORKDIR: { name: 'unused' },
      EMPTY_USAGE: {},
      EMPTY_CATALOG: {},
      INITIAL_CREDITS_STATE: {},
      INITIAL_RESOURCE_STATE: {},
      INITIAL_LITERATURE_STATE: {},
      INITIAL_AI_PANEL_STATE: {},
      DEFAULT_PROJECT_LAYOUT: {},
      OVERVIEW_TAB: { id: 'overview' },
    })
    const { state } = result
    for (const field of [
      'theme',
      'sidebarOpen',
      'shortcutOverrides',
      'dataSharingMode',
      'desktopNotifications',
      'soundAlerts',
      'autoSave',
      'formatOnSave',
      'editorWordWrap',
      'recentFiles',
      'recentLiterature',
      'recentSessions',
      'sessionActivityInitialized',
      'sessionActivitySeen',
    ] as const) {
      assert.equal(state[field], preferences[field], `${language ?? 'fallback'}: ${field}`)
    }
    assert.equal(state.lang, preferences.language)
    assert.deepEqual(shortcuts, [preferences.shortcutOverrides])
    assert.deepEqual(
      state.onboarding,
      saved ? { seen: { home: true }, recentProjectId: 'project' } : { seen: {} }
    )
    assert.deepEqual(
      state.selectionPrompts,
      saved
        ? { ...defaultSelectionPrompts(preferences.language), explain: 'Custom instruction' }
        : defaultSelectionPrompts('zh')
    )
    if (preferences.reasoningPreferences) {
      assert.equal(state.reasoningPreferences, preferences.reasoningPreferences)
    } else {
      assert.equal(Object.keys(state.reasoningPreferences as object).length, 0)
    }
  }
  assert.match(initialBlock, /onboarding: sanitizeOnboarding\(INITIAL_PREFERENCES\.onboarding\)/)
  assert.match(
    initialBlock,
    /selectionPrompts:\s*sanitizeSelectionPrompts\(\s*INITIAL_PREFERENCES\.selectionPrompts\s*,\s*INITIAL_PREFERENCES\.language\s*,?\s*\)/
  )
  assert.match(
    initialBlock,
    /reasoningPreferences: INITIAL_PREFERENCES\.reasoningPreferences \?\? \{\}/
  )
  assert.doesNotMatch(initialBlock, /theme: '/)
  assert.doesNotMatch(initialBlock, /lang: '/)
})

test('every transient menu flag starts closed and closeMenus clears exactly that list', () => {
  const menuKeys = [...menuKeysBlock.matchAll(/'([A-Za-z]+)'/g)].map(([, key]) => key)
  assert.deepEqual(menuKeys, [
    'newChooser',
    'modelMenuOpen',
    'wdMenuOpen',
    'notifPanelOpen',
    'accountMenuOpen',
    'homeProjectMenuOpen',
    'searchHint',
  ])
  for (const key of menuKeys) {
    assert.match(initialBlock, new RegExp(`${key}: false`), `${key} must start closed`)
  }
  const closeMenus = block(
    storeSource,
    'const closeMenus = useCallback',
    'const showAnswerAnnotationMutationFailure'
  )
  assert.match(closeMenus, /const next = \{ \.\.\.current \}/)
  assert.match(
    closeMenus,
    /for \(const key of MENU_KEYS\) \(next as Record<string, unknown>\)\[key\] = false/
  )
  assert.match(closeMenus, /return next/)
  // 常驻面板不属于「菜单」：closeMenus 不能顺手把模块面板也收起。
  assert.doesNotMatch(closeMenus, /modulePanelOpen/)
})

test('set routes composer text to its isolated store before merging the remaining patch', () => {
  assert.match(
    storeSource,
    /type Patch = Partial<AppState> \| \(\(state: AppState\) => Partial<AppState>\)/
  )
  const setBlock = block(storeSource, 'const set = useCallback', 'const closeMenus = useCallback')
  assert.match(
    setBlock,
    /const requested = typeof patch === 'function' \? patch\(current\) : patch\s*if \(requested === current\) return current\s*const delta = availabilityPolicy\.navigationPatch\(current, requested\)/
  )
  assert.match(setBlock, /Object\.prototype\.hasOwnProperty\.call\(delta, 'composerText'\)/)
  assert.match(setBlock, /composerDraft\.current!\.set\(delta\.composerText \?\? ''\)/)
  assert.match(setBlock, /const \{ composerText: _composerText, \.\.\.stateDelta \} = delta/)
  assert.match(setBlock, /if \(Object\.keys\(stateDelta\)\.length === 0\) return current/)
  assert.match(setBlock, /return \{ \.\.\.current, \.\.\.stateDelta, \.\.\.settings \}/)
})

test('patchThread is a no-op for a missing id or unknown thread and never invents one', () => {
  const patchThread = block(
    storeSource,
    'const patchThread = useCallback',
    'const appendThread = useCallback'
  )
  assert.match(patchThread, /if \(!id\) return current/)
  assert.match(patchThread, /const thread = current\.threads\[id\]\s*if \(!thread\) return current/)
  assert.match(patchThread, /const delta = typeof patch === 'function' \? patch\(thread\) : patch/)
  assert.match(patchThread, /const nextThread = \{ \.\.\.thread, \.\.\.delta \}/)
  assert.match(patchThread, /threads: \{ \.\.\.current\.threads, \[id\]: nextThread \}/)
})

test('thread status and title changes project onto the session tree together', () => {
  const compiled = transformSync(
    `${block(storeSource, 'const patchThread = useCallback', 'const appendThread = useCallback')}\nresult.patchThread = patchThread`,
    { loader: 'ts' }
  ).code
  const initial = () => ({
    activeSession: 'thread' as string | null,
    sessionCatalogRevision: 7,
    threads: {
      thread: {
        sessionId: 'session',
        title: 'New conversation',
        title_fallback: 'new_session',
        status: 'dormant',
        running: false,
      } as Pick<Thread, 'sessionId' | 'title' | 'title_fallback' | 'status' | 'running'>,
    },
    sessions: [
      {
        id: 'parent',
        title: 'Parent',
        status: 'dormant',
        children: [
          {
            id: 'session',
            title: 'New conversation',
            title_fallback: 'new_session',
            status: 'dormant',
          },
        ],
      },
      { id: 'unrelated', title: 'Unrelated', status: 'waiting' },
    ] as SessionNode[],
  })
  type Snapshot = ReturnType<typeof initial>
  type Patch = Partial<Thread> | ((thread: Thread) => Partial<Thread>)
  let state = initial()
  let updates = 0
  const result: { patchThread?: (id: string | null, patch: Patch) => void } = {}
  runInNewContext(compiled, {
    result,
    useCallback: (callback: unknown) => callback,
    setState: (update: (current: Snapshot) => Snapshot) => {
      updates += 1
      state = update(state)
    },
    findSessionNode,
    upsertSessionNode,
  })
  const patchThread = result.patchThread
  assert.ok(patchThread)
  for (const [patch, active, status, revision] of [
    [{ title: 'Named conversation', title_fallback: null, status: 'waiting' }, true, 'waiting', 8],
    [{ title: 'Named conversation' }, true, 'dormant', 8],
    [{ title_fallback: null }, true, 'dormant', 8],
    [{ title: 'New conversation', title_fallback: 'new_session' }, true, 'dormant', 7],
    [{ status: 'waiting', running: true }, true, 'waiting', 7],
    [{ running: true }, true, 'running', 7],
    [{ status: 'running' }, true, 'running', 7],
    [{ status: 'done' }, true, 'dormant', 7],
    [{ status: 'done' }, false, 'done', 7],
    [{ status: 'failed' }, true, 'failed', 7],
  ] satisfies [Partial<Thread>, boolean, SessionStatus, number][]) {
    state = initial()
    updates = 0
    if (!active) state.activeSession = 'another-thread'
    const previous = state
    const before = JSON.stringify(previous)
    patchThread('thread', patch)
    const thread = state.threads.thread
    const node = findSessionNode(state.sessions, 'session')!
    assert.equal(updates, 1)
    for (const [key, value] of Object.entries(patch))
      assert.equal(thread[key as keyof typeof thread], value)
    assert.equal(node.status, status)
    assert.equal(node.title, thread.title)
    assert.equal(node.title_fallback, thread.title_fallback)
    assert.equal(state.sessionCatalogRevision, revision)
    assert.equal(JSON.stringify(previous), before)
    assert.equal(state.sessions[1], previous.sessions[1])
    if (revision === 7 && !('status' in patch) && !('running' in patch))
      assert.equal(state.sessions, previous.sessions)
  }
  state = initial()
  const previous = state
  patchThread(null, { title: 'Not created' })
  patchThread('missing', { title: 'Not created' })
  patchThread('thread', () => previous.threads.thread)
  assert.equal(state, previous)
  patchThread('thread', () => ({ title: 'Functional rename', title_fallback: null }))
  assert.equal(findSessionNode(state.sessions, 'session')!.title, 'Functional rename')
  assert.equal(state.sessionCatalogRevision, 8)
  state = initial()
  state.sessions = [state.sessions[1]]
  const sessions = state.sessions
  patchThread('thread', { title: 'Not in tree', title_fallback: null })
  assert.equal(state.sessions, sessions)
  assert.equal(findSessionNode(state.sessions, 'session'), undefined)
  assert.equal(state.threads.thread.title, 'Not in tree')
  assert.equal(state.sessionCatalogRevision, 8)
  state = initial()
  state.threads.thread.sessionId = null
  state.sessions[0].children![0].id = 'thread'
  patchThread('thread', { title: 'Temporary session' })
  assert.equal(findSessionNode(state.sessions, 'thread')!.title, 'Temporary session')
  assert.equal(findSessionNode(state.sessions, 'session'), undefined)
  assert.equal(state.sessionCatalogRevision, 8)
})

test('appendThread appends to an existing thread conversation without mutating it', () => {
  const appendThread = block(
    storeSource,
    'const appendThread = useCallback',
    'const persistAssistantContext'
  )
  assert.match(appendThread, /if \(!id\) return current/)
  assert.match(
    appendThread,
    /const thread = current\.threads\[id\]\s*if \(!thread\) return current/
  )
  assert.match(appendThread, /conversation: \[\.\.\.thread\.conversation, item\]/)
})

test('reset bundles compose so returning home cannot keep stale metadata or surface state', () => {
  const surfaceReset = block(
    storeSource,
    'const SURFACE_RESET: Partial<AppState> = {',
    'const COMPOSER_RESET'
  )
  assert.match(surfaceReset, /workbenchReturnProjectId: null/)
  assert.match(surfaceReset, /foregroundError: null/)
  assert.match(surfaceReset, /capGallery: null/)
  assert.match(surfaceReset, /skillUploadOpen: false/)
  assert.match(surfaceReset, /workspaceFilesOpen: false/)
  assert.match(surfaceReset, /workspaceFilesSessionId: null/)
  assert.match(surfaceReset, /sessionRename: null/)

  const composerReset = block(
    storeSource,
    'const COMPOSER_RESET: Partial<AppState> = {',
    'function assistantScopeReset'
  )
  assert.doesNotMatch(composerReset, /composerText/)
  assert.match(composerReset, /composerTaskType: ''/)
  assert.match(composerReset, /composerRefs: \[\]/)

  const homeReset = block(
    storeSource,
    'const HOME_RESET: Partial<AppState> = {',
    'const SESSION_META'
  )
  assert.match(homeReset, /\.\.\.SURFACE_RESET/)
  assert.match(homeReset, /\.\.\.COMPOSER_RESET/)
  assert.match(homeReset, /mainView: 'home'/)
  assert.match(homeReset, /activeSession: null/)
  assert.match(homeReset, /turnLaunch: null/)
  assert.match(homeReset, /homeSelectedProjectId: null/)
  assert.match(homeReset, /homeProjectLocked: false/)
  assert.match(homeReset, /confirmDelete: null/)
  assert.match(homeReset, /searchHint: false/)

  // 换助手作用域时清空会话与草稿，但保留面板的展开/停靠/遮罩与已注册的来源列表。
  const assistantReset = block(storeSource, 'function assistantScopeReset', 'const HOME_RESET')
  assert.match(assistantReset, /\.\.\.COMPOSER_RESET/)
  assert.match(assistantReset, /activeSession: null/)
  assert.match(assistantReset, /turnLaunch: null/)
  assert.match(assistantReset, /\.\.\.INITIAL_AI_PANEL_STATE/)
  for (const preserved of ['open', 'docked', 'cover', 'contextSources']) {
    assert.match(assistantReset, new RegExp(`${preserved}: current\\.aiPanel\\.${preserved}`))
  }

  const clearSession = block(storeSource, 'clearSessionSelection: () => {', 'openSettings:')
  assert.match(clearSession, /composerDraft\.current!\.reset\(\)/)
  const startPanelDraft = block(storeSource, 'startPanelDraft: (seed = {}) => {', 'activateTab:')
  const startDraft = block(storeSource, 'startDraft: (seed = {}) => {', 'applyModelCatalog:')
  for (const draftStart of [startPanelDraft, startDraft]) {
    assert.match(draftStart, /composerDraft\.current!\.reset\(seed\.composerText \?\? ''\)/)
    assert.doesNotMatch(draftStart, /composerText: seed\.composerText/)
  }
})

test('selectors return the home fallback and null scopes instead of undefined', () => {
  assert.match(
    selectorBlock,
    /export const activeThread = \(state: AppState\): Thread =>\s*\(\s*state\.activeSession \? state\.threads\[state\.activeSession\] : undefined\s*\) \?\? HOME_THREAD/
  )
  assert.match(
    selectorBlock,
    /export const selectedProject = \(state: AppState\): Project \| null =>\s*state\.homeSelectedProjectId\s*\? \(state\.projects\.find\(\(project\) => project\.id === state\.homeSelectedProjectId\) \?\? null\)\s*: null/
  )
  assert.match(
    selectorBlock,
    /export const selectedProjectPath = \(state: AppState\): string \| null =>\s*selectedProject\(state\)\?\.path \?\? null/
  )
  // 草稿项目解析必须继续走 assistant 域的同一份口径，不能在 store 里另算一遍。
  assert.match(
    selectorBlock,
    /export const assistantProject = \(state: AppState\) =>\s*resolveAssistantProject\(\s*state\.activeSession,\s*activeThread\(state\)\.projectPath,\s*state\.homeSelectedProjectId,\s*state\.projects\s*\)/
  )
  // 项目范围有两个来源：已选项目，或用 SCHOLARSEED_DEFAULT_WORKSPACE 直接打开的目录。
  assert.match(
    selectorBlock,
    /export const hasProjectScope = \(state: AppState\): boolean =>\s*Boolean\(selectedProject\(state\) \|\| state\.resource\.root\)/
  )
})

test('invalidating the literature scope refreshes both caches without clearing user work', () => {
  const actions = block(
    storeSource,
    'export interface Actions extends AssistantIngress {',
    'export interface Store {'
  )
  assert.match(actions, /invalidateLiterature: \(\) => void/)
  const implementation = block(storeSource, 'invalidateLiterature: () => {', 'openDraftSession: (')
  // 文献数据有两份缓存: catalogue store 供面板/列表/详情, store 切片供首页「最近文献」。
  assert.match(implementation, /catalogue\.reload\(\)/)
  assert.match(implementation, /void actRef\.current\.reloadLiterature\(\)/)
  // 粗失效不等于清场: 勾选、筛选与已打开的详情抽屉都是用户的工作集, AI 改库不该收走。
  assert.doesNotMatch(implementation, /catalogue\.(clear|query|scope|filter)\(/)
})
