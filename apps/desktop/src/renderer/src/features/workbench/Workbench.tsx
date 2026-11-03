import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { featureRegistry } from '../../app/composition'
import { availabilityPolicy } from '../../app/policy'
import { Pending } from '../../shell/Pending'
import { useApp } from '../../store'
import { DocumentDock } from './Dock'
import {
  FIXED_TAB_BY_VIEW,
  synchronizeWorkbenchTab,
  tabMatchesProject,
  tabVisibleInCurrentView,
  viewerForPath,
} from './tabs'
import { documentNavigationView, useDocumentWorkspace } from './workspace'

export function Workbench(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { state, set } = useApp()
  const documents = useDocumentWorkspace()
  const visibleTabs = state.tabs.filter(
    (entry) =>
      availabilityPolicy.tabAvailable(entry) &&
      tabMatchesProject(entry, state.homeSelectedProjectId) &&
      tabVisibleInCurrentView(entry.kind, state.mainView)
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
  const activeTabNeedsSync = !activeTab && !documents.tabs[state.activeTab]
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

  if (documents.tabs[state.activeTab]) return <DocumentDock />
  if (activeTabNeedsSync && focusedDocument) return <DocumentDock />
  if (tab && !contributedViewActive && Object.keys(documents.tabs).length > 0) {
    return <DocumentDock />
  }
  if (!tab) return <></>
  if (!viewer) {
    return (
      <Pending
        feature={t('unavailable.tab')}
        owner={t('unavailable.workspace')}
        detail={t('unavailable.viewer', { kind })}
      />
    )
  }
  return <>{viewer.render({ active: true, path: tab?.id ?? '', tabId: tab?.id })}</>
}
