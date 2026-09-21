import { documentDisplayTitle } from '../../delivery'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { History, Save } from 'lucide-react'

import { featureRegistry } from '../../app/composition'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  BadgeDot,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  EllipsisText,
  IconButton,
  Tooltip,
  useToast,
  type NavigationTabItem
} from '../../components/ui'
import type { DocumentPanelContext, DocumentPanelContribution } from '../../contracts/features'
import { Icon } from '../../icons'
import { Pending } from '../../shell/Pending'
import { resourceFileIcon } from '../resources/icons'
import { selectedProject, useApp } from '../../store'
import { subscribeFileEvents } from '../project/events'
import {
  clampRatio,
  canPlaceTab,
  nodeTabCount,
  type DockArea,
  type DockLeaf,
  type DockNode,
  type DockSplit,
  type DropEdge
} from './layout'
import {
  DOCUMENT_TAB_MIME,
  DocumentNavigationTabs,
  type DocumentDropPreview,
  useDocumentDrag
} from './Dragging'
import { reclaimDocumentResources } from './reclaim'
import { DocumentPanelActions, DocumentPanelHost } from './Inspector'
import { DocumentTabMenu } from './Menu'
import { documentPanelContext } from './panel'
import { SelectionActionHost } from './Selection'
import { DocumentExternalOpen } from './External'
import {
  preserveTextSelectionForContextMenu,
  retainsDocumentSelection
} from './focus'
import { isMissingDocumentFailure } from './api'
import { useOfficeRuntime } from './office/runtime'
import { VersionHistory } from './VersionHistory'
import {
  useDocumentWorkspace,
  useWorkspaceController,
  type DocumentSession,
  type DocumentTab
} from './workspace'

const EDGE_RATIO = 0.24
const PATH_SEPARATOR = '/'
const MANAGEMENT_LABEL: Record<string, 'dock.ignored' | 'dock.oversized' | 'dock.unsupported' | 'dock.unavailable' | 'dock.migrationRequired'> = {
  migration_required: 'dock.migrationRequired',
  ignored: 'dock.ignored',
  oversized: 'dock.oversized',
  unsupported: 'dock.unsupported',
  unavailable: 'dock.unavailable'
}

function dropEdge(event: React.DragEvent, element: HTMLElement): DropEdge {
  const rect = element.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  if (x < EDGE_RATIO) return 'left'
  if (x > 1 - EDGE_RATIO) return 'right'
  if (y < EDGE_RATIO) return 'top'
  if (y > 1 - EDGE_RATIO) return 'bottom'
  return 'center'
}

function TabStrip({ leaf }: { leaf: DockLeaf }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: conversation } = useTranslation('conversation')
  const { t: shellText } = useTranslation('shell')
  const state = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const tabs: NavigationTabItem[] = leaf.tabIds.flatMap((tabId) => {
    const tab = state.tabs[tabId]
    const session = tab ? state.sessions[tab.sessionId] : null
    if (!tab || !session) return []
    const ResourceIcon = resourceFileIcon(tab.title)
    return [{
      dirty: session.dirty,
      icon: <ResourceIcon size={13} strokeWidth={1.8} />,
      id: tab.id,
      label: documentDisplayTitle(tab, conversation, t)
    }]
  })
  return (
    <DocumentNavigationTabs
      aria-label={shellText('tabs.opened')}
      leaf={leaf}
      onClose={(tabId) => workspace.requestClose(tabId)}
      onContextMenuOpen={(tabId) => workspace.activate(leaf.id, tabId)}
      onValueChange={(tabId) => workspace.activate(leaf.id, tabId)}
      renderContextMenu={(tab) => <DocumentTabMenu tabId={tab.id} tabIds={leaf.tabIds} />}
      showOverview={false}
      tabs={tabs}
      value={leaf.activeTabId ?? tabs[0]?.id}
    />
  )
}

function DocumentToolbarActions({ session }: { session: DocumentSession }): React.JSX.Element {
  const projectId = session.source.kind === 'project' ? session.source.project ?? null : null
  return (
    <>
      {featureRegistry.documentToolbarItems.map((item) => (
        <React.Fragment key={item.id}>
          {item.render({
            path: session.source.path,
            projectId,
            selection: session.selection,
            sourceKind: session.source.kind
          })}
        </React.Fragment>
      ))}
    </>
  )
}

function DocumentVersionActions({ session }: { session: DocumentSession }): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const [historyOpen, setHistoryOpen] = useState(false)
  if (session.source.kind !== 'project') return null
  return (
    <>
      <Tooltip portalled content={t('history.trigger')}><IconButton
        data-testid="document-version-history"
        icon={<History />}
        label={t('history.trigger')}
        size="sm"
        title={undefined}
        variant="ghostIcon"
        onClick={() => setHistoryOpen(true)}
      /></Tooltip>
      <VersionHistory session={session} open={historyOpen} onOpenChange={setHistoryOpen} />
    </>
  )
}

function DocumentToolbar({
  activePanelId,
  panels,
  session,
  onPanelToggle
}: {
  activePanelId: string | null
  panels: DocumentPanelContribution[]
  session: DocumentSession
  onPanelToggle: (panelId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: uiText } = useTranslation('ui')
  const workspace = useWorkspaceController()
  const pathParts = session.source.path.split(PATH_SEPARATOR).filter(Boolean)
  const fileName = pathParts.pop() ?? session.source.path
  const parentPath = session.source.kind === 'literature'
    ? t('dock.literatureRoot')
    : pathParts.join(` ${PATH_SEPARATOR} `) || t('dock.resourceRoot')
  return (
    <div className="vds-document-toolbar">
      {session.source.kind !== 'literature' && (
        <Breadcrumb
          className="min-w-0 max-w-[min(52vw,560px)] text-[14px] leading-5"
          label={t('dock.filePath')}
          title={session.source.path}
        >
          <BreadcrumbList className="flex-nowrap gap-2 overflow-hidden">
            <BreadcrumbItem className="min-w-0 max-w-[45%] shrink overflow-hidden font-normal text-[var(--vds-text-placeholder)]">
              <EllipsisText
                tooltip={parentPath}
                tooltipPortalled
                tooltipSide="bottom"
                wrapperClassName="max-w-full"
              >
                {parentPath}
              </EllipsisText>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="shrink-0 text-[var(--vds-text-placeholder)]" />
            <BreadcrumbItem className="min-w-0 shrink overflow-hidden">
              <BreadcrumbPage className="min-w-0 overflow-hidden font-normal text-[var(--vds-text-primary)]">
                <EllipsisText
                  tooltip={fileName}
                  tooltipPortalled
                  tooltipSide="bottom"
                  wrapperClassName="max-w-full"
                >
                  {fileName}
                </EllipsisText>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )}
      {(session.saveState === 'saving' || session.saveState === 'conflict' || session.saveState === 'error') && (
        <span className={`is-${session.saveState}`}>
          {session.saveState === 'saving' && t('dock.saving')}
          {session.saveState === 'conflict' && t('dock.externalChange')}
          {session.saveState === 'error' && t('dock.saveFailed')}
        </span>
      )}
      {session.versioning && session.versioning.management_state !== 'managed'
        && session.versioning.management_state !== 'git' && (
        <Badge tone="neutral">
          {Object.prototype.hasOwnProperty.call(MANAGEMENT_LABEL, session.versioning.management_state)
            ? t(MANAGEMENT_LABEL[session.versioning.management_state])
            : t('dock.unavailable')}
        </Badge>
      )}
      <div className="vds-document-toolbar-spacer" />
      <DocumentToolbarActions session={session} />
      <DocumentPanelActions
        activePanelId={activePanelId}
        panels={panels}
        onToggle={onPanelToggle}
      />
      <DocumentExternalOpen session={session} />
      <DocumentVersionActions session={session} />
      {session.capabilities.can_save && (
        <Tooltip portalled content={uiText('save')}>
          <span className="relative inline-flex">
            <IconButton
              variant="ghostIcon"
              size="sm"
              title={undefined}
              label={uiText('save')}
              icon={<Save />}
              data-testid="document-save"
              disabled={!session.dirty || session.saveState === 'saving'}
              onClick={() => void workspace.save(session.id)}
            />
            {session.dirty && <BadgeDot className="pointer-events-none absolute right-0 top-0" data-testid="document-save-dirty" />}
          </span>
        </Tooltip>
      )}
    </div>
  )
}

function useMissingDocumentNotice(tab: DocumentTab, title: string, missing: boolean): void {
  const { t } = useTranslation('workbench')
  const { toast } = useToast()
  const workspace = useWorkspaceController()
  const noticed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!missing || noticed.current.has(tab.id)) return
    noticed.current.add(tab.id)
    toast({
      title: t('dock.missingTitle', { title }),
      description: t('dock.missingDescription'),
      tone: 'error'
    })
    workspace.requestClose(tab.id)
  }, [missing, tab.id, title, t, toast, workspace])
}

function DocumentView({ active, tab }: { active: boolean; tab: DocumentTab }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: conversation } = useTranslation('conversation')
  const { t: uiText } = useTranslation('ui')
  const state = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  const session = state.sessions[tab.sessionId]
  const missing = Boolean(session?.loadState === 'error'
    && session.loadFailure
    && isMissingDocumentFailure(session.loadFailure))
  useMissingDocumentNotice(tab, documentDisplayTitle(tab, conversation, t), missing)
  if (!session || session.loadState === 'loading') {
    return <div className="vds-viewer-empty">{t('dock.loading', { title: documentDisplayTitle(tab, conversation, t) })}</div>
  }
  if (session.loadState === 'error') {
    const failure = session.loadFailure
    if (missing) {
      return (
        <div className="vds-viewer-empty" data-testid="document-missing">
          {t('dock.missingTitle', { title: documentDisplayTitle(tab, conversation, t) })}
        </div>
      )
    }
    return (
      <div className="vds-viewer-empty" data-testid="document-load-error">
        <Alert
          action={failure?.retryable
            ? (
                <Button
                  data-testid="document-load-retry"
                  variant="outline"
                  onClick={() => void workspace.retryLoad(session.id)}
                >
                  {uiText('retry')}
                </Button>
              )
            : undefined}
          description={failure
            ? t('dock.loadFailureDetail', { message: failure.message, code: failure.code })
            : t('dock.loadFailureUnknown')}
          title={t('dock.loadFailed', { title: documentDisplayTitle(tab, conversation, t) })}
          tone="error"
        />
      </div>
    )
  }
  const viewer = featureRegistry.viewers.get(session.viewer)
  const panelContext: DocumentPanelContext = documentPanelContext(session, tab)
  const panels = featureRegistry.documentPanels.filter((panel) => panel.matches(panelContext))
  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? null
  const toolbarPanels = panels.filter((panel) => panel.placement !== 'viewer')
  const viewerPanels = panels.filter((panel) => panel.placement === 'viewer')
  const togglePanel = (panelId: string): void => {
    setActivePanelId((current) => (current === panelId ? null : panelId))
  }
  return (
    <div className={`vds-document-view${viewer?.toolbar === 'viewer' ? ' is-viewer-toolbar' : ''}`}>
      {viewer?.toolbar !== 'viewer' && (
        <DocumentToolbar
          activePanelId={activePanel?.id ?? null}
          panels={toolbarPanels}
          session={session}
          onPanelToggle={togglePanel}
        />
      )}
      {session.saveState === 'conflict' && (
        <Alert tone="warning" data-testid="document-save-conflict">
          <AlertTitle>{t('dock.conflictTitle')}</AlertTitle>
          <AlertDescription>{t('dock.conflictDescription')}</AlertDescription>
          <div className="vds-version-actions">
            <Button size="sm" variant="danger" data-testid="document-conflict-overwrite" onClick={() => void workspace.overwriteDisk(session.id)}>{t('dock.overwrite')}</Button>
            <Button size="sm" variant="secondary" data-testid="document-conflict-discard" onClick={() => void workspace.discardMemory(session.id)}>{t('dock.discard')}</Button>
            <Button size="sm" variant="secondary" data-testid="document-conflict-copy" onClick={() => void workspace.saveManagedCopy(session.id)}>{t('dock.saveAs')}</Button>
          </div>
        </Alert>
      )}
      <div className="vds-document-view-body flex">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {session.deleted
            ? <div className="vds-viewer-empty">{t('dock.deleted')}</div>
            : viewer
            ? viewer.render({
                active,
                path: session.source.path,
                documentSessionId: session.id,
                tabId: tab.id,
                viewKind: tab.viewKind,
                toolbarActions: (
                  <>
                    <DocumentToolbarActions session={session} />
                    <DocumentVersionActions session={session} />
                  </>
                ),
                documentPanels: {
                  activePanelId: activePanel?.id ?? null,
                  context: panelContext,
                  panels: viewerPanels,
                  toggle: togglePanel
                },
                contentKind: session.contentKind
              })
            : <Pending feature={t('viewer.unsupported')} owner={t('unavailable.workspace')} detail={session.viewer} />}
        </div>
        {activePanel && activePanel.placement !== 'viewer' && (
          <DocumentPanelHost
            context={panelContext}
            panel={activePanel}
            onClose={() => setActivePanelId(null)}
          />
        )}
      </div>
    </div>
  )
}

function LeafView({
  area,
  leaf,
  draggingTabId,
  onDragFinish,
  onDropTarget,
  showTabs
}: {
  area: DockArea
  leaf: DockLeaf
  draggingTabId: string | null
  onDragFinish: () => void
  onDropTarget: (target: DocumentDropPreview | null) => void
  showTabs: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const workspace = useWorkspaceController()
  const state = useDocumentWorkspace()
  const drag = useDocumentDrag()
  const tab = leaf.activeTabId ? state.tabs[leaf.activeTabId] : null
  return (
    <section
      className={`vds-dock-leaf${state.focusedLeaf?.area === area && state.focusedLeaf.leafId === leaf.id ? ' is-focused' : ''}${showTabs ? ' !grid-rows-[auto_minmax(0,1fr)]' : ' is-tabless'}`}
      data-dock-area={area}
      data-dock-leaf={leaf.id}
      onPointerDownCapture={() => workspace.focusLeaf(area, leaf.id)}
      onFocusCapture={() => workspace.focusLeaf(area, leaf.id)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DOCUMENT_TAB_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const edge = dropEdge(event, event.currentTarget)
        if (!draggingTabId || !canPlaceTab(state.layout, draggingTabId, area, leaf.id, edge)) {
          event.dataTransfer.dropEffect = 'none'
          onDropTarget(null)
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        drag.setInsertionTarget(null)
        const tabList = showTabs
          ? event.currentTarget.querySelector<HTMLElement>(':scope > [role="tablist"]')
          : null
        const contentTop = tabList?.getBoundingClientRect().bottom ?? rect.top
        onDropTarget({
          edge,
          left: rect.left,
          top: contentTop,
          width: rect.width,
          height: Math.max(0, rect.bottom - contentTop)
        })
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        onDropTarget(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        const tabId = event.dataTransfer.getData(DOCUMENT_TAB_MIME)
        const edge = dropEdge(event, event.currentTarget)
        onDragFinish()
        if (tabId) void workspace.moveTab(tabId, area, leaf.id, edge)
      }}
    >
      {showTabs && (
        <TabStrip leaf={leaf} />
      )}
      {tab
        ? leaf.tabIds.map((tabId) => {
            const candidate = state.tabs[tabId]
            if (!candidate) return null
            const keepMounted = candidate.viewKind === 'edit'
            if (!keepMounted && candidate.id !== tab.id) return null
            return (
              <div
                key={candidate.id}
                className="vds-document-view-slot"
                hidden={candidate.id !== tab.id}
              >
                <DocumentView active={candidate.id === tab.id} tab={candidate} />
              </div>
            )
          })
        : <div className="vds-dock-empty">{t('dock.dropTab')}</div>}
    </section>
  )
}

function SplitView({
  area,
  split,
  draggingTabId,
  onDragFinish,
  onDropTarget,
  showTabs
}: {
  area: DockArea
  showTabs: boolean
  split: DockSplit
  draggingTabId: string | null
  onDragFinish: () => void
  onDropTarget: (target: DocumentDropPreview | null) => void
}): React.JSX.Element {
  const workspace = useWorkspaceController()
  const axis = split.direction === 'horizontal' ? 'clientX' : 'clientY'
  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const host = event.currentTarget.parentElement
    if (!host) return
    const rect = host.getBoundingClientRect()
    const move = (next: PointerEvent): void => {
      const offset = axis === 'clientX' ? next.clientX - rect.left : next.clientY - rect.top
      const size = axis === 'clientX' ? rect.width : rect.height
      workspace.resizePane(area, split.id, offset / size)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }
  return (
    <div
      className={`vds-dock-split is-${split.direction}`}
      style={split.direction === 'horizontal'
        ? { gridTemplateColumns: `${split.ratio}fr 5px ${1 - split.ratio}fr` }
        : { gridTemplateRows: `${split.ratio}fr 5px ${1 - split.ratio}fr` }}
    >
      <NodeView area={area} node={split.first} draggingTabId={draggingTabId} onDragFinish={onDragFinish} onDropTarget={onDropTarget} showTabs={showTabs} />
      <div className="vds-dock-divider" onPointerDown={beginResize} />
      <NodeView area={area} node={split.second} draggingTabId={draggingTabId} onDragFinish={onDragFinish} onDropTarget={onDropTarget} showTabs={showTabs || split.direction === 'vertical'} />
    </div>
  )
}

function NodeView({
  area,
  node,
  draggingTabId,
  onDragFinish,
  onDropTarget,
  showTabs
}: {
  area: DockArea
  node: DockNode
  draggingTabId: string | null
  onDragFinish: () => void
  onDropTarget: (target: DocumentDropPreview | null) => void
  showTabs: boolean
}): React.JSX.Element {
  return node.kind === 'leaf'
    ? <LeafView area={area} leaf={node} draggingTabId={draggingTabId} onDragFinish={onDragFinish} onDropTarget={onDropTarget} showTabs={showTabs} />
    : <SplitView area={area} split={node} showTabs={showTabs} draggingTabId={draggingTabId} onDragFinish={onDragFinish} onDropTarget={onDropTarget} />
}

function dropPreviewStyle(target: DocumentDropPreview): React.CSSProperties {
  if (target.edge === 'left') return { left: target.left, top: target.top, width: target.width / 2, height: target.height }
  if (target.edge === 'right') return { left: target.left + target.width / 2, top: target.top, width: target.width / 2, height: target.height }
  if (target.edge === 'top') return { left: target.left, top: target.top, width: target.width, height: target.height / 2 }
  if (target.edge === 'bottom') return { left: target.left, top: target.top + target.height / 2, width: target.width, height: target.height / 2 }
  return { left: target.left, top: target.top, width: target.width, height: target.height }
}

export function DocumentDock(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: uiText } = useTranslation('ui')
  const { state: appState } = useApp()
  const state = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const drag = useDocumentDrag()
  const officeRuntime = useOfficeRuntime()
  const project = selectedProject(appState)?.id ?? ''

  useEffect(() => {
    if (!project) return undefined
    return subscribeFileEvents(project, (event) => {
      if (event.source !== 'external') return
      if (event.kind === 'rescan') void workspace.reconcileProject(project)
      else if (event.path) void workspace.observeExternal(project, event.path)
    })
  }, [project, workspace])
  useEffect(() => {
    reclaimDocumentResources(new Set(Object.keys(state.sessions)), new Set(Object.keys(state.tabs)))
  }, [state.sessions, state.tabs])

  useEffect(() => {
    officeRuntime.setInteractionBlocked(Boolean(drag.draggingTabId))
    return () => officeRuntime.setInteractionBlocked(false)
  }, [drag.draggingTabId, officeRuntime])

  useEffect(() => {
    const dismissSelection = (): void => {
      const snapshot = workspace.getSnapshot()
      const focusedTabId = snapshot.focusedTabId
      const focusedTab = focusedTabId ? snapshot.tabs[focusedTabId] : null
      if (focusedTabId && focusedTab && snapshot.sessions[focusedTab.sessionId]?.selection) {
        workspace.setSelection(focusedTabId, null)
      }
      window.getSelection()?.removeAllRanges()
    }
    const dismissOutsideSelection = (event: Event): void => {
      if (retainsDocumentSelection(null, event.target)) return
      dismissSelection()
    }
    const dismissOutsidePointer = (event: PointerEvent): void => {
      if (preserveTextSelectionForContextMenu(event)) return
      dismissOutsideSelection(event)
    }
    document.addEventListener('focusin', dismissOutsideSelection, true)
    document.addEventListener('pointerdown', dismissOutsidePointer, true)
    window.addEventListener('blur', dismissSelection)
    return () => {
      document.removeEventListener('focusin', dismissOutsideSelection, true)
      document.removeEventListener('pointerdown', dismissOutsidePointer, true)
      window.removeEventListener('blur', dismissSelection)
    }
  }, [workspace])

  const beginAreaResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const host = event.currentTarget.parentElement
    if (!host) return
    const rect = host.getBoundingClientRect()
    const move = (next: PointerEvent): void => {
      workspace.resizeArea(clampRatio((next.clientX - rect.left) / rect.width))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  const visibleAreas = (['primary', 'secondary'] as const).filter(
    (area) => nodeTabCount(state.layout.areas[area]) > 0
  )
  if (visibleAreas.length === 0) visibleAreas.push('primary')

  return (
    <div
      className="vds-document-dock"
      data-testid="document-dock"
      onBlurCapture={(event) => {
        if (!appState.autoSave) return
        const host = event.currentTarget
        const related = event.relatedTarget
        if (related instanceof Node && host.contains(related)) return
        queueMicrotask(() => {
          const active = document.activeElement
          if (document.hasFocus() && active instanceof Node && host.contains(active)) return
          void workspace.saveFocused()
        })
      }}
    >
      <SelectionActionHost />
      <div
        className="vds-document-areas"
        style={visibleAreas.length === 2
          ? { gridTemplateColumns: `${state.layout.areaRatio}fr 6px ${1 - state.layout.areaRatio}fr` }
          : { gridTemplateColumns: 'minmax(0, 1fr)' }}
      >
        {/* Top navigation owns these tabs; the old conditional was:
            showTabs={visibleAreas.length > 1 || state.layout.areas[visibleAreas[0]].kind !== 'leaf'} */}
        <NodeView area={visibleAreas[0]} node={state.layout.areas[visibleAreas[0]]} draggingTabId={drag.draggingTabId} onDragFinish={drag.finish} onDropTarget={drag.setPreview} showTabs={false} />
        {visibleAreas.length === 2 && (
          <>
            <div className="vds-area-divider" onPointerDown={beginAreaResize} />
            <NodeView area={visibleAreas[1]} node={state.layout.areas[visibleAreas[1]]} draggingTabId={drag.draggingTabId} onDragFinish={drag.finish} onDropTarget={drag.setPreview} showTabs={false} />
          </>
        )}
      </div>
      <AlertDialog
        open={Boolean(state.pendingClose)}
        onOpenChange={(open) => {
          if (!open && state.pendingClose) void workspace.resolveClose('cancel')
        }}
      >
        <AlertDialogContent aria-label={t('dock.closeLabel')} data-testid="document-close-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dock.closeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('dock.closeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" data-testid="document-close-cancel" onClick={() => void workspace.resolveClose('cancel')}>{uiText('cancel')}</Button>
            <Button variant="danger" data-testid="document-close-discard" onClick={() => void workspace.resolveClose('discard')}>{t('dock.discard')}</Button>
            <Button
              variant="primary"
              data-testid="document-close-save"
              onClick={() => void workspace.resolveClose(
                state.sessions[state.pendingClose?.sessionId ?? '']?.saveState === 'conflict'
                  ? 'overwrite'
                  : 'save'
              )}
            >
              {state.sessions[state.pendingClose?.sessionId ?? '']?.saveState === 'conflict'
                ? t('dock.overwriteClose')
                : t('dock.saveClose')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {drag.preview && createPortal(
        <div className="vds-dock-drop-preview" style={dropPreviewStyle(drag.preview)} />,
        document.body
      )}
    </div>
  )
}
