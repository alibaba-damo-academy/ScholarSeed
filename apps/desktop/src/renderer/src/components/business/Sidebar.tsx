import { sessionDisplayTime, sessionDisplayTitle } from '../../session'
import { createFormatters } from '../../../../localization/format'
import React, { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { listProjects } from '../../api'
import { sessionNeedsAttention } from '../../attention'
import { useAttention } from '../../features/assistant/attention'
import { Icon } from '../../icons'
import type { SessionNode } from '../../model'
import { useApp } from '../../store'
import { searchSessionTitles } from '../../tree'
import { Button, Input } from '../ui'
import { cx } from '../ui/utils'
import { Chrome } from './Chrome'
import {
  SessionContextMenu,
  SessionDropdownMenu,
  type SessionContextMenuTarget,
} from './SessionContextMenu'
import { SessionTitleEditor } from './SessionTitle'
import { TaskPausedIcon } from './TaskStatus'

// Sidebar.tsx — the left column of the ScholarSeed shell (PRD 2.1.1): window
// controls row, 新对话, 技能, the project tree, the recent-session list, and the
// account chip. The old full-width titlebar is gone, so the sidebar owns the
// window chrome row and the account popovers.

const SIDEBAR_WIDTH_PX = 236
// macOS draws the real traffic lights over this inset (trafficLightPosition in
// the main process); the row only reserves the space and hosts our own buttons.
const TRAFFIC_LIGHT_INSET_PX = 78
const SIDEBAR_ROW_DEPTH_PX = 14
const SIDEBAR_PROJECTS_GROUP = 'projects'
const SIDEBAR_RECENT_GROUP = 'recent'
const SIDEBAR_CLASS_NAME =
  'box-border flex min-h-0 flex-none flex-col border-r border-[var(--border-soft)] bg-[var(--sidebar-surface)]'
const SIDEBAR_ICON_SLOT_CLASS_NAME =
  'inline-grid h-[18px] w-[16px] flex-none place-items-center text-[var(--text-1)] [&_svg]:text-current'
const SIDEBAR_COLLAPSED_BUTTON_CLASS_NAME =
  'grid size-[24px] flex-none place-items-center rounded-[6px] border-0 bg-transparent p-[0] text-[var(--sidebar-row-icon)] transition-[background,color,border-color] duration-150 [-webkit-app-region:no-drag] hover:bg-[var(--hover-bg)] hover:text-[var(--text-2)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text-2)]'
const SIDEBAR_WINDOW_BUTTON_CLASS_NAME =
  'grid size-[24px] place-items-center rounded-[6px] border-0 bg-transparent p-[0] text-[var(--sidebar-row-icon)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]'
const SIDEBAR_TOOLTIP_CLASS_NAME =
  'sidebar-tooltip relative after:pointer-events-none after:absolute after:[left:50%] after:top-[calc(100%+6px)] after:z-[110] after:-translate-x-1/2 after:-translate-y-[2px] after:whitespace-nowrap after:rounded-[5px] after:border after:border-[var(--border-soft)] after:bg-[var(--bg-2)] after:px-[7px] after:py-[4px] after:text-[10px] after:leading-[1.2] after:text-[var(--text-2)] after:opacity-0 after:shadow-[var(--shadow)] after:transition after:duration-150 after:content-[attr(data-tooltip)] hover:after:translate-y-[0] hover:after:opacity-100 focus-visible:after:translate-y-[0] focus-visible:after:opacity-100'
const SIDEBAR_SEARCH_PANEL_CLASS_NAME =
  'vds-panel absolute top-[32px] z-[90] w-[326px] overflow-hidden text-[var(--text-2)]'
const SIDEBAR_SEARCH_INPUT_ROW_CLASS_NAME =
  'flex min-h-[48px] items-center gap-[9px] border-b border-[var(--border-soft)] px-[14px] text-[var(--text-3)]'
const SIDEBAR_SEARCH_INPUT_CLASS_NAME =
  'min-w-0 flex-1 border-0 bg-transparent p-[0] text-[13px] text-[var(--text)] outline-0 placeholder:text-[var(--text-4)]'
const SIDEBAR_SEARCH_RESULT_CLASS_NAME =
  'grid min-h-[38px] w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-[8px] rounded-[7px] border-0 bg-transparent px-[9px] py-[7px] text-left text-[var(--text-2)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]'
const SIDEBAR_PANEL_TITLE_CLASS_NAME =
  'group flex min-h-[28px] items-center gap-[4px] px-[0] py-[0] text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text-4)] after:order-1 after:h-[1px] after:flex-1 after:bg-[var(--border-soft)] hover:text-[var(--text-3)]'
const SIDEBAR_PANEL_TOGGLE_CLASS_NAME =
  'flex min-h-[28px] flex-none items-center gap-[6px] rounded-[6px] border-0 bg-transparent px-[4px] py-[0] text-left text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text-4)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)] group-hover:text-[var(--text-3)]'
const SIDEBAR_PANEL_ACTION_CLASS_NAME =
  'order-2 ml-auto grid size-[22px] flex-none place-items-center rounded-[5px] border-0 bg-transparent p-[0] text-[var(--text-3)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]'
const SIDEBAR_EMPTY_CLASS_NAME =
  'px-[8px] py-[8px] text-[10.5px] leading-[1.6] text-[var(--text-3)]'

function StatusMark({
  node,
  unseen,
}: {
  node: SessionNode
  unseen: boolean
}): React.JSX.Element | null {
  if (node.status === 'waiting' && unseen) {
    return <TaskPausedIcon className="flex-none" />
  }
  if (node.status === 'running') {
    // 转圈：任务正在执行
    return (
      <span className="size-[10px] flex-none animate-[statusSpin_0.8s_linear_infinite] rounded-full border-[1.5px] border-[var(--c-experience)] border-t-transparent" />
    )
  }
  if (unseen) {
    // 小圆点：完成但用户未进入
    return <span className="size-[7px] flex-none rounded-full bg-[var(--c-experience)]" />
  }
  // 无标记：空闲/已查看
  return null
}

function SessionRow({
  node,
  depth = 0,
  inProject = false,
}: {
  node: SessionNode
  depth?: number
  inProject?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const format = createFormatters(state.lang)
  const active = state.activeSession === node.id && state.capGallery !== 'skill'
  const selectable = !node.container && node.openable !== false
  const reminders = useAttention()
  const unseen = !node.container && sessionNeedsAttention(reminders.by_session[node.id] ?? 0)
  const children = node.children ?? []
  const collapsed = Boolean(state.collapsedSessionIds[node.id])
  const renaming =
    state.sessionRename?.mode !== 'dialog' && state.sessionRename?.sessionId === node.id
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuTarget: SessionContextMenuTarget = {
    inProject,
    sessionId: node.id,
    title: node.title,
    title_fallback: node.title_fallback,
  }

  const row = (
    <div
      className={cx(
        'reveal group relative mb-[2px] flex min-w-0 max-w-full items-center overflow-hidden rounded-[7px] transition-colors duration-150 hover:bg-[var(--hover-bg)] focus-within:bg-[var(--hover-bg)]',
        active &&
          'bg-[var(--bg-3)] hover:bg-[color-mix(in_srgb,var(--bg-3)_72%,var(--hover-bg))] focus-within:bg-[color-mix(in_srgb,var(--bg-3)_72%,var(--hover-bg))]',
        menuOpen && 'is-menu-open'
      )}
      style={{ paddingLeft: depth * SIDEBAR_ROW_DEPTH_PX }}
    >
      {renaming ? (
        <div
          className="flex min-h-[31px] min-w-0 w-full max-w-full flex-1 items-center gap-[9px] rounded-[7px] border-0 bg-transparent py-[4px] pl-[0] pr-[8px] text-left"
          style={{
            color: active ? 'var(--text)' : 'var(--text-2)',
          }}
        >
          <StatusMark node={node} unseen={unseen} />
          <SessionTitleEditor node={node} />
        </div>
      ) : (
        <Button
          unstyled
          type="button"
          disabled={!selectable && children.length === 0}
          onClick={() =>
            node.container
              ? act.toggleSessionChildren(node.id)
              : selectable && act.openSession(node.id, undefined, 'task')
          }
          className={cx(
            'flex min-h-[31px] min-w-0 w-full max-w-full flex-1 items-center gap-[9px] rounded-[7px] border-0 bg-transparent py-[4px] pl-[0] text-left',
            !node.container && !renaming ? 'pr-[34px]' : 'pr-[10px]'
          )}
          data-testid={`sidebar-session-${node.id}`}
          style={{
            color: active ? 'var(--text)' : 'var(--text-2)',
          }}
        >
          <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
            {node.container ? (
              <Icon name="git-branch" size={13} />
            ) : (
              <StatusMark node={node} unseen={unseen} />
            )}
          </span>
          <span
            title={sessionDisplayTitle(node, assistantText)}
            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-[650] text-[var(--text-3)]"
          >
            {sessionDisplayTitle(node, assistantText)}
          </span>
          {sessionDisplayTime(node, format) && (
            <span className="flex-none text-[12px] font-semibold text-[var(--text-3)] tabular-nums transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0 group-[.is-menu-open]:opacity-0">
              {sessionDisplayTime(node, format)}
            </span>
          )}
        </Button>
      )}
      {!node.container && !renaming && (
        <SessionDropdownMenu onOpenChange={setMenuOpen} target={menuTarget}>
          <Button
            unstyled
            type="button"
            className="pointer-events-none absolute right-[4px] grid size-[24px] translate-x-[2px] place-items-center rounded-md border-0 bg-transparent p-[0] text-[var(--text-3)] opacity-0 transition duration-100 hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] hover:text-[var(--text)] focus-visible:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] focus-visible:text-[var(--text)] group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-[.is-menu-open]:pointer-events-auto group-[.is-menu-open]:translate-x-0 group-[.is-menu-open]:opacity-100"
            data-testid={`sidebar-session-actions-${node.id}`}
            onClick={(event) => {
              event.stopPropagation()
              set({ sessionRename: null })
            }}
            aria-label={t('sidebar.sessionActions', {
              title: sessionDisplayTitle(node, assistantText),
            })}
          >
            <Icon name="more-horizontal" size={14} />
          </Button>
        </SessionDropdownMenu>
      )}
    </div>
  )

  return (
    <div className="min-w-0 max-w-full">
      {!node.container && !renaming ? (
        <SessionContextMenu
          onOpenChange={(open) => {
            setMenuOpen(open)
            if (open) set({ sessionRename: null })
          }}
          target={menuTarget}
        >
          {row}
        </SessionContextMenu>
      ) : (
        row
      )}
      {!collapsed &&
        children.map((child) => (
          <SessionRow key={child.id} node={child} depth={depth + 1} inProject={inProject} />
        ))}
    </div>
  )
}

const RECENT_SESSION_ROW_HEIGHT = 33

function VirtualizedSessionList({ sessions }: { sessions: SessionNode[] }): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => RECENT_SESSION_ROW_HEIGHT,
    overscan: 5,
  })
  return (
    <div
      ref={parentRef}
      className="max-h-[var(--vds-sidebar-project-list-max-height)] overflow-y-auto"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={sessions[virtualRow.index].id}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <SessionRow node={sessions[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const format = createFormatters(state.lang)
  const [searchQuery, setSearchQuery] = React.useState('')
  const searchPopoverRef = React.useRef<HTMLDivElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const reloadProjects = React.useCallback(async (): Promise<void> => {
    const result = await listProjects()
    if (!result) return
    set({
      projects: result.projects,
      defaultWorkspacePath: result.default || state.defaultWorkspacePath,
    })
  }, [set, state.defaultWorkspacePath])

  React.useEffect(() => {
    if (state.backendReady) void reloadProjects()
  }, [reloadProjects, state.backendReady])

  React.useEffect(() => {
    if (!state.searchHint) {
      setSearchQuery('')
      return
    }
    searchInputRef.current?.focus()
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!searchPopoverRef.current?.contains(event.target as Node)) set({ searchHint: false })
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [set, state.searchHint])

  const projects = state.projects
  const projectsCollapsed = Boolean(state.sidebarGroupsCollapsed[SIDEBAR_PROJECTS_GROUP])
  const recentCollapsed = Boolean(state.sidebarGroupsCollapsed[SIDEBAR_RECENT_GROUP])
  const sessions = state.sessions
    .filter(
      (node) =>
        node.id === state.activeSession ||
        !(node.title || '').startsWith('serve:') ||
        (node.children?.length ?? 0) > 0 ||
        node.status === 'running' ||
        node.status === 'waiting'
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id))
  const selectedProjectId = state.homeSelectedProjectId
  const searchResults = searchSessionTitles(sessions, searchQuery)

  if (!state.sidebarOpen) {
    return (
      <aside
        className={`${SIDEBAR_CLASS_NAME} fixed left-[var(--vds-space-0)] top-[2px] z-[230] h-[58px] min-h-0 w-[174px] flex-row items-start gap-[6px] border-r-0 bg-transparent pb-[0] pl-[84px] pr-[0] pt-[10px] [-webkit-app-region:no-drag]`}
        aria-label={t('sidebar.collapsed')}
      >
        <Button
          unstyled
          type="button"
          onClick={act.toggleSidebar}
          data-testid="sidebar-expand"
          data-tooltip={t('sidebar.expand')}
          aria-label={t('sidebar.expand')}
          className={`${SIDEBAR_COLLAPSED_BUTTON_CLASS_NAME} ${SIDEBAR_TOOLTIP_CLASS_NAME}`}
        >
          <Icon name="panel-left" size={17} />
        </Button>
        <div className="no-drag relative [-webkit-app-region:no-drag]" ref={searchPopoverRef}>
          <Button
            unstyled
            type="button"
            data-testid="sidebar-search"
            className={SIDEBAR_COLLAPSED_BUTTON_CLASS_NAME}
            onClick={() => set((current) => ({ searchHint: !current.searchHint }))}
            title={t('sidebar.search')}
            aria-label={t('sidebar.search')}
            aria-expanded={state.searchHint}
          >
            <Icon name="search" size={15} />
          </Button>
          {state.searchHint && (
            <section
              className={`${SIDEBAR_SEARCH_PANEL_CLASS_NAME} left-[-28px]`}
              data-testid="sidebar-search-panel"
              aria-label={t('sidebar.search')}
            >
              <div className={SIDEBAR_SEARCH_INPUT_ROW_CLASS_NAME}>
                <Icon name="search" size={14} />
                <Input
                  unstyled
                  ref={searchInputRef}
                  data-testid="sidebar-search-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') set({ searchHint: false })
                  }}
                  placeholder={t('sidebar.searchPlaceholder')}
                  aria-label={t('sidebar.searchLabel')}
                  className={SIDEBAR_SEARCH_INPUT_CLASS_NAME}
                />
              </div>
              <div className="px-[14px] pb-[6px] pt-[10px] text-[10px] text-[var(--text-4)]">
                {t('sidebar.conversations')}
              </div>
              <div
                className="max-h-[330px] overflow-y-auto px-[7px] pb-[8px] pt-[0]"
                data-testid="sidebar-search-results"
              >
                {searchResults.length > 0 ? (
                  searchResults.map((node) => (
                    <Button
                      unstyled
                      type="button"
                      key={node.id}
                      className={SIDEBAR_SEARCH_RESULT_CLASS_NAME}
                      data-testid={`sidebar-search-result-${node.id}`}
                      onClick={() => {
                        set({ searchHint: false })
                        act.openSession(node.id, undefined, 'task')
                      }}
                    >
                      <Icon name="doc" size={13} />
                      <span
                        title={sessionDisplayTitle(node, assistantText)}
                        className="overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {sessionDisplayTitle(node, assistantText)}
                      </span>
                      {sessionDisplayTime(node, format) && (
                        <time className="text-[10px] text-[var(--text-4)]">
                          {sessionDisplayTime(node, format)}
                        </time>
                      )}
                    </Button>
                  ))
                ) : (
                  <div
                    className="px-[10px] pb-[22px] pt-[20px] text-center text-[12px] text-[var(--text-4)]"
                    data-testid="sidebar-search-empty"
                  >
                    {t('sidebar.noMatch')}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
        <Button
          unstyled
          type="button"
          data-testid="sidebar-new-chat"
          onClick={() => act.startPanelDraft()}
          title={t('sidebar.newChat')}
          aria-label={t('sidebar.newChat')}
          className={SIDEBAR_COLLAPSED_BUTTON_CLASS_NAME}
        >
          <Icon name="plus" size={15} />
        </Button>
      </aside>
    )
  }

  return (
    <aside className={SIDEBAR_CLASS_NAME} style={{ width: SIDEBAR_WIDTH_PX }}>
      {/* Window chrome row: OS traffic lights on the left, our controls after. */}
      <div
        className="drag flex h-[52px] flex-none items-center gap-[12px] border-b border-[color-mix(in_srgb,var(--border-soft)_78%,transparent)] pr-[18px]"
        style={{ paddingLeft: TRAFFIC_LIGHT_INSET_PX }}
      >
        <Button
          unstyled
          type="button"
          className={`no-drag ${SIDEBAR_WINDOW_BUTTON_CLASS_NAME} ${SIDEBAR_TOOLTIP_CLASS_NAME}`}
          onClick={act.toggleSidebar}
          data-testid="sidebar-collapse"
          data-tooltip={t('sidebar.collapseHint')}
          aria-label={t('sidebar.collapse')}
        >
          <Icon name="panel-left" size={15} />
        </Button>
        <div className="no-drag relative" ref={searchPopoverRef}>
          <Button
            unstyled
            type="button"
            data-testid="sidebar-search"
            className={SIDEBAR_WINDOW_BUTTON_CLASS_NAME}
            onClick={() => set((current) => ({ searchHint: !current.searchHint }))}
            title={t('sidebar.search')}
            aria-label={t('sidebar.search')}
            aria-expanded={state.searchHint}
          >
            <Icon name="search" size={15} />
          </Button>
          {state.searchHint && (
            <section
              className={`${SIDEBAR_SEARCH_PANEL_CLASS_NAME} left-[-84px]`}
              data-testid="sidebar-search-panel"
              aria-label={t('sidebar.search')}
            >
              <div className={SIDEBAR_SEARCH_INPUT_ROW_CLASS_NAME}>
                <Icon name="search" size={14} />
                <Input
                  unstyled
                  ref={searchInputRef}
                  data-testid="sidebar-search-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') set({ searchHint: false })
                  }}
                  placeholder={t('sidebar.searchPlaceholder')}
                  aria-label={t('sidebar.searchLabel')}
                  className={SIDEBAR_SEARCH_INPUT_CLASS_NAME}
                />
              </div>
              <div className="px-[14px] pb-[6px] pt-[10px] text-[10px] text-[var(--text-4)]">
                {t('sidebar.conversations')}
              </div>
              <div
                className="max-h-[330px] overflow-y-auto px-[7px] pb-[8px] pt-[0]"
                data-testid="sidebar-search-results"
              >
                {searchResults.length > 0 ? (
                  searchResults.map((node) => (
                    <Button
                      unstyled
                      type="button"
                      key={node.id}
                      className={SIDEBAR_SEARCH_RESULT_CLASS_NAME}
                      data-testid={`sidebar-search-result-${node.id}`}
                      onClick={() => {
                        set({ searchHint: false })
                        act.openSession(node.id, undefined, 'task')
                      }}
                    >
                      <Icon name="doc" size={13} />
                      <span
                        title={sessionDisplayTitle(node, assistantText)}
                        className="overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {sessionDisplayTitle(node, assistantText)}
                      </span>
                      {sessionDisplayTime(node, format) && (
                        <time className="text-[10px] text-[var(--text-4)]">
                          {sessionDisplayTime(node, format)}
                        </time>
                      )}
                    </Button>
                  ))
                ) : (
                  <div
                    className="px-[10px] pb-[22px] pt-[20px] text-center text-[12px] text-[var(--text-4)]"
                    data-testid="sidebar-search-empty"
                  >
                    {t('sidebar.noMatch')}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      <Button
        unstyled
        type="button"
        data-testid="sidebar-new-chat"
        onClick={() => act.startPanelDraft()}
        className={cx(
          'mx-[10px] mb-[0] mt-[14px] flex min-h-[36px] flex-none items-center justify-start gap-[8px] rounded-[6px] border-0 bg-transparent px-[3px] py-[0] text-left text-[14px] font-bold text-[var(--text-2)] transition-[background,color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]',
          !state.activeSession &&
            state.mainView === 'home' &&
            !state.homeSelectedProjectId &&
            !state.capGallery &&
            !state.workspaceFilesOpen &&
            'bg-[var(--active-bg)] text-[var(--active-text)] [&>span:first-child]:text-[var(--active-text)]'
        )}
      >
        <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
          <Icon name="plus" size={13} />
        </span>
        <span>{t('sidebar.newChat')}</span>
      </Button>

      <Button
        unstyled
        type="button"
        data-testid="sidebar-skills"
        onClick={() => act.openCap('skill')}
        className={cx(
          'mx-[10px] mb-[0] mt-[10px] flex min-h-[36px] items-center gap-[8px] rounded-[6px] border-0 bg-transparent px-[3px] py-[0] text-left text-[14px] font-[650] text-[var(--text-2)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]',
          state.capGallery === 'skill' &&
            'bg-[var(--active-bg)] text-[var(--active-text)] [&>span:first-child]:text-[var(--active-text)]'
        )}
      >
        <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
          <Icon name="plug-simple" size={14} />
        </span>
        <span>{t('sidebar.skills')}</span>
      </Button>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[10px] pb-[6px] pt-[18px]">
        <div className={SIDEBAR_PANEL_TITLE_CLASS_NAME}>
          <Button
            unstyled
            type="button"
            data-testid="sidebar-projects-toggle"
            className="grid size-[20px] flex-none place-items-center rounded-[5px] border-0 bg-transparent p-[0] text-[var(--text-4)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-2)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text-2)]"
            onClick={() =>
              set((prev) => ({
                sidebarGroupsCollapsed: {
                  ...prev.sidebarGroupsCollapsed,
                  [SIDEBAR_PROJECTS_GROUP]: !prev.sidebarGroupsCollapsed[SIDEBAR_PROJECTS_GROUP],
                },
              }))
            }
            aria-expanded={!projectsCollapsed}
            aria-label={
              projectsCollapsed ? t('sidebar.expandProjects') : t('sidebar.collapseProjects')
            }
          >
            <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
              <Icon name={projectsCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
            </span>
          </Button>
          <Button
            unstyled
            type="button"
            data-testid="sidebar-projects"
            className={cx(
              SIDEBAR_PANEL_TOGGLE_CLASS_NAME,
              state.mainView === 'projects' &&
                !state.activeSession &&
                'bg-[var(--active-bg)] text-[var(--active-text)]'
            )}
            onClick={() => act.openWorkbenchView('projects')}
            aria-label={t('sidebar.openProjects')}
          >
            <span>{t('sidebar.projects')}</span>
          </Button>
          <Button
            unstyled
            type="button"
            className={SIDEBAR_PANEL_ACTION_CLASS_NAME}
            data-testid="sidebar-project-new"
            onClick={() => set({ projectForm: { mode: 'create' } })}
            title={t('sidebar.newProject')}
            aria-label={t('sidebar.newProject')}
          >
            <Icon name="plus" size={13} />
          </Button>
          {/* MVP 0.2: 进入四区工作台（资料库 / 文献库 / 写作）。 */}
          <Button
            unstyled
            type="button"
            className={SIDEBAR_PANEL_ACTION_CLASS_NAME}
            data-testid="sidebar-workbench"
            onClick={() => act.openWorkbenchView('resource')}
            title={t('sidebar.workbench')}
            aria-label={t('sidebar.workbench')}
          >
            <Icon name="inbox" size={13} />
          </Button>
        </div>
        {!projectsCollapsed && projects.length === 0 && (
          <div className={SIDEBAR_EMPTY_CLASS_NAME}>{t('sidebar.emptyProjects')}</div>
        )}
        {!projectsCollapsed &&
          projects.map((project) => {
            const expanded = state.collapsedProjects[project.path] === false
            const selected = project.id === selectedProjectId
            return (
              <div key={project.path} className="mb-[1px] min-w-0 max-w-full overflow-hidden">
                <div className="reveal relative flex min-w-0 max-w-full items-center overflow-hidden">
                  <Button
                    unstyled
                    type="button"
                    className={cx(
                      'relative flex min-h-[31px] min-w-0 w-full max-w-full flex-1 items-center gap-[9px] rounded-[7px] border-0 bg-transparent py-[4px] pl-[0] pr-[26px] text-left text-[var(--text-2)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]',
                      selected &&
                        "bg-[var(--active-bg)] font-semibold text-[var(--active-text)] after:absolute after:right-[5px] after:size-[7px] after:rounded-full after:bg-[var(--brand-ink)] after:content-['']"
                    )}
                    data-testid={`sidebar-project-${project.name}`}
                    title={project.path}
                    onDoubleClick={() => set({ projectForm: { mode: 'edit', project } })}
                    onClick={() =>
                      set((prev) => ({
                        collapsedProjects: {
                          ...prev.collapsedProjects,
                          [project.path]: prev.collapsedProjects[project.path] === false,
                        },
                      }))
                    }
                  >
                    <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
                      <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                    </span>
                    <Icon name="folder" size={14} />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[13.5px]">
                      {project.name}
                    </span>
                  </Button>
                  <Button
                    unstyled
                    type="button"
                    className="acts absolute right-[3px] grid size-[22px] place-items-center rounded-[5px] border-0 bg-transparent p-[0] text-[var(--text-3)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]"
                    data-testid={`sidebar-project-add-session-${project.name}`}
                    onClick={() =>
                      act.startPanelDraft({ projectId: project.id, projectLocked: true })
                    }
                    title={t('sidebar.newInProject', { name: project.name })}
                    aria-label={t('sidebar.newInProject', { name: project.name })}
                  >
                    <Icon name="plus" size={13} />
                  </Button>
                </div>
                {/* Project membership comes from the service catalog, never inferred from workdir. */}
                {expanded &&
                  (() => {
                    const owned = sessions.filter((node) => node.projectPath === project.path)
                    return owned.length ? (
                      <div className="min-w-0 max-w-full overflow-hidden pl-[25px]">
                        {owned.map((node) => (
                          <SessionRow key={node.id} node={node} inProject />
                        ))}
                      </div>
                    ) : (
                      <p className="mb-[4px] ml-[25px] mt-[2px] text-[10.5px] text-[var(--text-3)]">
                        {t('sidebar.noChats')}
                      </p>
                    )
                  })()}
              </div>
            )
          })}

        <div className={`${SIDEBAR_PANEL_TITLE_CLASS_NAME} mt-[10px]`}>
          <Button
            unstyled
            type="button"
            className={SIDEBAR_PANEL_TOGGLE_CLASS_NAME}
            onClick={() =>
              set((prev) => ({
                sidebarGroupsCollapsed: {
                  ...prev.sidebarGroupsCollapsed,
                  [SIDEBAR_RECENT_GROUP]: !prev.sidebarGroupsCollapsed[SIDEBAR_RECENT_GROUP],
                },
              }))
            }
            aria-expanded={!recentCollapsed}
            aria-label={recentCollapsed ? t('sidebar.expandRecent') : t('sidebar.collapseRecent')}
          >
            <span className={SIDEBAR_ICON_SLOT_CLASS_NAME}>
              <Icon name={recentCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
            </span>
            <span>{t('sidebar.recent')}</span>
          </Button>
        </div>
        {!recentCollapsed &&
          (() => {
            const projectPaths = new Set(projects.map((project) => project.path))
            const recentSessions = sessions.filter(
              (node) => !node.projectPath || !projectPaths.has(node.projectPath)
            )
            if (!recentSessions.length) {
              return <div className={SIDEBAR_EMPTY_CLASS_NAME}>{t('sidebar.emptyRecent')}</div>
            }
            return <VirtualizedSessionList sessions={recentSessions} />
          })()}
      </div>

      <Chrome />
    </aside>
  )
}
