import type { ReactNode } from 'react'
import type { DocumentSession } from '../workbench/workspace'
import type { ResourceHistoryTarget } from '../../contracts/workbench'
import type { TaskTitle } from '../../contracts/tasks'
/**
 * 资料库领域状态切片（MVP 0.2）。
 *
 * 归属：资料库负责人。其它 feature 不得 import 本文件的可变状态，
 * 跨域协作只经 store 的 act.* 动作。
 */

import type { ResourceErrorMessage } from './error'
import type { AgentInvocationEvent } from '../../contracts/invocation.ts'
import type {
  ResourceCapability,
  ResourceImportConflict,
  ResourcePending,
  ResourceSearchHit,
} from './api'

/** 导入方式：复制一份到项目 / 关联原文件（PRD「资料导入」双卡片）。 */
export type ImportMode = 'copy' | 'link'

/**
 * 资产归属，与后端 `AssetOrigin` 一一对应。
 *
 * `link` 节点的物理位置在项目外，改名/同根移动作用于原始文件；删除入口只撤销
 * 关联并保留原文件。UI 必须能把它和项目内的副本区分开。
 */
export type AssetOrigin = 'local' | 'link'

export type ResourceManagementState =
  'migration_required' | 'managed' | 'git' | 'ignored' | 'oversized' | 'unsupported' | 'unavailable'

export interface ResourceNodeVersionState {
  managementState: ResourceManagementState
  drifted: boolean
  snapshotState: ResourceCapability['snapshot_state'] | null
  pendingOrigin: ResourcePending['origin'] | null
  manualAdmitted?: boolean
  needsReview: boolean
}

/** 一处 Content 已授权的关联根；节点只持有其所属根的权威投影。 */
export interface ResourceLinkRoot {
  rootId: string
  mountPath: string
  sourcePath: string
}

/** 资料树节点。 */
export interface ResourceNode {
  source?: 'imported' | 'created' | 'linked' | null
  fileType?: string
  updatedAt?: number
  /** 相对项目根的路径，作为稳定标识。 */
  path: string
  name: string
  kind: 'file' | 'dir'
  /** Content-identified repository root; descendants are not marked. */
  gitRepository?: boolean
  /**
   * 该目录条目的**总数**（不是 `children` 的长度）。
   *
   * 与 `children.length` 的差就是「还没投影出来的条目」——不管是后端没扫到那么深，
   * 还是单层只取了前一页。少了这个数，没投影的条目在界面上等于不存在。
   */
  count?: number
  /** 缺省视为 local：老响应没有该字段时不该凭空标成关联。 */
  origin?: AssetOrigin
  /** 关联节点所属的挂载根；local 节点没有该字段。 */
  linkRoot?: ResourceLinkRoot
  /** 版本账本的列表投影；不携带 file_id 等操作能力。 */
  version?: ResourceNodeVersionState
  children?: ResourceNode[]
}

/** 这个目录还有多少条目没加载。0 = 已全部投影（或它不是目录）。 */
export function pendingChildCount(node: ResourceNode): number {
  if (node.kind !== 'dir') return 0
  return Math.max(0, (node.count ?? 0) - (node.children?.length ?? 0))
}

/** 新建入口的两种业务动作。 */
export type ResourceCreateMode = 'create_document' | 'create_folder'

/** Markdown 扩展名由界面固定展示，不进入可编辑主文件名。 */
export const MARKDOWN_SUFFIX = '.md'

/** 与 content 域名称约束一致的本地即时校验。 */
const FORBIDDEN_RESOURCE_NAME_CHARS = new Set(['\\', '/', ':', '\0'])
const RESERVED_RESOURCE_NAMES = new Set(['.', '..'])
const RESOURCE_NAME_SUGGESTION_SEPARATOR = ' '
const RESOURCE_NAME_WHITESPACE_PATTERN = /\s+/gu
export const INVALID_RESOURCE_NAME_MESSAGE = 'operationError.invalid_name' as const
export const RESOURCE_CREATE_NAME_LIMIT = 20

export function resourceCreateNameError(value: string): NameDraftState['error'] {
  return (
    resourceNameError(value) ??
    (value.trim().length > RESOURCE_CREATE_NAME_LIMIT ? 'creation.nameTooLong' : null)
  )
}

export function resourceNameError(value: string): typeof INVALID_RESOURCE_NAME_MESSAGE | null {
  const cleaned = value.trim()
  if (
    !cleaned ||
    RESERVED_RESOURCE_NAMES.has(cleaned) ||
    Array.from(cleaned).some((character) => FORBIDDEN_RESOURCE_NAME_CHARS.has(character))
  ) {
    return INVALID_RESOURCE_NAME_MESSAGE
  }
  return null
}

/** Turn untrusted, generated text into a readable single resource-name suggestion. */
export function resourceNameSuggestion(value: string, fallback: string): string {
  const cleaned = Array.from(value)
    .map((character) =>
      FORBIDDEN_RESOURCE_NAME_CHARS.has(character) ? RESOURCE_NAME_SUGGESTION_SEPARATOR : character
    )
    .join('')
    .replace(RESOURCE_NAME_WHITESPACE_PATTERN, RESOURCE_NAME_SUGGESTION_SEPARATOR)
    .trim()
  return resourceNameError(cleaned) ? fallback : cleaned
}

/** 根据当前选择解析出的新建落点，以及需要二次确认的关联目录。 */
export interface ResourceCreateTarget {
  directory: string
  linkedDirectory: Pick<ResourceNode, 'path' | 'name'> | null
}

const VERSION_POLICY_KEYS = {
  git: 'versionBadge.git',
  migration_required: 'versionBadge.migrationRequired',
  ignored: 'versionBadge.ignored',
  oversized: 'versionBadge.oversized',
  unsupported: 'versionBadge.unsupported',
  unavailable: 'versionBadge.unavailable',
} as const
type VersionBadgeMessage =
  | (typeof VERSION_POLICY_KEYS)[keyof typeof VERSION_POLICY_KEYS]
  | 'versionBadge.manualAdmitted'
  | 'versionBadge.drifted'

export interface ResourceVersionBadge {
  label: VersionBadgeMessage
  description: VersionBadgeMessage[]
  tone: 'neutral' | 'warning'
}

/** 资料树只暴露版本策略异常，不展示已保存/待保存账本状态。 */
export function resourceVersionBadge(node: ResourceNode): ResourceVersionBadge | null {
  if (node.kind !== 'file' || !node.version || node.version.managementState === 'git') return null
  const version = node.version
  const policy =
    version.managementState === 'managed' ? null : VERSION_POLICY_KEYS[version.managementState]
  const label = policy ?? (version.drifted ? 'versionBadge.drifted' : null)
  if (!label) return null
  const description: VersionBadgeMessage[] = [label]
  if (version.manualAdmitted) description.push('versionBadge.manualAdmitted')
  if (version.drifted && label !== 'versionBadge.drifted') description.push('versionBadge.drifted')
  return {
    label,
    description,
    tone: version.needsReview || version.drifted ? 'warning' : 'neutral',
  }
}

/** 按路径找节点；找不到返回 null。 */
export function findResourceNode(nodes: ResourceNode[], path: string): ResourceNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const hit = node.children ? findResourceNode(node.children, path) : null
    if (hit) return hit
  }
  return null
}

/**
 * 把刚由服务端确认的新节点补进当前分页投影。
 *
 * 整树重拉只返回每层第一页；新文件按名称排序后可能在第 100 条之后。仅设置
 * `selected` 会得到一个树里不存在的选择，无法满足“定位并选中”。这里以服务端
 * 返回的稳定 path 去重后补入可见父目录，不改变其余节点引用。
 */
export function withCreatedResource(
  nodes: ResourceNode[],
  parent: string,
  created: ResourceNode
): ResourceNode[] {
  if (findResourceNode(nodes, created.path)) return nodes
  if (!parent) return [created, ...nodes]

  let changed = false
  const next = nodes.map((node) => {
    if (node.path === parent && node.kind === 'dir') {
      const children = [created, ...(node.children ?? [])]
      changed = true
      return {
        ...node,
        children,
        count: Math.max(node.count ?? 0, children.length),
      }
    }
    if (!node.children?.length) return node
    const children = withCreatedResource(node.children, parent, created)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : nodes
}

/** 从 directory 一路向上找最靠近根的 link 目录；新建落点在关联目录内时必须先确认。 */
function linkedDirectoryAbove(
  nodes: ResourceNode[],
  directory: string
): ResourceCreateTarget['linkedDirectory'] {
  const parentOf = (path: string): string => {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? '' : path.slice(0, slash)
  }
  let candidate = directory
  let linkedDirectory: ResourceCreateTarget['linkedDirectory'] = null
  while (candidate) {
    const node = findResourceNode(nodes, candidate)
    if (node?.kind === 'dir' && node.origin === 'link') {
      // 子节点也可能继承 link 标记；继续向上找，弹窗展示关联入口而非深层目录。
      linkedDirectory = { path: node.path, name: node.name }
    }
    candidate = parentOf(candidate)
  }
  return linkedDirectory
}

/**
 * 像 VS Code 一样决定新建落点：选中目录时建在目录内，选中文件时建在同级，
 * 未选中时建在资料库根目录。关联目录指向项目外部，成为落点前必须让用户确认。
 */
export function resolveResourceCreateTarget(
  nodes: ResourceNode[],
  selected: string | null
): ResourceCreateTarget {
  if (!selected) return { directory: '', linkedDirectory: null }

  const selectedNode = findResourceNode(nodes, selected)
  if (!selectedNode) return { directory: '', linkedDirectory: null }

  const parentOf = (path: string): string => {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? '' : path.slice(0, slash)
  }
  const directory = selectedNode.kind === 'dir' ? selectedNode.path : parentOf(selectedNode.path)
  if (!directory) return { directory: '', linkedDirectory: null }

  // managed 项目的逻辑根不会作为树节点重复渲染。选中根目录内的文件时，
  // 它的物理父路径不在树中，就地输入框必须回到可见的资料树根。
  const directoryNode = findResourceNode(nodes, directory)
  if (directoryNode?.kind !== 'dir') return { directory: '', linkedDirectory: null }

  return { directory, linkedDirectory: linkedDirectoryAbove(nodes, directory) }
}

/**
 * 显式指定新建落点（目录行的「+」入口）。directory 必须是树里可见的目录，
 * 与按选择推导的 resolveResourceCreateTarget 共用关联目录确认逻辑。
 */
export function resolveResourceCreateTargetAt(
  nodes: ResourceNode[],
  directory: string
): ResourceCreateTarget {
  const directoryNode = findResourceNode(nodes, directory)
  if (directoryNode?.kind !== 'dir') return { directory: '', linkedDirectory: null }
  return { directory, linkedDirectory: linkedDirectoryAbove(nodes, directory) }
}

/**
 * 把某个目录的子节点填进树（不可变更新）。
 *
 * `append` 用于取同一层的下一页——替换会把已经看到的条目抹掉。`total` 用服务端
 * 本次回的值刷新：磁盘随时在变，沿用旧总数会让「还剩几条」一直不准。
 *
 * 只重建命中路径上的节点，其余保持同一引用 —— 否则每次展开或翻页都会让整棵树
 * 的所有行重新渲染。
 */
export function withResourceChildren(
  nodes: ResourceNode[],
  path: string,
  children: ResourceNode[],
  total: number,
  mode: 'replace' | 'append' = 'replace'
): ResourceNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      const merged = mode === 'append' ? [...(node.children ?? []), ...children] : children
      return { ...node, children: merged, count: total || undefined }
    }
    if (!node.children?.length || !path.startsWith(`${node.path}/`)) return node
    return { ...node, children: withResourceChildren(node.children, path, children, total, mode) }
  })
}

/** 导入弹窗状态；null = 关闭。 */
export type ImportDialogState =
  | {
      phase: 'select'
      /** 落地目录（相对项目根），空串表示项目根。 */
      targetDir: string
    }
  | {
      phase: 'resolve'
      targetDir: string
      sources: string[]
      planToken: string
      conflicts: ResourceImportConflict[]
      idempotencyKey: string
    }

/** 树上的右键菜单（PRD「资料管理」）；null = 关闭。 */
export interface NodeMenuState {
  version?: ResourceNodeVersionState
  anchor?: { bottom: number; left: number; right: number; top: number; width: number }
  path: string
  name: string
  kind: 'file' | 'dir'
  origin?: AssetOrigin
  linkRoot?: ResourceLinkRoot
  /** 菜单弹出位置（视口坐标）。 */
  x: number
  y: number
}

/** 重命名 / 新建的就地输入态；null = 无。 */
export interface NameDraftState {
  /** rename 时为目标路径；create 时为父目录路径。 */
  target: string
  mode: 'rename' | ResourceCreateMode
  value: string
  /** rename 时不可编辑的原文件后缀；新建 Markdown 时为 `.md`。 */
  suffix: string
  error: ResourceErrorMessage['key'] | 'creation.nameTooLong' | null
  submitting: boolean
}

/** Toast 反馈中的资料打开目标；只保存可序列化数据，不把闭包函数塞进状态。 */
export interface ResourceNoticeOpenTarget {
  path: string
  projectId?: string | null
}

/** Toast 反馈可携带一次真实的新建重试或资料打开入口。 */
export type ResourceNoticeMessage =
  | ResourceErrorMessage
  | {
      namespace: 'tasks'
      key: 'feedback.completed' | 'feedback.cancelled' | 'feedback.incomplete'
      name: TaskTitle
      errorContent?: ReactNode
      detail?: string
      openTaskCenter?: boolean
    }
  | {
      key: 'feedback.savedDestination'
      name: string
      destination: string
      detail?: string
    }
  | {
      key:
        | 'localImport.pickerUnavailable'
        | 'localImport.dropPathError'
        | 'panel.invalidDrop'
        | 'panel.loadFailed'
        | 'feedback.revealDesktopUnavailable'
        | 'feedback.cannotOpenSearch'
        | 'feedback.renameDirty'
        | 'feedback.nameCopied'
        | 'feedback.clipboardUnavailable'
        | 'feedback.locationUnavailable'
        | 'feedback.pathUnavailable'
        | 'feedback.pathCopied'
        | 'feedback.deleteDirty'
        | 'feedback.trashUnavailable'
        | 'feedback.unlinkDirty'
        | 'feedback.moveDirty'
        | 'feedback.movePathMissing'
        | 'feedback.alreadyAtRoot'
        | 'feedback.importChanged'
        | 'feedback.clipboardFailed'
        | 'feedback.revealFailed'
        | 'feedback.trashFailed'
        | 'feedback.unlinkFailed'
        | 'feedback.importQueued'
        | 'feedback.linkQueued'
        | 'feedback.createUncertain'
        | 'feedback.linkedCreateFailed'
        | 'feedback.openBeforeContext'
      detail?: string
    }
  | {
      key:
        | 'feedback.versionAdmitted'
        | 'feedback.savedResource'
        | 'feedback.created'
        | 'feedback.copied'
        | 'feedback.renamed'
        | 'feedback.renamedSyncFailed'
        | 'feedback.moved'
        | 'feedback.movedSyncFailed'
        | 'feedback.trashed'
        | 'feedback.trashReceiptFailed'
        | 'feedback.trashTabsFailed'
        | 'feedback.trashContextFailed'
        | 'feedback.unlinkTabsFailed'
        | 'feedback.unlinkContextFailed'
        | 'feedback.unlinked'
      name: string
      detail?: string
    }
  | {
      key: 'feedback.unlinkedInterrupted'
      name: string
      count: number
      detail?: string
    }
  | {
      key:
        | 'feedback.importReplaced'
        | 'feedback.importRenamed'
        | 'feedback.linkSuperseded'
        | 'feedback.linkSupersedeCleanupFailed'
      count: number
      detail?: string
    }

export interface ResourceNoticeState {
  tone: 'ok' | 'error'
  text: ResourceNoticeMessage
  retryDraft?: NameDraftState
  openTarget?: ResourceNoticeOpenTarget
}

/** 在关联目录中新建前展示的外部源目录变更确认。 */
export interface LinkedCreateConfirmState {
  directoryPath: string
  directoryName: string
  mode: ResourceCreateMode
}

/** 删除确认弹窗（PRD要求删除前明确提示会同步影响本地文件）。 */
export interface DeleteConfirmState {
  path: string
  name: string
  kind: 'file' | 'dir'
}

/** 取消关联确认；操作只撤销 Content root，不触碰 sourcePath。 */
export interface UnlinkConfirmState extends ResourceLinkRoot {
  name: string
  interruptRunning?: boolean
}

/**
 * 反方向关联 (先子后父) 的选择弹窗。
 *
 * 后端对「新源是已生效关联根的父目录」回 `source_covers_links` 而非硬拒绝; 前端凭
 * 已加载的关联根推出被覆盖的子关联, 让用户二选一: 取代子关联并挂载父目录, 或不挂载、
 * 直接打开已有子关联。null = 关闭。
 */
export interface LinkSupersedeConfirmState {
  /** 要挂载的父目录源 (OS 绝对路径); 取代时逐个走同步授权 (supersede)。 */
  sources: string[]
  /** 将被取代的已生效子关联 (来自已加载的关联根)。 */
  covered: { rootId: string; mountPath: string; name: string }[]
}

/** 移动目标选择弹窗（PRD「移动资料」）。 */
export interface MoveDialogState {
  path: string
  name: string
}

/** Per-candidate import outcome after a verified search has completed. */
export interface WebSearchImportResult {
  status: 'success' | 'failed'
  error?: string
  nodePath?: string
}

export const WEB_SEARCH_CANDIDATES_MODE = 'codex-native'
export const OFFICIAL_SEARCH_MODE = 'official-api'
export const BROWSER_SEARCH_MODE = 'visible-browser'
export const WEB_SEARCH_MODES = [
  OFFICIAL_SEARCH_MODE,
  WEB_SEARCH_CANDIDATES_MODE,
  BROWSER_SEARCH_MODE,
] as const
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number]

export type WebSearchStatus =
  'opening' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'unavailable'

export interface WebSearchAttempt {
  mode: WebSearchMode
  startedAt: number
  invocationStartedAt?: number
  resultReadyAt?: number
  completedAt?: number
  invocationId?: string
  invocationEvents: AgentInvocationEvent[]
  /** Renderer receipt time for each retained SSE event, keyed by Invocation sequence. */
  eventObservedAt: Record<number, number>
  /** Final artifact path used by this provider phase, when it has one. */
  artifactPath?: string
  officialSearchId?: string
  invocationProfile?: string
  resultText?: string
  status: WebSearchStatus
  error?: string
  errorCode?: string
  httpStatus?: number
}

/**
 * 全网搜索的一次性提示种类。
 *
 * 提示只在首次到达时弹一次，因此「已提示过」是搜索本身的事实，必须记在搜索状态里；
 * 记在组件内会随标签切换卸载而丢失，导致每次切回来都重新弹。
 */
export const WEB_SEARCH_NOTICES = ['result', 'fallback'] as const
export type WebSearchNotice = (typeof WEB_SEARCH_NOTICES)[number]

/** One ephemeral Agent-backed web-search tab. Candidates come from verified Skill output. */
export interface ResourceWebSearch {
  tabId: string
  query: string
  /** Product-clock boundary from user submission to terminal search state. */
  startedAt: number
  /** Frozen when the complete automatic route becomes terminal. */
  completedAt?: number
  readyAt?: number
  /** Ordered provider phases from one automatic Invocation, sharing its invocation id. */
  attempts: WebSearchAttempt[]
  /** The executor whose verified output supplies the visible candidates. */
  resolvedMode?: WebSearchMode
  status: Exclude<WebSearchStatus, 'unavailable'>
  error?: string
  selectedUrls: string[]
  importing: boolean
  importResults: Record<string, WebSearchImportResult>
  /** 已投递过的一次性提示；寿命跟随标签，切换标签不会让同一条提示再弹一次。 */
  notified: WebSearchNotice[]
}

/** 该一次性提示是否还没投递过。 */
export function webSearchNoticePending(
  search: ResourceWebSearch,
  notice: WebSearchNotice
): boolean {
  return !search.notified.includes(notice)
}

/** 记账一条已投递的提示；已经投递过时原样返回，调用方据引用判断无需更新。 */
export function withWebSearchNotice(
  search: ResourceWebSearch,
  notice: WebSearchNotice
): ResourceWebSearch {
  if (search.notified.includes(notice)) return search
  return { ...search, notified: [...search.notified, notice] }
}

export interface ResourceState {
  /** 当前项目的资料树根节点集合。 */
  tree: ResourceNode[]
  /**
   * 树根那一层的条目总数。
   *
   * 根不是一个节点，没有父节点能承载这个数；少了它，根层超过一页时剩下的条目
   * 在界面上就等于不存在。
   */
  rootTotal: number
  /** 项目根绝对路径，空态引导与引导页展示用。 */
  root: string
  /** 已展开的目录路径。 */
  expanded: Record<string, boolean>
  /** 当前选中的节点路径。 */
  selected: string | null
  /** 侧栏「全网搜索」输入框内容。 */
  searchText: string
  /** 当前窗口内打开的全网搜索；不另建数据库，关闭标签即释放投影状态。 */
  webSearches: Record<string, ResourceWebSearch>
  /** 侧栏资料搜索关键词（文件名/正文）。 */
  filterText: string
  /** 资料搜索命中；null = 未搜索（与「搜了但无命中」区分）。 */
  searchHits: ResourceSearchHit[] | null
  importDialog: ImportDialogState | null
  historyTarget?: ResourceHistoryTarget | null
  admissionPending?: Record<string, boolean>
  nodeMenu: NodeMenuState | null
  nameDraft: NameDraftState | null
  linkedCreateConfirm: LinkedCreateConfirmState | null
  deleteConfirm: DeleteConfirmState | null
  unlinkConfirm: UnlinkConfirmState | null
  linkSupersedeConfirm: LinkSupersedeConfirmState | null
  moveDialog: MoveDialogState | null
  /** 一次性操作反馈（成功/失败），由原子 Toast 展示。 */
  notice: ResourceNoticeState | null
  /** 树加载态，用于区分「空项目」与「还没加载完」。 */
  loadState: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'
}

export const INITIAL_RESOURCE_STATE: ResourceState = {
  tree: [],
  rootTotal: 0,
  root: '',
  expanded: {},
  selected: null,
  searchText: '',
  webSearches: {},
  filterText: '',
  searchHits: null,
  importDialog: null,
  nodeMenu: null,
  nameDraft: null,
  linkedCreateConfirm: null,
  deleteConfirm: null,
  unlinkConfirm: null,
  linkSupersedeConfirm: null,
  moveDialog: null,
  notice: null,
  loadState: 'idle',
}

/** Start a clean resource projection for another project while retaining window-owned search jobs. */
export function resourceStateForProjectSwitch(current: ResourceState): ResourceState {
  return {
    ...INITIAL_RESOURCE_STATE,
    webSearches: current.webSearches,
  }
}

/** Independent file decorations; editor state is scoped by exact project/path identity. */
export function resourceTreeIndicators(
  node: ResourceNode,
  project: string | null,
  sessions: readonly DocumentSession[]
) {
  const session =
    node.kind === 'file'
      ? sessions.find(
          (item) =>
            item.source.kind === 'project' &&
            item.source.project === project &&
            item.source.path === node.path
        )
      : undefined
  const version =
    node.kind === 'file' && node.version?.managementState !== 'git' ? node.version : undefined
  const warnings: Array<'versionBadge.unavailable' | 'versionBadge.drifted'> = []
  if (version?.managementState === 'unavailable') warnings.push('versionBadge.unavailable')
  if (version?.drifted) warnings.push('versionBadge.drifted')
  return {
    session,
    dirty: Boolean(session?.dirty),
    needsReview: Boolean(version?.needsReview),
    warnings,
  }
}
