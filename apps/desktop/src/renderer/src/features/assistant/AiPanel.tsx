import { PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding'
import { sessionDisplayTitle } from '../../session'
import { useTranslation } from 'react-i18next'
import { referenceBaseLabel, referenceLabel, sessionTimeLabel } from './text'
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  EllipsisVertical,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Pencil,
  RotateCcwClock,
  Trash,
  X,
} from 'lucide-react'

import { getSkills, renameSession, terminateSession, type ServeSession } from '../../api'
import { createFormatters } from '../../../../localization/format'
import { Composer } from '../../components/business/Composer'
import { LoginPrompt } from '../../components/business/LoginPrompt'
import { ComposerRefChip } from '../../components/business/RefChip'
import { ConversationControls, Stream } from '../../components/business/Stream'
import { TodoPanel } from '../../components/business/TodoPanel'
import { TaskStatus } from '../../components/business/TaskStatus'
import { sessionNeedsAttention } from '../../attention'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import { IconFont } from '../../components/primitive/Iconfont'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Command,
  CommandItem,
  CommandList,
  EllipsisText,
  EmptyState,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchBox,
  Tooltip,
  cx,
  type IconButtonProps,
} from '../../components/ui'
import { Icon } from '../../icons'
import { feedback } from '../../contracts/feedback'
import { pendingAssistantContextRefs } from '../../contracts/assistant'
import { SESSION_TITLE_MAX_LENGTH } from '../../model'
import { focusComposer } from '../../reference'
import { SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { activeThread, assistantProject, useApp } from '../../store'
import { findSessionNode, serveSessionNode } from '../../tree'
import { useAttention } from './attention'
import { AssistantContextQuote } from './Quote'
import { AnnotationSummary, annotationDisplay } from './Notes'
import { Translation } from './Translation'
import { TaskOverviewBody } from './Overview'
import { assistantHeadingScope, truncateProjectName } from './heading'
import { listTaskHistory } from './history'
import {
  AI_TASK_STARTERS,
  AI_TASK_STARTER_SKILL_NAMES,
  resolveTaskStarterSkill,
  type TaskStarterSkillFailure,
} from './starters'

const PROJECT_SESSION_LIMIT = 30
const FLOATING_PANEL_MARGIN_PX = 12
const FLOATING_PANEL_MIN_WIDTH_PX = 320
const FLOATING_PANEL_MIN_HEIGHT_PX = 420

/**
 * 历史对话浮层：与「打开项目」浮层同族 —— 白底气泡 + 顶部搜索 + 单行列表。
 *
 * 行高、字号、内边距取设计 token；列表滚动高度由 CommandList 自己的
 * --vds-command-list-max-height 拥有，这里不重复声明。
 * 水平方向不再用固定宽度：与输入框同宽同左（浮层收在会话区域内、
 * 宽度随区域自适应，区域过宽时同输入框一起被内容列宽封顶并居中），
 * 经 PopoverContent 的 inline style 覆盖定位层；垂直方向仍贴历史按钮下方（side="bottom"）。
 */
const SESSION_FLYOUT_CLASS_NAME =
  'gap-[var(--vds-space-1)] ![padding:var(--vds-space-2)] !max-w-none'
/* 行 hover/选中背景与左侧菜单（lit-nav-row 等）对齐：同取 --vds-bg-gray-hover，
   不用品牌浅绿底，避免浮层内颜色突兀。 */
const SESSION_ROW_CLASS_NAME =
  'group relative flex min-w-0 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] hover:[background:var(--vds-bg-gray-hover)]'
const SESSION_ROW_ACTIVE_CLASS_NAME =
  '![background:var(--vds-bg-gray-hover)] hover:![background:var(--vds-bg-gray-hover)]'
const SESSION_ITEM_CLASS_NAME =
  'min-w-0 flex-1 !bg-transparent ![min-height:var(--vds-control-height-standard)]'
const SESSION_TITLE_CLASS_NAME =
  'text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
const SESSION_TITLE_ACTIVE_CLASS_NAME = '!text-[var(--vds-brand-bg-default)]'
const SESSION_TIME_CLASS_NAME =
  'flex-none text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)] transition-[opacity] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] group-hover:opacity-0'
/** 该行操作菜单展开时，时间与悬停态同样让位给「更多」。 */
const SESSION_TIME_HIDDEN_CLASS_NAME = 'opacity-0'
/** 行内「更多」绝对叠在时间槽上：默认不占位也不可见，悬停/聚焦/菜单展开才显现并替换时间。 */
const SESSION_MORE_CLASS_NAME = [
  'absolute right-0 top-1/2 -translate-y-1/2',
  'opacity-0 pointer-events-none transition-[opacity]',
  'duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'group-hover:[opacity:var(--vds-opacity-full)] group-hover:pointer-events-auto',
  'focus-visible:[opacity:var(--vds-opacity-full)] focus-visible:pointer-events-auto',
  'aria-expanded:[opacity:var(--vds-opacity-full)] aria-expanded:pointer-events-auto',
].join(' ')
const SESSION_MORE_VISIBLE_CLASS_NAME = '![opacity:var(--vds-opacity-full)] !pointer-events-auto'
const SESSION_ACTION_MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} gap-[var(--vds-space-1)]`
const SESSION_ACTION_ITEM_CLASS_NAME = 'w-full justify-start'
const SESSION_ACTION_DANGER_CLASS_NAME =
  '!text-[var(--vds-error-text-primary)] [&_svg]:!text-current'
const SESSION_ERROR_CLASS_NAME =
  'px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-error-text-primary)]'

type FloatingDrag = {
  pointerId: number
  offsetX: number
  offsetY: number
}

type FloatingResize = {
  pointerId: number
  edge: 'left' | 'right'
  startX: number
  startY: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * 面板头部右上角的图标动作。
 *
 * 提示统一走原子组件 `Tooltip`（而不是原生 `title`）：原生 title 由系统绘制，
 * 延迟、位置和样式都不可控，也拿不到设计系统的文字/圆角/阴影 token。
 * `IconButton` 默认把 `label` 写进 `title`，所以这里显式传 `title={undefined}` 关掉它，
 * 避免和 Tooltip 叠成两层提示；`label` 仍然提供 `aria-label`，
 * 于是提示文案与无障碍名称共用同一个来源。
 */
function HeadAction({ label, ...props }: IconButtonProps): React.JSX.Element {
  return (
    <Tooltip content={label} side="bottom">
      <IconButton label={label} size="md" title={undefined} variant="ghostIcon" {...props} />
    </Tooltip>
  )
}

/**
 * AI 对话面板（PRD「AI对话能力」）。
 *
 * 关键架构决定：面板**复用** 0.1 已有的 `Stream` + `Composer`，而不是自建
 * 一条对话链路。两者都从 store 的 `activeThread(state)` 取数、不吃 props，
 * 因此直接挂进来就得到真实的会话通道 —— 真实 LLM、真实 HIL 权限卡、技能、
 * 附件、中断续跑全部沿用，0.2 无需重新实现，也不会与 0.1 行为分叉。
 *
 * 面板自身只负责 0.2 新增的外围：多会话入口、上下文附加、
 * 暂存引用队列、存入资料库/文献库。
 */
export function AiPanel({
  sidebarVisible = true,
  embedded = false,
  compact = false,
  inlineComposer = false,
  hideHeader = false,
  headerCollapsed = false,
  workspaceLeading,
  workspaceActions,
  onToggleContent,
  floatingContent,
}: {
  sidebarVisible?: boolean
  embedded?: boolean
  compact?: boolean
  inlineComposer?: boolean
  hideHeader?: boolean
  headerCollapsed?: boolean
  workspaceLeading?: React.ReactNode
  workspaceActions?: React.ReactNode
  onToggleContent?: () => void
  floatingContent?: {
    side: 'top' | 'bottom'
    height: number
    anchorHeight: number
    headingHeight: number
  }
}): React.JSX.Element {
  const { t, i18n } = useTranslation('assistant')
  const { t: layoutText } = useTranslation('layout')
  const contentId = React.useId()
  const { t: literatureText } = useTranslation('literature')
  const { t: componentText } = useTranslation('components')
  const { state, set, composerDraft, act } = useApp()
  const ai = state.aiPanel
  const thread = activeThread(state)
  const reminders = useAttention()
  const currentSession = thread.sessionId
    ? findSessionNode(state.sessions, thread.sessionId)
    : undefined
  const sessionTimeFormat = useMemo(() => createFormatters(state.lang), [state.lang])
  const [sessionRows, setSessionRows] = useState<ServeSession[] | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const deferredSessionQuery = useDeferredValue(sessionQuery)
  const [sessionListState, setSessionListState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  )
  const [sessionRenameId, setSessionRenameId] = useState<string | null>(null)
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [sessionActionPopoverId, setSessionActionPopoverId] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<
    'panel.nameRequired' | 'panel.renameFailed' | 'panel.terminateFailed' | null
  >(null)
  const [sessionSaving, setSessionSaving] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState<{
    left: number
    top: number
  } | null>(null)
  const [floatingSize, setFloatingSize] = useState<{
    width: number
    height: number
  } | null>(null)
  const floatingDrag = useRef<FloatingDrag | null>(null)
  const floatingResize = useRef<FloatingResize | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const previousCompact = useRef(compact)
  useEffect(() => {
    if (previousCompact.current && !compact && !inlineComposer) focusComposer()
    previousCompact.current = compact
  }, [compact, inlineComposer])
  // 输入框所在的会话内容列（由 Composer 透传）：历史浮层据此对齐，做到与输入框同宽同左。
  const composerInputBoxRef = useRef<HTMLDivElement | null>(null)
  const [sessionFlyoutBounds, setSessionFlyoutBounds] = useState<{
    left: number
    width: number
  } | null>(null)
  const sessionListRequest = useRef(0)
  const sessionSearchRef = useRef<HTMLInputElement | null>(null)
  const sessionListScope = useRef<{ projectPath: string | null; query: string }>({
    projectPath: null,
    query: '',
  })
  const taskStarterRequest = useRef(0)
  const [taskStarterPending, setTaskStarterPending] = useState<string | null>(null)
  const [loginSkill, setLoginSkill] = useState<string | null>(null)
  const renameCancelled = useRef(false)
  const projectPath = assistantProject(state).projectPath
  const projectName = state.projects.find((project) => project.path === projectPath)?.name ?? null
  const headingScope = assistantHeadingScope(
    ai.cover || embedded,
    sidebarVisible && (!embedded || state.modulePanelOpen),
    projectName,
    !projectPath && state.mainView === 'literature',
    literatureText('navigation.overview')
  )

  const patch = (next: Partial<typeof ai>): void => set({ aiPanel: { ...ai, ...next } })

  const startTask = async (starter: (typeof AI_TASK_STARTERS)[number]): Promise<void> => {
    const request = ++taskStarterRequest.current
    setTaskStarterPending(starter.skillName)
    let skills
    try {
      skills = await getSkills(SKILL_SURFACE_SETTINGS, i18n.resolvedLanguage || i18n.language)
    } catch {
      if (request === taskStarterRequest.current) {
        set({ foregroundError: feedback('components', 'composer.skillFailed') })
        setTaskStarterPending(null)
      }
      return
    }
    if (request !== taskStarterRequest.current) return
    const result = resolveTaskStarterSkill(skills, starter.skillName)
    if (result.failure === 'login_required') {
      setLoginSkill(t(starter.titleKey))
      setTaskStarterPending(null)
      return
    }
    if (result.failure) {
      const failureKeys: Record<
        Exclude<TaskStarterSkillFailure, 'login_required'>,
        | 'composer.skillMissing'
        | 'composer.skillDisabled'
        | 'composer.skillDependencies'
        | 'composer.skillPath'
      > = {
        missing: 'composer.skillMissing',
        disabled: 'composer.skillDisabled',
        dependencies: 'composer.skillDependencies',
        path: 'composer.skillPath',
      }
      set({
        foregroundError: feedback('components', failureKeys[result.failure], {
          name: starter.skillName,
        }),
      })
      setTaskStarterPending(null)
      return
    }
    act.askAiFromPanel(t(starter.promptKey), 'taskType' in starter ? starter.taskType : undefined)
    set((current) => ({
      composerRefs: [
        ...current.composerRefs.filter(
          (reference) =>
            reference.type !== 'skill' || !AI_TASK_STARTER_SKILL_NAMES.has(reference.id)
        ),
        result.reference,
      ],
      foregroundError: null,
    }))
    setTaskStarterPending(null)
    focusComposer({ selectionStart: 0, selectionEnd: 0 })
  }

  /**
   * 拉一次会话目录。
   *
   * query 由调用方给，不从闭包里读输入框：预热（面板刚打开、浮层还没开）必须用
   * 空串，浮层内用当前输入。两者共用同一份取数与竞态守卫（requestId），
   * 所以不会出现「预热结果覆盖搜索结果」这种后到者赢的错乱。
   *
   * loading 只表达「这一次请求在飞」，不代表列表要清空：已有行会继续渲染，
   * 刷新期间不闪空态、不改气泡高度（见下方列表相位）。
   */
  useLayoutEffect(() => {
    sessionListRequest.current += 1
    if (
      sessionListScope.current.projectPath !== projectPath ||
      sessionListScope.current.query !== sessionQuery
    ) {
      sessionListScope.current = { projectPath, query: sessionQuery }
      setSessionRows([])
    }
    return () => {
      sessionListRequest.current += 1
    }
  }, [projectPath, sessionQuery, ai.open, ai.sessionMenuOpen])

  const fetchSessions = useCallback(
    async (query: string): Promise<void> => {
      const requestId = sessionListRequest.current + 1
      sessionListRequest.current = requestId
      setSessionListState('loading')
      const sessions = await listTaskHistory(
        projectPath
          ? {
              limit: PROJECT_SESSION_LIMIT,
              scope: 'project',
              projectPath,
              query,
            }
          : {
              limit: PROJECT_SESSION_LIMIT,
              scope: 'unassigned',
              query,
            },
        () => requestId === sessionListRequest.current
      )
      if (requestId !== sessionListRequest.current) return
      if (sessions === null) {
        setSessionListState('error')
        return
      }
      setSessionRows(sessions)
      setSessionListState('ready')
    },
    [projectPath]
  )

  const loadProjectSessions = useCallback(
    (): Promise<void> => fetchSessions(deferredSessionQuery),
    [deferredSessionQuery, fetchSessions]
  )

  // 面板一打开就把历史目录预热到手：用户点开气泡时行已经在内存里，气泡第一帧
  // 就是最终高度，不会先画一个空壳再跳成列表（那就是「闪一下再显示」）。
  // 浮层开着时不预热 —— 那时取数归浮层自己（带当前搜索词），避免两路互相覆盖。
  useEffect(() => {
    if (!ai.open || ai.sessionMenuOpen) return
    void fetchSessions('')
  }, [ai.open, ai.sessionMenuOpen, fetchSessions])

  useEffect(() => {
    if (!ai.sessionMenuOpen) {
      sessionListRequest.current += 1
      setSessionQuery('')
      return
    }
    void loadProjectSessions()
  }, [ai.sessionMenuOpen, loadProjectSessions])

  // 历史浮层水平方向与输入框内容列对齐：同宽同左，宽度随会话区域自适应（区域过宽时
  // 同输入框一起被内容列宽封顶并居中）。垂直方向仍由浮层定位层贴历史按钮下方，这里只覆盖 left/width。
  // 观察面板而非内容列：内容列被封顶后宽度不再变、但面板变宽会改变其居中 left，ResizeObserver 需盯面板才能捕获。
  useLayoutEffect(() => {
    if (!ai.sessionMenuOpen) {
      setSessionFlyoutBounds(null)
      return undefined
    }
    const panel = panelRef.current
    if (!panel) return undefined
    const update = (): void => {
      const box = composerInputBoxRef.current
      if (!box) return
      const rect = box.getBoundingClientRect()
      const left = rect.left
      const width = rect.width
      setSessionFlyoutBounds((current) =>
        current && current.left === left && current.width === width ? current : { left, width }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [ai.sessionMenuOpen])

  useEffect(() => {
    const refresh = (): void => {
      if (ai.sessionMenuOpen) void loadProjectSessions()
    }
    window.addEventListener('scholarseed:refresh-session-list', refresh)
    return () => window.removeEventListener('scholarseed:refresh-session-list', refresh)
  }, [ai.sessionMenuOpen, loadProjectSessions])

  const sessionNodes = useMemo(
    () =>
      (sessionRows ?? [])
        .filter((row) => state.threads[row.session_id]?.surface !== 'workbench')
        .map((row) => serveSessionNode(row, state.sessionActivitySeen, state.activeSession)),
    [sessionRows, state.activeSession, state.sessionActivitySeen, state.threads]
  )
  const sessionRowsById = useMemo(
    () => new Map((sessionRows ?? []).map((row) => [row.session_id, row])),
    [sessionRows]
  )
  // 列表相位：还没拿到任何结果（idle/loading）才算「加载中」。
  // 有行时刷新不回到加载态，也不插占位行 —— 气泡高度只由真实行数决定。
  const listPending = sessionListState !== 'ready' && sessionListState !== 'error'

  const beginSessionRename = (sessionId: string, title: string): void => {
    renameCancelled.current = false
    setSessionActionError(null)
    setSessionRenameId(sessionId)
    setSessionRenameDraft(title)
  }

  const commitSessionRename = async (): Promise<void> => {
    if (renameCancelled.current || !sessionRenameId || sessionSaving) return
    const title = sessionRenameDraft.trim()
    if (!title) {
      setSessionActionError('panel.nameRequired')
      return
    }
    const original = sessionRows?.find((row) => row.session_id === sessionRenameId)
    if (original?.title === title) {
      setSessionRenameId(null)
      return
    }
    setSessionSaving(true)
    const result = await renameSession(sessionRenameId, title)
    setSessionSaving(false)
    if (!result.ok) {
      setSessionActionError('panel.renameFailed')
      return
    }
    const savedTitle = result.title ?? title
    act.renameSessionTitle(sessionRenameId, savedTitle, result.title_fallback)
    setSessionRows(
      (current) =>
        current?.map((row) =>
          row.session_id === sessionRenameId
            ? { ...row, title: savedTitle, title_fallback: result.title_fallback ?? null }
            : row
        ) ?? current
    )
    setSessionRenameId(null)
    setSessionActionError(null)
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }

  // 面板打开时若还没有会话，开一条草稿会话，让输入框立刻可用。
  // 会话真正创建发生在首条消息发送时（沿用 0.1 的 openSession 时机）。
  // 用 startPanelDraft 而不是 startDraft：后者带 HOME_RESET，会把视图踢回 0.1 首页。
  useEffect(() => {
    if (!ai.open) return
    if (state.activeSession === null && !state.turnLaunch) {
      // 已有草稿就不要覆盖用户正在写的内容。
      if (composerDraft.getSnapshot().length === 0 && state.composerRefs.length === 0) {
        act.startPanelDraft()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.open])

  const sessionTitle = state.activeSession
    ? sessionDisplayTitle(thread, t) || t('panel.current')
    : t('panel.new')
  const startFloatingDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (ai.docked || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!bounds) return
    event.currentTarget.setPointerCapture(event.pointerId)
    floatingDrag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    setFloatingPosition({ left: bounds.left, top: bounds.top })
  }

  const moveFloatingPanel = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = floatingDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const panel = event.currentTarget.parentElement
    if (!panel) return
    const left = Math.max(
      FLOATING_PANEL_MARGIN_PX,
      Math.min(
        event.clientX - drag.offsetX,
        window.innerWidth - panel.offsetWidth - FLOATING_PANEL_MARGIN_PX
      )
    )
    const top = Math.max(
      FLOATING_PANEL_MARGIN_PX,
      Math.min(
        event.clientY - drag.offsetY,
        window.innerHeight - panel.offsetHeight - FLOATING_PANEL_MARGIN_PX
      )
    )
    setFloatingPosition({ left, top })
  }

  const stopFloatingDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (floatingDrag.current?.pointerId !== event.pointerId) return
    floatingDrag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const startFloatingResize = (
    event: React.PointerEvent<HTMLDivElement>,
    edge: FloatingResize['edge']
  ): void => {
    if (ai.docked || event.button !== 0) return
    const panel = event.currentTarget.parentElement
    if (!panel) return
    const bounds = panel.getBoundingClientRect()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    floatingResize.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
    setFloatingPosition({ left: bounds.left, top: bounds.top })
    setFloatingSize({ width: bounds.width, height: bounds.height })
  }

  const resizeFloatingPanel = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = floatingResize.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const deltaX = event.clientX - resize.startX
    const right = resize.left + resize.width
    const left =
      resize.edge === 'left'
        ? Math.max(
            FLOATING_PANEL_MARGIN_PX,
            Math.min(resize.left + deltaX, right - FLOATING_PANEL_MIN_WIDTH_PX)
          )
        : resize.left
    const width =
      resize.edge === 'left'
        ? right - left
        : Math.max(
            FLOATING_PANEL_MIN_WIDTH_PX,
            Math.min(
              resize.width + deltaX,
              window.innerWidth - resize.left - FLOATING_PANEL_MARGIN_PX
            )
          )
    const height = Math.max(
      FLOATING_PANEL_MIN_HEIGHT_PX,
      Math.min(
        resize.height + event.clientY - resize.startY,
        window.innerHeight - resize.top - FLOATING_PANEL_MARGIN_PX
      )
    )
    setFloatingPosition({ left, top: resize.top })
    setFloatingSize({ width, height })
  }

  const stopFloatingResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (floatingResize.current?.pointerId !== event.pointerId) return
    floatingResize.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // ContextRefs 属于当前 Session，但视觉上属于“下一次发送”的输入工作区，
  // 因此通过 Composer 插槽渲染在输入框内部，而不是占据面板顶部的一整条工具栏。
  const visibleRefs = thread.readOnly
    ? []
    : pendingAssistantContextRefs(ai.refs, ai.submittedRefIds)
  const noteRefs = visibleRefs.filter((ref) => ref.kind === 'note')
  const otherRefs = visibleRefs.filter((ref) => ref.kind !== 'note')
  const noteAnnotations = noteRefs.flatMap((ref) => {
    const annotation = ai.annotations.find((item) => item.annotation_id === ref.source_id)
    return annotation ? [annotationDisplay(annotation)] : []
  })
  const contextLabel = (ref: (typeof otherRefs)[number]): string => referenceLabel(ref, t)
  const contextWorkspaceHasContent =
    ai.contextState === 'loading' || ai.contextState === 'saving' || visibleRefs.length > 0
  const contextWorkspace = (
    <div
      className={`grid min-w-0 gap-[var(--vds-space-2)]${contextWorkspaceHasContent ? ' mb-1' : ''}`}
      data-testid="ai-context-workspace"
    >
      {ai.contextState === 'loading' || ai.contextState === 'saving' ? (
        <div
          className="vds-ai-context-empty px-[var(--vds-space-1)] py-[calc(var(--vds-space-3)+var(--vds-space-half))] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-ai-context-empty-line-height)] text-[var(--wb-muted)]"
          data-testid="ai-context-loading"
        >
          {ai.contextState === 'loading' ? t('panel.loadingContext') : t('panel.savingContext')}
        </div>
      ) : visibleRefs.length > 0 ? (
        <>
          <AnnotationSummary
            annotations={noteAnnotations}
            numberForAnnotation={(annotationId) => {
              // 与消息列表内联标识同一编排: 单条回答内注释创建顺序(从 1 开始)
              const raw = ai.annotations.find((item) => item.annotation_id === annotationId)
              if (!raw) return 1
              return (
                ai.annotations
                  .filter((item) => item.source_item_id === raw.source_item_id)
                  .findIndex((item) => item.annotation_id === annotationId) + 1
              )
            }}
            onClear={() => {
              // 输入框内删除注释时同步删除注释实体, 消息列表内联标识随之移除
              void act.deleteAnswerAnnotations(noteRefs.map((ref) => ref.source_id))
            }}
            onEdit={(annotationId, comment) => act.updateAnswerAnnotation(annotationId, comment)}
            onRemove={(annotationId) => act.deleteAnswerAnnotation(annotationId)}
            testId="ai-context-ref"
          />
          {otherRefs.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-[var(--vds-space-1)]">
              {otherRefs.map((ref) => {
                const tag = (
                  <ComposerRefChip
                    key={ref.ref_id}
                    title={contextLabel(ref)}
                    data-testid="ai-context-ref"
                    tabIndex={ref.anchor ? 0 : undefined}
                    icon={
                      <Icon
                        name={
                          ref.anchor
                            ? 'quote'
                            : ref.kind === 'literature'
                              ? 'books'
                              : ref.kind === 'dir'
                                ? 'folder'
                                : 'doc'
                        }
                        size={12}
                      />
                    }
                    label={contextLabel(ref)}
                    suffix={ref.kind === 'dir' ? t('panel.directoryOnDemand') : undefined}
                    closeLabel={t('panel.remove', { name: contextLabel(ref) })}
                    onClose={() => void act.detachAiContext(ref.ref_id)}
                  />
                )
                if (!ref.anchor) return tag
                const sourceLabel = referenceBaseLabel(ref, t)
                return (
                  <HoverCard key={ref.ref_id}>
                    <HoverCardTrigger asChild>{tag}</HoverCardTrigger>
                    <HoverCardContent
                      className="!w-80 max-w-[calc(100vw-48px)] p-[var(--vds-space-3)]"
                      side="top"
                    >
                      <AssistantContextQuote
                        label={sourceLabel}
                        sourceId={t('panel.selected')}
                        text={ref.anchor?.preview_text ?? ''}
                        onOpenSource={() => {
                          if (ref.kind === 'literature') {
                            void act.openLiteratureAttachment(
                              ref.source_id,
                              ref.anchor?.document_id ?? undefined
                            )
                            return
                          }
                          act.openResourceFile(
                            ref.source_id,
                            state.homeSelectedProjectId ?? undefined
                          )
                        }}
                      />
                    </HoverCardContent>
                  </HoverCard>
                )
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {ai.contextError && (
        <div
          className="vds-ai-context-empty px-[var(--vds-space-1)] py-[calc(var(--vds-space-3)+var(--vds-space-half))] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-ai-context-empty-line-height)] text-[var(--wb-muted)] is-error"
          data-testid="ai-context-error"
        >
          {'raw' in ai.contextError
            ? ai.contextError.raw
            : t(ai.contextError.key, { detail: ai.contextError.detail ?? '' })}
        </div>
      )}
    </div>
  )

  return (
    <aside
      className={
        embedded
          ? 'vds-ai-panel flex flex-col min-w-0 bg-[var(--vds-bg-gray-default)] is-docked !relative !inset-auto !h-full !w-full !min-w-0 !max-w-none !flex-1 !rounded-none !border-0 !shadow-none'
          : `vds-ai-panel flex flex-col min-w-0 bg-[var(--vds-bg-gray-default)]${ai.docked ? ' is-docked flex-1 w-full h-full' : ' is-floating fixed z-[var(--vds-z-floating-panel)] top-[var(--vds-assistant-floating-panel-top)] right-[var(--vds-assistant-floating-panel-right)] w-[var(--vds-assistant-floating-panel-width)] h-[var(--vds-assistant-floating-panel-height)] min-w-[var(--vds-assistant-floating-panel-min-width)] min-h-[var(--vds-assistant-floating-panel-min-height)] max-w-[var(--vds-assistant-floating-panel-max-width)] max-h-[var(--vds-assistant-floating-panel-max-height)] border border-[var(--vds-border-default)] rounded-[var(--vds-assistant-floating-panel-radius)] shadow-[var(--vds-assistant-floating-panel-shadow)] overflow-hidden resize-none'}${ai.cover ? ' is-cover flex-1' : ''}`
      }
      data-testid="ai-panel"
      ref={panelRef}
      style={
        floatingContent && !compact
          ? { minHeight: floatingContent.anchorHeight || 'var(--vds-floating-composer-height)' }
          : !embedded && !ai.docked
            ? { ...floatingPosition, ...floatingSize }
            : undefined
      }
    >
      <LoginPrompt
        open={loginSkill !== null}
        onOpenChange={(open) => {
          if (!open) setLoginSkill(null)
        }}
        skill={loginSkill ?? undefined}
      />
      <div
        className={
          floatingContent && !compact
            ? `absolute inset-x-0 flex flex-col overflow-hidden rounded-[var(--vds-radius-10)] bg-[var(--vds-bg-white-default)] shadow-[var(--vds-shadow-aidialog-2)] outline outline-[length:var(--vds-border-width-1)] outline-[var(--vds-border-default)] ${floatingContent.side === 'top' ? 'bottom-0' : 'top-[calc(var(--vds-space-9)*-1)]'}`
            : 'contents'
        }
        style={
          floatingContent && !compact
            ? {
                height:
                  floatingContent.height +
                  floatingContent.headingHeight +
                  floatingContent.anchorHeight,
              }
            : undefined
        }
        data-testid="floating-conversation-surface"
        data-workbench-motion={floatingContent && !compact ? 'conversation' : undefined}
      >
        <div
          className={`vds-ai-head box-border flex h-[var(--vds-ai-header-height)] items-center justify-between gap-[var(--vds-ai-header-gap)] border-b border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default)] p-[var(--vds-ai-header-padding)] transition-[max-height,opacity] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none ${!embedded && !ai.docked ? 'cursor-grab touch-none active:cursor-grabbing' : ai.docked ? 'h-[var(--vds-workbench-header-height)]' : ''} ${headerCollapsed ? '!max-h-0 !overflow-hidden opacity-0 pointer-events-none' : 'max-h-[var(--vds-workbench-header-height)] opacity-[var(--vds-opacity-full)]'}`}
          aria-hidden={headerCollapsed || undefined}
          ref={(element) => {
            if (element) element.inert = headerCollapsed
          }}
          style={hideHeader ? { display: 'none' } : undefined}
          data-testid={embedded ? 'workspace-drag-handle' : undefined}
          onPointerDown={embedded ? undefined : startFloatingDrag}
          onPointerMove={moveFloatingPanel}
          onPointerUp={stopFloatingDrag}
          onPointerCancel={stopFloatingDrag}
        >
          {workspaceLeading}
          <div
            className={`vds-ai-session flex min-w-0 flex-[1_1_auto] items-center gap-[var(--vds-ai-session-gap)] p-0 font-[family-name:var(--vds-font-main)] text-[length:var(--vds-ai-session-font-size)] [font-weight:var(--vds-ai-session-font-weight)] tracking-[var(--vds-ai-session-letter-spacing)] text-[var(--vds-brand-text-primary)] [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap${onToggleContent ? ' relative self-stretch' : ''}`}
            data-testid="ai-session-title"
          >
            {inlineComposer && currentSession && (
              <div
                className="flex shrink-0 items-center empty:hidden"
                data-testid="floating-title-status"
              >
                <TaskStatus
                  node={currentSession}
                  unread={sessionNeedsAttention(reminders.by_session[currentSession.id] ?? 0)}
                />
              </div>
            )}
            {headingScope ? (
              <Breadcrumb className="min-w-0" data-testid="ai-scope-breadcrumb">
                <BreadcrumbList className="min-w-0 flex-nowrap gap-[var(--vds-space-2)]">
                  <BreadcrumbItem className="min-w-0 shrink">
                    <Tooltip content={headingScope} portalled side="bottom" className="min-w-0">
                      <span
                        className="flex min-w-0 items-center gap-[var(--vds-space-2)] text-[var(--vds-text-secondary)]"
                        data-testid="ai-scope-name"
                        tabIndex={0}
                      >
                        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          {projectName ? truncateProjectName(headingScope) : headingScope}
                        </span>
                      </span>
                    </Tooltip>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0 flex-1">
                    <BreadcrumbPage className="truncate text-[var(--vds-text-primary)]">
                      {sessionTitle}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            ) : (
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--vds-text-primary)]">
                {sessionTitle}
              </span>
            )}
            {!inlineComposer && window.scholarseed.developerToolsEnabled && thread.sessionId && (
              <Tooltip content={t('panel.copyId')} side="bottom" portalled className="shrink-0">
                <IconButton
                  data-testid="ai-copy-session-id"
                  icon={<Icon name="copy" />}
                  label={t('panel.copyId')}
                  title={undefined}
                  onClick={() => void window.scholarseed.writeClipboard(thread.sessionId ?? '')}
                  size="md"
                  variant="ghostIcon"
                />
              </Tooltip>
            )}
            {onToggleContent && (
              <Button
                unstyled
                className="absolute inset-0 w-full cursor-pointer rounded-[var(--vds-radius-2)] focus-visible:shadow-[var(--vds-focus-brand)]"
                aria-label={layoutText(compact ? 'expandConversation' : 'collapseConversation')}
                aria-expanded={!compact}
                aria-controls={contentId}
                data-floating-content-toggle
                data-testid="floating-conversation-toggle"
                onClick={onToggleContent}
              />
            )}
          </div>
          <div className="vds-ai-head-actions flex flex-none items-center gap-[var(--vds-ai-header-actions-gap)]">
            <div className="contents">
              {!inlineComposer && (
                <HeadAction
                  label={t('panel.new')}
                  data-testid="ai-new-session"
                  icon={<MessageCirclePlus strokeWidth={1.7} />}
                  onClick={() => act.startPanelDraft()}
                />
              )}
              <Popover
                open={!embedded && ai.sessionMenuOpen}
                onOpenChange={(open) => patch({ sessionMenuOpen: open })}
              >
                {!embedded && (
                  <PopoverTrigger asChild>
                    <HeadAction
                      label={t('panel.history')}
                      data-testid="ai-session-toggle"
                      icon={<RotateCcwClock strokeWidth={1.7} />}
                      aria-expanded={ai.sessionMenuOpen}
                      aria-pressed={ai.sessionMenuOpen}
                    />
                  </PopoverTrigger>
                )}
                <PopoverContent
                  align="end"
                  aria-label={t('panel.history')}
                  className={SESSION_FLYOUT_CLASS_NAME}
                  data-testid="ai-session-flyout"
                  side="bottom"
                  style={
                    sessionFlyoutBounds
                      ? {
                          left: sessionFlyoutBounds.left,
                          width: sessionFlyoutBounds.width,
                        }
                      : undefined
                  }
                >
                  <SearchBox
                    ref={sessionSearchRef}
                    aria-label={t('panel.searchLabel')}
                    data-testid="ai-session-search"
                    onChange={(event) => setSessionQuery(event.currentTarget.value)}
                    placeholder={t('panel.searchPlaceholder')}
                    size="sm"
                    value={sessionQuery}
                  />
                  <Command>
                    <CommandList>
                      {/* 相位互斥，不允许出现「既无数据也无提示」的空壳帧，也不允许
                      加载占位与旧行同时渲染（那会把气泡撑高再缩回，就是闪动）。 */}
                      {sessionNodes.length === 0 && listPending && (
                        <div
                          className="vds-ai-context-empty px-[var(--vds-space-1)] py-[calc(var(--vds-space-3)+var(--vds-space-half))] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-ai-context-empty-line-height)] text-[var(--wb-muted)]"
                          data-testid="ai-session-loading"
                        >
                          {t('panel.loadingSessions')}
                        </div>
                      )}
                      {sessionNodes.length === 0 && sessionListState === 'ready' && (
                        <EmptyState
                          variant="compact"
                          icon={<Icon name="search" />}
                          title={
                            deferredSessionQuery.trim() ? t('panel.noMatches') : t('panel.empty')
                          }
                        />
                      )}
                      {sessionNodes.map((node) => {
                        const row = sessionRowsById.get(node.id)
                        const displayName = sessionDisplayTitle(node, t) || t('panel.untitled')
                        const isActive = node.id === state.activeSession
                        // 默认只展示时间；仅在该行操作菜单展开时强制让位给「更多」。
                        const moreForced = sessionActionPopoverId === node.id
                        const updatedLabel = sessionTimeLabel(
                          row?.last_agent_reply_at ?? undefined,
                          sessionTimeFormat
                        )
                        return (
                          <div
                            key={node.id}
                            className={cx(
                              SESSION_ROW_CLASS_NAME,
                              isActive && SESSION_ROW_ACTIVE_CLASS_NAME
                            )}
                          >
                            {sessionRenameId === node.id ? (
                              // Input 的外层 label 是 grid 且不接受 className，撑满行宽只能靠这层包裹。
                              <div className="min-w-0 flex-1">
                                <Input
                                  autoFocus
                                  data-testid={`ai-session-rename-input-${node.id}`}
                                  value={sessionRenameDraft}
                                  disabled={sessionSaving}
                                  maxLength={SESSION_TITLE_MAX_LENGTH}
                                  size="sm"
                                  aria-label={t('panel.renameLabel', {
                                    name: sessionDisplayTitle(node, t),
                                  })}
                                  onChange={(event) =>
                                    setSessionRenameDraft(event.currentTarget.value)
                                  }
                                  onBlur={() => {
                                    void commitSessionRename()
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      event.currentTarget.blur()
                                    } else if (event.key === 'Escape') {
                                      event.preventDefault()
                                      renameCancelled.current = true
                                      setSessionRenameId(null)
                                      setSessionActionError(null)
                                    }
                                  }}
                                />
                              </div>
                            ) : (
                              <CommandItem
                                value={node.id}
                                keywords={[node.title, row?.match?.excerpt ?? '']}
                                className={SESSION_ITEM_CLASS_NAME}
                                data-testid={`ai-session-${node.id}`}
                                onSelect={() => {
                                  patch({ sessionMenuOpen: false })
                                  act.openPanelSession(
                                    node,
                                    row?.match?.turn_id || row?.match?.item_id
                                      ? {
                                          turnId: row.match.turn_id,
                                          itemId: row.match.item_id,
                                        }
                                      : undefined
                                  )
                                }}
                              >
                                {/* 标题只在真被截断时才浮 tooltip；浮层列表可滚动，tooltip 必须 portal 才不被裁切。 */}
                                <EllipsisText
                                  className={cx(
                                    SESSION_TITLE_CLASS_NAME,
                                    isActive && SESSION_TITLE_ACTIVE_CLASS_NAME
                                  )}
                                  tooltipPortalled
                                  wrapperClassName="min-w-0 flex-1"
                                >
                                  {displayName}
                                </EllipsisText>
                                {updatedLabel ? (
                                  <span
                                    aria-label={t('panel.updated', { time: updatedLabel })}
                                    className={cx(
                                      SESSION_TIME_CLASS_NAME,
                                      moreForced && SESSION_TIME_HIDDEN_CLASS_NAME
                                    )}
                                  >
                                    {updatedLabel}
                                  </span>
                                ) : null}
                              </CommandItem>
                            )}
                            {sessionRenameId !== node.id && (
                              <Popover
                                open={sessionActionPopoverId === node.id}
                                onOpenChange={(open) =>
                                  setSessionActionPopoverId(open ? node.id : null)
                                }
                              >
                                <PopoverTrigger asChild>
                                  <IconButton
                                    className={cx(
                                      SESSION_MORE_CLASS_NAME,
                                      moreForced && SESSION_MORE_VISIBLE_CLASS_NAME
                                    )}
                                    data-testid={`ai-session-actions-${node.id}`}
                                    icon={<EllipsisVertical size={16} />}
                                    label={t('panel.moreActions', { name: displayName })}
                                    size="sm"
                                    variant="ghostIcon"
                                  />
                                </PopoverTrigger>
                                <PopoverContent
                                  align="end"
                                  className={SESSION_ACTION_MENU_CLASS_NAME}
                                  data-testid={`ai-session-action-menu-${node.id}`}
                                >
                                  <Button
                                    className={SESSION_ACTION_ITEM_CLASS_NAME}
                                    data-testid={`ai-session-rename-${node.id}`}
                                    variant="ghost"
                                    onClick={() => {
                                      setSessionActionPopoverId(null)
                                      beginSessionRename(node.id, node.title)
                                    }}
                                  >
                                    <Pencil size={14} strokeWidth={1.7} />
                                    {t('panel.rename')}
                                  </Button>
                                  {node.status === 'running' && (
                                    <Button
                                      className={SESSION_ACTION_ITEM_CLASS_NAME}
                                      data-testid={`ai-session-terminate-${node.id}`}
                                      variant="ghost"
                                      onClick={() => {
                                        setSessionActionPopoverId(null)
                                        patch({ sessionMenuOpen: false })
                                        void terminateSession(node.id).then((result) => {
                                          if (!result.ok)
                                            setSessionActionError('panel.terminateFailed')
                                        })
                                      }}
                                    >
                                      {t('panel.terminate')}
                                    </Button>
                                  )}
                                  <Button
                                    className={cx(
                                      SESSION_ACTION_ITEM_CLASS_NAME,
                                      SESSION_ACTION_DANGER_CLASS_NAME
                                    )}
                                    data-testid={`ai-session-delete-${node.id}`}
                                    variant="ghost"
                                    onClick={() => {
                                      setSessionActionPopoverId(null)
                                      patch({ sessionMenuOpen: false })
                                      set({
                                        confirmDelete: {
                                          label: node.title,
                                          title_fallback: node.title_fallback,
                                          sessionId: node.id,
                                          surface: 'assistant',
                                        },
                                      })
                                    }}
                                  >
                                    <Trash size={14} strokeWidth={1.7} />
                                    {t('panel.delete')}
                                  </Button>
                                </PopoverContent>
                              </Popover>
                            )}
                          </div>
                        )
                      })}
                      {/* 刷新失败时保留已有行，只在末尾追加重试；无行时它就是唯一提示。 */}
                      {sessionListState === 'error' && (
                        <Button
                          className={SESSION_ACTION_ITEM_CLASS_NAME}
                          data-testid="ai-session-retry"
                          onClick={() => {
                            sessionSearchRef.current?.focus()
                            void loadProjectSessions()
                          }}
                          variant="ghost"
                        >
                          {t('panel.loadFailed')}
                        </Button>
                      )}
                    </CommandList>
                  </Command>
                  {sessionActionError && (
                    <div className={SESSION_ERROR_CLASS_NAME} role="alert">
                      {t(sessionActionError)}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
            {workspaceActions}
            <div className={embedded ? 'hidden' : 'contents'}>
              <HeadAction
                label={ai.docked ? t('panel.float') : t('panel.dock')}
                icon={<IconFont type={ai.docked ? 'line-tool-pin' : 'fill-tool-pin'} />}
                data-testid="ai-toggle-dock"
                onClick={act.toggleAiPanelDock}
              />
              <HeadAction
                label={ai.cover ? t('panel.shrink') : t('panel.expand')}
                icon={ai.cover ? <Minimize2 strokeWidth={1.7} /> : <Maximize2 strokeWidth={1.7} />}
                data-testid="ai-toggle-cover"
                onClick={act.toggleAiPanelCover}
              />
              <HeadAction
                label={t('panel.close')}
                icon={<X strokeWidth={1.7} />}
                onClick={act.toggleAiPanel}
              />
            </div>
          </div>
        </div>

        <TaskOverviewBody>
          <div className={compact || inlineComposer || thread.readOnly ? 'hidden' : 'contents'}>
            <Translation />
          </div>

          {/* 真实会话流：0.1 的 Stream，含活动、工具、HIL 权限卡、产物。 */}
          <div
            className={
              compact
                ? 'hidden'
                : floatingContent
                  ? 'vds-ai-stream flex min-h-0 flex-1 flex-col overflow-hidden'
                  : 'flex vds-ai-stream min-h-0 flex-1 flex-col overflow-hidden pt-0 pb-[var(--vds-space-2)] [&>.conversation-stream]:!pt-[var(--vds-space-4)] [&>.conversation-stream]:!pb-0'
            }
            id={contentId}
            data-testid="ai-stream"
          >
            {state.activeSession === null && !state.turnLaunch ? (
              <div
                className={`vds-ai-stream-empty mx-auto w-[calc(100%-2*(var(--vds-conversation-inline-gutter)+var(--vds-conversation-scrollbar-width)))] flex flex-col !px-0 py-[calc(var(--vds-space-3)+var(--vds-space-half))] px-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-assistant-stream-empty-line-height)] text-[var(--vds-text-tertiary)] ${floatingContent ? '!w-[calc(100%-var(--vds-space-8))] min-h-0 overflow-y-auto !justify-start !pt-[var(--vds-space-10)] pb-[var(--vds-space-4)]' : embedded ? '!w-[calc(100%-2*(var(--vds-conversation-inline-gutter)+var(--vds-conversation-scrollbar-width)))] min-h-full max-w-[var(--vds-conversation-content-width)] !justify-start !pt-[var(--vds-project-welcome-top)] pb-[var(--vds-space-8)]' : 'min-h-full max-w-[var(--vds-conversation-content-width)] justify-center pt-[26px] pb-[34px]'}`}
              >
                <div
                  data-ob={
                    embedded && state.homeSelectedProjectId
                      ? PROJECT_GUIDE_ANCHORS.capabilities
                      : undefined
                  }
                >
                  <h3 className="m-0 mb-[var(--vds-space-2)] font-[family-name:var(--vds-font-serif)] text-[length:var(--vds-assistant-stream-empty-heading-size)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                    {t('panel.startTitle')}
                  </h3>
                  <p className="m-0 text-[length:var(--vds-assistant-stream-empty-description-size)] leading-[var(--vds-assistant-stream-empty-line-height)] text-[var(--vds-text-tertiary)]">
                    {t('panel.startDescription')}
                  </p>
                  <div className="vds-ai-task-starters mt-[var(--vds-space-4)] grid w-full grid-cols-[minmax(0,1fr)] gap-[var(--vds-ai-task-starters-gap)]">
                    {AI_TASK_STARTERS.map((starter) => (
                      <Button
                        key={starter.titleKey}
                        variant="ghost"
                        size="content"
                        className="vds-ai-task-starter !flex !min-h-[var(--vds-ai-task-starter-min-height)] !min-w-0 !flex-col !items-start !justify-center !gap-[var(--vds-ai-task-starter-content-gap)] !rounded-[var(--vds-ai-task-starter-radius)] !border !border-[var(--vds-border-default)] !bg-[var(--vds-bg-white-default)] !px-[var(--vds-space-4)] !py-[var(--vds-space-3)] !text-left !text-[var(--vds-text-primary)] !whitespace-normal hover:!bg-[var(--vds-bg-white-hover-transparent)] [&>span]:text-[length:var(--vds-font-body-lv1)] [&>span]:leading-[var(--vds-lh-body-lv1)] [&>span]:text-[var(--vds-text-tertiary)]"
                        data-testid={`ai-task-starter-${starter.taskType}`}
                        loading={taskStarterPending === starter.skillName}
                        aria-busy={taskStarterPending === starter.skillName}
                        onClick={() => void startTask(starter)}
                      >
                        <strong className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-medium">
                          {t(starter.titleKey)}
                        </strong>
                        <span>{t(starter.descriptionKey)}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <Stream />
            )}
          </div>

          {/* 真实输入框：0.1 的 Composer，含技能、附件、模型切换、中断。 */}
          <div className="contents">
            {inlineComposer && !compact && (
              <div
                aria-hidden="true"
                className="mx-[var(--vds-space-3)] h-[var(--vds-border-width-1)] shrink-0 bg-[var(--vds-divider-default)]"
              />
            )}
            <ConversationControls>
              {thread.readOnly && (
                <p className="mx-auto w-full max-w-[var(--vds-conversation-content-width)] px-[var(--vds-conversation-inline-gutter)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
                  {componentText('taskArchive.readonly')}
                </p>
              )}
              <fieldset
                disabled={thread.readOnly}
                className="contents"
                data-testid="conversation-input-controls"
              >
                <Composer
                  surface="assistant"
                  inline={inlineComposer}
                  showModelHint={!inlineComposer || !compact}
                  header={({ continueTurn, continueDisabled }) =>
                    !compact &&
                    !inlineComposer && (
                      <div className="box-border px-[var(--vds-conversation-inline-gutter)]">
                        <div className="mx-auto box-border w-full min-w-0 max-w-[var(--vds-conversation-content-width)]">
                          <TodoPanel
                            compact
                            currentTurnOnly
                            onContinue={continueTurn}
                            continueDisabled={continueDisabled}
                          />
                        </div>
                      </div>
                    )
                  }
                  contextTray={
                    thread.readOnly || (inlineComposer && !contextWorkspaceHasContent)
                      ? undefined
                      : contextWorkspace
                  }
                  inputBoxRef={composerInputBoxRef}
                />
              </fieldset>
            </ConversationControls>
          </div>
        </TaskOverviewBody>
      </div>
      {!embedded && !ai.docked && (
        <>
          <div
            aria-hidden="true"
            className="absolute bottom-0 left-0 z-[var(--vds-z-local-control)] size-[var(--vds-space-5)] cursor-sw-resize touch-none"
            data-testid="ai-resize-bottom-left"
            onPointerDown={(event) => startFloatingResize(event, 'left')}
            onPointerMove={resizeFloatingPanel}
            onPointerUp={stopFloatingResize}
            onPointerCancel={stopFloatingResize}
          />
          <div
            aria-hidden="true"
            className="absolute bottom-0 right-0 z-[var(--vds-z-local-control)] size-[var(--vds-space-5)] cursor-se-resize touch-none"
            data-testid="ai-resize-bottom-right"
            onPointerDown={(event) => startFloatingResize(event, 'right')}
            onPointerMove={resizeFloatingPanel}
            onPointerUp={stopFloatingResize}
            onPointerCancel={stopFloatingResize}
          />
        </>
      )}
    </aside>
  )
}
