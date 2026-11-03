import { PROJECT_GUIDE_ANCHORS } from '../contracts/onboarding'
import { availabilityPolicy } from '../app/policy'
import { documentDisplayTitle } from '../delivery'
import React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Folders, FolderTree, LayoutDashboard, LibraryBig, MessageCircle } from 'lucide-react'

import {
  NavigationTabsMenu,
  type NavigationTabElementProps,
  type NavigationTabItem,
} from '../components/ui'
import { fileIconForName, IconFont } from '../components/primitive'
import { Icon } from '../icons'
import { activeThread, useApp } from '../store'
import { changeProjectLayout } from '../../../layout'
import { sessionDisplayTitle } from '../session'
import { resourceFileIcon } from '../features/resources/icons'
import {
  DOCK_AREA_DIVIDER_SIZE,
  DOCK_DIVIDER_SIZE,
  firstLeaf,
  nodeTabCount,
  nodeTabIds,
  type DockLeaf,
  type DockNode,
} from '../features/workbench/layout'
import { DocumentNavigationTabs } from '../features/workbench/Dragging'
import { DocumentTabMenu, WorkbenchTabMenu } from '../features/workbench/Menu'
import {
  activeNavigationTabId,
  mergeNavigationTabOrder,
  reorderNavigationTabOrder,
  tabMatchesProject,
  tabVisibleInCurrentView,
  workbenchTabTitle,
  type TabKind,
} from '../features/workbench/tabs'
import {
  documentNavigationView,
  useDocumentWorkspace,
  useWorkspaceController,
} from '../features/workbench/workspace'

const NAVIGATION_AREAS_ID = 'navigation-areas'
const TASK_TAB_ID = 'workspace-task'
const TOPBAR_TRAILING_NAVIGATION_CLASS_NAME =
  'vds-top-bar-navigation-trailing !w-auto me-[var(--vds-top-bar-actions-width)]'

/** 标签种类 → 图标，保证同类标签视觉一致。 */
const TAB_ICONS: Record<
  Exclude<TabKind, 'overview' | 'literature' | 'new_tab' | 'library' | 'explorer'>,
  React.ComponentProps<typeof Icon>['name']
> = {
  projects: 'folder',
  browser: 'globe',
  literature_search: 'search',
  web_search: 'globe',
  review: 'edit-square',
  version_diff: 'rewind',
  file: 'doc',
} as const

function tabOrderInCurrentView(kind: TabKind, mainView: string): number {
  if (mainView === 'literature' && kind === 'literature') return -1
  return 0
}

/** 顶部标签栏：总览与文献中心常驻，其余按标签配置决定是否可关闭。 */
export function TabBar({
  trailing: tabAction,
  leading: leadingAction,
  actions,
  overflowTarget,
}: {
  trailing?: React.ReactNode
  leading?: React.ReactNode
  actions?: React.ReactNode
  overflowTarget?: HTMLElement | null
}): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const { t: conversation } = useTranslation('conversation')
  const { t: workbench } = useTranslation('workbench')
  const { t: literature } = useTranslation('literature')
  const { t: browser } = useTranslation('browser')
  const { t: assistant } = useTranslation('assistant')
  const [overflowScopes, setOverflowScopes] = React.useState<Record<string, boolean>>({})
  const overflowCallbacks = React.useRef(new Map<string, (next: boolean) => void>())
  const overflowReporter = (scope: string): ((next: boolean) => void) => {
    let callback = overflowCallbacks.current.get(scope)
    if (!callback) {
      callback = (next) =>
        setOverflowScopes((previous) =>
          previous[scope] === next ? previous : { ...previous, [scope]: next }
        )
      overflowCallbacks.current.set(scope, callback)
    }
    return callback
  }
  const taskTabActive = state.workbenchLayout.full && state.workbenchLayout.taskTab
  const taskTabs: NavigationTabItem[] = state.workbenchLayout.full
    ? [
        {
          id: TASK_TAB_ID,
          label: state.activeSession
            ? sessionDisplayTitle(activeThread(state), assistant) || assistant('panel.current')
            : assistant('panel.new'),
          icon: <MessageCircle size={16} strokeWidth={1.8} />,
          closable: false,
        },
      ]
    : []
  const navigationTabProps = (tab: NavigationTabItem): NavigationTabElementProps =>
    tab.id === TASK_TAB_ID
      ? { draggable: false, 'data-testid': 'workspace-task-tab' }
      : state.homeSelectedProjectId &&
          state.tabs.some((item) => item.id === tab.id && item.kind === 'library')
        ? { 'data-ob': PROJECT_GUIDE_ANCHORS.filesTab }
        : {}
  const workspace = useWorkspaceController()
  const documents = useDocumentWorkspace()
  const documentTabs: NavigationTabItem[] =
    state.mainView === 'resource' || state.mainView === 'literature'
      ? Object.values(documents.tabs).flatMap((tab) => {
          if (tab.embedded) return []
          const session = documents.sessions[tab.sessionId]
          if (!session) return []
          const ResourceIcon =
            session.source.kind === 'literature'
              ? fileIconForName(session.source.path)
              : resourceFileIcon(tab.title)
          return [
            {
              dirty: session.dirty,
              icon: <ResourceIcon size={16} strokeWidth={1.8} />,
              id: tab.id,
              label: documentDisplayTitle(tab, conversation, workbench),
            },
          ]
        })
      : []
  const workbenchTabs: NavigationTabItem[] = state.tabs
    .filter(availabilityPolicy.tabAvailable)

    .filter((tab) => tabMatchesProject(tab, state.homeSelectedProjectId))
    .filter((tab) => tabVisibleInCurrentView(tab.kind, state.mainView))
    .sort(
      (first, second) =>
        tabOrderInCurrentView(first.kind, state.mainView) -
        tabOrderInCurrentView(second.kind, state.mainView)
    )
    .flatMap((tab) => {
      if (tab.kind === 'overview') return []
      return [
        {
          closable: tab.kind === 'literature' ? false : tab.closable,
          icon:
            tab.kind === 'literature' ? (
              state.homeSelectedProjectId ? (
                <LibraryBig size={16} strokeWidth={1.8} />
              ) : (
                <LayoutDashboard size={16} strokeWidth={1.8} />
              )
            ) : tab.kind === 'new_tab' ? (
              <IconFont type="icon-shushen" />
            ) : tab.kind === 'library' ? (
              <Folders size={16} strokeWidth={1.8} />
            ) : tab.kind === 'explorer' ? (
              <FolderTree size={16} strokeWidth={1.8} />
            ) : (
              <Icon name={TAB_ICONS[tab.kind]} size={16} />
            ),
          id: tab.id,
          label:
            tab.kind === 'browser'
              ? browser('title')
              : tab.kind === 'literature'
                ? state.homeSelectedProjectId
                  ? t('chrome.projectLiterature')
                  : t('chrome.literatureOverview')
                : workbenchTabTitle(tab, literature, workbench),
        },
      ]
    })
  const [tabOrders, setTabOrders] = React.useState(new Map<string, string[]>())
  const orderScope = JSON.stringify([state.homeSelectedProjectId, state.mainView])
  const previousOrder = React.useMemo(
    () => tabOrders.get(orderScope) ?? [],
    [tabOrders, orderScope]
  )
  const navigationOrder = new Map(previousOrder.map((id, index) => [id, index]))
  workbenchTabs.sort(
    (first, second) =>
      (navigationOrder.get(first.id) ?? previousOrder.length) -
      (navigationOrder.get(second.id) ?? previousOrder.length)
  )
  const layoutOrder = new Map(
    [
      ...nodeTabIds(documents.layout.areas.primary),
      ...nodeTabIds(documents.layout.areas.secondary),
    ].map((id, index) => [id, index])
  )
  documentTabs.sort(
    (first, second) =>
      (layoutOrder.get(first.id) ?? layoutOrder.size) -
      (layoutOrder.get(second.id) ?? layoutOrder.size)
  )
  const orderedTabs = mergeNavigationTabOrder(previousOrder, [workbenchTabs, documentTabs])
  React.useLayoutEffect(() => {
    const ids = orderedTabs.map((tab) => tab.id)
    if (
      ids.length === previousOrder.length &&
      ids.every((id, index) => id === previousOrder[index])
    )
      return
    setTabOrders((current) => new Map(current).set(orderScope, ids))
  }, [orderScope, orderedTabs, previousOrder])
  const reorder = (ids: string[]): void => {
    setTabOrders((current) =>
      new Map(current).set(
        orderScope,
        reorderNavigationTabOrder(current.get(orderScope) ?? [], ids)
      )
    )
    set((current) => {
      const tabById = new Map(current.tabs.map((tab) => [tab.id, tab]))
      return {
        tabs: reorderNavigationTabOrder(
          current.tabs.map((tab) => tab.id),
          ids
        ).flatMap((id) => {
          const tab = tabById.get(id)
          return tab ? [tab] : []
        }),
      }
    })
  }
  const tabs = taskTabs.concat(orderedTabs)
  const focusedDocumentTabId = documents.focusedTabId
  const previousFocusedDocumentTabId = React.useRef(focusedDocumentTabId)
  const synchronizedResourceFile = React.useRef<{ tabId: string; path: string } | null>(null)
  React.useEffect(() => {
    const previousFocused = previousFocusedDocumentTabId.current
    previousFocusedDocumentTabId.current = focusedDocumentTabId
    if (!focusedDocumentTabId) return
    if (state.mainView !== 'resource' && state.mainView !== 'literature') return
    if (!documents.tabs[state.activeTab] && state.activeTab !== previousFocused) return
    const tab = documents.tabs[focusedDocumentTabId]
    const session = tab ? documents.sessions[tab.sessionId] : undefined
    if (!session) return
    const needsActivation =
      !state.aiPanel.cover &&
      (state.activeTab !== focusedDocumentTabId ||
        documentNavigationView(tab, session) !== state.mainView)
    if (needsActivation) act.activateTab(focusedDocumentTabId)
    if (
      session.source.kind === 'project' &&
      (needsActivation ||
        previousFocused !== focusedDocumentTabId ||
        synchronizedResourceFile.current?.tabId !== focusedDocumentTabId ||
        synchronizedResourceFile.current?.path !== session.source.path)
    ) {
      synchronizedResourceFile.current = { tabId: focusedDocumentTabId, path: session.source.path }
      act.selectResourceFile(session.source.path)
    }
  }, [
    focusedDocumentTabId,
    documents.tabs,
    documents.sessions,
    state.activeTab,
    state.mainView,
    state.aiPanel.cover,
    act,
  ])
  const documentTabIds = documentTabs.map((tab) => tab.id)
  const closableTabIds = tabs.filter((tab) => tab.closable !== false).map((tab) => tab.id)
  const fallbackTabId = workbenchTabs[0]?.id ?? documentTabs[0]?.id ?? state.activeTab
  const visibleTabIds = new Set(tabs.map((tab) => tab.id))
  const activeValue = activeNavigationTabId(
    state.activeTab,
    visibleTabIds,
    documents.focusedTabId,
    fallbackTabId,
    new Set(documentTabIds)
  )
  const activate = (id: string): void => {
    if (id === TASK_TAB_ID) {
      set((current) => ({
        workbenchLayout: changeProjectLayout(current.workbenchLayout, 'showTask'),
      }))
      return
    }
    if (taskTabActive) {
      set((current) => ({ workbenchLayout: { ...current.workbenchLayout, taskTab: false } }))
    }
    const documentTab = documents.tabs[id]
    if (documentTab) {
      const session = documents.sessions[documentTab.sessionId]
      if (session?.source.kind === 'project') act.selectResourceFile(session.source.path)
      act.activateTab(id)
      return
    }
    act.activateTab(id)
  }
  const close = (id: string): void => {
    if (documents.tabs[id]) {
      workspace.requestClose(id)
      return
    }
    act.closeWorkbenchTab(id)
  }

  const documentTabItem = (id: string): NavigationTabItem | null => {
    const tab = documents.tabs[id]
    if (!tab || tab.embedded) return null
    const session = documents.sessions[tab.sessionId]
    if (!session) return null
    const literature = session.source.kind === 'literature'
    const ResourceIcon = literature
      ? fileIconForName(session.source.path)
      : resourceFileIcon(tab.title)
    return {
      dirty: session.dirty,
      icon: <ResourceIcon size={16} strokeWidth={1.8} />,
      id: tab.id,
      label: documentDisplayTitle(tab, conversation, workbench),
    }
  }

  const renderPane = (
    content: React.JSX.Element,
    leaf: DockLeaf,
    leading: boolean,
    trailing: boolean
  ): React.JSX.Element =>
    !leadingAction && !actions ? (
      content
    ) : (
      <div
        className="flex h-full min-w-0 flex-1 overflow-hidden"
        data-navigation-leaf={leaf.id}
        data-navigation-leading={leading || undefined}
      >
        {leading && leadingAction}
        {content}
        {trailing && actions}
      </div>
    )

  const renderLeafTabs = (
    leaf: DockLeaf,
    leading: boolean,
    trailing: boolean
  ): React.JSX.Element => {
    const leafTabs = leaf.tabIds.flatMap((id) => {
      const item = documentTabItem(id)
      return item ? [item] : []
    })
    const tabs = leading
      ? taskTabs.concat(mergeNavigationTabOrder(previousOrder, [workbenchTabs, leafTabs]))
      : leafTabs
    const closableLeafTabIds = tabs.filter((tab) => tab.closable !== false).map((tab) => tab.id)
    const visibleIds = new Set([...tabs.map((tab) => tab.id)])
    const requestedId = leading ? state.activeTab : (leaf.activeTabId ?? state.activeTab)
    const value = activeNavigationTabId(
      requestedId,
      visibleIds,
      leaf.activeTabId,
      leading ? fallbackTabId : (leafTabs[0]?.id ?? requestedId),
      new Set(leafTabs.map((tab) => tab.id))
    )
    return renderPane(
      <DocumentNavigationTabs
        aria-label={leading ? t('tabs.opened') : t('tabs.rightOpened')}
        className={`min-w-0 flex-1 pl-[var(--vds-space-2)]${trailing ? (tabAction ? ' !flex-initial !me-0' : ` ${TOPBAR_TRAILING_NAVIGATION_CLASS_NAME}`) : ''}`}
        leaf={leaf}
        getTabProps={navigationTabProps}
        onClose={close}
        onOverflowChange={overflowReporter(`leaf:${leaf.id}`)}
        onReorder={reorder}
        onContextMenuOpen={activate}
        onValueChange={activate}
        overviewIcon={<MessageCircle size={16} strokeWidth={1.8} />}
        renderContextMenu={(tab) =>
          documents.tabs[tab.id] ? (
            <DocumentTabMenu tabId={tab.id} tabIds={leaf.tabIds} />
          ) : tab.closable !== false ? (
            <WorkbenchTabMenu tabId={tab.id} tabIds={closableLeafTabIds} />
          ) : null
        }
        showOverview={false}
        tabs={tabs}
        trailing={trailing ? tabAction : undefined}
        value={taskTabActive ? TASK_TAB_ID : value}
      />,
      leaf,
      leading,
      trailing
    )
  }

  const renderSplitTabs = (
    node: DockNode,
    leading: boolean,
    trailing: boolean,
    dividerSize = DOCK_DIVIDER_SIZE
  ): React.JSX.Element => {
    if (node.kind === 'leaf') return renderLeafTabs(node, leading, trailing)
    if (node.direction === 'vertical') {
      return renderSplitTabs(node.first, leading, trailing, dividerSize)
    }
    return (
      <div
        className="grid h-[var(--vds-workbench-header-height)] min-w-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: `minmax(0, ${node.ratio}fr) ${dividerSize}px minmax(0, ${1 - node.ratio}fr)`,
        }}
      >
        {renderSplitTabs(node.first, leading, false)}
        <div
          data-testid="navigation-split-divider"
          className="border-b border-[var(--vds-divider-default)] bg-[var(--vds-divider-default)]"
        />
        {renderSplitTabs(node.second, false, trailing)}
      </div>
    )
  }

  const primary = documents.layout.areas.primary
  const secondary = documents.layout.areas.secondary
  const currentRoot: DockNode =
    nodeTabCount(primary) && nodeTabCount(secondary)
      ? {
          kind: 'split',
          id: NAVIGATION_AREAS_ID,
          direction: 'horizontal',
          ratio: documents.layout.areaRatio,
          first: primary,
          second: secondary,
        }
      : nodeTabCount(secondary)
        ? secondary
        : primary
  const splitVisible =
    (state.mainView === 'resource' || state.mainView === 'literature') &&
    currentRoot.kind === 'split'

  const content = splitVisible
    ? renderSplitTabs(
        currentRoot,
        true,
        true,
        nodeTabCount(primary) && nodeTabCount(secondary)
          ? DOCK_AREA_DIVIDER_SIZE
          : DOCK_DIVIDER_SIZE
      )
    : renderPane(
        <DocumentNavigationTabs
          aria-label={t('tabs.opened')}
          className={
            tabAction
              ? 'pl-[var(--vds-space-2)] !flex-initial !me-0'
              : `pl-[var(--vds-space-2)] flex-1 ${TOPBAR_TRAILING_NAVIGATION_CLASS_NAME}`
          }
          leaf={currentRoot.kind === 'leaf' ? currentRoot : firstLeaf(currentRoot)}
          getTabProps={navigationTabProps}
          onClose={close}
          onOverflowChange={overflowReporter('main')}
          onReorder={reorder}
          onContextMenuOpen={activate}
          onValueChange={activate}
          overviewIcon={<MessageCircle size={16} strokeWidth={1.8} />}
          showOverview={false}
          tabs={tabs}
          trailing={tabAction}
          value={taskTabActive ? TASK_TAB_ID : activeValue}
          renderContextMenu={(tab) =>
            documents.tabs[tab.id] ? (
              <DocumentTabMenu tabId={tab.id} tabIds={documentTabIds} />
            ) : tab.closable !== false ? (
              <WorkbenchTabMenu tabId={tab.id} tabIds={closableTabIds} />
            ) : null
          }
        />,
        firstLeaf(currentRoot),
        true,
        true
      )
  const menu = Object.values(overflowScopes).some(Boolean) ? (
    <NavigationTabsMenu
      tabs={tabs}
      value={taskTabActive ? TASK_TAB_ID : activeValue}
      onValueChange={activate}
    />
  ) : null
  return (
    <>
      {content}
      {menu && (overflowTarget ? createPortal(menu, overflowTarget) : menu)}
    </>
  )
}
