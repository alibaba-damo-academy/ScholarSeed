import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { viewRequiresProject } from '../app/composition'
import { Button, Popover, PopoverContent, PopoverTrigger, ResizablePanel } from '../components/ui'
import { AiPanel } from '../features/assistant/AiPanel'
import {
  DeleteConfirm,
  LinkedCreateConfirm,
  LinkSupersedeConfirm,
  MoveDialog,
  UnlinkConfirm
} from '../features/resources/Dialogs'
import { ImportDialog } from '../features/resources/ImportDialog'
import { NodeMenu } from '../features/resources/NodeMenu'
import { GlobalSearch } from '../features/search/GlobalSearch'
import { HomeOverview } from '../features/home/HomeOverview'
import { Workbench } from '../features/workbench/Workbench'
import { DocumentDragProvider } from '../features/workbench/Dragging'
import { Icon } from '../icons'
import { hasProjectScope, useApp } from '../store'
import { ActivityRail } from './ActivityRail'
import { ModulePanel } from './ModulePanel'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from './ProjectMenu'
import { TopBar, TopBarLeft } from './TopBar'
import {
  ACTIVITY_RAIL_WIDTH,
  MODULE_PANEL_DEFAULT_WIDTH,
  MODULE_PANEL_MAX_WIDTH,
  MODULE_PANEL_WIDTH_STEP,
  MODULE_PANEL_WIDTH_UNIT,
  modulePanelWidthCss,
  parseModulePanelWidth,
  topBarLeftWidth
} from './geometry'

const MODULE_PANEL_WIDTH_STORAGE_KEY = 'scholarseed.modulePanel.width'
const AI_PANEL_WIDTH_STORAGE_KEY = 'scholarseed.aiPanel.width'
const AI_PANEL_DEFAULT_WIDTH = '26vw'
const AI_PANEL_MIN_WIDTH = 320
const AI_PANEL_MAX_WIDTH_PERCENT = 55
const MAIN_WORKBENCH_MIN_WIDTH = 160
const WORKBENCH_SPLIT_CLASS_NAME = String.raw`min-h-0 flex-1 [--vds-resizable-handle-active-guide-color:var(--vds-border-default)] [--vds-resizable-handle-active-guide-edge-color:var(--vds-border-default)] [--vds-resizable-handle-current-guide-color:var(--vds-border-default)] [--vds-resizable-handle-current-guide-edge-color:var(--vds-border-default)] [--vds-resizable-handle-drag-guide-color:var(--vds-border-default)] [--vds-resizable-handle-drag-guide-edge-color:var(--vds-border-default)] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-image:linear-gradient(to_bottom,transparent_calc(var(--vds-workbench-content-toolbar-height)_-_var(--vds-border-width-1)),var(--vds-border-default)_0_var(--vds-workbench-content-toolbar-height),transparent_0)] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-position:right_top] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-repeat:no-repeat] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-size:50%_100%] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:left-1/2 [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:translate-x-0 [&>.vds-resizable-split\_\_panel]:flex [&>.vds-resizable-split\_\_panel]:min-h-0 [&>.vds-resizable-split\_\_panel]:overflow-hidden [&>.vds-resizable-split\_\_panel--left]:shrink-0`

function readStoredModulePanelWidth(): number {
  const raw = window.localStorage.getItem(MODULE_PANEL_WIDTH_STORAGE_KEY)
  return raw ? parseModulePanelWidth(raw) : MODULE_PANEL_DEFAULT_WIDTH
}

function readStoredAiPanelWidth(): string {
  const raw = window.localStorage.getItem(AI_PANEL_WIDTH_STORAGE_KEY)
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN
  return Number.isFinite(parsed)
    ? modulePanelWidthCss(Math.max(parsed, AI_PANEL_MIN_WIDTH))
    : AI_PANEL_DEFAULT_WIDTH
}

function parseAiPanelWidth(width: string): number {
  const parsed = Number.parseFloat(width.replace(MODULE_PANEL_WIDTH_UNIT, ''))
  return Number.isFinite(parsed) ? Math.max(parsed, AI_PANEL_MIN_WIDTH) : AI_PANEL_MIN_WIDTH
}

function renderMainWorkbench(): React.JSX.Element {
  return (
    <main className="vds-workbench-main h-full min-h-0">
      <div className="vds-workbench-pane flex-1 min-h-0 overflow-hidden bg-[var(--vds-bg-gray-default)]">
        <Workbench />
      </div>
    </main>
  )
}

function HomeHeader(): React.JSX.Element {
  const { state, set } = useApp()
  const { t } = useTranslation('shell')
  return (
    <header className="vds-home-header">
      <div className="vds-home-header-drag" aria-hidden />
      <Popover
        open={state.homeProjectMenuOpen}
        onOpenChange={(open) => set({ homeProjectMenuOpen: open })}
      >
        <PopoverTrigger asChild>
          <Button
            unstyled
            className="vds-home-project-trigger no-drag"
            data-testid="home-project-trigger"
            aria-haspopup="menu"
          >
            <span>{t('chrome.projectOverview')}</span>
            <Icon name="chevron-down" size={13} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className={PROJECT_POPOVER_CONTENT_CLASS}>
          <ProjectMenu onClose={() => set({ homeProjectMenuOpen: false })} />
        </PopoverContent>
      </Popover>
    </header>
  )
}

function renderMainSurface(
  resizeAssistantLabel: string,
  topBar: React.ReactNode,
  body: React.ReactNode,
  aiPanelOpen: boolean,
  aiPanelDocked: boolean,
  aiPanelCover: boolean,
  aiPanelWidth: string,
  onAiPanelWidthChange: (width: string) => void,
  onAiPanelWidthChangeEnd: (width: string) => void
): React.JSX.Element {
  const mainColumn = (
    <div className="vds-workbench-main-column" data-vds-toast-viewport>
      {topBar}
      {body}
    </div>
  )
  const dockedAiPanel = aiPanelOpen && aiPanelDocked && !aiPanelCover

  return (
    <div className="vds-workbench-surface">
      <ResizablePanel
        aria-label={resizeAssistantLabel}
        className={`vds-ai-panel-resizable min-h-0 flex-1 [&>.vds-resizable-split__panel--left_.vds-workbench-body]:overflow-x-auto [&>.vds-resizable-split__panel--left_.vds-workbench-body]:overflow-y-hidden${dockedAiPanel ? ' [background-image:linear-gradient(to_bottom,transparent_calc(var(--vds-workbench-header-height)_-_var(--vds-border-width-1)),var(--vds-border-default)_0_var(--vds-workbench-header-height),transparent_0)]' : ''}`}
        defaultRightWidth={aiPanelWidth}
        isCollapsed={!dockedAiPanel}
        leftPanel={mainColumn}
        minLeftWidth={MAIN_WORKBENCH_MIN_WIDTH}
        maxRightWidth={AI_PANEL_MAX_WIDTH_PERCENT}
        minRightWidth={AI_PANEL_MIN_WIDTH}
        onRightWidthChange={onAiPanelWidthChange}
        onRightWidthChangeEnd={onAiPanelWidthChangeEnd}
        rightPanel={dockedAiPanel ? <AiPanel /> : null}
      />
      {aiPanelOpen && !aiPanelDocked && !aiPanelCover ? <AiPanel /> : null}
    </div>
  )
}

/**
 * 0.2 四区外壳：顶栏 + 活动栏 + 模块面板 + 中央工作区 + AI 面板。
 *
 * 该组件只做装配与快捷键，不承载任何模块业务；模块业务在
 * features/<domain>/ 下由各自负责人维护。
 */
export function WorkbenchShell(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const [modulePanelWidth, setModulePanelWidth] = useState(readStoredModulePanelWidth)
  const aiPanelWidthRef = useRef(readStoredAiPanelWidth())

  const modulePanelUserOverride = useRef(false)
  const prevPdfPanelRef = useRef(state.pdfSidePanelOpen)
  useEffect(() => {
    const wasOpen = prevPdfPanelRef.current
    prevPdfPanelRef.current = state.pdfSidePanelOpen
    if (!state.pdfSidePanelOpen) {
      modulePanelUserOverride.current = false
      return
    }
    if (wasOpen || modulePanelUserOverride.current || !state.modulePanelOpen) return
    act.toggleModulePanel()
  }, [state.pdfSidePanelOpen, state.modulePanelOpen, act])

  // 未选项目时整条模块面板隐藏：面板内容全都以项目为参数，留着只会展示一棵
  // 报错的树。「展开侧栏」按钮一起收掉 —— 没有面板可展开时它是个死入口。
  const panelBlocked = viewRequiresProject(state.mainView) && !hasProjectScope(state)
  const modulePanelVisible = state.modulePanelOpen && !panelBlocked
  const assistantExpanded = state.aiPanel.open && state.aiPanel.cover
  const modulePanelWidthValue = topBarLeftWidth(modulePanelWidth, modulePanelVisible)
  const modulePanelResizeWidth = modulePanelWidthCss(modulePanelWidth)
  const persistModulePanelWidth = (width: string): void => {
    const nextWidth = parseModulePanelWidth(width)
    setModulePanelWidth(nextWidth)
    window.localStorage.setItem(MODULE_PANEL_WIDTH_STORAGE_KEY, String(nextWidth))
  }
  const persistAiPanelWidth = (width: string): void => {
    const nextWidth = parseAiPanelWidth(width)
    aiPanelWidthRef.current = modulePanelWidthCss(nextWidth)
  }
  const commitAiPanelWidth = (width: string): void => {
    const nextWidth = parseAiPanelWidth(width)
    aiPanelWidthRef.current = modulePanelWidthCss(nextWidth)
    window.localStorage.setItem(AI_PANEL_WIDTH_STORAGE_KEY, String(nextWidth))
  }

  return (
    <DocumentDragProvider>
      <div className="vds-workbench" data-testid="workbench-shell" data-platform={window.scholarseed?.platform ?? 'web'}>
        {state.mainView === 'home' ? (
          /* 首页空间（原型 home space）：轻量标题栏 + 活动栏 + 全览内容；工作台标签 /
             模块面板 / AI 面板一律不挂 —— 首页是全局面，不携带任何项目上下文。 */
          <div className="vds-home-shell" data-testid="workbench-home-space">
            <HomeHeader />
            <div className="vds-home-body">
              <ActivityRail />
              <main className="vds-home-main" data-vds-toast-viewport>
                <HomeOverview />
              </main>
            </div>
          </div>
        ) : (
          renderMainSurface(
            t('panels.resizeAssistant'),
            assistantExpanded ? null : <TopBar leftWidth={modulePanelWidthValue} />,
            <div className="vds-workbench-body [.vds-ai-panel-resizable>.vds-resizable-split__panel--left_&]:overflow-x-auto [.vds-ai-panel-resizable>.vds-resizable-split__panel--left_&]:overflow-y-hidden">
              {assistantExpanded && modulePanelVisible ? (
                <div
                  className="absolute left-0 top-0 z-[var(--vds-z-local-raised)]"
                  style={{ width: modulePanelWidthCss(modulePanelWidth + ACTIVITY_RAIL_WIDTH) }}
                >
                  <TopBarLeft showRightBorder={false} />
                </div>
              ) : null}
              <div className={`flex shrink-0${assistantExpanded ? ' pt-[var(--vds-workbench-header-height)]' : ''}`}>
                <ActivityRail />
              </div>
              <ResizablePanel
                aria-label={t('panels.resizeModule')}
                className={WORKBENCH_SPLIT_CLASS_NAME}
                isLeftCollapsed={!modulePanelVisible}
                leftPanel={modulePanelVisible ? (
                  <div className={`flex min-h-0 min-w-0 flex-1${assistantExpanded ? ' pt-[var(--vds-workbench-header-height)]' : ''}`}>
                    <ModulePanel />
                  </div>
                ) : null}
                leftWidth={modulePanelResizeWidth}
                leftWidthStep={MODULE_PANEL_WIDTH_STEP}
                maxLeftWidth={MODULE_PANEL_MAX_WIDTH}
                minLeftWidth={MODULE_PANEL_DEFAULT_WIDTH}
                onWidthChange={persistModulePanelWidth}
                rightPanel={(
                  <div className="flex min-h-0 min-w-0 flex-1">
                    <div className={assistantExpanded ? 'hidden' : 'min-h-0 min-w-0 flex-1'}>
                      {renderMainWorkbench()}
                    </div>
                    {assistantExpanded ? <AiPanel /> : null}
                  </div>
                )}
              />
            </div>,
            state.aiPanel.open,
            state.aiPanel.docked,
            state.aiPanel.cover,
            aiPanelWidthRef.current,
            persistAiPanelWidth,
            commitAiPanelWidth
          )
        )}

        {state.resource.importDialog && <ImportDialog />}
        {state.globalSearchOpen && <GlobalSearch />}
        {/* 资料树菜单与弹层，各自根据切片状态自行决定是否渲染。 */}
        <NodeMenu />
        <LinkedCreateConfirm />
        <DeleteConfirm />
        <UnlinkConfirm />
        <LinkSupersedeConfirm />
        <MoveDialog />
      </div>
    </DocumentDragProvider>
  )
}
