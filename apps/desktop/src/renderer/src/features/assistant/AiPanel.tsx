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
  useState
} from 'react'
import {
  EllipsisVertical,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Pencil,
  Pin,
  RotateCcwClock,
  Trash,
  X
} from 'lucide-react'

import {
  getSkills,
  listSessionCatalog,
  renameSession,
  terminateSession,
  type ServeSession
} from '../../api'
import { createFormatters } from '../../../../localization/format'
import { Composer } from '../../components/business/Composer'
import { LoginPrompt } from '../../components/business/LoginPrompt'
import { ComposerRefChip } from '../../components/business/RefChip'
import {
  ConversationControls,
  Stream
} from '../../components/business/Stream'
import { TodoPanel } from '../../components/business/TodoPanel'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import {
  Button,
  Command,
  CommandItem,
  CommandList,
  EllipsisText,
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
  type IconButtonProps
} from '../../components/ui'
import { Icon } from '../../icons'
import { feedback } from '../../contracts/feedback'
import { SESSION_TITLE_MAX_LENGTH } from '../../model'
import { SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { activeThread, assistantProject, useApp } from '../../store'
import { serveSessionNode } from '../../tree'
import { AssistantContextQuote } from './Quote'
import { AnnotationSummary, annotationDisplay } from './Notes'
import { Translation } from './Translation'
import {
  AI_TASK_STARTERS,
  AI_TASK_STARTER_SKILL_NAMES,
  resolveTaskStarterSkill,
  type TaskStarterSkillFailure
} from './starters'

const PROJECT_SESSION_LIMIT = 30
const FLOATING_PANEL_MARGIN_PX = 12

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
  'aria-expanded:[opacity:var(--vds-opacity-full)] aria-expanded:pointer-events-auto'
].join(' ')
const SESSION_MORE_VISIBLE_CLASS_NAME =
  '![opacity:var(--vds-opacity-full)] !pointer-events-auto'
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
      <IconButton
        label={label}
        size="sm"
        title={undefined}
        variant="ghostIcon"
        {...props}
      />
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
export function AiPanel(): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const ai = state.aiPanel
  const thread = activeThread(state)
  const sessionTimeFormat = useMemo(() => createFormatters(state.lang), [state.lang])
  const [sessionRows, setSessionRows] = useState<ServeSession[] | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const deferredSessionQuery = useDeferredValue(sessionQuery)
  const [sessionListState, setSessionListState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [sessionRenameId, setSessionRenameId] = useState<string | null>(null)
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [sessionActionPopoverId, setSessionActionPopoverId] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<'panel.nameRequired' | 'panel.renameFailed' | 'panel.terminateFailed' | null>(
    null
  )
  const [sessionSaving, setSessionSaving] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState<{
    left: number
    top: number
  } | null>(null)
  const floatingDrag = useRef<FloatingDrag | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  // 输入框所在的会话内容列（由 Composer 透传）：历史浮层据此对齐，做到与输入框同宽同左。
  const composerInputBoxRef = useRef<HTMLDivElement | null>(null)
  const [sessionFlyoutBounds, setSessionFlyoutBounds] = useState<{
    left: number
    width: number
  } | null>(null)
  const sessionListRequest = useRef(0)
  const taskStarterRequest = useRef(0)
  const [loginSkill, setLoginSkill] = useState<string | null>(null)
  const renameCancelled = useRef(false)
  const projectPath = assistantProject(state).projectPath

  const patch = (next: Partial<typeof ai>): void =>
    set({ aiPanel: { ...ai, ...next } })

  const startTask = async (
    starter: (typeof AI_TASK_STARTERS)[number]
  ): Promise<void> => {
    const request = ++taskStarterRequest.current
    let skills
    try {
      skills = await getSkills(SKILL_SURFACE_SETTINGS)
    } catch {
      if (request === taskStarterRequest.current) {
        set({ foregroundError: feedback('components', 'composer.skillFailed') })
      }
      return
    }
    if (request !== taskStarterRequest.current) return
    const result = resolveTaskStarterSkill(skills, starter.skillName)
    if (result.failure === 'login_required') {
      setLoginSkill(t(starter.titleKey))
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
        path: 'composer.skillPath'
      }
      set({
        foregroundError: feedback('components', failureKeys[result.failure], {
          name: starter.skillName
        })
      })
      return
    }
    act.askAiFromPanel(
      t(starter.promptKey),
      'taskType' in starter ? starter.taskType : undefined
    )
    set((current) => ({
      composerRefs: [
        ...current.composerRefs.filter((reference) => (
          reference.type !== 'skill'
          || !AI_TASK_STARTER_SKILL_NAMES.has(reference.id)
        )),
        result.reference
      ],
      foregroundError: null
    }))
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
  const fetchSessions = useCallback(async (query: string): Promise<void> => {
    const requestId = sessionListRequest.current + 1
    sessionListRequest.current = requestId
    setSessionListState('loading')
    const catalog = await listSessionCatalog(
      projectPath
        ? {
          limit: PROJECT_SESSION_LIMIT,
          scope: 'project',
          projectPath,
          query
        }
        : {
          limit: PROJECT_SESSION_LIMIT,
          scope: 'unassigned',
          query
        }
    )
    if (requestId !== sessionListRequest.current) return
    if (catalog === null) {
      setSessionListState('error')
      return
    }
    setSessionRows(catalog.sessions)
    setSessionListState('ready')
  }, [projectPath])

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
        current && current.left === left && current.width === width
          ? current
          : { left, width }
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
    return () =>
      window.removeEventListener('scholarseed:refresh-session-list', refresh)
  }, [ai.sessionMenuOpen, loadProjectSessions])

  const sessionNodes = useMemo(
    () =>
      (sessionRows ?? [])
        .filter((row) => state.threads[row.session_id]?.surface !== 'workbench')
        .map((row) =>
          serveSessionNode(row, state.sessionActivitySeen, state.activeSession)
        )
        .sort((left, right) => {
          return (
            (right.activityAt ?? 0) - (left.activityAt ?? 0) ||
            right.id.localeCompare(left.id)
          )
        }),
    [sessionRows, state.activeSession, state.sessionActivitySeen, state.threads]
  )
  const sessionRowsById = useMemo(
    () => new Map((sessionRows ?? []).map((row) => [row.session_id, row])),
    [sessionRows]
  )
  // 列表相位：还没拿到任何结果（idle/loading）才算「加载中」。
  // 有行时刷新不回到加载态，也不插占位行 —— 气泡高度只由真实行数决定。
  const listPending =
    sessionListState !== 'ready' && sessionListState !== 'error'

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
    const original = sessionRows?.find(
      (row) => row.session_id === sessionRenameId
    )
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
      if (state.composerText.length === 0 && state.composerRefs.length === 0) {
        act.startPanelDraft()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.open])

  const sessionTitle = state.activeSession
    ? sessionDisplayTitle(thread, t) || t('panel.current')
    : t('panel.new')
  const startFloatingDrag = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (
      ai.docked ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button')
    )
      return
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!bounds) return
    event.currentTarget.setPointerCapture(event.pointerId)
    floatingDrag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top
    }
    setFloatingPosition({ left: bounds.left, top: bounds.top })
  }

  const moveFloatingPanel = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
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

  const stopFloatingDrag = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (floatingDrag.current?.pointerId !== event.pointerId) return
    floatingDrag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // ContextRefs 属于当前 Session，但视觉上属于“下一次发送”的输入工作区，
  // 因此通过 Composer 插槽渲染在输入框内部，而不是占据面板顶部的一整条工具栏。
  const visibleRefs = ai.refs.filter(
    (ref) => !ai.submittedRefIds.includes(ref.ref_id)
  )
  const noteRefs = visibleRefs.filter((ref) => ref.kind === 'note')
  const otherRefs = visibleRefs.filter((ref) => ref.kind !== 'note')
  const noteAnnotations = noteRefs.flatMap((ref) => {
    const annotation = ai.annotations.find(
      (item) => item.annotation_id === ref.source_id
    )
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
        <div className="vds-ai-context-empty" data-testid="ai-context-loading">
          {ai.contextState === 'loading'
            ? t('panel.loadingContext')
            : t('panel.savingContext')}
        </div>
      ) : visibleRefs.length > 0 ? (
        <>
          <AnnotationSummary
            annotations={noteAnnotations}
            numberForAnnotation={(annotationId) => {
              // 与消息列表内联标识同一编排: 单条回答内注释创建顺序(从 1 开始)
              const raw = ai.annotations.find((item) => item.annotation_id === annotationId)
              if (!raw) return 1
              return ai.annotations.filter(
                (item) => item.source_item_id === raw.source_item_id
              ).findIndex((item) => item.annotation_id === annotationId) + 1
            }}
            onClear={() => {
              // 输入框内删除注释时同步删除注释实体, 消息列表内联标识随之移除
              void act.deleteAnswerAnnotations(noteRefs.map((ref) => ref.source_id))
            }}
            onEdit={(annotationId, comment) =>
              act.updateAnswerAnnotation(annotationId, comment)
            }
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
                            void act.openLiteratureAttachment(ref.source_id)
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
          className="vds-ai-context-empty is-error"
          data-testid="ai-context-error"
        >
          {'raw' in ai.contextError ? ai.contextError.raw : t(ai.contextError.key, { detail: ai.contextError.detail ?? '' })}
        </div>
      )}
    </div>
  )

  return (
    <aside
      className={`vds-ai-panel${ai.docked ? ' is-docked' : ' is-floating'}${ai.cover ? ' is-cover' : ''}`}
      data-testid="ai-panel"
      ref={panelRef}
      style={!ai.docked && floatingPosition ? floatingPosition : undefined}
    >
      <LoginPrompt open={loginSkill !== null} onOpenChange={(open) => { if (!open) setLoginSkill(null) }} skill={loginSkill ?? undefined} />
      <div
        className="vds-ai-head"
        onPointerDown={startFloatingDrag}
        onPointerMove={moveFloatingPanel}
        onPointerUp={stopFloatingDrag}
        onPointerCancel={stopFloatingDrag}
      >
        <div className="vds-ai-session" data-testid="ai-session-title">
          <span className="text-[var(--vds-text-primary)]">{sessionTitle}</span>
          {window.scholarseed.developerToolsEnabled && thread.sessionId && (
            <IconButton
              className="flex-none opacity-40 hover:opacity-100"
              data-testid="ai-copy-session-id"
              icon={<Icon name="copy" size={13} />}
              label={t('panel.copyId')}
              onClick={() =>
                void window.scholarseed.writeClipboard(thread.sessionId ?? '')
              }
              size="sm"
              variant="ghostIcon"
            />
          )}
        </div>
        <div className="vds-ai-head-actions">
          <HeadAction
            label={t('panel.new')}
            data-testid="ai-new-session"
            icon={<MessageCirclePlus strokeWidth={1.7} />}
            onClick={act.startPanelDraft}
          />
          <Popover open={ai.sessionMenuOpen} onOpenChange={(open) => patch({ sessionMenuOpen: open })}>
            <PopoverTrigger asChild>
              <HeadAction
                label={t('panel.history')}
                data-testid="ai-session-toggle"
                icon={<RotateCcwClock strokeWidth={1.7} />}
                aria-expanded={ai.sessionMenuOpen}
                aria-pressed={ai.sessionMenuOpen}
              />
            </PopoverTrigger>
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
                    width: sessionFlyoutBounds.width
                  }
                  : undefined
              }
            >
              <SearchBox
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
                      className="vds-ai-context-empty"
                      data-testid="ai-session-loading"
                    >
                      {t('panel.loadingSessions')}
                    </div>
                  )}
                  {sessionNodes.length === 0 && sessionListState === 'ready' && (
                    <div className="vds-ai-context-empty">
                      {deferredSessionQuery.trim()
                        ? t('panel.noMatches')
                        : t('panel.empty')}
                    </div>
                  )}
                  {sessionNodes.map((node) => {
                    const row = sessionRowsById.get(node.id)
                    const displayName = sessionDisplayTitle(node, t) || t('panel.untitled')
                    const isActive = node.id === state.activeSession
                    // 默认只展示时间；仅在该行操作菜单展开时强制让位给「更多」。
                    const moreForced = sessionActionPopoverId === node.id
                    const updatedLabel = sessionTimeLabel(row?.mtime, sessionTimeFormat)
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
                              aria-label={t('panel.renameLabel', { name: sessionDisplayTitle(node, t) })}
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
                                    itemId: row.match.item_id
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
                            {/* 接口没有 mtime 时整列不渲染，不用占位符冒充时间。 */}
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
                            onOpenChange={(open) => setSessionActionPopoverId(open ? node.id : null)}
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
                                    void terminateSession(node.id).then(
                                      (result) => {
                                        if (!result.ok)
                                          setSessionActionError(
                                            'panel.terminateFailed'
                                          )
                                      }
                                    )
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
                                      surface: 'assistant'
                                    }
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
                      onClick={() => void loadProjectSessions()}
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
          <HeadAction
            label={ai.docked ? t('panel.float') : t('panel.dock')}
            icon={<Pin strokeWidth={1.7} />}
            data-testid="ai-toggle-dock"
            onClick={act.toggleAiPanelDock}
          />
          <HeadAction
            label={ai.cover ? t('panel.shrink') : t('panel.expand')}
            icon={
              ai.cover ? (
                <Minimize2 strokeWidth={1.7} />
              ) : (
                <Maximize2 strokeWidth={1.7} />
              )
            }
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

      <Translation />

      {/* 真实会话流：0.1 的 Stream，含活动、工具、HIL 权限卡、产物。 */}
      <div className="vds-ai-stream flex min-h-0 flex-1 flex-col overflow-hidden pt-0 pb-[var(--vds-space-2)] [&>.conversation-stream]:!pt-[var(--vds-space-4)] [&>.conversation-stream]:!pb-0" data-testid="ai-stream">
        {state.activeSession === null && !state.turnLaunch ? (
          <div className="vds-ai-stream-empty mx-auto w-[calc(100%-2*(var(--vds-conversation-inline-gutter)+var(--vds-conversation-scrollbar-width)))] max-w-[var(--vds-conversation-content-width)] flex min-h-full flex-col justify-center !px-0 pt-[26px] pb-[34px]">
            <h3>{t('panel.startTitle')}</h3>
            <p>{t('panel.startDescription')}</p>
            <div className="vds-ai-task-starters">
              {AI_TASK_STARTERS.map((starter) => (
                <Button
                  key={starter.titleKey}
                  variant="ghost"
                  size="content"
                  className="vds-ai-task-starter hover:!bg-[var(--vds-bg-white-hover-transparent)]"
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
        ) : (
          <Stream />
        )}
      </div>

      {/* 真实输入框：0.1 的 Composer，含技能、附件、模型切换、中断。 */}
      <ConversationControls>
        <div className="box-border px-[var(--vds-conversation-inline-gutter)]">
          <div className="mx-auto box-border w-full min-w-0 max-w-[var(--vds-conversation-content-width)]">
            <TodoPanel compact currentTurnOnly />
          </div>
        </div>
        <Composer
          surface="assistant"
          contextTray={contextWorkspace}
          inputBoxRef={composerInputBoxRef}
        />
      </ConversationControls>
    </aside>
  )
}
