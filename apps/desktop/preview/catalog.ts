import type { RendererPreferences } from '../src/preferences.ts'
import type { AccountSettingsPage, MainView } from '../src/navigation.ts'
import { PREVIEW_PROJECT_ID } from './constants.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import type { PreviewDeveloperPolicy } from './developer.ts'
import type { PreviewConversationPolicy } from './conversation.ts'
import { PREVIEW_CONVERSATION } from './conversation.ts'
import type { PreviewLiteraturePolicy } from './literature.ts'
import type { PreviewArchivePolicy } from './archive.ts'
import { PREVIEW_BROWSER, type PreviewBrowserPolicy } from './browser.ts'
import type { PreviewArtifactPolicy } from './publications.ts'
import type { PreviewStoragePolicy } from './directory.ts'
import type { PreviewBrowsingPolicy } from './listing.ts'
import { PREVIEW_HOME, type PreviewHomePolicy } from './home.ts'
import zh from './locales/zh.json' with { type: 'json' }

export type PreviewTarget = NonNullable<RendererPreferences['lastLocation']>
export type PreviewAvailability = 'pending' | 'hidden' | 'native-only'
export type PreviewImplementation = 'surface' | 'alias' | 'placeholder'

export interface PreviewScenario {
  readonly expectedKeys?: readonly (keyof typeof zh)[]
  readonly limitationKeys?: readonly (keyof typeof zh)[]
  readonly section?: 'areaDaily' | 'areaBoundaries' | 'areaRecovery'
  readonly group?: 'homeRegularGroup' | 'homeProjectBoundaryGroup' | 'homeTaskBoundaryGroup'
  readonly aliasOf?: string
  readonly capabilityKeys?: readonly (keyof typeof zh)[]
  readonly titleKey?: keyof typeof zh
  readonly home?: PreviewHomePolicy
  readonly id: string
  readonly title: string
  readonly states: readonly string[]
  readonly expected: readonly string[]
  readonly limitations: readonly string[]
  readonly status: 'unverified'
  readonly simulation?: { readonly artifacts?: PreviewArtifactPolicy; readonly browser?: PreviewBrowserPolicy; readonly literature?: PreviewLiteraturePolicy; readonly conversation?: PreviewConversationPolicy; readonly developer?: PreviewDeveloperPolicy; readonly archives?: PreviewArchivePolicy; readonly projectCreation?: 'fail-once'; readonly feedback?: 'failed' | 'rate-limited'; readonly versionHistory?: 'sample-change'; readonly reviewBatch?: 'pending' | 'fail-once' | 'conflict'; readonly close?: 'success' | 'delayed' | 'fail-once'; readonly permissions?: 'normal' | 'delayed' | 'failed'; readonly literatureSearch?: 'results'; readonly webSearch?: 'results'; readonly account?: 'ready' | 'delayed' | 'failed' | 'anonymous' | 'no-base'; readonly contentRead?: { readonly mode: 'delayed' | 'failed' | 'fail-once' }; readonly browsing?: PreviewBrowsingPolicy; readonly storage?: PreviewStoragePolicy; readonly fileSettings?: { readonly write: 'normal' | 'delayed' | 'fail-once' }; readonly modelProfiles?: { readonly read: 'sample' | 'empty' | 'delayed' | 'failed' }; readonly mcp?: { readonly read: 'normal' | 'delayed' | 'failed'; readonly write: 'normal' | 'delayed' | 'fail-once' } }
}

export interface PreviewPage {
  readonly navigation?: 'hidden' | { readonly parentPage: string; readonly section: NonNullable<PreviewScenario['section']> }
  readonly entryInstructionKeys?: readonly (keyof typeof zh)[]
  readonly titleKey?: keyof typeof zh
  readonly pendingStates?: readonly string[]
  readonly id: string
  readonly title: string
  readonly owner: string
  readonly source: string
  readonly entry: string
  readonly entryInstructions?: readonly string[]
  readonly launch?: { readonly kind: 'components' }
  readonly category: 'page' | 'settings' | 'viewer' | 'surface' | 'development'
  readonly availability: PreviewAvailability
  readonly implementation: PreviewImplementation
  readonly aliasOf?: string
  readonly requirementSource: string
  readonly target: PreviewTarget | null
  readonly host?: { readonly kind: 'settings'; readonly page: AccountSettingsPage } | { readonly kind: 'close' | 'error' | 'browser' } | { readonly kind: 'panel'; readonly key: 'resource-tree' }
  readonly scenarios: readonly PreviewScenario[]
}

const UNVERIFIED = 'unverified'
const PENDING = 'pending'
const MOCK_LIMITATION = '仅验证模拟响应的 UI 消费，不证明真实服务、模型、工具或持久化行为。'
const PENDING_LIMITATION = '目录登记不代表场景已接入；须由消费测试及真实预览证据确认。'
const VIEWER_LIMITATIONS: Readonly<Record<string, readonly string[]>> = {
  office: ['Office WASM 仅使用受审预置 Noto 字体，不访问系统字体；此为预览排版近似，不证明系统字体或 Electron 排版一致。默认字体可能重复安装，仍须核实际可见内容与启动开销。'],
}
const REQUIREMENT_SOURCE = '本次 Goal：用户确认以现有产品的完整 Mock 功能为需求；产品经理、设计师与前端共用真实 UI，逐功能核对完整交互、适用页面状态及组件示例。场景目录不是完整性证明；真实服务、模型与原生能力单列验收边界。'
const HIDDEN_SETTINGS: readonly AccountSettingsPage[] = ['account', 'preferences', 'skills', 'permissions', 'shortcuts', 'browser']
const DEVELOPMENT_PARAMETER = 'dev'
const COMPONENTS_DEVELOPMENT_ENTRY = 'components'
const FIXED_VIEWERS: Readonly<Record<string, MainView>> = { projects: 'projects', literature: 'literature' }
const SURFACE_ENTRIES: Readonly<Record<string, { readonly view: MainView; readonly instructions: readonly string[] }>> = {
  'project-form': { view: 'home', instructions: ['打开场景后点击首页“新建项目”，显示真实项目表单。'] },
  menus: { view: 'resource', instructions: ['打开场景后点击项目顶栏的项目名称，展开真实项目菜单；其他文件及会话菜单仍需从所属控件触发。'] },
  approval: { view: 'conversation', instructions: ['打开场景后在真实会话输入框提交消息，等待模拟审批，再通过真实审批控件允许或拒绝。'] },
  feedback: { view: 'home', instructions: ['打开场景后点击侧栏底部头像，在真实账号菜单中选择“问题反馈”，填写问题说明并提交。'] },
  login: { view: 'home', instructions: ['打开场景后点击侧栏底部头像，在真实账号菜单中选择登录；当前账号地址未配置，只展示真实无登录入口通知，不模拟授权成功。'] },
}
const LIBRARY_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  new_tab: ['打开场景后先点击项目侧栏“项目文件”进入工作区，再点击“新标签页”，在原选择页进入项目文件或项目资源管理器；使用远端产品新入口，不恢复旧侧栏布局。'],
  library: ['打开场景后点击项目侧栏的“项目文件”，显示真实资料概览。'],
  'material-list': ['打开场景后点击“项目文件”，在资料概览中选择“资料”。'],
  'project-literature': ['打开场景后点击“项目文件”，在资料概览中选择“文献”。'],
  outputs: ['打开场景后点击“项目文件”，在资料概览中选择“任务产物”。'],
  explorer: ['打开场景后点击“项目文件” → “项目资源管理器”；选择文件后，可用工具栏“收起文件树”扩大预览区域，再用“展开文件树”返回目录。'],
}

function location(view: MainView, settingsPage: AccountSettingsPage | null = null): PreviewTarget {
  return {
    view,
    projectId: null,
    sessionId: null,
    sessionProjectId: null,
    settingsPage,
    browserSettingsSection: settingsPage === 'browser' ? 'overview' : null,
    aiPanelOpen: false,
    aiPanelCover: false,
    target: null,
  }
}

function sampleDocument(kind: string): PreviewTarget | null {
  const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === kind)
  if (!sample) return null
  return {
    ...location('resource'), projectId: PREVIEW_PROJECT_ID,
    target: { kind: 'document', source: { kind: 'project', project: PREVIEW_PROJECT_ID, path: sample.path }, viewKind: sample.viewKind, title: sample.path },
  }
}

function viewerEntry(kind: string): PreviewTarget | null {
  if (kind === 'version_diff' || kind === 'review') return sampleDocument('markdown')
  if (kind === 'web_search') return { ...location('resource'), projectId: PREVIEW_PROJECT_ID }
  if (kind === 'literature_search') return location('literature')
  return sampleDocument(kind) ?? (FIXED_VIEWERS[kind] ? location(FIXED_VIEWERS[kind]) : LIBRARY_ENTRIES[kind] ? { ...location('resource'), projectId: PREVIEW_PROJECT_ID } : null)
}

function scenario(id: string, title: string, states: readonly string[], expected: readonly string[], limitations: readonly string[] = []): PreviewScenario {
  return { id, title, states, expected, limitations: [MOCK_LIMITATION, PENDING_LIMITATION, ...limitations], status: UNVERIFIED }
}

function browserSurfaceScenarios(prefix: string, requiredStates: readonly string[]): readonly PreviewScenario[] {
  const limitations = ['复用原 Browser 组件，通过显式预览宿主展示，不启用生产浏览器开关或导航；说明栏占用空间属于宿主差异。', `仅模拟 about:blank 标签账本，最多 ${PREVIEW_BROWSER.maxSurfaceTabs} 项；此上限不是原生产品配额。网页导航、历史重新打开、原生菜单、网页内容、frame、CDP、打印、开发工具、下载与 Vault 均不执行。`]
  const make = (suffix: string, title: string, states: readonly string[], expected: readonly string[], surface: NonNullable<PreviewBrowserPolicy['surface']>, extra: readonly string[] = []): PreviewScenario => ({
    ...scenario(`${prefix}-${suffix}`, title, states, expected, [...limitations, ...extra]), simulation: { browser: { seed: 'empty', surface } },
  })
  return [
    make('states', '浏览器原关键状态要求', requiredStates, ['保留原页面的正常与异常状态要求，具体行为按下列独立政策场景消费，不用单一空白种子声称全部实现。'], { seed: 'empty' }),
    make('blank', '起始页与空白标签交互', ['start', 'opened', 'selected', 'closed', 'reloaded', 'blocked'], ['通过原新建、选择、键盘和关闭控件操作空白标签，重载显示同一账本；地址栏外部导航明确拒绝，不联网或写历史，拒绝后仍可操作空白标签。'], { seed: 'empty' }),
    make('tabs', '已有空白标签', ['populated', 'selected', 'closed'], ['显示两个独立空白标签，选择与关闭改变同一快照，关闭最后一项返回原起始引导。'], { seed: 'sample' }),
    make('pending', '浏览器快照读取等待', ['request-pending', 'loaded'], ['真实快照请求在途时保持原默认起始界面；响应后呈现两个空白标签，不伪造原组件没有的 Spinner。'], { seed: 'sample', read: 'delayed' }),
    make('failed', '浏览器快照持续失败', ['error', 'retry-failed'], ['原辅助状态及提示显示失败；重新加载页面仍失败，不自动切换种子或宣称原生恢复。'], { seed: 'empty', read: 'failed' }),
    make('write-pending', '空白标签操作等待', ['submitting', 'opened'], ['原新建标签请求在途保持 busy，阻止重复操作；回执后出现同一新标签。'], { seed: 'empty', write: 'delayed' }),
    make('write-failed', '空白标签操作失败后重试', ['error', 'retried', 'opened'], ['首次新建失败不留下半标签，原提示展示失败；再次点击原新建控件后成功。'], { seed: 'empty', write: 'fail-once' }),
  ]
}

const PRIMARY_BROWSE_LIMITATIONS = ['本切片仅验证入口与正常浏览；原通用场景声明的空态、加载、异常等要求仍保留待接入，不因增加消费关联视为整页全状态完成。']
function homeScenario(id: string, title: string, states: readonly string[], expectedKeys: readonly (keyof typeof zh)[], extraLimitations: readonly (keyof typeof zh)[] = []): PreviewScenario {
  const limitationKeys = ['mockLimitation', 'registrationLimitation', ...extraLimitations] as const
  return { id, title, states, expectedKeys, limitationKeys, expected: expectedKeys.map(key => zh[key]), limitations: limitationKeys.map(key => zh[key]), status: UNVERIFIED }
}
const HOME_SCENARIOS: readonly PreviewScenario[] = [
  { ...homeScenario('home-states', '常规概览 · 1 个项目 / 1 个任务', ['populated', 'opened'], ['homeStandardExpected']), titleKey: 'homeStandard', section: 'areaDaily', group: 'homeRegularGroup', capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryProjectActions'], home: { projects: 1, tasks: 1 } },
  { ...homeScenario('home-browse', '项目中心项目与任务浏览', ['populated', 'opened'], ['homeBrowseExpected'], ['homeBrowseLimitation']), titleKey: 'homeBrowse', section: 'areaDaily', aliasOf: 'home-states', group: 'homeRegularGroup', capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryProjectActions'], home: { projects: 1, tasks: 1 } },
  { ...homeScenario('home-empty', '首次使用 · 0 个项目 / 0 个任务', ['empty'], ['homeEmptyExpected']), titleKey: 'homeEmpty', section: 'areaDaily', capabilityKeys: ['tryEmptyLists', 'tryCreate'], home: { projects: 0, tasks: 0 } },
  { ...homeScenario('home-no-tasks', '任务为空 · 3 个项目 / 0 个任务', ['empty', 'populated'], ['homeNoTasksExpected']), titleKey: 'homeNoTasks', section: 'areaDaily', capabilityKeys: ['tryTaskEmpty', 'tryOpenProject', 'tryCreate'], home: { projects: 3, tasks: 0 } },
  ...[PREVIEW_HOME.projectPage - 1, PREVIEW_HOME.projectPage, PREVIEW_HOME.projectPage + 1].map(count => ({ ...homeScenario('home-projects-' + count, '项目分页边界 · ' + count + ' 个项目 / 1 个任务', ['populated', 'pagination'], ['homeProjectBoundaryExpected']), titleKey: 'homeProjectBoundary' as const, section: 'areaBoundaries' as const, group: 'homeProjectBoundaryGroup' as const, capabilityKeys: ['tryProjectActions', 'tryPagination', 'tryOpenProject'] as const, home: { projects: count, tasks: 1 } })),
  ...[PREVIEW_HOME.taskPage - 1, PREVIEW_HOME.taskPage, PREVIEW_HOME.taskPage + 1].map(count => ({ ...homeScenario('home-tasks-' + count, '任务分页边界 · 3 个项目 / ' + count + ' 个任务', ['populated', 'pagination'], ['homeTaskBoundaryExpected']), titleKey: 'homeTaskBoundary' as const, section: 'areaBoundaries' as const, group: 'homeTaskBoundaryGroup' as const, capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryPagination'] as const, home: { projects: 3, tasks: count } })),
  { ...homeScenario('home-many-projects', '大量项目 · ' + PREVIEW_HOME.projects + ' 个项目 / 1 个任务', ['populated', 'pagination'], ['homeManyProjectsExpected']), titleKey: 'homeManyProjects', section: 'areaBoundaries', capabilityKeys: ['tryProjectActions', 'tryPagination', 'tryOpenProject'], home: { projects: PREVIEW_HOME.projects, tasks: 1 } },
  { ...homeScenario('home-many-tasks', '大量任务 · 3 个项目 / ' + PREVIEW_HOME.tasks + ' 个任务', ['populated', 'pagination'], ['homeManyTasksExpected']), titleKey: 'homeManyTasks', section: 'areaBoundaries', capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryPagination'], home: { projects: 3, tasks: PREVIEW_HOME.tasks } },
  { ...homeScenario('home-dense', '密集数据 · ' + PREVIEW_HOME.projects + ' 个项目 / ' + PREVIEW_HOME.tasks + ' 个任务', ['populated', 'pagination'], ['homeDenseExpected']), titleKey: 'homeDense', section: 'areaBoundaries', capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryPagination'], home: { projects: PREVIEW_HOME.projects, tasks: PREVIEW_HOME.tasks } },
  { ...homeScenario('home-long-content', '长名称与长标题 · 3 个项目 / ' + (PREVIEW_HOME.taskPage + 1) + ' 个任务', ['populated', 'pagination'], ['homeLongContentExpected']), titleKey: 'homeLongContent', section: 'areaBoundaries', capabilityKeys: ['tryLongContent', 'tryPagination', 'tryOpenTask'], home: { projects: 3, tasks: PREVIEW_HOME.taskPage + 1, content: 'long' } },
  { ...homeScenario('home-cross-batch', '跨批读取 · 3 个项目 / ' + (PREVIEW_HOME.sessionPage + 1) + ' 个任务', ['populated', 'pagination'], ['homeCrossBatchExpected']), titleKey: 'homeCrossBatch', section: 'areaBoundaries', capabilityKeys: ['tryCrossBatch', 'tryPagination', 'tryOpenTask'], home: { projects: 3, tasks: PREVIEW_HOME.sessionPage + 1 } },
  { ...homeScenario('home-create', '创建项目 · 0 个项目 / 0 个任务', ['empty', 'created'], ['homeCreateExpected']), titleKey: 'homeCreate', section: 'areaDaily', aliasOf: 'home-empty', capabilityKeys: ['tryEmptyLists', 'tryCreate'], home: { projects: 0, tasks: 0 } },
  { ...homeScenario('home-open-project', '打开项目与返回 · 3 个项目 / 0 个任务', ['opened', 'reentered'], ['homeOpenProjectExpected']), titleKey: 'homeOpenProject', section: 'areaDaily', aliasOf: 'home-no-tasks', capabilityKeys: ['tryTaskEmpty', 'tryOpenProject', 'tryCreate'], home: { projects: 3, tasks: 0 } },
  { ...homeScenario('home-open-task', '打开任务与返回 · 3 个项目 / 3 个任务', ['opened', 'reentered'], ['homeOpenTaskExpected']), titleKey: 'homeOpenTask', section: 'areaDaily', group: 'homeRegularGroup', capabilityKeys: ['tryOpenProject', 'tryOpenTask', 'tryProjectActions'], home: { projects: 3, tasks: 3 } },
  { ...homeScenario('home-project-actions', '项目菜单与列表变更 · ' + (PREVIEW_HOME.projectPage + 1) + ' 个项目 / 1 个任务', ['renamed', 'pinned', 'archived', 'pagination'], ['homeProjectActionsExpected'], ['homeActionsLimitation']), titleKey: 'homeProjectActions', section: 'areaBoundaries', aliasOf: 'home-projects-' + (PREVIEW_HOME.projectPage + 1), group: 'homeProjectBoundaryGroup' as const, capabilityKeys: ['tryProjectActions', 'tryPagination', 'tryOpenProject'], home: { projects: PREVIEW_HOME.projectPage + 1, tasks: 1 } },
  { ...homeScenario('home-task-loading', '任务加载中', ['loading', 'populated'], ['homeTaskLoadingExpected']), titleKey: 'homeTaskLoading', section: 'areaRecovery', capabilityKeys: ['tryTaskLoading'], home: { projects: 1, tasks: 1, read: 'delayed' } },
  { ...homeScenario('home-task-retry', '任务读取失败后重试', ['error', 'retried', 'populated'], ['homeTaskRetryExpected']), titleKey: 'homeTaskRetry', section: 'areaRecovery', capabilityKeys: ['tryTaskRetry'], home: { projects: 1, tasks: 1, read: 'fail-once' } },
  { ...homeScenario('home-project-read-loading', '项目读取中', ['project-read-loading', 'project-read-loaded'], ['homeProjectReadLoadingExpected']), titleKey: 'homeProjectReadLoading', section: 'areaRecovery', capabilityKeys: ['tryProjectReadLoading'], home: { projects: 1, tasks: 1, projectRead: 'delayed' } },
  { ...homeScenario('home-project-read-failed', '项目读取失败与恢复', ['project-read-error', 'project-read-retried', 'project-read-recovered'], ['homeProjectReadFailedExpected']), titleKey: 'homeProjectReadFailed', section: 'areaRecovery', capabilityKeys: ['tryProjectReadRecovery'], home: { projects: 1, tasks: 1, projectRead: 'failed' } },
]
const PRIMARY_BROWSE_SCENARIOS: Partial<Record<MainView, PreviewScenario>> = {
  projects: scenario('projects-browse', '项目列表浏览与筛选', ['populated', 'filtered', 'no-match', 'opened'], ['通过原搜索筛选已有项目、显示无匹配，再点击原项目卡进入工作区。'], PRIMARY_BROWSE_LIMITATIONS),
  resource: scenario('resource-browse', '项目资料树与文档浏览', ['populated', 'opened'], ['打开预览隐藏模块面板，浏览同一项目真实资料树；点击文档后关闭面板，显示原工作区文档。'], [...PRIMARY_BROWSE_LIMITATIONS, '资料树仅复用原注册模块，在预览非模态容器中显示；不恢复生产隐藏导航，不证明生产布局一致。']),
  literature: scenario('literature-browse', '文献库空库存浏览', ['empty', 'filtered'], ['显示真实空文献库；原搜索输入与清除保持空库存，不执行检索或导入。'], [...PRIMARY_BROWSE_LIMITATIONS, '非空文献列表、详情与导入尚未在此场景模拟，不把空库浏览当作全功能覆盖。']),
  skills: scenario('skills-browse', '技能中心浏览与详情', ['populated', 'filtered', 'no-match', 'details'], ['通过真实技能中心搜索、切换我的技能并打开受审技能详情。'], [...PRIMARY_BROWSE_LIMITATIONS, '仅既有模拟技能库存和文档，不安装、运行技能或访问用户文件。']),
}
const PRIMARY_INSTRUCTIONS: Partial<Record<MainView, readonly string[]>> = {
  home: [zh.homeEntry],
  projects: ['选择“项目列表浏览与筛选”，在原搜索框过滤并清除，再点击项目卡进入对应工作区。'],
  resource: ['选择“项目资料树与文档浏览”，点击“打开隐藏模块面板”；从同项目原资料树打开 readme.md，再用面板关闭按钮返回原工作区。此容器不代表生产导航布局。'],
  literature: ['空库存场景保留原搜索与清除；非空场景展示明确模拟的入库文献，使用原筛选、排序、详情、附件和笔记。目录、计数和变更由同一预览实例保存，重置后还原；不执行真实检索、下载或导入。'],
  skills: ['选择“技能中心浏览与详情”，使用原搜索、我的技能标签和详情按钮；不运行或安装技能。'],
}

const LITERATURE_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('library-populated', '模拟文献目录与详情', ['populated', 'filtered', 'sorted', 'detail', 'attachment', 'notes', 'reloaded'], ['原列表消费非空目录与真实筛选排序；详情、受审 PDF 附件、元数据及笔记沿原客户端读取与更新，重载保持当前实例。'], ['样本标题均明确标为模拟；检索结果与入库目录分离，不访问真实文献、账号或网络。PDF 批注写入、导入、下载与分类/标签实体管理仍未接入。']), simulation: { literature: { seed: 'sample', read: 'normal', detail: 'normal', write: 'normal' } } },
  { ...scenario('library-pending', '文献目录读取等待', ['loading', 'loaded'], ['目录相关 GET 有界等待两秒；原加载面结束后显示同一非空文献账本。']), simulation: { literature: { seed: 'sample', read: 'delayed', detail: 'normal', write: 'normal' } } },
  { ...scenario('library-failed', '文献目录读取失败', ['error', 'retry-failed'], ['目录读取持续失败，原错误反馈和重试再次请求后仍失败，不用空库存冒充错误恢复。']), simulation: { literature: { seed: 'sample', read: 'failed', detail: 'normal', write: 'normal' } } },
  { ...scenario('detail-pending', '文献详情读取等待', ['loading', 'loaded'], ['列表正常显示；通过原条目打开详情时等待后展示实际字段与附件。']), simulation: { literature: { seed: 'sample', read: 'normal', detail: 'delayed', write: 'normal' } } },
  { ...scenario('detail-failed', '文献详情读取失败', ['error', 'retry-failed'], ['列表可用但详情读取持续失败；原详情重试不伪造成功。']), simulation: { literature: { seed: 'sample', read: 'normal', detail: 'failed', write: 'normal' } } },
  { ...scenario('metadata-pending', '文献编辑保存等待', ['editing', 'pending', 'saved'], ['使用原详情字段编辑器，真实 PATCH 在途等待后保存，重新读取及重载核对同一值。'], ['原字段没有专门保存中或禁用界面；pending 以实际请求在途证明，不添加预览专属忙碌控件。']), simulation: { literature: { seed: 'sample', read: 'normal', detail: 'normal', write: 'delayed' } } },
  { ...scenario('metadata-failed', '文献编辑保存失败重试', ['editing', 'error', 'retried', 'saved'], ['首次合法变更返回声明失败，原错误反馈可见，再次编辑重试后保存；非法输入不消耗失败政策。']), simulation: { literature: { seed: 'sample', read: 'normal', detail: 'normal', write: 'fail-once' } } },
]

const CONVERSATION_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('conversation-stream', '模拟对话与流式回复', ['idle', 'submitting', 'streaming', 'completed'], ['从真实 Composer 提交，经 HTTP/SSE 投影逐步显示消息。', '完成后输入框恢复可提交状态。']), simulation: { conversation: { mode: 'streaming' } } },
  { ...scenario('conversation-tool', '模拟工具调用', ['queued', 'running', 'completed', 'failed'], ['真实工具卡显示输入、进度、输出与错误。', '模拟工具不执行命令或访问本机文件。'], ['真实工具协议仅 started/progress/completed，历史 pending 投影为 running，没有工具 queued 事件或状态。queued 原要求保留待 Owner 明确，不能用用户消息队列、尚未开始或 running 冒充。']), simulation: { conversation: { mode: 'tools' } } },
  { ...scenario('conversation-approval', '审批允许、拒绝与继续', ['waiting', 'approved', 'rejected', 'resumed'], ['真实审批控件提交同一请求身份，允许后继续、拒绝后不产生模拟副作用。', '重复提交及过期审批明确拒绝。'], ['不代表真实工具权限或安全授权已验收。']), simulation: { conversation: { mode: 'approval' } } },
  { ...scenario('conversation-cancel', '中断与取消', ['streaming', 'cancelling', 'cancelled'], ['通过真实停止入口取消正在逐段追加的长回答，终止后保留已显示前缀；重入及再次发送保持原账本一致。'], ['十二片段、每秒一段的长流是显式交互演示数据；不修改正常流式场景、真实客户端时序或生产模型速度。']), simulation: { conversation: { mode: 'streaming', stream: 'interruptible' } } },
  { ...scenario('conversation-recovery', '断线、失败与恢复', ['disconnected', 'reconnecting', 'failed', 'recovered'], ['首轮显示真实失败反馈，经原继续按钮重试；首个答案增量后模拟 HTTP 流断开一次，原客户端按 from_seq 续流并补齐断线期间内容和终态。'], ['重连握手有界等待两秒，但同一领域账本继续推进；这不是模型断线、真实网络故障或重叠帧去重验收。须保持原序号、会话及回合身份，不重新提交 turn 来假冒重连。']), simulation: { conversation: { mode: 'failure', disconnectAfterDeltas: 1, reconnectDelayMs: PREVIEW_CONVERSATION.reconnectDelayMs } } },
  { ...scenario('conversation-submit-pending', '提交接纳等待', ['submitting', 'completed'], ['合法提交在接纳前有界等待两秒；原发送按钮 busy/禁用，重复 Enter 不重复发起请求。回执后同一用户消息与回合正常完成。'], ['等待的是接纳，不是工具 queued 或用户消息排队；断连、重置、删除或中断取消未接纳请求，不执行真实工具。']), simulation: { conversation: { mode: 'chat', submission: 'delayed' } } },
  { ...scenario('conversation-tool-running', '工具运行、进度与取消', ['running', 'completed', 'cancelled', 'reentered'], ['原工具卡运行两秒并逐片输出，同一工具身份完成；运行中原 Stop 保留已读前缀并取消，重入仍保持对应终态。'], ['只使用真实 started/output/completed 事件，不造工具 queued；时间是模拟政策，不是模型速度。']), simulation: { conversation: { mode: 'tools', tool: 'delayed' } } },
  { ...scenario('conversation-tool-failed', '工具错误与历史保留', ['running', 'failed', 'completed', 'reentered'], ['工具运行后以 success:false 完成，原错误摘要及技术详情可见；助手说明错误并正常结束同回合，重入保留错误工具。'], ['failed 指工具，completed 指回合；没有原工具重试按钮，不造继续入口或将工具错误伪装为整轮失败。']), simulation: { conversation: { mode: 'tools', tool: 'failed' } } },
  { ...scenario('conversation-approval-resume', '审批后同回合续答', ['waiting', 'approved', 'resumed', 'completed'], ['记录原请求与回合身份，允许回执后同回合保持运行两秒，再正常续答完成；不再次提交 turns 或复制用户消息。'], ['不执行真实工具或授权；resumed 是同回合续行窗口，不是新事件或永久审批卡。拒绝仍不能发布副作用。']), simulation: { conversation: { mode: 'approval', approvalResume: 'delayed' } } },
]

const PROJECT_SCENARIOS: readonly PreviewScenario[] = [
  scenario('projects-states', '项目列表与新建', ['empty', 'loading', 'populated', 'submitting', 'error'], ['使用真实项目表单校验输入并提交；操作完成前保持忙碌，成功后显示新项目。']),
  { ...scenario('projects-create-failure', '项目创建失败与恢复', ['submitting', 'failed', 'retry', 'completed'], ['使用合法输入首次提交后明确显示模拟创建失败；不生成半项目，表单保留输入，重试后成功。']), simulation: { projectCreation: 'fail-once' } },
]

const FEEDBACK_SCENARIOS: readonly PreviewScenario[] = [
  scenario('feedback-normal', '反馈正常提交', ['editing', 'submitting', 'submitted'], ['从真实账号菜单打开反馈并提交，显示模拟提交结果。'], ['仅模拟服务回执，不采集日志、Trace 或截图，不上传到真实服务。']),
  { ...scenario('feedback-failed', '反馈提交失败', ['editing', 'submitting', 'failed'], ['提交后显示模拟服务失败，保留输入并允许重试。'], ['本场景持续返回模拟失败；不代表真实服务故障。']), simulation: { feedback: 'failed' } },
  { ...scenario('feedback-rate-limited', '反馈频率限制', ['editing', 'submitting', 'rate-limited'], ['提交后显示频率限制提示，保留输入。'], ['本场景持续返回模拟限流；不代表真实服务限流策略。']), simulation: { feedback: 'rate-limited' } },
]

const REVIEW_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('viewer-review-states', '待审阅修改', ['pending', 'accepted', 'rejected', 'revised'], ['从同一项目资料树的待审标记进入真实审阅页，核基线、候选与当前文件；通过真实控件作出决定。'], ['目录不固定批次或文件身份；不调用内部 Store，不代表真实 Agent 或磁盘审阅已验收。']), simulation: { reviewBatch: 'pending' } },
  { ...scenario('viewer-review-failed', '审阅失败与重试', ['pending', 'failed', 'retried'], ['合法审阅动作首次明确失败，保留待审状态，再从原 UI 重试。'], ['仅模拟当前实例首次审阅提交失败，不代表真实服务故障。']), simulation: { reviewBatch: 'fail-once' } },
  { ...scenario('viewer-review-conflict', '审阅修订冲突', ['pending', 'conflict'], ['真实提交携带当前修订围栏；候选之外的工作文件变更产生明确冲突，不静默覆盖。'], ['仅验证声明式冲突数据的 UI 消费，不授权修改用户文件。']), simulation: { reviewBatch: 'conflict' } },
]

const CLOSE_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('surface-close-states', '关闭确认', ['closed', 'open', 'completed'], ['通过共享关闭弹层选择取消、退出或最小化，记录真实 typed renderer 回调及记住选项。'], ['回调只保存在预览宿主，不关闭浏览器或发出原生窗口请求。']), simulation: { close: 'success' } },
  { ...scenario('surface-close-pending', '关闭提交等待', ['open', 'pending', 'completed'], ['实际点击后显示共享 pending 状态并禁用控件；等待有界的模拟宿主回执后完成，不代表真实跨进程时序。'], ['不模拟原生退出竞争、托盘或跨进程生命周期。']), simulation: { close: 'delayed' } },
  { ...scenario('surface-close-failed', '关闭失败与重试', ['open', 'failed', 'retried'], ['首次本地回调失败后共享弹层显示错误并保留选项，通过原按钮重试完成。'], ['仅为 renderer 回调状态演示，不代表真实宿主失败或已退出应用。']), simulation: { close: 'fail-once' } },
]

const PERMISSION_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('settings-permissions-states', '权限正常不可用', ['loaded', 'unavailable', 'query-error'], ['真实权限页消费浏览器 typed unavailable 快照；缺少权限记录时保留查询错误，不伪装已授权。'], ['仅模拟浏览器不可用快照，不查询或授予原生权限；full-disk 与 notifications 缺记录仍明确报错。']), simulation: { permissions: 'normal' } },
  { ...scenario('settings-permissions-pending', '权限加载等待', ['loading', 'unavailable', 'query-error'], ['真实查询在有界等待后返回同一不可用快照，等待期间显示真实加载状态。'], ['等待为预览桥的模拟响应，不代表原生权限弹窗或系统查询耗时。']), simulation: { permissions: 'delayed' } },
  { ...scenario('settings-permissions-failed', '权限查询失败', ['loading', 'failed', 'retry-failed'], ['查询明确失败；通过原刷新入口再次查询仍失败，不按调用次数自动恢复成功。'], ['持续模拟查询失败，不执行原生授权，也不证明真实操作系统故障或恢复。']), simulation: { permissions: 'failed' } },
]

const ACCOUNT_SCENARIOS: readonly PreviewScenario[] = [
  { ...scenario('settings-account-states', '账号地址未配置', ['loaded', 'error'], ['使用真实账号页显示账号地址未配置，不静默模拟登录成功。'], ['不连接真实账号服务，不执行授权、登录或资料修改。']), simulation: { account: 'no-base' } },
  { ...scenario('settings-account-ready', '账号模拟资料', ['loaded'], ['真实账号客户端消费当前实例的模拟协作账号资料，明确区别于真实用户。'], ['仅受审只读模拟资料，不代表真实账号登录、凭据、昵称、手机号或密码修改能力。']), simulation: { account: 'ready' } },
  { ...scenario('settings-account-pending', '账号资料等待', ['loading', 'loaded'], ['有界等待真实 HTTP 模拟响应，显示资料加载状态后呈现模拟账号。'], ['等待不代表真实账号服务耗时，不执行远程认证或资料修改。']), simulation: { account: 'delayed' } },
  { ...scenario('settings-account-failed', '账号查询失败', ['loading', 'error', 'retry-failed'], ['模拟查询持续失败；原刷新或重试入口仍显示真实错误，不按调用次数伪造成功。'], ['不代表真实账号故障或恢复，不执行账号资料修改。']), simulation: { account: 'failed' } },
  { ...scenario('settings-account-anonymous', '账号未登录', ['loaded', 'unauthorized'], ['保留模拟服务地址但不给本地能力，沿真实未登录分支显示提示。'], ['不使用真实账号凭据或假 JWT，不开放网页授权与资料修改。']), simulation: { account: 'anonymous' } },
]

const ADDITIONAL_VIEWER_SCENARIOS: Readonly<Record<string, readonly PreviewScenario[]>> = {
  'material-list': [
    { ...scenario('browsing-paged', '同源递归与分页示例', ['loaded', 'nested', 'filtered', 'no-match', 'opened'], ['原资料列表显示同一 VFS 的完整递归目录与文件，含多层受审文本；筛选、无匹配、清除及打开不改变文件源。'], ['包含明确模拟的分页文本，不访问真实磁盘、挂载或导入。']), simulation: { browsing: { seed: 'paged' } } },
    { ...scenario('browsing-empty', '真正空的项目资料', ['empty'], ['原列表成功读取空项目文件源；不是搜索无匹配，不伪造读取失败。'], ['仅文件源根为空；当前 VFS 不持久化独立空目录。']), simulation: { browsing: { seed: 'empty' } } },
    { ...scenario('browsing-listing-pending', '资料列表读取等待', ['loading', 'loaded', 'reentered'], ['仅完整资料列表 GET 有界等待，原 Spinner 结束后显示同一文件源；原入口重入再次读取。']), simulation: { browsing: { seed: 'sample', listingRead: 'delayed' } } },
    { ...scenario('browsing-listing-failed', '资料列表持续失败与恢复', ['error', 'retry-failed', 'recovered', 'independent'], ['原错误重试仍失败；Explorer 与辅助资源树独立正常。控制台明确解除实例故障后，原重试恢复，不把失败当空库。']), simulation: { browsing: { seed: 'sample', listingRead: 'failed' } } },
  ],
  explorer: [
    { ...scenario('browsing-paged', '同源递归与分页示例', ['loaded', 'nested', 'opened', 'paginated'], ['原 Explorer 按真实每页 100 项加载，更多读取后无重复；目录展开与原资料列表打开同一 VFS 文本。'], ['包含明确模拟的分页文本；不证明真实磁盘分页性能或原生文件权限。']), simulation: { browsing: { seed: 'paged' } } },
    { ...scenario('browsing-empty', '真正空的项目目录', ['empty'], ['原 Explorer 显示根目录成功空态；不把错误、等待或搜索无匹配当空目录。'], ['VFS 不持久化独立空目录；真实子空目录 UI 由 Owner 行为回归验证。']), simulation: { browsing: { seed: 'empty' } } },
    { ...scenario('browsing-explorer-pending', 'Explorer 目录读取等待', ['loading', 'loaded', 'reentered'], ['仅项目目录首读有界等待，原 Spinner 可见；离开后由原入口重入仍沿相同政策读取。']), simulation: { browsing: { seed: 'sample', explorerRead: 'delayed' } } },
    { ...scenario('browsing-explorer-failed', 'Explorer 首读失败与恢复', ['error', 'retry-failed', 'recovered', 'independent'], ['原目录错误可重试但持续失败；资料列表仍正常，控制台解除故障后原重试恢复。']), simulation: { browsing: { seed: 'sample', explorerRead: 'failed' } } },
    { ...scenario('browsing-more-pending', 'Explorer 后续页等待与旧回执', ['loaded', 'loading', 'paginated', 'retained', 'superseded', 'refreshed', 'remounted'], ['首屏 100 项可读；更多请求等待时保持旧节点并互斥。刷新或目录卸载重入使旧回执失效，新页不能追加旧响应；再次原更多读取按真实 offset 成功。']), simulation: { browsing: { seed: 'paged', explorerMore: 'delayed' } } },
    { ...scenario('browsing-more-failed', 'Explorer 分页失败保留与重试', ['loaded', 'error', 'retained', 'retried', 'paginated'], ['首次有效后续页返回声明失败，保留旧节点与明确错误；原更多按同 offset 重试成功且不重复。'], ['失败按目录与 offset 记账，非法请求不消耗政策；不是隐藏分页或缩小真实页大小。']), simulation: { browsing: { seed: 'paged', explorerMore: 'fail-once' } } },
  ],
  outputs: [
    { ...scenario('outputs-published', '已发布模拟产物', ['loaded', 'searched', 'filtered', 'collapsed', 'opened', 'reloaded'], ['沿真实项目任务产物页查看两组模拟已完成会话，按阶段、类型、文本及会话筛选；打开同一受审文件的发布快照，重载仍保持相同身份。'], ['所有发布均为模拟，不代表真实模型生成。快照从当前实例文件源捕获，发布后保持不可变；不提供真实文件导入、快照编辑、磁盘保存或原生打开。']), simulation: { artifacts: { seed: 'sample' } } },
    { ...scenario('outputs-pending', '产物会话目录读取等待', ['loading', 'loaded'], ['会话目录 GET 在途时显示原产物页 Spinner，回执后显示同一会话与发布记录。'], ['有界读取等待，不模拟模型执行或原生文件操作。']), simulation: { artifacts: { seed: 'sample', catalogRead: 'delayed' } } },
    { ...scenario('outputs-history-pending', '产物历史读取等待', ['loading', 'loaded'], ['目录返回后，逐会话历史读取在途显示原产物页 Spinner；完成后显示同一发布记录。'], ['独立模拟历史等待，不把目录返回等同历史已可用。']), simulation: { artifacts: { seed: 'sample', historyRead: 'delayed' } } },
    { ...scenario('outputs-content-pending', '已发布文件读取等待', ['request-pending', 'opened'], ['原产物列表正常，打开文件的 raw GET 在途后沿原工作区消费同一发布快照。'], ['等待期间的具体恢复或工作区占位沿原 UI，不造业务不存在的 Spinner；待公开消费核对实际表现。']), simulation: { artifacts: { seed: 'sample', contentRead: 'delayed' } } },
    { ...scenario('outputs-catalog-failed', '产物会话目录持续失败', ['error', 'retry-failed', 'recovered'], ['原产物页显示读取失败，重试仍失败；F8 显式解除当前实例故障后，原页重试恢复。'], ['不是空产物成功；故障不随请求计数消失，恢复不重建页面或修改发布记录。']), simulation: { artifacts: { seed: 'sample', catalogRead: 'failed' } } },
    { ...scenario('outputs-history-failed', '产物历史读取持续失败', ['error', 'retry-failed', 'recovered'], ['会话目录成功，但历史 GET 持续失败；原页重试不能误显示空列表，显式解除故障后恢复相同发布记录。'], ['独立历史读取政策，不通过辅助目录请求消耗错误。']), simulation: { artifacts: { seed: 'sample', historyRead: 'failed' } } },
    { ...scenario('outputs-content-failed', '已发布文件读取持续失败', ['loaded', 'error', 'retry-failed', 'recovered', 'opened'], ['产物列表成功，打开文件后原 viewer 显示错误；重试仍失败，显式解除故障后原 viewer 重试读取同一发布快照。'], ['内容故障不删除发布记录，不读取本机路径，不回落到其他项目文件。']), simulation: { artifacts: { seed: 'sample', contentRead: 'failed' } } },
    { ...scenario('outputs-delivery', '完成模拟对话后发布文件', ['empty', 'submitting', 'published', 'reentered'], ['先查看空产物，再通过原对话输入框发送消息；仅成功终态后发布当前文件快照，返回任务产物及重新进入会话时身份和事件一致。'], ['明确模拟文件发布，不调用模型或真实工具；取消和失败不产生成功交付，不模拟磁盘写入。']), simulation: { artifacts: { seed: 'empty', publishOnCompletion: true }, conversation: { mode: 'streaming', stream: 'interruptible' } } },
  ],
}

const SETTINGS_INSTRUCTIONS: Partial<Record<AccountSettingsPage, readonly string[]>> = {
  developer: ['选择明确的模拟场景后使用原开发者设置；所有 preview-only: 展示值不可认证，不复制到系统剪贴板。列表刷新会调用模拟托管准备，轮换会调用模拟刷新，但 ready/issued 均为 false、aligned 为 0，不证明真实签发或会话生效。'],
  archives: ['远端归档设置直接展示项目，支持单项或批量恢复、摘登记；任务归档入口已移至所属项目侧栏。任务场景请在资料页面选择“当前项目归档任务”等场景，不恢复旧任务标签。'],
  storage: ['打开真实数据存储页，查看虚拟数据位置与容器根；点击原“更改”按钮，从明确标注为模拟的目录选择器选择受审虚拟候选或取消。保存仅记录当前实例配置，不调用原生选择器或搬迁文件。失败后再次选择重试。'],
  files: ['在真实资料库文件设置页修改版本数量或大小，失焦或按 Enter 由原界面自动保存；高级配置当前隐藏，本切片不执行历史清理。'],
  models: ['通过正常模型设置入口的“模型服务”标签查看连接列表、搜索、详情与已选模型；空场景没有已保存连接，但保留真实界面的 ChatGPT 未添加入口。不点击测试连接、刷新模型、启停、保存或登录。'],
  notifications: ['在真实通知页修改声音开关并重载核对；本切片不触发原生系统权限，也不宣称实际声音或桌面提醒已播放。'],
  about: ['在真实关于页核对版本、修改自动下载偏好并重载；点击官网、社群和手册外链后，先用右上角关闭按钮关闭真实设置弹窗，再从预览控制台确认阻断诊断，不打开站外页面。'],
}
const ARCHIVE_SCENARIOS: readonly PreviewScenario[] = [
    { ...scenario('settings-archives-states', '任务与项目归档操作', ['populated', 'details', 'readonly', 'tree', 'restored', 'selected', 'mixed', 'cancelled', 'deleted'], ['默认任务标签展示受审已完成归档任务；原详情只读；项目导航归档树显示同一任务，恢复后回到正常任务列表。', '项目标签支持真实混合/全选和单项、批量恢复或摘登记；确认取消不发删除请求。'], ['只模拟本实例登记与历史；项目删除走真实异步 operation，只摘登记并保留虚拟文件，不操作本机目录。无搜索输入、任务批量操作或真实磁盘删除能力。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'normal', write: 'normal' } } },
    { ...scenario('settings-archives-empty', '双标签无归档记录', ['empty'], ['任务与项目标签均显示原空状态，不用请求失败冒充空库存。']), simulation: { archives: { seed: 'empty', read: 'normal', history: 'normal', write: 'normal' } } },
    { ...scenario('settings-archives-read-pending', '归档任务列表等待', ['loading', 'loaded'], ['真实归档任务 GET 在途时显示原 Spinner，回执后显示同一实例任务。'], ['项目目录沿同一缺省读取政策等待，原项目页也必须显示加载状态；不将空列表当作加载验收。']), simulation: { archives: { seed: 'sample', read: 'delayed', history: 'normal', write: 'normal' } } },
    { ...scenario('settings-archives-read-failed', '归档任务列表持续失败', ['error', 'retry-failed'], ['归档任务 GET 持续失败，原重试入口再次请求仍失败，不按次数伪造恢复。'], ['缺省政策同时使归档项目读取失败；两页各自保留原错误和重试，不自动恢复。']), simulation: { archives: { seed: 'sample', read: 'failed', history: 'normal', write: 'normal' } } },
    { ...scenario('settings-archives-history-pending', '归档任务历史等待', ['loading', 'loaded', 'readonly'], ['从原任务条目进入详情，历史 GET 等待时显示 Spinner，成功后只读显示用户、助手与工具记录。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'delayed', write: 'normal' } } },
    { ...scenario('settings-archives-history-failed', '归档任务历史持续失败', ['error', 'retry-failed'], ['任务详情历史失败，通过原错误重试按钮仍明确失败；不显示空历史作为成功。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'failed', write: 'normal' } } },
    { ...scenario('settings-archives-history-empty', '归档任务无历史', ['empty', 'readonly'], ['真实历史响应为空时显示无历史提示，编辑与发送保持禁用。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'empty', write: 'normal' } } },
    { ...scenario('settings-archives-write-pending', '归档操作等待', ['pending', 'deleted', 'restored'], ['任务删除/恢复和项目批量动作使用真实在途状态，防止已具备 busy 防护的重复操作；项目摘登记等待真实异步 operation 完成。'], ['单项和批量项目变更共用忙碌边界，等待变更及目录刷新；不运行真实任务或删除本机文件。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'normal', write: 'delayed' } } },
    { ...scenario('settings-archives-write-failed', '归档操作失败与重试', ['error', 'retried', 'deleted', 'partial', 'restored'], ['首次合法写入失败；任务删除确认保留并允许原按钮重试。项目批量首项失败、后项成功，汇总真实结果并保留失败项供重新选择恢复。'], ['失败按实例声明式政策触发，非法或跨实例请求不消耗；重试仅验证模拟 HTTP 消费，不代表真实后端恢复。']), simulation: { archives: { seed: 'sample', read: 'normal', history: 'normal', write: 'fail-once' } } },
    { ...scenario('settings-archives-required', '项目归档读取失败与显式恢复', ['project-read-error', 'project-read-retried', 'project-read-recovered', 'project-single-restore-busy'], ['项目归档读取持续失败时显示原错误与重试；F8打开预览控制台，显式恢复模拟项目读取，再由原页面重试获得目录。单项恢复等待真实变更及目录刷新，期间禁用重复动作。'], ['故障恢复由预览控制台明确触发，不按辅助请求次数或重试次数伪造恢复，不修改真实服务、项目或Store。']), simulation: { archives: { seed: 'sample', read: 'normal', projectRead: 'failed', history: 'normal', write: 'delayed' } } },
    { ...scenario('settings-archives-project-read-pending', '项目归档目录读取等待', ['project-read-loading', 'project-read-loaded'], ['项目归档 GET 等待两秒；原项目页显示读取中，不先展示成功空态，完成后显示同一实例目录。']), simulation: { archives: { seed: 'sample', read: 'normal', projectRead: 'delayed', history: 'normal', write: 'normal' } } },
    { ...scenario('settings-archives-project-read-failed', '项目归档目录持续失败', ['project-read-error', 'project-read-retried'], ['项目归档 GET 持续失败，原重试仍失败；任务读取与活动目录保持正常。'], ['不触发控制台恢复时，不自动恢复或以空项目列表冒充成功。']), simulation: { archives: { seed: 'sample', read: 'normal', projectRead: 'failed', history: 'normal', write: 'normal' } } },
  ]
const PROJECT_ARCHIVE_SCENARIOS: readonly PreviewScenario[] = ARCHIVE_SCENARIOS
  .filter(scene => !scene.simulation?.archives?.projectRead)
  .map(scene => ({
    ...scene,
    id: scene.id.replace('settings-', 'project-'),
    title: scene.title.replace('任务与项目归档操作', '当前项目归档任务').replace('双标签无归档记录', '当前项目无归档任务'),
    states: scene.states.filter(state => !['selected', 'mixed', 'partial'].includes(state)),
    expected: ['从当前项目原侧栏展开归档任务；列表只显示所属项目，另一项目的归档任务不得串入。按所选政策验证只读历史、恢复、删除及其等待、失败和重试。'],
    limitations: [...scene.limitations, '远端已移除归档设置任务标签；本场景沿项目侧栏和原只读会话消费，不恢复旧设置页或全局任务列表。'],
  }))
const PROJECT_LAYOUT_SCENARIOS: readonly PreviewScenario[] = [
  scenario('project-layout-states', '原工作区左右布局与重载', ['split', 'moved-right', 'moved-left', 'reloaded', 'narrow'], ['打开项目文件，使用原任务操作菜单将同一会话移至右侧或左侧；原标签和草稿不因换位重建，重载保留当前实例布局。最小窗核对原资料工具栏及文件操作。'], ['只复用原 Workspace 与同一偏好协议，不增加布局模拟页面；草稿不承诺跨重载持久化，不发送消息或执行模型。']),
]

const SETTINGS_SCENARIOS: Partial<Record<AccountSettingsPage, readonly PreviewScenario[]>> = {
  browser: [
    { ...scenario('settings-browser-states', '浏览器策略与历史', ['loaded', 'editing', 'saving', 'error', 'searched', 'paged', 'deleted', 'cleared', 'reloaded'], ['原设置页展示模拟策略与 24 条历史；通过原控件编辑规则、搜索分页、删除与确认清历史，重载保留同实例结果。'], ['策略和历史为场景种子，不是 Desktop 默认值；复用原设置内容的独立宿主，不改变真实浏览器功能开关或导航。', '原生网页导航、历史重新打开、CDP、下载设置、Vault、Cookie/缓存/站点数据清理均不可用；不联网，不证明真实授权或持久化安全。']), simulation: { browser: { seed: 'sample' } } },
    { ...scenario('settings-browser-empty', '浏览器无策略与历史', ['empty'], ['策略和历史读取成功但库存为空，不用错误冒充空结果。']), simulation: { browser: { seed: 'empty' } } },
    { ...scenario('settings-browser-pending', '浏览器策略与历史加载', ['loading', 'loaded'], ['策略与历史读取延迟时显示原加载说明，回执后显示原记录。']), simulation: { browser: { seed: 'sample', policyRead: 'delayed', historyRead: 'delayed' } } },
    { ...scenario('settings-browser-failed', '浏览器策略与历史持续失败', ['error', 'retry-failed'], ['读取失败保留原错误；策略原重试与历史搜索重新读取仍失败，不自动恢复。']), simulation: { browser: { seed: 'sample', policyRead: 'failed', historyRead: 'failed' } } },
    { ...scenario('settings-browser-retry', '浏览器策略原页重试', ['error', 'retried', 'loaded'], ['策略持续读取失败；F8 打开控制台显式解除当前实例故障后，关闭控制台，从原页面重试恢复同一规则。'], ['开发模式可能重复读取，故不按请求次数恢复；历史读取不消耗策略故障，也不因策略恢复改变。']), simulation: { browser: { seed: 'sample', policyRead: 'failed' } } },
    { ...scenario('settings-browser-write-pending', '浏览器策略与历史提交中', ['saving', 'saved'], ['模拟写入在途时原控件保持忙碌，回执后刷新规则或历史。']), simulation: { browser: { seed: 'sample', write: 'delayed' } } },
    { ...scenario('settings-browser-write-failed', '浏览器写入失败后重试', ['error', 'retried', 'saved'], ['首次模拟写入失败，原页面按安全策略显示不可用；原重新读取恢复未变库存及输入，再次提交后成功。']), simulation: { browser: { seed: 'sample', write: 'fail-once' } } },
  ],
  archives: ARCHIVE_SCENARIOS.filter(scene => scene.simulation?.archives?.history === 'normal').map(scene => ({
    ...scene,
    title: scene.title.replace('任务与项目归档操作', '项目归档操作').replace('双标签无归档记录', '无归档项目').replace('归档任务列表', '归档项目列表'),
    states: scene.states.filter(state => !['details', 'readonly', 'tree'].includes(state)),
    expected: ['真实归档设置仅展示项目；按所选政策验证目录读取、选择、恢复或摘登记，以及相应等待、失败、重试和确认取消。任务历史从原项目侧栏验证，不恢复旧标签。'],
  })),
  developer: [
    { ...scenario('settings-developer-states', '模拟 API Key 管理', ['loaded', 'editing', 'created', 'secret-hidden', 'revoked', 'rotated', 'reloaded'], ['原列表展示模拟普通及托管记录；通过原控件生成一次性展示值、关闭、重载、吊销及轮换。'], ['所有展示值明确不可认证，托管准备仅维护当前实例模拟摘要；不签发真实凭据、不对齐会话、不复制到系统剪贴板。账号服务不在本仓库，错误码与限额属于预览差异，不能据此宣称真实账号安全验收。']), simulation: { account: 'ready', developer: { read: 'sample', write: 'normal' } } },
    { ...scenario('settings-developer-empty', '模拟 API Key 空列表', ['empty'], ['原页面显示空列表，保留手动生成入口；该场景不补模拟托管记录。'], ['模拟托管准备返回 ready:false，不建立任何技能凭据环境。']), simulation: { account: 'ready', developer: { read: 'empty', write: 'normal' } } },
    { ...scenario('settings-developer-pending', '模拟 API Key 读取等待', ['loading', 'loaded'], ['原加载行和禁用生成入口保持到有界列表回执，随后显示同一实例记录。']), simulation: { account: 'ready', developer: { read: 'delayed', write: 'normal' } } },
    { ...scenario('settings-developer-failed', '模拟 API Key 读取失败', ['error', 'retry-failed'], ['原错误及重试入口可见；再次读取仍失败，不按请求次数伪造恢复。']), simulation: { account: 'ready', developer: { read: 'failed', write: 'normal' } } },
    { ...scenario('settings-developer-save-pending', '模拟 API Key 操作等待', ['editing', 'saving', 'created'], ['原生成动作在途禁用变更入口，单次回执后显示不可认证的模拟展示值。']), simulation: { account: 'ready', developer: { read: 'sample', write: 'delayed' } } },
    { ...scenario('settings-developer-save-failed', '模拟 API Key 操作失败重试', ['editing', 'error', 'retried', 'created'], ['首次合法变更明确失败，原名称保留；再次按原生成按钮成功，不产生半记录。']), simulation: { account: 'ready', developer: { read: 'sample', write: 'fail-once' } } },
  ],
  storage: [
    { ...scenario('settings-storage-states', '虚拟存储路径与配置', ['loaded', 'cancelled', 'saved', 'restart-required', 'reloaded'], ['显示受审虚拟路径；取消选择不发保存请求，选择候选经原 PUT 保存时提示重启，重载保留配置；生效根与已登记项目保持不变。'], ['选择器是预览宿主的虚拟目录控件，不是原生文件对话框；仅实例内存配置，不访问磁盘、不搬迁项目、不实际重启。GET 不带重启提示，重载不会重放该提示。双源读取等待和失败由独立场景覆盖，不把缺省路径当空态。']), simulation: { storage: { write: 'normal' } } },
    { ...scenario('settings-storage-save-pending', '虚拟容器根保存等待', ['loaded', 'saving', 'saved', 'restart-required'], ['选择受审虚拟候选后，原保存请求在途禁用更改按钮；有界回执后显示配置根和重启提示。'], ['仅模拟 PUT 回执等待，不证明原生选择器、磁盘写入或跨进程重启时序；读取状态与写入政策分离。']), simulation: { storage: { write: 'delayed' } } },
    { ...scenario('settings-storage-save-failed', '虚拟容器根保存失败重试', ['loaded', 'error', 'retried', 'saved'], ['首次合法保存失败，原页显示失败提示且旧路径不变；再次通过原更改按钮选择同一候选后重试成功。'], ['失败由声明式 HTTP 政策触发，不靠路径魔法；不伪造读取重试、原生文件选择或真实配置持久化。']), simulation: { storage: { write: 'fail-once' } } },
    { ...scenario('settings-storage-home-read-pending', '数据目录读取等待', ['loading', 'loaded'], ['仅数据目录读取有界等待；容器根独立显示，原加载面结束后显示虚拟目录。']), simulation: { storage: { write: 'normal', homeRead: 'delayed' } } },
    { ...scenario('settings-storage-workspace-read-pending', '容器根读取等待', ['loading', 'loaded'], ['仅容器根读取有界等待；数据目录独立显示，读取中不能更改配置。']), simulation: { storage: { write: 'normal', workspaceRead: 'delayed' } } },
    { ...scenario('settings-storage-home-read-failed', '数据目录读取失败与恢复', ['error', 'retry-failed', 'recovered'], ['数据目录持续读取失败，原重试仍失败；容器根可用。控制台明确解除当前实例故障后，原重试显示目录。']), simulation: { storage: { write: 'normal', homeRead: 'failed' } } },
    { ...scenario('settings-storage-workspace-read-failed', '容器根读取失败与恢复', ['error', 'retry-failed', 'recovered'], ['数据目录可用，容器根持续失败并禁止更改；控制台解除故障后使用原重试恢复。']), simulation: { storage: { write: 'normal', workspaceRead: 'failed' } } },
    { ...scenario('settings-storage-both-read-failed', '双源读取失败与独立重试', ['error', 'retry-failed', 'recovered'], ['两个数据来源各自显示错误和重试；解除实例故障不会直接改页面状态，必须分别原重试。']), simulation: { storage: { write: 'normal', homeRead: 'failed', workspaceRead: 'failed' } } },
    { ...scenario('settings-storage-read-required', '双源独立等待、失败与恢复', ['loading', 'error', 'recovered'], ['数据目录持续失败，容器根独立等待后显示；控制台解除故障后通过原数据目录重试恢复，不覆盖另一数据源。'], ['仅虚拟读取与明确恢复，不证明原生文件系统、真实失败注入或配置持久化。']), simulation: { storage: { write: 'normal', homeRead: 'failed', workspaceRead: 'delayed' } } },
  ],
  files: [
    { ...scenario('settings-files-states', '文件版本策略保存', ['loaded', 'invalid', 'editing', 'saved', 'reloaded'], ['读取当前模拟策略；非法值由原控件校验，合法值经失焦或 Enter 自动保存，重载保持。'], ['仅当前实例配置保存；不执行历史清理或访问真实磁盘。读取异常仍待覆盖，高级配置隐藏，不把配置回执当作版本回收或真实后端验收。']), simulation: { fileSettings: { write: 'normal' } } },
    { ...scenario('settings-files-save-pending', '文件版本策略保存等待', ['editing', 'saving', 'saved'], ['原自动保存请求在途保持忙碌且不重复提交，响应后恢复编辑。'], ['有界延迟仅模拟配置回执，不执行历史清理；读取异常及真实磁盘语义待覆盖。']), simulation: { fileSettings: { write: 'delayed' } } },
    { ...scenario('settings-files-save-failed', '文件版本策略保存失败重试', ['editing', 'error', 'retried', 'saved'], ['首次合法自动保存明确失败，保留输入；通过原错误提示重试后成功。'], ['仅模拟首次合法写入失败；不执行历史清理，不伪造读取异常或磁盘回收成功。']), simulation: { fileSettings: { write: 'fail-once' } } },
  ],
  models: [
    { ...scenario('settings-models-states', '模型连接只读样本', ['loaded', 'filtered', 'details'], ['展示受审、未启用且无密钥的模拟连接；原搜索筛选、详情与已选模型读取正常，重载仍为同一实例数据。'], ['仅模拟连接资料读取；无真实凭据或 OAuth，不执行探测、发现、推理或配置写入，原可见编辑控件不代表对应能力已接入。']), simulation: { modelProfiles: { read: 'sample' } } },
    { ...scenario('settings-models-empty', '模型连接未配置', ['empty'], ['真实界面无已保存连接和活动详情；仍保留产品的未添加厂商入口，不复制空列表页面。'], ['只读空配置，不提供真实凭据、OAuth、探测、发现或推理；不声明新增连接能力可用。']), simulation: { modelProfiles: { read: 'empty' } } },
    { ...scenario('settings-models-pending', '模型连接读取等待', ['loading', 'loaded'], ['真实连接读取在途显示加载状态，随后呈现同一受审模拟连接。'], ['延迟仅模拟 HTTP 回执；无真实凭据，不执行连接、发现或推理。']), simulation: { modelProfiles: { read: 'delayed' } } },
    { ...scenario('settings-models-failed', '模型连接读取失败', ['error', 'retry-failed'], ['读取持续失败，使用原重试入口再次查询仍显示明确错误。'], ['不按次数伪造恢复；无真实凭据，不执行连接、发现或推理。']), simulation: { modelProfiles: { read: 'failed' } } },
  ],
  notifications: [scenario('settings-notifications-states', '通知', ['loaded', 'editing', 'saving', 'error'], ['通过原声音控件修改偏好，经模拟状态服务保存并重载确认。'], ['不授予原生通知权限、不播放声音、不发送桌面通知；清除提醒需要独立 attention 写入合同和验收。'])],
  about: [scenario('settings-about-states', '关于与更新', ['loaded', 'editing', 'saving', 'error'], ['真实关于页显示预览版本并保存自动下载偏好；官网、社群与手册外链被预览桥明确阻断并记录诊断。'], ['浏览器更新状态只是原桥的固定不可更新投影，不证明真实检查、下载、安装或更新服务可用；本切片不执行更新。', '真实产品新手引导按钮当前隐藏（源码注释），不造公开入口，也不把目录登记当作引导消费已通过。'])],
}

const CONTENT_READ_VIEWERS: readonly string[] = ['markdown', 'pdf', 'code', 'image', 'office']

function contentReadScenarios(kind: string, title: string): readonly PreviewScenario[] {
  const limitations = ['仅模拟通用文档读取 HTTP 响应；不是文件格式解码错误，不证明真实后端、PDF 解析器或磁盘故障已验收。']
  return [
    { ...scenario(`viewer-${kind}-pending`, `${title} 读取等待`, ['loading', 'loaded'], ['从目录初次恢复当前文档时，内容 GET 在途显示真实应用恢复进度且尚无 viewer；响应完成后呈现同一受审文档。'], [...limitations, 'loading 指当前 App 的恢复进度，不是 viewer 内部或 Dock 加载态；当前打开路径等待文档准备完成后才切换活动标签，不用关闭重开冒称可见 Dock loading。']), simulation: { contentRead: { mode: 'delayed' } } },
    { ...scenario(`viewer-${kind}-failed`, `${title} 读取失败`, ['error', 'retry-failed', 'recovered'], ['文档读取持续失败；原重试仍显示错误。控制台显式解除故障后，关闭控制台并通过原重试打开同一文件，不重置实例或切换场景。'], limitations), simulation: { contentRead: { mode: 'failed' } } },
    { ...scenario(`viewer-${kind}-retry`, `${title} 读取失败后重试`, ['error', 'retried', 'loaded'], ['当前文档首次读取失败，从原错误界面重试后加载同一文件；不注入内部 Store。'], limitations), simulation: { contentRead: { mode: 'fail-once' } } },
  ]
}

const PAGE_DEFINITIONS: readonly [MainView, string, string, string, PreviewAvailability][] = [
  ['home', '项目中心', 'app', 'src/renderer/src/features/home/HomeOverview.tsx', PENDING],
  ['conversation', '会话', 'assistant', 'src/renderer/src/shell/ConversationSurface.tsx', PENDING],
  ['projects', '项目列表', 'project', 'src/renderer/src/features/project/feature.tsx', PENDING],
  ['resource', '资料库', 'resources', 'src/renderer/src/features/resources/feature.tsx', PENDING],
  ['literature', '文献库', 'literature', 'src/renderer/src/features/literature/feature.tsx', PENDING],
  ['writing', '写作历史占位（非独立已实现页面）', 'app', 'src/renderer/src/App.tsx', 'hidden'],
  ['browser', '内置浏览器', 'browser', 'src/renderer/src/features/browser/feature.tsx', 'hidden'],
  ['skills', '技能中心', 'skills', 'src/renderer/src/features/skills/feature.tsx', PENDING],
]

const SETTINGS_DEFINITIONS: readonly [AccountSettingsPage, string, PreviewAvailability][] = [
  ['prompts', '提示词', PENDING], ['preferences', '偏好', 'hidden'],
  ['account', '账号', 'hidden'], ['models', '模型连接', PENDING],
  ['model-settings', '模型设置兼容别名 → models', 'hidden'], ['skills', '技能设置', 'hidden'],
  ['developer', '开发者', PENDING], ['browser', '浏览器设置', 'hidden'],
  ['files', '文件', PENDING], ['storage', '数据位置', PENDING],
  ['shortcuts', '快捷键入口', 'hidden'], ['about', '关于与更新', PENDING],
  ['notifications', '通知', PENDING], ['permissions', '权限入口', 'hidden'],
  ['archives', '归档会话', PENDING],
]

const VIEWER_DEFINITIONS: readonly [string, string, string][] = [
  ['version_diff', '版本比较', 'workbench'], ['markdown', 'Markdown', 'workbench'],
  ['pdf', 'PDF', 'workbench'], ['table', '数据表', 'workbench'],
  ['code', '源码编辑', 'workbench'], ['image', '图片', 'workbench'],
  ['office', 'Office 文档与演示', 'workbench'], ['spreadsheet', '工作簿', 'workbench'],
  ['unsupported', '不支持的文件', 'workbench'], ['projects', '项目卡片', 'project'],
  ['new_tab', '项目新标签页', 'project'],
  ['library', '项目资料概览', 'project'], ['explorer', '项目浏览', 'project'],
  ['outputs', '会话产出', 'assistant'], ['project-literature', '项目文献', 'literature'],
  ['literature', '文献概览', 'literature'], ['literature_search', '文献搜索', 'literature'],
  ['material-list', '资料概览', 'resources'], ['review', '变更审查', 'resources'],
  ['web_search', '网页搜索', 'resources'],
  ['browser', '浏览器原生内容', 'browser'],
]

const SURFACE_DEFINITIONS: readonly [string, string, string, string][] = [
  ['login', '登录与首次引导', 'account', 'src/renderer/src/App.tsx'],
  ['project-form', '项目新建与编辑', 'project', 'src/renderer/src/components/business/ProjectForm.tsx'],
  ['menus', '项目、文件与会话菜单', 'shell', 'src/renderer/src/shell/ProjectMenu.tsx'],
  ['approval', '会话审批', 'assistant', 'src/renderer/src/components/business/Stream.tsx'],
  ['feedback', '反馈弹层', 'feedback', 'src/renderer/src/components/business/Feedback.tsx'],
  ['close', '关闭确认', 'shell', 'src/renderer/src/shell/Close.tsx'],
  ['error', '加载失败与错误边界', 'app', 'src/renderer/src/app/Error.tsx'],
]

export const PREVIEW_CATALOG: readonly PreviewPage[] = [
  ...PAGE_DEFINITIONS.map(([view, title, owner, source, availability]): PreviewPage => ({
    ...(view === 'projects' ? { navigation: 'hidden' as const } : {}),
    ...(view === 'home' ? { titleKey: 'pageProjectCenter' as const, entryInstructionKeys: ['homeEntry' as const] } : view === 'projects' ? { titleKey: 'areaProjects' as const } : {}),
    id: `page-${view}`, title, owner, source, entry: view, category: 'page', availability,
    implementation: view === 'writing' ? 'placeholder' : 'surface', requirementSource: REQUIREMENT_SOURCE,
    target: availability === PENDING ? { ...location(view), ...(view === 'resource' ? { projectId: PREVIEW_PROJECT_ID } : {}) } : null,
    ...(view === 'resource' ? { host: { kind: 'panel' as const, key: 'resource-tree' as const } } : {}),
    ...(view === 'browser' ? { host: { kind: 'browser' as const }, entryInstructions: ['在独立预览宿主操作原浏览器起始页、空白标签和地址栏；本入口不开放真实网页或生产浏览器导航。'] } : {}),
    ...(PRIMARY_INSTRUCTIONS[view] ? { entryInstructions: PRIMARY_INSTRUCTIONS[view] } : {}),
    scenarios: view === 'home' ? HOME_SCENARIOS : view === 'browser' ? browserSurfaceScenarios('browser', ['empty', 'loading', 'populated', 'error']) : [...(view === 'conversation' ? CONVERSATION_SCENARIOS : view === 'projects' ? PROJECT_SCENARIOS : view === 'writing'
      ? [scenario('writing-states', title, ['placeholder'], ['保留历史导航键用于追溯，不计为独立已实现页面或已接入预览。'], ['当前只有工作台占位键，没有独立 feature、模块面板或固定标签，不补造写作页面。'])]
      : [scenario(`${view}-states`, title, ['empty', 'loading', 'populated', 'error'], ['复用当前 renderer 页面展示数据与异常态。'], ['通用状态清单仍为待覆盖要求，不能从正常种子数据推断已实现空态、等待或错误模拟。'])]), ...(PRIMARY_BROWSE_SCENARIOS[view] ? [PRIMARY_BROWSE_SCENARIOS[view]!] : []), ...(view === 'literature' ? LITERATURE_SCENARIOS : []), ...(view === 'resource' ? [...PROJECT_ARCHIVE_SCENARIOS, ...PROJECT_LAYOUT_SCENARIOS] : [])],
  })),
  ...SETTINGS_DEFINITIONS.map(([page, title, availability]): PreviewPage => ({
    id: `settings-${page}`, title, owner: 'account', source: 'src/renderer/src/components/business/AccountPanel.tsx',
    entry: page, category: 'settings', availability,
    implementation: page === 'model-settings' ? 'alias' : 'surface',
    ...(page === 'model-settings' ? { aliasOf: 'settings-models' } : {}), requirementSource: REQUIREMENT_SOURCE,
    target: availability === PENDING ? location('home', page) : null,
    ...(HIDDEN_SETTINGS.includes(page) ? { host: { kind: 'settings' as const, page } } : {}),
    ...(SETTINGS_INSTRUCTIONS[page] ? { entryInstructions: SETTINGS_INSTRUCTIONS[page] } : {}),
    scenarios: SETTINGS_SCENARIOS[page] ?? (page === 'account' ? ACCOUNT_SCENARIOS : page === 'permissions' ? PERMISSION_SCENARIOS : page === 'model-settings'
      ? [scenario('settings-model-settings-states', title, ['alias'], ['既有 visiblePage 将 model-settings 解析到 models，不计为第二个模型设置页面。'])]
      : [scenario(`settings-${page}-states`, title, ['loaded', 'editing', 'saving', 'error'], ['通过原设置 UI 操作，模拟反馈明确且不写真实用户配置。'], HIDDEN_SETTINGS.includes(page) ? ['共享真实设置内容，通过预览宿主独立展示；不改变真实产品隐藏导航策略。'] : availability === PENDING ? [] : ['受策略或历史入口限制，尚无独立可展示导航目标。'])]),
  })),
  ...VIEWER_DEFINITIONS.map(([kind, title, owner]): PreviewPage => ({
    ...(kind === 'projects' ? { navigation: 'hidden' as const } : {}),
    id: `viewer-${kind}`, title, owner, source: `src/renderer/src/features/${owner}/feature.tsx`, entry: kind,
    category: 'viewer', availability: kind === 'browser' ? 'hidden' : PENDING, target: viewerEntry(kind),
    ...(kind === 'browser' ? { host: { kind: 'browser' as const }, entryInstructions: ['本 viewer 与浏览器页面使用同一原 Browser 组件和独立预览宿主，不伪造 WebContentsView、原生 frame 或外部网页。'] } : {}),
    ...(kind === 'review' || kind === 'web_search' ? { host: { kind: 'panel' as const, key: 'resource-tree' as const } } : {}),
    ...(CONTENT_READ_VIEWERS.includes(kind) ? { entryInstructions: ['正常场景通过文档深链展示原受审文件；读取等待场景从目录初次恢复，内容 GET 在途时显示 App 恢复进度且尚无 viewer，完成后显示同一文档。此进度不是 viewer 内部或 Dock loading，不采用关闭重开步骤；内容传输失败不等于格式解码或引擎故障。'] } : kind === 'review' ? { entryInstructions: ['打开隐藏模块面板，在同一项目资料树中点击 readme.md 的待审阅标记，再关闭面板查看真实审阅页；批次身份由服务投影提供。'] } : kind === 'web_search' ? { entryInstructions: ['打开隐藏模块面板，在原资料树的全网搜索输入框提交查询，再关闭面板查看真实搜索结果；仅模拟官方检索响应，不联网或导入网页。'] } : kind === 'literature_search' ? { entryInstructions: ['等待正常启动恢复模拟历史检索标签，点击“模拟文献检索：可复现研究”查看真实结果、选择与详情；不恢复隐藏搜索发起入口或模拟登录。'] } : kind === 'version_diff' ? { entryInstructions: ['打开场景后点击真实文档工具栏的版本历史，在旧版本操作中选择比较；版本身份由同一模拟项目的历史契约提供，不在目录中伪造。'] } : LIBRARY_ENTRIES[kind] ? { entryInstructions: LIBRARY_ENTRIES[kind] } : FIXED_VIEWERS[kind] ? { entryInstructions: ['打开场景后直接显示已有真实页面；此条目复用同名页面入口，不代表新增业务实现。'] } : {}),
    implementation: 'surface', requirementSource: REQUIREMENT_SOURCE,
    scenarios: kind === 'new_tab' ? [scenario('viewer-new_tab-states', title, ['opened', 'library', 'explorer', 'closed', 'reentered'], ['通过原工作区加号打开新标签页，选择项目文件或资源管理器后沿同一标签身份展示对应真实 viewer；关闭后通过原加号重新进入。'], ['这是原产品本地选择页，没有独立加载或保存请求；不虚构服务故障，不将重新打开的新标签身份当作持久化恢复。'])] : kind === 'browser' ? browserSurfaceScenarios('viewer-browser', ['loading', 'loaded', 'error']) : kind === 'review' ? REVIEW_SCENARIOS.map(scene => ({ ...scene, limitations: [...scene.limitations, '模块面板通过预览非模态容器展示；真实产品布局当前隐藏该面板，容器不作为生产导航布局一致的证据。'] })) : [{ ...scenario(`viewer-${kind}-states`, title, ['loading', 'loaded', 'error'], LIBRARY_ENTRIES[kind] || FIXED_VIEWERS[kind] || ['version_diff', 'web_search', 'literature_search'].includes(kind) ? ['经公开导航与真实交互进入所属视图，不绕过领域作用域或复制页面。'] : ['使用真实 viewer 加载匹配的模拟文件及文档身份。'], [
      ...(sampleDocument(kind === 'version_diff' ? 'markdown' : kind) ? ['已绑定受审样本；仍需逐项运行消费测试，目录登记不证明全部状态已验证。'] : ['web_search', 'literature_search'].includes(kind) ? ['已声明受审模拟搜索数据；仍需真实消费测试确认，不代表真实检索服务可用。'] : LIBRARY_ENTRIES[kind] ? ['此场景先打开所属项目；进入步骤需真实点击，不自动打开子视图，也不宣称非空文献或产物已模拟。'] : FIXED_VIEWERS[kind] ? ['复用现有页面导航；场景登记不证明非空数据或全部交互状态已验证。'] : ['尚未绑定样本项目与文档的稳定导航身份；不能只指定扩展名冒充可打开。']),
      ...(VIEWER_LIMITATIONS[kind] ?? []),
      ...(kind === 'web_search' ? ['模块面板通过预览非模态容器展示，不证明生产导航布局一致；结果为受审静态模拟候选，不联网、抓取、导入或打开外部页面。'] : kind === 'literature_search' ? ['仅消费模拟已完成历史任务，不执行真实文献检索、模型调用、登录或文献入库。'] : []),
    ]), ...(kind === 'version_diff' ? { simulation: { versionHistory: 'sample-change' as const } } : kind === 'literature_search' ? { simulation: { literatureSearch: 'results' as const } } : kind === 'web_search' ? { simulation: { webSearch: 'results' as const } } : {}) }, ...(CONTENT_READ_VIEWERS.includes(kind) ? contentReadScenarios(kind, title) : [])],
  })).map(page => ({ ...page, scenarios: [...page.scenarios, ...(ADDITIONAL_VIEWER_SCENARIOS[page.entry] ?? [])] })),
  ...SURFACE_DEFINITIONS.map(([id, title, owner, source]): PreviewPage => ({
    ...(id === 'project-form' ? { navigation: { parentPage: 'page-home', section: 'areaDaily' } as const, titleKey: 'homeProjectForm' as const, entryInstructionKeys: ['homeProjectFormEntry'] as const } : {}),
    id: `surface-${id}`, title, owner, source, entry: id, category: 'surface', availability: PENDING,
    target: SURFACE_ENTRIES[id] ? { ...location(SURFACE_ENTRIES[id].view), ...(SURFACE_ENTRIES[id].view === 'resource' ? { projectId: PREVIEW_PROJECT_ID } : {}) } : null,
    ...(SURFACE_ENTRIES[id] ? { entryInstructions: SURFACE_ENTRIES[id].instructions } : {}),
    ...(id === 'close' || id === 'error' ? { host: { kind: id }, entryInstructions: [id === 'close' ? '在隔离宿主点击关闭演示，使用共享真实关闭弹层；回调仅记录 renderer 演示结果，不关闭窗口或模拟 Windows 生命周期。' : '点击触发渲染故障，由真实 ErrorBoundary 捕获；点击恢复按钮重建局部边界，不修改应用 Store。'] } : {}),
    implementation: 'surface', requirementSource: REQUIREMENT_SOURCE,
    scenarios: id === 'project-form' ? [{ ...homeScenario('surface-project-form-states', title, ['closed', 'open', 'error'], ['homeProjectFormExpected']), titleKey: 'homeProjectForm', capabilityKeys: ['tryCreate', 'tryEditProject'] }] : id === 'approval' ? CONVERSATION_SCENARIOS.filter(item => item.id === 'conversation-approval') : id === 'feedback' ? FEEDBACK_SCENARIOS : id === 'close' ? CLOSE_SCENARIOS : [scenario(`surface-${id}-states`, title, ['closed', 'open', 'error'], ['通过所属真实 UI 的公开交互触发，不写临时 Store 状态。'], ['临时弹层不属于持久化导航；须从所属页面触发。'])],
  })),
  {
    id: 'development-components', title: 'UI 素材', owner: 'design', source: 'src/renderer/src/components/examples/ComponentsPage.tsx',
    entry: '?dev=components', category: 'development', availability: PENDING, target: location('home'),
    launch: { kind: 'components' },
    entryInstructions: ['打开场景后通过已有 ?dev=components 开发入口展示真实组件示例；切回普通场景会移除开发入口参数。'],
    implementation: 'surface', requirementSource: REQUIREMENT_SOURCE,
    scenarios: [scenario('components-states', '组件交互与主题', ['light', 'dark', 'zh', 'en', 'keyboard'], ['复用已有开发组件入口与同一设计系统。'], ['组件示例不等于全页面或 Electron 产品验收。'])],
  },
]

export function previewLaunchUrl(current: URL, pageId: string): URL {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)
  if (!page) throw new Error(`Unknown preview page: ${pageId}`)
  const url = new URL(current.href)
  url.searchParams.delete(DEVELOPMENT_PARAMETER)
  if (page.launch?.kind === 'components') url.searchParams.set(DEVELOPMENT_PARAMETER, COMPONENTS_DEVELOPMENT_ENTRY)
  return url
}
