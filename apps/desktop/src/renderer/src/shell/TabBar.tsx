import { documentDisplayTitle } from '../delivery'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, LibraryBig } from 'lucide-react'

import { type NavigationTabItem } from '../components/ui'
import { fileIconForName } from '../components/primitive'
import { Icon } from '../icons'
import { useApp } from '../store'
import { resourceFileIcon } from '../features/resources/icons'
import { firstLeaf, nodeTabCount, type DockLeaf, type DockNode } from '../features/workbench/layout'
import { DocumentNavigationTabs } from '../features/workbench/Dragging'
import { DocumentTabMenu } from '../features/workbench/Menu'
import {
  activeNavigationTabId,
  tabMatchesProject,
  tabVisibleInCurrentView,
  OVERVIEW_TAB,
  workbenchTabTitle,
  type TabKind
} from '../features/workbench/tabs'
import { documentNavigationView, useDocumentWorkspace, useWorkspaceController } from '../features/workbench/workspace'

const NAVIGATION_AREAS_ID = 'navigation-areas'
const TOPBAR_TRAILING_NAVIGATION_CLASS_NAME =
  'vds-top-bar-navigation-trailing box-border pe-[var(--vds-top-bar-actions-width,0px)]'

/** 标签种类 → 图标，保证同类标签视觉一致。 */
const TAB_ICONS: Record<Exclude<TabKind, 'overview' | 'literature'>, React.ComponentProps<typeof Icon>['name']> = {
  projects: 'folder',
  literature_search: 'search',
  web_search: 'globe',
  review: 'edit-square',
  version_diff: 'rewind',
  file: 'doc'
} as const

function tabOrderInCurrentView(kind: TabKind, mainView: string): number {
  if (mainView === 'literature' && kind === 'literature') return -1
  return 0
}

/** 顶部标签栏：总览与文献全览常驻，其余按标签配置决定是否可关闭。 */
export function TabBar(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const { t: conversation } = useTranslation('conversation')
  const { t: workbench } = useTranslation('workbench')
  const { t: literature } = useTranslation('literature')
  const workspace = useWorkspaceController()
  const documents = useDocumentWorkspace()
  const documentTabs: NavigationTabItem[] = state.mainView === 'resource' || state.mainView === 'literature'
    ? Object.values(documents.tabs).filter(tab => {
        const session = documents.sessions[tab.sessionId]
        return session && documentNavigationView(tab, session) === state.mainView
      }).map((tab) => {
        const source = documents.sessions[tab.sessionId]?.source
        const ResourceIcon = source?.kind === 'literature'
          ? fileIconForName(source.path)
          : resourceFileIcon(tab.title)
        return {
          dirty: documents.sessions[tab.sessionId]?.dirty === true,
          icon: <ResourceIcon size={13} strokeWidth={1.8} />,
          id: tab.id,
          label: documentDisplayTitle(tab, conversation, workbench)
        }
      })
    : []
  const workbenchTabs: NavigationTabItem[] = state.tabs
    .filter((tab) => tabMatchesProject(tab, state.homeSelectedProjectId))
    .filter((tab) => tabVisibleInCurrentView(tab.kind, state.mainView))
    .sort((first, second) => tabOrderInCurrentView(first.kind, state.mainView) - tabOrderInCurrentView(second.kind, state.mainView))
    .flatMap((tab) => {
      if (tab.kind === 'overview') return []
      return [{
        closable: tab.kind === 'literature' ? false : tab.closable,
        icon: tab.kind === 'literature'
          ? state.homeSelectedProjectId
            ? <LibraryBig size={13} strokeWidth={1.8} />
            : <LayoutDashboard size={13} strokeWidth={1.8} />
          : <Icon name={TAB_ICONS[tab.kind]} size={13} />,
        id: tab.id,
        label: tab.kind === 'literature' ? (state.homeSelectedProjectId ? t('chrome.projectLiterature') : t('chrome.literatureOverview')) : workbenchTabTitle(tab, literature, workbench)
      }]
    })
  const tabs = workbenchTabs.concat(documentTabs)
  const focusedDocumentTabId = documents.focusedTabId
  React.useEffect(() => {
    if (!focusedDocumentTabId) return
    const session = documents.sessions[documents.tabs[focusedDocumentTabId]?.sessionId]
    if (session?.source.kind === 'project') act.selectResourceFile(session.source.path)
  }, [focusedDocumentTabId])
  const documentTabIds = documentTabs.map((tab) => tab.id)
  const showOverview = state.mainView !== 'literature' || Boolean(state.homeSelectedProjectId)
  const fallbackTabId = showOverview
    ? OVERVIEW_TAB.id
    : workbenchTabs[0]?.id ?? documentTabs[0]?.id ?? state.activeTab
  const visibleTabIds = new Set([
    ...(showOverview ? [OVERVIEW_TAB.id] : []),
    ...tabs.map((tab) => tab.id)
  ])
  const activeValue = activeNavigationTabId(
    state.activeTab,
    visibleTabIds,
    documents.focusedTabId,
    fallbackTabId
  )
  const activate = (id: string): void => {
    const documentTab = documents.tabs[id]
    if (documentTab) {
      workspace.focusTab(id)
      const session = documents.sessions[documentTab.sessionId]
      if (session?.source.kind === 'project') act.selectResourceFile(session.source.path)
      set((current) => ({ ...current, mainView: session ? documentNavigationView(documentTab, session) : 'resource', activeTab: id }))
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
    if (!tab) return null
    const session = documents.sessions[tab.sessionId]
    if (!session) return null
    const literature = session.source.kind === 'literature'
    if (documentNavigationView(tab, session) !== state.mainView) return null
    const ResourceIcon = literature
      ? fileIconForName(session.source.path)
      : resourceFileIcon(tab.title)
    return {
      dirty: session.dirty,
      icon: <ResourceIcon size={13} strokeWidth={1.8} />,
      id: tab.id,
      label: documentDisplayTitle(tab, conversation, workbench)
    }
  }

  const renderLeafTabs = (leaf: DockLeaf, leading: boolean, trailing: boolean): React.JSX.Element => {
    const leafTabs = leaf.tabIds.flatMap((id) => {
      const item = documentTabItem(id)
      return item ? [item] : []
    })
    const tabs = leading ? workbenchTabs.concat(leafTabs) : leafTabs
    const visibleIds = new Set([
      ...(leading && showOverview ? [OVERVIEW_TAB.id] : []),
      ...tabs.map((tab) => tab.id)
    ])
    const requestedId = leading ? state.activeTab : leaf.activeTabId ?? state.activeTab
    const value = activeNavigationTabId(
      requestedId,
      visibleIds,
      leaf.activeTabId,
      leading ? fallbackTabId : leafTabs[0]?.id ?? requestedId
    )
    return (
      <DocumentNavigationTabs
        aria-label={leading ? t('tabs.opened') : t('tabs.rightOpened')}
        className={`min-w-0 flex-1${trailing ? ` ${TOPBAR_TRAILING_NAVIGATION_CLASS_NAME}` : ''}`}
        leaf={leaf}
        onClose={close}
        onContextMenuOpen={activate}
        onValueChange={activate}
        overviewIcon={<LayoutDashboard size={13} strokeWidth={1.8} />}
        renderContextMenu={(tab) => documents.tabs[tab.id]
          ? <DocumentTabMenu tabId={tab.id} tabIds={leaf.tabIds} />
          : null}
        showOverview={leading && showOverview}
        tabs={tabs}
        value={value}
      />
    )
  }

  const renderSplitTabs = (node: DockNode, leading: boolean, trailing: boolean): React.JSX.Element => {
    if (node.kind === 'leaf') return renderLeafTabs(node, leading, trailing)
    if (node.direction === 'vertical') {
      return renderSplitTabs(node.first, leading, trailing)
    }
    return (
      <div
        className="grid h-12 min-w-0 flex-1 overflow-hidden"
        style={{ gridTemplateColumns: `${node.ratio}fr 5px ${1 - node.ratio}fr` }}
      >
        {renderSplitTabs(node.first, leading, false)}
        <div data-testid="navigation-split-divider" className="border-b border-[var(--vds-border-default)] bg-[var(--vds-divider-default)]" />
        {renderSplitTabs(node.second, false, trailing)}
      </div>
    )
  }

  const primary = documents.layout.areas.primary
  const secondary = documents.layout.areas.secondary
  const currentRoot: DockNode = nodeTabCount(primary) && nodeTabCount(secondary)
    ? { kind: 'split', id: NAVIGATION_AREAS_ID, direction: 'horizontal', ratio: documents.layout.areaRatio, first: primary, second: secondary }
    : nodeTabCount(secondary) ? secondary : primary
  const splitVisible = (state.mainView === 'resource' || state.mainView === 'literature')
    && currentRoot.kind === 'split'

  return splitVisible ? renderSplitTabs(currentRoot, true, true) : (
    <DocumentNavigationTabs
      aria-label={t('tabs.opened')}
      className={`flex-1 ${TOPBAR_TRAILING_NAVIGATION_CLASS_NAME}`}
      leaf={currentRoot.kind === 'leaf' ? currentRoot : firstLeaf(currentRoot)}
      onClose={close}
      onContextMenuOpen={activate}
      onValueChange={activate}
      overviewIcon={<LayoutDashboard size={13} strokeWidth={1.8} />}
      showOverview={showOverview}
      tabs={tabs}
      value={activeValue}
      renderContextMenu={(tab) => documents.tabs[tab.id]
        ? <DocumentTabMenu tabId={tab.id} tabIds={documentTabIds} />
        : null}
    />
  )
}
