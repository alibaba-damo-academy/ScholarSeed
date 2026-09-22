import {
  sanitizeSelectionPrompts,
  selectionPromptsEqual,
  type SelectionPrompts
} from '../../prompts'
import { assistantFailureDetail } from './features/assistant/failure'
import { sessionTitleFallback } from './session'
import type { SessionTitleFallback } from './session'
import type { ForegroundMessage } from './contracts/feedback'
import { resourceErrorMessage, SOURCE_COVERS_LINKS_ERROR, SOURCE_OVERLAP_ERROR } from './features/resources/error'
import { useTranslation } from 'react-i18next'
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { IMPORT_PICKER_TARGET } from '../../picker'
import { sanitizeOnboarding, onboardingEqual, type OnboardingGroup, type OnboardingPreferences } from '../../onboarding'
import { PreferenceWriter } from '../../persistence'
import { applyRendererLanguage } from './app/localization'
import type { SkillInstallNotice } from './skill'
import { Button, useToast } from './components/ui'
import { assistantSourceAvailable, filterAssistantContextCandidates, resolveAssistantProject } from './features/assistant/candidates'
import {
  DEFAULT_RENDERER_PREFERENCES,
  recentFilesEqual,
  recentLiteratureEqual,
  sanitizeShortcutOverrides,
  recentSessionsEqual,
  sanitizeLiteratureAiModels,
  touchRecentFile,
  touchRecentLiterature,
  touchRecentSession,
  type PreferenceShortcutBinding,
  type PreferenceShortcutOverrides,
  type LiteratureAiModelAction,
  type LiteratureAiModelPreferences,
  type RecentFileEntry,
  type RecentLiteratureEntry,
  type RecentSessionEntry
} from '../../preferences'
import { setActiveShortcutOverrides, type ShortcutCommandId } from './shortcuts'
import { registerLiteratureOpenRecorder } from './features/literature/catalog'
import {
  CollaborationMode,
  DEFAULT_GLOBAL_PERMISSION_MODE,
  GlobalPermissionMode,
  ModelInfo,
  ModelsResp,
  PersonalApiProfilesResp,
  type ProductTaskType,
  Project,
  SubscriptionGroup,
  interruptSession,
  listQueuedMessages,
  listSessions,
  registerLocalPaths,
  revealSystemPath
} from './api'
import { authorizeRoot, listExternalRoots, revokeRoot } from './features/project/api'
import { ProjectFormTarget } from './components/business/ProjectForm'
import { DEFAULT_WORKDIR } from './i18n'
import { CAPTURE_SETTLE_FRAMES, waitForFrames } from './frames'
import {
  ConvItem,
  FilePreviewTarget,
  Lang,
  PetState,
  RecallEntry,
  RuntimeCapabilities,
  RuntimeReadiness,
  RuntimeSnapshot,
  SessionNode,
  SessionStatus,
  Theme,
  Thread
} from './model'
import { findSessionNode, removeSessionNode, upsertSessionNode } from './tree'
import { selectableCatalogModelKey } from './catalog'
import {
  LITERATURE_SCOPE_KEY,
  continuityScopeKey,
  readContinuityRecord,
  rememberContinuity,
  restoreContinuityCandidate,
  writeContinuityRecord
} from './continuity'
import {
  ASSISTANT_CONTEXT_FAILURE,
  assistantContextFailure,
  AiContextSource,
  AiPanelState,
  beginContextCandidateLoad,
  mergeContextCandidates,
  AssistantContextError,
  INITIAL_AI_PANEL_STATE
} from './features/assistant/state'
import {
  createAnswerAnnotation as requestAnswerAnnotation,
  deleteAnswerAnnotation as requestDeleteAnswerAnnotation,
  deleteAnswerAnnotations as requestDeleteAnswerAnnotations,
  getAssistantContext,
  listAnswerAnnotations,
  listArtifactLibraryLinks,
  patchAssistantContext,
  removeAnswerAnnotationContext as requestRemoveAnswerAnnotationContext,
  startAssistantInvocation,
  startAssistantSelectionAction,
  stopAssistantSelection,
  startAssistantTranslation,
  updateAnswerAnnotation as requestUpdateAnswerAnnotation
} from './features/assistant/api'
import { locateAnswerAnnotation } from './features/assistant/anchors'
import {
  nextSelectionAttempt,
  selectionActionKey,
  type SelectionAttemptIdentity
} from './features/assistant/selection'
import type {
  ArtifactLibraryLinksResult,
  AnswerAnnotation,
  AnswerAnnotationCreate,
  AssistantContextCandidate,
  AssistantIngress,
  AssistantContextMutationResult,
  AssistantFailure,
  AssistantContextRef,
  AssistantContextSelection,
  AssistantSourceFilter,
  AssistantInvocationMutationResult,
  AssistantOneShotInput,
  AssistantSelectionActionInput,
  AssistantSelectionActionMutationResult,
  AssistantSelectionStreamOptions,
  AssistantTranslationInput,
  AssistantTranslationTarget,
  ContextRefKind,
  SearchScope
} from './contracts/assistant'
import type { AssistantSourceContribution } from './contracts/features'
import type { LiteratureDetail, LiteratureSearchTask } from './contracts/literature'
import type { FindTextReveal, LiteratureDocumentSource } from './contracts/workbench'
import {
  LITERATURE_EXCERPT_SOURCE_KIND,
  LITERATURE_EXCERPT_VIEW_STATE_KEY
} from './contracts/resources'
import {
  ImportSourceKind,
  batchLiterature,
  deleteLiteratureSearch,
  exportBibtex,
  fetchFulltext,
  fetchLiterature,
  getLiterature,
  importLiterature,
  listLiteratureSearches,
  markFulltext,
  mutateCollection,
  mutateNote,
} from './features/literature/api'
import {
  FulltextStatus,
  INITIAL_LITERATURE_STATE,
  LiteratureScope,
  LiteratureSort,
  LiteratureState,
  PdfFilter
} from './features/literature/state'
import {
  fetchResourceTree,
  fetchResourceReviewBatchForPath,
  fetchVersionCapability,
  admitResourceVersion,
  importResources,
  mutateResourceNode,
  type ResourceImportDecisionAction,
  resolveRevealTarget,
  issueTrashToken
} from './features/resources/api'
import { createResourceImport } from './features/resources/imports'
import {
  DeleteConfirmState,
  findResourceNode,
  INITIAL_RESOURCE_STATE,
  INVALID_RESOURCE_NAME_MESSAGE,
  LinkSupersedeConfirmState,
  MARKDOWN_SUFFIX,
  NameDraftState,
  NodeMenuState,
  pendingChildCount,
  resolveResourceCreateTarget,
  resolveResourceCreateTargetAt,
  resourceNameError,
  resourceStateForProjectSwitch,
  ResourceCreateMode,
  ResourceNode,
  ResourceNoticeOpenTarget,
  ResourceNoticeMessage,
  UnlinkConfirmState,
  ResourceState,
  withCreatedResource,
  withResourceChildren
} from './features/resources/state'
import {
  beginResourceTreeReload,
  expandedResourceAncestors,
  deriveCoveredLinkRoots,
  deriveLinkOverlapTarget,
  finishResourceTreeReload,
  linkMountNameFromSource,
  materializeResourcePath,
  relocateExpandedResourcePaths,
  relocateResourcePath,
  removeExpandedResourcePaths,
  resourceNameParts,
  resourceDefaultName,
  resourceParentDirectory,
  transformResourceContextRefs,
  validateResourceMove
} from './features/resources/lifecycle'
import {
  createWebSearchTab,
  webSearchInvocationFailure,
  WEB_SEARCH_CANDIDATES_EXECUTION_ERROR_CODE
} from './features/resources/search'
import { runWebSearchRoute } from './features/resources/driver'
import { resolveDocumentLocation, type DocumentSource, type LocatedDocumentSource } from './features/workbench/api'
import { resolveDocumentWorkspaceProject } from './features/workbench/scope'
import { documentWorkspaces, type DocumentNavigationView, type DocumentTab } from './features/workbench/workspace'
import {
  closeTab,
  FIXED_TAB_BY_VIEW,
  LITERATURE_TAB,
  openFileTab,
  openFixedTab,
  literatureSearchTab,
  literatureResultTab,
  type CloseTabContext,
  type LiteratureResultReference,
  openLiteratureSearchTabs,
  openReviewTab,
  openVersionDiffTab,
  OVERVIEW_TAB,
  type VersionDiffReference,
  reviewTab,
  versionDiffTab,
  WorkbenchTab
} from './features/workbench/tabs'
import { StoreContext } from './storeContext'
import { INITIAL_CREDITS_STATE, type CreditsState } from './account'

export type CapKind = 'skill'
export type AccountSettingsPage = 'prompts' | 'preferences' | 'account' | 'models' | 'model-settings' | 'skills' | 'developer' | 'files' | 'shortcuts' | 'about' | 'notifications' | 'permissions' | 'archives'
/**
 * 主视图判别式。0.1 的 home/projects 保留不动；0.2 新增三个工作台视图，
 * 与活动栏三个图标一一对应（writing 为 P1 占位）。
 */
export type MainView = 'home' | 'conversation' | 'projects' | 'resource' | 'literature' | 'writing'
export type WorkspaceLoadState = 'loading' | 'ready' | 'error'


function mainViewForWorkbenchTab(tab: WorkbenchTab | undefined): MainView | null {
  if (!tab) return null
  if (tab.kind === 'overview') return null
  if (tab.kind === 'projects') return 'projects'
  if (['literature', 'literature_search'].includes(tab.kind)) return 'literature'
  return 'resource'
}

function mainViewForDocumentSource(source: DocumentSource, currentView: MainView): DocumentNavigationView {
  if (source.kind === 'literature') return 'literature'
  if (currentView === 'literature' && (source.kind === 'session-artifact' || source.kind === 'session-file')) return 'literature'
  return 'resource'
}

/**
 * 关标签时的视图上下文：接替标签必须留在当前视图，同视图没有剩余 workbench
 * 标签时回当前视图的文档焦点标签，避免全局列表的位置邻居把用户带去别的视图。
 * 文档工作区作用域与 main.tsx 的 provider 保持一致。
 */
function closeTabContext(current: AppState): CloseTabContext {
  const projectId = current.homeSelectedProjectId ?? assistantProject(current).projectId
  const documents = documentWorkspaces.forProject(projectId).getSnapshot()
  const focusedTab = documents.focusedTabId ? documents.tabs[documents.focusedTabId] : null
  const session = focusedTab ? documents.sessions[focusedTab.sessionId] : null
  const matchesView = current.mainView === 'literature'
    ? session?.source.kind === 'literature'
    : session?.source.kind === 'project'
  return {
    view: current.mainView,
    viewFallbackId: matchesView ? documents.focusedTabId : null
  }
}

/**
 * 资料操作失败的人话文案。
 *
 * 后端回的是稳定的 detail 码（而不是文案），由前端统一翻译：
 * 后端不应承担文案与多语言，前端也不应把原始错误码扔给用户。
 * 未登记的码回落到“操作失败：<code>”，不隐藏异常。
 */

/** 新建失败后允许安全重放的服务端错误；网络断连时结果未知，不能盲目重放制造副本。 */
const RETRYABLE_RESOURCE_CREATE_ERRORS = new Set([
  'authorized_root_unavailable',
  'parent_not_found',
  'parent_not_writable',
  'write_failed'
])

const RESOURCE_CONTEXT_SYNC_ATTEMPTS = 2
const ASSISTANT_CONTEXT_ADD_ATTEMPTS = 2
const ASSISTANT_CONTEXT_REVISION_CONFLICT = 'assistant_context_revision_conflict'

function resourceCreateErrorMessage(error: string, linked: boolean): ResourceNoticeMessage {
  if (error === 'network_error' || error.startsWith('http_')) {
    return { key: 'feedback.createUncertain', detail: error }
  }
  if (linked && ['authorized_root_unavailable', 'parent_not_found'].includes(error)) {
    return { key: 'feedback.linkedCreateFailed', detail: error }
  }
  return resourceErrorMessage(error)
}

/**
 * AI 摘录落地目录（PRD「基于 AI 回答新建文档」）。
 *
 * 集中到一个目录而非散在项目根：用户事后能一眼找到所有 AI 摘录，
 * 也不会把人工整理的项目结构冲散。
 */
/** 文献入库失败的人话文案，与资料库同一套翻译约定。 */
const RUNTIME_SKILLS_UNAVAILABLE = 'runtime_skills_unavailable'
const CONTEXT_SAVE_FAILED = 'context_save_failed'

export const LITERATURE_ERROR_TEXT: Record<string, string> = {
  unsupported_format: '只支持 .bib / .ris / .pdf 三种文件。',
  unsupported_source: '该导入通道待实现。',
  no_records_parsed: '没从文件里解析出题录，确认格式是否正确。',
  source_not_found: '选中的文件已不存在。',
  sources_required: '没选中任何文件。',
  read_failed: '文件读不了，检查权限。',
  network_error: '本地服务没响应，稍后重试。'
}

export interface TurnLaunch {
  phase: 'admitting' | 'opening'
  optimisticUserMessage: Extract<ConvItem, { kind: 'user' }>
}

export interface LanguageSwitchState {
  target: Lang
  dirtyCount: number
  saving: boolean
  failure: 'save' | 'preferences' | null
}

/**
 * The model catalogue is one source of truth in the store: the composer's model
 * pill and the settings panel's connection section both read it, so switching a
 * model in one surface can never leave the other showing a stale catalogue.
 */
export interface ModelCatalog {
  models: ModelInfo[]
  /** Hidden in Model management; listed there for restore, never offered to a session. */
  hiddenModels: ModelInfo[]
  /** Subscription second-level groups, ordered by the backend. */
  subscriptionGroups: SubscriptionGroup[]
  personalProfiles: PersonalApiProfilesResp | null
}

export type ComposerReference = {
  type: 'skill'
  id: string
  title: string
  status?: string
  path: string
  version?: string
} | {
  type: 'file'
  id: string
  title: string
  status?: string
  path: string
  referenceId?: string
  registrationRequired?: boolean
  previewSource?: LiteratureDocumentSource
  mediaType?: string
  sha256?: string
  size?: number
} | {
  type: 'directory'
  id: string
  title: string
  status?: string
  path: string
  referenceId?: string
  registrationRequired?: boolean
}

export interface DraftSeed {
  composerText?: string
  composerRefs?: ComposerReference[]
  /** Explicit project assignment for a draft opened from a project's add action. */
  projectId?: string | null
  /** Locked drafts cannot change or clear their project before the first turn. */
  projectLocked?: boolean
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export type { BgTask, ContextEntry, ContextSurface, TodoItemUI } from './model'

export interface AppState {
  onboarding: OnboardingPreferences
  theme: Theme
  lang: Lang
  editorRuntimeRevision: number
  languageSwitch: LanguageSwitchState | null
  sidebarOpen: boolean
  /** Whether the first durable session snapshot has seeded the local read ledger. */
  sessionActivityInitialized: boolean
  /** Last durable activity timestamp viewed by this desktop user, keyed by session id. */
  sessionActivitySeen: Record<string, number>
  selectionPrompts: SelectionPrompts
  reasoningPreferences: Record<string, string>
  literatureAiModels: LiteratureAiModelPreferences
  desktopNotifications: boolean
  soundAlerts: boolean
  autoSave: boolean
  formatOnSave: boolean
  editorWordWrap: boolean
  shortcutOverrides: PreferenceShortcutOverrides
  dataSharingMode: 'private'
  newChooser: boolean
  modelMenuOpen: boolean
  wdMenuOpen: boolean
  notifPanelOpen: boolean
  model: string
  collaborationMode: CollaborationMode
  globalPermissionMode: GlobalPermissionMode
  defaultWorkflowEnabled: boolean
  defaultAutoReviewEnabled: boolean
  workdir: string | null
  workspacePath: string | null
  /** Stable ScholarSeed default used by every unassigned draft, independent of active project. */
  defaultWorkspacePath: string | null
  projects: Project[]
  /** Primary product surface shown while no conversation is selected. */
  mainView: MainView
  activeSession: string | null
  threads: Record<string, Thread>
  capGallery: CapKind | null
  /** 首页/对话「添加技能」上传弹窗 (复用技能页的 SkillAdd)。true = 打开。 */
  skillUploadOpen: boolean
  workspaceFilesOpen: boolean
  /** Product session workdir being browsed; null selects the global workspace. */
  workspaceFilesSessionId: string | null
  composerText: string
  composerTaskType: '' | ProductTaskType
  composerRefs: ComposerReference[]
  judgment: 'pending' | 'confirmed'
  tension: 'open' | 'hypothesis' | 'ignored'
  thread: 'open' | 'folded'
  confirmDelete: {
    label: string
    title_fallback?: SessionTitleFallback
    sessionId?: string
    surface?: SessionSurface
  } | null
  foregroundError: ForegroundMessage | null
  petOverride: PetState | null
  recall: RecallEntry[]
  recallQuery: string | null
  recallOpen: boolean
  sessions: SessionNode[]
  /** Initial project/session hydration is separate from persisted read-ledger state. */
  workspaceLoadState: WorkspaceLoadState
  /** First-turn admission before a durable session exists. */
  turnLaunch: TurnLaunch | null
  collapsedSessionIds: Record<string, boolean>
  resourceRevision: number
  backendReady: boolean
  /** Changes on every Service process start and invalidates renderer attachment caches. */
  serviceInstanceId: string | null
  runtimeReadiness: RuntimeReadiness | null
  runtimeCapabilities: RuntimeCapabilities | null
  usage: UsageTotals
  catalog: ModelCatalog
  credits: CreditsState
  accountMenuOpen: boolean
  /** Independent full-screen settings surface opened from the account chip. */
  accountSettingsPage: AccountSettingsPage | null
  /** 问题反馈弹窗。从账户菜单打开, 不跟随菜单关闭 (提交中不能被一次失焦清掉)。 */
  feedbackOpen: boolean
  /**
   * 打开反馈弹窗前抓取的当前窗口截图字节; null = 未抓或抓取失败 (静默降级)。
   * 由 act.openFeedback() 写入, 作为弹窗里默认开启、可一键删除的预附件。
   */
  feedbackScreenshot: Uint8Array | null
  /**
   * 应用内登录层。登录不是门禁: 未登录也能用应用, 这一层只由用户从账户菜单 /
   * 账号设置主动打开。与 feedbackOpen 同理不跟随菜单关闭, 也不随表面切换重置 ——
   * 验证码/口令填到一半切个视图就丢掉, 等于逼用户重填。
   */
  loginOpen: boolean
  /**
   * The home project picker (PRD 2.1.2 modification 2) and the sidebar project
   * switcher share handlers but keep independent open state, so opening one
   * never silently closes the other.
   */
  homeProjectMenuOpen: boolean
  /**
   * 已选项目的 content 域 id（PRD 2.1.8: 默认未选显示「选择项目」）。
   *
   * 存 id 而不是路径：资料 / 文献 / 搜索 / 文件事件这些接口只认 id，传路径会
   * 被 unknown_project 拒掉。会话域需要的绝对路径用 `selectedProjectPath`
   * 按 id 反查 —— 两套 key 各有事实源，不能混用同一个字符串。
   */
  homeSelectedProjectId: string | null
  workbenchReturnProjectId: string | null
  /** 项目内新对话的归属锁；锁定时首页不提供项目选择入口。 */
  homeProjectLocked: boolean
  /** One list row currently editing its title inline. */
  sessionRename: { sessionId: string; originalTitle: string } | null
  searchHint: boolean
  /** 新建 / 编辑项目弹窗（PRD 2.1.8）；null = 关闭。 */
  /** 一次性成功提示（项目创建/改名/移除等），与 foregroundError 互补。 */
  foregroundNotice: ForegroundMessage | SkillInstallNotice | null
  projectForm: ProjectFormTarget | null
  /** 侧栏项目节点的收起状态，按项目路径记。 */
  collapsedProjects: Record<string, boolean>
  /** 侧栏一级分组的收起状态。 */
  sidebarGroupsCollapsed: Record<string, boolean>

  // ===== MVP 0.2 领域切片 =====
  // 每个切片由单一负责人拥有，切片之间不互相 import；
  // 跨域协作统一走下方 act.* 动作。
  /** 资料库（负责人 A）。 */
  resource: ResourceState
  /** 文献库（负责人 B）。 */
  literature: LiteratureState
  /** AI 对话面板（负责人 D）。 */
  aiPanel: AiPanelState
  /** 中央工作区标签（负责人 C）。 */
  tabs: WorkbenchTab[]
  activeTab: string
  /** 全局搜索面板 ⌘K（负责人 F）。 */
  globalSearchOpen: boolean
  /** Global search shows every domain; quick open narrows the same surface to files. */
  globalSearchMode: 'all' | 'files'
  /** Successfully opened project files, newest first, persisted as renderer UX state. */
  recentFiles: RecentFileEntry[]
  /** 首页「最近打开」的文献 MRU；newest first，持久化为 renderer UX state。 */
  recentLiterature: RecentLiteratureEntry[]
  /** Conversation MRU used by the Assistant reference picker. */
  recentSessions: RecentSessionEntry[]
  /** 模块面板是否展开（原型「收起」按钮）。 */
  modulePanelOpen: boolean
  pdfSidePanelOpen: boolean
}

function resourceDocumentTabIdForSelection(state: AppState): string | null {
  if (!state.resource.selected) return null
  const project = state.homeSelectedProjectId ?? null
  const documents = documentWorkspaces.forProject(project).getSnapshot()
  const tab = Object.values(documents.tabs).find((candidate) => {
    const session = documents.sessions[candidate.sessionId]
    return session?.source.kind === 'project'
      && session.source.path === state.resource.selected
      && (session.source.project ?? null) === project
  })
  return tab?.id ?? null
}

function activeTabForWorkbenchView(view: MainView, state: AppState, tabs: WorkbenchTab[]): string {
  const fixed = FIXED_TAB_BY_VIEW[view]
  if (fixed) return fixed.id
  if (view === 'resource') {
    const selectedTabId = resourceDocumentTabIdForSelection(state)
    if (selectedTabId) return selectedTabId
    const documents = documentWorkspaces.forProject(state.homeSelectedProjectId).getSnapshot()
    const activeDocument = documents.tabs[state.activeTab]
    const activeSession = activeDocument ? documents.sessions[activeDocument.sessionId] : undefined
    if (activeSession?.source.kind === 'project') return state.activeTab
  }
  const current = tabs.find((tab) => tab.id === state.activeTab)
  const currentView = mainViewForWorkbenchTab(current)
  return current?.kind === 'overview' || currentView === view ? state.activeTab : OVERVIEW_TAB.id
}

const HOME_THREAD: Thread = {
  id: 'home',
  title: '',
  conversation: [],
  sessionId: null,
  lastSeq: 0
}

const EMPTY_CATALOG: ModelCatalog = {
  models: [],
  hiddenModels: [],
  subscriptionGroups: [],
  personalProfiles: null
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
}

/**
 * 分类操作的错误码 → 人话。
 *
 * 把后端稳定码转成可行动的提示：直接把 `collection_exists` 摆给用户
 * 他无法知道下一步该做什么。
 */
function collectionError(code?: string): string {
  if (code === 'collection_exists') return '已有同名分类，换个名字'
  if (code === 'reserved_collection') return '「未整理」是系统收件箱，不可改动'
  if (code === 'name_required') return '分类名不能为空'
  return '分类操作失败'
}

/** 资料树的一处补齐：某个目录 → 它的子节点、该层总数、合并方式。 */
type ResourceChildrenPatch = [
  path: string,
  children: ResourceNode[],
  total: number,
  mode: 'replace' | 'append'
]

/**
 * 把这些已展开目录里还没投影出来的子节点取回来。
 *
 * 后端一次只回若干层、每层一页，剩下的要在这里续取；按层级从浅到深处理，父目录
 * 补完深层节点才会出现在树里（因此一轮就能收敛）。
 *
 * 回补丁而不是整棵树：调用方必须把结果应用到 `setState` 的 `current` 上，拿这里
 * 的快照算出的整棵树会覆盖掉这期间发生的其它更新。
 */
async function fetchPendingChildren(
  nodes: ResourceNode[],
  expanded: Record<string, boolean>,
  project: string | null
): Promise<ResourceChildrenPatch[]> {
  const paths = Object.entries(expanded)
    .filter(([, open]) => open)
    .map(([path]) => path)
    .sort((left, right) => left.split('/').length - right.split('/').length)
  const patches: ResourceChildrenPatch[] = []
  let tree = nodes
  for (const path of paths) {
    const node = findResourceNode(tree, path)
    // 只补还差条目的目录：已投影完整的目录再拉一次只是把磁盘重扫一遍。
    if (!node || pendingChildCount(node) === 0) continue
    const result = await fetchResourceTree(project, path)
    // 失败时保持原样，下次展开会重试 —— 静默填一棵空子树等于告诉用户这里没东西。
    if (!result) continue
    patches.push([path, result.nodes, result.total, 'replace'])
    tree = withResourceChildren(tree, path, result.nodes, result.total)
  }
  return patches
}

const applyChildrenPatches = (
  nodes: ResourceNode[],
  patches: ResourceChildrenPatch[]
): ResourceNode[] =>
  patches.reduce(
    (tree, [path, children, total, mode]) => withResourceChildren(tree, path, children, total, mode),
    nodes
  )

const INITIAL_PREFERENCES = window.scholarseed?.preferences ?? DEFAULT_RENDERER_PREFERENCES
setActiveShortcutOverrides(INITIAL_PREFERENCES.shortcutOverrides)

const INITIAL: AppState = {
  onboarding: sanitizeOnboarding(INITIAL_PREFERENCES.onboarding),
  selectionPrompts: sanitizeSelectionPrompts(INITIAL_PREFERENCES.selectionPrompts),
  theme: INITIAL_PREFERENCES.theme,
  lang: INITIAL_PREFERENCES.language,
  editorRuntimeRevision: 0,
  languageSwitch: null,
  sidebarOpen: INITIAL_PREFERENCES.sidebarOpen,
  sessionActivityInitialized: INITIAL_PREFERENCES.sessionActivityInitialized,
  sessionActivitySeen: INITIAL_PREFERENCES.sessionActivitySeen,
  reasoningPreferences: INITIAL_PREFERENCES.reasoningPreferences ?? {},
  literatureAiModels: INITIAL_PREFERENCES.literatureAiModels,
  desktopNotifications: INITIAL_PREFERENCES.desktopNotifications,
  soundAlerts: INITIAL_PREFERENCES.soundAlerts,
  autoSave: INITIAL_PREFERENCES.autoSave,
  formatOnSave: INITIAL_PREFERENCES.formatOnSave,
  editorWordWrap: INITIAL_PREFERENCES.editorWordWrap,
  shortcutOverrides: INITIAL_PREFERENCES.shortcutOverrides,
  dataSharingMode: INITIAL_PREFERENCES.dataSharingMode,
  newChooser: false,
  modelMenuOpen: false,
  wdMenuOpen: false,
  notifPanelOpen: false,
  model: '',
  collaborationMode: 'default',
  globalPermissionMode: DEFAULT_GLOBAL_PERMISSION_MODE,
  defaultWorkflowEnabled: true,
  defaultAutoReviewEnabled: true,
  workdir: DEFAULT_WORKDIR.name,
  workspacePath: null,
  defaultWorkspacePath: null,
  projects: [],
  // MVP 0.2: 默认落在首页空间（项目全览）。原型 home space 即启动面，
  // 进项目 / 进文献全览都由首页卡片承接。
  mainView: 'home',
  activeSession: null,
  threads: {},
  capGallery: null,
  skillUploadOpen: false,
  workspaceFilesOpen: false,
  workspaceFilesSessionId: null,
  composerText: '',
  composerTaskType: '',
  composerRefs: [],
  judgment: 'pending',
  tension: 'open',
  thread: 'open',
  confirmDelete: null,
  foregroundError: null,
  petOverride: null,
  recall: [],
  recallQuery: null,
  recallOpen: false,
  sessions: [],
  workspaceLoadState: 'loading',
  turnLaunch: null,
  collapsedSessionIds: {},
  resourceRevision: 0,
  backendReady: false,
  serviceInstanceId: null,
  runtimeReadiness: null,
  runtimeCapabilities: null,
  usage: EMPTY_USAGE,
  catalog: EMPTY_CATALOG,
  credits: INITIAL_CREDITS_STATE,
  accountMenuOpen: false,
  accountSettingsPage: null,
  feedbackOpen: false,
  feedbackScreenshot: null,
  loginOpen: false,
  homeProjectMenuOpen: false,
  homeSelectedProjectId: null,
  workbenchReturnProjectId: null,
  homeProjectLocked: false,
  sessionRename: null,
  searchHint: false,
  foregroundNotice: null,
  projectForm: null,
  collapsedProjects: {},
  sidebarGroupsCollapsed: {},
  resource: INITIAL_RESOURCE_STATE,
  literature: INITIAL_LITERATURE_STATE,
  aiPanel: INITIAL_AI_PANEL_STATE,
  tabs: [OVERVIEW_TAB],
  activeTab: OVERVIEW_TAB.id,
  globalSearchOpen: false,
  globalSearchMode: 'all',
  recentFiles: INITIAL_PREFERENCES.recentFiles,
  recentLiterature: INITIAL_PREFERENCES.recentLiterature,
  recentSessions: INITIAL_PREFERENCES.recentSessions,
  modulePanelOpen: true,
  pdfSidePanelOpen: false
}

const MENU_KEYS: (keyof AppState)[] = [
  'newChooser',
  'modelMenuOpen',
  'wdMenuOpen',
  'notifPanelOpen',
  'accountMenuOpen',
  'homeProjectMenuOpen',
  'searchHint'
]

const SURFACE_RESET: Partial<AppState> = {
  workbenchReturnProjectId: null,
  // A failed foreground action belongs to the surface the user is leaving.
  foregroundError: null,
  capGallery: null,
  skillUploadOpen: false,
  workspaceFilesOpen: false,
  workspaceFilesSessionId: null,
  sessionRename: null
}

const COMPOSER_RESET: Partial<AppState> = {
  composerText: '',
  composerTaskType: '',
  composerRefs: []
}

function assistantScopeReset(current: AppState): Partial<AppState> {
  return {
    ...COMPOSER_RESET,
    activeSession: null,
    turnLaunch: null,
    aiPanel: {
      ...INITIAL_AI_PANEL_STATE,
      open: current.aiPanel.open,
      docked: current.aiPanel.docked,
      cover: current.aiPanel.cover,
      contextSources: current.aiPanel.contextSources
    }
  }
}

const HOME_RESET: Partial<AppState> = {
  ...SURFACE_RESET,
  ...COMPOSER_RESET,
  activeSession: null,
  mainView: 'home',
  newChooser: false,
  modelMenuOpen: false,
  wdMenuOpen: false,
  notifPanelOpen: false,
  confirmDelete: null,
  accountMenuOpen: false,
  homeProjectMenuOpen: false,
  searchHint: false,
  turnLaunch: null,
  homeSelectedProjectId: null,
  homeProjectLocked: false
}

const SESSION_META = 'Codex'
const ANSWER_ANNOTATION_MUTATION_TOAST_ID = 'answer-annotation-mutation-failed'
const ANSWER_ANNOTATION_REMOVE_TOAST_ID = 'answer-annotation-remove-failed'

export const activeThread = (state: AppState): Thread => (
  state.activeSession ? state.threads[state.activeSession] : undefined
) ?? HOME_THREAD

/** 已选项目的完整记录。项目目录是 content 域下发的那一份，不另存副本。 */
export const selectedProject = (state: AppState): Project | null => (
  state.homeSelectedProjectId
    ? state.projects.find((project) => project.id === state.homeSelectedProjectId) ?? null
    : null
)

/**
 * 已选项目的本机绝对路径，供会话域使用（openSession 的 `project_path`）。
 *
 * 反查不到就返回 null —— 语义等于「这条草稿没指定项目」，与用户还没选过时
 * 完全一致；硬塞一个 id 进 `project_path` 只会让后端以 project_path_not_registered 拒绝。
 */
export const assistantProject = (state: AppState) => resolveAssistantProject(
  state.activeSession, activeThread(state).projectPath, state.homeSelectedProjectId, state.projects
)

export const selectedProjectPath = (state: AppState): string | null =>
  selectedProject(state)?.path ?? null

function activeLocatedDocument(state: AppState): {
  source: LocatedDocumentSource
  title: string
  revision: string
} | null {
  const projectId = state.homeSelectedProjectId ?? assistantProject(state).projectId
  const documents = documentWorkspaces.forProject(projectId).getSnapshot()
  const tab = documents.focusedTabId ? documents.tabs[documents.focusedTabId] : null
  const session = tab ? documents.sessions[tab.sessionId] : null
  if (!session || (session.source.kind !== 'project' && session.source.kind !== 'literature')) {
    return null
  }
  return { source: session.source, title: session.title, revision: session.revision }
}

/**
 * 当前是否已经落在某个项目范围内。
 *
 * 已选项目算；后端已解析出资料树根目录也算 —— 用 `SCHOLARSEED_DEFAULT_WORKSPACE`
 * 直接打开一个本地目录时 projects 列表是空的，但文件树是真实可用的。
 *
 * 工作台空态、活动栏禁用与模块面板隐藏必须共用这一个判定，否则会出现
 * 「入口被禁用了，可空态却没出现」这类自相矛盾的画面。
 */
export const hasProjectScope = (state: AppState): boolean =>
  Boolean(selectedProject(state) || state.resource.root)

function currentLiteratureContextCandidate(state: AppState): AssistantContextCandidate | null {
  if (state.mainView !== 'literature' || !state.literature.detailId) return null
  const item = state.literature.items.find(
    (candidate) => candidate.id === state.literature.detailId
  )
  if (!item) return null
  return {
    kind: 'literature',
    source_id: item.id,
    label: item.title,
    retention: 'next_turn',
    origin: 'current_document'
  }
}

type Patch = Partial<AppState> | ((state: AppState) => Partial<AppState>)
type ThreadPatch = Partial<Thread> | ((thread: Thread) => Partial<Thread>)
export type SessionSurface = 'conversation' | 'assistant' | 'workbench'
const ASSISTANT_FALLBACK_VIEW: MainView = 'resource'

function assistantSessionView(current: AppState): MainView {
  return current.mainView === 'home' || current.mainView === 'conversation'
    ? ASSISTANT_FALLBACK_VIEW
    : current.mainView
}

function activateSession(
  current: AppState,
  node: SessionNode,
  surface: SessionSurface
): AppState {
  if (node.container || node.openable === false) return current
  if (current.activeSession === node.id) {
    if (surface === 'assistant') {
      return {
        ...current,
        mainView: assistantSessionView(current),
        aiPanel: { ...current.aiPanel, open: true, sessionMenuOpen: false }
      }
    }
    if (surface === 'workbench') return current
    return {
      ...current,
      ...SURFACE_RESET,
      mainView: 'conversation',
      homeSelectedProjectId: null,
      homeProjectLocked: false
    }
  }
  const sessions = upsertSessionNode(
    current.sessions,
    node.status === 'done' ? { ...node, status: 'dormant' } : node
  )
  const sessionActivitySeen = node.activityAt
    ? { ...current.sessionActivitySeen, [node.id]: node.activityAt }
    : current.sessionActivitySeen
  const knownThread = current.threads[node.id]
  const threads = {
    ...current.threads,
    [node.id]: knownThread
      ? {
        ...knownThread,
        resumeState: 'pending' as const,
        resumeMessage: { key: 'resume.codex' as const }
      }
      : {
        id: node.id,
        title: node.title || node.id,
        title_fallback: node.title ? sessionTitleFallback(node.title_fallback) : null,
        conversation: [],
        sessionId: node.id,
        lastSeq: 0,
        resumeState: 'pending' as const,
        resumeMessage: { key: 'resume.codex' as const },
        workdir: node.workdir,
        projectPath: node.projectPath,
        status: node.status,
        meta: node.meta
      }
  }
  const shared = {
    ...current,
    ...COMPOSER_RESET,
    activeSession: node.id,
    sessions,
    sessionActivitySeen,
    threads
  }
  if (surface === 'assistant') {
    return {
      ...shared,
      mainView: assistantSessionView(current),
      aiPanel: { ...current.aiPanel, open: true, sessionMenuOpen: false }
    }
  }
  if (surface === 'workbench') return shared
  return {
    ...shared,
    ...SURFACE_RESET,
    mainView: 'conversation',
    homeSelectedProjectId: null,
    homeProjectLocked: false
  }
}

function currentScopeKey(current: AppState): string | null {
  return continuityScopeKey({
    activeSession: current.activeSession,
    threadProjectPath: activeThread(current).projectPath,
    homeSelectedProjectId: current.homeSelectedProjectId,
    mainView: current.mainView,
    projects: current.projects
  })
}

/**
 * 离开当前作用域时记住「最后打开的对话」：值为当前会话（仅当它属于该作用域），
 * 否则记 null（新对话）。无项目且不在文献库的全局状态不写。
 */
function rememberScopeConversation(current: AppState): void {
  const scopeKey = currentScopeKey(current)
  if (!scopeKey) return
  const scopePath = assistantProject(current).projectPath
  const sessionId = current.activeSession !== null
    && (activeThread(current).projectPath ?? null) === scopePath
    ? current.activeSession
    : null
  const storage = window.localStorage
  const record = readContinuityRecord(storage)
  const next = rememberContinuity(record, scopeKey, sessionId)
  if (next !== record) writeContinuityRecord(storage, next)
}

/**
 * 会话自身的 projectPath 是权威归属（文献库会话为 null），只有它是 undefined
 * 时才退回线程缓存；两者都未知则跳过写入。
 */
function conversationScopePath(
  node: SessionNode | undefined,
  threadPath: string | null | undefined
): string | null | undefined {
  return node?.projectPath !== undefined ? node.projectPath : threadPath
}

/** 打开会话时把记录落到该会话所属作用域；归属不明（projectPath undefined）时跳过。 */
function rememberOpenedConversation(
  current: AppState,
  sessionId: string,
  projectPath: string | null | undefined
): void {
  if (projectPath === undefined) return
  const scopeKey = continuityScopeKey({
    activeSession: sessionId,
    threadProjectPath: projectPath,
    homeSelectedProjectId: null,
    mainView: current.mainView,
    projects: current.projects
  })
  if (!scopeKey) return
  const storage = window.localStorage
  const record = readContinuityRecord(storage)
  const next = rememberContinuity(record, scopeKey, sessionId)
  if (next !== record) writeContinuityRecord(storage, next)
}

/**
 * 进入作用域时把记录里的会话恢复到 AI 面板；记录缺失/失效时保持新对话，
 * 失效条目顺手清掉，避免每次进入都做一次注定失败的查找。
 */
function restoreScopeConversation(
  current: AppState,
  scopeKey: string,
  expectedProjectPath: string | null
): AppState {
  const storage = window.localStorage
  const record = readContinuityRecord(storage)
  const candidate = restoreContinuityCandidate(
    record,
    scopeKey,
    (sessionId) => findSessionNode(current.sessions, sessionId),
    expectedProjectPath
  )
  if (candidate.record !== record) writeContinuityRecord(storage, candidate.record)
  return candidate.node ? activateSession(current, candidate.node, 'assistant') : current
}

export interface Actions extends AssistantIngress {
  /** 外观与界面语言（PRD「偏好设置」）。两者都落盘，重启后保持。 */
  saveSelectionPrompts: (prompts: SelectionPrompts) => Promise<void>
  setLiteratureAiModel: (action: LiteratureAiModelAction, modelKey: string) => void
  setTheme: (theme: Theme) => void
  setLang: (lang: Lang) => void
  confirmLanguageSwitch: () => Promise<void>
  cancelLanguageSwitch: () => void
  setAutoSave: (enabled: boolean) => void
  setFormatOnSave: (enabled: boolean) => void
  setEditorWordWrap: (enabled: boolean) => void
  setShortcutOverride: (id: ShortcutCommandId, binding: PreferenceShortcutBinding | null) => void
  resetShortcutOverride: (id: ShortcutCommandId) => void
  markOnboardingSeen: (group: OnboardingGroup) => void
  resetOnboardingGroup: (group: OnboardingGroup) => void
  resetOnboardingSeen: () => void
  rememberOnboardingProject: (projectId: string) => void
  toggleSidebar: () => void
  removeSession: (id: string, surface?: SessionSurface) => void
  openCap: (kind: CapKind) => void
  openWorkspaceFiles: (sessionId?: string | null) => void
  openFilePreview: (target: FilePreviewTarget) => void
  openSession: (
    id: string,
    focus?: Omit<NonNullable<AiPanelState['messageFocus']>, 'sessionId'>
  ) => void
  openPanelSession: (
    node: SessionNode,
    focus?: Omit<NonNullable<AiPanelState['messageFocus']>, 'sessionId'>
  ) => void
  /** 统一项目切换：解绑跨项目前台会话，不终止后台任务。 */
  selectProject: (projectId: string) => void
  toggleSessionChildren: (id: string) => void
  invalidateResources: () => void
  openDraftSession: (
    sessionId: string,
    title: string,
    workdir: string | undefined,
    projectPath: string | null | undefined,
    runtime: {
      runtimeId: 'codex'
      runtime: RuntimeSnapshot
      readiness: RuntimeReadiness
      capabilities: RuntimeCapabilities
    },
    surface?: SessionSurface,
    titleFallback?: SessionTitleFallback
  ) => void
  clearSessionSelection: () => void
  startDraft: (seed?: DraftSeed) => void
  openSettings: (page: AccountSettingsPage | null) => void
  /** 先抓当前窗口截图、再打开问题反馈弹窗; 截图失败静默降级 (弹窗照常打开)。 */
  openFeedback: () => Promise<void>
  applyModelCatalog: (catalog: ModelsResp | null) => void
  setPersonalProfiles: (profiles: PersonalApiProfilesResp | null) => void
  renameSessionTitle: (id: string, title: string, titleFallback?: SessionTitleFallback) => void

  // ===== MVP 0.2 工作台动作 =====
  /** 切到某个工作台视图（活动栏）。 */
  openWorkbenchView: (view: MainView, options?: { preserveProject?: boolean; returnProjectId?: string }) => void
  /** 打开指定回合的文本变更审阅，并保留右侧当前会话。 */
  /** 模块面板开合。 */
  toggleModulePanel: () => void
  setPdfSidePanelOpen: (open: boolean) => void
  /** AI 面板开合。 */
  toggleAiPanel: () => void
  /** 在原型定义的右侧停靠与悬浮窗口之间切换。 */
  toggleAiPanelDock: () => void
  /** 放大/恢复停靠态 AI 面板。 */
  toggleAiPanelCover: () => void
  /** 打开一个资料文件标签。 */
  openResourceFile: (path: string, projectId?: string | null, attachment?: Extract<DocumentSource, { kind: 'session-file' }>) => void
  /** 在资料树中高亮并展开当前文件。 */
  selectResourceFile: (path: string) => void
  openSnapshot: (source: Extract<DocumentSource, { kind: 'review-base' | 'version' }>, title: string, titleFallback?: DocumentTab['titleFallback']) => void
  /** 打开由两个不可变版本组成的工作区对比标签。 */
  openVersionDiff: (reference: VersionDiffReference) => void
  /** 打开资料并让对应阅读器定位一条正文搜索命中。 */
  revealResourceFile: (path: string, reveal: FindTextReveal, projectId?: string | null) => void
  /** 激活已有标签。 */
  activateTab: (id: string, options?: { returnToExpandedAssistantOnClose?: boolean }) => void
  /** 关闭标签。 */
  closeWorkbenchTab: (id: string) => void
  /** 完成资料审阅并回到被审阅文件，不让相邻工作台标签决定去向。 */
  completeResourceReview: (
    id: string,
    target: { projectId: string; path: string; documentTabId: string | null }
  ) => void
  /** 打开一个由文献域持久化的 AI 检索任务。 */
  openLiteratureResult: (result: LiteratureResultReference) => void
  openLiteratureSearch: (task: LiteratureSearchTask) => void
  /** 按服务端创建时间恢复持久化 AI 检索标签。 */
  restoreLiteratureSearches: (tasks: LiteratureSearchTask[]) => void

  // ----- 资料库（PRD「资料新建」「资料管理」「资料导入」）-----
  /** 重拉资料树。写操作后统一走它刷新，保证 UI 与磁盘一致。 */
  reloadResourceTree: (expandedOverride?: Record<string, boolean>) => Promise<boolean>
  /**
   * 树上点一个目录：翻转展开态，展开时按需把它的子节点取回来。
   *
   * 后端一次只回若干层，更深的层级必须在这里续取 —— 否则深度上限就等于
   * 用户永远看不到的层级。
   */
  toggleResourceDir: (path: string) => Promise<void>
  /** 幂等地补齐某个目录还没投影出来的子节点（已完整则直接返回）。 */
  ensureResourceChildren: (path: string) => Promise<void>
  /**
   * 取同一层的下一页并追加。空 path 表示树根那一层。
   *
   * 单层可能有上万条，后端每层只回一页；不给用户一个「继续取」的入口，那一页
   * 之后的条目在界面上就等于不存在。
   */
  loadMoreResourceChildren: (path: string) => Promise<void>
  /**
   * 收起所有已展开的目录，树回到只剩顶层。
   *
   * 只清展开态，不动已经取回来的子节点：用户再展开同一个目录时不该重新等一次请求。
   */
  collapseAllResourceDirs: () => void
  /** 原子 Toast 一次性提示，可提供由用户主动触发的资料打开入口。 */
  noticeResource: (
    tone: 'ok' | 'error',
    text: ResourceNoticeMessage,
    openTarget?: ResourceNoticeOpenTarget
  ) => void
  /** 按当前树选择发起新建；显式给 directory 时落在该目录内。关联目录会先确认外部源目录变更。 */
  requestResourceCreate: (mode: ResourceCreateMode, directory?: string) => void
  cancelLinkedResourceCreate: () => void
  confirmLinkedResourceCreate: () => void
  openResourceMenu: (menu: NodeMenuState) => void
  closeResourceMenu: () => void
  /** 开启就地命名输入（重命名 / 新建文档 / 新建文件夹）。 */
  startResourceDraft: (target: string, mode: NameDraftState['mode']) => void
  setResourceNameDraft: (value: string) => void
  commitResourceNameDraft: (draft?: NameDraftState) => void
  retryResourceCreate: () => void
  cancelResourceNameDraft: () => void
  openResourceHistory: (path: string) => Promise<void>
  openResourceReview: (path: string) => Promise<void>
  closeResourceHistory: () => void
  refreshResourceVersioning: (projectOverride?: string) => Promise<void>
  admitResourceVersion: (path: string) => Promise<void>
  copyResourceNode: (path: string) => Promise<void>
  copyResourceName: (name: string) => Promise<void>
  revealResourceNode: (path: string, projectId?: string | null) => Promise<void>
  copyResourcePath: (path: string, projectId?: string | null) => Promise<void>
  revealActiveDocument: () => Promise<void>
  copyActiveDocumentPath: () => Promise<void>
  confirmResourceDelete: (target: DeleteConfirmState) => void
  cancelResourceDelete: () => void
  deleteResourceNode: () => Promise<void>
  confirmResourceUnlink: (target: UnlinkConfirmState) => void
  cancelResourceUnlink: () => void
  unlinkResourceRoot: () => Promise<void>
  /** 反方向关联 (先子后父) 选择弹窗: 取消 / 取代并挂载 / 直接打开已有子关联。 */
  cancelLinkSupersede: () => void
  confirmLinkSupersede: () => Promise<void>
  openCoveredLinkAndCancel: () => Promise<void>
  openResourceMoveDialog: (path: string, name: string) => void
  closeResourceMoveDialog: () => void
  moveResourceNode: (path: string, targetDir: string) => Promise<void>
  moveResourceToParent: (path: string) => Promise<void>
  importResourceFiles: (mode: 'copy' | 'link', sources: string[]) => Promise<void>
  resolveResourceImport: (action: ResourceImportDecisionAction) => Promise<void>
  /** 新开一个 Codex Search、官方 API、可见浏览器依次降级的全网搜索标签。 */
  startWebSearch: (text: string) => void
  /** 读取当前 Session 的服务端上下文投影。 */
  loadAiContext: (sessionId: string) => Promise<void>
  reloadArtifactLinks: (sessionId: string) => Promise<ArtifactLibraryLinksResult>
  /** CAS 更新当前 Session 的检索源。 */
  setAiSearchScope: (scope: SearchScope) => Promise<void>
  /** 把新会话创建前的草稿上下文写入刚创建的 Session。 */
  prepareAiContext: (sessionId: string) => Promise<number | null>
  /** 把一段文本交给 AI 面板提问（侧栏检索框 / 划词发 AI）。 */
  askAiFromPanel: (text: string, taskType?: ProductTaskType) => void
  /** 把当前活动标签的资料加为 AI 上下文（PRD「资料上下文」）。 */
  attachActiveFileToAi: () => Promise<void>
  /** 打开原型两栏菜单的资料/文献/对话候选面。 */
  openAiContextPicker: (source: AiContextSource, query?: string, filter?: AssistantSourceFilter) => void
  closeAiContextPicker: () => void
  /** AssistantIngress：其它 Feature 只提交页面安全候选，不操作 Session/CAS。 */
  /** 旧资料树入口的兼容适配；来源 Feature 迁移后删除。 */
  addAiContextRef: (input: {
    kind: Extract<ContextRefKind, 'file' | 'dir' | 'literature' | 'session'>
    sourceId: string
    label: string
  }) => Promise<void>
  /** 移除一条上下文。 */
  detachAiContext: (refId: string) => Promise<void>
  /** Create an answer annotation and optionally queue it for the next accepted turn. */
  createAnswerAnnotation: (
    answerId: string,
    input: Omit<AnswerAnnotationCreate, 'expected_context_revision'>
  ) => Promise<{ ok: boolean; annotation?: AnswerAnnotation; error?: string }>
  /** Edit an unclaimed annotation comment using annotation and context CAS revisions. */
  updateAnswerAnnotation: (annotationId: string, comment: string) => Promise<boolean>
  /** Permanently delete an unclaimed annotation using annotation and context CAS revisions. */
  deleteAnswerAnnotation: (annotationId: string) => Promise<boolean>
  /** Permanently delete several unclaimed annotations in one context CAS transaction. */
  deleteAnswerAnnotations: (annotationIds: string[]) => Promise<boolean>
  /** Resolve and focus one historical annotation without fuzzy text matching. */
  focusAnswerAnnotation: (annotationId: string) => Promise<void>
  /** Clear only the focus generation that finished its temporary highlight. */
  clearAnswerAnnotationFocus: (sequence: number) => void
  /** Remove only the pending next-turn reference; keep the persisted annotation. */
  detachAnswerAnnotation: (annotationId: string) => Promise<void>
  /** Remove several pending annotation references with one sequential CAS update. */
  detachAnswerAnnotations: (annotationIds: string[]) => Promise<void>
  /** 把显式选区或页面当前选区存为资料（PRD「对话存入资料库」）。 */
  /**
   * 在不离开当前工作台视图的前提下开一条草稿会话。
   *
   * 这个动作只重置会话与输入，保留当前工作台上下文，并确保 AI 面板可见。
   */
  startPanelDraft: (seed?: DraftSeed) => void

  // ----- 文献库（PRD「文献接入」「文献组织」）-----
  /**
   * 按当前筛选/排序条件重拉文献列表。
   *
   * `override` 用于「刚改完条件就重拉」：setState 异步批处理，此时 stateRef
   * 还是旧值，不传会发出旧参数请求（表现为点排序/筛选没反应）。
   */
  reloadLiterature: (override?: Partial<LiteratureState>) => Promise<void>
  /** 文献库面板的一次性提示。 */
  noticeLiterature: (tone: 'ok' | 'error', text: string) => void
  /** 只改文献库切片字段（不触发重拉），用于菜单开合、标签输入等纯 UI 态。 */
  patchLiterature: (patch: Partial<LiteratureState>) => void
  /** 切侧栏范围（全部 / 最近添加 / 分类 / 标签）。 */
  setLiteratureScope: (scope: LiteratureScope) => void
  /** 改搜索词 / PDF 筛选 / 排序，改完自动重拉。 */
  setLiteratureQuery: (patch: {
    searchText?: string
    pdfFilter?: PdfFilter
    sort?: LiteratureSort
    sortDesc?: boolean
  }) => void
  /** 点列头切排序；再点同一列回退默认「最近添加」。 */
  toggleLiteratureSort: (key: LiteratureSort) => void
  /** 开启分类名草稿（新建 / 重命名 / 建子分类）。 */
  startCollectionDraft: (mode: 'create' | 'rename' | 'child', target: string) => void
  /** 改分类名草稿内容。 */
  patchCollectionDraft: (value: string) => void
  /** 提交分类名草稿。 */
  commitCollectionDraft: () => Promise<void>
  /** 删分类（移除该分类关联，不删文献）。 */
  deleteLiteratureCollection: (name: string) => Promise<void>
  /** 右键分类：弹重命名/删除菜单。 */
  openCollectionMenu: (name: string, x: number, y: number) => void
  /** 右键文献行：弹上下文菜单。 */
  openLiteratureRowMenu: (id: string, x: number, y: number) => void
  /** 把勾选条目移进指定分类。 */
  moveLiteratureToCollection: (name: string) => Promise<void>
  /** 导出勾选条目为 BibTeX。 */
  exportLiteratureBibtex: () => Promise<void>
  /** 详情面板新增笔记。 */
  addLiteratureNote: () => Promise<void>
  /** 详情面板删笔记。 */
  removeLiteratureNote: (noteId: string) => Promise<void>
  /** AI 检索卡片提交（本期接到列表搜索）。 */
  searchLiteratureByAi: () => void
  /**
   * 打开文献的精确附件，由 Workbench 按服务端 MIME 选择查看器。
   * `options.projectId` 显式声明目标项目作用域；链式调用（如首页先
   * openLiteratureItem 再开附件）时 stateRef 还没提交，必须由调用方传入。
   */
  openLiteratureAttachment: (
    id: string,
    attachmentId?: string,
    page?: number,
    options?: { projectId?: string | null }
  ) => void
  /** 附件被删除后收掉它已打开的文档标签，避免界面继续显示已不存在的全文。 */
  closeLiteratureAttachment: (id: string, attachmentId: string) => void
  /** 勾选 / 取消勾选一条。 */
  toggleLiteratureSelected: (id: string) => void
  /** 全选 / 全不选当前可见条目。 */
  toggleLiteratureSelectAll: () => void
  /** 批量打标 / 去标 / 移除（PRD「批量操作」）。 */
  runLiteratureBatch: (action: 'add_tag' | 'remove_tag' | 'remove_items') => Promise<void>
  /** 从本机选文件入库（BIB / RIS / PDF）。 */
  importLiteratureFiles: (source: ImportSourceKind) => Promise<void>
  /** 把资料库当前选中的文件标记为文献（PRD「资料库标记为文献」）。 */
  markResourceAsLiterature: () => Promise<void>
  openLiteratureItem: (id: string, projectId: string) => Promise<void>
  /** 标注全文获取状态。 */
  markLiteratureFulltext: (id: string, status: FulltextStatus) => Promise<void>
  /** 请求真实取回全文（本期后端 501，前端提示待实现）。 */
  requestLiteratureFulltext: (id: string) => Promise<void>
  /** 把选中文献加为 AI 上下文（PRD「上下文附加」）。 */
  attachLiteratureToAi: () => Promise<void>
  retryTranslation: () => Promise<void>
  setTranslationTarget: (target: AssistantTranslationTarget) => void
  closeTranslation: () => void
}

export interface Store {
  state: AppState
  set: (patch: Patch) => void
  closeMenus: () => void
  act: Actions
  patchThread: (id: string | null, patch: ThreadPatch) => void
  appendThread: (id: string | null, item: ConvItem) => void
}

function PreferenceFailure(): React.JSX.Element {
  const { t } = useTranslation('foundation')
  return <>{t('preferences.failed')}</>
}

function PreferenceRetry({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation('foundation')
  return <Button onClick={onRetry}>{t('preferences.retry')}</Button>
}

export function StoreProvider({
  children,
  assistantSources
}: {
  children: React.ReactNode
  assistantSources: readonly AssistantSourceContribution[]
}): React.JSX.Element {
  const { i18n: resourceI18n } = useTranslation('resources')
  const { t: assistantText } = useTranslation('assistant')
  const { t: literatureText } = useTranslation('literature')
  const [state, setState] = useState<AppState>(() => ({
    ...INITIAL,
    aiPanel: {
      ...INITIAL.aiPanel,
      contextPickerSource: assistantSources[0]?.id ?? '',
      contextSources: assistantSources.map((source) => ({
        id: source.id,
        label: source.label,
        icon: source.icon,
        emptyLabel: source.emptyLabel,
        requiresProject: Boolean(source.requiresProject)
      }))
    }
  }))

  // 异步动作（资料读写、导入、删除）要读「此刻」的项目路径与弹窗目标。
  // 闭进 act 的 state 会是动作创建时的旧值，因此额外持一份 ref。
  const { toast } = useToast()
  const preferenceWriter = useRef<PreferenceWriter | null>(null)
  if (!preferenceWriter.current) {
    preferenceWriter.current = new PreferenceWriter(window.scholarseed.preferences, {
      save: (value) => window.scholarseed.savePreferences(value),
      reconcile: () => window.scholarseed.reconcilePreferences(),
      apply: async (value) => {
        await applyRendererLanguage(value.language)
        const selectionPrompts = sanitizeSelectionPrompts(value.selectionPrompts)
        setState((current) => {
          const samePrompts = selectionPromptsEqual(
            current.selectionPrompts,
            selectionPrompts
          )
          const sameRecentFiles = recentFilesEqual(
            current.recentFiles,
            value.recentFiles
          )
          const sameRecentLiterature = recentLiteratureEqual(
            current.recentLiterature,
            value.recentLiterature
          )
          const shortcutOverrides = sanitizeShortcutOverrides(value.shortcutOverrides)
          const sameShortcutOverrides = JSON.stringify(current.shortcutOverrides) === JSON.stringify(shortcutOverrides)
          const sameRecentSessions = recentSessionsEqual(
            current.recentSessions,
            value.recentSessions
          )
          const literatureAiModels = sanitizeLiteratureAiModels(value.literatureAiModels)
          const sameLiteratureAiModels = JSON.stringify(current.literatureAiModels) === JSON.stringify(literatureAiModels)
          if (
            onboardingEqual(current.onboarding, value.onboarding) &&
            current.lang === value.language &&
            current.editorWordWrap === value.editorWordWrap &&
            samePrompts &&
            sameRecentFiles &&
            sameRecentLiterature &&
            sameShortcutOverrides &&
            sameRecentSessions &&
            sameLiteratureAiModels
          ) return current
          setActiveShortcutOverrides(shortcutOverrides)
          return {
            ...current,
            onboarding: sanitizeOnboarding(value.onboarding),
            lang: value.language,
            editorWordWrap: value.editorWordWrap,
            selectionPrompts: samePrompts
              ? current.selectionPrompts
              : selectionPrompts,
            recentFiles: sameRecentFiles
              ? current.recentFiles
              : value.recentFiles,
            recentLiterature: sameRecentLiterature
              ? current.recentLiterature
              : value.recentLiterature,
            shortcutOverrides: sameShortcutOverrides
              ? current.shortcutOverrides
              : shortcutOverrides,
            recentSessions: sameRecentSessions
              ? current.recentSessions
              : value.recentSessions,
            literatureAiModels: sameLiteratureAiModels
              ? current.literatureAiModels
              : literatureAiModels
          }
        })
      },
      failed: () => {
        toast({
          tone: 'error',
          description: React.createElement(PreferenceFailure),
          action: React.createElement(PreferenceRetry, {
            onRetry: () => { void preferenceWriter.current?.retry() }
          })
        })
      }
    })
  }

  const stateRef = useRef(state)
  stateRef.current = state

  const switchEditorLanguage = useCallback(async (language: Lang): Promise<boolean> => {
    await preferenceWriter.current!.submit({ language })
    if (preferenceWriter.current!.current().language !== language) return false
    setState((current) => ({
      ...current,
      editorRuntimeRevision: current.editorRuntimeRevision + 1,
      languageSwitch: null
    }))
    return true
  }, [])

  // 文献列表/阅读器/全局搜索的「打开」都汇到 catalog recorder 与下面两个
  // action；MRU 只在这里落 state，避免各调用点重复记时间戳。
  useEffect(() => {
    registerLiteratureOpenRecorder((id) => {
      setState((current) => ({
        ...current,
        recentLiterature: touchRecentLiterature(current.recentLiterature, {
          id,
          openedAt: Date.now()
        })
      }))
    })
    return () => registerLiteratureOpenRecorder(null)
  }, [])

  // 资料库异步动作需要回调自己（写完刷树、出提示），用 ref 打破自引用环。
  const actRef = useRef<Actions>(null as unknown as Actions)
  const expandedAssistantReturns = useRef(new Map<string, () => void>())
  useEffect(() => () => {
    for (const unsubscribe of expandedAssistantReturns.current.values()) unsubscribe()
    expandedAssistantReturns.current.clear()
  }, [])
  const artifactLinksRequest = useRef(0)
  /** One AbortController owns each non-resumable web-search Invocation stream. */
  const webSearchInvocations = useRef(new Map<string, AbortController>())
  useEffect(() => () => {
    for (const controller of webSearchInvocations.current.values()) controller.abort()
    webSearchInvocations.current.clear()
  }, [])
  /** Same file cannot start a second admission while its request is pending. */
  const resourceVersionAdmissionRef = useRef(new Set<string>())
  /** Enter 与 blur 可能同帧触发；锁住一次真实写请求，响应后再释放。 */
  const resourceNameCommitRef = useRef(false)
  /** 资料树重拉的请求代次：导入终态刷新不能被更早发出的空树响应覆盖。 */
  const resourceTreeReloadSeq = useRef(0)
  /** 搜索连续点击时只允许最后一个目标补树并定位。 */
  const resourcePathRevealSeq = useRef(0)
  /** 连续打开资料文件时，只有最后一次请求可以更新自动上下文。 */
  const resourceFileContextSeq = useRef(0)
  /** Session 上下文加载期间暂存最后一个自动文档引用，ready 后再持久化。 */
  const pendingResourceFileContext = useRef<{
    requestSeq: number
    sessionId: string
    projectId: string | null
    candidate: AssistantContextCandidate
  } | null>(null)
  /** 文献库重拉的请求代次 (见 reloadLiterature: 丢弃过期响应)。 */
  const literatureReloadSeq = useRef(0)
  /** AI 上下文候选请求代次：输入 @ 连续筛选时只接收最后一次响应。 */
  const assistantContextCandidateSeq = useRef(0)
  /** 单项上下文写入串行化，避免连续操作用同一个 revision 并发覆盖。 */
  const assistantContextMutationQueue = useRef<Promise<void>>(Promise.resolve())
  const selectionAttempt = useRef<{
    key: string
    identity: SelectionAttemptIdentity
  } | null>(null)

  useEffect(() => {
    void preferenceWriter.current!.submit({
      sidebarOpen: state.sidebarOpen,
      sessionActivityInitialized: state.sessionActivityInitialized,
      sessionActivitySeen: state.sessionActivitySeen,
      reasoningPreferences: state.reasoningPreferences,
      literatureAiModels: state.literatureAiModels,
      desktopNotifications: state.desktopNotifications,
      soundAlerts: state.soundAlerts,
      autoSave: state.autoSave,
      formatOnSave: state.formatOnSave,
      editorWordWrap: state.editorWordWrap,
      shortcutOverrides: state.shortcutOverrides,
      dataSharingMode: state.dataSharingMode,
      theme: state.theme,
      recentFiles: state.recentFiles,
      recentLiterature: state.recentLiterature,
      recentSessions: state.recentSessions
    })
  }, [
    state.autoSave,
    state.editorWordWrap,
    state.formatOnSave,
    state.shortcutOverrides,
    state.dataSharingMode,
    state.desktopNotifications,
    state.sessionActivityInitialized,
    state.sessionActivitySeen,
    state.reasoningPreferences,
    state.literatureAiModels,
    state.recentFiles,
    state.recentLiterature,
    state.recentSessions,
    state.sidebarOpen,
    state.soundAlerts,
    state.theme
  ])

  const set = useCallback((patch: Patch) => {
    setState((current) => ({
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch)
    }))
  }, [])

  const closeMenus = useCallback(() => {
    setState((current) => {
      const next = { ...current }
      for (const key of MENU_KEYS) (next as Record<string, unknown>)[key] = false
      return next
    })
  }, [])

  const showAnswerAnnotationMutationFailure = useCallback((failure: AssistantFailure): void => {
    const detail = assistantFailureDetail(failure) ?? ''
    toast({
      id: ANSWER_ANNOTATION_MUTATION_TOAST_ID,
      tone: 'error',
      title: assistantText('contextErrors.annotationFailed', { detail })
    })
    console.warn('[assistant-context] mutate answer annotation failed', detail)
  }, [assistantText, toast])

  const showAnswerAnnotationRemoveFailure = useCallback((failure: AssistantFailure): void => {
    toast({
      id: ANSWER_ANNOTATION_REMOVE_TOAST_ID,
      tone: 'error',
      title: assistantText('contextErrors.removeFailedToast')
    })
    console.warn('[assistant-context] remove answer annotation failed', assistantFailureDetail(failure))
  }, [assistantText, toast])

  const patchThread = useCallback((id: string | null, patch: ThreadPatch) => {
    setState((current) => {
      if (!id) return current
      const thread = current.threads[id]
      if (!thread) return current
      const delta = typeof patch === 'function' ? patch(thread) : patch
      const nextThread = { ...thread, ...delta }
      const node = findSessionNode(current.sessions, thread.sessionId ?? id)
      let sessions = current.sessions
      if (node && ('status' in delta || 'running' in delta)) {
        let status: SessionStatus = node.status
        if (nextThread.status === 'waiting') status = 'waiting'
        else if (nextThread.running === true || nextThread.status === 'running') status = 'running'
        else if (nextThread.status === 'done') {
          status = current.activeSession === id ? 'dormant' : 'done'
        } else if (nextThread.status) status = nextThread.status
        sessions = upsertSessionNode(sessions, { ...node, status })
      }
      return {
        ...current,
        sessions,
        threads: { ...current.threads, [id]: nextThread }
      }
    })
  }, [])

  const appendThread = useCallback((id: string | null, item: ConvItem) => {
    setState((current) => {
      if (!id) return current
      const thread = current.threads[id]
      if (!thread) return current
      return {
        ...current,
        threads: {
          ...current.threads,
          [id]: { ...thread, conversation: [...thread.conversation, item] }
        }
      }
    })
  }, [])

  const persistAssistantContext = useCallback(async (next: {
    refs?: AssistantContextRef[]
    searchScope?: SearchScope
  }): Promise<AssistantContextSelection | null> => {
    const current = stateRef.current
    const sessionId = current.activeSession
    const panel = current.aiPanel
    if (!sessionId) {
      setState((value) => ({
        ...value,
        aiPanel: {
          ...value.aiPanel,
          refs: next.refs ?? panel.refs,
          searchScope: next.searchScope ?? panel.searchScope,
          contextError: null
        }
      }))
      return {
        session_id: '',
        revision: panel.revision,
        project_policy: panel.projectPolicy,
        search_scope: next.searchScope ?? panel.searchScope,
        refs: next.refs ?? panel.refs,
        updated_at: Date.now() / 1000,
        capabilities: panel.capabilities
      }
    }
    if (panel.sessionId !== sessionId || panel.contextState !== 'ready') {
      setState((value) => ({
        ...value,
        aiPanel: {
          ...value.aiPanel,
          open: true,
          contextError: { key: 'contextErrors.loading' }
        }
      }))
      return null
    }
    setState((value) => ({
      ...value,
      aiPanel: { ...value.aiPanel, contextState: 'saving', contextError: null }
    }))
    const result = await patchAssistantContext(sessionId, {
      expected_revision: panel.revision,
      project_policy: panel.projectPolicy,
      search_scope: next.searchScope ?? panel.searchScope,
      refs: next.refs ?? panel.refs
    })
    setState((value) => {
      if (value.activeSession !== sessionId) return value
      const selection = result.context ?? result.latest
      if (selection) {
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            sessionId,
            contextState: 'ready',
            revision: selection.revision,
            projectPolicy: selection.project_policy,
            searchScope: selection.search_scope,
            refs: selection.refs,
            capabilities: selection.capabilities,
            contextError: result.ok ? null : { key: 'contextErrors.updated' }
          }
        }
      }
      return {
        ...value,
        aiPanel: {
          ...value.aiPanel,
          contextState: 'error',
          contextError: { key: 'contextErrors.saveFailed', detail: assistantFailureDetail(result) }
        }
      }
    })
    return result.ok ? result.context ?? null : null
  }, [])

  /**
   * Apply an idempotent resource-path transform to the current mutable Assistant selection.
   * A CAS conflict replays the same transform over the authoritative latest refs once; claimed
   * refs are left untouched by the transformer supplied by the resources owner.
   */
  const syncResourceContext = useCallback(async (
    transform: (refs: AssistantContextRef[], submittedRefIds: string[]) => AssistantContextRef[]
  ): Promise<boolean> => {
    const snapshot = stateRef.current
    const sessionId = snapshot.activeSession
    if (!sessionId) {
      setState((current) => ({
        ...current,
        aiPanel: {
          ...current.aiPanel,
          refs: transform(current.aiPanel.refs, current.aiPanel.submittedRefIds),
          contextError: null
        }
      }))
      return true
    }
    if (snapshot.aiPanel.sessionId !== sessionId || snapshot.aiPanel.contextState !== 'ready') {
      return false
    }

    setState((current) => ({
      ...current,
      aiPanel: { ...current.aiPanel, contextState: 'saving', contextError: null }
    }))
    let selection: AssistantContextSelection = {
      session_id: sessionId,
      revision: snapshot.aiPanel.revision,
      project_policy: snapshot.aiPanel.projectPolicy,
      search_scope: snapshot.aiPanel.searchScope,
      refs: snapshot.aiPanel.refs,
      updated_at: Date.now() / 1000,
      capabilities: snapshot.aiPanel.capabilities
    }
    for (let attempt = 0; attempt < RESOURCE_CONTEXT_SYNC_ATTEMPTS; attempt += 1) {
      const result = await patchAssistantContext(sessionId, {
        expected_revision: selection.revision,
        project_policy: selection.project_policy,
        search_scope: selection.search_scope,
        refs: transform(selection.refs, stateRef.current.aiPanel.submittedRefIds)
      })
      const authoritative = result.context ?? result.latest
      if (result.ok && authoritative) {
        setState((current) => current.activeSession !== sessionId ? current : ({
          ...current,
          aiPanel: {
            ...current.aiPanel,
            sessionId,
            contextState: 'ready',
            revision: authoritative.revision,
            projectPolicy: authoritative.project_policy,
            searchScope: authoritative.search_scope,
            refs: authoritative.refs,
            capabilities: authoritative.capabilities,
            contextError: null
          }
        }))
        return true
      }
      if (result.latest && attempt + 1 < RESOURCE_CONTEXT_SYNC_ATTEMPTS) {
        selection = result.latest
        continue
      }
      setState((current) => current.activeSession !== sessionId ? current : ({
        ...current,
        aiPanel: {
          ...current.aiPanel,
          ...(authoritative ? {
            revision: authoritative.revision,
            projectPolicy: authoritative.project_policy,
            searchScope: authoritative.search_scope,
            refs: authoritative.refs,
            capabilities: authoritative.capabilities
          } : {}),
          contextState: authoritative ? 'ready' : 'error',
          contextError: { key: 'contextErrors.syncFailed', detail: assistantFailureDetail(result) }
        }
      }))
      return false
    }
    return false
  }, [])

  const runTranslation = useCallback(async (
    input: AssistantTranslationInput,
    identity?: {
      clientActionId: string
      retryOfAttemptId: string
    }
  ): Promise<AssistantInvocationMutationResult> => {
    const current = stateRef.current
    const projectId = current.homeSelectedProjectId
    const targetLanguage = input.target_language ?? (current.lang === 'en' ? 'en' : 'zh-CN')
    const clientActionId = identity?.clientActionId ?? crypto.randomUUID()
    const clientAttemptId = crypto.randomUUID()
    if (!projectId) {
      const error = '请先选择项目，再使用 AI 翻译。'
      setState((value) => ({
        ...value,
        aiPanel: {
          ...value.aiPanel,
          open: true,
          translation: {
            input,
            clientActionId,
            clientAttemptId,
            targetLanguage,
            loading: false,
            invocation: null,
            error: 'project_required'
          }
        }
      }))
      return { ok: false, error: 'project_required' }
    }
    setState((value) => ({
      ...value,
      aiPanel: {
        ...value.aiPanel,
        open: true,
        translation: {
          input,
          clientActionId,
          clientAttemptId,
          targetLanguage,
          loading: true,
          invocation: null,
          error: null
        }
      }
    }))
    const result = await startAssistantTranslation({
      client_action_id: clientActionId,
      client_attempt_id: clientAttemptId,
      retry_of_attempt_id: identity?.retryOfAttemptId,
      project_id: projectId,
      text: input.text,
      target_language: targetLanguage,
      source_id: input.source_id,
      source_revision: input.source_revision,
      model_key: input.model_key
    })
    setState((value) => {
      if (value.aiPanel.translation?.clientAttemptId !== clientAttemptId) return value
      return {
        ...value,
        aiPanel: {
          ...value.aiPanel,
          translation: {
            ...value.aiPanel.translation,
            loading: false,
            invocation: result.invocation ?? null,
            error: result.ok ? null : assistantFailureDetail(result) ?? 'translation_failed'
          }
        }
      }
    })
    return result
  }, [])

  const revealResourceTreePath = useCallback(async (
    path: string,
    project: string | null
  ): Promise<void> => {
    const generation = ++resourcePathRevealSeq.current
    const snapshot = stateRef.current
    const sourceProjectMatches = snapshot.homeSelectedProjectId === project
    const sourceTree = sourceProjectMatches ? snapshot.resource.tree : []
    const materialized = await materializeResourcePath(
      sourceTree,
      sourceProjectMatches ? snapshot.resource.rootTotal : 0,
      path,
      async (directory, offset) => fetchResourceTree(
        project,
        directory || undefined,
        offset
      )
    )
    if (generation !== resourcePathRevealSeq.current) return
    setState((current) => {
      if (
        current.homeSelectedProjectId !== project
        || current.resource.selected !== path
        || (sourceProjectMatches && current.resource.tree !== sourceTree)
      ) return current
      return {
        ...current,
        resource: {
          ...current.resource,
          tree: materialized.tree,
          rootTotal: materialized.rootTotal,
          expanded: expandedResourceAncestors(
            materialized.tree,
            path,
            current.resource.expanded
          )
        }
      }
    })
  }, [])

  const act = useMemo<Actions>(() => ({
    saveSelectionPrompts: (selectionPrompts) => preferenceWriter.current!.submit({ selectionPrompts }),
    setLiteratureAiModel: (action, modelKey) => setState((current) => {
      const literatureAiModels = sanitizeLiteratureAiModels({
        ...current.literatureAiModels,
        [action]: modelKey
      })
      void preferenceWriter.current!.submit({ literatureAiModels })
      return { ...current, literatureAiModels }
    }),
    setTheme: (theme) => setState((current) => (current.theme === theme ? current : { ...current, theme })),
    setLang: (lang) => {
      if (lang === stateRef.current.lang) return
      const dirtyCount = documentWorkspaces.dirtyEditorCount()
      if (dirtyCount > 0) {
        setState((current) => ({
          ...current,
          accountMenuOpen: false,
          languageSwitch: {
            target: lang,
            dirtyCount,
            saving: false,
            failure: null
          }
        }))
        return
      }
      void switchEditorLanguage(lang)
    },
    confirmLanguageSwitch: async () => {
      const pending = stateRef.current.languageSwitch
      if (!pending || pending.saving) return
      setState((current) => current.languageSwitch ? {
        ...current,
        languageSwitch: { ...current.languageSwitch, saving: true, failure: null }
      } : current)
      if (!await documentWorkspaces.saveEditors()) {
        setState((current) => current.languageSwitch ? {
          ...current,
          languageSwitch: {
            ...current.languageSwitch,
            dirtyCount: documentWorkspaces.dirtyEditorCount(),
            saving: false,
            failure: 'save'
          }
        } : current)
        return
      }
      if (!await switchEditorLanguage(pending.target)) {
        setState((current) => current.languageSwitch ? {
          ...current,
          languageSwitch: {
            ...current.languageSwitch,
            saving: false,
            failure: 'preferences'
          }
        } : current)
      }
    },
    cancelLanguageSwitch: () => setState((current) => ({ ...current, languageSwitch: null })),
    setAutoSave: (autoSave) => setState((current) => current.autoSave === autoSave ? current : { ...current, autoSave }),
    setFormatOnSave: (formatOnSave) => setState((current) => current.formatOnSave === formatOnSave ? current : { ...current, formatOnSave }),
    setEditorWordWrap: (editorWordWrap) => setState((current) => current.editorWordWrap === editorWordWrap ? current : { ...current, editorWordWrap }),
    setShortcutOverride: (id, binding) => setState((current) => {
      const shortcutOverrides = sanitizeShortcutOverrides({ ...current.shortcutOverrides, [id]: binding })
      setActiveShortcutOverrides(shortcutOverrides)
      return { ...current, shortcutOverrides }
    }),
    resetShortcutOverride: (id) => setState((current) => {
      if (!Object.prototype.hasOwnProperty.call(current.shortcutOverrides, id)) return current
      const shortcutOverrides = { ...current.shortcutOverrides }
      delete shortcutOverrides[id]
      setActiveShortcutOverrides(shortcutOverrides)
      return { ...current, shortcutOverrides }
    }),
    markOnboardingSeen: (group) => setState((current) => {
      if (current.onboarding.seen[group]) return current
      const onboarding = sanitizeOnboarding({
        ...current.onboarding,
        seen: { ...current.onboarding.seen, [group]: true }
      })
      void preferenceWriter.current!.submit({ onboarding })
      return { ...current, onboarding }
    }),
    resetOnboardingGroup: (group) => setState((current) => {
      if (!current.onboarding.seen[group]) return current
      const seen = { ...current.onboarding.seen }
      delete seen[group]
      const onboarding = sanitizeOnboarding({ ...current.onboarding, seen })
      void preferenceWriter.current!.submit({ onboarding })
      return { ...current, onboarding }
    }),
    resetOnboardingSeen: () => setState((current) => {
      if (!Object.keys(current.onboarding.seen).length) return current
      const onboarding = sanitizeOnboarding({ ...current.onboarding, seen: {} })
      void preferenceWriter.current!.submit({ onboarding })
      return { ...current, onboarding }
    }),
    rememberOnboardingProject: (projectId) => setState((current) => {
      if (current.onboarding.recentProjectId === projectId) return current
      const onboarding = sanitizeOnboarding({ ...current.onboarding, recentProjectId: projectId })
      void preferenceWriter.current!.submit({ onboarding })
      return { ...current, onboarding }
    }),
    toggleSidebar: () => setState((current) => ({ ...current, sidebarOpen: !current.sidebarOpen })),
    removeSession: (id, surface = 'conversation') => setState((current) => {
      const sessions = removeSessionNode(current.sessions, id)
      const threads = { ...current.threads }
      delete threads[id]
      if (current.activeSession === id) {
        if (surface === 'assistant') {
          return {
            ...current,
            ...COMPOSER_RESET,
            activeSession: null,
            turnLaunch: null,
            sessions,
            threads,
            confirmDelete: null,
            aiPanel: { ...current.aiPanel, open: true, sessionMenuOpen: false }
          }
        }
        return { ...current, ...HOME_RESET, sessions, threads }
      }
      return { ...current, sessions, threads, confirmDelete: null }
    }),
    openCap: (kind) => setState((current) => ({
      ...current,
      ...SURFACE_RESET,
      accountSettingsPage: kind === 'skill' ? 'skills' : null,
      capGallery: kind === 'skill' ? null : kind
    })),
    openWorkspaceFiles: (sessionId = null) => setState((current) => ({
      ...current,
      ...SURFACE_RESET,
      workspaceFilesOpen: !(
        current.workspaceFilesOpen && current.workspaceFilesSessionId === sessionId
      ),
      workspaceFilesSessionId: sessionId
    })),
    openFilePreview: (filePreview) => setState((current) => {
      const thread = activeThread(current)
      const sessionId = filePreview.sessionId || thread.sessionId
      let source: DocumentSource
      if (filePreview.source) {
        source = filePreview.source
      } else if (filePreview.artifactId && sessionId) {
        source = {
          kind: 'session-artifact',
          sessionId,
          artifactId: filePreview.artifactId,
          path: filePreview.path,
          revision: filePreview.revisionId,
          mediaType: filePreview.mediaType,
          renderKind: filePreview.renderKind
        }
      } else if (sessionId) {
        source = {
          kind: 'session-file',
          sessionId,
          path: filePreview.path,
          revision: filePreview.revisionId,
          mediaType: filePreview.mediaType,
          renderKind: filePreview.renderKind
        }
      } else {
        source = {
          kind: 'runtime-file',
          path: filePreview.absolutePath || filePreview.path,
          revision: filePreview.revisionId,
          mediaType: filePreview.mediaType,
          renderKind: filePreview.renderKind
        }
      }
      const projectId = assistantProject(current).projectId
      const workspace = documentWorkspaces.forProject(projectId)
      const navigationView = mainViewForDocumentSource(source, current.mainView)
      void workspace.open(source, undefined, filePreview.title, undefined, filePreview.titleFallback).then((tabId) => {
        workspace.setTabNavigationView(tabId, navigationView)
        setState((latest) => assistantProject(latest).projectId === projectId ? ({
          ...latest,
          activeTab: tabId,
          mainView: navigationView,
          aiPanel: { ...latest.aiPanel, cover: false }
        }) : latest)
      })
      return {
        ...current,
        foregroundError: null,
        capGallery: null,
        workspaceFilesOpen: false,
        workspaceFilesSessionId: null
      }
    }),
    openSession: (id, focus) => setState((current) => {
      const node = findSessionNode(current.sessions, id)
      if (current.activeSession === id) {
        rememberOpenedConversation(current, id, conversationScopePath(node, current.threads[id]?.projectPath))
        return {
          ...current,
          recentSessions: touchRecentSession(current.recentSessions, { id, openedAt: Date.now() }),
          mainView: assistantSessionView(current),
          aiPanel: {
            ...current.aiPanel,
            open: true,
            sessionMenuOpen: false,
            messageFocus: focus
              ? { ...focus, sessionId: id }
              : null
          }
        }
      }
      if (node?.container) return current
      rememberScopeConversation(current)
      rememberOpenedConversation(current, id, conversationScopePath(node, current.threads[id]?.projectPath))
      const sessions = node && node.status === 'done'
        ? upsertSessionNode(current.sessions, { ...node, status: 'dormant' })
        : current.sessions
      const sessionActivitySeen = node?.activityAt
        ? { ...current.sessionActivitySeen, [id]: node.activityAt }
        : current.sessionActivitySeen
      const threads = current.threads[id]
        ? {
          ...current.threads,
          [id]: {
            ...current.threads[id],
            resumeState: 'pending' as const,
            resumeMessage: { key: 'resume.codex' as const }
          }
        }
        : {
          ...current.threads,
          [id]: {
            id,
            title: node?.title ?? id,
            title_fallback: sessionTitleFallback(node?.title_fallback),
            conversation: [],
            sessionId: id,
            lastSeq: 0,
            resumeState: 'pending' as const,
            resumeMessage: { key: 'resume.codex' as const },
            workdir: node?.workdir,
            projectPath: node?.projectPath,
            status: node?.status,
            meta: node?.meta
          }
        }
      return {
        ...current,
        ...COMPOSER_RESET,
        activeSession: id,
        mainView: assistantSessionView(current),
        aiPanel: {
          ...current.aiPanel,
          open: true,
          sessionMenuOpen: false,
          messageFocus: focus
            ? { ...focus, sessionId: id }
            : null
        },
        sessions,
        recentSessions: touchRecentSession(current.recentSessions, { id, openedAt: Date.now() }),
        sessionActivitySeen,
        threads
      }
    }),
    openPanelSession: (node, focus) => setState((current) => {
      rememberOpenedConversation(current, node.id, conversationScopePath(node, current.threads[node.id]?.projectPath))
      const activated = activateSession(current, node, 'assistant')
      return {
        ...activated,
        recentSessions: touchRecentSession(activated.recentSessions, { id: node.id, openedAt: Date.now() }),
        aiPanel: {
          ...activated.aiPanel,
          messageFocus: focus
            ? { ...focus, sessionId: node.id }
            : null
        }
      }
    }),
    selectProject: (projectId) => setState((current) => {
      if (current.homeSelectedProjectId === projectId) return current
      rememberScopeConversation(current)
      const nextProject = current.projects.find((project) => project.id === projectId)
      const projectWorkspace = documentWorkspaces.forProject(projectId).getSnapshot()
      const projectActiveTab = projectWorkspace.focusedTabId ?? OVERVIEW_TAB.id
      const thread = activeThread(current)
      const crossesProject = Boolean(
        current.activeSession && thread.projectPath !== nextProject?.path
      )
      const projectScope = {
        homeSelectedProjectId: projectId,
        workbenchReturnProjectId: null,
        resource: resourceStateForProjectSwitch(current.resource),
        ...(current.mainView === 'resource' ? { activeTab: projectActiveTab } : {})
      }
      const next = {
        ...current,
        ...(crossesProject ? assistantScopeReset(current) : {}),
        ...projectScope
      }
      if (!nextProject) return next
      return restoreScopeConversation(next, projectId, nextProject.path)
    }),
    toggleSessionChildren: (id) => setState((current) => ({
      ...current,
      collapsedSessionIds: {
        ...current.collapsedSessionIds,
        [id]: !current.collapsedSessionIds[id]
      }
    })),
    invalidateResources: () => setState((current) => ({
      ...current,
      resourceRevision: current.resourceRevision + 1
    })),
    openDraftSession: (sessionId, title, workdir, projectPath, runtime, surface = 'conversation', titleFallback = null) => setState((current) => {
      const detached = surface === 'workbench'
      if (!detached) {
        rememberScopeConversation(current)
        rememberOpenedConversation(current, sessionId, projectPath)
      }
      return {
        ...current,
        ...(surface === 'conversation' ? SURFACE_RESET : {}),
        turnLaunch: null,
        ...(!detached ? { activeSession: sessionId } : {}),
        ...(surface === 'conversation'
          ? { homeSelectedProjectId: null, homeProjectLocked: false }
          : {}),
        sessionActivitySeen: detached ? current.sessionActivitySeen : {
          ...current.sessionActivitySeen,
          [sessionId]: Date.now() / 1000
        },
        recentSessions: detached
          ? current.recentSessions
          : touchRecentSession(current.recentSessions, { id: sessionId, openedAt: Date.now() }),
        sessions: detached ? current.sessions : upsertSessionNode(current.sessions, {
          id: sessionId,
          title,
          title_fallback: titleFallback,
          status: 'dormant',
          tone: 'experience',
          meta: runtime.runtime.model_id || SESSION_META,
          createdAt: Date.now() / 1000,
          workdir,
          projectPath,
          runtimeId: runtime.runtimeId,
          openable: true
        }),
        threads: {
          ...current.threads,
          [sessionId]: {
            id: sessionId,
            title,
            title_fallback: titleFallback,
            conversation: [],
            surface: detached ? 'workbench' : 'conversation',
            sessionId,
            lastSeq: 0,
            resumeState: 'ready',
            resumeMessage: undefined,
            workdir,
            projectPath,
            runtimeId: runtime.runtimeId,
            runtime: runtime.runtime,
            readiness: runtime.readiness,
            capabilities: runtime.capabilities,
            running: false,
            status: 'dormant'
          }
        }
      }
    }),
    clearSessionSelection: () => setState((current) => {
      rememberScopeConversation(current)
      return { ...current, ...HOME_RESET }
    }),
    openSettings: (accountSettingsPage) => setState((current) => ({
      ...current,
      foregroundError: null,
      accountSettingsPage
    })),
    openFeedback: async () => {
      // 时机 (a): 弹窗挂载之前抓当前窗口。先等若干帧, 让宿主 closeMenus() 收起的
      // 账户菜单/遮罩真正卸载, 否则会把菜单拍进截图。
      let screenshot: Uint8Array | null = null
      try {
        await waitForFrames(CAPTURE_SETTLE_FRAMES)
        const result = await window.scholarseed?.captureFeedbackScreenshot()
        if (result?.ok) {
          // 拷贝一份, 脱离桥返回的 buffer。
          screenshot = new Uint8Array(result.bytes.byteLength)
          screenshot.set(result.bytes)
        }
      } catch {
        screenshot = null
      }
      // 截图是增益: 成功带字节、失败/异常都置 null, 两种情况都照常打开弹窗, 永不阻断报障。
      setState((current) => ({ ...current, feedbackOpen: true, feedbackScreenshot: screenshot }))
    },
    openWorkbenchView: (view, options) => setState((current) => {
      // 项目/文献库这类视图自己没有"被点开的文件"，进去时先把它的固定标签开出来，
      // 否则中区是白板。哪个视图配哪个标签由 FIXED_TAB_BY_VIEW 决定。
      const fixed = FIXED_TAB_BY_VIEW[view]
      const tabs = fixed ? openFixedTab(current.tabs, fixed) : current.tabs
      const activeTab = activeTabForWorkbenchView(view, current, tabs)
      const workspace = documentWorkspaces.forProject(current.homeSelectedProjectId)
      if (workspace.getSnapshot().tabs[activeTab]) workspace.focusTab(activeTab)
      const leavesProjectScope = view === 'home'
        || (view === 'literature' && !options?.preserveProject)
      if (leavesProjectScope) rememberScopeConversation(current)
      const targetProjectId = leavesProjectScope ? null : current.homeSelectedProjectId
      const changesAssistantScope = assistantProject(current).projectId !== targetProjectId
      const next = {
        ...current,
        ...SURFACE_RESET,
        ...(changesAssistantScope ? assistantScopeReset(current) : {}),
        homeProjectMenuOpen: false,
        mainView: view,
        workbenchReturnProjectId: options?.returnProjectId ?? null,
        ...(leavesProjectScope
          ? {
            homeSelectedProjectId: null,
            homeProjectLocked: false
          }
          : {}),
        modulePanelOpen: true,
        tabs,
        activeTab
      }
      return view === LITERATURE_SCOPE_KEY && next.homeSelectedProjectId === null
        ? restoreScopeConversation(next, LITERATURE_SCOPE_KEY, null)
        : next
    }),
    toggleModulePanel: () => setState((current) => ({
      ...current,
      modulePanelOpen: !current.modulePanelOpen
    })),
    setPdfSidePanelOpen: (open: boolean) => setState((current) =>
      current.pdfSidePanelOpen === open ? current : { ...current, pdfSidePanelOpen: open }
    ),
    toggleAiPanel: () => {
      const current = stateRef.current
      const opening = !current.aiPanel.open
      if (!opening) resourceFileContextSeq.current += 1
      const candidate = opening
        ? currentLiteratureContextCandidate(current)
        : null
      setState((value) => ({
        ...value,
        aiPanel: {
          ...value.aiPanel,
          open: !value.aiPanel.open,
          cover: value.aiPanel.open ? false : value.aiPanel.cover
        }
      }))
      if (candidate) void actRef.current.addContext(candidate)
    },
    openPanel: (reason) => {
      const candidate = reason === 'user_request'
        ? currentLiteratureContextCandidate(stateRef.current)
        : null
      setState((current) => ({
        ...current,
        aiPanel: { ...current.aiPanel, open: true }
      }))
      if (candidate) void actRef.current.addContext(candidate)
    },
    invokeOnce: async (input: AssistantOneShotInput) => {
      const projectId = stateRef.current.homeSelectedProjectId
      if (!projectId) return { ok: false, error: 'project_required' }
      return startAssistantInvocation({
        client_action_id: crypto.randomUUID(),
        client_attempt_id: crypto.randomUUID(),
        project_id: projectId,
        input_text: input.input_text,
        instructions: input.instructions,
        model_key: input.model_key
      })
    },
    translate: (input) => runTranslation(input),
    invokeSelection: async (
      input: AssistantSelectionActionInput,
      retry = false,
      stream?: AssistantSelectionStreamOptions
    ): Promise<AssistantSelectionActionMutationResult> => {
      const projectId = stateRef.current.homeSelectedProjectId
      if (!projectId) return { ok: false, error: 'project_required' }
      const key = JSON.stringify([projectId, selectionActionKey(input)])
      const identity = nextSelectionAttempt(
        selectionAttempt.current?.key === key ? selectionAttempt.current.identity : null,
        retry,
        () => crypto.randomUUID()
      )
      selectionAttempt.current = { key, identity }
      return startAssistantSelectionAction({
        ...input,
        client_action_id: identity.clientActionId,
        client_attempt_id: identity.clientAttemptId,
        retry_of_attempt_id: identity.retryOfAttemptId,
        project_id: projectId
      }, stream)
    },
    stopSelection: stopAssistantSelection,
    retryTranslation: async () => {
      const translation = stateRef.current.aiPanel.translation
      if (!translation || translation.loading) return
      await runTranslation(
        {
          ...translation.input,
          target_language: translation.targetLanguage
        },
        {
          clientActionId: translation.clientActionId,
          retryOfAttemptId: translation.clientAttemptId
        }
      )
    },
    setTranslationTarget: (target) => setState((current) => ({
      ...current,
      aiPanel: current.aiPanel.translation
        ? {
          ...current.aiPanel,
          translation: {
            ...current.aiPanel.translation,
            targetLanguage: target
          }
        }
        : current.aiPanel
    })),
    closeTranslation: () => setState((current) => ({
      ...current,
      aiPanel: { ...current.aiPanel, translation: null }
    })),
    toggleAiPanelDock: () => setState((current) => ({
      ...current,
      aiPanel: {
        ...current.aiPanel,
        docked: !current.aiPanel.docked,
        cover: false,
        open: true
      }
    })),
    toggleAiPanelCover: () => setState((current) => ({
      ...current,
      aiPanel: {
        ...current.aiPanel,
        docked: true,
        cover: !current.aiPanel.cover,
        open: true
      }
    })),
    openSnapshot: (source, title, titleFallback) => {
      const workspace = documentWorkspaces.forProject(source.project)
      void workspace.open(source, 'preview', title, undefined, titleFallback).then((tabId) => {
        setState((current) => assistantProject(current).projectId === source.project
          ? { ...current, activeTab: tabId }
          : current)
      })
    },
    openResourceFile: (path, projectId, attachment) => {
      const current = stateRef.current
      const project = projectId ?? current.homeSelectedProjectId
      const contextRequestSeq = resourceFileContextSeq.current + 1
      resourceFileContextSeq.current = contextRequestSeq
      const addToAssistant =
        current.aiPanel.open && project === assistantProject(current).projectId
      const source = {
        kind: 'project',
        path,
        project
      } as const
      const workspace = documentWorkspaces.forProject(project)
      const opened = attachment
        ? workspace.openImported(source, attachment)
        : workspace.open(source, 'edit')
      void opened.then((tabId) => {
        const snapshot = workspace.getSnapshot()
        const tab = snapshot.tabs[tabId]
        const session = tab ? snapshot.sessions[tab.sessionId] : undefined
        const openedFileContext =
          addToAssistant &&
          resourceFileContextSeq.current === contextRequestSeq &&
          stateRef.current.aiPanel.open &&
          stateRef.current.resource.selected === path &&
          session?.loadState === 'ready'
            ? {
                kind: 'file',
                source_id: path,
                label: session.title,
                retention: 'next_turn',
                origin: 'current_document'
              } satisfies AssistantContextCandidate
            : null
        setState((current) => ({
          ...current,
          ...(current.homeSelectedProjectId === project && tab
            ? { activeTab: tabId, aiPanel: { ...current.aiPanel, cover: false } }
            : {}),
          ...(project && session?.loadState === 'ready'
            ? {
              recentFiles: touchRecentFile(current.recentFiles, {
                projectId: project,
                path,
                openedAt: Date.now()
              })
            }
            : {})
        }))
        if (openedFileContext) {
          const latest = stateRef.current
          const sessionId = latest.activeSession
          if (
            !sessionId
            || (
              latest.aiPanel.sessionId === sessionId
              && latest.aiPanel.contextState === 'ready'
            )
          ) {
            void actRef.current.addContext(openedFileContext)
          } else {
            pendingResourceFileContext.current = {
              requestSeq: contextRequestSeq,
              sessionId,
              projectId: project,
              candidate: openedFileContext
            }
          }
        }
      })
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          expanded: expandedResourceAncestors(current.resource.tree, path, current.resource.expanded),
          selected: path
        }
      }))
      void revealResourceTreePath(path, project)
    },
    selectResourceFile: (path) => setState((current) => ({
      ...current,
      resource: {
        ...current.resource,
        expanded: expandedResourceAncestors(current.resource.tree, path, current.resource.expanded),
        selected: path
      }
    })),
    revealResourceFile: (path, reveal, projectId) => {
      const project = projectId ?? stateRef.current.homeSelectedProjectId
      const source = {
        kind: 'project',
        path,
        project
      } as const
      void documentWorkspaces.forProject(project).revealText(source, reveal).catch(() => {
        actRef.current.noticeResource('error', { key: 'feedback.cannotOpenSearch' })
      }).then((tabId) => {
        if (!tabId) return
        setState((current) => ({
          ...current,
          ...(current.homeSelectedProjectId === project ? { activeTab: tabId } : {}),
          ...(project
            ? {
              recentFiles: touchRecentFile(current.recentFiles, {
                projectId: project,
                path,
                openedAt: Date.now()
              })
            }
            : {})
        }))
      })
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          expanded: expandedResourceAncestors(current.resource.tree, path, current.resource.expanded),
          selected: path
        }
      }))
      void revealResourceTreePath(path, project)
    },

    // ----- 资料库真实操作 -----
    // 每个写动作都是「调接口 → 看结果 → 重拉树 → 提示」四步。
    // 重拉而不本地拼接: 磁盘是真源，本地推演会与重名避让、外部改动走歧。
    reloadResourceTree: async (expandedOverride) => {
      const project = stateRef.current.homeSelectedProjectId
      resourceTreeReloadSeq.current += 1
      const generation = resourceTreeReloadSeq.current
      setState((current) => ({
        ...current,
        resource: beginResourceTreeReload(current.resource)
      }))
      const [result, roots] = await Promise.all([
        fetchResourceTree(project),
        project ? listExternalRoots(project) : Promise.resolve(null)
      ])
      if (generation !== resourceTreeReloadSeq.current || project !== stateRef.current.homeSelectedProjectId) return false
      setState((current) => ({
        ...current,
        resource: finishResourceTreeReload(current.resource, result)
      }))
      if (!result || (project && !roots)) {
        actRef.current.noticeResource('error', { key: 'panel.loadFailed' })
        return false
      }
      // 整树刷新只回浅层，用户已经展开的深层目录会在树里变空 —— 展开态还在、内容没了。
      // 补丁必须在**刚拿回来的**浅树上算: setState 是异步的, 此时 stateRef 还是那棵
      // 已经补全过的旧树, 照它判断会得出「都已投影完整」而一处也不补。
      const patches = await fetchPendingChildren(
        result.nodes,
        expandedOverride ?? stateRef.current.resource.expanded,
        project
      )
      if (generation !== resourceTreeReloadSeq.current || project !== stateRef.current.homeSelectedProjectId) return false
      if (!patches.length) return true
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          tree: applyChildrenPatches(current.resource.tree, patches)
        }
      }))
      return true
    },
    toggleResourceDir: async (path) => {
      const open = !(stateRef.current.resource.expanded[path] ?? false)
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          selected: path,
          expanded: { ...current.resource.expanded, [path]: open }
        }
      }))
      if (open) await actRef.current.ensureResourceChildren(path)
    },
    ensureResourceChildren: async (path) => {
      if (!path) return
      const { resource, homeSelectedProjectId } = stateRef.current
      const patches = await fetchPendingChildren(
        resource.tree,
        { [path]: true },
        homeSelectedProjectId
      )
      if (!patches.length) return
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          tree: applyChildrenPatches(current.resource.tree, patches)
        }
      }))
    },
    loadMoreResourceChildren: async (path) => {
      const { resource, homeSelectedProjectId } = stateRef.current
      // 空 path = 树根那一层。根不是节点，已加载条数只能从树本身数。
      const loaded = path
        ? (findResourceNode(resource.tree, path)?.children?.length ?? 0)
        : resource.tree.length
      const result = await fetchResourceTree(homeSelectedProjectId, path || undefined, loaded)
      if (!result?.nodes.length) return
      setState((current) => ({
        ...current,
        resource: path
          ? {
            ...current.resource,
            tree: withResourceChildren(
              current.resource.tree,
              path,
              result.nodes,
              result.total,
              'append'
            )
          }
          : {
            ...current.resource,
            tree: [...current.resource.tree, ...result.nodes],
            rootTotal: result.total
          }
      }))
    },
    collapseAllResourceDirs: () =>
      setState((current) => ({
        ...current,
        // 只清展开态: 已取回的子节点留在树里, 再展开同一个目录不必重新等请求。
        resource: { ...current.resource, expanded: {} }
      })),
    noticeResource: (tone, text, openTarget) => setState((current) => ({
      ...current,
      resource: { ...current.resource, notice: { tone, text, openTarget } }
    })),
    requestResourceCreate: (mode, directory) => {
      const { tree, selected } = stateRef.current.resource
      const target = directory !== undefined
        ? resolveResourceCreateTargetAt(tree, directory)
        : resolveResourceCreateTarget(tree, selected)
      const linkedDirectory = target.linkedDirectory
      if (linkedDirectory) {
        setState((current) => ({
          ...current,
          resource: {
            ...current.resource,
            nameDraft: null,
            linkedCreateConfirm: {
              directoryPath: target.directory,
              directoryName: linkedDirectory.name,
              mode
            }
          }
        }))
        return
      }
      actRef.current.startResourceDraft(target.directory, mode)
    },
    cancelLinkedResourceCreate: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, linkedCreateConfirm: null }
    })),
    confirmLinkedResourceCreate: () => {
      const pending = stateRef.current.resource.linkedCreateConfirm
      if (!pending) return
      actRef.current.startResourceDraft(pending.directoryPath, pending.mode)
    },
    openResourceMenu: (menu) => setState((current) => ({
      ...current,
      resource: { ...current.resource, nodeMenu: menu }
    })),
    closeResourceMenu: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, nodeMenu: null }
    })),
    startResourceDraft: (target, mode) => setState((current) => {
      // 重命名预填现名，新建给一个可直接回车的默认名。
      const targetName = target.split('/').pop() ?? ''
      const targetNode = mode === 'rename' ? findResourceNode(current.resource.tree, target) : null
      const parts = mode === 'rename'
        ? resourceNameParts(targetName, targetNode?.kind ?? 'file')
        : mode === 'create_document'
          ? { basename: resourceDefaultName(mode, resourceI18n.getFixedT(null, 'resources')), suffix: MARKDOWN_SUFFIX }
          : { basename: resourceDefaultName(mode, resourceI18n.getFixedT(null, 'resources')), suffix: '' }
      const expanded = mode === 'rename' || !target
        ? current.resource.expanded
        : { ...current.resource.expanded, [target]: true }
      return {
        ...current,
        resource: {
          ...current.resource,
          expanded,
          linkedCreateConfirm: null,
          notice: null,
          nameDraft: {
            target,
            mode,
            value: parts.basename,
            suffix: parts.suffix,
            error: null,
            submitting: false
          }
        }
      }
    }),
    setResourceNameDraft: (value) => setState((current) => {
      const draft = current.resource.nameDraft
      if (!draft) return current
      const editableValue = draft.suffix && value.endsWith(draft.suffix)
        ? value.slice(0, -draft.suffix.length)
        : value
      return {
        ...current,
        resource: {
          ...current.resource,
          nameDraft: { ...draft, value: editableValue, error: null }
        }
      }
    }),
    cancelResourceNameDraft: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, nameDraft: null }
    })),
    commitResourceNameDraft: (override) => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const draft = override ?? resource.nameDraft
      if (!draft || draft.submitting || resourceNameCommitRef.current) return
      const name = draft.value.trim()
      const invalid = resourceNameError(name)
      if (invalid) {
        setState((current) => ({
          ...current,
          resource: {
            ...current.resource,
            notice: null,
            nameDraft: { ...draft, value: name, error: invalid, submitting: false }
          }
        }))
        return
      }
      const submittedName = `${name}${draft.suffix}`
      if (draft.mode === 'rename' && submittedName === draft.target.split('/').pop()) {
        actRef.current.cancelResourceNameDraft()
        return
      }
      if (
        draft.mode === 'rename'
        && documentWorkspaces.forProject(homeSelectedProjectId).hasDirtyProjectPath(homeSelectedProjectId, draft.target)
      ) {
        actRef.current.cancelResourceNameDraft()
        actRef.current.noticeResource('error', { key: 'feedback.renameDirty' })
        return
      }
      resourceNameCommitRef.current = true
      const pendingDraft = { ...draft, value: name, error: null, submitting: true }
      setState((current) => ({
        ...current,
        resource: { ...current.resource, notice: null, nameDraft: pendingDraft }
      }))
      const input = draft.mode === 'rename'
        ? { path: draft.target, name: submittedName }
        : { parent: draft.target, name: submittedName }
      void mutateResourceNode(draft.mode, input, homeSelectedProjectId).then(async (result) => {
        resourceNameCommitRef.current = false
        if (!result.ok) {
          const error = result.error ?? ''
          if (error === 'invalid_name') {
            setState((current) => ({
              ...current,
              resource: {
                ...current.resource,
                nameDraft: { ...pendingDraft, error: INVALID_RESOURCE_NAME_MESSAGE, submitting: false }
              }
            }))
            return
          }
          const linked = findResourceNode(resource.tree, draft.target)?.origin === 'link'
          const retryDraft =
            draft.mode !== 'rename' && RETRYABLE_RESOURCE_CREATE_ERRORS.has(error)
              ? { ...draft, value: name, error: null, submitting: false }
              : undefined
          setState((current) => ({
            ...current,
            resource: {
              ...current.resource,
              nameDraft: null,
              notice: {
                tone: 'error',
                text: draft.mode === 'rename'
                  ? (resourceErrorMessage(error))
                  : resourceCreateErrorMessage(error, linked),
                retryDraft
              }
            }
          }))
          return
        }
        if (draft.mode === 'rename' && result.node) {
          const renamed = result.node
          const relocatedExpanded = relocateExpandedResourcePaths(
            resource.expanded,
            draft.target,
            renamed.path
          )
          await actRef.current.reloadResourceTree(relocatedExpanded)
          await documentWorkspaces.forProject(homeSelectedProjectId).relocateProjectPath(
            homeSelectedProjectId,
            draft.target,
            renamed.path,
            renamed.name
          )
          setState((current) => ({
            ...current,
            resource: {
              ...current.resource,
              nameDraft: null,
              selected: current.resource.selected
                ? relocateResourcePath(current.resource.selected, draft.target, renamed.path)
                : null,
              expanded: relocatedExpanded,
              notice: null
            }
          }))
          const contextSynced = await syncResourceContext((refs, submittedRefIds) => (
            transformResourceContextRefs(
              refs,
              submittedRefIds,
              draft.target,
              renamed.path,
              renamed.name
            )
          ))
          actRef.current.noticeResource(
            contextSynced ? 'ok' : 'error',
            contextSynced
              ? { key: 'feedback.renamed', name: renamed.name }
              : { key: 'feedback.renamedSyncFailed', name: renamed.name }
          )
          return
        }
        await actRef.current.reloadResourceTree()
        const createdPath = result.node?.path ?? null
        setState((current) => ({
          ...current,
          resource: {
            ...current.resource,
            tree: result.node
              ? withCreatedResource(current.resource.tree, draft.target, result.node)
              : current.resource.tree,
            nameDraft: null,
            selected: createdPath ?? current.resource.selected,
            notice: {
              tone: 'ok',
              text: { key: 'feedback.created', name: result.node?.name ?? submittedName }
            }
          }
        }))
        if (draft.mode === 'create_document' && createdPath) {
          actRef.current.openResourceFile(createdPath, homeSelectedProjectId)
        }
      })
    },
    retryResourceCreate: () => {
      const retryDraft = stateRef.current.resource.notice?.retryDraft
      if (!retryDraft) return
      actRef.current.commitResourceNameDraft(retryDraft)
    },
    openResourceHistory: async (path) => {
      const project = stateRef.current.homeSelectedProjectId
      if (!project) return
      const capability = await fetchVersionCapability(project, path)
      if (stateRef.current.homeSelectedProjectId !== project) return
      if (!capability?.file_id) { actRef.current.noticeResource('error', resourceErrorMessage('version_admission_unavailable')); return }
      setState((current) => ({ ...current, resource: { ...current.resource, historyTarget: { project, path, fileId: capability.file_id! } } }))
    },
    openResourceReview: async (path) => {
      const project = stateRef.current.homeSelectedProjectId
      if (!project) return
      const batch = await fetchResourceReviewBatchForPath(project, path)
      if (stateRef.current.homeSelectedProjectId !== project) return
      if (!batch) {
        actRef.current.noticeResource('error', resourceErrorMessage('review_batch_unavailable'))
        return
      }
      const tab = reviewTab(project, batch.id, batch.members.length)
      setState((current) => ({
        ...current,
        mainView: 'resource',
        modulePanelOpen: true,
        tabs: openReviewTab(current.tabs, project, batch.id, batch.members.length),
        activeTab: tab.id
      }))
    },
    closeResourceHistory: () => setState((current) => ({ ...current, resource: { ...current.resource, historyTarget: null } })),
    refreshResourceVersioning: async (projectOverride) => {
      const workspace = documentWorkspaces.forProject(projectOverride ?? stateRef.current.homeSelectedProjectId)
      await Promise.all(Object.values(workspace.getSnapshot().sessions).map((session) => workspace.refreshVersioning(session.id, session.documentId)))
    },
    admitResourceVersion: async (path) => {
      const project = stateRef.current.homeSelectedProjectId
      if (!project) { actRef.current.noticeResource('error', resourceErrorMessage('no_project_selected')); return }
      const key = `${project}:${path}`
      if (resourceVersionAdmissionRef.current.has(key)) return
      resourceVersionAdmissionRef.current.add(key)
      setState((current) => ({ ...current, resource: { ...current.resource, admissionPending: { ...current.resource.admissionPending, [key]: true } } }))
      try {
        const capability = await fetchVersionCapability(project, path)
        if (!capability?.disk_revision) {
          if (stateRef.current.homeSelectedProjectId === project) actRef.current.noticeResource('error', resourceErrorMessage('version_admission_unavailable'))
          return
        }
        const result = await admitResourceVersion(project, path, capability.disk_revision, crypto.randomUUID())
        if (!result.ok) {
          if (stateRef.current.homeSelectedProjectId === project) actRef.current.noticeResource('error', resourceErrorMessage(result.error))
          return
        }
        await actRef.current.refreshResourceVersioning(project)
        if (stateRef.current.homeSelectedProjectId === project) {
          await actRef.current.reloadResourceTree()
          if (stateRef.current.homeSelectedProjectId === project) actRef.current.noticeResource('ok', { key: 'feedback.versionAdmitted', name: path })
        }
      } finally {
        resourceVersionAdmissionRef.current.delete(key)
        setState((current) => ({ ...current, resource: { ...current.resource, admissionPending: { ...current.resource.admissionPending, [key]: false } } }))
      }
    },
    copyResourceNode: async (path) => {
      const result = await mutateResourceNode('copy', { path }, stateRef.current.homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeResource('error', resourceErrorMessage(result.error))
        return
      }
      await actRef.current.reloadResourceTree()
      actRef.current.noticeResource('ok', { key: 'feedback.copied', name: result.node?.name ?? '' })
    },
    copyResourceName: async (name) => {
      const native = window.scholarseed?.writeClipboard
      if (native) {
        const done = await native(name)
        actRef.current.noticeResource(
          done.ok ? 'ok' : 'error',
          done.ok ? { key: 'feedback.nameCopied' } : { key: 'feedback.clipboardFailed', detail: done.error }
        )
        return
      }
      try {
        await navigator.clipboard.writeText(name)
        actRef.current.noticeResource('ok', { key: 'feedback.nameCopied' })
      } catch {
        actRef.current.noticeResource('error', { key: 'feedback.clipboardUnavailable' })
      }
    },
    revealResourceNode: async (path, projectId) => {
      const resolved = await resolveRevealTarget(path, projectId ?? stateRef.current.homeSelectedProjectId)
      if (!resolved.ok || !resolved.absolute) {
        actRef.current.noticeResource('error', { key: 'feedback.locationUnavailable' })
        return
      }
      const opened = await revealSystemPath(resolved.absolute)
      if (!opened.ok) actRef.current.noticeResource('error', opened.applicationFailure?.code === 'desktop_bridge_unavailable'
        ? { key: 'feedback.revealDesktopUnavailable' }
        : { key: 'feedback.revealFailed', detail: opened.error })
    },
    copyResourcePath: async (path, projectId) => {
      const resolved = await resolveRevealTarget(path, projectId ?? stateRef.current.homeSelectedProjectId)
      if (!resolved.ok || !resolved.absolute) {
        actRef.current.noticeResource('error', { key: 'feedback.pathUnavailable' })
        return
      }
      // 优先走主进程剪贴板：`navigator.clipboard.writeText` 要求文档处于聚焦态，
      // 而桌面端用户很容易在点右键菜单/切窗口时失焦，那时写入会直接报错。
      const native = window.scholarseed?.writeClipboard
      if (native) {
        const done = await native(resolved.absolute)
        actRef.current.noticeResource(
          done.ok ? 'ok' : 'error',
          done.ok ? { key: 'feedback.pathCopied' } : { key: 'feedback.clipboardFailed', detail: done.error }
        )
        return
      }
      // 非 Electron 环境（例如浏览器调试）才回落到 Web API。
      try {
        await navigator.clipboard.writeText(resolved.absolute)
        actRef.current.noticeResource('ok', { key: 'feedback.pathCopied' })
      } catch {
        actRef.current.noticeResource('error', { key: 'feedback.clipboardUnavailable' })
      }
    },
    revealActiveDocument: async () => {
      const document = activeLocatedDocument(stateRef.current)
      if (!document) return
      const location = await resolveDocumentLocation(document.source)
      if (!location.ok || !location.absolute) {
        actRef.current.noticeResource('error', { key: 'feedback.locationUnavailable' })
        return
      }
      const opened = await revealSystemPath(location.absolute)
      if (!opened.ok) actRef.current.noticeResource('error', opened.applicationFailure?.code === 'desktop_bridge_unavailable'
        ? { key: 'feedback.revealDesktopUnavailable' }
        : { key: 'feedback.revealFailed', detail: opened.error })
    },
    copyActiveDocumentPath: async () => {
      const document = activeLocatedDocument(stateRef.current)
      if (!document) return
      const location = await resolveDocumentLocation(document.source)
      if (!location.ok || !location.absolute) {
        actRef.current.noticeResource('error', { key: 'feedback.pathUnavailable' })
        return
      }
      const native = window.scholarseed?.writeClipboard
      if (native) {
        const done = await native(location.absolute)
        actRef.current.noticeResource(
          done.ok ? 'ok' : 'error',
          done.ok ? { key: 'feedback.pathCopied' } : { key: 'feedback.clipboardFailed', detail: done.error }
        )
        return
      }
      try {
        await navigator.clipboard.writeText(location.absolute)
        actRef.current.noticeResource('ok', { key: 'feedback.pathCopied' })
      } catch {
        actRef.current.noticeResource('error', { key: 'feedback.clipboardUnavailable' })
      }
    },
    confirmResourceDelete: (target) => setState((current) => ({
      ...current,
      resource: {
        ...current.resource,
        deleteConfirm: target
      }
    })),
    cancelResourceDelete: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, deleteConfirm: null }
    })),
    deleteResourceNode: async () => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const target = resource.deleteConfirm
      if (!target) return
      const parent = resourceParentDirectory(resource.tree, target.path)
      setState((current) => ({
        ...current,
        resource: { ...current.resource, deleteConfirm: null }
      }))
      // 后端只签一次性令牌；绝对路径不经渲染层，兑换只有主进程能做
      // （proposal 47 §6.6）。真正的删除走系统废纸篓，保证可恢复。
      const issued = await issueTrashToken(target.path, homeSelectedProjectId)
      if (!issued.ok || !issued.token) {
        actRef.current.noticeResource('error', resourceErrorMessage(issued.error))
        return
      }
      const trash = window.scholarseed?.trashToken
      if (!trash) {
        actRef.current.noticeResource('error', { key: 'feedback.trashUnavailable' })
        return
      }
      const done = await trash(issued.token)
      if (!done.ok) {
        actRef.current.noticeResource('error', { key: 'feedback.trashFailed', detail: done.error })
        return
      }
      const tabsClosed = documentWorkspaces.forProject(homeSelectedProjectId).discardProjectPath(
        homeSelectedProjectId,
        target.path
      )
      const remainingExpanded = removeExpandedResourcePaths(resource.expanded, target.path)
      await actRef.current.reloadResourceTree(remainingExpanded)
      const linkedSessionId = stateRef.current.aiPanel.sessionId
      if (linkedSessionId) void actRef.current.reloadArtifactLinks(linkedSessionId)
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          selected: current.resource.selected
            && !current.resource.selected.startsWith(`${target.path}/`)
            && current.resource.selected !== target.path
            ? current.resource.selected
            : parent || null,
          expanded: remainingExpanded
        }
      }))
      const contextSynced = await syncResourceContext((refs, submittedRefIds) => (
        transformResourceContextRefs(refs, submittedRefIds, target.path, null)
      ))
      const partial = Boolean(done.error) || !tabsClosed || !contextSynced
      actRef.current.noticeResource(
        partial ? 'error' : 'ok',
        partial
          ? { key: done.error ? 'feedback.trashReceiptFailed' : !tabsClosed ? 'feedback.trashTabsFailed' : 'feedback.trashContextFailed', name: target.name, detail: done.error }
          : { key: 'feedback.trashed', name: target.name }
      )
    },
    confirmResourceUnlink: (target) => setState((current) => ({
      ...current,
      resource: { ...current.resource, unlinkConfirm: target }
    })),
    cancelResourceUnlink: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, unlinkConfirm: null }
    })),
    unlinkResourceRoot: async () => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const target = resource.unlinkConfirm
      if (!target || !homeSelectedProjectId) return
      if (documentWorkspaces.forProject(homeSelectedProjectId).hasDirtyProjectPath(homeSelectedProjectId, target.mountPath)) {
        actRef.current.noticeResource('error', { key: 'feedback.unlinkDirty' })
        return
      }
      const parent = resourceParentDirectory(resource.tree, target.mountPath)
      setState((current) => ({
        ...current,
        resource: { ...current.resource, unlinkConfirm: null }
      }))
      const result = await revokeRoot(homeSelectedProjectId, target.rootId)
      if (!result.ok) {
        actRef.current.noticeResource('error', { key: 'feedback.unlinkFailed', detail: result.error ?? 'unknown_error' })
        return
      }
      let interrupted = 0
      if (target.interruptRunning) {
        for (const sessionId of result.agentSessionsUpdated) {
          const stopped = await interruptSession(sessionId)
          if (stopped.ok) interrupted += 1
        }
      }
      const tabsClosed = documentWorkspaces.forProject(homeSelectedProjectId).requestCloseProjectPath(
        homeSelectedProjectId,
        target.mountPath
      )
      const remainingExpanded = removeExpandedResourcePaths(
        resource.expanded,
        target.mountPath
      )
      await actRef.current.reloadResourceTree(remainingExpanded)
      setState((current) => ({
        ...current,
        resource: {
          ...current.resource,
          selected: current.resource.selected
            && !current.resource.selected.startsWith(`${target.mountPath}/`)
            && current.resource.selected !== target.mountPath
            ? current.resource.selected
            : parent || null,
          expanded: remainingExpanded
        }
      }))
      const contextSynced = await syncResourceContext((refs, submittedRefIds) => (
        transformResourceContextRefs(refs, submittedRefIds, target.mountPath, null)
      ))
      const partial = !tabsClosed || !contextSynced
      actRef.current.noticeResource(
        partial ? 'error' : 'ok',
        partial
          ? { key: !tabsClosed ? 'feedback.unlinkTabsFailed' : 'feedback.unlinkContextFailed', name: target.name }
          : target.interruptRunning && result.agentSessionsUpdated.length > 0
            ? { key: 'feedback.unlinkedInterrupted', name: target.name, count: interrupted }
            : { key: 'feedback.unlinked', name: target.name }
      )
    },
    cancelLinkSupersede: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, linkSupersedeConfirm: null }
    })),
    confirmLinkSupersede: async () => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const pending = resource.linkSupersedeConfirm
      if (!pending || !homeSelectedProjectId) return
      // 先关弹窗: 取代是逐个同步授权, 期间不再接受重复点击。
      setState((current) => ({
        ...current,
        resource: { ...current.resource, linkSupersedeConfirm: null }
      }))
      let mountedPath: string | null = null
      let failure: string | undefined
      for (const source of pending.sources) {
        // supersede=true: 后端在同一事务里原子撤销被这个父目录覆盖的子关联再挂载,
        // 不留「子关联已撤、父挂载未成」的半态或双身份窗口。
        const result = await authorizeRoot(
          homeSelectedProjectId,
          source,
          linkMountNameFromSource(source),
          true
        )
        if (!result.ok) {
          failure = result.error
          break
        }
        mountedPath = result.root?.mountPath ?? mountedPath
      }
      if (failure !== undefined) {
        // 未全部成功: 失败的那个源及其子关联保持原状 (后端按源逐个原子取代)。
        // 只刷新树反映真实状态并报错, 不乱关仍生效子关联名下的页签。
        await actRef.current.reloadResourceTree()
        actRef.current.noticeResource('error', resourceErrorMessage(failure))
        return
      }
      // 全部取代成功: 被覆盖的子关联已原子撤销。像取消关联一样关掉它们名下的孤儿
      // 页签、清展开态、丢弃按路径串附加的上下文引用 (路径基准已随挂载点消失)。
      let remainingExpanded = resource.expanded
      let tabsClosed = true
      for (const child of pending.covered) {
        tabsClosed = documentWorkspaces
          .forProject(homeSelectedProjectId)
          .requestCloseProjectPath(homeSelectedProjectId, child.mountPath) && tabsClosed
        remainingExpanded = removeExpandedResourcePaths(remainingExpanded, child.mountPath)
      }
      const contextSynced = await syncResourceContext((refs, submittedRefIds) =>
        pending.covered.reduce(
          (acc, child) => transformResourceContextRefs(acc, submittedRefIds, child.mountPath, null),
          refs
        )
      )
      await actRef.current.reloadResourceTree(remainingExpanded)
      if (mountedPath) {
        actRef.current.selectResourceFile(mountedPath)
        void revealResourceTreePath(mountedPath, homeSelectedProjectId)
      }
      const partial = !tabsClosed || !contextSynced
      actRef.current.noticeResource(
        partial ? 'error' : 'ok',
        partial
          ? { key: 'feedback.linkSupersedeCleanupFailed', count: pending.covered.length }
          : { key: 'feedback.linkSuperseded', count: pending.covered.length }
      )
    },
    openCoveredLinkAndCancel: async () => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const target = resource.linkSupersedeConfirm?.covered[0]
      setState((current) => ({
        ...current,
        resource: { ...current.resource, linkSupersedeConfirm: null }
      }))
      // 「不挂载, 直接打开原子目录」: 不取代、不授权, 只定位到已有的子关联。
      if (!target) return
      actRef.current.selectResourceFile(target.mountPath)
      await revealResourceTreePath(target.mountPath, homeSelectedProjectId)
    },
    openResourceMoveDialog: (path, name) => setState((current) => ({
      ...current,
      resource: { ...current.resource, moveDialog: { path, name } }
    })),
    closeResourceMoveDialog: () => setState((current) => ({
      ...current,
      resource: { ...current.resource, moveDialog: null }
    })),
    moveResourceNode: async (path, targetDir) => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const validation = validateResourceMove(resource.tree, path, targetDir)
      if (!validation.ok) {
        actRef.current.noticeResource(
          'error',
          resourceErrorMessage(validation.error)
        )
        return
      }
      if (documentWorkspaces.forProject(homeSelectedProjectId).hasDirtyProjectPath(homeSelectedProjectId, path)) {
        actRef.current.noticeResource('error', { key: 'feedback.moveDirty' })
        return
      }
      setState((current) => ({
        ...current,
        resource: { ...current.resource, moveDialog: null }
      }))
      const result = await mutateResourceNode(
        'move',
        { path, targetDir },
        homeSelectedProjectId
      )
      if (!result.ok) {
        actRef.current.noticeResource('error', resourceErrorMessage(result.error))
        return
      }
      if (result.node) {
        const moved = result.node
        const relocatedExpanded = {
          ...relocateExpandedResourcePaths(resource.expanded, path, moved.path),
          ...(targetDir ? { [targetDir]: true } : {})
        }
        await actRef.current.reloadResourceTree(relocatedExpanded)
        await documentWorkspaces.forProject(homeSelectedProjectId).relocateProjectPath(
          homeSelectedProjectId,
          path,
          result.node.path,
          result.node.name
        )
        setState((current) => {
          return {
            ...current,
            resource: {
              ...current.resource,
              selected: current.resource.selected
                ? relocateResourcePath(current.resource.selected, path, moved.path)
                : moved.path,
              expanded: relocatedExpanded
            }
          }
        })
        const contextSynced = await syncResourceContext((refs, submittedRefIds) => (
          transformResourceContextRefs(
            refs,
            submittedRefIds,
            path,
            moved.path,
            moved.name
          )
        ))
        actRef.current.noticeResource(
          contextSynced ? 'ok' : 'error',
          contextSynced
            ? { key: 'feedback.moved', name: moved.path }
            : { key: 'feedback.movedSyncFailed', name: moved.path }
        )
        return
      }
      await actRef.current.reloadResourceTree()
      actRef.current.noticeResource('error', { key: 'feedback.movePathMissing' })
    },
    moveResourceToParent: async (path) => {
      const tree = stateRef.current.resource.tree
      const currentParent = resourceParentDirectory(tree, path)
      const targetParent = currentParent ? resourceParentDirectory(tree, currentParent) : null
      if (currentParent === null || targetParent === null) {
        actRef.current.noticeResource('error', { key: 'feedback.alreadyAtRoot' })
        return
      }
      await actRef.current.moveResourceNode(path, targetParent)
    },
    importResourceFiles: async (mode, sources) => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const targetDir = resource.importDialog?.targetDir ?? ''
      const result = await createResourceImport(mode, sources, targetDir, homeSelectedProjectId)
      if (!result.ok) {
        if (result.error === SOURCE_COVERS_LINKS_ERROR) {
          // 反方向 (先子后父): 新源是已生效子关联的父目录。后端不硬拒绝, 回
          // source_covers_links; 前端凭已加载的关联根推出被覆盖的子关联, 关导入弹窗、
          // 弹选择框, 让用户决定「取代子关联并挂载父目录」还是「直接打开已有子关联」。
          const coveredRoots = deriveCoveredLinkRoots(stateRef.current.resource.tree, sources)
          if (coveredRoots.length > 0) {
            const target: LinkSupersedeConfirmState = {
              sources,
              covered: coveredRoots.map((item) => ({
                rootId: item.rootId,
                mountPath: item.mountPath,
                name: item.name
              }))
            }
            setState((current) => ({
              ...current,
              resource: { ...current.resource, importDialog: null, linkSupersedeConfirm: target }
            }))
            return
          }
          // 推不出被覆盖的子关联 (关联根未加载/路径规范化差异): 退回普通报错, 不弹空框。
        } else if (result.error === SOURCE_OVERLAP_ERROR) {
          // 正向 (先父后子): 撞上已生效的父级关联, 后端只回 source_overlap (包含判定是
          // 它的权威职责), 前端用已加载的关联根反推出这份资料在树里的位置 —— 关弹窗、
          // 定位过去, 再弹统一文案。用户立刻看到「它已经在那个父级关联里了」。
          const revealPath = deriveLinkOverlapTarget(stateRef.current.resource.tree, sources)
          if (revealPath) {
            setState((current) => ({
              ...current,
              resource: { ...current.resource, importDialog: null }
            }))
            actRef.current.selectResourceFile(revealPath)
            void revealResourceTreePath(revealPath, homeSelectedProjectId)
          }
        }
        actRef.current.noticeResource(
          'error',
          resourceErrorMessage(result.error)
        )
        return
      }
      setState((current) => ({
        ...current,
        resource: { ...current.resource, importDialog: null }
      }))
      actRef.current.noticeResource(
        'ok',
        { key: mode === 'copy' ? 'feedback.importQueued' : 'feedback.linkQueued' }
      )
    },
    resolveResourceImport: async (action) => {
      const { resource, homeSelectedProjectId } = stateRef.current
      const dialog = resource.importDialog
      if (!dialog || dialog.phase !== 'resolve') return
      setState((current) => ({
        ...current,
        resource: { ...current.resource, notice: null }
      }))
      const result = await importResources(
        'copy',
        dialog.sources,
        dialog.targetDir,
        homeSelectedProjectId,
        {
          planToken: dialog.planToken,
          action,
          sourceIndexes: dialog.conflicts.map((item) => item.sourceIndex),
          idempotencyKey: dialog.idempotencyKey
        }
      )
      if (!result.ok) {
        const error = resourceErrorMessage(result.error)
        actRef.current.noticeResource('error', error)
        return
      }
      if (result.status === 'needs_resolution') {
        setState((current) => ({
          ...current,
          resource: {
            ...current.resource,
            importDialog: {
              ...dialog,
              planToken: result.planToken,
              conflicts: result.conflicts,
              idempotencyKey: crypto.randomUUID()
            }
          }
        }))
        actRef.current.noticeResource('error', { key: 'feedback.importChanged' })
        return
      }
      setState((current) => ({
        ...current,
        resource: { ...current.resource, importDialog: null }
      }))
      await actRef.current.reloadResourceTree()
      if (action === 'replace') {
        await documentWorkspaces.forProject(result.projectId).reconcileProjectPaths(
          result.projectId,
          result.imported.filter((node) => node.kind === 'file').map((node) => node.path)
        )
      }
      actRef.current.noticeResource(
        'ok',
        action === 'replace'
          ? { key: 'feedback.importReplaced', count: result.imported.length }
          : { key: 'feedback.importRenamed', count: result.imported.length }
      )
    },
    startWebSearch: (text) => {
      const query = text.trim()
      if (!query) return
      const tab = createWebSearchTab(query, stateRef.current.homeSelectedProjectId)
      const controller = new AbortController()
      webSearchInvocations.current.set(tab.id, controller)
      setState((current) => ({
        ...current,
        mainView: 'resource',
        tabs: [...current.tabs, tab],
        activeTab: tab.id,
        // A fullscreen (cover) assistant hides the main column that shows this tab.
        aiPanel: { ...current.aiPanel, cover: false },
        resource: {
          ...current.resource,
          webSearches: {
            ...current.resource.webSearches,
            [tab.id]: {
              tabId: tab.id,
              query,
              startedAt: Date.now(),
              attempts: [],
              status: 'opening',
              selectedUrls: [],
              importing: false,
              importResults: {},
              notified: []
            }
          }
        }
      }))

      const patchSearch = (patch: Partial<ResourceState['webSearches'][string]>): void => {
        setState((current) => {
          const search = current.resource.webSearches[tab.id]
          if (!search || controller.signal.aborted) return current
          return {
            ...current,
            resource: {
              ...current.resource,
              webSearches: {
                ...current.resource.webSearches,
                [tab.id]: { ...search, ...patch }
              }
            }
          }
        })
      }

      const run = async (): Promise<void> => {
        const runtime = stateRef.current
        if (!runtime.runtimeReadiness?.ready) {
          patchSearch({
            status: 'failed',
            completedAt: Date.now(),
            error: webSearchInvocationFailure(
              runtime.runtimeReadiness?.message || '',
              WEB_SEARCH_CANDIDATES_EXECUTION_ERROR_CODE
            )
          })
          return
        }
        if (runtime.runtimeCapabilities?.skills !== true) {
          patchSearch({
            status: 'failed',
            completedAt: Date.now(),
            error: RUNTIME_SKILLS_UNAVAILABLE
          })
          return
        }

        const result = await runWebSearchRoute(
          query,
          { web_search: runtime.runtimeCapabilities?.web_search === true },
          (attempt, index) => {
            setState((current) => {
              const search = current.resource.webSearches[tab.id]
              if (!search || controller.signal.aborted) return current
              const attempts = [...search.attempts]
              attempts[index] = attempt
              return {
                ...current,
                resource: {
                  ...current.resource,
                  webSearches: {
                    ...current.resource.webSearches,
                    [tab.id]: {
                      ...search,
                      status: 'running',
                      attempts
                    }
                  }
                }
              }
            })
          },
          controller.signal
        )
        if (controller.signal.aborted) return
        if (!result.ok) {
          patchSearch({
            status: result.status,
            completedAt: Date.now(),
            attempts: result.attempts,
            error: result.error
          })
          return
        }
        patchSearch({
          status: 'completed',
          completedAt: Date.now(),
          attempts: result.attempts,
          resolvedMode: result.resolvedMode,
          error: undefined
        })
      }

      void run().finally(() => {
        if (webSearchInvocations.current.get(tab.id) === controller) {
          webSearchInvocations.current.delete(tab.id)
        }
      })
    },
    reloadArtifactLinks: async (sessionId) => {
      const request = ++artifactLinksRequest.current
      setState((current) => current.aiPanel.sessionId !== sessionId ? current : ({
        ...current,
        aiPanel: { ...current.aiPanel, artifactLinksState: 'loading' }
      }))
      const result = await listArtifactLibraryLinks(sessionId)
      setState((current) => {
        if (current.aiPanel.sessionId !== sessionId || request !== artifactLinksRequest.current) return current
        return {
          ...current,
          aiPanel: {
            ...current.aiPanel,
            artifactLinksState: result.ok ? 'ready' : 'error',
            artifactLinks: result.ok ? result.links : current.aiPanel.artifactLinks
          }
        }
      })
      return result
    },
    loadAiContext: async (sessionId) => {
      setState((current) => ({
        ...current,
        aiPanel: {
          ...current.aiPanel,
          sessionId,
          contextState: 'loading',
          revision: 0,
          projectPolicy: 'explicit_only',
          searchScope: 'web',
          refs: [],
          submittedRefIds: [],
          annotations: [],
          artifactLinks: [],
          artifactLinksState: 'loading',
          answerAnnotationFocus: null,
          capabilities: [],
          contextPickerOpen: false,
          contextPickerSource: assistantSources[0]?.id ?? '',
          contextCandidates: [],
          contextCandidatesLoading: false,
          contextError: null
        }
      }))
      void actRef.current.reloadArtifactLinks(sessionId)
      const [loadedSelection, annotations, queuedMessages] = await Promise.all([
        getAssistantContext(sessionId),
        listAnswerAnnotations(sessionId),
        listQueuedMessages(sessionId)
      ])
      const queuedSubmittedRefIds = (queuedMessages ?? []).flatMap((message) => (
        (message.assistant_references ?? []).flatMap((reference) => (
          reference.ref_id ? [reference.ref_id] : []
        ))
      ))
      let selection = loadedSelection
      if (selection?.refs.some((ref) => ref.origin === 'current_document')) {
        const cleaned = await patchAssistantContext(sessionId, {
          expected_revision: selection.revision,
          project_policy: selection.project_policy,
          search_scope: selection.search_scope,
          refs: selection.refs.filter((ref) => ref.origin !== 'current_document')
        })
        selection = cleaned.context ?? cleaned.latest ?? selection
      }
      setState((current) => {
        if (current.activeSession !== sessionId) return current
        if (!selection) {
          return {
            ...current,
            aiPanel: {
              ...current.aiPanel,
              contextState: 'error',
              contextError: { key: 'contextErrors.loadFailed' }
            }
          }
        }
        return {
          ...current,
          aiPanel: {
            ...current.aiPanel,
            sessionId,
            contextState: 'ready',
            revision: selection.revision,
            projectPolicy: selection.project_policy,
            searchScope: selection.search_scope,
            refs: selection.refs,
            submittedRefIds: Array.from(new Set(queuedSubmittedRefIds)),
            capabilities: selection.capabilities,
            annotations,
            contextError: null
          }
        }
      })
    },
    setAiSearchScope: async (scope) => {
      await persistAssistantContext({ searchScope: scope })
    },
    prepareAiContext: async (sessionId) => {
      const desired = stateRef.current.aiPanel
      const initial = await getAssistantContext(sessionId)
      if (!initial) {
        setState((current) => ({
          ...current,
          aiPanel: {
            ...current.aiPanel,
            contextState: 'error',
            contextError: { key: 'contextErrors.initializeFailed' }
          }
        }))
        return null
      }
      const result = await patchAssistantContext(sessionId, {
        expected_revision: initial.revision,
        project_policy: desired.projectPolicy,
        search_scope: desired.searchScope,
        refs: desired.refs
      })
      const selection = result.context ?? result.latest
      if (!result.ok || !selection) {
        setState((current) => ({
          ...current,
          aiPanel: {
            ...current.aiPanel,
            contextState: 'error',
            contextError: { key: 'contextErrors.newSaveFailed' }
          }
        }))
        return null
      }
      setState((current) => ({
        ...current,
        aiPanel: {
          ...current.aiPanel,
          sessionId,
          contextState: 'ready',
          revision: selection.revision,
          projectPolicy: selection.project_policy,
          searchScope: selection.search_scope,
          refs: selection.refs,
          capabilities: selection.capabilities,
          contextError: null
        }
      }))
      return selection.revision
    },
    askAiFromPanel: (text, taskType) => setState((current) => ({
      ...current,
      // 输入框真源是 0.1 已有的 composerText（Composer 消费它）。
      // 面板不另建一条平行输入链路，只把文本推进去并弹开面板。
      composerText: text.trim() ? text : current.composerText,
      composerTaskType: taskType ?? '',
      aiPanel: { ...current.aiPanel, open: true }
    })),
    attachActiveFileToAi: async () => {
      const current = stateRef.current
      const document = activeLocatedDocument(current)
      if (!document) {
        setState((value) => ({
          ...value,
          resource: {
            ...value.resource,
            notice: { tone: 'error', text: { key: 'feedback.openBeforeContext' } }
          }
        }))
        return
      }
      if (
        document.source.kind === 'project'
        && document.source.project !== assistantProject(current).projectId
      ) {
        setState((value) => ({ ...value, aiPanel: { ...value.aiPanel, contextError: { key: 'contextErrors.wrongProject' } } }))
        return
      }
      const location = document.source.kind === 'literature'
        ? await resolveDocumentLocation(document.source)
        : { ok: true, absolute: document.source.path }
      if (!location.ok || !location.absolute) {
        setState((value) => ({ ...value, aiPanel: { ...value.aiPanel, contextError: { key: 'contextErrors.sourceUnavailable' } } }))
        return
      }
      const absolute = location.absolute
      const legacyRefs = stateRef.current.aiPanel.refs.filter(
        (ref) => !(ref.kind === 'file' && ref.source_id === absolute)
      )
      if (legacyRefs.length !== stateRef.current.aiPanel.refs.length) {
        const selection = await persistAssistantContext({ refs: legacyRefs })
        if (!selection) return
      }
      const sessionId = activeThread(stateRef.current).sessionId
      const registered = sessionId
        ? await registerLocalPaths(sessionId, [absolute])
        : null
      const reference = registered?.[0]
      if (sessionId && (!reference || activeThread(stateRef.current).sessionId !== sessionId)) {
        setState((value) => ({ ...value, aiPanel: { ...value.aiPanel, contextError: { key: 'contextErrors.sourceUnavailable' } } }))
        return
      }
      const title = document.source.path.split(/[\\/]/).filter(Boolean).at(-1)
        || reference?.name
        || document.source.path
      const referenceId = reference?.reference_id
      setState((value) => ({
        ...value,
        composerRefs: value.composerRefs.some(
          (item) => item.type === 'file' && item.path === absolute
        )
          ? value.composerRefs
          : [
              ...value.composerRefs,
              {
                type: 'file',
                id: referenceId ?? absolute,
                ...(referenceId
                  ? { referenceId }
                  : { registrationRequired: true }),
                ...(document.source.kind === 'literature'
                  ? { previewSource: document.source }
                  : {}),
                path: reference?.path || absolute,
                title,
                mediaType: reference?.media_type || (
                  document.source.kind === 'literature'
                    ? document.source.mediaType
                    : undefined
                ),
                size: reference?.size
              }
            ],
        aiPanel: { ...value.aiPanel, open: true, contextError: null }
      }))
    },
    openAiContextPicker: (source, query = '', filter = 'all') => {
      const snapshot = stateRef.current
      const { projectId: project, projectPath } = assistantProject(snapshot)
      const contribution = assistantSources.find((item) => item.id === source)
      if (!contribution || !assistantSourceAvailable(contribution, project)) {
        setState((current) => ({
          ...current,
          aiPanel: {
            ...current.aiPanel,
            contextPickerOpen: false,
            contextCandidates: [],
            contextCandidatesLoading: false
          }
        }))
        return
      }
      const requestSeq = assistantContextCandidateSeq.current + 1
      assistantContextCandidateSeq.current = requestSeq
      setState((current) => ({
        ...current,
        aiPanel: beginContextCandidateLoad(current.aiPanel, source)
      }))
      const unavailable = (kind: ContextRefKind): string | undefined => {
        const capability = snapshot.aiPanel.capabilities.find((item) => item.name === kind)
        if (capability?.available) return undefined
        // 新对话还没有 activeSession 时，capabilities 本来就还没拉回来（它跟着
        // 当前会话的 selection 一起加载），此时任何 kind（包括 session）都不能
        // 因为查不到能力就判不可用——引用会先本地暂存，真正建会话时再由服务端把关。
        if (!snapshot.activeSession) return undefined
        return capability?.reason || ASSISTANT_CONTEXT_FAILURE.SOURCE_UNAVAILABLE
      }
      const load = async (): Promise<AssistantContextCandidate[]> => {
        if (projectPath && !project) throw new Error(ASSISTANT_CONTEXT_FAILURE.PROJECT_LOADING)
        const result = await contribution.search({
          projectId: project,
          projectPath,
          activeSessionId: snapshot.activeSession,
          query,
          filter
        })
        const candidates = result.items.map((item) => {
          const openedAt = item.opened_at ?? (
            item.kind === 'literature'
              ? snapshot.recentLiterature.find((entry) => entry.id === item.source_id)?.openedAt
              : item.kind === 'session'
                ? snapshot.recentSessions.find((entry) => entry.id === item.source_id)?.openedAt
                : (item.kind === 'file' || item.kind === 'dir') && project
                  ? snapshot.recentFiles.find((entry) => entry.projectId === project && entry.path === item.source_id)?.openedAt
                  : undefined
          )
          return {
            ...item,
            ...(openedAt !== undefined ? { opened_at: openedAt } : {}),
            unavailable_reason: item.unavailable_reason || unavailable(item.kind)
          }
        })
        return filterAssistantContextCandidates(candidates, filter)
      }
      void load().then((candidates) => {
        if (assistantContextCandidateSeq.current !== requestSeq) return
        setState((current) => ({
          ...current,
          aiPanel: {
            ...current.aiPanel,
            contextCandidates: current.aiPanel.contextPickerSource === source
              ? candidates
              : current.aiPanel.contextCandidates,
            contextCandidatesLoading: false
          }
        }))
      }).catch((error: unknown) => {
        if (assistantContextCandidateSeq.current !== requestSeq) return
        setState((current) => ({ ...current, aiPanel: { ...current.aiPanel, contextCandidatesLoading: false, contextError: error instanceof Error ? assistantContextFailure(error.message) : { key: 'contextErrors.loadFailed' } } }))
      })
    },
    closeAiContextPicker: () => {
      assistantContextCandidateSeq.current += 1
      setState((current) => ({
        ...current,
        aiPanel: {
          ...current.aiPanel,
          contextPickerOpen: false,
          contextCandidates: [],
          contextCandidatesLoading: false
        }
      }))
    },
    addAiContextRef: async ({ kind, sourceId, label }) => {
      await actRef.current.addContext({
        kind,
        source_id: sourceId,
        label,
        retention: 'session',
        origin: 'explicit'
      })
    },
    addContext: (candidate) => {
      const pending = assistantContextMutationQueue.current.then(() =>
        actRef.current.addContexts([candidate])
      )
      assistantContextMutationQueue.current = pending.then(
        () => undefined,
        () => undefined
      )
      return pending
    },
    addContexts: async (candidates) => {
      const current = stateRef.current
      const admitted: AssistantContextCandidate[] = []
      const rejected: AssistantContextMutationResult['rejected'] = []
      for (const candidate of candidates) {
        const capability = current.aiPanel.capabilities.find(
          (item) => item.name === candidate.kind
        )
        // 没有 activeSession 时 capabilities 还没拉回来，此时任何 kind 都不能
        // 拿「查不到能力」当「不可用」；与上面 openAiContextPicker 的判定保持一致。
        const unavailableReason = candidate.unavailable_reason
          || (current.activeSession && !capability?.available
            ? capability?.reason || ASSISTANT_CONTEXT_FAILURE.SOURCE_PENDING
            : '')
        if (unavailableReason) {
          rejected.push({
            source_id: candidate.source_id,
            code: 'capability_unavailable',
            message: unavailableReason
          })
          continue
        }
        admitted.push(candidate)
      }
      const generatedRefIds = new Map<AssistantContextCandidate, string>()
      const createRefId = (candidate: AssistantContextCandidate): string => {
        const existing = generatedRefIds.get(candidate)
        if (existing) return existing
        const refId = crypto.randomUUID()
        generatedRefIds.set(candidate, refId)
        return refId
      }
      let application = mergeContextCandidates(
        current.aiPanel.refs,
        admitted,
        current.aiPanel.submittedRefIds,
        createRefId
      )
      let selection: AssistantContextSelection | null = null
      let saved = !application.changed
      if (application.changed && !current.activeSession) {
        selection = await persistAssistantContext({ refs: application.refs })
        saved = Boolean(selection)
      } else if (application.changed && current.activeSession) {
        const sessionId = current.activeSession
        if (current.aiPanel.sessionId === sessionId && current.aiPanel.contextState === 'ready') {
          setState((value) => ({
            ...value,
            aiPanel: { ...value.aiPanel, contextState: 'saving', contextError: null }
          }))
          let base: AssistantContextSelection = {
            session_id: sessionId,
            revision: current.aiPanel.revision,
            project_policy: current.aiPanel.projectPolicy,
            search_scope: current.aiPanel.searchScope,
            refs: current.aiPanel.refs,
            updated_at: Date.now() / 1000,
            capabilities: current.aiPanel.capabilities
          }
          for (let attempt = 0; attempt < ASSISTANT_CONTEXT_ADD_ATTEMPTS; attempt += 1) {
            if (stateRef.current.activeSession !== sessionId) break
            const result = await patchAssistantContext(sessionId, {
              expected_revision: base.revision,
              project_policy: base.project_policy,
              search_scope: base.search_scope,
              refs: application.refs
            })
            selection = result.context ?? result.latest ?? null
            if (result.ok && result.context) {
              saved = true
              break
            }
            if (
              result.error !== ASSISTANT_CONTEXT_REVISION_CONFLICT
              || !result.latest
              || attempt + 1 >= ASSISTANT_CONTEXT_ADD_ATTEMPTS
            ) break
            base = result.latest
            const latest = stateRef.current
            const pending = admitted.filter((candidate) =>
              candidate.origin !== 'current_document'
              || candidate.kind !== 'file'
              || (latest.aiPanel.open && latest.resource.selected === candidate.source_id)
            )
            application = mergeContextCandidates(
              base.refs,
              pending,
              latest.aiPanel.submittedRefIds,
              createRefId
            )
            if (!application.changed) {
              saved = true
              break
            }
          }
          setState((value) => {
            if (value.activeSession !== sessionId) return value
            return {
              ...value,
              aiPanel: {
                ...value.aiPanel,
                ...(selection ? {
                  revision: selection.revision,
                  projectPolicy: selection.project_policy,
                  searchScope: selection.search_scope,
                  refs: selection.refs,
                  capabilities: selection.capabilities
                } : {}),
                contextState: selection ? 'ready' : 'error',
                contextError: saved ? null : { key: 'contextErrors.saveRetry' }
              }
            }
          })
        }
      }
      if (!saved) {
        rejected.push(...admitted.map((candidate) => ({
          source_id: candidate.source_id,
          code: 'context_save_failed',
          message: CONTEXT_SAVE_FAILED
        })))
      }
      setState((value) => {
        if (value.activeSession !== current.activeSession) return value
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            open: true,
            contextPickerOpen: false,
            contextError: rejected.length > 0
              ? rejected[0].code === 'context_save_failed'
                ? { key: 'contextErrors.saveRetry' }
                : assistantContextFailure(rejected[0].message)
              : value.aiPanel.contextError
          }
        }
      })
      return {
        session_id: current.activeSession,
        revision: selection?.revision ?? current.aiPanel.revision,
        accepted_ref_ids: saved ? application.acceptedRefIds : [],
        rejected
      }
    },
    detachAiContext: async (refId) => {
      await persistAssistantContext({
        refs: stateRef.current.aiPanel.refs.filter((ref) => ref.ref_id !== refId)
      })
    },
    createAnswerAnnotation: async (answerId, input) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      if (!sessionId || current.aiPanel.sessionId !== sessionId) {
        return { ok: false, error: 'assistant_session_unavailable' }
      }
      const result = await requestAnswerAnnotation(sessionId, answerId, {
        ...input,
        expected_context_revision: current.aiPanel.revision
      })
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const selection = result.context ?? result.latest
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            annotations: result.annotation
              ? [
                ...value.aiPanel.annotations.filter(annotation => annotation.annotation_id !== result.annotation!.annotation_id),
                result.annotation
              ]
              : value.aiPanel.annotations,
            contextError: result.ok ? null : value.aiPanel.contextError
          }
        }
      })
      return { ok: result.ok, annotation: result.annotation, ...(result.error ? { error: result.error } : {}) }
    },
    updateAnswerAnnotation: async (annotationId, comment) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      const annotation = current.aiPanel.annotations.find(
        (item) => item.annotation_id === annotationId
      )
      if (!sessionId || current.aiPanel.sessionId !== sessionId || !annotation) return false
      const result = await requestUpdateAnswerAnnotation(sessionId, annotationId, {
        expected_annotation_revision: annotation.revision,
        expected_context_revision: current.aiPanel.revision,
        comment
      })
      if (!result.ok) showAnswerAnnotationMutationFailure(result)
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const selection = result.context ?? result.latest
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            annotations: result.annotation || result.latestAnnotation
              ? value.aiPanel.annotations.map((item) => (
                item.annotation_id === annotationId
                  ? (result.annotation ?? result.latestAnnotation)!
                  : item
              ))
              : value.aiPanel.annotations,
            contextError: null
          }
        }
      })
      return result.ok
    },
    deleteAnswerAnnotation: async (annotationId) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      const annotation = current.aiPanel.annotations.find(
        (item) => item.annotation_id === annotationId
      )
      if (!sessionId || current.aiPanel.sessionId !== sessionId || !annotation) return false
      const result = await requestDeleteAnswerAnnotation(
        sessionId,
        annotationId,
        annotation.revision,
        current.aiPanel.revision
      )
      if (!result.ok) showAnswerAnnotationMutationFailure(result)
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const selection = result.context ?? result.latest
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            annotations: result.ok
              ? value.aiPanel.annotations.filter((item) => item.annotation_id !== annotationId)
              : result.latestAnnotation
                ? value.aiPanel.annotations.map((item) => (
                  item.annotation_id === annotationId ? result.latestAnnotation! : item
                ))
                : value.aiPanel.annotations,
            answerAnnotationFocus: result.ok
              && value.aiPanel.answerAnnotationFocus?.annotationId === annotationId
              ? null
              : value.aiPanel.answerAnnotationFocus,
            contextError: null
          }
        }
      })
      return result.ok
    },
    deleteAnswerAnnotations: async (annotationIds) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      if (!sessionId || current.aiPanel.sessionId !== sessionId) return false
      const requestedIds = new Set(annotationIds)
      const annotations = current.aiPanel.annotations.filter(
        (item) => requestedIds.has(item.annotation_id)
      )
      if (annotations.length === 0) return true
      const result = await requestDeleteAnswerAnnotations(sessionId, {
        expected_context_revision: current.aiPanel.revision,
        annotations: annotations.map((annotation) => ({
          annotation_id: annotation.annotation_id,
          expected_annotation_revision: annotation.revision
        }))
      })
      if (!result.ok) showAnswerAnnotationMutationFailure(result)
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const selection = result.context ?? result.latest
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            annotations: result.ok
              ? value.aiPanel.annotations.filter((item) => !requestedIds.has(item.annotation_id))
              : value.aiPanel.annotations,
            answerAnnotationFocus: result.ok
              && value.aiPanel.answerAnnotationFocus
              && requestedIds.has(value.aiPanel.answerAnnotationFocus.annotationId)
              ? null
              : value.aiPanel.answerAnnotationFocus,
            contextError: null
          }
        }
      })
      return result.ok
    },
    focusAnswerAnnotation: async (annotationId) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      if (!sessionId || current.aiPanel.sessionId !== sessionId) return
      const annotation = current.aiPanel.annotations.find(
        (item) => item.annotation_id === annotationId
      ) ?? null
      const target = await locateAnswerAnnotation(annotation, activeThread(current).conversation)
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const previousSequence = value.aiPanel.answerAnnotationFocus?.sequence ?? 0
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            answerAnnotationFocus: {
              annotationId,
              answerId: annotation?.answer_id ?? '',
              sequence: previousSequence + 1,
              status: target.status
            }
          }
        }
      })
    },
    clearAnswerAnnotationFocus: (sequence) => setState((current) => ({
      ...current,
      aiPanel: {
        ...current.aiPanel,
        answerAnnotationFocus: current.aiPanel.answerAnnotationFocus?.sequence === sequence
          ? null
          : current.aiPanel.answerAnnotationFocus
      }
    })),
    detachAnswerAnnotation: async (annotationId) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      if (!sessionId || current.aiPanel.sessionId !== sessionId) return
      const result = await requestRemoveAnswerAnnotationContext(
        sessionId,
        annotationId,
        current.aiPanel.revision
      )
      if (!result.ok) showAnswerAnnotationRemoveFailure(result)
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        const selection = result.context ?? result.latest
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            contextError: null
          }
        }
      })
    },
    detachAnswerAnnotations: async (annotationIds) => {
      const current = stateRef.current
      const sessionId = current.activeSession
      if (!sessionId || current.aiPanel.sessionId !== sessionId || annotationIds.length === 0) return
      let revision = current.aiPanel.revision
      let selection: AssistantContextSelection | null = null
      for (const annotationId of annotationIds) {
        const result = await requestRemoveAnswerAnnotationContext(sessionId, annotationId, revision)
        const next = result.context ?? result.latest
        if (next) {
          selection = next
          revision = next.revision
        }
        if (!result.ok) {
          showAnswerAnnotationRemoveFailure(result)
          break
        }
      }
      setState((value) => {
        if (value.activeSession !== sessionId) return value
        return {
          ...value,
          aiPanel: {
            ...value.aiPanel,
            ...(selection ? {
              revision: selection.revision,
              projectPolicy: selection.project_policy,
              searchScope: selection.search_scope,
              refs: selection.refs,
              capabilities: selection.capabilities
            } : {}),
            contextError: null
          }
        }
      })
    },
    startPanelDraft: (seed = {}) => setState((current) => {
      rememberScopeConversation(current)
      const scopeKey = seed.projectId ?? currentScopeKey(current)
      if (scopeKey) {
        const storage = window.localStorage
        const record = readContinuityRecord(storage)
        const next = rememberContinuity(record, scopeKey, null)
        if (next !== record) writeContinuityRecord(storage, next)
      }
      return {
        ...current,
        ...COMPOSER_RESET,
        activeSession: null,
        turnLaunch: null,
        mainView: assistantSessionView(current),
        homeSelectedProjectId: seed.projectId ?? current.homeSelectedProjectId,
        homeProjectLocked: Boolean(seed.projectLocked && seed.projectId),
        composerText: seed.composerText ?? '',
        composerRefs: seed.composerRefs ?? [],
        aiPanel: { ...current.aiPanel, open: true, sessionMenuOpen: false }
      }
    }),
    activateTab: (id, options) => {
      const current = stateRef.current
      const projectId = current.homeSelectedProjectId ?? assistantProject(current).projectId
      const workspace = documentWorkspaces.forProject(projectId)
      const documents = workspace.getSnapshot()
      const documentTab = documents.tabs[id]
      const session = documentTab ? documents.sessions[documentTab.sessionId] : undefined
      if (documentTab && session) {
        if (options?.returnToExpandedAssistantOnClose && current.aiPanel.cover && !expandedAssistantReturns.current.has(id)) {
          const unsubscribe = workspace.subscribe(() => {
            if (workspace.getSnapshot().tabs[id]) return
            unsubscribe()
            expandedAssistantReturns.current.delete(id)
            setState((latest) => latest.activeTab === id && latest.aiPanel.open
              ? { ...latest, aiPanel: { ...latest.aiPanel, cover: true } }
              : latest)
          })
          expandedAssistantReturns.current.set(id, unsubscribe)
        }
        const navigationView = mainViewForDocumentSource(session.source, current.mainView)
        workspace.setTabNavigationView(id, navigationView)
        workspace.focusTab(id)
        setState((latest) => ({
          ...latest,
          activeTab: id,
          mainView: navigationView,
          aiPanel: { ...latest.aiPanel, cover: false }
        }))
        return
      }
      setState((current) => {
        const tab = current.tabs.find((entry) => entry.id === id)
        const mainView = mainViewForWorkbenchTab(tab)
        // A fullscreen (cover) assistant hides the main column that shows this tab.
        return {
          ...current,
          activeTab: id,
          workbenchReturnProjectId: id === current.activeTab ? current.workbenchReturnProjectId : null,
          ...(mainView
            ? { mainView, aiPanel: { ...current.aiPanel, cover: false } }
            : {}),
          ...(tab?.kind === 'literature_search'
            ? {
              homeSelectedProjectId: tab.projectId ?? null,
              homeProjectLocked: false
            }
            : mainView === 'literature'
              ? { homeProjectLocked: false }
              : {})
        }
      })
    },
    openVersionDiff: (reference) => setState((current) => {
      const tab = versionDiffTab(reference)
      return {
        ...current,
        mainView: 'resource',
        tabs: openVersionDiffTab(current.tabs, reference),
        activeTab: tab.id
      }
    }),
    openLiteratureResult: (result) => setState((current) => {
      const tab = literatureResultTab(result)
      return {
        ...current,
        homeSelectedProjectId: null,
        workbenchReturnProjectId: null,
        homeProjectLocked: false,
        mainView: 'literature',
        tabs: openFixedTab(current.tabs, tab),
        activeTab: tab.id,
        // A fullscreen (cover) assistant hides the main column that shows this tab.
        aiPanel: { ...current.aiPanel, cover: false }
      }
    }),
    openLiteratureSearch: (task) => setState((current) => {
      const tab = literatureSearchTab(
        task.id,
        task.query,
        current.homeSelectedProjectId
      )
      return {
        ...current,
        homeProjectLocked: false,
        workbenchReturnProjectId: null,
        mainView: 'literature',
        tabs: openLiteratureSearchTabs(current.tabs, [
          { ...task, projectId: current.homeSelectedProjectId }
        ]),
        activeTab: tab.id,
        // A fullscreen (cover) assistant hides the main column that shows this tab.
        aiPanel: { ...current.aiPanel, cover: false }
      }
    }),
    restoreLiteratureSearches: (tasks) => setState((current) => ({
      ...current,
      tabs: openLiteratureSearchTabs(
        current.tabs,
        [...tasks].sort((left, right) => left.created_at - right.created_at)
      )
    })),

    // ----- 文献库真实操作 -----
    // 筛选/排序持久在 state，每次变更都重拉 —— 后端是筛选真源，
    // 前端不再筛一遍，避免与「共 M 条」计数打架。
    //
    // `override` 是必需的：setState 是异步批处理，先 setState 再立即调本函数时，
    // stateRef 还是旧值，会把旧的 sort/筛选参数发给后端（表现为「点了排序没反应」）。
    // 因此调用方把本次变更的字段显式传进来，不依赖 ref 的时序。
    reloadLiterature: async (override) => {
      const { literature: current, homeSelectedProjectId } = stateRef.current
      const literature = { ...current, ...(override ?? {}) }
      // 请求代次: 并发的两次重拉会「后发先至」, 旧参数的响应把新参数的结果盖掉
      // (表现为「点了排序没反应」)。文件事件驱动的刷新与用户点击天然会并发,
      // 所以这里按代次丢弃过期响应, 而不是指望调用方排队。
      literatureReloadSeq.current += 1
      const generation = literatureReloadSeq.current
      setState((state) => ({
        ...state,
        literature: { ...state.literature, loadState: 'loading' }
      }))
      const scope = literature.scope
      const view = await fetchLiterature(
        {
          search: literature.searchText.trim(),
          tag: scope.kind === 'tag' ? scope.name : undefined,
          collection: scope.kind === 'collection' ? scope.name : undefined,
          recent: scope.kind === 'recent',
          pdf: literature.pdfFilter,
          sort: literature.sort,
          desc: literature.sortDesc
        },
        homeSelectedProjectId
      )
      if (generation !== literatureReloadSeq.current) return
      setState((current) => {
        if (!view) {
          return {
            ...current,
            literature: { ...current.literature, loadState: 'error' }
          }
        }
        return {
          ...current,
          literature: {
            ...current.literature,
            items: view.items,
            total: view.total,
            recentTotal: view.recentTotal,
            collections: view.collections,
            tags: view.tags,
            years: view.years,
            fulltextCounts: view.fulltextCounts,
            loadState: 'ready'
          }
        }
      })
    },
    noticeLiterature: (tone, text) => setState((current) => ({
      ...current,
      literature: { ...current.literature, notice: { tone, text } }
    })),
    patchLiterature: (patch) => setState((current) => ({
      ...current,
      literature: { ...current.literature, ...patch }
    })),
    setLiteratureScope: (scope) => {
      setState((current) => ({
        ...current,
        // 换分组清空勾选：批量操作不应误伤看不见的条目。
        literature: { ...current.literature, scope, selected: {}, detailId: null }
      }))
      void actRef.current.reloadLiterature({ scope })
    },
    setLiteratureQuery: (patch) => {
      setState((current) => ({
        ...current,
        literature: { ...current.literature, ...patch }
      }))
      void actRef.current.reloadLiterature(patch)
    },
    toggleLiteratureSort: (key) => {
      // 再点同一列回退默认「最近添加」（对齐原型 toggleLibSort），
      // 而不是在升/降之间死循环 —— 用户需要一个能回到默认视图的出口。
      const literature = stateRef.current.literature
      const patch: Partial<LiteratureState> =
        literature.sort === key
          ? { sort: 'added', sortDesc: false }
          : { sort: key, sortDesc: false }
      setState((current) => ({ ...current, literature: { ...current.literature, ...patch } }))
      void actRef.current.reloadLiterature(patch)
    },
    startCollectionDraft: (mode, target) =>
      setState((current) => ({
        ...current,
        literature: {
          ...current.literature,
          // 新建子分类时先展开分类组，否则输入框会落在折叠区里看不见。
          collectionsOpen: true,
          collectionDraft: { mode, target, value: mode === 'rename' ? target : '' }
        }
      })),
    patchCollectionDraft: (value) =>
      setState((current) => ({
        ...current,
        literature: {
          ...current.literature,
          collectionDraft: current.literature.collectionDraft
            ? { ...current.literature.collectionDraft, value }
            : null
        }
      })),
    commitCollectionDraft: async () => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const draft = literature.collectionDraft
      if (!draft) return
      const name = draft.value.trim()
      if (!name) {
        actRef.current.patchLiterature({ collectionDraft: null })
        return
      }
      const result =
        draft.mode === 'rename'
          ? await mutateCollection('rename', draft.target, homeSelectedProjectId, { target: name })
          : await mutateCollection('create', name, homeSelectedProjectId, {
            parent: draft.mode === 'child' ? draft.target : ''
          })
      actRef.current.patchLiterature({ collectionDraft: null })
      if (!result.ok) {
        actRef.current.noticeLiterature('error', collectionError(result.error))
        return
      }
      actRef.current.noticeLiterature('ok', draft.mode === 'rename' ? '已重命名' : `已创建「${name}」`)
      await actRef.current.reloadLiterature()
    },
    deleteLiteratureCollection: async (name) => {
      const { homeSelectedProjectId } = stateRef.current
      const result = await mutateCollection('delete', name, homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature('error', collectionError(result.error))
        return
      }
      // 删的是分类而非文献，文案说清楚避免用户以为题录也没了。
      actRef.current.noticeLiterature('ok', `已删除分类「${name}」，其中文献仍保留在文献库`)
      const scope = stateRef.current.literature.scope
      if (scope.kind === 'collection' && scope.name === name) {
        actRef.current.setLiteratureScope({ kind: 'all' })
        return
      }
      await actRef.current.reloadLiterature()
    },
    openCollectionMenu: (name, x, y) =>
      setState((current) => ({
        ...current,
        literature: { ...current.literature, rowMenu: { id: `col:${name}`, x, y } }
      })),
    openLiteratureRowMenu: (id, x, y) =>
      setState((current) => ({
        ...current,
        literature: { ...current.literature, rowMenu: { id, x, y } }
      })),
    moveLiteratureToCollection: async (name) => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const ids = Object.keys(literature.selected)
      if (!ids.length) {
        actRef.current.noticeLiterature('error', '先勾选要放入分类的文献')
        return
      }
      const result = await batchLiterature('set_collection', ids, '', homeSelectedProjectId, name)
      actRef.current.patchLiterature({ collectionPickerOpen: false })
      if (!result.ok) {
        actRef.current.noticeLiterature('error', collectionError(result.error))
        return
      }
      actRef.current.noticeLiterature('ok', `${ids.length} 篇已移入「${name}」`)
      await actRef.current.reloadLiterature()
    },
    exportLiteratureBibtex: async () => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const ids = Object.keys(literature.selected)
      if (!ids.length) {
        actRef.current.noticeLiterature('error', '先勾选要导出的文献')
        return
      }
      const result = await exportBibtex(ids, homeSelectedProjectId)
      if (!result.ok || !result.bibtex) {
        actRef.current.noticeLiterature('error', '导出失败')
        return
      }
      // 写入系统剪贴板而不自行落盘：存到哪里由用户定，产品自作主张写文件只会弄脏项目目录。
      const native = window.scholarseed?.writeClipboard
      if (native) {
        const done = await native(result.bibtex)
        actRef.current.noticeLiterature(
          done.ok ? 'ok' : 'error',
          done.ok ? `已复制 ${result.count} 条 BibTeX 到剪贴板` : '剪贴板不可用'
        )
        return
      }
      try {
        await navigator.clipboard.writeText(result.bibtex)
        actRef.current.noticeLiterature('ok', `已复制 ${result.count} 条 BibTeX 到剪贴板`)
      } catch {
        actRef.current.noticeLiterature('error', '剪贴板不可用')
      }
    },
    addLiteratureNote: async () => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const id = literature.detailId
      const text = literature.noteDraft.trim()
      if (!id || !text) return
      const result = await mutateNote(id, 'add', { text }, homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature('error', '笔记保存失败')
        return
      }
      actRef.current.patchLiterature({ noteDraft: '' })
      await actRef.current.reloadLiterature()
    },
    removeLiteratureNote: async (noteId) => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const id = literature.detailId
      if (!id) return
      const result = await mutateNote(id, 'remove', { noteId }, homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature('error', '笔记删除失败')
        return
      }
      await actRef.current.reloadLiterature()
    },
    openLiteratureAttachment: async (id, attachmentId, page, options) => {
      // stateRef 在 React 批处理下滞后于 setState；链式调用时用调用方
      // 显式传入的作用域，避免守卫拿旧值误判「项目已切换」而静默返回。
      const current = stateRef.current
      const project = resolveDocumentWorkspaceProject(
        current.homeSelectedProjectId,
        assistantProject(current).projectId,
        options?.projectId
      )
      actRef.current.patchLiterature({ rowMenu: null })
      let detail: LiteratureDetail
      try {
        detail = await getLiterature(id)
      } catch {
        actRef.current.noticeLiterature('error', '全文 PDF 当前不可用：metadata_unavailable')
        return
      }
      const attachment = attachmentId
        ? detail.attachments.find((candidate) => candidate.id === attachmentId)
        : detail.primary_attachment
      const latest = stateRef.current
      if (resolveDocumentWorkspaceProject(
        latest.homeSelectedProjectId,
        assistantProject(latest).projectId
      ) !== project) return
      if (!attachment) {
        actRef.current.noticeLiterature('error', '附件当前不可用：attachment_unavailable')
        return
      }
      const attachmentTitle = resourceNameParts(attachment.name, 'file').basename
      // 业务标签优先于 DocumentDock 渲染；先退出文献列表标签，避免 PDF 会话
      // 已加载却被列表遮住。项目总览只是 Shell 的非业务占位，DocumentDock
      // 检测到打开的文档后会立即接管中央区。
      setState((current) => ({ ...current, activeTab: OVERVIEW_TAB.id }))
      // 附件统一由 Workbench 打开；文献域只附带稳定的条目/附件身份。
      // PDF 选区组件会使用该身份，图片和不支持格式则由各自 viewer 处理。
      const workspace = documentWorkspaces.forProject(project)
      try {
        const tabId = await workspace.open({
          kind: 'literature',
          literatureId: id,
          attachmentId: attachment.id,
          recordTarget: attachment.record_target,
          path: attachment.name,
          mediaType: attachment.media_type
        }, 'edit', attachmentTitle)
        const latest = stateRef.current
        if (resolveDocumentWorkspaceProject(
          latest.homeSelectedProjectId,
          assistantProject(latest).projectId
        ) !== project) return
        setState((current) => ({ ...current, activeTab: tabId }))
        const tab = workspace.getSnapshot().tabs[tabId]
        workspace.setTabViewState(tabId, {
          ...tab?.viewState,
          ...(page ? { page } : {}),
          [LITERATURE_EXCERPT_VIEW_STATE_KEY]: {
            kind: LITERATURE_EXCERPT_SOURCE_KIND,
            literatureId: id,
            title: detail.title
          }
        })
      } catch (error) {
        actRef.current.noticeLiterature('error', literatureText('attachment.openFailed'))
        console.error('[literature] attachment open failed', {
          attachmentId: attachment.id,
          error,
          literatureId: id,
          projectId: project
        })
      }
    },
    closeLiteratureAttachment: (id, attachmentId) => {
      // 标签可能开在别的项目工作区里(文献是全库维度), 交给注册表全量收口。
      documentWorkspaces.closeLiteratureAttachment(id, attachmentId)
    },
    searchLiteratureByAi: () => {
      // AI 语义检索属于学术库对接（后续里程碑）。本期把输入接到列表搜索，
      // 使输入框真实可用；同时明确提示语义检索待实现，不假装已接学术库。
      const text = stateRef.current.literature.aiSearchText.trim()
      if (!text) return
      actRef.current.setLiteratureQuery({ searchText: text })
      actRef.current.noticeLiterature('ok', '已在本地文献库内检索；学术库语义检索待实现')
    },
    toggleLiteratureSelected: (id) => setState((current) => {
      const selected = { ...current.literature.selected }
      if (selected[id]) delete selected[id]
      else selected[id] = true
      return { ...current, literature: { ...current.literature, selected } }
    }),
    toggleLiteratureSelectAll: () => setState((current) => {
      const visible = current.literature.items
      const allPicked = visible.length > 0 && visible.every((item) => current.literature.selected[item.id])
      const selected: Record<string, boolean> = {}
      if (!allPicked) for (const item of visible) selected[item.id] = true
      return { ...current, literature: { ...current.literature, selected } }
    }),
    runLiteratureBatch: async (action) => {
      const { literature, homeSelectedProjectId } = stateRef.current
      const ids = Object.keys(literature.selected)
      if (ids.length === 0) {
        actRef.current.noticeLiterature('error', '先勾选要操作的条目。')
        return
      }
      const tag = literature.tagDraft.trim()
      if (action !== 'remove_items' && !tag) {
        actRef.current.noticeLiterature('error', '先填一个标签名。')
        return
      }
      const result = await batchLiterature(action, ids, tag, homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature('error', `批量操作失败：${result.error}`)
        return
      }
      setState((current) => ({
        ...current,
        literature: { ...current.literature, selected: {}, tagDraft: '' }
      }))
      await actRef.current.reloadLiterature()
      const done = action === 'remove_items'
        ? `已移除 ${ids.length} 条`
        : action === 'add_tag'
          ? `已给 ${ids.length} 条打上「${tag}」`
          : `已从 ${ids.length} 条移除「${tag}」`
      actRef.current.noticeLiterature('ok', done)
    },
    importLiteratureFiles: async (source) => {
      const picker = window.scholarseed?.pickImport
      if (!picker) {
        actRef.current.noticeLiterature('error', '桌面端文件选择不可用。')
        return
      }
      setState((current) => ({
        ...current,
        literature: { ...current.literature, importMenuOpen: false }
      }))
      // Zotero 根目录本期未实现，不弹选择器假装可用。
      if (source === 'zotero' || source === 'doi') {
        actRef.current.noticeLiterature(
          'error',
          source === 'zotero' ? 'Zotero 目录导入待实现。' : 'DOI / BibTeX 粘贴导入待实现。'
        )
        return
      }
      const picked = await picker(IMPORT_PICKER_TARGET.FILE)
      if (picked.length === 0) return
      const result = await importLiterature(source, picked, stateRef.current.homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature(
          'error',
          LITERATURE_ERROR_TEXT[result.error ?? ''] ?? `导入失败：${result.error}`
        )
        return
      }
      await actRef.current.reloadLiterature()
      const parts = [`新增 ${result.added ?? 0} 条`]
      if (result.skipped) parts.push(`跳过 ${result.skipped} 条`)
      actRef.current.noticeLiterature('ok', parts.join('，'))
    },
    markResourceAsLiterature: async () => {
      // PRD「资料库标记为文献」: 拿资料树当前选中的文件，走与本地导入同一套抽取。
      const { resource, homeSelectedProjectId } = stateRef.current
      if (!resource.selected) {
        actRef.current.noticeLiterature('error', '先在资料库里选一份文件。')
        return
      }
      const reveal = await resolveRevealTarget(resource.selected, homeSelectedProjectId)
      if (!reveal.ok || !reveal.absolute) {
        actRef.current.noticeLiterature('error', '没取到该资料的真实路径。')
        return
      }
      const result = await importLiterature('resource', [reveal.absolute], homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature(
          'error',
          LITERATURE_ERROR_TEXT[result.error ?? ''] ?? `标记失败：${result.error}`
        )
        return
      }
      await actRef.current.reloadLiterature()
      actRef.current.noticeLiterature('ok', `已从资料库入库 ${result.added ?? 0} 条`)
    },
    openLiteratureItem: async (id, projectId) => {
      const sessionId = stateRef.current.activeSession
      const view = await fetchLiterature({}, projectId)
      if (!view || !view.items.some((item) => item.id === id)) {
        actRef.current.noticeLiterature('error', '这条文献当前不可用，请刷新关联。')
        return
      }
      setState((current) => current.activeSession !== sessionId ? current : ({
        ...current,
        homeSelectedProjectId: projectId,
        mainView: 'literature',
        workbenchReturnProjectId: null,
        modulePanelOpen: true,
        tabs: openFixedTab(current.tabs, LITERATURE_TAB),
        activeTab: LITERATURE_TAB.id,
        recentLiterature: touchRecentLiterature(current.recentLiterature, {
          id,
          openedAt: Date.now()
        }),
        literature: {
          ...INITIAL_LITERATURE_STATE,
          ...view,
          detailId: id,
          loadState: 'ready'
        }
      }))
    },
    markLiteratureFulltext: async (id, status) => {
      const result = await markFulltext(id, status, stateRef.current.homeSelectedProjectId)
      if (!result.ok) {
        actRef.current.noticeLiterature('error', `状态标注失败：${result.error}`)
        return
      }
      await actRef.current.reloadLiterature()
    },
    requestLiteratureFulltext: async (id) => {
      const result = await fetchFulltext(id, stateRef.current.homeSelectedProjectId)
      // 后端本期显式 501；如实告知而不假装下载成功。
      actRef.current.noticeLiterature(
        'error',
        result.error === 'fulltext_fetch_pending'
          ? '全文自动取回待实现（需接 OA 渠道与机构凭证）。可先手动标注状态。'
          : `全文获取失败：${result.error}`
      )
    },
    attachLiteratureToAi: async () => {
      const current = stateRef.current
      const picked = current.literature.items.filter(
        (item) => current.literature.selected[item.id]
      )
      if (picked.length === 0) {
        setState((value) => ({
          ...value,
          literature: {
            ...value.literature,
            notice: { tone: 'error', text: '先勾选要作为上下文的文献。' }
          }
        }))
        return
      }
      await actRef.current.addContexts(
        picked.map((item): AssistantContextCandidate => ({
          kind: 'literature',
          source_id: item.id,
          label: item.title,
          retention: 'session',
          origin: 'explicit'
        }))
      )
    },
    closeWorkbenchTab: (id) => {
      const workbenchTab = stateRef.current.tabs.find((tab) => tab.id === id)
      if (workbenchTab?.kind === 'literature') return
      if (workbenchTab && !workbenchTab.closable) return
      const invocation = webSearchInvocations.current.get(id)
      if (invocation) {
        invocation.abort()
        webSearchInvocations.current.delete(id)
      }
      const literatureTaskId = id.startsWith('literature-search:')
        ? id.slice('literature-search:'.length)
        : null
      if (literatureTaskId) {
        void deleteLiteratureSearch(literatureTaskId).then(() => {
          setState((current) => {
            const next = closeTab(current.tabs, current.activeTab, id, closeTabContext(current))
            const mainView = mainViewForWorkbenchTab(
              next.tabs.find((tab) => tab.id === next.activeId)
            )
            return {
              ...current,
              tabs: next.tabs,
              activeTab: next.activeId,
              ...(mainView ? { mainView } : {})
            }
          })
        }).catch(() => undefined)
        return
      }
      setState((current) => {
        const next = closeTab(current.tabs, current.activeTab, id, closeTabContext(current))
        const mainView = mainViewForWorkbenchTab(
          next.tabs.find((tab) => tab.id === next.activeId)
        )
        const activeTabState = {
          tabs: next.tabs,
          activeTab: next.activeId,
          ...(mainView ? { mainView } : {})
        }
        if (!current.resource.webSearches[id]) {
          return { ...current, ...activeTabState }
        }
        const webSearches = { ...current.resource.webSearches }
        delete webSearches[id]
        return {
          ...current,
          ...activeTabState,
          resource: { ...current.resource, webSearches }
        }
      })
    },
    completeResourceReview: (id, target) => setState((current) => {
      const next = closeTab(current.tabs, current.activeTab, id)
      return {
        ...current,
        homeSelectedProjectId: target.projectId,
        mainView: 'resource',
        tabs: next.tabs,
        activeTab: target.documentTabId ?? OVERVIEW_TAB.id,
        resource: {
          ...current.resource,
          expanded: expandedResourceAncestors(
            current.resource.tree,
            target.path,
            current.resource.expanded
          ),
          selected: target.path
        }
      }
    }),
    startDraft: (seed = {}) => setState((current) => {
      rememberScopeConversation(current)
      // 点「新对话」= 该作用域最后打开的是新对话：目标作用域（seed.projectId）
      // 或全局按钮所在的当前作用域记 null，回访时不恢复旧会话。
      const scopeKey = seed.projectId ?? currentScopeKey(current)
      if (scopeKey) {
        const storage = window.localStorage
        const record = readContinuityRecord(storage)
        const next = rememberContinuity(record, scopeKey, null)
        if (next !== record) writeContinuityRecord(storage, next)
      }
      return {
        ...current,
        ...HOME_RESET,
        mainView: assistantSessionView(current),
        composerText: seed.composerText ?? '',
        composerTaskType: '',
        composerRefs: seed.composerRefs ?? [],
        homeSelectedProjectId: seed.projectId ?? null,
        homeProjectLocked: Boolean(seed.projectLocked && seed.projectId),
        aiPanel: { ...current.aiPanel, open: true, sessionMenuOpen: false }
      }
    }),
    applyModelCatalog: (catalog) => setState((current) => {
      if (!catalog) return current
      const models = catalog.available_models ?? []
      return {
        ...current,
        model: selectableCatalogModelKey(catalog.current_model, models, current.model),
        catalog: {
          ...current.catalog,
          models,
          hiddenModels: catalog.hidden_models ?? [],
          subscriptionGroups: catalog.subscription_groups ?? [],
        }
      }
    }),
    setPersonalProfiles: (personalProfiles) => setState((current) => ({
      ...current,
      catalog: { ...current.catalog, personalProfiles }
    })),
    renameSessionTitle: (id, title, titleFallback = null) => setState((current) => {
      const node = findSessionNode(current.sessions, id)
      const thread = current.threads[id]
      return {
        ...current,
        sessionRename: null,
        sessions: node
          ? upsertSessionNode(current.sessions, { ...node, title, title_fallback: titleFallback })
          : current.sessions,
        threads: thread
          ? { ...current.threads, [id]: { ...thread, title, title_fallback: titleFallback } }
          : current.threads
      }
    })
  }), [assistantSources, literatureText, persistAssistantContext, resourceI18n, revealResourceTreePath, runTranslation, showAnswerAnnotationMutationFailure, showAnswerAnnotationRemoveFailure, switchEditorLanguage, syncResourceContext])

  // 资料库的异步动作会互相调用（例如写完重拉树、失败出提示）。
  // act 本身是 useMemo 对象字面量，在其内部引用自己会抱到未初始化的绑定，
  // 因此用 ref 转一道：所有自引用都发生在用户触发后，此时 ref 已指向完整的 act。
  actRef.current = act

  useEffect(() => {
    let active = true
    listLiteratureSearches()
      .then((tasks) => {
        if (active) act.restoreLiteratureSearches(tasks)
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [act])

  useEffect(() => {
    assistantContextCandidateSeq.current += 1
    if (state.activeSession) {
      setState((current) => ({ ...current, aiPanel: { ...current.aiPanel, contextCandidates: [], contextCandidatesLoading: false, contextPickerOpen: false } }))
      void actRef.current.loadAiContext(state.activeSession)
      return
    }
    setState((current) => ({
      ...current,
      aiPanel: {
        ...current.aiPanel,
        sessionId: null,
        contextState: 'idle',
        revision: 0,
        projectPolicy: 'explicit_only',
        searchScope: 'web',
        refs: [],
        submittedRefIds: [],
        capabilities: [],
        contextPickerOpen: false,
        contextCandidates: [],
        contextCandidatesLoading: false,
        contextError: null
      }
    }))
  }, [state.activeSession, assistantProject(state).projectPath])

  useEffect(() => {
    const pending = pendingResourceFileContext.current
    if (!pending) return
    const projectId = assistantProject(state).projectId
    const stale =
      pending.requestSeq !== resourceFileContextSeq.current
      || pending.sessionId !== state.activeSession
      || pending.projectId !== projectId
      || pending.candidate.source_id !== state.resource.selected
      || !state.aiPanel.open
    if (stale) {
      pendingResourceFileContext.current = null
      return
    }
    if (
      state.aiPanel.sessionId !== pending.sessionId
      || state.aiPanel.contextState !== 'ready'
    ) return
    pendingResourceFileContext.current = null
    void actRef.current.addContext(pending.candidate)
  }, [
    state.activeSession,
    state.aiPanel.contextState,
    state.aiPanel.open,
    state.aiPanel.sessionId,
    state.homeSelectedProjectId,
    state.projects,
    state.resource.selected
  ])

  const value = useMemo(
    () => ({ state, set, closeMenus, act, patchThread, appendThread }),
    [state, set, closeMenus, act, patchThread, appendThread]
  )
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useApp(): Store {
  const value = useContext(StoreContext)
  if (!value) throw new Error('useApp outside StoreProvider')
  return value
}
