import type { ForegroundMessage } from './feedback'
import type { PublicComponentContribution } from './components'
import type { PluginReference } from '../../../plugins'
/**
 * Feature 统一贡献协议（开发 7 拥有，开发 1～6 实现）。
 *
 * 架构文档 §4.3 要求开发 1～6 的每个前端 Feature 提供统一公开入口，
 * 开发 7 只组合 `FeatureModule`，**不在 App Shell 中根据文件扩展名、
 * 库类型或业务状态写硬编码分支**。
 *
 * 这条约束的实际后果：新增功能靠增加贡献项完成，而不是继续扩大
 * `App.tsx` 与全局 Store。因此本文件只定义"插槽形状"，不含任何业务判断。
 */

import type { ComponentType, ReactNode } from 'react'
import type { TFunction, i18n } from 'i18next'

import type { IconName } from '../icons'
import type { AssistantContextCandidate, AssistantSourceFilter, ContextRefKind } from './assistant'
import type { ContentKind, RecordTarget, SelectionAnchor, ViewerKind } from './workbench'
import type { ProductTask, ProductTaskPresentation } from './tasks'

export interface TaskSourceContribution {
  id: string
  /** Return a language-subscribed element; never cache a translated string. */
  renderError?: (error: string) => ReactNode
  /** Present source-owned progress and terminal outcome details in the active language. */
  present: (task: ProductTask, t: TFunction<'tasks'>) => ProductTaskPresentation
  list: () => Promise<ProductTask[]>
  cancel: (taskId: string) => Promise<ProductTask>
  retry: (taskId: string) => Promise<ProductTask>
  watch?: (
    task: ProductTask,
    callbacks: {
      onTask: (task: ProductTask) => void
      onConnectionChange: (connected: boolean) => void
    }
  ) => () => void
  subscribe?: (listener: (task: ProductTask) => void) => () => void
  onTerminal?: (task: ProductTask) => void
}

/** Resolve error presentation through the same owner registration used for task operations. */
export function taskErrorContent(
  task: Pick<ProductTask, 'sourceId' | 'error'>,
  sources: readonly TaskSourceContribution[]
): ReactNode {
  if (!task.error) return null
  const source = sources.find((candidate) => candidate.id === task.sourceId)
  return source?.renderError ? source.renderError(task.error) : task.error
}

/** Resolve task-center outcome detail through the source-owned presentation contract. */
export function taskDetailText(
  task: ProductTask,
  sources: readonly TaskSourceContribution[],
  t: TFunction<'tasks'>
): string {
  const source = sources.find((candidate) => candidate.id === task.sourceId)
  return source?.present(task, t).detail || task.detail
}

/** Resolve task-center plain text through the source-owned presentation contract. */
export function taskErrorText(
  task: ProductTask,
  sources: readonly TaskSourceContribution[],
  t: TFunction<'tasks'>
): string {
  if (!task.error) return ''
  const source = sources.find((candidate) => candidate.id === task.sourceId)
  return source?.present(task, t).error || task.error
}

/** 主视图导航键。与后端无关，纯前端导航概念。 */
export type RouteKey =
  | 'home'
  | 'conversation'
  | 'projects'
  | 'resource'
  | 'literature'
  | 'writing'
  | 'browser'
  | 'skills'

/**
 * 活动栏条目（最左侧竖条）。
 *
 * `icon` 用图标名而非 ReactNode：活动栏要按自己的尺寸与主题色渲染图标
 * （深色底上用浅色描边），若 Feature 直接给 JSX，颜色与尺寸就由 Feature
 * 决定了，活动栏无法保证视觉一致。给名字让 Shell 掌握呈现。
 */
export interface ActivityItem {
  key: RouteKey
  /** 在渲染时解析名称，语言切换不重建贡献注册表。 */
  label: (i18n: i18n, context: { hasProject: boolean }) => string
  icon: IconName
  /** 排序权重，小的在上。 */
  order: number
  /** 在指定视图中隐藏该入口。 */
  hiddenIn?: RouteKey[]
  /**
   * 该视图是否必须落在某个项目范围内。
   *
   * 由 Feature 自己声明而不是让 Shell 按 key 写死：资料库/文献库的接口都以
   * 项目为参数，没有项目时进去只会看到一棵报错的树。哪些视图有这个前提是
   * Feature 的业务事实，Shell 只按这面旗决定禁不禁用入口。
   */
  requiresProject?: boolean
}

/**
 * Viewer/Editor 插件（架构文档 §3.4 由开发 4 定义，开发 5 供 Editor 实现）。
 *
 * `accepts` 而非 `extensions`：能力判定的事实源在后端 workbench 域
 * （`/api/workbench/open` 回报 viewer 与 capabilities），前端只做匹配。
 * 这样"这份文件能不能编辑"只有一处答案，UI 不会给出点了没反应的按钮。
 */
export interface ViewerPlugin {
  /** 与后端 `ViewerKind` 同名，例如 markdown / pdf / table / code / docx。 */
  kind: string
  /** viewer 自带完整工具栏时，由 viewer 接管工作台顶部区域。 */
  toolbar?: 'workbench' | 'viewer'
  /** 渲染该 viewer。path 是项目内相对路径。 */
  render: (props: {
    active: boolean
    path: string
    page?: number
    documentSessionId?: string
    tabId?: string
    viewKind?: 'preview' | 'edit' | 'source'
    toolbarActions?: ReactNode
    modeControlHost?: HTMLElement | null
    documentPanels?: {
      activePanelId: string | null
      context: DocumentPanelContext
      panels: DocumentPanelContribution[]
      toggle: (panelId: string) => void
    }
    contentKind?: ContentKind | 'unknown'
  }) => ReactNode
}

/** 侧栏/底部面板贡献。 */
export interface PanelContribution {
  key: string
  title: (i18n: i18n) => string
  /** 挂载位置。module = 二级侧栏，dock = 右侧停靠区。 */
  slot: 'module' | 'dock' | 'navigation' | 'page'
  render: () => ReactNode
}

/** 命令贡献（供快捷键与命令面板使用）。 */
export interface CommandContribution {
  id: string
  title: string
  run: () => void | Promise<void>
}

/**
 * 文档工具栏贡献。
 *
 * Workbench 只发布稳定的文档路径与 SelectionAnchor，不依赖 AI 或其它业务域；
 * 需要消费选区的 Feature 通过这一插槽贡献自己的动作。
 */
export interface DocumentToolbarContext {
  path: string
  projectId: string | null
  selection: SelectionAnchor | null
  sourceKind: string
}

export interface DocumentToolbarContribution {
  id: string
  render: (context: DocumentToolbarContext) => ReactNode
}

/**
 * Stable document context exposed to business-owned side panels.
 *
 * The Workbench owns sessions and viewers, while feature modules own their
 * business data. A panel receives only stable document identity and never the
 * mutable workspace store or a feature-private API.
 */
export interface DocumentPanelContext {
  path: string
  viewer: ViewerKind
  sourceKind: string
  recordTarget: RecordTarget | null
  documentSessionId: string
  tabId: string
}

/** A business feature that can extend matching documents with one side panel. */
export interface DocumentPanelContribution {
  id: string
  label: (i18n: i18n) => string
  title: ReactNode
  placement?: 'toolbar' | 'viewer'
  matches: (context: DocumentPanelContext) => boolean
  render: (context: DocumentPanelContext) => ReactNode
}

export interface AssistantSourceQuery {
  projectId: string | null
  projectPath: string | null
  activeSessionId: string | null
  query: string
  filter: AssistantSourceFilter
  cursor?: string
}

export interface AssistantBrowseNode {
  id: string
  label: string
  parentId: string | null
}

export interface AssistantSourceBrowse {
  heading: ForegroundMessage
  ungrouped: { id: string; label: ForegroundMessage }
  nodes: (projectId: string | null) => Promise<AssistantBrowseNode[] | null>
  items: (projectId: string | null, nodeId: string) => Promise<AssistantContextCandidate[] | null>
}

/** 业务 Feature 向 AI Picker 贡献候选查询，不暴露自己的可变 Store。 */
export interface AssistantSourceContribution {
  id: string
  label: ForegroundMessage
  icon: IconName
  emptyLabel: ForegroundMessage
  kinds: readonly ContextRefKind[]
  /** This source only has meaning inside a project-bound conversation. */
  requiresProject?: boolean
  browse?: AssistantSourceBrowse
  search: (query: AssistantSourceQuery) => Promise<{
    items: AssistantContextCandidate[]
    next_cursor?: string | null
  }>
}

export type DisplayCardSupersessionPosition = 'first' | 'latest'

export interface DisplayCardContribution {
  type: string
  /** Suggestions for a new turn appear only after completion and file delivery. */
  placement?: 'after-artifacts'
  /** Newer cards with the same key replace older snapshots in the visible transcript. */
  supersessionKey?: (content: Record<string, unknown>) => string | null
  /** Keep the first display anchor when updating a card; defaults to the latest position. */
  supersessionPosition?: DisplayCardSupersessionPosition
  /** Supporting artifacts already accessible through this card. */
  presentedArtifacts?: (content: Record<string, unknown>) => readonly string[]
  render: (props: {
    cardId: string
    content: Record<string, unknown>
    component?: PluginReference
    presentationSource?: 'live' | 'history'
    turnId?: string
  }) => ReactNode
}

export interface InteractionQuestion {
  id?: string
  header?: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  papers?: Array<{ id: string; label: string; description?: string }>
}

export type InteractionDirectPresentation = 'options' | 'primary-secondary'

/** A feature-scoped refinement of an existing question card. Unmatched cards keep the global behavior. */
export interface InteractionPolicyContribution {
  id: string
  title: string
  matches: (questions: readonly InteractionQuestion[]) => boolean
  /** Optional immediate decision mode. When present, option clicks respond or cancel without a second confirmation. */
  directDecision?: (
    question: InteractionQuestion,
    option: InteractionQuestion['options'][number]
  ) => 'respond' | 'cancel'
  /** Optional visual hierarchy for immediate decisions. The default remains the ordinary option list. */
  directPresentation?: InteractionDirectPresentation
  directSelectionRequired?: (option: InteractionQuestion['options'][number]) => boolean
  /** Optional canonical label for immediate decisions whose native protocol adds presentation suffixes. */
  optionLabel?: (option: InteractionQuestion['options'][number]) => string
  replyTitle?: (
    question: InteractionQuestion,
    answer: string,
    localization: i18n
  ) => string | undefined
  replyText?: (
    question: InteractionQuestion,
    answer: string,
    localization: i18n
  ) => string | undefined
  presentQuestion?: (question: InteractionQuestion, localization: i18n) => InteractionQuestion
  presentAnswer?: (question: InteractionQuestion, answer: string, localization: i18n) => string
  /** Optional terminal copy after a feature-owned immediate cancellation succeeds. */
  cancelledLabel?: (question: InteractionQuestion) => string
  complete?: (
    questions: readonly InteractionQuestion[],
    answers: Readonly<Record<number, readonly string[]>>,
    texts: Readonly<Record<number, string>>
  ) => boolean
  defaults?: (questions: readonly InteractionQuestion[]) => Record<string, string>
  defaultLabel?: string
}

export interface GlobalSurfaceContribution {
  id: string
  render: () => ReactNode
}

/**
 * 一个 Feature 对外暴露的全部贡献。
 *
 * 全部可选：Feature 只声明自己真正提供的东西。开发 7 遍历贡献项装配，
 * 因此新增一个 Feature 不需要改 Shell 代码。
 */
export interface FeatureModule {
  /** Feature 标识，用于诊断与去重。 */
  id: string
  activityItems?: ActivityItem[]
  viewerPlugins?: ViewerPlugin[]
  panels?: PanelContribution[]
  commands?: CommandContribution[]
  documentToolbarItems?: DocumentToolbarContribution[]
  documentPanels?: DocumentPanelContribution[]
  assistantSources?: AssistantSourceContribution[]
  displayCards?: DisplayCardContribution[]
  publicComponents?: PublicComponentContribution[]
  interactionPolicies?: InteractionPolicyContribution[]
  taskSources?: TaskSourceContribution[]
  globalSurfaces?: GlobalSurfaceContribution[]
}

/** 组合后的贡献索引。由 `app/composition.tsx` 生成，Shell 只读它。 */
export interface FeatureRegistry {
  activityItems: ActivityItem[]
  viewers: Map<string, ViewerPlugin>
  panels: PanelContribution[]
  commands: Map<string, CommandContribution>
  documentToolbarItems: DocumentToolbarContribution[]
  documentPanels: DocumentPanelContribution[]
  assistantSources: AssistantSourceContribution[]
  displayCards: Map<string, DisplayCardContribution>
  publicComponents: Map<string, PublicComponentContribution>
  interactionPolicies: InteractionPolicyContribution[]
  taskSources: TaskSourceContribution[]
  globalSurfaces: GlobalSurfaceContribution[]
}

/**
 * 把多个 FeatureModule 折叠成一张索引。
 *
 * 冲突策略是"先注册者胜 + 开发期告警"而不是静默覆盖：两个 Feature 抢同一个
 * viewer kind 属于边界划分出错，静默覆盖会让问题在运行时才以"打开是空白"
 * 的形式出现，届时很难定位到是注册冲突。
 */
export function composeFeatures(modules: readonly FeatureModule[]): FeatureRegistry {
  const viewers = new Map<string, ViewerPlugin>()
  const commands = new Map<string, CommandContribution>()
  const activityItems: ActivityItem[] = []
  const panels: PanelContribution[] = []
  const documentToolbarItems: DocumentToolbarContribution[] = []
  const documentToolbarIds = new Set<string>()
  const documentPanels: DocumentPanelContribution[] = []
  const documentPanelIds = new Set<string>()
  const assistantSources: AssistantSourceContribution[] = []
  const assistantSourceIds = new Set<string>()
  const displayCards = new Map<string, DisplayCardContribution>()
  const publicComponents = new Map<string, PublicComponentContribution>()
  const interactionPolicies: InteractionPolicyContribution[] = []
  const interactionPolicyIds = new Set<string>()
  const taskSources: TaskSourceContribution[] = []
  const globalSurfaces: GlobalSurfaceContribution[] = []
  const taskSourceIds = new Set<string>()
  const globalSurfaceIds = new Set<string>()

  for (const module of modules) {
    for (const viewer of module.viewerPlugins ?? []) {
      if (viewers.has(viewer.kind)) {
        console.warn(`[features] viewer ${viewer.kind} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      viewers.set(viewer.kind, viewer)
    }
    for (const command of module.commands ?? []) {
      if (commands.has(command.id)) {
        console.warn(`[features] 命令 ${command.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      commands.set(command.id, command)
    }
    for (const item of module.documentToolbarItems ?? []) {
      if (documentToolbarIds.has(item.id)) {
        console.warn(`[features] 文档工具栏 ${item.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      documentToolbarIds.add(item.id)
      documentToolbarItems.push(item)
    }
    for (const panel of module.documentPanels ?? []) {
      if (documentPanelIds.has(panel.id)) {
        console.warn(`[features] 文档侧栏 ${panel.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      documentPanelIds.add(panel.id)
      documentPanels.push(panel)
    }
    for (const source of module.assistantSources ?? []) {
      if (assistantSourceIds.has(source.id)) {
        console.warn(`[features] AI 上下文来源 ${source.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      assistantSourceIds.add(source.id)
      assistantSources.push(source)
    }
    for (const component of module.publicComponents ?? []) {
      if (publicComponents.has(component.slot)) throw new Error(`Duplicate public component: ${component.slot}`)
      publicComponents.set(component.slot, component)
    }
    for (const card of module.displayCards ?? []) {
      if (displayCards.has(card.type)) {
        console.warn(`[features] 对话卡片 ${card.type} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      displayCards.set(card.type, card)
    }
    for (const policy of module.interactionPolicies ?? []) {
      if (interactionPolicyIds.has(policy.id)) {
        console.warn(`[features] 问答策略 ${policy.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      interactionPolicyIds.add(policy.id)
      interactionPolicies.push(policy)
    }
    for (const source of module.taskSources ?? []) {
      if (taskSourceIds.has(source.id)) {
        console.warn(`[features] 任务来源 ${source.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      taskSourceIds.add(source.id)
      taskSources.push(source)
    }
    for (const surface of module.globalSurfaces ?? []) {
      if (globalSurfaceIds.has(surface.id)) {
        console.warn(`[features] 全局表面 ${surface.id} 重复注册，忽略 ${module.id} 的贡献`)
        continue
      }
      globalSurfaceIds.add(surface.id)
      globalSurfaces.push(surface)
    }
    activityItems.push(...(module.activityItems ?? []))
    panels.push(...(module.panels ?? []))
  }

  activityItems.sort((a, b) => a.order - b.order)
  return {
    activityItems,
    viewers,
    panels,
    commands,
    documentToolbarItems,
    documentPanels,
    assistantSources,
    displayCards,
    publicComponents,
    interactionPolicies,
    taskSources,
    globalSurfaces,
  }
}

/** 供 Feature 声明自己时使用的类型辅助，避免各处重复写类型标注。 */
export type FeatureFactory = () => FeatureModule

export type { ComponentType }
