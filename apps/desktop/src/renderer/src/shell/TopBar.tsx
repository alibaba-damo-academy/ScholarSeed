import React, { type CSSProperties, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import aiAssistantIcon from '../assets/ai_assistant.webp'
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip
} from '../components/ui'
import { IconFont } from '../components/primitive'
import { Icon } from '../icons'
import { hasHorizontalSplit } from '../features/workbench/layout'
import { useDocumentWorkspace } from '../features/workbench/workspace'
import { selectedProject, useApp } from '../store'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from './ProjectMenu'
import { TabBar } from './TabBar'

const TOPBAR_LEFT_GROUP_CLASS_NAME =
  'vds-topbar-left-group relative flex h-[var(--vds-workbench-header-height)] w-full flex-none items-center border-y border-l border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default)] [padding-left:var(--vds-window-controls-left-space)] pr-4'
const TOPBAR_RIGHT_DIVIDER_CLASS_NAME =
  ' after:pointer-events-none after:absolute after:right-0 after:top-0 after:h-full after:w-px after:bg-[var(--vds-border-default)] after:content-[""]'
const PROJECT_TRIGGER_CLASS_NAME =
  'flex h-8 w-[154px] min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[14px] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)] hover:bg-[var(--vds-bg-gray-hover-transparent)]'
const TOPBAR_ICON_BUTTON_CLASS_NAME =
  '!flex !size-[var(--vds-control-height-sm)] !items-center !justify-center !p-0 !leading-none'
const TOPBAR_ACTIONS_WIDTH_PROPERTY = '--vds-top-bar-actions-width'

/**
 * 顶栏（对齐原型截图）：左上项目切换 / 搜索 / 侧栏折叠，右侧 AI 助手。
 *
 * 项目切换复用 0.1 既有状态（homeProjectMenuOpen），不另起一套。
 * 账号入口不在这里 —— PRD 把它定在左侧活动栏最下方，见 `ActivityRail`。
 */
export function TopBarLeft({ showRightBorder = true }: { showRightBorder?: boolean }): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const projectLabel =
    (state.mainView === 'home'
      ? t('chrome.projectOverview')
      : state.mainView === 'literature' && !state.homeSelectedProjectId
        ? t('chrome.literatureOverview')
        : undefined) ??
    selectedProject(state)?.name ??
    t('chrome.selectProject')
  const showGlobalSearch =
    state.mainView !== 'literature' || Boolean(state.homeSelectedProjectId)

  return (
    <div className={`${TOPBAR_LEFT_GROUP_CLASS_NAME}${showRightBorder ? TOPBAR_RIGHT_DIVIDER_CLASS_NAME : ''}`}>
      <Popover
        open={state.homeProjectMenuOpen}
        onOpenChange={(open) => set({ homeProjectMenuOpen: open })}
      >
        <div className="vds-project-switch">
          <PopoverTrigger asChild>
            <Button
              unstyled
              className={PROJECT_TRIGGER_CLASS_NAME}
              data-testid="topbar-project" data-ob="project-switcher"
              aria-haspopup="menu"
            >
              <span className="vds-project-name flex-1 text-left">
                {projectLabel}
              </span>
              <span className="ml-auto flex items-center">
                <Icon name="chevron-down" size={13} />
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className={PROJECT_POPOVER_CONTENT_CLASS}>
            <ProjectMenu onClose={() => set({ homeProjectMenuOpen: false })} />
          </PopoverContent>
        </div>
      </Popover>

      <div className="ml-auto flex h-8 items-center gap-[2px]">
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

        <Tooltip
          content={
            state.modulePanelOpen
              ? t('chrome.collapseSidebar')
              : t('chrome.expandSidebar')
          }
          side="bottom"
          portalled
        >
          <Button
            variant="ghostIcon"
            size="sm"
            className={TOPBAR_ICON_BUTTON_CLASS_NAME}
            aria-label={
              state.modulePanelOpen
                ? t('chrome.collapseSidebar')
                : t('chrome.expandSidebar')
            }
            data-testid="topbar-panel-toggle"
            onClick={act.toggleModulePanel}
          >
            <IconFont
              type={
                state.modulePanelOpen ? 'panel-left-close' : 'panel-left-open'
              }
            />
          </Button>
        </Tooltip>
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
      root.style.setProperty(TOPBAR_ACTIONS_WIDTH_PROPERTY, `${actions.getBoundingClientRect().width}px`)
    }
    updateActionsWidth()
    const observer = new ResizeObserver(updateActionsWidth)
    observer.observe(actions)
    return () => observer.disconnect()
  }, [])
  const compactAiEntry = (state.mainView === 'resource' || state.mainView === 'literature')
    && hasHorizontalSplit(documents.layout)
  const aiIcon = (
    <img
      alt=""
      className="size-[14px]"
      draggable={false}
      height={14}
      src={aiAssistantIcon}
      width={14}
    />
  )
  return (
    <div ref={rootRef} className="vds-top-bar vds-top-bar-right relative !h-[var(--vds-workbench-header-height)]">
      <TabBar />
      <div ref={actionsRef} className="vds-top-bar-actions no-drag z-[var(--vds-z-elevated)] bg-[var(--vds-bg-gray-default)]">
        {!state.aiPanel.open && (
          compactAiEntry ? (
            <Tooltip content={t('chrome.aiAssistant')} side="bottom" portalled>
              <IconButton
                className="!size-[28px] !min-h-[28px] !min-w-[28px] !p-0 [&_.vds-icon-button__content]:!size-[28px]"
                data-testid="topbar-ai" data-ob="ai-entry"
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
              data-testid="topbar-ai" data-ob="ai-entry"
              onClick={act.toggleAiPanel}
              icon={aiIcon}
            >
              {t('chrome.scholarseedAi')}
            </Button>
          )
        )}
      </div>
    </div>
  )
}

interface TopBarProps {
  leftWidth: string
}

export function TopBar({ leftWidth }: TopBarProps): React.JSX.Element {
  const leftStyle = {
    '--vds-collapsed-sidebar-width': leftWidth
  } as CSSProperties
  return (
    <header className="vds-top-bar vds-top-bar-root" style={leftStyle}>
      <div className="vds-top-bar-collapsed-left">
        <TopBarLeft />
      </div>
      <TopBarRight />
    </header>
  )
}
