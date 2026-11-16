import React, { useEffect, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { featureRegistry } from '../../app/composition'
import { availabilityPolicy } from '../../app/policy'
import { Pending } from '../../shell/Pending'
import { useApp } from '../../store'
import { DocumentDock } from './Dock'
import {
  FIXED_TAB_BY_VIEW,
  OVERVIEW_TAB,
  synchronizeWorkbenchTab,
  tabMatchesProject,
  workbenchTabVisible,
  viewerForPath,
} from './tabs'
import { documentNavigationView, useDocumentWorkspace, useWorkspaceController } from './workspace'

export function Workbench(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { state, set } = useApp()
  const documents = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const pageTabs = state.tabs.filter((tab) => {
    const dockable = featureRegistry.viewers.get(tab.kind)?.dockable
    return (
      availabilityPolicy.tabAvailable(tab) &&
      tabMatchesProject(tab, state.homeSelectedProjectId) &&
      (typeof dockable === 'function' ? dockable(tab.id) : dockable)
    )
  })
  const pageIds = JSON.stringify(pageTabs.map((tab) => tab.id))
  useLayoutEffect(() => {
    const ids: string[] = JSON.parse(pageIds)
    workspace.synchronizePageTabs(ids)
    if (ids.includes(state.activeTab)) workspace.focusTab(state.activeTab)
    else if (workspace.getSnapshot().tabs[state.activeTab]) {
      if (workspace.getSnapshot().tabs[state.activeTab].embedded)
        workspace.setTabEmbedded(state.activeTab, false)
      workspace.focusTab(state.activeTab)
    }
  }, [workspace, pageIds, state.activeTab])
  const visibleTabs = state.tabs.filter(
    (entry) =>
      availabilityPolicy.tabAvailable(entry) &&
      tabMatchesProject(entry, state.homeSelectedProjectId) &&
      workbenchTabVisible(entry, state.mainView, state.activeSession)
  )
  const activeTab = visibleTabs.find((entry) => entry.id === state.activeTab)
  const focusedTab = documents.focusedTabId ? documents.tabs[documents.focusedTabId] : undefined
  const focusedSession = focusedTab ? documents.sessions[focusedTab.sessionId] : undefined
  const focusedDocument =
    focusedTab &&
    focusedSession &&
    documentNavigationView(focusedTab, focusedSession) === state.mainView
      ? focusedTab
      : undefined
  const fixedTab = visibleTabs.find((entry) => entry.id === FIXED_TAB_BY_VIEW[state.mainView]?.id)
  const fallbackTab = fixedTab ?? visibleTabs[0]
  const fallbackTabId = focusedDocument?.id ?? fallbackTab?.id
  const closedProjectWorkbench =
    state.homeSelectedProjectId &&
    !state.workbenchLayout.open &&
    state.activeTab === OVERVIEW_TAB.id
  const activeTabNeedsSync =
    !closedProjectWorkbench && !activeTab && !documents.tabs[state.activeTab]
  const tab = activeTab ?? (activeTabNeedsSync && !focusedDocument ? fallbackTab : undefined)
  const kind = tab?.kind === 'file' ? viewerForPath(tab.id) : (tab?.kind ?? 'new_tab')
  const viewer = featureRegistry.viewers.get(kind)
  const contributedViewActive = Boolean(tab && tab.kind !== 'file' && viewer)
  useEffect(() => {
    if (!activeTabNeedsSync || !fallbackTabId) return
    set((current) => synchronizeWorkbenchTab(current, state, fallbackTabId))
  }, [
    activeTabNeedsSync,
    fallbackTabId,
    state.homeSelectedProjectId,
    state.mainView,
    state.activeTab,
    set,
  ])

  const dockActive = Boolean(
    documents.tabs[state.activeTab] ||
    pageTabs.some((page) => page.id === state.activeTab) ||
    (activeTabNeedsSync && focusedDocument) ||
    (tab && !contributedViewActive && Object.keys(documents.tabs).length > 0)
  )
  const retainDock = tab?.kind === 'browser' && pageTabs.some((page) => visibleTabs.includes(page))

  return (
    <>
      {(dockActive || retainDock) && <DocumentDock hidden={!dockActive} />}
      {!dockActive &&
        tab &&
        (viewer ? (
          viewer.render({ active: true, path: tab.id, tabId: tab.id })
        ) : (
          <Pending
            feature={t('unavailable.tab')}
            owner={t('unavailable.workspace')}
            detail={t('unavailable.viewer', { kind })}
          />
        ))}
    </>
  )
}
