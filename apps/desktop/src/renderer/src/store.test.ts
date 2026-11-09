import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { block } from '../../test-helpers/source-contract.ts'

import { StoreContext } from './storeContext.ts'
import { literatureNavigation, synchronizeWorkbenchTab } from './features/workbench/tabs.ts'
import {
  DocumentWorkspace,
  documentNavigationView,
  type DocumentLoader,
} from './features/workbench/workspace.ts'
import { resolveDocumentWorkspaceProject } from './features/workbench/scope.ts'
import { LITERATURE_EXCERPT_VIEW_STATE_KEY } from './contracts/resources.ts'
import { documentIdFor } from './features/workbench/api.ts'
import { expandedResourceAncestors } from './features/resources/lifecycle.ts'
import { observeNavigation, navigationDiagnostic, type NavigationCause } from './navigation.ts'

/**
 * store.tsx 是 JSX，`node --experimental-transform-types` 只剥类型不转 JSX，运行时
 * import 它会以 `Unknown file extension ".tsx"` 失败；仓库既有做法（resources.test.ts、
 * features/workbench/scope.test.ts、contracts/tasks.test.ts）是把 .tsx 当契约文本钉住。
 * 所以这里分两段：
 * - storeContext.ts 能被真实 import，它的行为用真断言（context 默认值、Provider 可用性）；
 * - store.tsx 的初值、reducer 与 selector 不变量用源码契约钉住，改一处就要同时改断言。
 */
const storeSource = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')

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
  const open = async (page?: number) => {
    const result: { promise?: Promise<boolean> } = {}
    runInNewContext(compiled, {
      result,
      page,
      stateRef,
      resolveDocumentWorkspaceProject,
      LITERATURE_EXCERPT_VIEW_STATE_KEY,
      LITERATURE_EXCERPT_SOURCE_KIND: 'literature',
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
      documentWorkspaces: { forProject: () => workspace },
      setState: (update: (state: typeof stateRef.current) => typeof stateRef.current) => {
        stateRef.current = update(stateRef.current)
      },
    })
    return result.promise!
  }
  assert.equal(await open(3), true)
  const id = stateRef.current.activeTab
  const first = workspace.getSnapshot().tabs[id]
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
    transformSync(
      block(workbench, '  useEffect(() => {', '  if (documents.tabs[state.activeTab]'),
      {
        loader: 'ts',
      }
    ).code,
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
            set: (value: string) => {
              draft = value
            },
          },
        },
        HOME_RESET: { activeSession: null, draftModelId: null },
        assistantSessionView: () => 'resource',
        rememberScopeConversation: () => {},
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
    /<StoreContext\.Provider value=\{value\}>\s*<NavigationRecoveryContext\.Provider value=\{act\.returnHome\}>\s*\{children\}\s*<\/NavigationRecoveryContext\.Provider>\s*<\/StoreContext\.Provider>/
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
  assert.match(
    storeSource,
    /const INITIAL_PREFERENCES = window\.scholarseed\?\.preferences \?\? DEFAULT_RENDERER_PREFERENCES/
  )
  assert.match(storeSource, /setActiveShortcutOverrides\(INITIAL_PREFERENCES\.shortcutOverrides\)/)
  for (const field of [
    'theme: INITIAL_PREFERENCES.theme',
    'lang: INITIAL_PREFERENCES.language',
    'sidebarOpen: INITIAL_PREFERENCES.sidebarOpen',
    'shortcutOverrides: INITIAL_PREFERENCES.shortcutOverrides',
    'dataSharingMode: INITIAL_PREFERENCES.dataSharingMode',
    'desktopNotifications: INITIAL_PREFERENCES.desktopNotifications',
    'soundAlerts: INITIAL_PREFERENCES.soundAlerts',
    'autoSave: INITIAL_PREFERENCES.autoSave',
    'formatOnSave: INITIAL_PREFERENCES.formatOnSave',
    'editorWordWrap: INITIAL_PREFERENCES.editorWordWrap',
    'recentFiles: INITIAL_PREFERENCES.recentFiles',
    'recentLiterature: INITIAL_PREFERENCES.recentLiterature',
    'recentSessions: INITIAL_PREFERENCES.recentSessions',
    'sessionActivityInitialized: INITIAL_PREFERENCES.sessionActivityInitialized',
    'sessionActivitySeen: INITIAL_PREFERENCES.sessionActivitySeen',
  ]) {
    assert.match(initialBlock, new RegExp(field.replace(/[.?]/g, '\\$&')))
  }
  // 落库前还要过一遍归一：偏好文件可能是旧版本或被人手改过。
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
    /const delta = availabilityPolicy\.navigationPatch\(\s*current,\s*typeof patch === 'function' \? patch\(current\) : patch\s*\)/
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
  const patchThread = block(
    storeSource,
    'const patchThread = useCallback',
    'const appendThread = useCallback'
  ).replace(/\s+/g, ' ')
  assert.match(patchThread, /findSessionNode\(current\.sessions, thread\.sessionId \?\? id\)/)
  assert.match(patchThread, /let sessions = current\.sessions/)
  assert.match(
    patchThread,
    /if \(node && \('status' in delta \|\| 'running' in delta \|\| titleChanged\)\)/
  )
  assert.match(patchThread, /if \(nextThread\.status === 'waiting'\) status = 'waiting'/)
  assert.match(
    patchThread,
    /else if \(nextThread\.running === true \|\| nextThread\.status === 'running'\) status = 'running'/
  )
  // 收尾态要区分「用户正在看的会话」：当前会话回 dormant，其它会话才是 done。
  assert.match(patchThread, /status = current\.activeSession === id \? 'dormant' : 'done'/)
  assert.match(patchThread, /sessions = upsertSessionNode\(sessions, \{\s*\.\.\.node, status,/)
  assert.ok(patchThread.includes('...(titleChanged ? {'))
  assert.ok(
    patchThread.includes('title: nextThread.title, title_fallback: nextThread.title_fallback')
  )
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
  assert.match(clearSession, /composerDraft\.current!\.set\(''\)/)
  const startPanelDraft = block(storeSource, 'startPanelDraft: (seed = {}) => {', 'activateTab:')
  const startDraft = block(storeSource, 'startDraft: (seed = {}) => {', 'applyModelCatalog:')
  for (const draftStart of [startPanelDraft, startDraft]) {
    assert.match(draftStart, /composerDraft\.current!\.set\(seed\.composerText \?\? ''\)/)
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
