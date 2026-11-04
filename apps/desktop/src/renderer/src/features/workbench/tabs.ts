import type { TFunction } from 'i18next'
import { availabilityPolicy, type AvailabilityPolicy } from '../../app/policy.ts'

import {
  isDocumentProcessorKind,
  type DocumentProcessorKind,
  type ViewerKind,
} from '../../contracts/workbench.ts'

interface WorkbenchTabScope {
  homeSelectedProjectId: string | null
  mainView: string
  activeTab: string
}

export function reorderNavigationTabOrder(
  previous: readonly string[],
  requested: readonly string[]
): string[] {
  const available = new Set(previous)
  const visible = new Set(requested)
  const reordered = requested.filter((id) => available.has(id))
  return previous.map((id) => (visible.has(id) ? (reordered.shift() ?? id) : id))
}

export function mergeNavigationTabOrder<Tab extends { id: string }>(
  previous: readonly string[],
  groups: readonly (readonly Tab[])[]
): Tab[] {
  const previousIds = new Set(previous)
  const remaining = groups.map((group) => group.filter((tab) => previousIds.has(tab.id)))
  const groupById = new Map(
    groups.flatMap((group, groupIndex) => group.map((tab) => [tab.id, groupIndex] as const))
  )
  const retained = previous.flatMap((id) => {
    const groupIndex = groupById.get(id)
    const tab = groupIndex === undefined ? undefined : remaining[groupIndex].shift()
    return tab ? [tab] : []
  })
  return retained.concat(groups.flatMap((group) => group.filter((tab) => !previousIds.has(tab.id))))
}

export function synchronizeWorkbenchTab<State extends WorkbenchTabScope>(
  current: State,
  observed: WorkbenchTabScope,
  fallbackTabId: string
): Partial<Pick<State, 'activeTab'>> {
  if (
    current.homeSelectedProjectId !== observed.homeSelectedProjectId ||
    current.mainView !== observed.mainView ||
    current.activeTab !== observed.activeTab ||
    current.activeTab === fallbackTabId
  )
    return {}
  return { activeTab: fallbackTabId }
}

/**
 * 中央工作区标签模型（MVP 0.2）。
 *
 * 归属：工作区负责人。标签是资料库/文献库共用的打开面，
 * 因此模型放在 workbench 下、由 store 顶层切片持有。
 */

/**
 * 标签种类决定用哪个 viewer 渲染。
 * - overview: 项目总览（常驻首个标签，不可关闭）
 * - projects: 项目列表（从活动栏进入时打开）
 * - literature: 文献库列表（从活动栏进入时打开）
 * - review: 本轮变更审阅页
 * - web_search: Agent 全网搜索结果页
 * - file: 资料文件，具体 viewer 由扩展名二次分派
 */
export type TabKind =
  | 'overview'
  | 'new_tab'
  | 'library'
  | 'explorer'
  | 'projects'
  | 'browser'
  | 'literature'
  | 'literature_search'
  | 'web_search'
  | 'review'
  | 'version_diff'
  | 'file'

export interface WorkbenchTab {
  libraryCategory?: 'materials' | 'literature' | 'outputs'
  /** 稳定标识：overview/literature/review 用种类名，file 用相对路径。 */
  id: string
  kind: TabKind
  title: string
  titleFallback?:
    | 'literatureResult'
    | 'newTab'
    | 'projectFiles'
    | 'projectExplorer'
    | { kind: 'review'; count: number }
    | { kind: 'literatureSearch'; query: string }
    | { kind: 'versionDiff'; name: string; sequence: number }
  /** 是否允许关闭（总览、文献中心等固定标签可常驻）。 */
  closable: boolean
  /** 页签创建时的项目作用域；null 表示全局，未设置表示跨项目共享。 */
  projectId?: string | null
  navigationView?: 'resource' | 'literature'
}

const VIEWER_BY_EXTENSION: Record<string, ViewerKind> = {
  md: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
  docx: 'office',
  doc: 'office',
  csv: 'spreadsheet',
  xlsx: 'spreadsheet',
  xls: 'office',
  ppt: 'office',
  pptx: 'office',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  py: 'code',
  r: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  sh: 'code',
  json: 'code',
  lean: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  xml: 'code',
  txt: 'code',
  log: 'code',
}
const OVERVIEW_TAB_TITLE = '总览'
const PROJECTS_TAB_TITLE = '项目'
const LITERATURE_TAB_TITLE = '文献中心'
const BROWSER_TAB_TITLE = 'browser'

export const OVERVIEW_TAB: WorkbenchTab = {
  id: 'overview',
  kind: 'overview',
  title: OVERVIEW_TAB_TITLE,
  closable: false,
}

export const PROJECTS_TAB: WorkbenchTab = {
  id: 'projects',
  kind: 'projects',
  title: PROJECTS_TAB_TITLE,
  closable: true,
}

export const LITERATURE_TAB: WorkbenchTab = {
  id: 'literature',
  kind: 'literature',
  title: LITERATURE_TAB_TITLE,
  closable: false,
}

/**
 * 视图键 → 进入该视图时自动打开的固定标签。
 *
 * 没有这张表就得在 `openWorkbenchView` 里按视图写 if/else：资料库靠资料树
 * 打开文件标签，项目与文献库自己没有"被点开的文件"，进去时中区必须已经有
 * 一个标签，否则是白板。键用 string 而非 MainView：store 依赖本模块，
 * 反向标注类型会成环。
 */
export const FIXED_TAB_BY_VIEW: Record<string, WorkbenchTab> = {
  browser: { id: 'browser', kind: 'browser', title: BROWSER_TAB_TITLE, closable: false },
  projects: PROJECTS_TAB,
  literature: LITERATURE_TAB,
}

export function fixedTabForView(
  view: string,
  policy: AvailabilityPolicy = availabilityPolicy
): WorkbenchTab | undefined {
  return policy.routeAvailable(view) ? FIXED_TAB_BY_VIEW[view] : undefined
}

/** 按扩展名决定 viewer；未识别的走 unsupported 提示而不是空白。 */
export function viewerForPath(path: string): ViewerKind {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'unsupported'
  const ext = path.slice(dot + 1).toLowerCase()
  return VIEWER_BY_EXTENSION[ext] ?? 'unsupported'
}

/** 打开一个文件标签；已存在则复用，避免重复标签。 */
export function openFileTab(tabs: WorkbenchTab[], path: string): WorkbenchTab[] {
  if (tabs.some((tab) => tab.id === path)) return tabs
  const dot = path.lastIndexOf('/')
  const title = dot < 0 ? path : path.slice(dot + 1)
  return [...tabs, { id: path, kind: 'file', title, closable: true }]
}

/** 打开一个固定种类的标签（项目/文献库）。 */
export function openFixedTab(tabs: WorkbenchTab[], tab: WorkbenchTab): WorkbenchTab[] {
  if (tabs.some((existing) => existing.id === tab.id)) return tabs
  return [...tabs, tab]
}

export function openWorkbenchTab(
  tabs: WorkbenchTab[],
  view: string,
  tab: WorkbenchTab,
  policy: AvailabilityPolicy = availabilityPolicy
): WorkbenchTab[] {
  if (!policy.routeAvailable(view) || !policy.tabAvailable(tab)) return tabs
  const fixed = fixedTabForView(view, policy)
  return openFixedTab(fixed ? openFixedTab(tabs, fixed) : tabs, tab)
}

/**
 * Resolve the selected item for one visible navigation tab list.
 *
 * The application-owned active tab describes the surface rendered in the workbench.
 * A document focus is only a recovery candidate after that requested tab has closed or
 * belongs to another visible list; otherwise a stale document focus would visually
 * override search, review, and future contributed workbench tabs.
 */
export function activeNavigationTabId(
  requestedId: string,
  visibleIds: ReadonlySet<string>,
  focusedDocumentId: string | null | undefined,
  fallbackId: string,
  documentIds: ReadonlySet<string>
): string {
  if (documentIds.has(requestedId) && focusedDocumentId && visibleIds.has(focusedDocumentId)) {
    return focusedDocumentId
  }
  if (visibleIds.has(requestedId)) return requestedId
  if (focusedDocumentId && visibleIds.has(focusedDocumentId)) return focusedDocumentId
  return fallbackId
}

export function tabMatchesProject(tab: WorkbenchTab, projectId: string | null): boolean {
  return tab.projectId === undefined || tab.projectId === projectId
}

export function restoreProjectWorkbenchTab(
  projectId: string | null,
  rememberedId: string | undefined,
  tabs: readonly WorkbenchTab[],
  documents: {
    focusedTabId: string | null
    tabs: Readonly<Record<string, { embedded?: boolean }>>
  }
): string {
  if (rememberedId) {
    const surface = tabs.find((tab) => tab.id === rememberedId)
    if (
      surface &&
      tabMatchesProject(surface, projectId) &&
      workbenchTabVisible(surface, 'resource')
    )
      return rememberedId
    const document = documents.tabs[rememberedId]
    if (document && !document.embedded) return rememberedId
  }
  const focused = documents.focusedTabId ? documents.tabs[documents.focusedTabId] : undefined
  return focused && !focused.embedded ? documents.focusedTabId! : OVERVIEW_TAB.id
}

const NEW_PROJECT_TAB_PREFIX = 'new-tab:'

export function newProjectTab(projectId: string | null): WorkbenchTab {
  return {
    id: `${NEW_PROJECT_TAB_PREFIX}${crypto.randomUUID()}`,
    kind: 'new_tab',
    title: '',
    titleFallback: 'newTab',
    closable: true,
    projectId,
  }
}

const PROJECT_EXPLORER_TAB_PREFIX = 'explorer:'
const PROJECT_LIBRARY_TAB_PREFIX = 'library:'

export function literatureNavigation(
  tabs: WorkbenchTab[],
  projectId: string | null
): { mainView: 'resource' | 'literature'; tabs: WorkbenchTab[]; activeTab: string } {
  if (!projectId) {
    return {
      mainView: 'literature',
      tabs: openFixedTab(tabs, LITERATURE_TAB),
      activeTab: LITERATURE_TAB.id,
    }
  }
  return projectLibraryNavigation(tabs, projectId, 'literature')
}

export function projectLibraryNavigation(
  tabs: WorkbenchTab[],
  projectId: string | null,
  category?: WorkbenchTab['libraryCategory']
): { mainView: 'resource'; tabs: WorkbenchTab[]; activeTab: string } {
  const existing = tabs.find((tab) => tab.kind === 'library' && tabMatchesProject(tab, projectId))
  const target: WorkbenchTab = {
    ...existing,
    id: existing?.id ?? `${PROJECT_LIBRARY_TAB_PREFIX}${encodeURIComponent(projectId ?? '')}`,
    kind: 'library',
    title: existing?.title ?? '',
    titleFallback: 'projectFiles',
    closable: true,
    projectId,
    libraryCategory: category ?? existing?.libraryCategory ?? 'materials',
  }
  return {
    mainView: 'resource',
    tabs: existing ? tabs.map((tab) => (tab.id === existing.id ? target : tab)) : [...tabs, target],
    activeTab: target.id,
  }
}

export function projectExplorerTab(projectId: string | null, title: string): WorkbenchTab {
  return {
    id: `${PROJECT_EXPLORER_TAB_PREFIX}${encodeURIComponent(projectId ?? '')}`,
    kind: 'explorer',
    title,
    closable: true,
    projectId,
  }
}

export function selectProjectTab(
  tabs: WorkbenchTab[],
  tabId: string,
  kind: 'library' | 'explorer'
): WorkbenchTab[] {
  if (!tabs.some((tab) => tab.id === tabId && tab.kind === 'new_tab')) return tabs
  return tabs.map((tab) =>
    tab.id === tabId
      ? { ...tab, kind, titleFallback: kind === 'library' ? 'projectFiles' : 'projectExplorer' }
      : tab
  )
}

export function resolveProjectTabSelection(
  tabs: WorkbenchTab[],
  tabId: string,
  kind: 'library' | 'explorer',
  paneTabIds?: readonly string[]
): { tabs: WorkbenchTab[]; activeTab: string } {
  const blank = tabs.find((tab) => tab.id === tabId && tab.kind === 'new_tab')
  const existing = blank
    ? tabs.find(
        (tab) =>
          tab.kind === kind &&
          tabMatchesProject(tab, blank.projectId ?? null) &&
          (!paneTabIds || paneTabIds.includes(tab.id))
      )
    : undefined
  return {
    tabs: existing ? tabs : selectProjectTab(tabs, tabId, kind),
    activeTab: existing?.id ?? tabId,
  }
}

const REVIEW_TAB_PREFIX = 'review:'
const VERSION_DIFF_TAB_PREFIX = 'version-diff:'

export interface VersionDiffReference {
  project: string
  fileId: string
  path: string
  historicalVersionId: string
  currentVersionId: string
  historicalSequence: number
  processor: DocumentProcessorKind | null
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

export function versionDiffTab(reference: VersionDiffReference): WorkbenchTab {
  const identity = [
    reference.project,
    reference.fileId,
    reference.path,
    reference.historicalVersionId,
    reference.currentVersionId,
    String(reference.historicalSequence),
    reference.processor ?? '',
  ]
    .map(encodeURIComponent)
    .join(':')
  const name = fileName(reference.path)
  return {
    id: `${VERSION_DIFF_TAB_PREFIX}${identity}`,
    kind: 'version_diff',
    title: name,
    titleFallback: { kind: 'versionDiff', name, sequence: reference.historicalSequence },
    closable: true,
    projectId: reference.project,
  }
}

export function parseVersionDiffTab(id: string): VersionDiffReference | null {
  if (!id.startsWith(VERSION_DIFF_TAB_PREFIX)) return null
  const parts = id.slice(VERSION_DIFF_TAB_PREFIX.length).split(':')
  if (parts.length !== 7) return null
  try {
    const [project, fileId, path, historicalVersionId, currentVersionId, historical, rawProcessor] =
      parts.map(decodeURIComponent)
    const historicalSequence = Number(historical)
    if (
      !project ||
      !fileId ||
      !path ||
      !historicalVersionId ||
      !currentVersionId ||
      !Number.isInteger(historicalSequence) ||
      historicalSequence < 1
    )
      return null
    const processor = rawProcessor
      ? isDocumentProcessorKind(rawProcessor)
        ? rawProcessor
        : undefined
      : null
    if (processor === undefined) return null
    return {
      project,
      fileId,
      path,
      historicalVersionId,
      currentVersionId,
      historicalSequence,
      processor,
    }
  } catch {
    return null
  }
}

export function openVersionDiffTab(
  tabs: WorkbenchTab[],
  reference: VersionDiffReference
): WorkbenchTab[] {
  const tab = versionDiffTab(reference)
  return tabs.some((candidate) => candidate.id === tab.id) ? tabs : [...tabs, tab]
}

export function reviewTab(projectId: string, batchId: string, fileCount: number): WorkbenchTab {
  return {
    id: `${REVIEW_TAB_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(batchId)}`,
    kind: 'review',
    title: `审阅修改 · ${fileCount}`,
    titleFallback: { kind: 'review', count: fileCount },
    closable: true,
    projectId,
  }
}

export function parseReviewTab(id: string): { projectId: string; batchId: string } | null {
  if (!id.startsWith(REVIEW_TAB_PREFIX)) return null
  const divider = id.indexOf(':', REVIEW_TAB_PREFIX.length)
  if (divider < 0) return null
  try {
    return {
      projectId: decodeURIComponent(id.slice(REVIEW_TAB_PREFIX.length, divider)),
      batchId: decodeURIComponent(id.slice(divider + 1)),
    }
  } catch {
    return null
  }
}

export function openReviewTab(
  tabs: WorkbenchTab[],
  projectId: string,
  batchId: string,
  fileCount: number
): WorkbenchTab[] {
  const tab = reviewTab(projectId, batchId, fileCount)
  return tabs.some((candidate) => candidate.id === tab.id) ? tabs : [...tabs, tab]
}

export function literatureSearchTab(
  id: string,
  query: string,
  projectId?: string | null
): WorkbenchTab {
  return {
    id: `literature-search:${id}`,
    kind: 'literature_search',
    title: `AI检索：${query}`,
    titleFallback: { kind: 'literatureSearch', query },
    closable: true,
    projectId: projectId ?? null,
  }
}

export function openLiteratureSearchTabs(
  tabs: WorkbenchTab[],
  tasks: ReadonlyArray<{ id: string; query: string; projectId?: string | null }>
): WorkbenchTab[] {
  if (tasks.length > 0) tabs = openFixedTab(tabs, LITERATURE_TAB)
  const existing = new Set(tabs.map((tab) => tab.id))
  const additions = tasks
    .map((task) => literatureSearchTab(task.id, task.query, task.projectId))
    .filter((tab) => !existing.has(tab.id))
  if (additions.length === 0) return tabs
  const lastLiteratureIndex = tabs.reduce(
    (last, tab, index) =>
      tab.kind === 'literature' || tab.kind === 'literature_search' ? index : last,
    -1
  )
  const insertion = lastLiteratureIndex + 1
  return [...tabs.slice(0, insertion), ...additions, ...tabs.slice(insertion)]
}

/**
 * 标签种类在某个主视图下是否出现在标签栏。
 *
 * 标签栏按视图过滤显示，但全局标签列表是混排的；关闭标签选接替者时必须用
 * 同一张可见性表，否则位置邻居会落在别的视图的标签上，把整个工作区带走。
 * 视图键用 string 而非 MainView：store 依赖本模块，反向标注类型会成环。
 */
export function tabVisibleInCurrentView(
  kind: TabKind,
  mainView: string,
  policy: AvailabilityPolicy = availabilityPolicy
): boolean {
  if (!policy.routeAvailable(mainView) || !policy.tabAvailable({ kind, id: kind })) return false
  if (kind === 'browser' || mainView === 'browser')
    return kind === 'browser' && mainView === 'browser'
  if (kind === 'overview') return false
  if (mainView === 'projects') return kind === 'projects'
  if (mainView === 'literature') return kind === 'literature' || kind === 'literature_search'
  if (mainView === 'resource')
    return (
      kind === 'new_tab' ||
      kind === 'library' ||
      kind === 'explorer' ||
      kind === 'file' ||
      kind === 'review' ||
      kind === 'web_search' ||
      kind === 'version_diff'
    )
  return kind !== 'projects' && kind !== 'literature' && kind !== 'literature_search'
}

export function workbenchTabVisible(tab: WorkbenchTab, mainView: string): boolean {
  if (tab.navigationView)
    return (
      availabilityPolicy.routeAvailable(mainView) &&
      tab.navigationView === mainView &&
      availabilityPolicy.tabAvailable(tab)
    )
  return tabVisibleInCurrentView(tab.kind, mainView)
}

export interface CloseTabContext {
  paneTabIds?: readonly string[]
  projectId?: string | null
  /** 关闭发生时的工作区视图；接替标签必须在该视图可见。 */
  view: string
  /** 同视图没有剩余 workbench 标签时的接替 id（如当前视图文档焦点标签）；空则回视图固定标签。 */
  viewFallbackId?: string | null
}

/**
 * 关闭标签，返回新列表与关闭后应激活的标签 id。
 *
 * 不传 context 时保持位置邻居语义（右邻→左邻→总览）。传 context 时接替者只在
 * 当前视图可见的标签里按右邻→左邻选；都没有才落到调用方给的视图内接替 id
 * （文档标签不在本列表里也合法），最后兜底视图固定标签。
 */
export function closeTab(
  tabs: WorkbenchTab[],
  activeId: string,
  closingId: string,
  context?: CloseTabContext
): { tabs: WorkbenchTab[]; activeId: string } {
  const index = tabs.findIndex((tab) => tab.id === closingId)
  if (index < 0) return { tabs, activeId }
  const next = tabs.filter((tab) => tab.id !== closingId)
  if (activeId !== closingId) return { tabs: next, activeId }
  if (!context) {
    const fallback = next[index] ?? next[index - 1] ?? OVERVIEW_TAB
    return { tabs: next, activeId: fallback.id }
  }
  if (context.paneTabIds?.includes(closingId)) {
    const paneIndex = context.paneTabIds.indexOf(closingId)
    const candidates = [
      ...context.paneTabIds.slice(paneIndex + 1),
      ...context.paneTabIds.slice(0, paneIndex).reverse(),
    ]
    if (candidates.length) return { tabs: next, activeId: candidates[0] }
  }
  const [nearest] = sameViewNeighbours(next, index, context.view, context.projectId)
  if (nearest !== undefined) return { tabs: next, activeId: next[nearest].id }
  if (context.viewFallbackId) return { tabs: next, activeId: context.viewFallbackId }
  const fixed = context.view === 'literature' ? LITERATURE_TAB : OVERVIEW_TAB
  return { tabs: next, activeId: fixed.id }
}

/** 从被关闭位置向右、再向左，产出当前视图可见标签的下标。 */
function sameViewNeighbours(
  tabs: WorkbenchTab[],
  closedIndex: number,
  view: string,
  projectId?: string | null
): number[] {
  const ordered: number[] = []
  for (let cursor = closedIndex; cursor < tabs.length; cursor += 1) ordered.push(cursor)
  for (let cursor = closedIndex - 1; cursor >= 0; cursor -= 1) ordered.push(cursor)
  return ordered.filter(
    (cursor) =>
      workbenchTabVisible(tabs[cursor], view) &&
      (projectId === undefined || tabMatchesProject(tabs[cursor], projectId))
  )
}

export const LITERATURE_RESULT_PREFIX = 'literature-result:'
export interface LiteratureResultReference {
  session_id: string
  card_id: string
  title: string
}
export function literatureResultTab(
  result: LiteratureResultReference,
  projectId: string | null = null
): WorkbenchTab {
  return {
    id: `${LITERATURE_RESULT_PREFIX}${encodeURIComponent(result.session_id)}/${encodeURIComponent(result.card_id)}`,
    kind: 'literature_search',
    title: result.title,
    titleFallback: 'literatureResult',
    closable: true,
    projectId,
    navigationView: projectId ? 'resource' : 'literature',
  }
}

/** Resolve application-owned labels without rewriting stored titles or search criteria. */
export function workbenchTabTitle(
  tab: WorkbenchTab,
  literature: TFunction<'literature'>,
  workbench: TFunction<'workbench'>
): string {
  if (tab.kind === 'projects') return workbench('tabs.projects')
  if (tab.titleFallback === 'newTab') return workbench('tabs.newTab')
  if (tab.titleFallback === 'projectFiles') return workbench('tabs.projectFiles')
  if (tab.titleFallback === 'projectExplorer') return workbench('tabs.projectExplorer')
  if (typeof tab.titleFallback === 'object') {
    if (tab.titleFallback.kind === 'review')
      return workbench('tabs.review', { count: tab.titleFallback.count })
    if (tab.titleFallback.kind === 'versionDiff')
      return workbench('tabs.versionDiff', tab.titleFallback)
    return literature('result.aiSearchTitle', { query: tab.titleFallback.query })
  }
  return tab.titleFallback === 'literatureResult'
    ? literature('result.tabTitle', { title: tab.title || literature('result.untitledSearch') })
    : tab.title
}
