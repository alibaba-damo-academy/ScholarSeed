import { Onboarding } from './contracts/onboarding'
import { OnboardingHost } from './features/onboarding/Onboarding'
import { sessionDisplayTitle } from './session'
import { feedback, renderFeedback } from './contracts/feedback'
import { taskTitleText } from './contracts/tasks'
import React, { useEffect, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { activeThread, AppState, MainView, useApp } from './store'
import { useThemeEffect } from './theme'
import {
  deleteSession,
  getAuthMe,
  getAuthStatus,
  getGlobalPermissionMode,
  getHealth,
  listProjects,
  type Project
} from './api'
import { AccountLogoutResult } from './account'
import { useCreditsLowWarning } from './credits'
import { logoutDesktopSession } from './logout'
import { useLiveSession } from './live'
import {
  notificationIntents,
  sessionStatusMap
} from './attention'
import type { SessionStatus } from './model'
import { AccountLogin } from './components/business/AccountLogin'
import { Landing } from './components/business/Landing'
import { AccountPanel } from './components/business/AccountPanel'
import { ProjectForm } from './components/business/ProjectForm'
import { Sidebar } from './components/business/Sidebar'
import { UpdateOverlay } from './components/business/UpdateOverlay'
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  useToast
} from './components/ui'
import { Conversation } from './shell/ConversationSurface'
import { Progress } from './components/primitive/Progress'
import { WorkbenchShell } from './shell/WorkbenchShell'
import {
  LITERATURE_TAB,
  OVERVIEW_TAB,
  PROJECTS_TAB
} from './features/workbench/tabs'
import { INITIAL_AI_PANEL_STATE } from './features/assistant/state'
import { INITIAL_LITERATURE_STATE } from './features/literature/state'
import { INITIAL_RESOURCE_STATE } from './features/resources/state'
import {
  OFFICE_RUNTIME_ROOT_ID,
  OfficeRuntimeProvider
} from './features/workbench/office/runtime'
import { featureRegistry } from './app/composition'

/** 0.2 工作台视图：这些 mainView 走四区外壳，其余走 0.1 双栏。 */
const WORKBENCH_VIEWS: MainView[] = [
  'home',
  'projects',
  'resource',
  'literature',
  'writing'
]

/** 等 Composer 注册提交入口的轮询间隔与上限。 */
const SUBMIT_ENTRY_POLL_MS = 60
const SUBMIT_ENTRY_TIMEOUT_MS = 5_000

/**
 * 等待输入框挂载完成（`__scholarseedSubmitMessage` 由 Composer 在 effect 里注册）。
 *
 * 开面板是一次 setState，Composer 要等下一轮渲染才存在；不等就提交会抢跑。
 * 超时就放行，由调用方按「提交失败」路径给出可见错误，不静默卡住。
 */
async function waitForSubmitEntry(): Promise<void> {
  const deadline = Date.now() + SUBMIT_ENTRY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (window.__scholarseedSubmitMessage) return
    await new Promise((resolve) =>
      window.setTimeout(resolve, SUBMIT_ENTRY_POLL_MS)
    )
  }
}

// 截图场景用的真实文件标签。路径对应验收项目里真实存在的文件，
// 因此拍到的是 viewer 读真文件的结果，而不是预置内容。
const MARKDOWN_TAB = {
  id: '笔记/湿度失效机理.md',
  kind: 'file' as const,
  title: '湿度失效机理.md',
  closable: true
}
const TABLE_TAB = {
  id: '实验/实验数据.csv',
  kind: 'file' as const,
  title: '实验数据.csv',
  closable: true
}
const CODE_TAB = {
  id: '实验/analyze.py',
  kind: 'file' as const,
  title: 'analyze.py',
  closable: true
}
const DOCX_TAB = {
  id: '笔记/论文草稿.docx',
  kind: 'file' as const,
  title: '论文草稿.docx',
  closable: true
}

// scene → state patch, used by the --shoot screenshot harness. Keys mirror the
// design's surfaces so a screenshot pass can validate each one against the comp.
type ScenePatch = Partial<AppState> | ((state: AppState) => Partial<AppState>)

/**
 * 文献库场景的基底：保留已拉到的真实数据，清掉全部弹层/选中/草稿。
 *
 * 必须有这一层：场景函数里写 `...state.literature` 会把**上一个场景**的 UI 态
 * 带过来——实测中筛选下拉就漏到了 `literature-batch` 的图上，遮住了标签列。
 * 不能直接用 `INITIAL_LITERATURE_STATE`：那会把 items 也清空，退化成空列表。
 */
function litBase(state: AppState): AppState['literature'] {
  return {
    ...state.literature,
    importMenuOpen: false,
    filterOpen: false,
    collectionPickerOpen: false,
    collectionDraft: null,
    rowMenu: null,
    selected: {},
    detailId: null,
    detailTab: 'basic',
    noteDraft: '',
    tagDraft: '',
    aiSearchText: '',
    notice: null
  }
}

const SCENES: Record<string, ScenePatch> = {
  main: {
    mainView: 'home',
    workspaceFilesOpen: false,
    capGallery: null,
    confirmDelete: null,
    activeSession: null,
    sidebarOpen: true,
    wdMenuOpen: false,
    homeProjectMenuOpen: false,
    modelMenuOpen: false,
    accountSettingsPage: null,
    searchHint: false,
    projectForm: null,
    composerText: '',
    composerRefs: [],
    resource: INITIAL_RESOURCE_STATE,
    literature: INITIAL_LITERATURE_STATE,
    aiPanel: INITIAL_AI_PANEL_STATE,
    tabs: [OVERVIEW_TAB],
    activeTab: OVERVIEW_TAB.id,
    globalSearchOpen: false,
    modulePanelOpen: true
  },
  projects: {
    mainView: 'projects',
    activeSession: null,
    tabs: [OVERVIEW_TAB, PROJECTS_TAB],
    activeTab: PROJECTS_TAB.id,
    modulePanelOpen: true
  },
  'home-project-menu': (state) => ({
    mainView: 'conversation',
    homeProjectMenuOpen: true,
    homeSelectedProjectId: state.projects[0]?.id ?? null
  }),
  'project-new': { projectForm: { mode: 'create' } },
  'project-edit': (state) => {
    const target = state.projects[0]
    return target
      ? { projectForm: { mode: 'edit' as const, project: target } }
      : {}
  },
  'home-model-menu': { mainView: 'conversation', modelMenuOpen: true },
  'home-composer-filled': {
    mainView: 'conversation',
    composerText:
      '帮我做一次钙钛矿湿度稳定性的文献综述：近三年，多库检索去重后读全文，按机理聚类并给出带 DOI 的出处。'
  },
  'home-at-plus-menu': { mainView: 'conversation', composerText: '@' },
  'workspace-menu': { mainView: 'conversation', wdMenuOpen: true },
  // 头像入口打开的账号菜单。--shoot 只发状态补丁、不点头像，所以这一面必须靠场景打开：
  // 剩余积分行与「获取更多」入口都在这个面板里。未登录态（harness 恒 auth off）拍到的是
  // 登录提示行，已登录态才会出现积分行。
  'account-menu': { mainView: 'conversation', accountMenuOpen: true },
  'sidebar-collapsed': { sidebarOpen: false },
  'sidebar-reference': (state) => ({
    mainView: 'conversation',
    sidebarOpen: true,
    activeSession: 'shot-lit-stability',
    sessions: [
      {
        id: 'shot-casual-weather',
        title: '闲聊场景 · 顺手问天气',
        status: 'dormant',
        createdAt: 6,
        timeLabel: '17:02'
      },
      {
        id: 'shot-lit-stability',
        title: '文献场景 · 钙钛矿湿度稳定性',
        status: 'waiting',
        createdAt: 5,
        timeLabel: '16:47'
      },
      {
        id: 'shot-lit-flow',
        title: '文献场景 · 全流程',
        status: 'waiting',
        createdAt: 4,
        timeLabel: '16:20'
      },
      {
        id: 'shot-daily-summary',
        title: '日常场景 · 读文档出结论',
        status: 'dormant',
        createdAt: 3,
        timeLabel: '14:52'
      },
      {
        id: 'shot-aging-crosscheck',
        title: '老化表 × 论文保持率 · 交叉校验',
        status: 'dormant',
        createdAt: 2,
        timeLabel: '昨天'
      },
      {
        id: 'shot-ocr',
        title: '论文复现 · Unlimited OCR W...',
        status: 'dormant',
        createdAt: 1,
        timeLabel: '昨天'
      },
      {
        id: 'shot-idea',
        title: '想法生成 · 钙钛矿湿热稳定性',
        status: 'waiting',
        createdAt: 0,
        timeLabel: '周日'
      }
    ],
    projects: state.projects.map((project) => project),
    collapsedProjects: Object.fromEntries(
      state.projects.map((project) => [project.path, true])
    )
  }),
  'workspace-files': { mainView: 'conversation', workspaceFilesOpen: true },
  skills: { accountSettingsPage: 'skills' },
  'skills-collapsed': { accountSettingsPage: 'skills', sidebarOpen: false },
  'confirm-delete': {
    confirmDelete: { label: 'Codex 会话', sessionId: 'demo-session' }
  },
  settings: {
    accountSettingsPage: 'account',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  'settings-models': {
    accountSettingsPage: 'models',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  'settings-files': {
    accountSettingsPage: 'files',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  // 暂时隐藏「键盘快捷键」页面时同步隐藏验收场景，恢复页面时一并恢复。
  // 'settings-shortcuts': {
  //   accountSettingsPage: 'shortcuts',
  //   modelMenuOpen: false,
  //   notifPanelOpen: false
  // },
  'settings-developer': {
    accountSettingsPage: 'developer',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  'settings-skills': {
    accountSettingsPage: 'skills',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  // 「关于书深」的当前版本行随更新状态变化，验收要能直接拍到这一面。
  'settings-about': {
    accountSettingsPage: 'about',
    modelMenuOpen: false,
    notifPanelOpen: false
  },
  // ===== MVP 0.2 工作台场景 =====
  // 切片重置统一由 SCENES.main 负责 (见上方 main), 因此每个场景只用写自己
  // 的增量, 不会把上一个场景的弹窗/面板带到下一张图里。
  resource: {
    mainView: 'resource',
    activeSession: null,
    modulePanelOpen: true
  },
  // 未选择项目时的工作台内容。main 基线已把 resource 切片与标签回到 INITIAL，
  // 这里只需清掉项目选中，让总览标签落到品牌空态那一支。
  'workbench-blank': {
    mainView: 'resource',
    activeSession: null,
    modulePanelOpen: true,
    homeSelectedProjectId: null,
    homeProjectLocked: false
  },
  literature: {
    mainView: 'literature',
    activeSession: null,
    modulePanelOpen: true,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id
  },
  'resource-import': {
    mainView: 'resource',
    activeSession: null,
    resource: {
      ...INITIAL_RESOURCE_STATE,
      importDialog: { phase: 'select', targetDir: '' }
    }
  },
  'resource-import-conflict': {
    mainView: 'resource',
    activeSession: null,
    resource: {
      ...INITIAL_RESOURCE_STATE,
      importDialog: {
        phase: 'resolve',
        targetDir: '',
        sources: ['/tmp/实验记录.md', '/tmp/原始数据'],
        planToken: 'sha256:resource-import-conflict-scene',
        idempotencyKey: 'resource-import-conflict-scene',
        conflicts: [
          {
            sourceIndex: 0,
            sourceName: '实验记录.md',
            sourceKind: 'file',
            targetPath: 'resources/实验记录.md',
            targetKind: 'file',
            suggestedName: '实验记录 (2).md',
            expectedTargetRevision: 'sha256:existing',
            canReplaceWithVersion: true
          },
          {
            sourceIndex: 1,
            sourceName: '原始数据',
            sourceKind: 'dir',
            targetPath: 'resources/原始数据',
            targetKind: 'dir',
            suggestedName: '原始数据 (2)',
            expectedTargetRevision: null,
            canReplaceWithVersion: false
          }
        ]
      }
    }
  },
  'ai-panel': {
    mainView: 'resource',
    activeSession: null,
    aiPanel: { ...INITIAL_AI_PANEL_STATE, open: true }
  },
  'global-search': {
    mainView: 'resource',
    activeSession: null,
    globalSearchOpen: true
  },
  writing: { mainView: 'writing', activeSession: null, modulePanelOpen: true },
  // 资料管理三个真实交互面 (右键菜单 / 删除确认 / 移动目标选择)。
  // 选中节点用真实项目树的第一个节点, 担保拍到的是真实文件名。
  //
  // 每个场景只保留 tree/root/loadState 这三个「已从后端拉到的真实数据」,
  // 其余瞬态字段一律回 INITIAL —— 直接 spread state.resource 会把上一个场景的
  // nameDraft / nodeMenu 带进下一张图, 得到两个弹层叠在一起的无效证据。
  'resource-menu': (state) => {
    const node = state.resource.tree[0]
    return {
      mainView: 'resource' as const,
      activeSession: null,
      resource: {
        ...INITIAL_RESOURCE_STATE,
        tree: state.resource.tree,
        root: state.resource.root,
        loadState: state.resource.loadState,
        selected: node?.path ?? null,
        nodeMenu: node
          ? {
              path: node.path,
              name: node.name,
              kind: node.kind,
              x: 300,
              y: 240
            }
          : null
      }
    }
  },
  'resource-delete': (state) => {
    const node = state.resource.tree[0]
    return {
      mainView: 'resource' as const,
      activeSession: null,
      resource: {
        ...INITIAL_RESOURCE_STATE,
        tree: state.resource.tree,
        root: state.resource.root,
        loadState: state.resource.loadState,
        deleteConfirm: node
          ? { path: node.path, name: node.name, kind: node.kind }
          : null
      }
    }
  },
  'resource-move': (state) => {
    const node = state.resource.tree[0]
    return {
      mainView: 'resource' as const,
      activeSession: null,
      resource: {
        ...INITIAL_RESOURCE_STATE,
        tree: state.resource.tree,
        root: state.resource.root,
        loadState: state.resource.loadState,
        moveDialog: node ? { path: node.path, name: node.name } : null
      }
    }
  },
  // 新建文档的就地输入态。
  'resource-new-doc': (state) => ({
    mainView: 'resource' as const,
    activeSession: null,
    resource: {
      ...INITIAL_RESOURCE_STATE,
      tree: state.resource.tree,
      root: state.resource.root,
      loadState: state.resource.loadState,
      nameDraft: {
        target: '',
        mode: 'create_document' as const,
        value: '研究笔记',
        suffix: '.md',
        error: null,
        submitting: false
      }
    }
  }),
  // 文献库导入菜单 (含两个显式「待实现」项)。
  'literature-import-menu': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: { ...litBase(state), importMenuOpen: true }
  }),
  // 模块面板收起 (⌘B)。
  'panel-collapsed': {
    mainView: 'resource',
    activeSession: null,
    modulePanelOpen: false
  },
  // 文献列表筛选态: 按年份倒序 + 勾选两条 (批量操作条可见)。
  // 勾选取真实条目 id, 因此必须从当前已拉到的 items 里取。
  'literature-batch': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: {
      ...litBase(state),
      importMenuOpen: false,
      detailId: null,
      tagDraft: '待阅读',
      selected: Object.fromEntries(
        state.literature.items.slice(0, 2).map((item) => [item.id, true])
      )
    }
  }),
  // 文献条目页速览 (基本信息 Tab)。
  'literature-detail': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: {
      ...litBase(state),
      importMenuOpen: false,
      selected: {},
      detailTab: 'basic' as const,
      detailId: state.literature.items[0]?.id ?? null
    }
  }),
  // 详情面板「笔记」Tab (原型 libdetail 三 Tab 之二)。
  'literature-notes': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: {
      ...litBase(state),
      importMenuOpen: false,
      selected: {},
      detailTab: 'notes' as const,
      noteDraft: '这篇的判据可直接引用到综述方法章节。',
      detailId: state.literature.items[0]?.id ?? null
    }
  }),
  // 侧栏新建分类输入框 (原型分类分组右上 + 按钮)。
  'literature-collection-new': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: {
      ...litBase(state),
      importMenuOpen: false,
      collectionsOpen: true,
      collectionDraft: { mode: 'create' as const, target: '', value: '待阅读' }
    }
  }),
  // 行右键上下文菜单 (原型 5 项)。
  'literature-row-menu': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: {
      ...litBase(state),
      importMenuOpen: false,
      detailId: null,
      rowMenu: state.literature.items[0]
        ? { id: state.literature.items[0].id, x: 700, y: 300 }
        : null
    }
  }),
  // 筛选下拉 (PDF 状态 + 四维排序)。
  'literature-filter': (state) => ({
    mainView: 'literature' as const,
    activeSession: null,
    tabs: [OVERVIEW_TAB, LITERATURE_TAB],
    activeTab: LITERATURE_TAB.id,
    literature: { ...litBase(state), importMenuOpen: false, filterOpen: true }
  }),
  // AI 面板上下文 + 暂存引用队列 (PRD「上下文附加」「暂存引用」)。
  'ai-context': {
    mainView: 'resource',
    activeSession: null,
    aiPanel: {
      ...INITIAL_AI_PANEL_STATE,
      open: true,
      refs: [
        {
          ref_id: 'ref-file-demo',
          kind: 'file',
          source_id: '笔记/湿度失效机理.md',
          label: '湿度失效机理.md',
          retention: 'session',
          origin: 'explicit'
        },
        {
          ref_id: 'ref-literature-demo',
          kind: 'literature',
          source_id: 'lit-1',
          label: 'Humidity-induced degradation pathways',
          retention: 'session',
          origin: 'explicit'
        }
      ]
    }
  },
  // AI 历史对话浮层 (多会话管理)。
  // 浮层是 portal + 锚定触发器定位的, 只写 state 拍不到它; 展开那一下由 shoot
  // harness 真实点击 ai-session-toggle 完成 (见 src/main/shoot.ts 的 SCENE_CLICKS)。
  // 选中一个真实项目, 浮层才走 project scope 拍到真实会话行而不是空态;
  // 项目 id 从真实状态里取, 不写死机器相关值。
  'ai-session-menu': (state) => ({
    mainView: 'resource' as const,
    activeSession: null,
    homeSelectedProjectId: state.projects[0]?.id ?? null,
    aiPanel: { ...INITIAL_AI_PANEL_STATE, open: true }
  }),
  // Markdown 双视图: 渲染态与源码态各拍一张 (开真实文件)。
  'markdown-render': {
    mainView: 'resource',
    activeSession: null,
    tabs: [OVERVIEW_TAB, MARKDOWN_TAB],
    activeTab: MARKDOWN_TAB.id
  },
  // 表格预览 (真实 CSV 解析)。
  table: {
    mainView: 'resource',
    activeSession: null,
    tabs: [OVERVIEW_TAB, TABLE_TAB],
    activeTab: TABLE_TAB.id
  },
  // 代码预览 (真实文件 + 行号 + 行内待实现标注)。
  code: {
    mainView: 'resource',
    activeSession: null,
    tabs: [OVERVIEW_TAB, CODE_TAB],
    activeTab: CODE_TAB.id
  },
  // DOCX 占位 (本期 C 档)。
  'docx-pending': {
    mainView: 'resource',
    activeSession: null,
    tabs: [OVERVIEW_TAB, DOCX_TAB],
    activeTab: DOCX_TAB.id
  },
  'theme-light': { theme: 'light', capGallery: null, activeSession: null },
  // Opens the newest real conversation in the sidebar so the 对话页 scene is
  // shot against a real transcript instead of invented content.
  'conversation-latest': (state) => {
    const openable = state.sessions.filter(
      (node) => !node.container && node.openable !== false
    )
    const target = openable[openable.length - 1]
    return target
      ? { mainView: 'conversation' as const, activeSession: target.id }
      : {}
  },
  'conversation-collapsed': (state) => {
    const openable = state.sessions.filter(
      (node) => !node.container && node.openable !== false
    )
    const target = openable[openable.length - 1]
    return target
      ? {
          mainView: 'conversation' as const,
          activeSession: target.id,
          sidebarOpen: false
        }
      : { sidebarOpen: false }
  }
}

/**
 * dev 专用的组件示例页。
 *
 * 只有开发构建带 `?dev=components` 才会渲染它，但它连带 `?raw` 内联的自身
 * 源码有几百 KB —— 静态导入等于让每个产品用户的首屏都背着这份开发工具。
 */
const ComponentsPage = React.lazy(() =>
  import('./components/examples').then((module) => ({
    default: module.ComponentsPage
  }))
)

export function App(): React.JSX.Element {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('dev') === 'components'
  ) {
    return (
      <React.Suspense fallback={<></>}>
        <ComponentsPage />
      </React.Suspense>
    )
  }

  return <AppRoot />
}

/**
 * 登录不是门禁: 应用外壳始终挂载, 登录层只在用户主动打开时盖上来。
 *
 * 老实现是 `authed === false` 就返回登录页 —— 退出登录 (以及任何一个 401) 都会把用户
 * 从正在看的界面上拽走, 而那个登录页自身没有出口, 于是「退出登录」等于「应用不能用了」。
 * 现在登录是账户菜单 / 账号设置里的一个入口 (`state.loginOpen`), 关掉就回到应用。
 */
function AppRoot(): React.JSX.Element {
  const { state, set } = useApp()
  const [landingOpen, setLandingOpen] = React.useState(false)
  // 失败驱动开出来的首页是 layer 变体（带 X/Esc）；冷启动那个仍是强制二选一。
  const [landingDismissible, setLandingDismissible] = React.useState(false)
  useEffect(() => {
    void window.scholarseed.setLoginWindowVisible(landingOpen || state.loginOpen)
  }, [landingOpen, state.loginOpen])

  // 冷启动首页认领：主进程闸为「本进程内首页未被关闭前每次挂载都可认领」（dev 链路
  // 启动后有一次整页 reload，一次性 claim 会被它吃掉）。登录是可选增强：只要账号服务
  // 地址在且当前未登录就显示首页；会话中登出不触发挂载，故不弹（登录不是门禁）。
  useEffect(() => {
    let alive = true
    void (async () => {
      const claimed = await window.scholarseed.claimLanding()
      if (!claimed || !alive) return
      const status = await getAuthStatus()
      if (!alive || !status?.account_base_url) return
      const me = await getAuthMe()
      if (!alive || me?.auth === true) return
      setLandingDismissible(false)
      setLandingOpen(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // 终结型交接失败驱动的首页重开（proposal 73 §6.4）。**走放宽的前置：不查 getAuthMe。**
  // 上面那条冷启动认领查 getAuthMe 是为了别给已登录用户弹首页；而 adopt_failed 那条路上
  // 主进程可能已经存好 refresh token、也设过 cookie，getAuthMe 完全可能回 auth: true ——
  // 那个前置直接不成立，首页不会弹，用户只能对着一个没有任何错误的界面猜。而「本地看起来
  // 已登录但这次交接失败了」恰恰是要展示给他的问题本身。
  useEffect(
    () =>
      window.scholarseed.onLandingReopen(() => {
        setLandingDismissible(true)
        setLandingOpen(true)
      }),
    []
  )

  const handleLogout = async (): Promise<AccountLogoutResult> => {
    const result = await logoutDesktopSession()
    // 与头像菜单的退出同源: 广播一次, 所有表面的身份一起回到未登录态。不跳转 ——
    // 登出结束的是账号态, 不该顺带把用户从当前界面上赶走。
    if (result.ok)
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
    return result
  }

  const handleAuthed = (): void => {
    set({ loginOpen: false })
    setLandingOpen(false)
    void window.scholarseed.landingDismiss()
    // 外壳在未登录期间已经挂载过 (那阵子的数据请求都吃了 401), 登录成功后得重拉:
    // 身份走 auth-restored, 项目/会话目录复用既有的刷新事件。
    window.dispatchEvent(new CustomEvent('scholarseed:auth-restored'))
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }

  const handleSkipped = (): void => {
    setLandingOpen(false)
    set({ loginOpen: false })
    void window.scholarseed.landingDismiss()
  }

  return (
    <>
      <AppMain
        onLogin={() => set({ loginOpen: true })}
        onLogout={handleLogout}
      />
      <OnboardingHost blocked={landingOpen || state.loginOpen} />
      {state.loginOpen && !landingOpen && (
        <AccountLogin
          onAuthed={handleAuthed}
          onClose={() => set({ loginOpen: false })}
          onSkipped={handleSkipped}
        />
      )}
      {landingOpen && (
        <Landing
          onAuthed={handleAuthed}
          onClose={landingDismissible ? handleSkipped : undefined}
          onSkipped={handleSkipped}
        />
      )}
    </>
  )
}

function AppMain({
  onLogin,
  onLogout
}: {
  onLogin: () => void
  onLogout: () => Promise<AccountLogoutResult>
}): React.JSX.Element {
  const { t } = useTranslation('shell')
  const { t: foundation } = useTranslation('foundation')
  const { t: accountText } = useTranslation('account')
  const { t: assistantText } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const observedStatuses = useRef<Record<string, SessionStatus>>({})
  const notificationLedgerReady = useRef(false)
  useThemeEffect(state.theme)
  useLiveSession()

  useEffect(() => {
    document.title = foundation('startup.brand')
  }, [foundation])

  useEffect(() => {
    if (notificationLedgerReady.current) {
      const intents = notificationIntents(
        observedStatuses.current,
        state.sessions,
        state.activeSession,
        document.hasFocus()
      )
      for (const intent of intents) {
        if (state.desktopNotifications) {
          void window.scholarseed
            .showNotification({
              sessionId: intent.sessionId,
              title:
                sessionDisplayTitle(intent, assistantText) ||
                t('notifications.title'),
              body: t(intent.bodyKey)
            })
            .catch(() => undefined)
        }
        if (intent.terminal && state.soundAlerts) {
          void window.scholarseed.playAlertSound().catch(() => undefined)
        }
      }
    }
    observedStatuses.current = sessionStatusMap(state.sessions)
    notificationLedgerReady.current = true
  }, [
    state.activeSession,
    state.desktopNotifications,
    state.sessions,
    state.soundAlerts,
    t,
    assistantText
  ])

  useEffect(
    () =>
      window.scholarseed.onNotificationClick((sessionId) => {
        act.openSession(sessionId)
      }),
    [act]
  )

  useEffect(() => {
    window.__scholarseedLiveTurnStatus = () => {
      const thread = activeThread(state)
      const running =
        thread.running === true ||
        thread.status === 'running' ||
        thread.status === 'waiting'
      return {
        activeSession: state.activeSession,
        runtimeId: thread.runtimeId ?? null,
        running,
        status: thread.status ?? null,
        lastSeq: thread.lastSeq,
        conversationLength: thread.conversation.length,
        todoCount: thread.todos?.length ?? 0,
        artifactCount: thread.artifacts?.length ?? 0,
        hilPending: thread.conversation.some(
          (item) =>
            item.kind === 'hil' &&
            (item.hilState === 'pending' || item.hilState === 'submitting')
        ),
        runtimeReadinessKnown: Boolean(
          thread.readiness || state.runtimeReadiness
        ),
        runtimeReady:
          thread.readiness?.ready ?? state.runtimeReadiness?.ready ?? false
      }
    }
    return () => {
      delete window.__scholarseedLiveTurnStatus
    }
  }, [state])

  // The real-turn harness invokes the exact same submit action as the visible composer.
  //
  // 0.2 默认落在工作台视图，而 Composer 只存在于 AI 面板内，面板默认收起
  // —— 此时 `__scholarseedSubmitMessage` 根本未注册，--say 会直接报「提交入口未就绪」。
  // 因此先走产品自己的路径把面板开出来（与用户点「AI 助手」等效），等 Composer
  // 挂载后再提交；这不是为测试开后门，而是补上「发消息前得先有输入框」这一步。
  useEffect(() => {
    const off = window.scholarseed?.onSay?.((msg) => {
      void (async () => {
        if (!window.__scholarseedSubmitMessage) {
          act.toggleAiPanel()
          await waitForSubmitEntry()
        }
        const submitted = await window.__scholarseedSubmitMessage?.(msg)
        if (submitted !== true) {
          set({
            petOverride: 'error',
            foregroundError:
              state.runtimeReadiness?.ready === false
                ? state.runtimeReadiness.message ||
                  feedback('shell', 'foreground.runtimeNotReady')
                : feedback('shell', 'foreground.submitNotReady')
          })
        }
      })()
    })
    return () => off?.()
  }, [act, set, state.runtimeReadiness])

  // non-blocking backend health (shell renders seed data immediately). Poll fast
  // until the backend is ready, then a slow heartbeat so we don't hit /api/healthz
  // every 1.5s for the whole session.
  useEffect(() => {
    let stop = false
    const poll = async (): Promise<void> => {
      const h = await getHealth()
      if (stop) return
      const ready = Boolean(h?.ok)
      set({
        backendReady: ready,
        serviceInstanceId: h?.service_instance_id ?? null,
        runtimeReadiness: h?.readiness ?? null,
        runtimeCapabilities: h?.capabilities ?? null
      })
      setTimeout(poll, ready ? 30_000 : 1_500)
    }
    void poll()
    return () => {
      stop = true
    }
  }, [set])

  // Serve owns the durable default. Keep the safe local fallback until the
  // backend is ready, then hydrate it for every new conversation draft.
  useEffect(() => {
    if (!state.backendReady) return
    let cancelled = false
    void getGlobalPermissionMode().then((preference) => {
      if (!cancelled && preference) {
        set({ globalPermissionMode: preference.mode })
      }
    })
    return () => {
      cancelled = true
    }
  }, [set, state.backendReady, state.serviceInstanceId])

  // screenshot harness driver
  useEffect(() => {
    const off = window.scholarseed?.onShootScene?.((scene) => {
      const patch = SCENES[scene]
      if (!patch) return
      // each scene is self-contained: reset to base ('main') then apply the delta
      set((current) => {
        const base = SCENES.main as Partial<AppState>
        const delta = typeof patch === 'function' ? patch(current) : patch
        return scene === 'main' ? delta : { ...base, ...delta }
      })
    })
    return () => off?.()
  }, [set])

  // 未登录时项目/会话目录请求会 401, 而失败屏是当时唯一渲染出来的东西 (侧栏与活动栏
  // 都在 workspaceReady 之后才挂载) —— 账户菜单里的登录入口那时根本不存在。所以这里
  // 要自己记住「见过 401」, 把失败屏的动作换成登录; 否则去掉门禁只是把死路从登录页
  // 挪到了这一屏。
  const [authRequired, setAuthRequired] = React.useState(false)
  useEffect(() => {
    const required = (): void => {
      setAuthRequired(true)
    }
    const restored = (): void => {
      setAuthRequired(false)
    }
    window.addEventListener('scholarseed:auth-required', required)
    window.addEventListener('scholarseed:auth-restored', restored)
    return () => {
      window.removeEventListener('scholarseed:auth-required', required)
      window.removeEventListener('scholarseed:auth-restored', restored)
    }
  }, [])

  const workspaceReady = state.workspaceLoadState === 'ready'
  const workspaceFailed = state.workspaceLoadState === 'error'
  const needsLogin = workspaceFailed && authRequired
  const retryWorkspaceLoad = (): void => {
    window.dispatchEvent(new CustomEvent('scholarseed:refresh-session-list'))
  }
  const workspaceTitle = needsLogin
    ? t('workspaceLoading.signInTitle')
    : workspaceFailed
      ? t('workspaceLoading.failedTitle')
      : t('workspaceLoading.loadingTitle')
  const workspaceDetail = needsLogin
    ? t('workspaceLoading.signInDetail')
    : workspaceFailed
      ? t('workspaceLoading.failedDetail')
      : state.backendReady
        ? t('workspaceLoading.syncing')
        : t('workspaceLoading.connecting')
  const workspaceAction = !workspaceFailed
    ? undefined
    : needsLogin
      ? { label: t('workspaceLoading.signIn'), run: onLogin }
      : { label: t('workspaceLoading.reload'), run: retryWorkspaceLoad }

  return (
    <OfficeRuntimeProvider>
      <div
        className={`vds-app-shell${!state.sidebarOpen ? ' is-sidebar-collapsed' : ''}`}
      >
        <div id={OFFICE_RUNTIME_ROOT_ID} className="vds-office-runtime-layer" />
        {/* PRD 2.1.1: no full-width titlebar — the sidebar owns the window row
          and the account chrome, the composer owns the model pill. */}
        {!workspaceReady ? (
          <Progress
            surface="screen"
            title={workspaceTitle}
            detail={workspaceDetail}
            error={workspaceFailed}
            actionLabel={workspaceAction?.label}
            onAction={workspaceAction?.run}
          />
        ) : (
          <div className="vds-workspace-body h-full min-h-0 min-w-0 overflow-hidden">
            {WORKBENCH_VIEWS.includes(state.mainView) ? (
              <WorkbenchShell />
            ) : (
              <>
                <Sidebar />
                <Conversation key={state.activeSession ?? 'draft'} />
              </>
            )}
          </div>
        )}

        {workspaceReady && (
          <Dialog
            open={Boolean(state.accountSettingsPage)}
            onOpenChange={(open) => {
              if (!open) act.openSettings(null)
            }}
          >
            <DialogContent
              aria-label={accountText('settings.title')}
              className="!z-[var(--vds-z-modal)] !h-[min(720px,calc(100vh-48px))] !w-[min(920px,calc(100vw-48px))] !max-w-none overflow-hidden !p-0"
              closeButtonClassName="z-[6] !right-3 !top-3"
              overlayClassName="!z-[var(--vds-z-overlay)]"
            >
              {state.accountSettingsPage && (
                <AccountPanel
                  embedded
                  page={state.accountSettingsPage}
                  onPage={act.openSettings}
                  onClose={() => act.openSettings(null)}
                  onLogin={onLogin}
                  onLogout={async () => {
                    const result = await onLogout()
                    if (result.ok) act.openSettings(null)
                    return result
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
        )}

        {workspaceReady && state.projectForm && <ProjectFormHost />}

        {workspaceReady && state.confirmDelete && <ConfirmDialog />}

        {workspaceReady && state.foregroundNotice && <ForegroundNotice />}
        {workspaceReady && state.resource.notice && <ResourceNoticeToast />}
        {workspaceReady && state.foregroundError && <ForegroundError />}

        {/* 安装/重启遮罩挂在视图分支之外：安装可从活动栏、0.1 侧栏或「关于书深」任一处
          发起，而那些表面按 mainView 互斥挂载。 */}
        <UpdateOverlay />
        {/* 积分预警同理挂在视图分支之外：对话轮在工作台与会话视图都会发生。 */}
        <CreditsWarningToast />
        {featureRegistry.globalSurfaces.map((surface) => (
          <React.Fragment key={surface.id}>{surface.render()}</React.Fragment>
        ))}
      </div>
    </OfficeRuntimeProvider>
  )
}

/** 项目弹窗宿主：成功后刷新注册表；新建还要切到新项目（PRD「新建项目」④）。 */
function ProjectFormHost(): React.JSX.Element {
  const { state, set, act } = useApp()
  const target = state.projectForm!
  return (
    <ProjectForm
      key={`${target.mode}:${target.project?.path ?? ''}`}
      target={target}
      onClose={() => set({ projectForm: null })}
      onDone={async (message, created?: Project) => {
        set({ projectForm: null, foregroundNotice: message })
        const result = await listProjects()
        if (result) {
          set({
            projects: result.projects,
            defaultWorkspacePath: result.default || state.defaultWorkspacePath
          })
        }
        // 必须排在刷新之后: selectProject 靠最新列表判断是否跨项目并决定要不要重置会话。
        if (created) {
          act.selectProject(created.id)
          act.openWorkbenchView('resource')
          Onboarding.trigger('project', created.id)
        }
      }}
    />
  )
}

function ForegroundError(): React.JSX.Element {
  const { state, set } = useApp()
  const { t, i18n } = useTranslation('shell')
  const message = renderFeedback(i18n, state.foregroundError || '')
  return (
    <div
      className="absolute left-1/2 top-14 z-[95] w-[min(760px,calc(100%_-_48px))] -translate-x-1/2"
      data-testid="foreground-error"
    >
      <Alert
        closable
        onClose={() => set({ foregroundError: null })}
        tone="error"
      >
        <div className="grid gap-[var(--vds-space-2)]">
          <AlertTitle>{t('foreground.title')}</AlertTitle>
          <div className="text-xs leading-5 text-[var(--vds-text-secondary)]">
            {t('foreground.hint')}
          </div>
          <div className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--vds-radius-3)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)] text-xs leading-5 text-[var(--vds-text-secondary)]">
            {message}
          </div>
        </div>
      </Alert>
    </div>
  )
}

function ForegroundNotice(): null {
  const { t, i18n } = useTranslation('shell')
  const { t: skills } = useTranslation('skills')
  const { state, set } = useApp()
  const { toast } = useToast()
  const message = state.foregroundNotice || ''
  // StrictMode 下 effect 会连跑两次，用已推送消息身份去重，避免 toast 重复弹出。
  const pushedRef = useRef('')
  React.useEffect(() => {
    if (!message) return
    const identity = JSON.stringify(message)
    if (pushedRef.current === identity) return
    pushedRef.current = identity
    toast({
      tone: 'success',
      title: t('notice.completed'),
      description: typeof message === 'object' && !('ns' in message)
        ? skills('installed', { name: message.name })
        : renderFeedback(i18n, message)
    })
    set({ foregroundNotice: null })
  }, [message, set, t, skills, i18n, toast])
  return null
}

/** 成功操作 Toast 的展示时间；错误提示保留到用户主动关闭。 */
const RESOURCE_NOTICE_TIMEOUT_MS = 3200

/**
 * 资料库操作反馈的全局 Toast 桥：notice 由任意视图写入（如 AI 会话导入资料
 * 库），过去只在资料库面板内受控渲染，面板未挂载时用户看不到任何反馈。这里
 * 统一推入全局共享 Toast，推完即清，避免陈旧 notice 在面板打开时二次弹出。
 */
function ResourceNoticeToast(): null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { t: taskText } = useTranslation('tasks')
  const { state, set, act } = useApp()
  const { toast } = useToast()
  const notice = state.resource.notice
  // StrictMode 下 effect 会连跑两次，用已推送消息引用去重，避免 toast 重复弹出。
  const pushedRef = useRef<typeof notice>(null)
  React.useEffect(() => {
    if (!notice || pushedRef.current === notice) return
    pushedRef.current = notice
    toast({
      action: notice.retryDraft ? (
        <Button
          data-testid="resource-notice-retry"
          size="sm"
          type="button"
          variant="link"
          onClick={act.retryResourceCreate}
        >
          {uiText('retry')}
        </Button>
      ) : notice.openTarget ? (
        <Button
          data-testid="resource-notice-open"
          size="sm"
          type="button"
          variant="link"
          onClick={() =>
            void act.openResourceFile(
              notice.openTarget!.path,
              notice.openTarget!.projectId
            )
          }
        >
          {uiText('open')}
        </Button>
      ) : undefined,
      description: (
        <>
          {'namespace' in notice.text
            ? taskText(notice.text.key, {
                name: taskTitleText(notice.text.name, taskText)
              })
            : 'destination' in notice.text
              ? t(notice.text.key, {
                  name: notice.text.name,
                  destination: notice.text.destination
                })
              : 'count' in notice.text
                ? 'name' in notice.text
                  ? t(notice.text.key, {
                      name: notice.text.name,
                      count: notice.text.count
                    })
                  : t(notice.text.key, {
                      count: notice.text.count
                    })
                : 'name' in notice.text
                  ? t(notice.text.key, { name: notice.text.name })
                  : t(notice.text.key)}
          {'namespace' in notice.text && notice.text.errorContent ? (
            <span> {notice.text.errorContent}</span>
          ) : null}
          {notice.text.detail && <span> {notice.text.detail}</span>}
        </>
      ),
      duration: notice.tone === 'ok' ? RESOURCE_NOTICE_TIMEOUT_MS : false,
      tone: notice.tone === 'ok' ? 'success' : 'error'
    })
    set((current) => ({ resource: { ...current.resource, notice: null } }))
  }, [notice, set, toast, t, taskText, uiText, act])
  return null
}

/** 积分低余额预警宿主：登录态与轮结束驱动重取余额，桶跃迁时弹一次性 toast。 */
function CreditsWarningToast(): null {
  const { state } = useApp()
  const thread = activeThread(state)
  const running =
    thread.running === true || thread.status === 'running' || thread.status === 'waiting'
  useCreditsLowWarning(state.backendReady, running, state.activeSession)
  return null
}

function ConfirmDialog(): React.JSX.Element {
  const { t } = useTranslation('shell')
  const { t: assistantText } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const cd = state.confirmDelete!
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<
    'delete.running' | 'delete.failed' | null
  >(null)

  const onDelete = async (): Promise<void> => {
    // sessionId 缺失 → 能力卡占位删除 (暂无端点), 仅关闭对话框。
    if (!cd.sessionId) {
      set({ confirmDelete: null })
      return
    }
    // 只有已知的本地失败占位才没有真实 session；普通侧栏会话不一定已载入
    // thread，仍必须走服务端删除。
    const thread = state.threads[cd.sessionId]
    if (thread && !thread.sessionId) {
      act.removeSession(cd.sessionId)
      return
    }
    setBusy(true)
    setErr(null)
    const r = await deleteSession(cd.sessionId)
    setBusy(false)
    if (r.ok) {
      act.removeSession(cd.sessionId, cd.surface) // 从本地树/线程剔除 + 关对话框
      window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
      return
    }
    if (r.status === 409) setErr('delete.running')
    else setErr('delete.failed')
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 90,
        display: 'grid',
        placeItems: 'center'
      }}
    >
      <div
        onClick={() => !busy && set({ confirmDelete: null })}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(10,9,6,0.5)'
        }}
      />
      <div
        data-testid="session-delete-confirm"
        style={{
          position: 'relative',
          width: 340,
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: 20,
          boxShadow: 'var(--shadow)',
          animation: 'cardIn .2s ease both'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            marginBottom: 10
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--c-tension)',
              color: '#fff',
              fontSize: 13
            }}
          >
            !
          </span>
          <span style={{ fontSize: 14, color: 'var(--text)' }}>
            {t('delete.title')}
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-2)',
            lineHeight: 1.6,
            marginBottom: err ? 10 : 16
          }}
        >
          {cd.sessionId ? (
            <>
              <div>{t('delete.filesRetained')}</div>
              <div style={{ marginTop: 6 }}>
                <Trans
                  t={t}
                  ns="shell"
                  i18nKey="delete.irreversible"
                  components={{
                    name: (
                      <b style={{ color: 'var(--text)' }}>
                        {sessionDisplayTitle(
                          {
                            title: cd.label,
                            title_fallback: cd.title_fallback
                          },
                          assistantText
                        )}
                      </b>
                    )
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <Trans
                t={t}
                ns="shell"
                i18nKey="delete.irreversible"
                components={{
                  name: (
                    <b style={{ color: 'var(--text)' }}>
                      {sessionDisplayTitle(
                        { title: cd.label, title_fallback: cd.title_fallback },
                        assistantText
                      )}
                    </b>
                  )
                }}
              />
            </>
          )}
        </div>
        {err && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--c-tension)',
              lineHeight: 1.5,
              marginBottom: 14
            }}
          >
            {t(err)}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
          <Button
            unstyled
            className="chip"
            onClick={() => set({ confirmDelete: null })}
            disabled={busy}
          >
            {t('delete.cancel')}
          </Button>
          <Button
            unstyled
            onClick={onDelete}
            disabled={busy}
            style={{
              background: 'var(--c-tension)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: 11.5,
              opacity: busy ? 0.6 : 1
            }}
          >
            {t(busy ? 'delete.deleting' : 'delete.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
