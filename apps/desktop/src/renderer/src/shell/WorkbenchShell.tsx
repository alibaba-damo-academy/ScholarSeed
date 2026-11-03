import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import scholarseedLogoMark from '../assets/logo.svg'
import { featureRegistry, viewRequiresProject } from '../app/composition'
import { ErrorBoundary } from '../app/Error'
import { ResizablePanel } from '../components/ui'
import { AssistantPanel } from '../features/assistant/Panel'
import {
  DeleteConfirm,
  LinkedCreateConfirm,
  LinkSupersedeConfirm,
  MoveDialog,
  UnlinkConfirm,
} from '../features/resources/Dialogs'
import { ImportDialog } from '../features/resources/ImportDialog'
import { NodeMenu } from '../features/resources/NodeMenu'
import { GlobalSearch } from '../features/search/GlobalSearch'
import { HomeOverview } from '../features/home/HomeOverview'
import { Workbench } from '../features/workbench/Workbench'
import { DocumentDragProvider } from '../features/workbench/Dragging'
import { hasProjectScope, useApp } from '../store'
import { ActivityRail } from './ActivityRail'
import { HomeHeader } from './Header'
import { ModulePanel } from './ModulePanel'
import { modulePanelForView } from './panels'
import { TopBar, TopBarLeft } from './TopBar'
import { Workspace } from './Workspace'
import {
  MODULE_PANEL_DEFAULT_WIDTH,
  MODULE_PANEL_MAX_WIDTH,
  MODULE_PANEL_WIDTH_STEP,
  MODULE_PANEL_WIDTH_UNIT,
  modulePanelWidthCss,
  parseModulePanelWidth,
  topBarLeftWidth,
} from './geometry'

const MODULE_PANEL_WIDTH_STORAGE_KEY = 'scholarseed.modulePanel.width'
const MODULE_PANEL_WIDTH_PROPERTY = '--vds-workbench-module-width'
const AI_PANEL_WIDTH_STORAGE_KEY = 'scholarseed.aiPanel.width'
const AI_PANEL_DEFAULT_WIDTH = '26vw'
const AI_PANEL_MIN_WIDTH = 320
const AI_PANEL_MAX_WIDTH_PERCENT = 55
const MAIN_WORKBENCH_MIN_WIDTH = 160
const WORKBENCH_ROOT_CLASS_NAME =
  'vds-workbench flex h-full min-w-0 w-full flex-col bg-[var(--vds-bg-gray-default)] text-[var(--wb-ink)] [--vds-window-controls-left-space:var(--vds-workbench-window-controls-left-space)] [--wb-surface:var(--vds-workbench-light-surface)] [--wb-white:var(--vds-workbench-light-paper)] [--wb-rail:var(--vds-workbench-light-rail)] [--wb-rail-icon:var(--vds-static-white)] [--wb-rail-on:var(--vds-static-white)] [--wb-on-green:var(--vds-workbench-light-foreground-on-rail)] [--wb-green:var(--vds-workbench-light-primary)] [--wb-green-hover:var(--vds-workbench-light-primary-hover)] [--wb-tint:var(--vds-workbench-light-selection)] [--wb-ink:var(--vds-workbench-light-text-primary)] [--wb-ink-2:var(--vds-workbench-light-text-secondary)] [--wb-muted:var(--vds-workbench-light-text-muted)] [--wb-line:var(--vds-workbench-light-border)] [--wb-line-soft:var(--vds-workbench-light-divider)] data-[platform=win32]:[--vds-window-controls-left-space:var(--vds-workbench-window-controls-left-space-win32)] [[data-theme=dark]_&]:[--wb-canvas:var(--vds-bg-page)] [[data-theme=dark]_&]:[--wb-surface:var(--vds-bg-gray-light-default)] [[data-theme=dark]_&]:[--wb-white:var(--vds-bg-white-default)] [[data-theme=dark]_&]:[--wb-green:var(--vds-brand-bg-default)] [[data-theme=dark]_&]:[--wb-green-hover:var(--vds-brand-bg-hover)] [[data-theme=dark]_&]:[--wb-tint:var(--vds-brand-light-bg-default)] [[data-theme=dark]_&]:[--wb-ink:var(--vds-text-primary)] [[data-theme=dark]_&]:[--wb-ink-2:var(--vds-text-secondary)] [[data-theme=dark]_&]:[--wb-muted:var(--vds-text-tertiary)] [[data-theme=dark]_&]:[--wb-line:var(--vds-border-default)] [[data-theme=dark]_&]:[--wb-line-soft:var(--vds-divider-default)]'
const WORKBENCH_SPLIT_CLASS_NAME = String.raw`min-h-0 flex-1 [--vds-resizable-handle-active-guide-color:var(--vds-divider-default)] [--vds-resizable-handle-active-guide-edge-color:var(--vds-divider-default)] [--vds-resizable-handle-current-guide-color:var(--vds-divider-default)] [--vds-resizable-handle-current-guide-edge-color:var(--vds-divider-default)] [&:has(.lit-page)>.vds-resizable-split\_\_handle]:bg-[var(--vds-bg-gray-default)] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-image:linear-gradient(to_bottom,transparent_calc(var(--vds-workbench-content-toolbar-height)_-_var(--vds-border-width-1)),var(--vds-border-default)_0_var(--vds-workbench-content-toolbar-height),transparent_0)] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-position:right_top] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-repeat:no-repeat] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-size:50%_100%] [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:left-1/2 [&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:translate-x-0 [&>.vds-resizable-split\_\_panel]:flex [&>.vds-resizable-split\_\_panel]:min-h-0 [&>.vds-resizable-split\_\_panel]:overflow-hidden [&>.vds-resizable-split\_\_panel--left]:shrink-0`

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
    <main className="vds-workbench-main h-full min-h-0" id="main-content">
      <div className="vds-workbench-pane flex-1 min-h-0 overflow-hidden bg-[var(--vds-bg-gray-default)]">
        <ErrorBoundary embedded>
          <Workbench />
        </ErrorBoundary>
      </div>
    </main>
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
    <div className="vds-workbench-main-column relative flex min-h-0 min-w-0 flex-1 flex-col">
      {topBar}
      {body}
    </div>
  )
  const dockedAiPanel = aiPanelOpen && aiPanelDocked && !aiPanelCover

  return (
    <div className="vds-workbench-surface">
      <ResizablePanel
        animated
        aria-label={resizeAssistantLabel}
        className={`vds-ai-panel-resizable min-h-0 flex-1 [--vds-resizable-handle-z-index:var(--vds-z-inline-flyout)] [&>.vds-resizable-split__panel--left_.vds-workbench-body]:overflow-x-auto [&>.vds-resizable-split__panel--left_.vds-workbench-body]:overflow-y-hidden${dockedAiPanel ? ' [background-image:linear-gradient(to_bottom,transparent_calc(var(--vds-workbench-header-height)_-_var(--vds-border-width-1)),var(--vds-border-default)_0_var(--vds-workbench-header-height),transparent_0)]' : ''}`}
        defaultRightWidth={aiPanelWidth}
        isCollapsed={!dockedAiPanel}
        leftPanel={mainColumn}
        minLeftWidth={MAIN_WORKBENCH_MIN_WIDTH}
        maxRightWidth={AI_PANEL_MAX_WIDTH_PERCENT}
        minRightWidth={AI_PANEL_MIN_WIDTH}
        onRightWidthChange={onAiPanelWidthChange}
        onRightWidthChangeEnd={onAiPanelWidthChangeEnd}
        rightPanel={aiPanelDocked && !aiPanelCover ? <AssistantPanel /> : null}
      />
      {aiPanelOpen && !aiPanelDocked && !aiPanelCover ? <AssistantPanel /> : null}
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
  const { state, act } = useApp()
  const { t, i18n } = useTranslation('shell')
  const page = featureRegistry.panels.find(
    (panel) => panel.slot === 'page' && panel.key === state.mainView
  )
  const [macFullscreen, setMacFullscreen] = useState(
    () => window.scholarseed?.platform === 'darwin' && Boolean(window.scholarseed.fullscreen)
  )
  useEffect(() => {
    if (window.scholarseed?.platform !== 'darwin') return
    return window.scholarseed.onFullscreenChange?.(setMacFullscreen)
  }, [])
  const [modulePanelWidth, setModulePanelWidth] = useState(readStoredModulePanelWidth)
  const shellRef = useRef<HTMLDivElement | null>(null)
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
  const panelBlocked =
    !modulePanelForView(state.mainView) ||
    (viewRequiresProject(state.mainView) && !hasProjectScope(state))
  const modulePanelVisible = state.modulePanelOpen && !panelBlocked
  const assistantExpanded = state.aiPanel.open && state.aiPanel.cover
  const modulePanelWidthValue = modulePanelVisible
    ? `calc(var(${MODULE_PANEL_WIDTH_PROPERTY}) + var(--vds-layout-rail-width) + var(--vds-resizable-handle-size) / 2 + var(--vds-border-width-1))`
    : topBarLeftWidth(modulePanelWidth, false)
  const modulePanelResizeWidth = modulePanelWidthCss(modulePanelWidth)
  const updateModulePanelWidth = (width: string): void => {
    const nextWidth = parseModulePanelWidth(width)
    setModulePanelWidth(nextWidth)
    window.localStorage.setItem(MODULE_PANEL_WIDTH_STORAGE_KEY, String(nextWidth))
  }
  const previewModulePanelWidth = (width: string): void => {
    shellRef.current?.style.setProperty(MODULE_PANEL_WIDTH_PROPERTY, width)
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
      <div
        className={WORKBENCH_ROOT_CLASS_NAME}
        ref={shellRef}
        style={{ [MODULE_PANEL_WIDTH_PROPERTY]: modulePanelResizeWidth } as React.CSSProperties}
        data-testid="workbench-shell"
        data-platform={window.scholarseed?.platform ?? 'web'}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-[var(--vds-space-4)] focus:top-[var(--vds-space-4)] focus:z-[var(--vds-z-overlay)] focus:rounded-[var(--vds-radius-3)] focus:bg-[var(--vds-bg-brand)] focus:px-[var(--vds-space-4)] focus:py-[var(--vds-space-2)] focus:text-[var(--vds-fg-on-brand)] focus:text-[length:var(--vds-font-body-lv2)] focus:font-[var(--vds-fw-medium)] focus:no-underline focus:outline-none focus:ring-2 focus:ring-[var(--vds-focus-brand)]"
        >
          {t('navigation.skipToContent')}
        </a>
        {macFullscreen ? (
          <img
            alt=""
            aria-hidden="true"
            className="pointer-events-none fixed left-[var(--vds-space-4)] top-[var(--vds-space-2)] z-[var(--vds-z-local-raised)] size-[var(--vds-space-8)]"
            draggable={false}
            src={scholarseedLogoMark}
          />
        ) : null}
        {state.mainView === 'home' || page ? (
          /* 首页空间（原型 home space）：轻量标题栏 + 活动栏 + 全览内容；工作台标签 /
             模块面板 / AI 面板一律不挂 —— 首页是全局面，不携带任何项目上下文。 */
          <div
            className="vds-home-shell flex flex-[1_1_auto] min-h-0 flex-col bg-[var(--vds-bg-gray-default)]"
            data-testid="workbench-home-space"
          >
            {page ? (
              <HomeHeader
                title={page.title(i18n)}
                avoidWindowControls={window.scholarseed?.platform === 'darwin' && !macFullscreen}
              />
            ) : null}
            <div className="vds-home-body flex flex-[1_1_auto] min-h-0">
              <div className="flex shrink-0 flex-col [&>nav]:flex-1">
                {!page ? (
                  <header className="h-[var(--vds-workbench-header-height)] shrink-0 border-b border-[var(--vds-divider-default)] [-webkit-app-region:drag]" />
                ) : null}
                <ActivityRail />
              </div>
              <main
                className={`vds-home-main relative min-w-0 flex-[1_1_auto] overflow-auto bg-[var(--vds-bg-gray-default)]${!page && window.scholarseed?.platform === 'darwin' && !macFullscreen ? ' [&_header]:!pl-[var(--vds-layout-overview-title-inset)]' : ''}`}
                id="main-content"
              >
                <ErrorBoundary embedded>{page ? page.render() : <HomeOverview />}</ErrorBoundary>
              </main>
            </div>
          </div>
        ) : state.homeSelectedProjectId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className={`flex min-h-0 flex-1${window.scholarseed?.platform === 'darwin' && !macFullscreen ? ' [&_[data-testid=project-navigation]>header]:!pl-[var(--vds-layout-overview-title-inset)]' : ''}`}
            >
              <div className="flex shrink-0 flex-col [&>nav]:flex-1">
                <div className="h-[var(--vds-workbench-header-height)] shrink-0 border-b border-[var(--vds-divider-default)] [-webkit-app-region:drag]" />
                <ActivityRail />
              </div>
              <Workspace
                navigationWidth={modulePanelResizeWidth}
                onNavigationWidthChange={updateModulePanelWidth}
              />
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
                  style={{ width: modulePanelWidthValue }}
                >
                  <TopBarLeft showRightBorder={false} />
                </div>
              ) : null}
              <div
                className={`flex shrink-0${assistantExpanded ? ' pt-[var(--vds-workbench-header-height)]' : ''}`}
              >
                <ActivityRail />
              </div>
              <ResizablePanel
                animated
                aria-label={t('panels.resizeModule')}
                className={WORKBENCH_SPLIT_CLASS_NAME}
                isLeftCollapsed={!modulePanelVisible}
                leftPanel={
                  !panelBlocked ? (
                    <div
                      className={`flex min-h-0 min-w-0 flex-1${assistantExpanded ? ' pt-[var(--vds-workbench-header-height)]' : ''}`}
                    >
                      <ModulePanel />
                    </div>
                  ) : null
                }
                leftWidth={modulePanelResizeWidth}
                leftWidthStep={MODULE_PANEL_WIDTH_STEP}
                maxLeftWidth={MODULE_PANEL_MAX_WIDTH}
                minLeftWidth={MODULE_PANEL_DEFAULT_WIDTH}
                onWidthChange={previewModulePanelWidth}
                onWidthChangeEnd={updateModulePanelWidth}
                rightPanel={
                  <div className="flex min-h-0 min-w-0 flex-1">
                    <div className={assistantExpanded ? 'hidden' : 'min-h-0 min-w-0 flex-1'}>
                      {renderMainWorkbench()}
                    </div>
                    {assistantExpanded ? (
                      <AssistantPanel sidebarVisible={modulePanelVisible} />
                    ) : null}
                  </div>
                }
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
