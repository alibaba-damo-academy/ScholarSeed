import React, { type CSSProperties, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import aiAssistantIcon from '../assets/ai_assistant.webp'
import {
  Button,
  NavigationButton,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '../components/ui'
import { IconFont } from '../components/primitive'
import { hasHorizontalSplit } from '../features/workbench/layout'
import { useDocumentWorkspace } from '../features/workbench/workspace'
import { selectedProject, useApp } from '../store'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from './ProjectMenu'
import { TabBar } from './TabBar'
import { modulePanelForView } from './panels'

const TOPBAR_LEFT_GROUP_CLASS_NAME =
  'vds-topbar-left-group relative flex h-[var(--vds-workbench-header-height)] w-full flex-none items-center gap-[var(--vds-space-2)] border-y border-l border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] [padding-left:var(--vds-window-controls-left-space)] pr-[var(--vds-space-1)]'
const TOPBAR_RIGHT_DIVIDER_CLASS_NAME =
  ' after:pointer-events-none after:absolute after:right-0 after:top-0 after:h-full after:w-[var(--vds-border-width-1)] after:bg-[var(--vds-divider-default)] after:content-[""]'
const TOPBAR_ICON_BUTTON_CLASS_NAME =
  '!flex !size-[var(--vds-control-height-sm)] !items-center !justify-center !p-0 !leading-none'
const TOPBAR_ACTIONS_WIDTH_PROPERTY = '--vds-top-bar-actions-width'

/**
 * 顶栏（对齐原型截图）：左上项目切换 / 搜索 / 侧栏折叠，右侧 AI 助手。
 *
 * 项目切换复用 0.1 既有状态（homeProjectMenuOpen），不另起一套。
 * 账号入口不在这里 —— PRD 把它定在左侧活动栏最下方，见 `ActivityRail`。
 */
export function TopBarLeft({
  showRightBorder = true,
}: {
  showRightBorder?: boolean
}): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const { t: layoutText } = useTranslation('layout')
  const isLiteratureOverview = state.mainView === 'literature' && !state.homeSelectedProjectId
  const compactLiteratureHeader = isLiteratureOverview && !state.modulePanelOpen
  const projectLabel =
    (state.mainView === 'home'
      ? t('chrome.projectOverview')
      : state.mainView === 'literature' && !state.homeSelectedProjectId
        ? t('chrome.literatureOverview')
        : undefined) ??
    selectedProject(state)?.name ??
    t('chrome.selectProject')
  const showGlobalSearch = state.mainView !== 'literature' || Boolean(state.homeSelectedProjectId)

  return (
    <div
      className={`${TOPBAR_LEFT_GROUP_CLASS_NAME}${showRightBorder && !compactLiteratureHeader ? TOPBAR_RIGHT_DIVIDER_CLASS_NAME : ''}${compactLiteratureHeader ? ' !border-t-0 !border-l-0' : ''}`}
    >
      {isLiteratureOverview ? (
        state.modulePanelOpen && (
          <h1
            className={`min-w-0 flex-1 truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)]${window.scholarseed?.platform === 'darwin' ? ' pl-[calc(var(--vds-layout-window-controls-end)+var(--vds-space-3)-var(--vds-window-controls-left-space))]' : ''}`}
            data-testid="topbar-literature-title"
          >
            {layoutText('literature')}
          </h1>
        )
      ) : (
        <Popover
          open={state.homeProjectMenuOpen}
          onOpenChange={(open) => set({ homeProjectMenuOpen: open })}
        >
          <div className="vds-project-switch shrink-0">
            <PopoverTrigger asChild>
              <NavigationButton
                label={projectLabel}
                className="w-[var(--vds-project-selector-width)]"
                data-testid="topbar-project"
                data-ob="project-switcher"
                aria-haspopup="menu"
              />
            </PopoverTrigger>
            <PopoverContent className={PROJECT_POPOVER_CONTENT_CLASS}>
              <ProjectMenu onClose={() => set({ homeProjectMenuOpen: false })} />
            </PopoverContent>
          </div>
        </Popover>
      )}

      <div
        className={`flex h-[var(--vds-control-height-md)] shrink-0 items-center gap-[var(--vds-space-1)]${compactLiteratureHeader ? '' : ' ml-auto'}`}
      >
        {showGlobalSearch ? (
          <Tooltip content={t('chrome.search')} side="bottom">
            <Button
              variant="ghostIcon"
              size="sm"
              className={TOPBAR_ICON_BUTTON_CLASS_NAME}
              aria-label={t('chrome.search')}
              data-testid="topbar-search"
              onClick={() => set({ globalSearchOpen: true, globalSearchMode: 'all' })}
            >
              <IconFont type="line-operation-search" />
            </Button>
          </Tooltip>
        ) : null}

        {modulePanelForView(state.mainView) && (
          <Tooltip
            content={
              state.modulePanelOpen ? t('chrome.collapseSidebar') : t('chrome.expandSidebar')
            }
            side="bottom"
            portalled
          >
            <IconButton
              variant="ghostIcon"
              size="md"
              label={
                state.modulePanelOpen ? t('chrome.collapseSidebar') : t('chrome.expandSidebar')
              }
              title={undefined}
              icon={
                <IconFont
                  type={state.modulePanelOpen ? 'panel-left-close' : 'panel-left-open'}
                  className="inline-flex items-center justify-center !leading-none"
                />
              }
              data-testid="topbar-panel-toggle"
              onClick={act.toggleModulePanel}
            />
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export function TopBarRight(): React.JSX.Element {
  const { state, act } = useApp()
  const documents = useDocumentWorkspace()
  const { t } = useTranslation('shell')
  const rootRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    const actions = actionsRef.current
    if (!root || !actions) return
    const updateActionsWidth = (): void => {
      root.style.setProperty(
        TOPBAR_ACTIONS_WIDTH_PROPERTY,
        `${actions.getBoundingClientRect().width}px`
      )
    }
    updateActionsWidth()
    const observer = new ResizeObserver(updateActionsWidth)
    observer.observe(actions)
    return () => observer.disconnect()
  }, [])
  const compactAiEntry =
    (state.mainView === 'resource' || state.mainView === 'literature') &&
    hasHorizontalSplit(documents.layout)
  const aiIcon = (
    <img
      alt=""
      className="size-[var(--vds-icon-7)]"
      draggable={false}
      height={14}
      src={aiAssistantIcon}
      width={14}
    />
  )
  return (
    <div
      ref={rootRef}
      className="vds-top-bar vds-top-bar-right relative flex w-0 min-w-0 !flex-1 !items-stretch !gap-0 !pr-0 !h-[var(--vds-workbench-header-height)]"
    >
      <TabBar />
      <div
        ref={actionsRef}
        className="vds-top-bar-actions no-drag absolute end-0 top-0 z-[var(--vds-z-elevated)] flex h-[var(--vds-workbench-header-height)] flex-none items-center gap-[var(--vds-space-3)] border-0 border-b border-solid border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] pe-[var(--vds-top-bar-inline-end)]"
      >
        {!state.aiPanel.open &&
          (compactAiEntry ? (
            <Tooltip content={t('chrome.aiAssistant')} side="bottom" portalled>
              <IconButton
                className="!size-[28px] !min-h-[28px] !min-w-[28px] !p-0 [&_.vds-icon-button__content]:!size-[28px]"
                data-testid="topbar-ai"
                data-ob="ai-entry"
                icon={aiIcon}
                label={t('chrome.aiAssistant')}
                onClick={act.toggleAiPanel}
                size="sm"
                title={undefined}
                variant="ghostIcon"
              />
            </Tooltip>
          ) : (
            <Button
              variant="tertiary"
              size="sm"
              className="gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] !text-[var(--vds-brand-bg-default)]"
              aria-label={t('chrome.aiAssistant')}
              data-testid="topbar-ai"
              data-ob="ai-entry"
              onClick={act.toggleAiPanel}
              icon={aiIcon}
            >
              {t('chrome.scholarseedAi')}
            </Button>
          ))}
      </div>
    </div>
  )
}

interface TopBarProps {
  leftWidth: string
}

export function TopBar({ leftWidth }: TopBarProps): React.JSX.Element {
  const { state } = useApp()
  const compactLiteratureHeader =
    state.mainView === 'literature' && !state.homeSelectedProjectId && !state.modulePanelOpen
  const leftStyle = {
    '--vds-collapsed-sidebar-width': compactLiteratureHeader
      ? 'calc(var(--vds-window-controls-left-space) + var(--vds-control-height-sm) + var(--vds-space-1))'
      : leftWidth,
  } as CSSProperties
  return (
    <header className="vds-top-bar vds-top-bar-root w-full min-w-0 !gap-0 !pr-0" style={leftStyle}>
      <div className="vds-top-bar-collapsed-left transition-[width,flex-basis] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none">
        <TopBarLeft />
      </div>
      <TopBarRight />
    </header>
  )
}
