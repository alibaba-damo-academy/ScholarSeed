import { PROJECT_GUIDE_ANCHORS } from '../contracts/onboarding'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  MoreVertical,
  PanelRight,
  Plus,
  Square,
  SquareArrowDownRight,
  SquareArrowUpLeft,
  SquarePlus,
} from 'lucide-react'

import { featureRegistry } from '../app/composition'
import { availabilityPolicy } from '../app/policy'
import aiAssistantIcon from '../assets/ai_assistant.webp'
import { sessionNeedsAttention } from '../attention'
import { IconFont } from '../components/primitive'
import { SessionDropdownMenu } from '../components/business/SessionContextMenu'
import { TaskStatus } from '../components/business/TaskStatus'
import {
  cx,
  Divider,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  ResizablePanel,
  ResizableHandle,
  Tooltip,
} from '../components/ui'
import { AssistantPanel } from '../features/assistant/Panel'
import { TaskOverview, TaskOverviewLayout } from '../features/assistant/Overview'
import { useAttention } from '../features/assistant/attention'
import { Workbench } from '../features/workbench/Workbench'
import {
  newProjectTab,
  tabMatchesProject,
  tabVisibleInCurrentView,
} from '../features/workbench/tabs'
import { useDocumentWorkspace } from '../features/workbench/workspace'
import { activeThread, useApp } from '../store'
import { findSessionNode } from '../tree'
import { changeProjectLayout } from '../../../layout'
import { TabBar } from './TabBar'
import { Motion } from './Motion'
import {
  MODULE_PANEL_DEFAULT_WIDTH,
  MODULE_PANEL_MAX_WIDTH,
  MODULE_PANEL_WIDTH_STEP,
  constrainFloatingPanel,
  floatingPanelDockPosition,
  nearestFloatingPanelDock,
  resizeFloatingPanel,
  type FloatingPanelBounds,
  type FloatingPanelDock,
} from './geometry'

const CONTENT_MIN_WIDTH = 260
const CONTENT_MAX_WIDTH = 75
const BUBBLE_DRAG_THRESHOLD = 4
const CONVERSATION_DRAG_THRESHOLD = 4
const FLOATING_CONTENT_HEIGHT_RATIO = 0.6

interface WorkspaceProps {
  navigationWidth: string
  onNavigationWidthChange: (width: string) => void
}

export function Workspace({
  navigationWidth,
  onNavigationWidthChange,
}: WorkspaceProps): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('layout')
  const { t: shellText } = useTranslation('shell')
  const { t: assistantText } = useTranslation('assistant')
  const [tabOverflowTarget, setTabOverflowTarget] = useState<HTMLSpanElement | null>(null)
  const layout = state.workbenchLayout
  const documents = useDocumentWorkspace()
  const workspaceTabCount =
    state.tabs.filter(
      (tab) =>
        tab.kind !== 'overview' &&
        availabilityPolicy.tabAvailable(tab) &&
        tabMatchesProject(tab, state.homeSelectedProjectId) &&
        tabVisibleInCurrentView(tab.kind, state.mainView)
    ).length +
    (state.mainView === 'resource' || state.mainView === 'literature'
      ? Object.values(documents.tabs).filter(
          (tab) => !tab.embedded && documents.sessions[tab.sessionId]
        ).length
      : 0)
  const thread = activeThread(state)
  const reminders = useAttention()
  const minimizedSession = thread.sessionId
    ? findSessionNode(state.sessions, thread.sessionId)
    : undefined
  const lastDocument = useRef(state.activeTab)
  const lastProject = useRef(state.homeSelectedProjectId)
  useLayoutEffect(() => {
    if (workspaceTabCount !== 0 || (!layout.open && !layout.full && !layout.taskTab)) return
    set((current) =>
      current.homeSelectedProjectId === state.homeSelectedProjectId &&
      current.mainView === state.mainView
        ? {
            workbenchLayout: {
              ...current.workbenchLayout,
              open: false,
              full: false,
              taskTab: false,
            },
          }
        : {}
    )
  }, [
    workspaceTabCount,
    layout.open,
    layout.full,
    layout.taskTab,
    state.homeSelectedProjectId,
    state.mainView,
    set,
  ])
  const patch = (value: Partial<typeof layout>): void =>
    set((current) => ({ workbenchLayout: { ...current.workbenchLayout, ...value } }))
  const changeLayout = (action: Parameters<typeof changeProjectLayout>[1]): void =>
    set((current) => ({ workbenchLayout: changeProjectLayout(current.workbenchLayout, action) }))
  useEffect(() => {
    if (
      lastProject.current === state.homeSelectedProjectId &&
      lastDocument.current !== state.activeTab &&
      state.activeTab !== 'overview' &&
      workspaceTabCount > 0
    ) {
      set((current) =>
        current.homeSelectedProjectId === state.homeSelectedProjectId &&
        current.activeTab === state.activeTab
          ? { workbenchLayout: { ...current.workbenchLayout, open: true, taskTab: false } }
          : {}
      )
    }
    lastDocument.current = state.activeTab
    lastProject.current = state.homeSelectedProjectId
  }, [state.activeTab, state.homeSelectedProjectId, workspaceTabCount, set])
  const conversationFull = layout.conversationFull
  const fullSurface = layout.full || conversationFull
  const showConversationDivider = layout.open && !fullSurface
  const conversationPinnedOut = layout.full && !layout.taskTab
  const floating = conversationPinnedOut && !conversationFull
  const minimized = floating && layout.floating === 'minimized'
  const compact = (floating || conversationFull) && layout.floating !== 'expanded'
  const conversationHeaderLeading =
    conversationFull || (!layout.full && (!layout.open || !layout.swapped))
  const sidebarToggle = !state.modulePanelOpen && (
    <Tooltip content={shellText('chrome.expandSidebar')} side="bottom" portalled>
      <IconButton
        variant="ghostIcon"
        size="md"
        label={shellText('chrome.expandSidebar')}
        title={undefined}
        icon={<IconFont type="panel-left-open" />}
        onClick={act.toggleModulePanel}
        data-testid="project-sidebar-expand"
      />
    </Tooltip>
  )
  const hostRef = useRef<HTMLDivElement>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [floatingActive, setFloatingActive] = useState(false)
  const floatingInteraction = useRef<Event | null>(null)
  useEffect(() => {
    setFloatingActive(false)
    if (!floating || minimized) return
    const outside = (event: Event): void => {
      setFloatingActive(
        event === floatingInteraction.current ||
          (event.target instanceof Node && Boolean(conversationRef.current?.contains(event.target)))
      )
    }
    const deactivate = (): void => setFloatingActive(false)
    window.addEventListener('pointerdown', outside)
    window.addEventListener('focusin', outside)
    window.addEventListener('blur', deactivate)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('focusin', outside)
      window.removeEventListener('blur', deactivate)
    }
  }, [floating, minimized])
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    startX: number
    startY: number
  } | null>(null)
  const conversationDragged = useRef(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [floatingMetrics, setFloatingMetrics] = useState<FloatingPanelBounds | null>(null)
  const [floatingDock, setFloatingDock] = useState<FloatingPanelDock>('bottomRight')
  const [floatingWidth, setFloatingWidth] = useState<number | null>(null)
  const floatingResize = useRef<{ left: number; width: number; minimumWidth: number } | null>(null)
  const floatingResized = useRef(false)
  useEffect(() => {
    setFloatingWidth(null)
    floatingResize.current = null
    floatingResized.current = false
  }, [state.homeSelectedProjectId])
  const startFloatingResize = (): void => {
    const panel = conversationRef.current
    const host = hostRef.current
    if (!panel || !host) return
    floatingResize.current = {
      left: panel.getBoundingClientRect().left - host.getBoundingClientRect().left,
      width: panel.offsetWidth,
      minimumWidth: Number.parseFloat(
        getComputedStyle(host).getPropertyValue('--vds-floating-conversation-width')
      ),
    }
  }
  const resizeFloating = (edge: 'left' | 'right', delta: number): void => {
    const initial = floatingResize.current
    const host = hostRef.current
    if (!initial || !host) return
    const inset = Number.parseFloat(getComputedStyle(host).getPropertyValue('--vds-space-4'))
    const next = resizeFloatingPanel(
      initial,
      edge,
      delta,
      host.clientWidth,
      initial.minimumWidth,
      inset
    )
    floatingResized.current = true
    setFloatingWidth(next.width)
    setPosition((current) => (current ? { ...current, left: next.left } : current))
  }
  const floatingBounds = useCallback((): FloatingPanelBounds | null => {
    const host = hostRef.current
    const panel = minimized ? bubbleRef.current : conversationRef.current
    if (!host || !panel) return null
    const composer = minimized ? null : panel.querySelector<HTMLElement>('.vds-ai-composer-host')
    const style = getComputedStyle(host)
    const inset = Number.parseFloat(style.getPropertyValue('--vds-space-4'))
    const headingHeight =
      floating && !minimized ? Number.parseFloat(style.getPropertyValue('--vds-space-9')) : 0
    const workspaceHeadingHeight =
      host.querySelector('[data-testid="workspace-content"] > header')?.getBoundingClientRect()
        .height ?? 0
    return {
      hostWidth: host.clientWidth,
      hostHeight: host.clientHeight,
      panelWidth: panel.offsetWidth,
      panelHeight: composer?.offsetHeight ?? panel.offsetHeight,
      minimumTop: workspaceHeadingHeight + inset + headingHeight,
      inset,
    }
  }, [floating, minimized])
  const [bubblePosition, setBubblePosition] = useState<{ left: number; top: number } | null>(null)
  const bubbleDrag = useRef<{
    pointerId: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const bubbleDragged = useRef(false)
  const startBubbleDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    bubbleDragged.current = false
    const bounds = event.currentTarget.getBoundingClientRect()
    bubbleDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveBubbleDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = bubbleDrag.current
    const host = hostRef.current
    if (!drag || drag.pointerId !== event.pointerId || !host) return
    if (
      !bubbleDragged.current &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < BUBBLE_DRAG_THRESHOLD
    )
      return
    bubbleDragged.current = true
    event.preventDefault()
    const bounds = host.getBoundingClientRect()
    const metrics = floatingBounds()
    if (!metrics) return
    setBubblePosition(
      constrainFloatingPanel(
        {
          left: event.clientX - bounds.left - drag.offsetX,
          top: event.clientY - bounds.top - drag.offsetY,
        },
        host.clientWidth,
        host.clientHeight,
        metrics.panelWidth,
        metrics.panelHeight,
        metrics.minimumTop
      )
    )
  }
  const stopBubbleDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = bubbleDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const host = hostRef.current
    const metrics = floatingBounds()
    if (bubbleDragged.current && host && metrics) {
      const bounds = host.getBoundingClientRect()
      const dock =
        event.type === 'pointerup'
          ? nearestFloatingPanelDock(
              {
                left: event.clientX - bounds.left - drag.offsetX,
                top: event.clientY - bounds.top - drag.offsetY,
              },
              metrics
            )
          : floatingDock
      setFloatingDock(dock)
      setBubblePosition(floatingPanelDockPosition(dock, metrics))
    }
    bubbleDrag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  useLayoutEffect(() => {
    setPosition(null)
    setFloatingDock('bottomRight')
    dragRef.current = null
    bubbleDrag.current = null
    bubbleDragged.current = false
    setBubblePosition(null)
  }, [state.homeSelectedProjectId])
  useLayoutEffect(() => {
    if (!floating || minimized) floatingResize.current = null
    if (!floating) {
      dragRef.current = null
      return
    }
    const host = hostRef.current
    const panel = minimized ? bubbleRef.current : conversationRef.current
    if (!host || !panel) return
    const update = (): void => {
      const bounds = floatingBounds()
      if (!bounds) return
      if (!minimized) {
        setFloatingMetrics((current) =>
          current &&
          Object.entries(bounds).every(
            ([key, value]) => current[key as keyof FloatingPanelBounds] === value
          )
            ? current
            : bounds
        )
      }
      const updatePosition = minimized ? setBubblePosition : setPosition
      updatePosition((current) => {
        const dragging = minimized ? bubbleDrag.current : dragRef.current
        const next =
          (dragging || (!minimized && (floatingResize.current || floatingResized.current))) &&
          current
            ? constrainFloatingPanel(
                current,
                bounds.hostWidth,
                bounds.hostHeight,
                bounds.panelWidth,
                bounds.panelHeight,
                bounds.minimumTop
              )
            : floatingPanelDockPosition(floatingDock, bounds)
        return next.left === current?.left && next.top === current?.top ? current : next
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    observer.observe(panel)
    const composer = panel.querySelector<HTMLElement>('.vds-ai-composer-host')
    if (composer) observer.observe(composer)
    return () => observer.disconnect()
  }, [floating, minimized, floatingDock, floatingBounds])
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!floating || event.button !== 0 || !(event.target instanceof Element)) return
    const handle = event.target.closest<HTMLElement>('[data-workspace-drag-handle]')
    if (!handle) return
    const panel = conversationRef.current
    if (!panel) return
    const bounds = panel.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      startX: event.clientX,
      startY: event.clientY,
    }
    conversationDragged.current = false
    handle.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const host = hostRef.current
    const panel = conversationRef.current
    if (!drag || drag.pointerId !== event.pointerId || !host || !panel) return
    if (
      !conversationDragged.current &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <
        CONVERSATION_DRAG_THRESHOLD
    )
      return
    conversationDragged.current = true
    event.preventDefault()
    const bounds = host.getBoundingClientRect()
    const metrics = floatingBounds()
    if (!metrics) return
    setPosition(
      constrainFloatingPanel(
        {
          left: event.clientX - bounds.left - drag.offsetX,
          top: event.clientY - bounds.top - drag.offsetY,
        },
        host.clientWidth,
        host.clientHeight,
        panel.offsetWidth,
        panel.offsetHeight,
        metrics.minimumTop
      )
    )
  }
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag?.pointerId !== event.pointerId) return
    const host = hostRef.current
    const bounds = floatingBounds()
    if (host && bounds && conversationDragged.current) {
      const hostBounds = host.getBoundingClientRect()
      const dock =
        event.type === 'pointerup'
          ? nearestFloatingPanelDock(
              {
                left: event.clientX - hostBounds.left - drag.offsetX,
                top: event.clientY - hostBounds.top - drag.offsetY,
              },
              bounds
            )
          : floatingDock
      setFloatingDock(dock)
      setPosition(floatingPanelDockPosition(dock, bounds))
      floatingResized.current = false
    }
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const navigation = featureRegistry.panels.find((panel) => panel.slot === 'navigation')
  const openNewTab = (): void => {
    set((current) => {
      const tab = newProjectTab(current.homeSelectedProjectId)
      return { activeTab: tab.id, tabs: [...current.tabs, tab] }
    })
    patch({ open: true, taskTab: false })
  }
  const workspaceToggle = (
    <Tooltip content={t(workspaceTabCount ? 'openTabs' : 'newTabAction')} side="bottom">
      <IconButton
        variant="ghostIcon"
        size="md"
        label={t(workspaceTabCount ? 'openTabs' : 'newTabAction')}
        title={undefined}
        aria-expanded={layout.open}
        icon={
          workspaceTabCount ? (
            <span className="relative inline-flex size-[var(--vds-icon-button-glyph)] items-center justify-center">
              <Square />
              <span className="absolute inset-0 flex items-center justify-center text-[length:var(--vds-workspace-tab-count-font-size)] font-[var(--vds-fw-medium)] leading-none">
                {workspaceTabCount}
              </span>
            </span>
          ) : (
            <SquarePlus />
          )
        }
        onClick={workspaceTabCount ? () => changeLayout('toggleWorkspace') : openNewTab}
        data-testid="workspace-open"
      />
    </Tooltip>
  )
  const minimizeControl = (
    <Tooltip content={t('minimizeConversation')} side="bottom">
      <IconButton
        variant="ghostIcon"
        size="md"
        label={t('minimizeConversation')}
        title={undefined}
        icon={<Minus />}
        data-testid="workspace-minimize-conversation"
        onClick={() => changeLayout('minimizeConversation')}
      />
    </Tooltip>
  )
  const workspaceControls = (
    <span className="contents">
      {!floating && <TaskOverview />}
      {conversationFull && (
        <>
          {minimizeControl}
          <Tooltip
            content={t(compact ? 'expandConversation' : 'collapseConversation')}
            side="bottom"
          >
            <IconButton
              variant="ghostIcon"
              size="md"
              label={t(compact ? 'expandConversation' : 'collapseConversation')}
              title={undefined}
              icon={compact ? <ChevronUp /> : <ChevronDown />}
              aria-expanded={!compact}
              data-testid="workspace-expand-messages"
              onClick={() => changeLayout('toggleFloating')}
            />
          </Tooltip>
        </>
      )}
      {floating ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              variant="ghostIcon"
              size="md"
              label={t('conversationActions')}
              title={undefined}
              icon={<GripVertical />}
              data-workspace-drag-handle
              data-testid="workspace-conversation-menu"
              className="order-last cursor-grab touch-none active:cursor-grabbing"
              onClick={(event) => {
                if (conversationDragged.current && event.detail !== 0) event.preventDefault()
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="floating-conversation-menu">
            <DropdownMenuItem onSelect={() => changeLayout('moveConversationRight')}>
              <ArrowRightToLine />
              {t('moveConversationRight')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => changeLayout('moveConversationLeft')}>
              <ArrowLeftToLine />
              {t('moveConversationLeft')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => changeLayout('minimizeConversation')}>
              <Minus />
              {t('minimizeTaskEntry')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => changeLayout('pinConversation')}>
              <SquareArrowUpLeft />
              {t('exitFloating')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <SessionDropdownMenu
          target={{
            inProject: true,
            sessionId: thread.sessionId ?? '',
            title: thread.title,
            title_fallback: thread.title_fallback,
          }}
          layoutActions={
            <>
              <DropdownMenuItem
                onSelect={() => {
                  if (!conversationPinnedOut && workspaceTabCount === 0) openNewTab()
                  changeLayout('pinConversation')
                }}
              >
                {conversationPinnedOut ? (
                  <IconFont type="fill-tool-pin" />
                ) : (
                  <SquareArrowDownRight />
                )}
                {t(conversationPinnedOut ? 'dockConversation' : 'enterFloating')}
              </DropdownMenuItem>
              {layout.open && (
                <DropdownMenuItem
                  onSelect={() =>
                    changeLayout(layout.swapped ? 'moveConversationLeft' : 'moveConversationRight')
                  }
                >
                  {layout.swapped ? <ArrowLeftToLine /> : <ArrowRightToLine />}
                  {t(layout.swapped ? 'moveConversationLeft' : 'moveConversationRight')}
                </DropdownMenuItem>
              )}
            </>
          }
        >
          <Tooltip content={t('moreActions')} side="bottom" portalled>
            <IconButton
              variant="ghostIcon"
              size="md"
              label={t('moreActions')}
              title={undefined}
              icon={
                <MoreVertical className="[stroke-width:var(--vds-project-header-icon-stroke)]" />
              }
              data-testid="workspace-conversation-menu"
            />
          </Tooltip>
        </SessionDropdownMenu>
      )}
      {conversationFull && (
        <Tooltip
          content={t(conversationFull ? 'exitConversationFull' : 'conversationFull')}
          side="bottom"
        >
          <IconButton
            variant="ghostIcon"
            size="md"
            label={t(conversationFull ? 'exitConversationFull' : 'conversationFull')}
            title={undefined}
            icon={conversationFull ? <Minimize2 /> : <Maximize2 />}
            onClick={() => changeLayout('toggleConversationFull')}
            data-testid="workspace-conversation-full"
          />
        </Tooltip>
      )}
      {!floating && !conversationFull && !layout.open && (
        <>
          <Divider
            orientation="vertical"
            className="h-[var(--vds-space-3)] !self-center [--vds-divider-min-height:var(--vds-space-3)] [--vds-divider-margin-vertical:0]"
          />
          {workspaceToggle}
        </>
      )}
    </span>
  )
  let floatingContent:
    | { side: 'top' | 'bottom'; height: number; anchorHeight: number; headingHeight: number }
    | undefined
  if (floating && !minimized && position && floatingMetrics && hostRef.current) {
    const above = Math.max(0, position.top - floatingMetrics.minimumTop)
    const below = Math.max(
      0,
      floatingMetrics.hostHeight -
        position.top -
        floatingMetrics.panelHeight -
        floatingMetrics.inset
    )
    const preferredHeight = floatingMetrics.hostHeight * FLOATING_CONTENT_HEIGHT_RATIO
    const side = above >= Math.min(preferredHeight, below) ? 'top' : 'bottom'
    floatingContent = {
      side,
      height: Math.min(preferredHeight, side === 'top' ? above : below),
      anchorHeight: floatingMetrics.panelHeight,
      headingHeight: Number.parseFloat(
        getComputedStyle(hostRef.current).getPropertyValue('--vds-space-9')
      ),
    }
  }
  return (
    <Motion
      project={state.homeSelectedProjectId}
      dragging={Boolean(dragRef.current || bubbleDrag.current || floatingResize.current)}
      revision={`${layout.full}:${layout.taskTab}:${conversationFull}:${layout.swapped}:${layout.floating}:${floatingDock}`}
      className={`flex h-full min-h-0 min-w-0 flex-1${(!state.modulePanelOpen || conversationFull) && window.scholarseed?.platform === 'darwin' ? (conversationHeaderLeading ? ' [&_.vds-ai-head]:!pl-[var(--vds-layout-overview-title-inset)]' : ' [&_[data-navigation-leading]]:!pl-[var(--vds-layout-overview-title-inset)]') : ''}`}
      data-testid="project-workspace"
    >
      <ResizablePanel
        animated
        className={String.raw`min-h-0 min-w-0 flex-1 [&>.vds-resizable-split\_\_handle]:!mx-[calc(var(--vds-resizable-handle-active-size)/-2)]`}
        isLeftCollapsed={!state.modulePanelOpen || conversationFull}
        resizeEnabled={state.modulePanelOpen && !conversationFull}
        leftWidth={navigationWidth}
        minLeftWidth={MODULE_PANEL_DEFAULT_WIDTH}
        maxLeftWidth={MODULE_PANEL_MAX_WIDTH}
        leftWidthStep={MODULE_PANEL_WIDTH_STEP}
        onWidthChangeEnd={onNavigationWidthChange}
        leftPanel={<div className="flex h-full min-h-0 flex-col">{navigation?.render()}</div>}
        rightPanel={
          <div
            className="relative flex h-full min-h-0 min-w-0 flex-1"
            ref={hostRef}
            data-testid="workspace-floating-area"
          >
            <ResizablePanel
              animated
              className={cx(
                String.raw`h-full min-h-0 min-w-0 flex-1 [&>.vds-resizable-split\_\_panel--left]:!overflow-visible`,
                fullSurface &&
                  String.raw`[&>.vds-resizable-split\_\_panel--left]:!w-0 [&>.vds-resizable-split\_\_panel--left]:!min-w-0 [&>.vds-resizable-split\_\_panel--left]:!flex-none [&>.vds-resizable-split\_\_panel--right]:!w-full [&>.vds-resizable-split\_\_panel--right]:!flex-1`,
                !showConversationDivider &&
                  String.raw`[&>.vds-resizable-split\_\_handle]:!hidden [&>.vds-resizable-split\_\_handle]:pointer-events-none`
              )}
              reversed={layout.swapped}
              leftWidth={`${layout.conversationWidth}px`}
              resizeEnabled={showConversationDivider}
              onWidthChangeEnd={(width) =>
                !layout.full && patch({ conversationWidth: Number.parseFloat(width) })
              }
              minLeftWidth={fullSurface ? 0 : CONTENT_MIN_WIDTH}
              minRightWidth={CONTENT_MIN_WIDTH}
              maxLeftWidth={CONTENT_MAX_WIDTH}
              isCollapsed={!layout.open && !conversationFull}
              leftPanel={
                <div
                  className={cx(
                    !floating &&
                      '[&_.vds-ai-head]:[-webkit-app-region:drag] [&_.vds-ai-head_button]:[-webkit-app-region:no-drag] [&_.vds-ai-head_[tabindex]]:[-webkit-app-region:no-drag]',
                    conversationFull
                      ? 'absolute inset-0 z-[var(--vds-z-local-raised)] flex min-h-0 flex-col'
                      : layout.full
                        ? layout.taskTab
                          ? 'absolute inset-0 z-[var(--vds-z-local-raised)] flex min-h-0 flex-col pt-[var(--vds-workbench-header-height)]'
                          : 'absolute bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] z-[var(--vds-z-floating-panel)] flex h-[var(--vds-workspace-ai-panel-height)] max-h-[var(--vds-workspace-ai-panel-max-height)] w-[var(--vds-workspace-ai-panel-width)] flex-col overflow-hidden rounded-[var(--vds-radius-5)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] shadow-[var(--vds-shadow-3-center)]'
                        : 'flex h-full min-h-0 w-full flex-col',
                    floating &&
                      '!h-auto !w-[var(--vds-floating-conversation-width)] max-w-[calc(100%-var(--vds-space-8))] !rounded-[var(--vds-radius-6)] !border-0 !bg-[var(--vds-bg-white-default)] !shadow-[var(--vds-shadow-aidialog-2)] [&_.vds-ai-panel]:!bg-transparent [&_.vds-ai-composer-host]:!px-0 [&_.vds-ai-head]:!h-[var(--vds-space-10)] [&_.vds-ai-head]:!shrink-0 [&_.vds-ai-head]:!bg-[var(--vds-bg-white-default)] [&_.vds-ai-head]:!px-[var(--vds-space-2)] [&_.vds-ai-session]:overflow-hidden [&_.vds-ai-session]:font-[var(--vds-fw-regular)] [&_.vds-ai-session]:text-[length:var(--vds-font-body-lv1)] [&_.vds-ai-head-actions]:gap-0',
                    floating &&
                      '[&_.vds-ai-session]:!text-[length:var(--vds-font-body-lv2)] [&_.vds-ai-session]:!leading-[var(--vds-lh-body-lv2)] [&_.vds-ai-session]:!font-[var(--vds-fw-regular)] [&_.vds-ai-session_*]:!font-[var(--vds-fw-regular)]',
                    floating &&
                      compact &&
                      '!overflow-visible [&_.vds-ai-head]:absolute [&_.vds-ai-head]:inset-x-0 [&_.vds-ai-head]:bottom-full [&_.vds-ai-head]:rounded-t-[var(--vds-radius-6)]',
                    floating &&
                      compact &&
                      floatingActive &&
                      "!rounded-t-none [&_.vds-ai-head]:!h-auto [&_.vds-ai-head]:!gap-[var(--vds-space-2)] [&_.vds-ai-head]:!px-[var(--vds-space-3)] [&_.vds-ai-head]:!pt-[var(--vds-space-3)] [&_.vds-ai-head]:!pb-[var(--vds-space-2)] [&_.vds-ai-head]:border-[length:var(--vds-border-width-1)] [&_.vds-ai-head]:border-solid [&_.vds-ai-head]:border-[var(--vds-border-default)] [&_.vds-ai-head]:border-b-0 [&_.vds-ai-head]:after:absolute [&_.vds-ai-head]:after:inset-x-[var(--vds-space-3)] [&_.vds-ai-head]:after:bottom-0 [&_.vds-ai-head]:after:h-[var(--vds-border-width-1)] [&_.vds-ai-head]:after:bg-[var(--vds-divider-default)] [&_.vds-ai-head]:after:content-[''] [&_.vds-ai-session]:!text-[length:var(--vds-font-body-lv2)] [&_.vds-ai-session]:!leading-[var(--vds-lh-body-lv2)] [&_.vds-ai-session]:!tracking-[var(--vds-letter-spacing-normal)] [&_.vds-ai-session_span]:!text-[var(--vds-text-secondary)] [&_[data-testid=composer-drop-zone]]:!rounded-t-none [&_[data-testid=composer-drop-zone]]:!rounded-b-[var(--vds-radius-6)] [&_[data-testid=composer-drop-zone]]:!border-[length:var(--vds-border-width-1)] [&_[data-testid=composer-drop-zone]]:!border-t-transparent [&_[data-testid=composer-drop-zone]]:!border-[var(--vds-border-default)]",
                    floating &&
                      !compact &&
                      "!overflow-visible !bg-transparent !shadow-none [&_.vds-ai-head]:!relative [&_.vds-ai-head]:!h-auto [&_.vds-ai-head]:!shrink-0 [&_.vds-ai-head]:!bg-transparent [&_.vds-ai-head]:!px-[var(--vds-space-3)] [&_.vds-ai-head]:!pt-[var(--vds-space-3)] [&_.vds-ai-head]:!pb-[var(--vds-space-2)] [&_.vds-ai-head]:!gap-[var(--vds-space-2)] [&_.vds-ai-head]:border-b-0 [&_.vds-ai-head]:after:absolute [&_.vds-ai-head]:after:inset-x-[var(--vds-space-3)] [&_.vds-ai-head]:after:bottom-0 [&_.vds-ai-head]:after:h-[var(--vds-border-width-1)] [&_.vds-ai-head]:after:bg-[var(--vds-divider-default)] [&_.vds-ai-head]:after:content-[''] [&_[data-testid=composer-drop-zone]]:!border-0 [&_[data-testid=composer-drop-zone]]:!rounded-none [&_[data-testid=composer-drop-zone]]:!shadow-none"
                  )}
                  data-workbench-motion={
                    !minimized && !(floating && !compact) ? 'conversation' : undefined
                  }
                  data-testid="workspace-conversation"
                  data-floating-active={floating ? floatingActive : undefined}
                  data-floating-dock={floating ? floatingDock : undefined}
                  data-mode={
                    conversationFull
                      ? 'fullscreen'
                      : layout.full
                        ? layout.taskTab
                          ? 'tab'
                          : 'floating'
                        : 'split'
                  }
                  ref={conversationRef}
                  data-content-collapsed={compact}
                  style={
                    minimized
                      ? { display: 'none' }
                      : floating
                        ? {
                            ...(position ? { ...position, right: 'auto', bottom: 'auto' } : {}),
                            height: 'auto',
                            ...(floatingWidth !== null
                              ? { '--vds-floating-conversation-width': `${floatingWidth}px` }
                              : {}),
                          }
                        : undefined
                  }
                  onFocusCapture={(event) => {
                    floatingInteraction.current = event.nativeEvent
                    if (floating) setFloatingActive(true)
                  }}
                  onPointerDownCapture={(event) => {
                    floatingInteraction.current = event.nativeEvent
                    if (floating) setFloatingActive(true)
                  }}
                  onPointerDown={startDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                  onLostPointerCapture={() => {
                    if (dragRef.current) {
                      const bounds = floatingBounds()
                      if (bounds) setPosition(floatingPanelDockPosition(floatingDock, bounds))
                    }
                    dragRef.current = null
                  }}
                >
                  {floating &&
                    !minimized &&
                    (['left', 'right'] as const).map((edge) => (
                      <ResizableHandle
                        key={edge}
                        appearance="invisible"
                        aria-label={t('resizeFloatingConversation')}
                        aria-valuenow={floatingWidth ?? floatingMetrics?.panelWidth}
                        className={cx(
                          '!absolute inset-y-0 z-[var(--vds-z-local-control)] !h-auto !w-[var(--vds-resizable-handle-active-size)] !flex-none !bg-transparent touch-none select-none !cursor-ew-resize [-webkit-app-region:no-drag]',
                          edge === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
                        )}
                        data-testid={`floating-conversation-resize-${edge}`}
                        onResizeStart={startFloatingResize}
                        onOffsetChange={(delta) => resizeFloating(edge, delta)}
                        onResizeEnd={() => {
                          floatingResize.current = null
                        }}
                      />
                    ))}
                  <div className={cx('flex min-h-0 flex-1 flex-col', floating && 'isolate')}>
                    <TaskOverviewLayout
                      reserveSpace={!floating && (conversationFull || !layout.open)}
                    >
                      <AssistantPanel
                        embedded
                        hideHeader={layout.full && layout.taskTab && !conversationFull}
                        headerCollapsed={floating && compact && !floatingActive}
                        compact={compact}
                        inlineComposer={floating}
                        onToggleContent={
                          floating ? () => changeLayout('toggleFloating') : undefined
                        }
                        floatingContent={
                          floating
                            ? (floatingContent ?? {
                                side: 'top',
                                height: 0,
                                anchorHeight: 0,
                                headingHeight: 0,
                              })
                            : undefined
                        }
                        workspaceLeading={
                          floating
                            ? minimizeControl
                            : conversationHeaderLeading
                              ? sidebarToggle
                              : undefined
                        }
                        workspaceActions={workspaceControls}
                      />
                    </TaskOverviewLayout>
                  </div>
                </div>
              }
              rightPanel={
                <section
                  className="vds-workbench-pane flex h-full min-h-0 min-w-0 flex-col"
                  aria-label={t('workspace')}
                  data-testid="workspace-content"
                  data-workbench-motion="workspace"
                  style={conversationFull ? { visibility: 'hidden' } : undefined}
                >
                  <header className="drag relative z-[var(--vds-z-local-control)] flex h-[var(--vds-workbench-header-height)] min-w-0 shrink-0 items-center border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] [&_button]:[-webkit-app-region:no-drag] [&_svg]:[stroke-width:var(--vds-project-header-icon-stroke)]">
                    <div className="drag min-w-0 flex-1 self-stretch">
                      <TabBar
                        leading={!conversationHeaderLeading && sidebarToggle}
                        overflowTarget={tabOverflowTarget}
                        trailing={
                          <div className="flex items-center">
                            <IconButton
                              variant="ghostIcon"
                              size="md"
                              label={t('newTab')}
                              icon={<Plus />}
                              onClick={openNewTab}
                              data-testid="workspace-new-tab"
                            />
                          </div>
                        }
                        actions={
                          <div
                            className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)] pr-[var(--vds-space-4)]"
                            data-testid="workbench-actions"
                            data-ob={PROJECT_GUIDE_ANCHORS.workspace}
                          >
                            {layout.full && layout.taskTab && !conversationFull && (
                              <>
                                <IconButton
                                  variant="ghostIcon"
                                  size="md"
                                  label={assistantText('panel.new')}
                                  icon={<MessageCircle />}
                                  onClick={() => act.startPanelDraft()}
                                  data-testid="ai-new-session"
                                />
                                {workspaceControls}
                              </>
                            )}
                            <span
                              ref={setTabOverflowTarget}
                              className="contents"
                              data-testid="workspace-tab-overflow-slot"
                            />
                            <Tooltip content={t(layout.full ? 'exitFull' : 'full')} side="bottom">
                              <IconButton
                                variant="ghostIcon"
                                size="md"
                                title={undefined}
                                label={t(layout.full ? 'exitFull' : 'full')}
                                icon={layout.full ? <Minimize2 /> : <Maximize2 />}
                                onClick={() => changeLayout('toggleFull')}
                                data-testid="workspace-full"
                              />
                            </Tooltip>
                            <Tooltip content={t('hideTabs')} side="bottom">
                              <IconButton
                                variant="ghostIcon"
                                size="md"
                                title={undefined}
                                label={t('hideTabs')}
                                icon={<PanelRight />}
                                aria-expanded={layout.open}
                                aria-pressed={layout.open}
                                onClick={() => patch({ open: false, full: false, taskTab: false })}
                                data-testid="workspace-close"
                                data-ob={PROJECT_GUIDE_ANCHORS.closeWorkspace}
                              />
                            </Tooltip>
                          </div>
                        }
                      />
                    </div>
                  </header>
                  <div
                    className="min-h-0 min-w-0 flex-1 overflow-hidden"
                    hidden={layout.full && layout.taskTab}
                  >
                    <Workbench />
                  </div>
                </section>
              }
            />
            {minimized && (
              <div
                ref={bubbleRef}
                data-workbench-motion="conversation"
                data-workbench-motion-kind="entry"
                className="absolute bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] size-[var(--vds-floating-conversation-entry-size)] z-[var(--vds-z-floating-panel)]"
                style={
                  bubblePosition ? { ...bubblePosition, right: 'auto', bottom: 'auto' } : undefined
                }
              >
                <IconButton
                  variant="ghostIcon"
                  label={t('restoreConversation')}
                  icon={
                    <img
                      src={aiAssistantIcon}
                      alt=""
                      draggable={false}
                      className="size-[var(--vds-icon-10)]"
                    />
                  }
                  className="!size-[var(--vds-floating-conversation-entry-size)] !min-w-0 touch-none !rounded-[var(--vds-radius-6)] ![border:var(--vds-border-width-1)_solid_var(--vds-border-default)] ![background:var(--vds-bg-white-default)] !shadow-[var(--vds-shadow-aidialog-2)] [--vds-icon-button-glyph:var(--vds-icon-10)]"
                  data-testid="workspace-restore-conversation"
                  onPointerDown={startBubbleDrag}
                  onPointerMove={moveBubbleDrag}
                  onPointerUp={stopBubbleDrag}
                  onPointerCancel={stopBubbleDrag}
                  onLostPointerCapture={() => {
                    if (bubbleDrag.current) {
                      const bounds = floatingBounds()
                      if (bounds) setBubblePosition(floatingPanelDockPosition(floatingDock, bounds))
                    }
                    bubbleDrag.current = null
                  }}
                  onClick={(event) => {
                    if (bubbleDragged.current && event.detail !== 0) return
                    changeLayout('restoreConversation')
                  }}
                />
                {minimizedSession && (
                  <div className="absolute -right-[var(--vds-radius-3)] -top-[var(--vds-radius-3)]">
                    <TaskStatus
                      node={minimizedSession}
                      unread={sessionNeedsAttention(reminders.by_session[minimizedSession.id] ?? 0)}
                      variant="badge"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />
    </Motion>
  )
}
