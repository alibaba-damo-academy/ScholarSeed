import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  Box,
  ChevronDown,
  Folders,
  Plus,
  Search,
} from 'lucide-react'

import {
  listAllSessions,
  detachSession,
  reorderSession,
  restoreSessionParent,
  setSessionArchived,
  setSessionPinned,
  type ServeSession,
  type SessionOrderPlacement,
} from '../../api'
import { sessionDisplayTitle } from '../../session'
import emptyFolder from '../../assets/empty_img.webp'
import { createScrollbarVisibility } from '../../components/business/scroll'
import { IconFont } from '../../components/primitive/Iconfont'
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
  EllipsisText,
  IconButton,
  NavigationButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  Spinner,
  Tooltip,
  useToast,
} from '../../components/ui'
import { ProjectMenu } from '../../shell/ProjectMenu'
import { selectedProject, useApp } from '../../store'
import { findSessionNode, projectSessionNodes, serveSessionNode } from '../../tree'
import { HOME_TASK_LIMIT } from '../home/catalog'
import { Tasks } from './Tasks'
import { projectLibraryNavigation, tabMatchesProject } from '../workbench/tabs'
import {
  canDetachSession,
  canDragSession,
  canOrderSession,
  canRestoreSession,
  SESSION_DRAG_TYPE,
  SESSION_DROP_KINDS,
  type SessionDropTarget,
} from './drag'
import { SessionDropIndicator } from './Indicator'
import { PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding'

const PANEL_PERCENTAGE_TOTAL = 100
const ARCHIVE_MAX_PERCENTAGE = 50
const SESSION_CHANGE_MESSAGES = {
  detach: { pending: 'detachingSession', failure: 'detachFailed', success: 'sessionDetached' },
  restore: {
    pending: null,
    failure: 'restoreParentFailed',
    success: null,
  },
  order: {
    pending: 'orderingSession',
    failure: 'sessionOrderFailed',
    success: 'sessionOrderSaved',
  },
} as const
type SessionChangeMessages = (typeof SESSION_CHANGE_MESSAGES)[keyof typeof SESSION_CHANGE_MESSAGES]

export function ProjectNavigation(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('layout')
  const { t: shellText } = useTranslation('shell')
  const { toast } = useToast()
  const { t: archiveText } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const project = selectedProject(state)
  const projectPath = project?.path
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveSizes, setArchiveSizes] = useState<number[] | null>(null)
  const [archiveDefaultPercentage, setArchiveDefaultPercentage] = useState(0)
  const [archiveMaxPercentage, setArchiveMaxPercentage] = useState(ARCHIVE_MAX_PERCENTAGE)
  const navigationRef = useRef<HTMLElement>(null)
  const resizeGroupRef = useRef<HTMLDivElement>(null)
  const archiveHeightRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const navigation = navigationRef.current
    const archiveHeight = archiveHeightRef.current
    const resizeGroup = resizeGroupRef.current
    if (!navigation || !archiveHeight || !resizeGroup) return
    const measure = (): void => {
      const panelHeight = navigation.getBoundingClientRect().height
      const groupHeight = resizeGroup.getBoundingClientRect().height
      if (!panelHeight || !groupHeight) return
      const maximum = Math.min(
        PANEL_PERCENTAGE_TOTAL,
        (panelHeight / groupHeight) * ARCHIVE_MAX_PERCENTAGE
      )
      setArchiveMaxPercentage(maximum)
      setArchiveDefaultPercentage(
        Math.min(
          maximum,
          (archiveHeight.getBoundingClientRect().height / groupHeight) * PANEL_PERCENTAGE_TOTAL
        )
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(navigation)
    observer.observe(resizeGroup)
    observer.observe(archiveHeight)
    measure()
    return () => observer.disconnect()
  }, [])
  const [archiveCatalog, setArchiveCatalog] = useState<{
    projectPath: string
    rows: ServeSession[]
  } | null>(null)
  const [archiveFailed, setArchiveFailed] = useState(false)
  const [archiveOperationFailed, setArchiveOperationFailed] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const selectedArchive = useRef(state.archivedSession?.session_id)
  selectedArchive.current = state.archivedSession?.session_id
  const [rows, setRows] = useState<ServeSession[]>([])
  const [taskScrollbarVisible, setTaskScrollbarVisible] = useState(false)
  const [taskScrollbar] = useState(() =>
    createScrollbarVisibility(setTaskScrollbarVisible, window.setTimeout, window.clearTimeout)
  )
  useEffect(() => taskScrollbar.hide, [taskScrollbar])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pinFailed, setPinFailed] = useState(false)
  const [draggedSession, setDraggedSession] = useState<ServeSession | null>(null)
  const [dropTarget, setDropTarget] = useState<SessionDropTarget | null>(null)
  const [changingSession, setChangingSession] = useState<{
    id: string
    message: SessionChangeMessages['pending']
  } | null>(null)
  const [changeFeedback, setChangeFeedback] = useState<SessionChangeMessages['failure'] | null>(
    null
  )
  const pendingChange = useRef(false)
  const [pinning, setPinning] = useState<Set<string>>(new Set())
  const pendingPins = useRef(new Set<string>())
  const projectEpoch = useRef(0)
  const catalogEpoch = useRef(0)
  const taskActions = useRef(new Map<string, HTMLButtonElement>())
  const restoreTaskFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const sessionId = restoreTaskFocus.current
    restoreTaskFocus.current = null
    if (sessionId && document.activeElement === document.body)
      taskActions.current.get(sessionId)?.focus()
  }, [rows])
  useEffect(() => {
    projectEpoch.current += 1
    setLoading(true)
    setPinFailed(false)
    setDraggedSession(null)
    setDropTarget(null)
    setChangeFeedback(null)
    setArchiveOpen(false)
    setArchiveSizes(null)
    setRows([])
    return () => {
      projectEpoch.current += 1
    }
  }, [project?.path])
  useEffect(() => {
    let alive = true
    const epoch = ++catalogEpoch.current
    setFailed(false)
    if (!projectPath) return
    void listAllSessions(
      {
        scope: 'project',
        projectPath,
        limit: HOME_TASK_LIMIT,
      },
      () => alive && epoch === catalogEpoch.current
    ).then((catalog) => {
      if (!alive || epoch !== catalogEpoch.current) return
      setLoading(false)
      setFailed(!catalog)
      if (catalog) {
        restoreTaskFocus.current =
          [...taskActions.current].find(([, button]) => button === document.activeElement)?.[0] ??
          null
        setRows(catalog)
      }
    })
    return () => {
      alive = false
    }
  }, [projectPath, state.activeSession, state.sessionCatalogRevision, revision])
  useEffect(() => {
    const refresh = (): void => setRevision((value) => value + 1)
    window.addEventListener('scholarseed:refresh-session-list', refresh)
    return () => window.removeEventListener('scholarseed:refresh-session-list', refresh)
  }, [])
  const changePin = async (row: ServeSession): Promise<void> => {
    if (pendingPins.current.has(row.session_id)) return
    const epoch = projectEpoch.current
    pendingPins.current.add(row.session_id)
    setPinning(new Set(pendingPins.current))
    setPinFailed(false)
    const result = await setSessionPinned(row.session_id, !row.pinned)
    pendingPins.current.delete(row.session_id)
    setPinning(new Set(pendingPins.current))
    if (!result.ok) {
      if (epoch === projectEpoch.current) setPinFailed(true)
      return
    }
    if (taskActions.current.get(row.session_id) === document.activeElement)
      restoreTaskFocus.current = row.session_id
    setRows((current) =>
      current.map((item) =>
        item.session_id === row.session_id ? { ...item, pinned: result.pinned } : item
      )
    )
    catalogEpoch.current += 1
    setRevision((value) => value + 1)
  }
  const changeSession = async (
    row: ServeSession,
    execute: () => Promise<{ ok: boolean }>,
    messages: SessionChangeMessages
  ): Promise<void> => {
    if (pendingChange.current) return
    const epoch = projectEpoch.current
    pendingChange.current = true
    setDropTarget(null)
    setChangingSession({ id: row.session_id, message: messages.pending })
    setChangeFeedback(null)
    const result = await execute()
    pendingChange.current = false
    setChangingSession(null)
    if (epoch !== projectEpoch.current) return
    if (!result.ok) {
      setChangeFeedback(messages.failure)
      setRevision((value) => value + 1)
      return
    }
    if (messages.success) toast({ tone: 'success', title: t(messages.success) })
    catalogEpoch.current += 1
    set((current) => ({ sessionCatalogRevision: current.sessionCatalogRevision + 1 }))
    setRevision((value) => value + 1)
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }
  const detach = (row: ServeSession): void => {
    if (canDetachSession(row, projectPath))
      void changeSession(row, () => detachSession(row.session_id), SESSION_CHANGE_MESSAGES.detach)
  }
  const reorder = (
    row: ServeSession,
    target: ServeSession,
    placement: SessionOrderPlacement
  ): void => {
    setDraggedSession(null)
    if (canOrderSession(row, target, projectPath, rows))
      void changeSession(
        row,
        () => reorderSession(row.session_id, target.session_id, placement),
        SESSION_CHANGE_MESSAGES.order
      )
  }
  const detachDraggedSession = (): void => {
    const row = rows.find((item) => item.session_id === draggedSession?.session_id)
    setDraggedSession(null)
    if (row) detach(row)
  }
  const acceptsListDetach = (event: React.DragEvent<HTMLDivElement>): boolean =>
    Boolean(
      draggedSession &&
      !changingSession &&
      canDetachSession(draggedSession, projectPath) &&
      event.target === event.currentTarget &&
      [...event.currentTarget.querySelectorAll<HTMLElement>('[draggable]')].every(
        (row) => event.clientY >= row.getBoundingClientRect().bottom
      )
    )
  useEffect(() => {
    let alive = true
    setArchiveCatalog((current) => (current?.projectPath === projectPath ? current : null))
    setArchiveFailed(false)
    setArchiveOperationFailed(false)
    if (projectPath) {
      void listAllSessions({ scope: 'project', projectPath, archived: true }, () => alive, {
        synchronizeRoots: false,
      }).then((result) => {
        if (!alive) return
        setArchiveFailed(result === null)
        if (result) setArchiveCatalog({ projectPath, rows: result })
      })
    }
    return () => {
      alive = false
    }
  }, [projectPath, state.sessionCatalogRevision, revision])
  const archivedRows = archiveCatalog?.projectPath === project?.path ? archiveCatalog?.rows : null
  const restore = async (row: ServeSession): Promise<void> => {
    if (restoring) return
    const epoch = projectEpoch.current
    setRestoring(row.session_id)
    setArchiveOperationFailed(false)
    const result = await setSessionArchived(row.session_id, false)
    setRestoring(null)
    if (epoch !== projectEpoch.current) return
    if (!result.ok) {
      setArchiveOperationFailed(true)
      return
    }
    set((current) => ({ sessionCatalogRevision: current.sessionCatalogRevision + 1 }))
    if (selectedArchive.current === row.session_id) act.openSession(row.session_id)
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }
  const visible = rows.map((row) => {
    const live = findSessionNode(state.sessions, row.session_id)
    if (!live) return row
    return {
      ...row,
      title: live.title,
      title_fallback: live.title_fallback,
      running: live.status === 'running',
      waiting: live.status === 'waiting',
    }
  })
  const renderTasks = (items: ServeSession[]): React.JSX.Element => (
    <Tasks
      rows={items}
      pending={pinning}
      projectPath={projectPath}
      detaching={changingSession?.id}
      draggedSession={draggedSession}
      dropTarget={dropTarget}
      onDropTargetChange={setDropTarget}
      onOrder={reorder}
      onRestore={(row, parent) => {
        setDraggedSession(null)
        if (canRestoreSession(row, parent, projectPath, rows))
          void changeSession(
            row,
            () => restoreSessionParent(row.session_id, parent.session_id),
            SESSION_CHANGE_MESSAGES.restore
          )
      }}
      onDetach={(row) => {
        setDraggedSession(null)
        void detach(row)
      }}
      onDragStart={(row, event) => {
        if (pendingChange.current || !canDragSession(row, projectPath)) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(SESSION_DRAG_TYPE, row.session_id)
        setDropTarget(null)
        setDraggedSession(row)
      }}
      onDragEnd={() => {
        setDraggedSession(null)
        setDropTarget(null)
      }}
      onPin={(row) => {
        void changePin(row)
      }}
      registerAction={(id, button) => {
        if (button) taskActions.current.set(id, button)
        else taskActions.current.delete(id)
      }}
    />
  )
  const taskRows = new Map(visible.map((row) => [row.session_id, row]))
  const taskGroups = projectSessionNodes(
    visible.map((row) => serveSessionNode(row, state.sessionActivitySeen, state.activeSession))
  ).map((node) => [node, ...(node.children ?? [])].map((member) => taskRows.get(member.id)!))
  const pinnedTasks = taskGroups.filter((group) => group.some((row) => row.pinned)).flat()
  const unpinnedTasks = taskGroups.filter((group) => !group.some((row) => row.pinned)).flat()
  const detachDropActive = Boolean(
    draggedSession && !changingSession && dropTarget?.kind === SESSION_DROP_KINDS.detach
  )
  const taskHeadingClassName =
    'shrink-0 px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]'
  return (
    <nav
      ref={navigationRef}
      className="relative flex h-full min-h-0 flex-col"
      aria-label={t('tasks')}
      data-testid="project-navigation"
    >
      <div
        ref={archiveHeightRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-[var(--vds-project-archive-max-height)] w-0"
      />
      <header className="flex h-[var(--vds-workbench-header-height)] shrink-0 items-center gap-[var(--vds-space-half)] border-b border-[var(--vds-divider-default)] px-[var(--vds-space-2)] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_svg]:size-[var(--vds-icon-8)] [&_svg]:[stroke-width:var(--vds-project-header-icon-stroke)]">
        <Tooltip content={t('back')} side="bottom">
          <IconButton
            variant="ghostIcon"
            size="sm"
            label={t('back')}
            title={undefined}
            icon={<Box />}
            className="shrink-0"
            onClick={() => act.openProjectCenter({ overview: true })}
            data-testid="project-navigation-home"
          />
        </Tooltip>
        <span aria-hidden="true" className="shrink-0 text-[var(--vds-text-placeholder)]">
          /
        </span>
        <Popover open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
          <PopoverTrigger asChild>
            <NavigationButton
              icon={null}
              className="!w-auto flex-1 !shrink"
              label={project?.name ?? shellText('chrome.selectProject')}
              data-testid="project-navigation-selector"
              data-ob={PROJECT_GUIDE_ANCHORS.switcher}
            />
          </PopoverTrigger>
          <PopoverContent>
            <ProjectMenu onClose={() => setProjectMenuOpen(false)} />
          </PopoverContent>
        </Popover>
        <Tooltip content={shellText('chrome.collapseSidebar')} side="bottom" portalled>
          <IconButton
            variant="ghostIcon"
            size="md"
            label={shellText('chrome.collapseSidebar')}
            title={undefined}
            className="ml-auto shrink-0"
            icon={<IconFont type="panel-left-close" />}
            onClick={act.toggleModulePanel}
            data-testid="project-sidebar-collapse"
          />
        </Tooltip>
      </header>
      <ResizablePanelGroup
        ref={resizeGroupRef}
        direction="vertical"
        className="min-h-0 flex-1 !gap-0 !rounded-none !border-0 !bg-transparent !opacity-[var(--vds-opacity-full)]"
        sizes={
          archiveOpen
            ? (archiveSizes ?? [
                PANEL_PERCENTAGE_TOTAL - archiveDefaultPercentage,
                archiveDefaultPercentage,
              ])
            : [PANEL_PERCENTAGE_TOTAL, 0]
        }
        onSizesChange={setArchiveSizes}
        disabled={!archiveOpen}
      >
        <ResizablePanel
          minSize={PANEL_PERCENTAGE_TOTAL - archiveMaxPercentage}
          maxSize={PANEL_PERCENTAGE_TOTAL}
          className="flex min-h-0 flex-col !overflow-hidden !p-0"
        >
          <div className="grid shrink-0 gap-[var(--vds-space-1)] px-[var(--vds-space-3)] pt-[var(--vds-space-4)]">
            <Button
              variant="secondary"
              className="!h-[var(--vds-project-navigation-action-height)] !justify-start !gap-[var(--vds-space-2)] !px-[var(--vds-space-2)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)]"
              onClick={() => act.startPanelDraft()}
              data-testid="project-new-task"
              data-ob={PROJECT_GUIDE_ANCHORS.task}
            >
              <Plus />
              {t('newTask')}
            </Button>
            <Button
              variant="ghost"
              data-testid="project-search"
              aria-expanded={state.globalSearchOpen}
              className="w-full !h-[var(--vds-project-navigation-action-height)] !justify-start !gap-[var(--vds-navigation-button-gap)] !px-[var(--vds-space-2)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)]"
              onClick={() => set({ globalSearchOpen: true, globalSearchMode: 'all' })}
            >
              <Search className="text-[var(--vds-text-7)]" />
              {shellText('chrome.search')}
            </Button>
            <Button
              variant="ghost"
              data-testid="project-library"
              data-ob={PROJECT_GUIDE_ANCHORS.files}
              aria-pressed={
                state.workbenchLayout.open &&
                state.tabs.some(
                  (tab) =>
                    tab.id === state.activeTab &&
                    tab.kind === 'library' &&
                    tabMatchesProject(tab, state.homeSelectedProjectId)
                )
              }
              className="w-full !h-[var(--vds-project-navigation-action-height)] !justify-start !gap-[var(--vds-navigation-button-gap)] !px-[var(--vds-space-2)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)] aria-pressed:!bg-[var(--vds-surface-hover)]"
              onClick={() =>
                set((current) => {
                  return {
                    ...projectLibraryNavigation(current.tabs, current.homeSelectedProjectId),
                    workbenchLayout: {
                      ...current.workbenchLayout,
                      open: true,
                      full: false,
                      swapped: false,
                      taskTab: false,
                    },
                  }
                })
              }
            >
              <Folders className="text-[var(--vds-text-7)]" />
              {t('projectFiles')}
            </Button>
          </div>
          <section
            data-ob={PROJECT_GUIDE_ANCHORS.tasks}
            aria-labelledby="project-task-list"
            className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-3)] px-[var(--vds-space-3)] pt-[var(--vds-space-4)]"
          >
            {pinFailed && <Alert tone="error" role="alert" description={t('saveFailed')} />}
            {changeFeedback && (
              <Alert tone="error" role="alert">
                <AlertDescription truncate={false}>{t(changeFeedback)}</AlertDescription>
              </Alert>
            )}
            {changingSession?.message &&
              rows.some((row) => row.session_id === changingSession.id) && (
                <span role="status">{t(changingSession.message)}</span>
              )}
            <ScrollArea
              overlay
              shadow="auto"
              data-scrolling={taskScrollbarVisible}
              className="flex min-h-0 flex-1 flex-col -mr-[var(--vds-space-3)] data-[scrolling=false]:[&>[role=scrollbar]]:invisible before:!-left-[var(--vds-space-3)] before:!h-0 before:![background:none] before:border-t before:border-[var(--vds-divider-default)] after:!-left-[var(--vds-space-3)] after:![background:linear-gradient(to_top,var(--vds-bg-gray-default),transparent)]"
              viewportClassName="min-h-0 flex-1 pr-[var(--vds-space-3)]"
              viewportProps={{ onScroll: taskScrollbar.scroll, 'aria-label': t('tasks') }}
            >
              <div
                className="flex min-h-full min-w-0 flex-col gap-[var(--vds-space-1)]"
                data-testid="project-task-list"
                aria-busy={loading}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return
                  if (!acceptsListDetach(event)) {
                    event.dataTransfer.dropEffect = 'none'
                    setDropTarget(null)
                    return
                  }
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget({ kind: SESSION_DROP_KINDS.detach })
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setDropTarget(null)
                }}
                onDrop={(event) => {
                  setDropTarget(null)
                  if (
                    !acceptsListDetach(event) ||
                    event.dataTransfer.getData(SESSION_DRAG_TYPE) !== draggedSession?.session_id
                  )
                    return
                  event.preventDefault()
                  event.stopPropagation()
                  detachDraggedSession()
                }}
              >
                {pinnedTasks.length > 0 && (
                  <section
                    aria-labelledby="project-pinned-task-heading"
                    data-testid="project-pinned-tasks"
                    className="mb-[var(--vds-space-3)] flex shrink-0 flex-col gap-[var(--vds-space-1)]"
                  >
                    <h2
                      id="project-pinned-task-heading"
                      className={`${taskHeadingClassName} relative mb-[var(--vds-space-2)]`}
                    >
                      {t('pinnedTasks')}
                      {detachDropActive && draggedSession?.pinned && (
                        <SessionDropIndicator after label={t('detachToPinnedStart')} />
                      )}
                    </h2>
                    {renderTasks(pinnedTasks)}
                  </section>
                )}
                <h2
                  id="project-task-list"
                  className={`${taskHeadingClassName} relative mb-[var(--vds-space-2)]`}
                >
                  {t('tasks')}
                  {detachDropActive && !draggedSession?.pinned && (
                    <SessionDropIndicator after label={t('detachToTaskStart')} />
                  )}
                </h2>
                {loading && !rows.length && <Spinner />}
                {failed && (
                  <Button
                    onClick={() => {
                      setLoading(true)
                      setRevision((value) => value + 1)
                    }}
                  >
                    {t('loadFailed')}
                  </Button>
                )}
                {!loading && !failed && !visible.length && (
                  <EmptyState
                    image={{ src: emptyFolder, alt: '' }}
                    title={t('emptyTasks')}
                    className="[&_.vds-empty-state\_\_title]:text-[length:var(--vds-font-body-lv2)] [&_.vds-empty-state\_\_title]:font-[var(--vds-fw-medium)] [&_.vds-empty-state\_\_title]:text-[var(--vds-text-secondary)]"
                  />
                )}
                {renderTasks(unpinnedTasks)}
              </div>
            </ScrollArea>
          </section>
        </ResizablePanel>
        <ResizableHandle
          disabled={!archiveOpen}
          className={
            archiveOpen
              ? '!basis-0 !h-0 !bg-transparent before:!left-0 before:!top-0 before:!h-[var(--vds-space-2)] before:!w-full before:!translate-x-0 before:!-translate-y-1/2 before:![background:none] before:!pointer-events-auto after:!hidden [&>span]:!hidden z-[var(--vds-z-local-control)]'
              : '!hidden'
          }
        />
        <ResizablePanel
          minSize={archiveOpen ? archiveDefaultPercentage : 0}
          maxSize={archiveOpen ? archiveMaxPercentage : 0}
          className={`!overflow-hidden !p-0${archiveOpen ? ' shadow-[var(--vds-project-archive-shadow)]' : ' !basis-auto shrink-0'}`}
        >
          <Collapsible
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            className={`!flex min-h-0 flex-col !gap-[var(--vds-space-1)] border-t border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] px-[var(--vds-space-3)]${archiveOpen ? ' h-full' : ''}`}
            data-testid="project-archives"
          >
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="content"
                data-testid="project-archive-toggle"
                className="!flex !h-[var(--vds-project-archive-header-height)] data-[state=closed]:!h-[var(--vds-project-archive-collapsed-height)] data-[state=closed]:!py-[var(--vds-space-4)] w-full shrink-0 !justify-start !gap-[var(--vds-navigation-button-gap)] !rounded-none !border-0 !px-[var(--vds-space-3)] !pt-[var(--vds-space-4)] !pb-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)] hover:![background:transparent] focus-visible:shadow-[var(--vds-focus-brand)] [&_svg]:size-[var(--vds-icon-8)]"
              >
                <Archive className="text-[var(--vds-text-tertiary)]" />
                <span className="min-w-0 flex-1">{t('archivedTasks')}</span>
                <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {archivedRows ? archivedRows.length : archiveFailed ? null : <Spinner />}
                </span>
                <ChevronDown
                  className={
                    archiveOpen
                      ? '!size-[var(--vds-icon-7)] rotate-180 text-[var(--vds-text-tertiary)]'
                      : '!size-[var(--vds-icon-7)] text-[var(--vds-text-tertiary)]'
                  }
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent
              className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden !rounded-none !border-0 !bg-transparent !px-0 !pt-0 !pb-[var(--vds-space-3)] !animate-none [&>div+div]:mt-[var(--vds-space-1)]"
              data-testid="project-archived-list"
            >
              {archiveFailed && (
                <Button onClick={() => setRevision((value) => value + 1)}>{t('loadFailed')}</Button>
              )}
              {archiveOperationFailed && (
                <Alert tone="error" description={archiveText('taskArchive.loadFailed')} />
              )}
              {!archivedRows && !archiveFailed && <Spinner />}
              {archivedRows?.length === 0 && (
                <EmptyState variant="compact" title={t('emptyArchivedTasks')} />
              )}
              {archivedRows?.map((row) => (
                <div
                  key={row.session_id}
                  className="group/archive relative flex h-[var(--vds-project-task-height)] min-w-0 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] pr-[var(--vds-space-2)] hover:bg-[var(--vds-surface-hover)] [&:has([aria-current=true])]:bg-[var(--vds-surface-hover)]"
                  data-testid={`project-archived-task-${row.session_id}`}
                >
                  <Button
                    variant="ghost"
                    className="h-full min-w-0 flex-1 !justify-start !px-[var(--vds-space-3)] !bg-transparent text-[var(--vds-text-secondary)] hover:!bg-transparent active:!bg-transparent"
                    aria-current={state.archivedSession?.session_id === row.session_id}
                    onClick={() =>
                      set((current) => ({
                        archivedSession: row,
                        activeSession: row.session_id,
                        threads: {
                          ...current.threads,
                          [row.session_id]: {
                            ...current.threads[row.session_id],
                            id: row.session_id,
                            title: row.title,
                            title_fallback: row.title_fallback,
                            sessionId: row.session_id,
                            projectPath: row.project_path,
                            workdir: row.runtime_workdir ?? row.workdir,
                            runtimeId: row.runtime_id,
                            runtime: row.runtime,
                            readiness: row.readiness ?? undefined,
                            capabilities: row.capabilities,
                            conversation: current.threads[row.session_id]?.conversation ?? [],
                            lastSeq: current.threads[row.session_id]?.lastSeq ?? row.last_seq ?? 0,
                            readOnly: true,
                            running: false,
                            interrupting: false,
                            resumeState: 'pending',
                          },
                        },
                        aiPanel: { ...current.aiPanel, open: true },
                        workbenchLayout: {
                          ...current.workbenchLayout,
                          open: false,
                          full: false,
                          conversationFull: false,
                          taskTab: false,
                        },
                      }))
                    }
                  >
                    <EllipsisText tooltipPortalled tooltipSide="right" tooltipAlign="center">
                      {sessionDisplayTitle(row, assistantText)}
                    </EllipsisText>
                  </Button>
                  <div className="pointer-events-none absolute right-[var(--vds-space-2)] flex shrink-0 items-center gap-[var(--vds-space-1)] opacity-0 group-hover/archive:static group-hover/archive:pointer-events-auto group-hover/archive:opacity-[var(--vds-opacity-full)] group-focus-within/archive:static group-focus-within/archive:pointer-events-auto group-focus-within/archive:opacity-[var(--vds-opacity-full)]">
                    <Tooltip content={archiveText('taskArchive.restoreTask')} portalled>
                      <IconButton
                        size="sm"
                        variant="ghostIcon"
                        label={archiveText('taskArchive.restoreTask')}
                        title={undefined}
                        icon={<ArchiveRestore />}
                        disabled={restoring !== null}
                        onClick={() => void restore(row)}
                      />
                    </Tooltip>
                    <Tooltip content={assistantText('panel.delete')} portalled>
                      <IconButton
                        size="sm"
                        variant="ghostIcon"
                        label={assistantText('panel.delete')}
                        title={undefined}
                        icon={<ArchiveX className="text-[var(--vds-error-text-primary)]" />}
                        disabled={restoring !== null}
                        onClick={() =>
                          set({
                            confirmDelete: {
                              label: row.title,
                              title_fallback: row.title_fallback,
                              sessionId: row.session_id,
                              surface: 'assistant',
                            },
                          })
                        }
                      />
                    </Tooltip>
                  </div>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        </ResizablePanel>
      </ResizablePanelGroup>
    </nav>
  )
}
