import { sanitizeNavigationLocation, type NavigationLocation } from '../../navigation.ts'
import type { Actions, AppState } from './store'
import type { SessionNode } from './model'
import type { DocumentWorkspaceState } from './features/workbench/workspace'
import type { LiteratureSearchTask } from './contracts/literature'
import {
  FIXED_TAB_BY_VIEW,
  LITERATURE_RESULT_PREFIX,
  OVERVIEW_TAB,
  literatureResultTab,
  literatureSearchTab,
  parseReviewTab,
  parseVersionDiffTab,
  reviewTab,
  versionDiffTab,
  type WorkbenchTab
} from './features/workbench/tabs.ts'

export function openResourceTarget(
  actions: Pick<Actions, 'selectProject' | 'openWorkbenchView' | 'openResourceFile'>,
  target: { path: string; projectId?: string | null }
): void {
  if (target.projectId) actions.selectProject(target.projectId)
  actions.openWorkbenchView('resource')
  actions.openResourceFile(target.path, target.projectId)
}

export function captureNavigationLocation(
  state: AppState,
  projectId: string | null,
  documents: DocumentWorkspaceState
): NavigationLocation {
  const documentTab = documents.tabs[state.activeTab]
  const document = documentTab ? documents.sessions[documentTab.sessionId] : undefined
  const workbenchTab = state.tabs.find((tab) => tab.id === state.activeTab)
  const hasDocumentSurface = state.mainView === 'resource' || state.mainView === 'literature'
  return sanitizeNavigationLocation({
    view: state.mainView,
    projectId,
    sessionId: state.activeSession,
    sessionProjectId: state.activeSession
      ? state.projects.find((project) => project.path === state.threads[state.activeSession!]?.projectPath)?.id ?? null
      : null,
    settingsPage: state.accountSettingsPage,
    aiPanelOpen: state.aiPanel.open,
    aiPanelCover: state.aiPanel.cover,
    target: hasDocumentSurface && documentTab && document && !document.deleted
      ? { kind: 'document', source: document.source, title: documentTab.title, viewKind: documentTab.viewKind }
      : workbenchTab && workbenchTab.id !== OVERVIEW_TAB.id
        ? { kind: 'tab', id: workbenchTab.id }
        : null
  })!
}

export function resolveNavigationLocation(
  location: NavigationLocation,
  projects: readonly { id: string; path: string }[],
  lookup: (id: string) => Pick<SessionNode, 'id' | 'projectPath' | 'container' | 'openable'> | undefined
): NavigationLocation {
  const project = projects.find((candidate) => candidate.id === location.projectId)
  if (location.projectId && !project) {
    return { ...location, view: 'home', projectId: null, sessionId: null, sessionProjectId: null, target: null, aiPanelOpen: false, aiPanelCover: false }
  }
  const session = location.sessionId ? lookup(location.sessionId) : undefined
  const sessionProject = projects.find((candidate) => candidate.id === location.sessionProjectId)
  const validSession = session && !session.container && session.openable !== false
    && (!location.sessionProjectId || sessionProject)
    && (session.projectPath ?? null) === (sessionProject?.path ?? null)
  const source = location.target?.kind === 'document' ? location.target.source : null
  const sourceProject = source && 'project' in source ? source.project ?? null : location.projectId
  return {
    ...location,
    sessionId: validSession ? location.sessionId : null,
    sessionProjectId: validSession ? location.sessionProjectId : null,
    target: sourceProject === location.projectId ? location.target : null
  }
}

export function restoredWorkbenchTab(id: string, searches: readonly Pick<LiteratureSearchTask, 'id' | 'query'>[], projectId: string | null = null): WorkbenchTab | null {
  const fixed = Object.values(FIXED_TAB_BY_VIEW).find((tab) => tab.id === id)
  if (fixed) return fixed
  const search = searches.find((task) => literatureSearchTab(task.id, task.query).id === id)
  if (search) return literatureSearchTab(search.id, search.query, projectId)
  const review = parseReviewTab(id)
  if (review) return reviewTab(review.projectId, review.batchId, 0)
  const version = parseVersionDiffTab(id)
  if (version) return versionDiffTab(version)
  if (id.startsWith(LITERATURE_RESULT_PREFIX)) {
    try {
      const [sessionId, cardId] = id.slice(LITERATURE_RESULT_PREFIX.length).split('/').map(decodeURIComponent)
      if (sessionId && cardId) return literatureResultTab({ session_id: sessionId, card_id: cardId, title: '' })
    } catch {
      return null
    }
  }
  return null
}
