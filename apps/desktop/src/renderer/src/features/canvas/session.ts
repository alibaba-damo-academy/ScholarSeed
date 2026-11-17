import { changeProjectLayout, type ProjectLayout } from '../../../../layout.ts'
import {
  OVERVIEW_TAB,
  tabMatchesProject,
  workbenchTabVisible,
  type WorkbenchTab,
} from '../workbench/tabs.ts'

interface CanvasWorkbenchState {
  activeSession: string | null
  activeTab: string
  mainView: string
  homeSelectedProjectId: string | null
  tabs: WorkbenchTab[]
  workbenchLayout: ProjectLayout
  aiPanel: { cover: boolean }
}

export function followCanvasSession<State extends CanvasWorkbenchState>(
  current: State,
  next: State
): State {
  if (current.activeSession === next.activeSession) return next

  const leavingTab = current.tabs.find(
    (tab) =>
      tab.canvasSessionId === current.activeSession &&
      tab.id === current.activeTab &&
      tabMatchesProject(tab, current.homeSelectedProjectId) &&
      workbenchTabVisible(tab, current.mainView, current.activeSession)
  )
  const tabs = next.tabs.map((tab) => {
    if (!current.activeSession || tab.canvasSessionId !== current.activeSession) return tab
    const restoreCanvas = tab.id === leavingTab?.id && current.workbenchLayout.open
    return Boolean(tab.restoreCanvas) === restoreCanvas ? tab : { ...tab, restoreCanvas }
  })
  const followingTab =
    next.activeSession &&
    next.activeTab === current.activeTab &&
    (next.mainView === 'resource' || next.mainView === 'conversation')
      ? tabs.find(
          (tab) =>
            tab.canvasSessionId === next.activeSession &&
            tab.restoreCanvas &&
            tabMatchesProject(tab, next.homeSelectedProjectId)
        )
      : undefined
  if (followingTab) {
    return {
      ...next,
      tabs,
      activeTab: followingTab.id,
      mainView: 'resource',
      workbenchLayout: changeProjectLayout(next.workbenchLayout, 'revealConversation'),
      aiPanel: { ...next.aiPanel, cover: false },
    }
  }
  if (!leavingTab || next.activeTab !== leavingTab.id) return { ...next, tabs }
  return {
    ...next,
    tabs,
    activeTab: OVERVIEW_TAB.id,
    workbenchLayout: next.workbenchLayout.open
      ? changeProjectLayout(next.workbenchLayout, 'toggleWorkspace')
      : next.workbenchLayout,
    aiPanel:
      next.activeSession && !next.homeSelectedProjectId
        ? { ...next.aiPanel, cover: true }
        : next.aiPanel,
  }
}
