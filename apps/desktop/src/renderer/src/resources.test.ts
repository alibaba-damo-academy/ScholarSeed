import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { createInstance } from 'i18next'

import {
  BROWSER_SEARCH_MODE,
  OFFICIAL_SEARCH_MODE,
  findResourceNode,
  INITIAL_RESOURCE_STATE,
  MARKDOWN_SUFFIX,
  pendingChildCount,
  resourceStateForProjectSwitch,
  resolveResourceCreateTarget,
  resourceNameError,
  resourceCreateNameError,
  resourceNameSuggestion,
  resourceVersionBadge,
  webSearchNoticePending,
  withCreatedResource,
  withResourceChildren,
  withWebSearchNotice,
  WEB_SEARCH_CANDIDATES_MODE,
} from './features/resources/state.ts'
import type { ResourceNode, ResourceWebSearch } from './features/resources/state.ts'
import { defaultExcerptName } from './features/assistant/names.ts'

import {
  asLiteratureExcerptSource,
  LITERATURE_EXCERPT_SOURCE_KIND,
  PDF_EXCERPT_LOCATOR_KIND,
} from './contracts/resources.ts'
import {
  fetchResourceAgentOrigin,
  fetchVersionCapability,
  fetchResourceTree,
  importLiteratureExcerpts,
  importResources,
  importWebResources,
  mutateResourceNode,
  webSearchSiteIconUrl,
} from './features/resources/api.ts'
import { waitForFileVersionScan } from './features/resources/settings.ts'
import {
  appendWebSearchProjectionEvent,
  automaticWebSearchInvocationRequest,
  AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
  AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH,
  BROWSER_SEARCH_ARTIFACT_PATH,
  BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
  createWebSearchTab,
  importFailureMessage,
  projectWebSearch,
  WEB_SEARCH_CANDIDATE_LIMIT,
  WEB_IMPORT_SELECTION_LIMIT,
  WEB_SEARCH_CANDIDATE_DESCRIPTION_LIMIT,
  WEB_SEARCH_CANDIDATE_TITLE_LIMIT,
  WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
  WEB_SEARCH_AUTOMATIC_ROUTE,
  WEB_SEARCH_PROJECTION_EVENT_LIMIT,
  verifiedWebSearchCandidates,
  webSearchDurationLabel,
  webSearchInvocationRequest,
  webSearchInvocationFailure,
  webSearchFailureText,
  WEB_SEARCH_CANDIDATES_EXECUTION_ERROR_CODE,
  BROWSER_SEARCH_EXECUTION_ERROR_CODE,
  WEB_SEARCH_INTERRUPTED_CODE,
  webSearchModeDefinition,
  webSearchOutputMissing,
  webSearchPrompt,
  webSearchTimeLabel,
} from './features/resources/search.ts'
import {
  expandedResourceAncestors,
  materializeResourcePath,
} from './features/resources/lifecycle.ts'
import type { AgentInvocationEvent } from './contracts/invocation.ts'

test('opening covered links reveals every target and opens the first file without remounting', () => {
  const store = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')
  const action = store.slice(
    store.indexOf('openCoveredLinkAndCancel: async'),
    store.indexOf('openResourceMoveDialog:', store.indexOf('openCoveredLinkAndCancel: async'))
  )
  assert.match(action, /linkSupersedeConfirm: null/)
  assert.match(action, /await prepareResourceOpening\(/)
  assert.match(action, /covered\.map\(\(child\) => child\.mountPath\)/)
  assert.match(action, /openResourceFile\(target\.mountPath, homeSelectedProjectId\)/)
  assert.match(action, /latest\.resource\.tree !== resource\.tree/)
  assert.match(action, /latest\.resource\.expanded !== resource\.expanded/)
  assert.match(action, /latest\.resource\.selected !== resource\.selected/)
  assert.match(action, /latest\.homeSelectedProjectId !== homeSelectedProjectId/)
  assert.doesNotMatch(
    action,
    /toggleResourceDir|authorizeResource|supersedeResource|createResourceImport/
  )
  assert.match(action, /tree: opened\.tree/)
  assert.match(action, /expanded: opened\.expanded/)
  assert.match(action, /selected: opened\.selected/)
  assert.doesNotMatch(
    action,
    /toggleResourceDir|authorizeResource|supersedeResource|createResourceImport/
  )
})

test('switching projects clears resource state without dropping open web searches', () => {
  const webSearches = {}
  const next = resourceStateForProjectSwitch({
    ...INITIAL_RESOURCE_STATE,
    tree: [{ path: 'resources/old.txt', name: 'old.txt', kind: 'file' }],
    rootTotal: 1,
    root: '/old-project/resources',
    expanded: { resources: true },
    selected: 'resources/old.txt',
    searchText: '请帮我分析一下AI支付的最新资料',
    webSearches,
    filterText: '旧项目',
    searchHits: [],
    admissionPending: { 'resources/old.txt': true },
    notice: { tone: 'ok', text: { key: 'feedback.created', name: 'old.txt' } },
    loadState: 'ready',
  })

  assert.deepEqual(next, { ...INITIAL_RESOURCE_STATE, webSearches })
  assert.equal(next.webSearches, webSearches)
})

test('tree version description omits saved and pending states', () => {
  const node: ResourceNode = {
    path: 'resources/a.docx',
    name: 'a.docx',
    kind: 'file',
    version: {
      managementState: 'managed',
      drifted: true,
      snapshotState: 'saved',
      pendingOrigin: null,
      needsReview: false,
    },
  }
  assert.equal(resourceVersionBadge(node)?.label, 'versionBadge.drifted')
  assert.ok(resourceVersionBadge(node)?.description.includes('versionBadge.drifted'))
  node.version = {
    ...node.version!,
    drifted: false,
    snapshotState: 'pending',
    pendingOrigin: 'agent',
    needsReview: true,
  }
  assert.equal(resourceVersionBadge(node), null)
  node.version = {
    ...node.version,
    pendingOrigin: 'external',
    needsReview: false,
    managementState: 'ignored',
  }
  assert.equal(resourceVersionBadge(node)?.label, 'versionBadge.ignored')
  assert.ok(resourceVersionBadge(node)?.description.includes('versionBadge.ignored'))
  node.version = { ...node.version, snapshotState: null, pendingOrigin: null }
  assert.equal(resourceVersionBadge(node)?.label, 'versionBadge.ignored')
})

test('tree HTTP mapping preserves snapshot and review projection without operation identities', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    globalThis.fetch = async () =>
      Response.json({
        root: 'resources',
        total: 1,
        offset: 0,
        nodes: [
          {
            path: 'resources/a.docx',
            name: 'a.docx',
            kind: 'file',
            count: null,
            version: {
              management_state: 'managed',
              drifted: false,
              snapshot_state: 'pending',
              pending_origin: 'agent',
              needs_review: true,
            },
          },
        ],
      })
    const tree = await fetchResourceTree('project')
    assert.deepEqual(tree?.nodes[0].version, {
      managementState: 'managed',
      drifted: false,
      snapshotState: 'pending',
      pendingOrigin: 'agent',
      manualAdmitted: false,
      needsReview: true,
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('resource selection expands ancestors for a visible tree highlight', () => {
  const nodes: ResourceNode[] = [
    {
      path: 'resources/root',
      name: 'root',
      kind: 'dir',
      children: [
        {
          path: 'resources/root/nested',
          name: 'nested',
          kind: 'dir',
          children: [{ path: 'resources/root/nested/file.txt', name: 'file.txt', kind: 'file' }],
        },
      ],
    },
  ]
  assert.deepEqual(expandedResourceAncestors(nodes, 'resources/root/nested/file.txt', {}), {
    'resources/root': true,
    'resources/root/nested': true,
  })
})

test('search navigation materializes paged ancestors before revealing a resource', async () => {
  const target = 'resources/skills/supabase/references/data-pagination.md'
  const nodes: ResourceNode[] = [
    {
      path: 'resources/alpha',
      name: 'alpha',
      kind: 'dir',
      count: 0,
    },
  ]
  const calls: Array<[string, number]> = []
  const pages: Record<string, { nodes: ResourceNode[]; total: number }> = {
    ':1': {
      nodes: [{ path: 'resources/skills', name: 'skills', kind: 'dir', count: 1 }],
      total: 2,
    },
    'resources/skills:0': {
      nodes: [{ path: 'resources/skills/supabase', name: 'supabase', kind: 'dir', count: 1 }],
      total: 1,
    },
    'resources/skills/supabase:0': {
      nodes: [
        { path: 'resources/skills/supabase/references', name: 'references', kind: 'dir', count: 1 },
      ],
      total: 1,
    },
    'resources/skills/supabase/references:0': {
      nodes: [{ path: target, name: 'data-pagination.md', kind: 'file' }],
      total: 1,
    },
  }

  const result = await materializeResourcePath(nodes, 2, target, async (path, offset) => {
    calls.push([path, offset])
    return pages[`${path}:${offset}`] ?? { nodes: [], total: offset }
  })

  assert.equal(result.found, true)
  assert.equal(findResourceNode(result.tree, target)?.name, 'data-pagination.md')
  assert.deepEqual(calls, [
    ['', 1],
    ['resources/skills', 0],
    ['resources/skills/supabase', 0],
    ['resources/skills/supabase/references', 0],
  ])
  assert.deepEqual(expandedResourceAncestors(result.tree, target, {}), {
    'resources/skills': true,
    'resources/skills/supabase': true,
    'resources/skills/supabase/references': true,
  })
})

test('search navigation does not fetch a fully projected resource path again', async () => {
  const target = 'resources/root/nested/file.txt'
  const nodes: ResourceNode[] = [
    {
      path: 'resources/root',
      name: 'root',
      kind: 'dir',
      count: 1,
      children: [
        {
          path: 'resources/root/nested',
          name: 'nested',
          kind: 'dir',
          count: 1,
          children: [{ path: target, name: 'file.txt', kind: 'file' }],
        },
      ],
    },
  ]

  const result = await materializeResourcePath(nodes, 1, target, async () => {
    assert.fail('a visible path must not trigger another tree request')
  })

  assert.equal(result.found, true)
  assert.equal(result.tree, nodes)
})

const artifactImportSource = readFileSync(
  new URL('./features/assistant/Artifacts.tsx', import.meta.url),
  'utf8'
)
const answerImportSource = readFileSync(
  new URL('./features/assistant/Annotations.tsx', import.meta.url),
  'utf8'
)
const resourceSaveDialogSource = readFileSync(
  new URL('./features/assistant/Save.tsx', import.meta.url),
  'utf8'
)
const originActionSource = readFileSync(
  new URL('./features/resources/Origin.tsx', import.meta.url),
  'utf8'
)
const resourceFeatureSource = readFileSync(
  new URL('./features/resources/feature.tsx', import.meta.url),
  'utf8'
)
const resourcePanelSource = readFileSync(
  new URL('./features/resources/ResourcePanel.tsx', import.meta.url),
  'utf8'
)
const resourceDialogsSource = readFileSync(
  new URL('./features/resources/Dialogs.tsx', import.meta.url),
  'utf8'
)
const resourceImportDialogSource = readFileSync(
  new URL('./features/resources/ImportDialog.tsx', import.meta.url),
  'utf8'
)
const resourceIconsSource = readFileSync(
  new URL('./features/resources/icons.ts', import.meta.url),
  'utf8'
)
const tabBarSource = readFileSync(new URL('./shell/TabBar.tsx', import.meta.url), 'utf8')
const workbenchTabsSource = readFileSync(
  new URL('./features/workbench/tabs.ts', import.meta.url),
  'utf8'
)
const workspaceSource = readFileSync(
  new URL('./features/workbench/workspace.ts', import.meta.url),
  'utf8'
)
const topBarSource = readFileSync(new URL('./shell/TopBar.tsx', import.meta.url), 'utf8')
const dockSource = readFileSync(new URL('./features/workbench/Dock.tsx', import.meta.url), 'utf8')
const workbenchApiSource = readFileSync(
  new URL('./features/workbench/api.ts', import.meta.url),
  'utf8'
)
const draggingSource = readFileSync(
  new URL('./features/workbench/Dragging.tsx', import.meta.url),
  'utf8'
)
const documentMenuSource = readFileSync(
  new URL('./features/workbench/Menu.tsx', import.meta.url),
  'utf8'
)
const composerSource = readFileSync(
  new URL('./components/business/Composer.tsx', import.meta.url),
  'utf8'
)
const streamSource = readFileSync(
  new URL('./components/business/Stream.tsx', import.meta.url),
  'utf8'
)
const attachmentsSource = readFileSync(
  new URL('./components/primitive/Attachments.tsx', import.meta.url),
  'utf8'
)
const inputSource = readFileSync(new URL('./input.ts', import.meta.url), 'utf8')
const workbenchStyles = readFileSync(new URL('./shell/workbench.css', import.meta.url), 'utf8')
const workbenchSource = readFileSync(
  new URL('./features/workbench/Workbench.tsx', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(
  new URL('./components/business/Sidebar.tsx', import.meta.url),
  'utf8'
)
const globalSearchSource = readFileSync(
  new URL('./features/search/GlobalSearch.tsx', import.meta.url),
  'utf8'
)
const webSearchDriverSource = readFileSync(
  new URL('./features/resources/driver.ts', import.meta.url),
  'utf8'
)
const webSearchActivitySource = readFileSync(
  new URL('./features/resources/activity.ts', import.meta.url),
  'utf8'
)
const webSearchTabSource = readFileSync(
  new URL('./features/resources/WebSearchTab.tsx', import.meta.url),
  'utf8'
)
const webSearchFeedbackSource = readFileSync(
  new URL('./features/resources/Feedback.tsx', import.meta.url),
  'utf8'
)
const webImportDestinationSource = readFileSync(
  new URL('./features/resources/Destination.tsx', import.meta.url),
  'utf8'
)
const rendererMainSource = readFileSync(new URL('./app/root.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const navigationSource = readFileSync(new URL('./navigation.ts', import.meta.url), 'utf8')

/**
 * 两种截断各一个样本：
 * - 关联目录嵌到第 4 层，树一次只回 3 层，第 3 层只报总数、没有子节点；
 * - `海量` 是单层超一页的形态：只投影了 2 条，实际有 5 条。
 */
const tree = (): ResourceNode[] => [
  {
    path: 'resources/关联目录',
    name: '关联目录',
    kind: 'dir',
    origin: 'link',
    count: 1,
    children: [
      {
        path: 'resources/关联目录/s1',
        name: 's1',
        kind: 'dir',
        origin: 'link',
        count: 1,
        children: [
          {
            path: 'resources/关联目录/s1/s2',
            name: 's2',
            kind: 'dir',
            origin: 'link',
            count: 1,
            children: [],
          },
        ],
      },
    ],
  },
  {
    path: 'resources/海量',
    name: '海量',
    kind: 'dir',
    count: 5,
    children: [
      { path: 'resources/海量/a.md', name: 'a.md', kind: 'file' },
      { path: 'resources/海量/b.md', name: 'b.md', kind: 'file' },
    ],
  },
  { path: 'resources/表格.xlsx', name: '表格.xlsx', kind: 'file' },
]

test('pendingChildCount 用同一个判据覆盖两种截断', () => {
  const nodes = tree()
  // 深度没扫到：报了总数但没有子节点。
  assert.equal(pendingChildCount(findResourceNode(nodes, 'resources/关联目录/s1/s2')!), 1)
  // 单层只取了一页：已投影 2 条、总数 5 条。
  assert.equal(pendingChildCount(findResourceNode(nodes, 'resources/海量')!), 3)
  // 已投影完整。
  assert.equal(pendingChildCount(findResourceNode(nodes, 'resources/关联目录')!), 0)
  // 文件没有子节点可言。
  assert.equal(pendingChildCount(findResourceNode(nodes, 'resources/表格.xlsx')!), 0)
})

test('linked resource refresh waits until the background version scan is idle', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({
      max_versions_per_file: 50,
      ignore_patterns: [],
      scan_summary: {
        status: calls === 1 ? 'scanning' : 'idle',
        projects: 1,
        managed: 1,
        created: 1,
        ignored: 0,
        oversized: 0,
        unsupported: 0,
        failed: 0,
      },
    })
  }
  try {
    assert.equal(await waitForFileVersionScan(0, 100), true)
    assert.equal(calls, 2)
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('Agent imports stay in the conversation and resource previews expose their origin', () => {
  assert.doesNotMatch(artifactImportSource, /openResourceFile\(result\.node\.path/)
  assert.doesNotMatch(answerImportSource, /openResourceFile\(result\.node\.path/)
  assertLocalized(artifactImportSource, 'resources', 'feedback.savedDestination', [
    '已保存 {{name}}',
    'Saved {{name}}',
  ])
  assert.match(
    artifactImportSource,
    /key: 'feedback\.savedDestination', name: result\.node\.name, destination/
  )
  assert.match(artifactImportSource, /\{ path: result\.node\.path, projectId: targetProject\.id \}/)
  assert.match(appSource, /data-testid="resource-notice-open"/)
  assert.match(appSource, /openResourceTarget\(act, notice\.openTarget!\)/)
  assert.match(
    navigationSource,
    /actions\.openWorkbenchView\('resource'\)[\s\S]*actions\.openResourceFile\(target\.path, target\.projectId\)/
  )
  assert.match(resourceFeatureSource, /id: 'resource-agent-origin'/)
  assertLocalized(originActionSource, 'resources', 'origin.view', [
    '查看原任务',
    'View original task',
  ])
  assert.match(originActionSource, /findSessionNode\(state\.sessions, origin\.sessionId\)/)
  assert.match(originActionSource, /act\.openPanelSession\(sourceSession/)
  assert.doesNotMatch(originActionSource, /act\.openSession\(/)
  assert.match(originActionSource, /turnId: origin\.turnId/)
  assert.match(originActionSource, /itemId: origin\.itemId/)
  assert.doesNotMatch(resourceSaveDialogSource, /Tooltip/)
  assert.match(
    resourceSaveDialogSource,
    /toast\(\{ tone: 'error', title: assistantText\('remaining\.correctRetry', \{ detail: error \}\) \}\)/
  )
  assertLocalized(resourceSaveDialogSource, 'assistant', 'remaining.correctRetry', [
    '{{detail}} 请修改后重试。',
    '{{detail}} Correct the issue and try again.',
  ])
})

test('resource origin keeps the workbench and opens the source session in the assistant panel', () => {
  const openPanelSessionStart = storeSource.indexOf('openPanelSession: (node, focus)')
  const openPanelSessionEnd = storeSource.indexOf('selectProject:', openPanelSessionStart)
  const openPanelSessionSource = storeSource.slice(openPanelSessionStart, openPanelSessionEnd)

  assert.notEqual(openPanelSessionStart, -1)
  assert.notEqual(openPanelSessionEnd, -1)
  assert.match(openPanelSessionSource, /activateSession\(current, node, 'assistant'\)/)
  assert.doesNotMatch(openPanelSessionSource, /mainView: 'conversation'/)
  assert.match(originActionSource, /status: 'dormant'/)
  assert.match(originActionSource, /openable: true/)
})

test('conversation entry points open the workbench assistant instead of the legacy shell', () => {
  const parsed = ts.createSourceFile(
    'store.tsx',
    storeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const actions = new Map<string, string>()
  const actionNames = new Set(['openSession', 'startPanelDraft', 'startDraft'])
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      actionNames.has(node.name.text) &&
      ts.isArrowFunction(node.initializer)
    ) {
      assert.equal(actions.has(node.name.text), false)
      actions.set(node.name.text, node.initializer.body.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(actions.size, actionNames.size)
  const openSessionSource = actions.get('openSession')!
  const startPanelDraftSource = actions.get('startPanelDraft')!
  const startDraftSource = actions.get('startDraft')!
  assert.match(
    storeSource,
    /function assistantSessionView\(current: AppState, projectId\?: string \| null\): MainView/
  )
  assert.match(openSessionSource, /mainView: assistantSessionView\(current\)/)
  assert.match(openSessionSource, /open: true/)
  assert.doesNotMatch(openSessionSource, /mainView: 'conversation'/)
  assert.match(startDraftSource, /mainView: assistantSessionView\(current, seed\.projectId\)/)
  assert.doesNotMatch(startDraftSource, /mainView: 'conversation'/)
  assert.match(startPanelDraftSource, /mainView: assistantSessionView\(current\)/)
  assert.match(sidebarSource, /onClick=\{\(\) => act\.startPanelDraft\(\)\}/)
  assert.match(
    sidebarSource,
    /act\.startPanelDraft\(\{ projectId: project\.id, projectLocked: true \}\)/
  )
  assert.doesNotMatch(sidebarSource, /act\.startDraft\(/)
  assert.match(streamSource, /act\.startPanelDraft\(\)/)
  assert.doesNotMatch(streamSource, /act\.startDraft\(/)
})

test('project selection replaces project-scoped projections at the store boundary', () => {
  const selectProjectStart = storeSource.indexOf('selectProject: (projectId)')
  const selectProjectEnd = storeSource.indexOf('toggleSessionChildren:', selectProjectStart)
  const selectProjectSource = storeSource.slice(selectProjectStart, selectProjectEnd)

  assert.notEqual(selectProjectStart, -1)
  assert.notEqual(selectProjectEnd, -1)
  assert.match(selectProjectSource, /resource: resourceStateForProjectSwitch\(current\.resource\)/)
  assert.match(selectProjectSource, /literature: literatureStateForProjectSwitch\(\)/)
})

test('resource operation results use the shared Toast atom', () => {
  assert.match(appSource, /const \{ toast \} = useToast\(\)/)
  assert.match(appSource, /tone: notice\.tone === 'ok' \? 'success' : 'error'/)
  assert.match(
    appSource,
    /set\(\(current\) => \(\{ resource: \{ \.\.\.current\.resource, notice: null \} \}\)\)/
  )
  assert.doesNotMatch(resourcePanelSource, /<Toaster[\s\S]*?resource-notice/)
  assert.doesNotMatch(resourcePanelSource, /<Alert[\s\S]*?resource-notice/)
  assert.doesNotMatch(resourceImportDialogSource, /data-testid="resource-import-error"/)
  assert.match(
    storeSource,
    /if \(!result\.ok\) \{[\s\S]*?actRef\.current\.noticeResource\('error', error\)/
  )
  assert.match(resourceImportDialogSource, /<Alert className="mt-4" tone="warning">/)
})

test('confirmed resource deletion discards dirty tabs only after trash succeeds', () => {
  const actionStart = storeSource.indexOf('deleteResourceNode: async () =>')
  const actionEnd = storeSource.indexOf('confirmResourceUnlink:', actionStart)
  const actionSource = storeSource.slice(actionStart, actionEnd)

  assert.notEqual(actionStart, -1)
  assert.notEqual(actionEnd, -1)
  assert.doesNotMatch(actionSource, /feedback\.deleteDirty|hasDirtyProjectPath/)
  assert.match(actionSource, /discardProjectPath\(/)
  assert.ok(actionSource.indexOf('discardProjectPath(') > actionSource.indexOf('if (!done.ok)'))
  assert.match(resourceDialogsSource, /hasDirtyProjectPath\(/)
  assert.match(
    resourceDialogsSource,
    /hasUnsavedChanges\s*\?\s*t\('delete\.unsavedWarning',\s*\{\s*trash\s*\}\)/
  )
})

test('annotation removal failures use toast feedback instead of persistent page errors', () => {
  assert.match(storeSource, /ANSWER_ANNOTATION_REMOVE_TOAST_ID = 'answer-annotation-remove-failed'/)
  assert.match(storeSource, /showAnswerAnnotationRemoveFailure\(result\)/)
  assert.match(storeSource, /title: assistantText\('contextErrors\.removeFailedToast'\)/)
  assert.doesNotMatch(
    storeSource,
    /contextError: result\.ok \? null : \{ key: 'contextErrors\.removeFailed'/
  )
  assert.doesNotMatch(storeSource, /error = \{ key: 'contextErrors\.removeFailed'/)
  assertLocalized(storeSource, 'assistant', 'contextErrors.removeFailedToast', [
    '移除注释失败，请稍后重试。',
    'Could not remove the annotation. Try again later.',
  ])
})

test('annotation mutation failures use toast feedback instead of persistent page errors', () => {
  assert.match(
    storeSource,
    /ANSWER_ANNOTATION_MUTATION_TOAST_ID = 'answer-annotation-mutation-failed'/
  )
  assert.equal(
    (storeSource.match(/showAnswerAnnotationMutationFailure\(result\)/g) ?? []).length,
    3
  )
  assert.match(
    storeSource,
    /title: assistantText\('contextErrors\.annotationFailed', \{ detail \}\)/
  )
  assert.doesNotMatch(
    storeSource,
    /contextError: result\.ok \? null : \{ key: 'contextErrors\.annotationFailed'/
  )
})

test('annotation save failures use toast feedback instead of an inline alert', () => {
  assert.match(
    answerImportSource,
    /ANSWER_ANNOTATION_SAVE_TOAST_ID = 'answer-annotation-save-failed'/
  )
  assert.match(answerImportSource, /const \{ toast \} = useToast\(\)/)
  assert.match(answerImportSource, /title: a\(messageKey\)/)
  assert.doesNotMatch(answerImportSource, /annotationError|setAnnotationError/)
})

test('same-project resource and literature document tabs share the top navigation while split panes expose closable leaf tabs', () => {
  assert.match(tabBarSource, /tabVisibleInCurrentView,/)
  assert.match(
    workbenchTabsSource,
    /mainView === 'literature'\) return kind === 'literature' \|\| kind === 'literature_search'/
  )
  assert.match(
    tabBarSource,
    /const documentTabs: NavigationTabItem\[\] =\s*state\.mainView === 'resource' \|\| state\.mainView === 'literature'/
  )
  assert.match(tabBarSource, /\? Object\.values\(documents\.tabs\)\.flatMap/)
  assert.match(
    tabBarSource,
    /const session = documents\.sessions\[tab\.sessionId\][\s\S]*?if \(!session\) return \[\]/
  )
  assert.doesNotMatch(
    tabBarSource.slice(
      tabBarSource.indexOf('const documentTabs:'),
      tabBarSource.indexOf('const workbenchTabs:')
    ),
    /documentNavigationView\(tab, session\) !== state\.mainView/
  )
  assert.match(tabBarSource, /resourceFileIcon\(tab\.title\)/)
  assert.match(resourcePanelSource, /resourceFileIcon\(node\.name\)/)
  assert.match(
    resourceIconsSource,
    /fileIconForName as resourceFileIcon.*from '..\/..\/components\/primitive'/
  )
  assert.match(tabBarSource, /if \(documentTab\) \{[\s\S]*?act\.activateTab\(id\)/)
  assert.match(tabBarSource, /act\.selectResourceFile\(session\.source\.path\)/)
  assert.doesNotMatch(tabBarSource, /workspace\.focusTab\(id\)/)
  assert.match(tabBarSource, /const activeValue = activeNavigationTabId\(/)
  assert.match(tabBarSource, /workspace\.requestClose\(id\)/)
  assert.match(
    storeSource,
    /workspace\.open\(source, previewFormat\(path\) \? 'preview' : 'edit'\)[\s\S]*?opened\.then\(\(tabId\) =>/
  )
  assert.match(
    storeSource,
    /openSnapshot: \(source, title, titleFallback\) => \{[\s\S]*?workspace\.open\(source, 'preview', title, undefined, titleFallback\)\.then\(\(tabId\) => \{[\s\S]*?assistantProject\(current\)\.projectId === source\.project[\s\S]*?activeTab: tabId/
  )
  assert.match(
    storeSource,
    /forProject\(project\)\s*\.revealText\(source, reveal\)[\s\S]*?activeTab: tabId/
  )
  assert.match(storeSource, /selectResourceFile: \(path\) =>\s*setState/)
  assert.match(
    storeSource,
    /expandedResourceAncestors\(\s*current\.resource\.tree,\s*path,\s*current\.resource\.expanded\s*\)/
  )
  assert.match(
    storeSource,
    /function resourceDocumentTabIdForSelection\(state: AppState\): string \| null/
  )
  assert.match(storeSource, /session\.source\.path === state\.resource\.selected/)
  assert.match(
    storeSource,
    /const activeTab =[\s\S]*?restoreProjectWorkbenchTab\([\s\S]*?activeTabForWorkbenchView\(view, current, tabs\)/
  )
  assert.match(storeSource, /workspace\.focusTab\(activeTab\)/)
  assert.match(
    workbenchSource,
    /if \(documents\.tabs\[state\.activeTab\]\) return <DocumentDock \/>/
  )
  assert.match(workbenchSource, /const viewer = featureRegistry\.viewers\.get\(kind\)/)
  assert.match(
    workbenchSource,
    /viewer\.render\(\{ active: true, path: tab\?\.id \?\? '', tabId: tab\?\.id \}\)/
  )
  assert.match(dockSource, /showTabs=\{false\}/)
  assert.match(dockSource, /\{showTabs &&\s*(?:\(\s*)?<TabStrip\b/)
  assert.match(dockSource, /showTabs \? ' !grid-rows-\[auto_minmax\(0,1fr\)\]' : ' is-tabless'/)
  assert.match(workbenchStyles, /\.vds-dock-leaf\.is-tabless\s*\{[^}]*border-top:\s*0/s)
  assert.match(
    workbenchStyles,
    /\.vds-dock-leaf\.is-tabless\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s
  )
})

test('literature attachment entry points share the workspace action and source-owned PDF renderer', () => {
  for (const path of [
    './features/assistant/References.tsx',
    './components/business/Stream.tsx',
    './components/business/SessionArtifacts.tsx',
    './features/assistant/AiPanel.tsx',
    './features/assistant/Outputs.tsx',
    './features/onboarding/adapter.ts',
    './features/literature/admission.ts',
  ]) {
    assert.match(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      /\.openLiteratureAttachment\(/
    )
  }
  const pdf = readFileSync(new URL('./features/workbench/PdfDocument.tsx', import.meta.url), 'utf8')
  assert.match(pdf, /session\?\.source\.kind === 'literature'/)
  assert.match(
    workbenchSource,
    /documentNavigationView\(focusedTab, focusedSession\) === state\.mainView/
  )
})

test('opening a conversation file selects the document view owned by its source', () => {
  const actionStart = storeSource.indexOf('openFilePreview: (filePreview)')
  const actionEnd = storeSource.indexOf('openSession:', actionStart)
  const actionSource = storeSource.slice(actionStart, actionEnd)
  const parsed = ts.createSourceFile(
    'store.tsx',
    storeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const functions = parsed.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'mainViewForDocumentSource'
  )
  assert.equal(functions.length, 1)
  const js = ts.transpileModule(functions[0].getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const navigate = new Function(js + '\nreturn mainViewForDocumentSource;')() as (
    source: { kind: string },
    view: string
  ) => string
  for (const kind of ['literature', 'project', 'session-artifact', 'session-file']) {
    for (const view of ['resource', 'literature', 'home']) {
      assert.equal(
        navigate({ kind }, view),
        (kind === 'literature' && view !== 'resource') ||
          (view === 'literature' && ['session-artifact', 'session-file'].includes(kind))
          ? 'literature'
          : 'resource'
      )
    }
  }
  assert.match(
    actionSource,
    /const navigationView = mainViewForDocumentSource\(source, current\.mainView\)[\s\S]*workspace\.setTabNavigationView\(tabId, navigationView\)[\s\S]*mainView: navigationView/
  )
  assert.match(workspaceSource, /return tab\.navigationView \?\? 'resource'/)
})

test('missing document loads notify through a toast and close the tab instead of an inline alert', () => {
  assert.match(workbenchApiSource, /const NOT_FOUND_STATUS = 404/)
  assert.match(workbenchApiSource, /return failure\.status === NOT_FOUND_STATUS/)
  assert.match(dockSource, /function useMissingDocumentNotice\(/)
  assert.match(dockSource, /isMissingDocumentFailure\(session\.loadFailure\)/)
  assert.match(
    dockSource,
    /toast\(\{\s*title: t\('dock\.missingTitle', \{ title \}\),\s*description: t\('dock\.missingDescription'\),\s*tone: 'error',?\s*\}\)/
  )
  assert.match(dockSource, /workspace\.requestClose\(tab\.id\)/)
  assert.match(dockSource, /data-testid="document-missing"/)
})

test('findResourceNode reaches nodes below the first scan depth', () => {
  assert.equal(findResourceNode(tree(), 'resources/关联目录/s1/s2')?.name, 's2')
  assert.equal(findResourceNode(tree(), 'resources/缺失'), null)
})

test('withResourceChildren 填入深度没扫到的层级并刷新总数', () => {
  const filled = withResourceChildren(
    tree(),
    'resources/关联目录/s1/s2',
    [
      {
        path: 'resources/关联目录/s1/s2/s3',
        name: 's3',
        kind: 'dir',
        origin: 'link',
        count: 2,
        children: [],
      },
    ],
    1
  )
  const target = findResourceNode(filled, 'resources/关联目录/s1/s2')
  assert.equal(pendingChildCount(target!), 0)
  assert.deepEqual(
    target?.children?.map((child) => child.name),
    ['s3']
  )
  // 续扫回来的层级自己还可能有没投影的条目，否则第 5 层又会变成看不见的层级。
  assert.equal(pendingChildCount(findResourceNode(filled, 'resources/关联目录/s1/s2/s3')!), 2)
})

test('append 模式追加同一层的下一页而不抹掉已看到的条目', () => {
  const appended = withResourceChildren(
    tree(),
    'resources/海量',
    [
      { path: 'resources/海量/c.md', name: 'c.md', kind: 'file' },
      { path: 'resources/海量/d.md', name: 'd.md', kind: 'file' },
      { path: 'resources/海量/e.md', name: 'e.md', kind: 'file' },
    ],
    5,
    'append'
  )
  const target = findResourceNode(appended, 'resources/海量')
  assert.deepEqual(
    target?.children?.map((child) => child.name),
    ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
  )
  assert.equal(pendingChildCount(target!), 0)
})

test('总数用服务端本次回的值刷新（磁盘随时在变）', () => {
  const grown = withResourceChildren(
    tree(),
    'resources/海量',
    [{ path: 'resources/海量/c.md', name: 'c.md', kind: 'file' }],
    9,
    'append'
  )
  assert.equal(findResourceNode(grown, 'resources/海量')?.count, 9)
  assert.equal(pendingChildCount(findResourceNode(grown, 'resources/海量')!), 6)
})

test('withResourceChildren only rebuilds the path it touches', () => {
  const before = tree()
  const after = withResourceChildren(before, 'resources/关联目录/s1/s2', [], 0)
  // 兄弟节点保持同一引用：否则每展开一个深层目录都会重渲染整棵树。
  assert.equal(after[2], before[2])
  assert.notEqual(after[0], before[0])
})

test('withResourceChildren leaves the tree alone when the path is absent', () => {
  const before = tree()
  assert.deepEqual(withResourceChildren(before, 'resources/别的/路径', [], 0), before)
})

test('new resources follow the selected local folder like VS Code', () => {
  const localTree: ResourceNode[] = [
    {
      path: 'resources/待整理',
      name: '待整理',
      kind: 'dir',
      children: [{ path: 'resources/待整理/笔记.md', name: '笔记.md', kind: 'file' }],
    },
  ]

  assert.deepEqual(resolveResourceCreateTarget(localTree, 'resources/待整理'), {
    directory: 'resources/待整理',
    linkedDirectory: null,
  })
  assert.deepEqual(resolveResourceCreateTarget(localTree, 'resources/待整理/笔记.md'), {
    directory: 'resources/待整理',
    linkedDirectory: null,
  })
  assert.deepEqual(resolveResourceCreateTarget(localTree, null), {
    directory: '',
    linkedDirectory: null,
  })
  assert.deepEqual(resolveResourceCreateTarget(tree(), 'resources/表格.xlsx'), {
    directory: '',
    linkedDirectory: null,
  })
})

test('new resources require confirmation inside a linked folder and its descendants', () => {
  assert.deepEqual(resolveResourceCreateTarget(tree(), 'resources/关联目录'), {
    directory: 'resources/关联目录',
    linkedDirectory: { path: 'resources/关联目录', name: '关联目录' },
  })
  assert.deepEqual(resolveResourceCreateTarget(tree(), 'resources/关联目录/s1/s2'), {
    directory: 'resources/关联目录/s1/s2',
    linkedDirectory: { path: 'resources/关联目录', name: '关联目录' },
  })
})

test('created resources stay visible even when the refreshed page does not include them', () => {
  const created: ResourceNode = {
    path: 'resources/海量/第101条.md',
    name: '第101条.md',
    kind: 'file',
  }
  const before = tree()
  const next = withCreatedResource(before, 'resources/海量', created)
  assert.equal(findResourceNode(next, created.path), created)
  assert.equal(findResourceNode(next, 'resources/海量')?.count, 5)
  assert.equal(findResourceNode(next, 'resources/关联目录'), before[0])
  assert.equal(withCreatedResource(next, 'resources/海量', created), next)
})

test('new resource names have a twenty-character basename limit without restricting rename', () => {
  assert.equal(resourceCreateNameError('文'.repeat(20)), null)
  assert.equal(resourceCreateNameError('文'.repeat(21)), 'creation.nameTooLong')
  assert.equal(resourceCreateNameError('  研究笔记  '), null)
  assert.equal(resourceCreateNameError(''), 'operationError.invalid_name')
  assert.equal(resourceCreateNameError('目录/笔记'), 'operationError.invalid_name')
  assert.equal(resourceNameError('文'.repeat(21)), null)
})

test('Markdown inline naming edits only the basename and keeps invalid drafts in place', () => {
  assert.equal(MARKDOWN_SUFFIX, '.md')
  assert.equal(resourceNameError(''), 'operationError.invalid_name')
  assert.equal(resourceNameError('..'), 'operationError.invalid_name')
  assert.equal(resourceNameError('目录/笔记'), 'operationError.invalid_name')
  assert.equal(resourceNameError('新建新建2026年10月27日16:51:39'), 'operationError.invalid_name')
  assert.equal(resourceNameError('新建新建2026年10月27日16-51-39'), null)
  assert.equal(resourceNameError('研究笔记'), null)
  assert.match(resourcePanelSource, /data-testid="resource-name-suffix"/)
  assert.match(resourcePanelSource, /error=\{resource\.nameDraft(?:\?\.)?error\}/)
})

test('generated answer excerpt names obey the shared resource-name invariant', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    resources: {
      zh: {
        assistant: JSON.parse(
          readFileSync(
            new URL('../../localization/locales/zh/assistant.json', import.meta.url),
            'utf8'
          )
        ),
      },
    },
  })
  assert.equal(resourceNameSuggestion('  目录/笔记\\结论  ', '回退'), '目录 笔记 结论')
  assert.equal(resourceNameSuggestion('/\\\0', '回退'), '回退')
  assert.equal(resourceNameSuggestion('笔记16:51:39', '回退'), '笔记16 51 39')

  const name = defaultExcerptName(
    '按“光学波段星地/斜程链路”来理解问题',
    locale.getFixedT(null, 'assistant')
  )
  assert.equal(resourceNameError(name), null)
  assert.doesNotMatch(name, /[\\/\0]/u)
  assert.match(name, /_任务摘录$/u)
  assert.match(name, /光学波段星地/u)
  assert.match(name, /斜程链路/u)

  assert.match(
    resourceSaveDialogSource,
    /error=\{nameError \? resourceText\(nameError\) : undefined\}/
  )
  assert.match(resourceSaveDialogSource, /disabled=\{nameError !== null \|\| submitDisabled\}/)
})

test('new Markdown selection is revealed and opened after creation', () => {
  assert.match(
    storeSource,
    /draft\.mode === 'create_document' && createdPath\) \{\s*actRef\.current\.openResourceFile\(createdPath, homeSelectedProjectId\)/
  )
  assert.match(storeSource, /selected: createdPath \?\? current\.resource\.selected/)
  assert.match(resourcePanelSource, /scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(appSource, /data-testid="resource-notice-retry"/)
})

test('resource write feedback uses the shared toast component', () => {
  const bridgeStart = appSource.indexOf('function ResourceNoticeToast()')
  const bridgeEnd = appSource.indexOf('function CreditsWarningToast()', bridgeStart)
  assert.notEqual(bridgeStart, -1)
  assert.notEqual(bridgeEnd, -1)
  const bridgeSource = appSource.slice(bridgeStart, bridgeEnd)
  assert.match(bridgeSource, /toast\(\{/)
  assert.match(bridgeSource, /dedupeKey:/)
  assert.doesNotMatch(bridgeSource, /duration:/)
  assert.doesNotMatch(resourcePanelSource, /<Toaster[\s\S]*data-testid="resource-notice"/)
  assert.doesNotMatch(resourcePanelSource, /<Alert[\s\S]*data-testid="resource-notice"/)
})

test('opening a resource is not hidden inside a React state updater', () => {
  assert.match(
    storeSource,
    /openResourceFile: \(path, projectId, attachment\) => \{[\s\S]*?workspace\.openImported\(source, attachment\)[\s\S]*?workspace\.open\(source, previewFormat\(path\) \? 'preview' : 'edit'\)[\s\S]*?setState\(/
  )
  assert.doesNotMatch(
    storeSource,
    /openResourceFile: \([^)]*\) => setState\([\s\S]*?workspace\.open\(/
  )
  assert.match(
    storeSource,
    /openResourceFile: \(path, projectId, attachment\) => \{[\s\S]*?opened\.then\(\(tabId\) => \{[\s\S]*?activeTab: tabId/
  )
})

for (const artifactId of [undefined, 'artifact']) {
  for (const selectedProject of ['project', 'other']) {
    test(`task preview opens once under updater replay (artifact=${Boolean(artifactId)}, project=${selectedProject})`, async () => {
      const start = storeSource.indexOf('openFilePreview: (filePreview) =>')
      const end = storeSource.indexOf('      openSession:', start)
      const action = storeSource.slice(start, end).trim().replace(/,$/, '')
      const compiled = ts.transpileModule(`({${action}})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText
      const current = {
        mainView: 'resource',
        homeSelectedProjectId: 'project',
        activeTab: 'library',
        aiPanel: { cover: false },
      }
      const updaters: Array<(state: typeof current) => typeof current> = []
      const opened: unknown[] = []
      const workspace = {
        open: async (source: unknown) => {
          opened.push(source)
          return 'task-document'
        },
        setTabNavigationView: () => undefined,
      }
      const dependencies = {
        beginNavigation: () => ({}),
        setState: (updater: (state: typeof current) => typeof current) => updaters.push(updater),
        stateRef: { current },
        activeThread: () => ({ sessionId: 'task' }),
        assistantProject: (state: typeof current) => ({ projectId: state.homeSelectedProjectId }),
        documentWorkspaces: { forProject: () => workspace },
        mainViewForDocumentSource: () => 'resource',
      }
      const actions = new Function(...Object.keys(dependencies), `return ${compiled}`)(
        ...Object.values(dependencies)
      ) as {
        openFilePreview: (target: { path: string; sessionId: string; artifactId?: string }) => void
      }

      actions.openFilePreview({ path: 'ideas.md', sessionId: 'task', artifactId })
      assert.equal(opened.length, 1)
      assert.equal(
        (opened[0] as { kind: string }).kind,
        artifactId ? 'session-artifact' : 'session-file'
      )
      await Promise.resolve()
      let result = { ...current, homeSelectedProjectId: selectedProject }
      for (const updater of updaters) {
        updater(result)
        result = updater(result)
      }
      await Promise.resolve()
      assert.equal(opened.length, 1)
      assert.equal(result.activeTab, selectedProject === 'project' ? 'task-document' : 'library')
    })
  }
}

test('resource tree opens files and toggles folders through one click action', () => {
  assert.match(resourcePanelSource, /onClick=\{open\}/)
  assert.doesNotMatch(resourcePanelSource, /onDoubleClick=\{open\}/)
  assert.match(
    resourcePanelSource,
    /if \(node\.kind === 'dir'\) \{[\s\S]*?toggleResourceDir\(node\.path\)[\s\S]*?return[\s\S]*?openResourceFile\(node\.path\)/
  )
  assert.equal(
    resourcePanelSource.match(/onDoubleClick=\{\(event\) => event\.stopPropagation\(\)\}/g)?.length,
    4
  )
})

test('resource tree ignores follow-up clicks from a native double click', () => {
  assert.match(
    resourcePanelSource,
    /const open = \(event: React\.MouseEvent<HTMLDivElement>\): void => \{[\s\S]*?if \(event\.detail > 1\) return[\s\S]*?openResourceFile\(node\.path\)/
  )
  assert.doesNotMatch(resourcePanelSource, /RESOURCE_FILE_OPEN_DEBOUNCE_MS/)
})

test('current document is captured at send without a visible auto-reference', () => {
  assert.match(storeSource, /export function activeDocumentForTurn/)
  assert.match(storeSource, /state\.activeTab !== tabId/)
  assert.match(composerSource, /const activeDocument = activeDocumentForTurn\(state\)/)
  assert.match(composerSource, /activeDocument: queued\.activeDocument/)
  assert.doesNotMatch(storeSource, /pendingResourceFileContext/)
  assert.doesNotMatch(storeSource, /openedFileContext/)
})

test('only resource body hits ask the document viewer to reveal their retained query', () => {
  assert.match(
    resourcePanelSource,
    /if \(hit\.reveal\) act\.revealResourceFile\(hit\.path, hit\.reveal\)/
  )
  assert.match(
    globalSearchSource,
    /if \(hit\.reveal\) act\.revealResourceFile\(hit\.id, hit\.reveal\)/
  )
  assert.match(
    storeSource,
    /revealResourceFile: \(path, reveal, projectId\) => \{[\s\S]*?forProject\(project\)\s*\.revealText\(source, reveal\)[\s\S]*?setState\(/
  )
})

test('global search only renders resource, literature, and conversation groups', () => {
  assert.match(globalSearchSource, /const DOMAIN_ORDER = \['resource', 'literature', 'session'\]/)
  assert.doesNotMatch(globalSearchSource, /writing: \{ label: '文稿'/)
})

test('global search scopes the empty-query recent list to the active search project', () => {
  assert.match(globalSearchSource, /const RECENT_FILE_DISPLAY_LIMIT = 5/)
  assert.match(
    globalSearchSource,
    /state\.recentFiles[\s\S]*\.slice\(0, RECENT_FILE_DISPLAY_LIMIT\)/
  )
  // 最近打开必须与搜索结果同口径：按 searchProjectId 过滤后再取前 5 条。
  assert.match(
    globalSearchSource,
    /state\.recentFiles\s*\.filter\([\s\S]*?searchProjectId === null \|\| entry\.projectId === searchProjectId[\s\S]*?\.slice\(0, RECENT_FILE_DISPLAY_LIMIT\)/
  )
  assert.match(globalSearchSource, /hits === null \?[\s\S]*data-testid="search-recent"/)
  assert.match(globalSearchSource, /data-testid="search-recent-file"/)
  assert.match(globalSearchSource, /openResourceTarget\(act, entry\)/)
  assert.match(
    navigationSource,
    /if \(target\.projectId\) actions\.selectProject\(target\.projectId\)[\s\S]*actions\.openWorkbenchView\('resource'\)[\s\S]*actions\.openResourceFile\(target\.path, target\.projectId\)/
  )
})

test('successful resource opens update the persisted MRU after the document loader resolves', () => {
  assert.match(
    storeSource,
    /openResourceFile: \(path, projectId, attachment\) => \{[\s\S]*opened\.then\(\(tabId\) => \{[\s\S]*session\?\.loadState === 'ready'[\s\S]*touchRecentFile\(current\.recentFiles/
  )
  assert.match(
    storeSource,
    /revealResourceFile: \(path, reveal, projectId\) => \{[\s\S]*\.then\(\(tabId\) => \{[\s\S]*touchRecentFile\(current\.recentFiles/
  )
})

test('project document tabs share the resource tree context queue before local attachment registration', () => {
  const action = storeSource.slice(
    storeSource.indexOf('    attachActiveFileToAi: async () => {'),
    storeSource.indexOf('    openAiContextPicker:')
  )
  const parsed = ts.createSourceFile(
    'store.tsx',
    storeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const branches: ts.IfStatement[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(parsed) === "document.source.kind === 'project'"
    )
      branches.push(node)
    ts.forEachChild(node, visit)
  }
  const handlers: ts.ArrowFunction[] = []
  function findHandler(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(parsed) === 'attachActiveFileToAi' &&
      ts.isArrowFunction(node.initializer)
    )
      handlers.push(node.initializer)
    ts.forEachChild(node, findHandler)
  }
  findHandler(parsed)
  assert.equal(handlers.length, 1)
  visit(handlers[0])
  assert.equal(branches.length, 1)
  const branch = branches[0].thenStatement
  assert.ok(ts.isBlock(branch))
  assert.ok(ts.isReturnStatement(branch.statements.at(-1)!))
  const projectBranch = branch.statements.map((statement) => statement.getText(parsed)).join('\n')
  assert.ok(projectBranch)
  assert.match(projectBranch, /await actRef\.current\.addAiContextRef\(\{/)
  assert.match(projectBranch, /kind: 'file'/)
  assert.match(projectBranch, /sourceId: document\.source\.path/)
  assert.match(projectBranch, /projectId: document\.source\.project/)
  assert.match(projectBranch, /label: document\.title/)
  assert.match(projectBranch, /return\s*$/)
  assert.doesNotMatch(projectBranch, /registerLocalPaths|composerRefs|resolveDocumentLocation/)
  assert.ok(action.indexOf(branch.getText(parsed)) < action.indexOf('resolveDocumentLocation'))
  assert.doesNotMatch(action, /contextErrors\.wrongProject/)
})

test('literature attachment tabs expose file-path actions and attach through the message file channel', () => {
  assert.match(
    documentMenuSource,
    /session\.source\.kind === 'project' \|\| session\.source\.kind === 'literature'/
  )
  assert.match(documentMenuSource, /act\.copyActiveDocumentPath\(\)/)
  assert.match(documentMenuSource, /act\.revealActiveDocument\(\)/)
  assert.match(
    storeSource,
    /function activeLocatedDocument[\s\S]*state\.homeSelectedProjectId \?\? assistantProject\(state\)\.projectId/
  )
  assert.match(
    storeSource,
    /attachActiveFileToAi:[\s\S]*resolveDocumentLocation\(document\.source\)[\s\S]*registerLocalPaths\([\s\S]*\[absolute\][\s\S]*composerRefs/
  )
  assert.match(
    storeSource,
    /const literatureSource = document\.source[\s\S]*previewSource: literatureSource/
  )
  assert.match(storeSource, /registrationRequired: true/)
  assert.match(storeSource, /const title =\s*document\.source\.path\.split/)
  assert.match(
    composerSource,
    /registrations[\s\S]*registerLocalPaths\([\s\S]*targetSessionId[\s\S]*submittedReferences[\s\S]*buildTurnInput\(v, submittedReferences\)/
  )
  assert.match(composerSource, /title: reference\.title \|\| registeredReference\.name/)
  assert.doesNotMatch(
    storeSource,
    /attachActiveFileToAi:[\s\S]{0,1800}addContext\(\{[\s\S]*source_id: location\.absolute/
  )
})

test('literature message files retain their original preview identity before a session exists', () => {
  const references = readFileSync(new URL('./contracts/assistant.ts', import.meta.url), 'utf8')
  assert.match(references, /previewSource\?: LiteratureDocumentSource \| SessionFileSource/)
  assert.match(
    storeSource,
    /attachActiveFileToAi:[\s\S]*const literatureSource = document\.source[\s\S]*previewSource: literatureSource/
  )
  const attachmentList = readFileSync(
    new URL('./components/primitive/AttachmentList.tsx', import.meta.url),
    'utf8'
  )
  assert.match(attachmentsSource, /<AttachmentList \{\.\.\.props\} openPaths=\{openPaths\}/)
  assert.match(attachmentList, /source: ref\.previewSource/)
  assert.match(
    storeSource,
    /openFilePreview: \(filePreview\)[\s\S]*if \(filePreview\.source\)[\s\S]*source = filePreview\.source/
  )
  assert.doesNotMatch(inputSource, /previewSource/)
})

test('resource mutations translate browser failures to a stable actionable code', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  try {
    assert.deepEqual(
      await mutateResourceNode('create_document', { parent: '', name: '研究笔记.md' }, 'p1'),
      { ok: false, error: 'network_error' }
    )
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('local import uses the same endpoint for conflict preview and resolution', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    if (requests.length === 1) {
      return Response.json({
        status: 'needs_resolution',
        plan_token: 'sha256:plan',
        conflicts: [
          {
            source_index: 0,
            source_name: 'report.md',
            source_kind: 'file',
            target_path: 'resources/report.md',
            target_kind: 'file',
            suggested_name: 'report (2).md',
            expected_target_revision: 'sha256:old',
            can_replace_with_version: true,
          },
        ],
      })
    }
    return Response.json({
      status: 'completed',
      project_id: 'project-1',
      imported: [
        {
          path: 'resources/report.md',
          name: 'report.md',
          kind: 'file',
          count: null,
        },
      ],
    })
  }
  try {
    const preview = await importResources('copy', ['/tmp/report.md'], '', 'project-1')
    assert.equal(preview.ok && preview.status, 'needs_resolution')
    assert.deepEqual(preview.ok && preview.status === 'needs_resolution' && preview.conflicts, [
      {
        sourceIndex: 0,
        sourceName: 'report.md',
        sourceKind: 'file',
        targetPath: 'resources/report.md',
        targetKind: 'file',
        suggestedName: 'report (2).md',
        expectedTargetRevision: 'sha256:old',
        canReplaceWithVersion: true,
      },
    ])
    const completed = await importResources('copy', ['/tmp/report.md'], '', 'project-1', {
      planToken: 'sha256:plan',
      action: 'replace',
      sourceIndexes: [0],
      idempotencyKey: 'import-key',
    })
    assert.equal(completed.ok && completed.status, 'completed')
    assert.equal(
      completed.ok && completed.status === 'completed' && completed.projectId,
      'project-1'
    )
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, 'http://service.test/api/resource/import')
    assert.equal(requests[1].url, 'http://service.test/api/resource/import')
    assert.equal(new Headers(requests[0].init?.headers).has('Idempotency-Key'), false)
    assert.equal(new Headers(requests[1].init?.headers).get('Idempotency-Key'), 'import-key')
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
      mode: 'copy',
      sources: ['/tmp/report.md'],
      target_dir: '',
      project: 'project-1',
      plan_token: 'sha256:plan',
      decisions: [{ source_index: 0, action: 'replace' }],
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('resource import resolves collisions inside the existing dialog', () => {
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.conflictTitle', [
    '发现同名资料',
    'Resources with matching names found',
  ])
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.replaceImport', [
    '覆盖并保存为新版本',
    'Replace and save new versions',
  ])
  assert.doesNotMatch(resourceImportDialogSource, /覆盖并保留旧版本/)
  assert.match(resourceImportDialogSource, /data-testid="resource-import-rename"/)
  assert.match(resourceImportDialogSource, /data-testid="resource-import-replace"/)
  assert.match(resourceImportDialogSource, /disabled=\{busy !== null \|\| !canReplace\}/)
  assert.doesNotMatch(resourceImportDialogSource, /<Alert[\s\S]*tone="error"/)
  assert.doesNotMatch(resourceImportDialogSource, /<AlertDialog/)
  assert.match(
    storeSource,
    /forProject\(result\.projectId\)\.reconcileProjectPaths\(\s*result\.projectId,\s*result\.imported[\s\S]*?\.map\(\(node\) => node\.path\)\s*\)/
  )
})

test('resource import selection follows the dual dropzone reference with shared atoms', () => {
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.title', [
    '导入文件或文件夹',
    'Import files or folders',
  ])
  assert.match(resourceImportDialogSource, /<DialogTitle[\s\S]*\{t\('localImport\.title'\)\}/)
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.copyTitle', [
    '复制到项目',
    'Copy to project',
  ])
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.linkTitle', [
    '关联本地原文件',
    'Link local originals',
  ])
  assert.match(resourceImportDialogSource, /variant="dropzone"/)
  assert.match(resourceImportDialogSource, /data-testid="resource-import-drop-hint"/)
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.pickFile', [
    '选择文件',
    'Choose files',
  ])
  assertLocalized(resourceImportDialogSource, 'resources', 'localImport.pickDirectory', [
    '选择文件夹',
    'Choose folders',
  ])
  assert.match(
    resourceImportDialogSource,
    /supportsImportPickerTarget\(\s*window\.scholarseed\?\.platform,\s*IMPORT_PICKER_TARGET\.RESOURCE\s*\)/
  )
  assert.match(
    resourceImportDialogSource,
    /pickAndImport\(choice\.mode, IMPORT_PICKER_TARGET\.RESOURCE\)/
  )
  assert.match(
    resourceImportDialogSource,
    /pickAndImport\(choice\.mode, IMPORT_PICKER_TARGET\.FILE\)/
  )
  assert.match(
    resourceImportDialogSource,
    /pickAndImport\(choice\.mode, IMPORT_PICKER_TARGET\.DIRECTORY\)/
  )
  assert.match(resourceImportDialogSource, /<DropdownMenu/)
  assert.match(resourceImportDialogSource, /!z-\[calc\(var\(--vds-z-modal\)\+1\)\]/)
  assert.doesNotMatch(
    resourceImportDialogSource,
    /data-testid=\{`import-\$\{choice\.mode\}-drop-hint`\}/
  )
  assert.doesNotMatch(resourceImportDialogSource, /<button/)
})

test('version capability reads always bypass the HTTP cache', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'http://service.test/api/resource/capability?project=p1&path=notes%2Freview.docx'
      )
      assert.equal(init?.credentials, 'include')
      assert.equal(init?.cache, 'no-store')
      return Response.json({ can_version: true })
    }
    assert.deepEqual(await fetchVersionCapability('p1', 'notes/review.docx'), { can_version: true })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('web search opens a unique ephemeral workbench tab', () => {
  const tab = createWebSearchTab(
    '  一个非常非常长的全网搜索问题，需要在标题栏里被安全稳定地截断并保留辨识度  ',
    'project-alpha',
    () => 'fixed'
  )
  assert.equal(tab.id, 'web-search:fixed')
  assert.equal(tab.kind, 'web_search')
  assert.equal(tab.projectId, 'project-alpha')
  assert.equal(tab.closable, true)
  assert.equal(tab.title.endsWith('…'), true)
})

test('web search creation, navigation, rendering and imports retain project ownership', () => {
  assert.match(
    storeSource,
    /createWebSearchTab\(query, stateRef\.current\.homeSelectedProjectId\)/u
  )
  assert.match(tabBarSource, /tabMatchesProject\(tab, state\.homeSelectedProjectId\)/u)
  assert.match(workbenchSource, /tabMatchesProject\(entry, state\.homeSelectedProjectId\)/u)
  assert.match(
    webSearchTabSource,
    /state\.tabs\.find\(\(tab\) => tab\.id === tabId\)\?\.projectId/u
  )
  assert.match(
    webSearchTabSource,
    /state\.projects\.find\(\(candidate\) => candidate\.id === projectId\)/u
  )
  assert.doesNotMatch(webSearchTabSource, /selectedProject\(state\)/u)
})

test('web search results resolve same-site favicons with the Avatar fallback intact', () => {
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  try {
    assert.equal(
      webSearchSiteIconUrl('https://www.example.com:8443/articles/result?q=search#section'),
      'http://service.test/api/resource/web-icon?url=https%3A%2F%2Fwww.example.com%3A8443'
    )
    assert.equal(webSearchSiteIconUrl('file:///tmp/result.html'), undefined)
    assert.equal(webSearchSiteIconUrl('not a url'), undefined)
    assert.match(webSearchTabSource, /image=\{webSearchSiteIconUrl\(candidate\.url\)\}/)
    assert.match(webSearchTabSource, /fallback=\{sourceMark\(candidate\.source\)\}/)
  } finally {
    globalThis.window = originalWindow
  }
})

test('resource library keeps automatic web-search routing out of the input controls', () => {
  assert.doesNotMatch(resourcePanelSource, /data-testid="resource-search-policy"/)
  assert.doesNotMatch(resourcePanelSource, /自动 · Web Search 优先/)
  assert.doesNotMatch(resourcePanelSource, /data-testid="resource-search-mode"/)
  assert.match(
    resourcePanelSource,
    /onClick=\{\(\) => act\.startWebSearch\(resource\.searchText\)\}/
  )
  assert.match(storeSource, /startWebSearch: \(text\) =>/)
  assert.match(
    storeSource,
    /tabId: tab\.id,\s+query,\s+startedAt: Date\.now\(\),\s+attempts: \[\],\s+status: 'opening'/
  )
  assert.match(storeSource, /runWebSearchRoute/)
  assert.match(webSearchDriverSource, /streamAgentInvocation/)
  assert.match(webSearchActivitySource, /attempt\.status === 'unavailable'/)
  assert.doesNotMatch(webSearchTabSource, /deliverNotice\('fallback'/)
  assert.match(
    webSearchTabSource,
    /if \(failureError && SILENT_SEARCH_FAILURES\.has\(failureError\)\) return/
  )
  assert.match(webSearchTabSource, /deliverNotice\('result'/)
  assertLocalized(webSearchFeedbackSource, 'resources', 'webFeedback.browserReason', [
    '原因：{{reason}} 书深已使用内置浏览器继续搜索。',
    'Reason: {{reason}} ScholarSeed continued the search in the built-in browser.',
  ])
  assert.match(
    webSearchFeedbackSource,
    /t\('webFeedback\.browserReason', \{ reason: webSearchFailureText\(t, message\.error\) \}\)/
  )
  assert.match(webSearchTabSource, /data-testid="web-search-loading"/)
  assert.match(webSearchTabSource, /<Skeleton/)
  assert.doesNotMatch(webSearchTabSource, /webSearchProcessSteps/)
  assert.doesNotMatch(webSearchTabSource, />搜索过程</)
  assert.match(storeSource, /webSearchInvocations\.current\.get\(id\)/)
  assert.doesNotMatch(webSearchTabSource, /openSession|postTurn|deleteSession/)
  assert.doesNotMatch(resourcePanelSource, /toggleAiScope|askAiFromPanel/)
})

test('web-search operation outcomes use the shared Toast primitive', () => {
  assert.match(rendererMainSource, /<ToastProvider>/)
  assert.match(rendererMainSource, /<Toaster/)
  assert.match(webSearchTabSource, /useToast/)
  assertLocalized(webSearchTabSource, 'resources', 'webFeedback.completed', [
    '全网搜索已完成',
    'Web search completed',
  ])
  assertLocalized(webSearchTabSource, 'resources', 'webFeedback.requestFailed', [
    '保存请求未完成',
    'Save request did not complete',
  ])
  assert.match(webImportDestinationSource, /useToast/)
  assertLocalized(webImportDestinationSource, 'resources', 'destination.created', [
    '已创建并选择文件夹',
    'Folder created and selected',
  ])
  assert.doesNotMatch(
    webSearchTabSource,
    /data-testid="web-search-(?:error|fallback|import-error|import-summary)"/
  )
  assert.doesNotMatch(webImportDestinationSource, /<Alert/)
})

test('web-search finish notice is delivered once per search, not once per mount', () => {
  const search: ResourceWebSearch = {
    tabId: 'web-search:test',
    query: '黄山旅游',
    startedAt: 1,
    attempts: [],
    status: 'completed',
    selectedUrls: [],
    importing: false,
    importResults: {},
    notified: [],
  }

  assert.equal(webSearchNoticePending(search, 'result'), true)
  const delivered = withWebSearchNotice(search, 'result')
  assert.deepEqual(delivered.notified, ['result'])
  assert.equal(webSearchNoticePending(delivered, 'result'), false)
  assert.equal(withWebSearchNotice(delivered, 'result'), delivered)
  assert.equal(webSearchNoticePending(delivered, 'fallback'), true)
  assert.deepEqual(withWebSearchNotice(delivered, 'fallback').notified, ['result', 'fallback'])

  // 记账必须落在搜索状态上；记在组件 ref 里会随切换标签卸载而丢失，导致重复弹提示。
  assert.match(storeSource, /importResults: \{\},\s+notified: \[\]/)
  assert.match(webSearchTabSource, /webSearchNoticePending\(search, notice\)/)
  assert.match(webSearchTabSource, /withWebSearchNotice\(existing, notice\)/)
  assert.doesNotMatch(webSearchTabSource, /deliveredToastIds/)
})

test('web-search results expose the title as one accessible external action', () => {
  assertLocalized(webSearchTabSource, 'resources', 'webSearch.results', [
    '检索结果',
    'Search results',
  ])
  assert.match(
    webSearchTabSource,
    /<CardTitle[\s\S]*?<Button[\s\S]*?data-testid=\{`web-search-result-title-\$\{index\}`\}[\s\S]*?candidate\.title[\s\S]*?<ArrowUpRight/
  )
  assertLocalized(webSearchTabSource, 'resources', 'webSearch.open', [
    '打开网页：{{title}}',
    'Open web page: {{title}}',
  ])
  assert.match(
    webSearchTabSource,
    /aria-label=\{t\('webSearch\.open', \{ title: candidate\.title \}\)\}/
  )
  assert.match(webSearchTabSource, /openExternal\(candidate\.url\)/)
  assert.doesNotMatch(webSearchTabSource, /<IconButton[\s\S]*?ArrowUpRight/)
  assert.doesNotMatch(webSearchTabSource, />\s*打开网页\s*</)
  assert.doesNotMatch(webSearchTabSource, />\s*-\s*\{candidate\.source\}\s*</)
  assert.doesNotMatch(webSearchTabSource, /vds-web-search-url/)
})

test('web-search results fill the workbench and use atomic import actions', () => {
  assert.match(
    webSearchTabSource,
    /className="[^"]*\bw-full\b[^"]*"\s+data-testid="web-search-tab"/
  )
  assert.doesNotMatch(workbenchStyles, /width:\s*min\(920px/)
  assert.match(
    webSearchTabSource,
    /data-testid="web-search-save"[\s\S]*onClick=\{openImportDialog\}/
  )
  assert.match(
    webSearchTabSource,
    /<WebImportDestination[\s\S]*onConfirm=\{\(\) => void saveSelected\(importParent\)\}[\s\S]*open=\{importDialogOpen\}/
  )
  assert.match(webImportDestinationSource, /data-testid="web-search-import-dialog"/)
  assert.match(webImportDestinationSource, /data-testid="web-import-folder-root"/)
  assert.match(
    webImportDestinationSource,
    /data-testid="web-search-import-confirm"[\s\S]*onClick=\{onConfirm\}/
  )
  assertLocalized(webImportDestinationSource, 'resources', 'destination.target', [
    '目标目录',
    'Destination directory',
  ])
  assertLocalized(webSearchTabSource, 'resources', 'webSearch.importSelected', [
    '导入所选',
    'Import selected',
  ])
})

function browserSearchPayload(
  candidates: Array<{ title: string; url: string; description: string }>,
  options: {
    status?: 'completed' | 'empty' | 'action_required' | 'failed'
    query?: string
    error?: { code: string; message: string } | null
  } = {}
): string {
  return JSON.stringify({
    schema: BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
    status: options.status ?? 'completed',
    provider: BROWSER_SEARCH_MODE,
    query: options.query ?? 'test',
    engine: 'bing',
    browser: 'chrome',
    started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.234Z',
    duration_ms: 1234,
    candidates,
    error: options.error ?? null,
  })
}

function invocationEvent(
  type: string,
  data: Record<string, unknown> = {},
  options: {
    seq?: number
    itemId?: string
    createdAt?: string
  } = {}
): AgentInvocationEvent {
  return {
    schema_version: 1,
    invocation_id: 'invocation-1',
    seq: options.seq ?? 1,
    type,
    turn_id: 'turn-1',
    item_id: options.itemId ?? '',
    data,
    created_at: Date.parse(options.createdAt ?? '2026-09-08T06:30:00.000Z') / 1000,
  }
}

function browserInvocationEvents(publicationCount = 1): AgentInvocationEvent[] {
  return [
    invocationEvent('invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'browser' },
      execution: {
        permission_mode: 'bypassPermissions',
        network_access: true,
        web_search: false,
      },
    }),
    ...Array.from({ length: publicationCount }, (_, index) =>
      invocationEvent(
        'artifact.published',
        {
          artifact_id: `artifact-${index + 1}`,
          relative_path: BROWSER_SEARCH_ARTIFACT_PATH,
          role: 'final',
          mime_type: 'application/json',
          size_bytes: 120,
          sha256: 'a'.repeat(64),
        },
        {
          seq: index + 2,
          itemId: `browser-search-${index + 1}`,
          createdAt: `2026-09-08T06:30:0${index + 1}.000Z`,
        }
      )
    ),
  ]
}

function automaticArtifactInvocationEvents(artifactPath: string): AgentInvocationEvent[] {
  return [
    invocationEvent('invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'automatic' },
      execution: { permission_mode: 'bypassPermissions' },
    }),
    invocationEvent(
      'artifact.published',
      {
        artifact_id: 'automatic-artifact',
        relative_path: artifactPath,
        role: 'final',
        mime_type: 'application/json',
        size_bytes: 120,
        sha256: 'a'.repeat(64),
      },
      { seq: 2, itemId: 'automatic-search-1' }
    ),
  ]
}

function webSearchCandidatesText(
  candidates: Array<{ title: string; url: string; description: string }>
): string {
  return [
    '<scholarseed_web_search_results>',
    JSON.stringify({
      schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
      status: candidates.length > 0 ? 'completed' : 'empty',
      provider: WEB_SEARCH_CANDIDATES_MODE,
      query: 'test',
      candidates,
      error: null,
    }),
    '</scholarseed_web_search_results>',
  ].join('\n')
}

function nativeWebSearchEvents(): AgentInvocationEvent[] {
  return [
    invocationEvent('invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'native' },
    }),
    invocationEvent(
      'web_search.started',
      { query: 'test', action: { type: 'search', query: 'test' } },
      { seq: 2, itemId: 'native-search-1' }
    ),
    invocationEvent(
      'web_search.completed',
      {
        query: 'test',
        action: { type: 'search', query: 'test' },
        result_count: 1,
      },
      {
        seq: 3,
        itemId: 'native-search-1',
        createdAt: '2026-09-08T06:30:02.500Z',
      }
    ),
  ]
}

test('automatic resource search does not require agent planning', () => {
  const request = automaticWebSearchInvocationRequest('ai大模型')
  assert.doesNotMatch(request.prompt, /update_plan/)
  assert.equal(request.developer_prompt, true)
  assert.deepEqual(request.skill, { id: 'builtin:web-search', profile: 'automatic' })
})

test('automatic web search prioritizes the official API before native and browser fallback', () => {
  assert.deepEqual(WEB_SEARCH_AUTOMATIC_ROUTE, [
    OFFICIAL_SEARCH_MODE,
    WEB_SEARCH_CANDIDATES_MODE,
    BROWSER_SEARCH_MODE,
  ])
  const automatic = automaticWebSearchInvocationRequest('query')
  assert.equal(automatic.skill?.profile, 'automatic')
  assert.equal(automatic.execution.web_search, true)
  assert.match(automatic.prompt, /--provider official-api/)
  assert.match(automatic.prompt, /--provider visible-browser/)
  assert.match(automatic.prompt, /web-search-official-result\.json/)
  assert.match(automatic.prompt, /web-search-browser-result\.json/)
  assert.deepEqual(webSearchModeDefinition(WEB_SEARCH_CANDIDATES_MODE).requiredCapabilities, [
    'web_search',
  ])
  assert.deepEqual(webSearchModeDefinition(BROWSER_SEARCH_MODE).requiredCapabilities, [])
  assert.deepEqual(webSearchInvocationRequest('query', WEB_SEARCH_CANDIDATES_MODE).skill, {
    id: 'builtin:web-search',
    profile: 'native',
  })
  assert.equal(
    webSearchInvocationRequest('query', WEB_SEARCH_CANDIDATES_MODE).execution.web_search,
    true
  )
  assert.equal(
    webSearchInvocationRequest('query', WEB_SEARCH_CANDIDATES_MODE).developer_prompt,
    true
  )
  assert.equal(webSearchInvocationRequest('query', OFFICIAL_SEARCH_MODE).developer_prompt, false)
  assert.equal(webSearchInvocationRequest('query', BROWSER_SEARCH_MODE).developer_prompt, true)
  assert.deepEqual(webSearchInvocationRequest('query', BROWSER_SEARCH_MODE).execution, {
    web_search: false,
    sandbox: 'danger-full-access',
    network_access: true,
    reasoning_effort: 'low',
    service_tier: 'fast',
  })
  assert.deepEqual(webSearchInvocationRequest('query', WEB_SEARCH_CANDIDATES_MODE).execution, {
    web_search: true,
    sandbox: 'danger-full-access',
    network_access: true,
    reasoning_effort: 'low',
    service_tier: 'fast',
  })
  assert.deepEqual(webSearchInvocationRequest('query', OFFICIAL_SEARCH_MODE).execution, {
    web_search: false,
    sandbox: 'danger-full-access',
    network_access: true,
    reasoning_effort: 'low',
    service_tier: 'fast',
  })
})

test('web search keeps bounded mode evidence while preserving the Invocation identity', () => {
  const started = invocationEvent('invocation.started', {
    skill: { id: 'builtin:web-search', profile: 'native' },
  })
  const ignored = invocationEvent('content.delta', { delta: 'private model text' })
  assert.deepEqual(appendWebSearchProjectionEvent([started], ignored), [started])
  const plan = invocationEvent(
    'plan.updated',
    {
      todos: [{ content: '动态搜索阶段', status: 'in_progress' }],
    },
    { seq: 2 }
  )
  assert.deepEqual(appendWebSearchProjectionEvent([started], plan), [started, plan])

  const events = Array.from({ length: WEB_SEARCH_PROJECTION_EVENT_LIMIT + 5 }, (_, index) =>
    invocationEvent(
      'web_search.completed',
      { query: `query-${index}`, result_count: 1 },
      { seq: index + 2, itemId: `search-${index}` }
    )
  ).reduce(appendWebSearchProjectionEvent, [started])

  assert.equal(events.length, WEB_SEARCH_PROJECTION_EVENT_LIMIT)
  assert.equal(events[0], started)
  assert.equal(events.at(-1)?.item_id, `search-${WEB_SEARCH_PROJECTION_EVENT_LIMIT + 4}`)

  const completed = invocationEvent(
    'web_search.completed',
    { query: 'test', result_count: 1 },
    { seq: WEB_SEARCH_PROJECTION_EVENT_LIMIT + 20, itemId: 'verified-search' }
  )
  const withEvidence = [
    completed,
    ...Array.from({ length: WEB_SEARCH_PROJECTION_EVENT_LIMIT + 20 }, (_, index) =>
      invocationEvent(
        'plan.updated',
        { todos: [{ content: `动态阶段 ${index}`, status: 'in_progress' }] },
        { seq: WEB_SEARCH_PROJECTION_EVENT_LIMIT + 21 + index }
      )
    ),
  ].reduce(appendWebSearchProjectionEvent, [started])
  const projection = projectWebSearch(
    withEvidence,
    WEB_SEARCH_CANDIDATES_MODE,
    webSearchCandidatesText([{ title: '结果', url: 'https://example.com', description: '描述' }])
  )

  assert.equal(withEvidence.length, WEB_SEARCH_PROJECTION_EVENT_LIMIT)
  assert.equal(
    withEvidence.some((candidate) => candidate === started),
    true
  )
  assert.equal(
    withEvidence.some((candidate) => candidate === completed),
    true
  )
  assert.equal(projection.executionEvidenceFound, true)
  assert.equal(projection.structuredOutputFound, true)
})

test('browser search prompt requires the visible local browser skill and its output contract', () => {
  assert.equal(WEB_SEARCH_CANDIDATE_LIMIT, 20)
  const prompt = webSearchPrompt('NotebookLM 全网搜索', BROWSER_SEARCH_MODE)
  assert.match(prompt, /可见的本机浏览器和 Bing/)
  assert.match(prompt, new RegExp(BROWSER_SEARCH_OUTPUT_SCHEMA_ID.replace(/\./g, '\\.')))
  assert.match(prompt, new RegExp(`最多 ${WEB_SEARCH_CANDIDATE_LIMIT} 个`))
  assert.match(prompt, new RegExp(BROWSER_SEARCH_MODE))
  assert.match(prompt, /第一步必须调用 update_plan/)
  assert.match(prompt, /不得套用固定模板/)
  assert.match(prompt, /scripts\/invoke\.py/)
  assert.match(prompt, new RegExp(BROWSER_SEARCH_ARTIFACT_PATH.replace(/\./g, '\\.')))
  assert.match(prompt, /不得改用 Agent 原生 Web Search/)
  assert.match(prompt, /不要打开候选网页/)
})

test('web-search-candidates prompt requires native Web Search and marked output', () => {
  const prompt = webSearchPrompt('NotebookLM 全网搜索', WEB_SEARCH_CANDIDATES_MODE)
  assert.match(prompt, /Agent 已有的 Web Search 能力/)
  assert.match(prompt, /第一步必须调用 update_plan/)
  assert.match(prompt, /不得套用固定模板/)
  assert.match(prompt, new RegExp(WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID.replace(/\./g, '\\.')))
  assert.match(prompt, /<scholarseed_web_search_results>/)
  assert.match(prompt, /native profile/)
  assert.doesNotMatch(prompt, /scripts\/search\.sh/)
})

test('official search prompt skips agent planning and keeps the artifact contract', () => {
  const prompt = webSearchPrompt('NotebookLM 全网搜索', OFFICIAL_SEARCH_MODE)
  assert.match(prompt, /official profile/)
  assert.match(prompt, /scripts\/invoke\.py/)
  assert.match(prompt, new RegExp(BROWSER_SEARCH_ARTIFACT_PATH.replace(/\./g, '\\.')))
  assert.doesNotMatch(prompt, /update_plan/)
  assert.doesNotMatch(prompt, /不得套用固定模板/)
})

test('web search projection accepts browser-search final artifacts and validates candidates', () => {
  const candidates = Array.from({ length: WEB_SEARCH_CANDIDATE_LIMIT + 3 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://www.example${index}.test/path#section`,
    description: `Description ${index}`,
  }))
  candidates.splice(1, 0, {
    title: 'Duplicate result',
    url: 'https://www.example0.test/path',
    description: 'Duplicate description',
  })
  candidates.splice(2, 0, {
    title: 'Private file',
    url: 'file:///tmp/private',
    description: 'Invalid local result',
  })
  candidates.splice(3, 0, {
    title: 'Missing description',
    url: 'https://missing-description.test/path',
    description: '',
  })
  const projected = projectWebSearch(
    browserInvocationEvents(),
    BROWSER_SEARCH_MODE,
    browserSearchPayload(candidates),
    'test'
  )
  assert.equal(projected.executionEvidenceFound, true)
  assert.equal(projected.structuredOutputFound, true)
  assert.deepEqual(projected.validationIssues, [])
  assert.equal(projected.candidates.length, WEB_SEARCH_CANDIDATE_LIMIT)
  assert.equal(projected.candidates[0].url, 'https://www.example0.test/path')
  assert.equal(projected.candidates[0].title, 'Result 0')
  assert.equal(projected.candidates[0].description, 'Description 0')
  assert.equal(projected.candidates[0].source, 'example0.test')
  assert.equal(projected.startedAt, '2026-09-08T06:30:00.000Z')
  assert.equal(projected.completedAt, '2026-09-08T06:30:01.234Z')
  assert.equal(projected.durationMs, 1234)
  assert.equal(
    projected.candidates.some((candidate) => candidate.url.startsWith('file:')),
    false
  )
  assert.equal(
    projected.candidates.some((candidate) => candidate.url.includes('missing-description')),
    false
  )
  assert.deepEqual(projected.operations, [
    {
      searchId: 'browser-search-1',
      label: 'Bing 本机浏览器搜索 1',
      query: 'test',
      status: 'done',
      resultCount: candidates.length,
      startedAt: Date.parse('2026-09-08T06:30:00.000Z'),
      completedAt: Date.parse('2026-09-08T06:30:01.234Z'),
    },
  ])
})

test('automatic result projection accepts immutable official and browser artifact paths', () => {
  for (const [mode, artifactPath] of [
    [OFFICIAL_SEARCH_MODE, AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH],
    [BROWSER_SEARCH_MODE, AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH],
  ] as const) {
    const payload = JSON.stringify({
      schema: BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
      status: 'completed',
      provider: mode,
      query: 'test',
      engine: 'bing',
      browser: 'chrome',
      started_at: '2026-09-08T06:30:00.000Z',
      completed_at: '2026-09-08T06:30:01.234Z',
      duration_ms: 1234,
      candidates: [
        { title: 'Automatic result', url: 'https://automatic.test', description: 'Description' },
      ],
      error: null,
    })
    const projected = projectWebSearch(
      automaticArtifactInvocationEvents(artifactPath),
      mode,
      payload,
      'test',
      artifactPath
    )
    assert.equal(projected.executionEvidenceFound, true)
    assert.equal(projected.structuredOutputFound, true)
    assert.deepEqual(
      verifiedWebSearchCandidates(projected).map((candidate) => candidate.url),
      ['https://automatic.test/']
    )
  }
})

test('web search formats the complete product completion time and duration', () => {
  const label = webSearchTimeLabel(1_000, 2_234)
  assert.match(label ?? '', /^完成于 .+ · 用时 1\.2 秒$/)
  assert.equal(webSearchTimeLabel(undefined, 2_234), null)
  assert.equal(webSearchTimeLabel(1_000, undefined), null)
})

test('web-search-candidates projection requires native evidence and marked candidates', () => {
  const candidate = {
    title: 'Native result',
    url: 'https://www.native.test/result#section',
    description: 'Description returned by Agent Web Search.',
  }
  const projected = projectWebSearch(
    nativeWebSearchEvents(),
    WEB_SEARCH_CANDIDATES_MODE,
    webSearchCandidatesText([candidate])
  )

  assert.equal(projected.executionEvidenceFound, true)
  assert.equal(projected.structuredOutputFound, true)
  assert.deepEqual(projected.validationIssues, [])
  assert.deepEqual(projected.candidates, [
    {
      title: candidate.title,
      url: 'https://www.native.test/result',
      source: 'native.test',
      description: candidate.description,
    },
  ])
  assert.deepEqual(projected.operations, [
    {
      searchId: 'native-search-1',
      label: 'Web Search 1',
      query: 'test',
      status: 'done',
      resultCount: 1,
      startedAt: Date.parse('2026-09-08T06:30:00.000Z'),
      completedAt: Date.parse('2026-09-08T06:30:02.500Z'),
    },
  ])
  assert.equal(projected.startedAt, '2026-09-08T06:30:00.000Z')
  assert.equal(projected.completedAt, '2026-09-08T06:30:02.500Z')
  assert.equal(projected.durationMs, 2500)
  assert.deepEqual(verifiedWebSearchCandidates(projected), projected.candidates)

  const claimOnly = projectWebSearch(
    [],
    WEB_SEARCH_CANDIDATES_MODE,
    webSearchCandidatesText([candidate])
  )
  assert.equal(claimOnly.executionEvidenceFound, false)
  assert.deepEqual(claimOnly.validationIssues, [
    'invocation_started_missing',
    'web_search_completed_missing',
  ])
  assert.deepEqual(verifiedWebSearchCandidates(claimOnly), [])

  const wrongSkill = projectWebSearch(
    nativeWebSearchEvents().map((event) =>
      event.type === 'invocation.started'
        ? { ...event, data: { skill: { id: 'builtin:web-search', profile: 'browser' } } }
        : event
    ),
    WEB_SEARCH_CANDIDATES_MODE,
    webSearchCandidatesText([candidate])
  )
  assert.equal(wrongSkill.executionEvidenceFound, false)
  assert.deepEqual(wrongSkill.validationIssues, ['invocation_skill_mismatch'])
  assert.deepEqual(verifiedWebSearchCandidates(wrongSkill), [])
})

test('web-search-candidates projection reports exact structured-output contract failures', () => {
  const marked = (value: string): string =>
    ['<scholarseed_web_search_results>', value, '</scholarseed_web_search_results>'].join('\n')
  const cases: Array<[string, string]> = [
    ['', 'result_text_empty'],
    ['unmarked native output', 'result_begin_marker_missing'],
    ['<scholarseed_web_search_results>{}', 'result_end_marker_missing'],
    [marked('{'), 'result_json_invalid'],
    [
      marked(
        JSON.stringify({
          schema: 'wrong',
          status: 'empty',
          provider: WEB_SEARCH_CANDIDATES_MODE,
          query: 'test',
          candidates: [],
          error: null,
        })
      ),
      'result_schema_mismatch',
    ],
    [
      marked(
        JSON.stringify({
          schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
          status: 'empty',
          provider: WEB_SEARCH_CANDIDATES_MODE,
          query: 123,
          candidates: [],
          error: null,
        })
      ),
      'result_query_invalid',
    ],
    [
      marked(
        JSON.stringify({
          schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
          status: 'empty',
          provider: WEB_SEARCH_CANDIDATES_MODE,
          query: 'test',
          candidates: {},
          error: null,
        })
      ),
      'result_candidates_invalid',
    ],
  ]

  for (const [resultText, expectedIssue] of cases) {
    const projected = projectWebSearch(
      nativeWebSearchEvents(),
      WEB_SEARCH_CANDIDATES_MODE,
      resultText
    )
    assert.equal(projected.executionEvidenceFound, true)
    assert.equal(projected.structuredOutputFound, false)
    assert.deepEqual(projected.validationIssues, [expectedIssue])
  }
})

test('browser search requires the selected Invocation skill and its published final artifact', () => {
  const payload = browserSearchPayload([
    {
      title: 'Browser result',
      url: 'https://browser.test/source',
      description: 'Description from the local browser result.',
    },
  ])
  const untrusted: AgentInvocationEvent[] = [
    invocationEvent('invocation.started', {
      skill: { id: 'builtin:web-search', profile: 'native' },
    }),
    ...nativeWebSearchEvents(),
    invocationEvent('artifact.published', {
      artifact_id: 'wrong-artifact',
      relative_path: 'unrelated.json',
      role: 'final',
      mime_type: 'application/json',
      size_bytes: 120,
      sha256: 'b'.repeat(64),
    }),
  ]
  const untrustedProjection = projectWebSearch(untrusted, BROWSER_SEARCH_MODE, payload, 'test')
  assert.equal(untrustedProjection.executionEvidenceFound, false)
  assert.equal(untrustedProjection.structuredOutputFound, true)
  assert.deepEqual(verifiedWebSearchCandidates(untrustedProjection), [])

  const readOnly = projectWebSearch(
    browserInvocationEvents().map((event) =>
      event.type === 'invocation.started'
        ? {
            ...event,
            data: {
              ...event.data,
              execution: {
                permission_mode: 'read_only',
                network_access: true,
                web_search: false,
              },
            },
          }
        : event
    ),
    BROWSER_SEARCH_MODE,
    payload,
    'test'
  )
  assert.equal(readOnly.executionEvidenceFound, false)
  assert.deepEqual(verifiedWebSearchCandidates(readOnly), [])

  const verified = projectWebSearch(browserInvocationEvents(), BROWSER_SEARCH_MODE, payload, 'test')
  assert.deepEqual(
    verified.candidates.map((candidate) => candidate.source),
    ['browser.test']
  )
  assert.deepEqual(verifiedWebSearchCandidates(verified), verified.candidates)
})

test('web search uses the last bounded browser query as the authoritative result', () => {
  const narrowed = browserSearchPayload([], {
    status: 'empty',
    query: 'narrowed query',
  })
  const projected = projectWebSearch(
    browserInvocationEvents(2),
    BROWSER_SEARCH_MODE,
    narrowed,
    'test'
  )

  assert.equal(projected.structuredOutputFound, true)
  assert.deepEqual(projected.candidates, [])
  assert.deepEqual(
    projected.operations.map((operation) => operation.query),
    ['test', 'narrowed query']
  )
})

test('web search duration labels preserve short work and scale to long searches', () => {
  assert.equal(webSearchDurationLabel(undefined, 1_000), null)
  assert.equal(webSearchDurationLabel(1_000, undefined), null)
  assert.equal(webSearchDurationLabel(1_000, 1_450), '0.5 秒')
  assert.equal(webSearchDurationLabel(1_000, 13_000), '12 秒')
  assert.equal(webSearchDurationLabel(1_000, 66_000), '1 分 5 秒')
  assert.equal(webSearchDurationLabel(5_000, 1_000), '0 秒')
})

test('terminal search without selected executor evidence and output is a failure', () => {
  assert.equal(
    webSearchOutputMissing({
      invocationStarted: true,
      terminal: true,
      executionEvidenceFound: true,
      structuredOutputFound: false,
    }),
    true
  )
  assert.equal(
    webSearchOutputMissing({
      invocationStarted: true,
      terminal: true,
      executionEvidenceFound: true,
      structuredOutputFound: true,
    }),
    false
  )
  assert.equal(
    webSearchOutputMissing({
      invocationStarted: true,
      terminal: false,
      executionEvidenceFound: false,
      structuredOutputFound: false,
    }),
    false
  )
  assert.equal(
    webSearchOutputMissing({
      invocationStarted: true,
      terminal: true,
      executionEvidenceFound: false,
      structuredOutputFound: true,
    }),
    true
  )
})

test('failed browser-search output reports its stable product error and hides candidates', () => {
  const failed = projectWebSearch(
    browserInvocationEvents(),
    BROWSER_SEARCH_MODE,
    browserSearchPayload([], {
      status: 'failed',
      error: {
        code: 'browser_launch_failed',
        message: 'raw browser failure',
      },
    }),
    'test'
  )

  assert.equal(failed.structuredOutputFound, true)
  assert.equal(failed.error, 'browser_launch_failed')
  assert.deepEqual(verifiedWebSearchCandidates(failed), [])
  assert.equal(failed.operations[0].status, 'failed')
})

test('web search projection normalizes and bounds candidate descriptions', () => {
  const payload = browserSearchPayload([
    {
      title: `  ${'T'.repeat(WEB_SEARCH_CANDIDATE_TITLE_LIMIT + 20)}  `,
      url: 'https://bounded.test/result',
      description: `  A   description\n${'D'.repeat(WEB_SEARCH_CANDIDATE_DESCRIPTION_LIMIT + 20)}  `,
    },
  ])
  const projected = projectWebSearch(
    browserInvocationEvents(),
    BROWSER_SEARCH_MODE,
    `diagnostic\n${payload}`,
    'test'
  )

  assert.equal(projected.candidates[0].title.length, WEB_SEARCH_CANDIDATE_TITLE_LIMIT)
  assert.equal(projected.candidates[0].description.length, WEB_SEARCH_CANDIDATE_DESCRIPTION_LIMIT)
  assert.equal(projected.candidates[0].description.includes('\n'), false)
  assert.equal(projected.candidates[0].description.includes('   '), false)
})

test('web import client sends selected candidates and preserves per-item outcomes', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> = {}
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      succeeded: 1,
      failed: 1,
      items: [
        {
          title: 'Saved page',
          url: 'https://saved.example/page',
          final_url: 'https://saved.example/final',
          status: 'success',
          node: {
            path: 'resources/Saved page.md',
            name: 'Saved page.md',
            kind: 'file',
            origin: 'local',
          },
        },
        {
          title: 'Dynamic page',
          url: 'https://dynamic.example/page',
          status: 'failed',
          error: 'web_content_unavailable',
        },
      ],
    })
  }
  try {
    const candidates = [
      { title: 'Saved page', url: 'https://saved.example/page', snippet: 'saved' },
      { title: 'Dynamic page', url: 'https://dynamic.example/page', snippet: 'dynamic' },
    ]
    const result = await importWebResources('project-1', 'llm', candidates, 'reviewed/web')

    assert.equal(capturedUrl, 'http://service.test/api/resource/web-import')
    assert.deepEqual(capturedBody, {
      project: 'project-1',
      query: 'llm',
      parent: 'reviewed/web',
      candidates,
    })
    assert.equal(result.ok, true)
    assert.equal(result.succeeded, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.items[0].finalUrl, 'https://saved.example/final')
    assert.equal(result.items[0].node?.path, 'resources/Saved page.md')
    assert.equal(result.items[1].error, 'web_content_unavailable')
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('web import client normalizes an over-limit 422 validation array into a readable code', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: [
          {
            type: 'too_long',
            loc: ['body', 'candidates'],
            msg: 'List should have at most 10 items after validation, not 11',
            input: [],
          },
        ],
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    )
  try {
    const candidates = Array.from({ length: WEB_IMPORT_SELECTION_LIMIT + 1 }, (_, index) => ({
      title: `page ${index}`,
      url: `https://example.test/${index}`,
      snippet: '',
    }))
    const result = await importWebResources('project-1', 'q', candidates)

    assert.equal(result.ok, false)
    assert.equal(result.error, 'web_import_candidate_limit')

    const i18n = createInstance()
    await i18n.init({
      lng: 'zh',
      fallbackLng: false,
      resources: {
        zh: {
          resources: JSON.parse(
            readFileSync(
              new URL('../../localization/locales/zh/resources.json', import.meta.url),
              'utf8'
            )
          ),
        },
        en: {
          resources: JSON.parse(
            readFileSync(
              new URL('../../localization/locales/en/resources.json', import.meta.url),
              'utf8'
            )
          ),
        },
      },
    })
    const zhText = importFailureMessage(i18n.getFixedT('zh', 'resources'), result.error)
    const enText = importFailureMessage(i18n.getFixedT('en', 'resources'), result.error)
    assert.match(zhText, /超过上限/)
    assert.match(enText, /per-import page limit/)
    assert.equal(zhText.includes('object Object'), false)
    assert.equal(enText.includes('object Object'), false)
    assert.equal(
      importFailureMessage(i18n.getFixedT('zh', 'resources'), { detail: [] } as unknown as string),
      '网页保存失败。'
    )
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('web import selection limit mirrors the serve per-import cap', () => {
  assert.equal(WEB_IMPORT_SELECTION_LIMIT, 10)
  assert.ok(WEB_IMPORT_SELECTION_LIMIT < WEB_SEARCH_CANDIDATE_LIMIT)
  // The renderer must make an over-limit submission unreachable: select-all is capped,
  // and both per-item selection and save refuse to grow the set past the serve limit.
  assert.match(
    webSearchTabSource,
    /eligibleCandidates\s*\n?\s*\.slice\(0, WEB_IMPORT_SELECTION_LIMIT\)/u
  )
  assert.match(webSearchTabSource, /selectedCandidates\.length >= WEB_IMPORT_SELECTION_LIMIT/u)
  assert.match(webSearchTabSource, /selectedCandidates\.length > WEB_IMPORT_SELECTION_LIMIT/u)
})

test('resource Agent origin lookup preserves the conversation focus target', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedCredentials = ''
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedCredentials = String(init?.credentials ?? '')
    return Response.json({
      source_kind: 'answer',
      session_id: 'session/1',
      turn_id: 'turn 1',
      item_id: 'item 1',
      source_range: { unit: 'utf16_code_unit', start: 12, end: 24 },
    })
  }
  try {
    const origin = await fetchResourceAgentOrigin('project/1', 'resources/回答 摘录.md')
    assert.equal(
      capturedUrl,
      'http://service.test/api/resource/agent-origin?project=project%2F1&path=resources%2F%E5%9B%9E%E7%AD%94+%E6%91%98%E5%BD%95.md'
    )
    assert.equal(capturedCredentials, 'include')
    assert.deepEqual(origin, {
      sourceKind: 'answer',
      sessionId: 'session/1',
      sessionDeleted: false,
      turnId: 'turn 1',
      itemId: 'item 1',
      sourceRange: { unit: 'utf16_code_unit', start: 12, end: 24 },
    })
    globalThis.fetch = async () =>
      Response.json({
        source_kind: 'artifact',
        session_id: 'deleted',
        session_deleted: true,
        turn_id: null,
        item_id: null,
      })
    assert.deepEqual(await fetchResourceAgentOrigin('project/1', 'resources/copy.md'), {
      sourceKind: 'artifact',
      sessionId: 'deleted',
      sessionDeleted: true,
      turnId: null,
      itemId: null,
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('literature excerpt context only accepts complete stable identities', () => {
  assert.deepEqual(
    asLiteratureExcerptSource({
      kind: LITERATURE_EXCERPT_SOURCE_KIND,
      literatureId: 'lit-1',
      title: 'Attention Is All You Need',
    }),
    {
      kind: LITERATURE_EXCERPT_SOURCE_KIND,
      literatureId: 'lit-1',
      title: 'Attention Is All You Need',
    }
  )
  assert.equal(
    asLiteratureExcerptSource({
      kind: LITERATURE_EXCERPT_SOURCE_KIND,
      literatureId: '',
      title: 'Missing ID',
    }),
    null
  )
  assert.equal(
    asLiteratureExcerptSource({
      kind: 'web',
      literatureId: 'lit-1',
      title: 'Wrong source',
    }),
    null
  )
})

test('literature excerpt client preserves multi-selection locators and import outcome', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> = {}
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' },
  } as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      operation: 'updated',
      node: {
        path: 'resources/文献摘录/Attention Is All You Need.md',
        name: 'Attention Is All You Need.md',
        kind: 'file',
        origin: 'local',
      },
      literature_id: 'lit-1',
      added: 1,
      skipped: 1,
      total: 4,
    })
  }
  try {
    const selections = [
      {
        text: 'Scaled dot-product attention.',
        locator: {
          kind: PDF_EXCERPT_LOCATOR_KIND,
          page: 3,
          quads: [[0.12, 0.23, 0.78, 0.27] as const],
        },
      },
      {
        text: 'Multi-head attention.',
        locator: { kind: PDF_EXCERPT_LOCATOR_KIND, page: 7 },
      },
    ]
    const result = await importLiteratureExcerpts({
      project: 'project-1',
      literatureId: 'lit-1',
      documentRevision: 'sha256:current',
      parent: '文献摘录',
      name: 'Attention Is All You Need',
      selections,
    })

    assert.equal(capturedUrl, 'http://service.test/api/resource/excerpts')
    assert.deepEqual(capturedBody, {
      project: 'project-1',
      location: { parent: '文献摘录', name: 'Attention Is All You Need' },
      source: {
        kind: LITERATURE_EXCERPT_SOURCE_KIND,
        literature_id: 'lit-1',
        document_revision: 'sha256:current',
      },
      selections: [
        {
          text: 'Scaled dot-product attention.',
          locator: {
            kind: PDF_EXCERPT_LOCATOR_KIND,
            page: 3,
            quads: [[0.12, 0.23, 0.78, 0.27]],
          },
        },
        {
          text: 'Multi-head attention.',
          locator: { kind: PDF_EXCERPT_LOCATOR_KIND, page: 7 },
        },
      ],
    })
    assert.deepEqual(result, {
      ok: true,
      operation: 'updated',
      node: {
        path: 'resources/文献摘录/Attention Is All You Need.md',
        name: 'Attention Is All You Need.md',
        kind: 'file',
        origin: 'local',
        children: undefined,
        count: undefined,
        fileType: undefined,
        source: undefined,
        updatedAt: undefined,
      },
      literatureId: 'lit-1',
      added: 1,
      skipped: 1,
      total: 4,
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('excerpt save labels select complete singular and plural messages without changing counts', async () => {
  const localization = createInstance()
  const resources = Object.fromEntries(
    ['zh', 'en'].map((language) => [
      language,
      {
        literature: JSON.parse(
          readFileSync(
            new URL(`../../localization/locales/${language}/literature.json`, import.meta.url),
            'utf8'
          )
        ),
      },
    ])
  )
  await localization.init({ lng: 'zh', fallbackLng: false, resources })
  const zh = localization.getFixedT('zh', 'literature')
  const en = localization.getFixedT('en', 'literature')
  assert.equal(zh('excerpts.save'), '保存到资料库')
  assert.equal(en('excerpts.save'), 'Save to library')
  assert.equal(zh('excerpts.saveSelection', { count: 1 }), '保存到资料库（1 段）')
  assert.equal(zh('excerpts.saveSelection', { count: 3 }), '保存到资料库（3 段）')
  assert.equal(en('excerpts.saveSelection', { count: 1 }), 'Save to library (1 segment)')
  assert.equal(en('excerpts.saveSelection', { count: 3 }), 'Save to library (3 segments)')
})

function assertLocalized(source: string, namespace: string, key: string, expected: string[]): void {
  assert.ok(source.includes(`'${key}'`), `source binds ${namespace}:${key}`)
  const labels = ['zh', 'en'].map((language) => {
    const resource = JSON.parse(
      readFileSync(
        new URL(`../../localization/locales/${language}/${namespace}.json`, import.meta.url),
        'utf8'
      )
    )
    return key.split('.').reduce((value, part) => value[part], resource)
  })
  assert.deepEqual(labels, expected)
}

test('search failure codes redraw in either language while unknown diagnostics remain intact', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
      zh: {
        resources: JSON.parse(
          readFileSync(
            new URL('../../localization/locales/zh/resources.json', import.meta.url),
            'utf8'
          )
        ),
      },
      en: {
        resources: JSON.parse(
          readFileSync(
            new URL('../../localization/locales/en/resources.json', import.meta.url),
            'utf8'
          )
        ),
      },
    },
  })
  const failure = webSearchInvocationFailure(
    'browser_launch_failed',
    BROWSER_SEARCH_EXECUTION_ERROR_CODE
  )
  const before = failure
  assert.equal(failure, 'browser_launch_failed')
  assert.match(
    webSearchFailureText(i18n.getFixedT('zh', 'resources'), failure),
    /浏览器进程启动失败/
  )
  assert.match(webSearchFailureText(i18n.getFixedT('en', 'resources'), failure), /could not start/)
  assert.equal(failure, before)
  assert.equal(
    webSearchFailureText(i18n.getFixedT('en', 'resources'), 'invocation_aborted'),
    'Search interrupted.'
  )
  assert.equal(
    webSearchFailureText(i18n.getFixedT('zh', 'resources'), 'invocation_request_failed'),
    '请求失败。'
  )
  assert.match(
    webSearchFailureText(i18n.getFixedT('en', 'resources'), 'invocation_stream_invalid'),
    /invalid event stream/
  )
  assert.match(
    webSearchFailureText(i18n.getFixedT('en', 'resources'), 'invocation_interaction_required'),
    /requires confirmation/
  )
  assert.equal(
    webSearchFailureText(i18n.getFixedT('en', 'resources'), WEB_SEARCH_INTERRUPTED_CODE),
    'Search interrupted.'
  )
  assert.match(
    webSearchFailureText(
      i18n.getFixedT('en', 'resources'),
      WEB_SEARCH_CANDIDATES_EXECUTION_ERROR_CODE
    ),
    /Web Search did not complete/
  )
  assert.match(
    webSearchFailureText(i18n.getFixedT('en', 'resources'), BROWSER_SEARCH_EXECUTION_ERROR_CODE),
    /Local browser search did not complete/
  )
  assert.equal(
    webSearchInvocationFailure(
      'runtime_web_search_capability_unavailable',
      BROWSER_SEARCH_EXECUTION_ERROR_CODE
    ),
    WEB_SEARCH_CANDIDATES_EXECUTION_ERROR_CODE
  )
  assert.equal(
    webSearchInvocationFailure('', BROWSER_SEARCH_EXECUTION_ERROR_CODE),
    BROWSER_SEARCH_EXECUTION_ERROR_CODE
  )
  const diagnostic = 'Upstream: TLS handshake failed (certificate: abc)'
  assert.equal(
    webSearchInvocationFailure(diagnostic, BROWSER_SEARCH_EXECUTION_ERROR_CODE),
    diagnostic
  )
  assert.equal(webSearchFailureText(i18n.getFixedT('en', 'resources'), diagnostic), diagnostic)
  assert.equal(
    webSearchFailureText(i18n.getFixedT('zh', 'resources'), 'constructor'),
    'constructor'
  )
})

test('split pane tabs reuse the same NavigationTabs presentation as the top bar', () => {
  assert.match(dockSource, /<DocumentNavigationTabs[\s\S]*?showOverview=\{false\}/)
  assert.match(tabBarSource, /<DocumentNavigationTabs/)
  assert.match(draggingSource, /draggable: true/)
  assert.match(draggingSource, /workspace\.moveTabToTab\(tabId, item\.id, insertion\)/)
  assert.match(dockSource, /!grid-rows-\[auto_minmax\(0,1fr\)\]/)
  assert.match(dockSource, /querySelector<HTMLElement>\(':scope > \[role="tablist"\]'\)/)
  assert.doesNotMatch(dockSource, /className="vds-document-tabs"/)
  assert.doesNotMatch(dockSource, /className=\{`vds-document-tab/)
})

test('top navigation split uses the document width while actions reserve only trailing tab space', () => {
  assert.match(topBarSource, /TOPBAR_ACTIONS_WIDTH_PROPERTY = '--vds-top-bar-actions-width'/)
  assert.match(topBarSource, /new ResizeObserver\(updateActionsWidth\)/)
  assert.match(
    topBarSource,
    /compactAiEntry =\s*\(state\.mainView === 'resource' \|\| state\.mainView === 'literature'\)[\s\S]*?hasHorizontalSplit\(documents\.layout\)/
  )
  assert.match(
    topBarSource,
    /compactAiEntry \? \([\s\S]*?<IconButton[\s\S]*?data-testid="topbar-ai"[\s\S]*?variant="ghostIcon"/
  )
  assert.match(
    tabBarSource,
    /TOPBAR_TRAILING_NAVIGATION_CLASS_NAME =[\s\S]*?'vds-top-bar-navigation-trailing !w-auto me-\[var\(--vds-top-bar-actions-width\)\]'/
  )
  const layoutSource = readFileSync(new URL('./design/layout.css', import.meta.url), 'utf8')
  assert.match(layoutSource, /:root\s*\{[^}]*--vds-top-bar-actions-width:\s*0px;/)
  assert.match(tabBarSource, /renderSplitTabs\(node\.first, leading, false\)/)
  assert.match(tabBarSource, /renderSplitTabs\(node\.second, false, trailing\)/)
  assert.match(topBarSource, /vds-top-bar-actions no-drag absolute/)
  assert.match(topBarSource, /border-\[var\(--vds-divider-default\)\]/)
})

test('document tab menu groups available splits before dynamic move targets', () => {
  const splitIndex = documentMenuSource.indexOf('splitActions.map')
  const moveIndex = documentMenuSource.indexOf('moveTargets.map')
  assert.ok(splitIndex >= 0)
  assert.ok(moveIndex > splitIndex)
  assert.match(documentMenuSource, /workspace\.moveTargetsForTab\(tab\.id\)/)
  assert.match(documentMenuSource, /rightTop: 'navigation\.moveRightTop'/)
  assert.match(documentMenuSource, /bottomRight: 'navigation\.moveBottomRight'/)
  assert.doesNotMatch(documentMenuSource, /disabled=\{!workspace\.canMoveTab/)
})
