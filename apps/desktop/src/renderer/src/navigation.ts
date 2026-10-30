import { availabilityPolicy } from './app/policy.ts'
import {
  browserSettingsSection,
  HOME_LOCATION,
  MAIN_VIEWS,
  sanitizeNavigationLocation,
  type AccountSettingsPage,
  type BrowserSettingsSection,
  type NavigationLocation,
} from '../../navigation.ts'
import type { Actions, AppState } from './store'
import type { SessionNode } from './model'
import type { DocumentWorkspaceState } from './features/workbench/workspace'
import type { LiteratureSearchTask } from './contracts/literature'
import {
  FIXED_TAB_BY_VIEW,
  fixedTabForView,
  LITERATURE_RESULT_PREFIX,
  OVERVIEW_TAB,
  literatureResultTab,
  literatureSearchTab,
  projectLibraryNavigation,
  parseReviewTab,
  parseVersionDiffTab,
  reviewTab,
  versionDiffTab,
  type WorkbenchTab,
} from './features/workbench/tabs.ts'

const NAVIGATION_ACTIONS = {
  unattributed: 'unattributed',
  restore: 'startup',
  workbench: 'action',
  project: 'action',
  tab: 'action',
  result: 'action',
  search: 'action',
  comparison: 'action',
  'file-preview': 'async',
  review: 'async',
  'literature-item': 'async',
  'close-tab': 'async',
  'host-scene': 'host',
} as const
const NAVIGATION_TAB_KINDS = [
  'overview',
  'library',
  'explorer',
  'projects',
  'browser',
  'literature',
  'literature_search',
  'web_search',
  'review',
  'version_diff',
  'file',
] as const
export type NavigationAction = keyof typeof NAVIGATION_ACTIONS
export interface NavigationCause {
  action: NavigationAction
  request?: number
  startedGeneration?: number
}
interface NavigationProjection {
  view: string
  tabKind: string
}
export interface NavigationObservation {
  sequence: number
  generation: number
  action: NavigationAction
  request: number | null
  startedGeneration: number | null
  evaluatedUpdates?: number
  before: NavigationProjection
  after: NavigationProjection
  projectChanged: boolean
  focusChanged: boolean
  settingsChanged: boolean
  navigationRestored: boolean
}
interface NavigationObservedState {
  mainView: string
  activeTab: string
  homeSelectedProjectId: string | null
  accountSettingsPage: string | null
  browserSettingsSection: string | null
  navigationRestored: boolean
  tabs: readonly { id: string; kind: string }[]
  navigationObservation?: NavigationObservation
}

function navigationProjection(state: NavigationObservedState): NavigationProjection {
  const kind = state.tabs.find((tab) => tab.id === state.activeTab)?.kind
  return {
    view: (MAIN_VIEWS as readonly string[]).includes(state.mainView) ? state.mainView : 'unknown',
    tabKind: kind && (NAVIGATION_TAB_KINDS as readonly string[]).includes(kind) ? kind : 'unknown',
  }
}

function diagnosticInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function observeNavigation<State extends NavigationObservedState>(
  current: State,
  next: State,
  cause?: NavigationCause
): State & { navigationObservation?: NavigationObservation } {
  const projectChanged = current.homeSelectedProjectId !== next.homeSelectedProjectId
  const focusChanged = current.activeTab !== next.activeTab
  const settingsChanged =
    current.accountSettingsPage !== next.accountSettingsPage ||
    current.browserSettingsSection !== next.browserSettingsSection
  const changed =
    projectChanged || focusChanged || settingsChanged || current.mainView !== next.mainView
  if (!changed)
    return next.navigationObservation === current.navigationObservation
      ? next
      : { ...next, navigationObservation: current.navigationObservation }
  const action =
    cause && Object.prototype.hasOwnProperty.call(NAVIGATION_ACTIONS, cause.action)
      ? cause.action
      : 'unattributed'
  return {
    ...next,
    navigationObservation: {
      sequence: (current.navigationObservation?.sequence ?? 0) + 1,
      generation: (current.navigationObservation?.generation ?? 0) + 1,
      action,
      request: diagnosticInteger(cause?.request),
      startedGeneration: diagnosticInteger(cause?.startedGeneration),
      before: navigationProjection(current),
      after: navigationProjection(next),
      projectChanged,
      focusChanged,
      settingsChanged,
      navigationRestored: next.navigationRestored,
    },
  }
}

export function navigationAttempt(
  state: NavigationObservedState,
  cause: NavigationCause
): NavigationObservation {
  return {
    sequence: state.navigationObservation?.sequence ?? 0,
    generation: state.navigationObservation?.generation ?? 0,
    action: cause.action,
    request: diagnosticInteger(cause.request),
    startedGeneration: diagnosticInteger(cause.startedGeneration),
    before: navigationProjection(state),
    after: navigationProjection(state),
    projectChanged: false,
    focusChanged: false,
    settingsChanged: false,
    navigationRestored: state.navigationRestored,
  }
}

export function navigationDiagnostic(
  observation: NavigationObservation,
  stage: 'started' | 'committed' | 'fence-rejected'
): string {
  const action = Object.prototype.hasOwnProperty.call(NAVIGATION_ACTIONS, observation.action)
    ? observation.action
    : 'unattributed'
  const projection = (value: NavigationProjection): NavigationProjection => ({
    view: (MAIN_VIEWS as readonly string[]).includes(value.view) ? value.view : 'unknown',
    tabKind: (NAVIGATION_TAB_KINDS as readonly string[]).includes(value.tabKind)
      ? value.tabKind
      : 'unknown',
  })
  return JSON.stringify({
    stage,
    sequence: diagnosticInteger(observation.sequence),
    generation: diagnosticInteger(observation.generation),
    source: NAVIGATION_ACTIONS[action],
    action,
    request: diagnosticInteger(observation.request),
    startedGeneration: diagnosticInteger(observation.startedGeneration),
    before: projection(observation.before),
    after: projection(observation.after),
    evaluatedUpdates: diagnosticInteger(observation.evaluatedUpdates ?? 1),
    projectChanged: observation.projectChanged === true,
    focusChanged: observation.focusChanged === true,
    settingsChanged: observation.settingsChanged === true,
    navigationRestored: observation.navigationRestored === true,
  })
}

export class NavigationCommit {
  private sequence = 0
  private previous: NavigationProjection | undefined

  constructor(initial?: NavigationObservation) {
    this.previous = initial?.after
  }

  record(observation: NavigationObservation | undefined): string | null {
    if (!observation || observation.sequence <= this.sequence) return null
    const after = observation.after
    const entry = {
      ...observation,
      before: this.previous ?? observation.before,
      after,
      evaluatedUpdates: observation.sequence - this.sequence,
    }
    this.sequence = observation.sequence
    this.previous = after
    return navigationDiagnostic(entry, 'committed')
  }
}

export class SettingsSurface {
  private epoch = 0
  private page: AccountSettingsPage | null = null
  private section: BrowserSettingsSection | null = null
  private current: () => boolean = () => this.epoch === 0

  constructor(private readonly browserEnabled: boolean) {}

  project(patch: {
    accountSettingsPage?: AccountSettingsPage | null
    browserSettingsSection?: unknown
  }): {
    accountSettingsPage: AccountSettingsPage | null
    browserSettingsSection: BrowserSettingsSection | null
  } {
    const requested =
      patch.accountSettingsPage === undefined ? this.page : patch.accountSettingsPage
    const page = requested === 'browser' && !this.browserEnabled ? this.page : requested
    const section = browserSettingsSection(
      page,
      'browserSettingsSection' in patch
        ? patch.browserSettingsSection
        : patch.accountSettingsPage !== undefined
          ? undefined
          : this.section
    )
    if (page !== this.page || section !== this.section) {
      this.epoch += 1
      const epoch = this.epoch
      this.current = () => epoch === this.epoch
    }
    this.page = page
    this.section = section
    return { accountSettingsPage: page, browserSettingsSection: section }
  }

  capture(): () => boolean {
    return this.current
  }
}

export function openResourceTarget(
  actions: Pick<Actions, 'selectProject' | 'openWorkbenchView' | 'openResourceFile'>,
  target: { path: string; projectId?: string | null }
): void {
  if (target.projectId) actions.selectProject(target.projectId)
  actions.openWorkbenchView('resource')
  actions.openResourceFile(target.path, target.projectId)
}

export function openSessionTarget(
  actions: Pick<Actions, 'selectProject' | 'openWorkbenchView' | 'openPanelSession'>,
  target: SessionNode,
  projects: readonly { id: string; path: string }[],
  focus?: Parameters<Actions['openPanelSession']>[1]
): boolean {
  if (target.container || target.openable === false) return false
  const project = projects.find((candidate) => candidate.path === target.projectPath)
  if (project) {
    actions.selectProject(project.id)
    actions.openWorkbenchView('resource')
  } else if (!target.projectPath) {
    actions.openWorkbenchView('literature')
  } else {
    return false
  }
  actions.openPanelSession(target, focus)
  return true
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
      ? (state.projects.find(
          (project) => project.path === state.threads[state.activeSession!]?.projectPath
        )?.id ?? null)
      : null,
    settingsPage: state.accountSettingsPage,
    browserSettingsSection: state.browserSettingsSection,
    aiPanelOpen: state.aiPanel.open,
    aiPanelCover: state.aiPanel.cover,
    target:
      hasDocumentSurface && documentTab && document && !document.deleted
        ? {
            kind: 'document',
            source: document.source,
            title: documentTab.title,
            viewKind: documentTab.viewKind,
          }
        : workbenchTab && workbenchTab.id !== OVERVIEW_TAB.id
          ? { kind: 'tab', id: workbenchTab.id }
          : null,
  })!
}

export function resolveNavigationLocation(
  location: NavigationLocation,
  projects: readonly { id: string; path: string }[],
  lookup: (
    id: string
  ) => Pick<SessionNode, 'id' | 'projectPath' | 'container' | 'openable'> | undefined
): NavigationLocation {
  location = availabilityPolicy.navigationLocation(location)
  const project = projects.find((candidate) => candidate.id === location.projectId)
  if (location.projectId && !project) {
    return HOME_LOCATION
  }
  const session = location.sessionId ? lookup(location.sessionId) : undefined
  const sessionProject = projects.find((candidate) => candidate.id === location.sessionProjectId)
  const validSession =
    session &&
    !session.container &&
    session.openable !== false &&
    (!location.sessionProjectId || sessionProject) &&
    (session.projectPath ?? null) === (sessionProject?.path ?? null)
  const source = location.target?.kind === 'document' ? location.target.source : null
  const sourceProject =
    source && 'project' in source ? (source.project ?? null) : location.projectId
  if ((location.sessionId && !validSession) || sourceProject !== location.projectId)
    return HOME_LOCATION
  return {
    ...location,
    sessionId: validSession ? location.sessionId : null,
    sessionProjectId: validSession ? location.sessionProjectId : null,
    target: sourceProject === location.projectId ? location.target : null,
  }
}

export function restoredWorkbenchTab(
  id: string,
  searches: readonly Pick<LiteratureSearchTask, 'id' | 'query'>[],
  projectId: string | null = null
): WorkbenchTab | null {
  if (!availabilityPolicy.tabIdAvailable(id)) return null
  if (projectId) {
    const navigation = projectLibraryNavigation([], projectId)
    if (id === navigation.activeTab) return navigation.tabs[0]
  }
  const fixed = Object.values(FIXED_TAB_BY_VIEW).find((tab) => tab.id === id)
  if (fixed) return fixedTabForView(fixed.kind) ?? null
  const search = searches.find((task) => literatureSearchTab(task.id, task.query).id === id)
  if (search) return literatureSearchTab(search.id, search.query, projectId)
  const review = parseReviewTab(id)
  if (review) return reviewTab(review.projectId, review.batchId, 0)
  const version = parseVersionDiffTab(id)
  if (version) return versionDiffTab(version)
  if (id.startsWith(LITERATURE_RESULT_PREFIX)) {
    try {
      const [sessionId, cardId] = id
        .slice(LITERATURE_RESULT_PREFIX.length)
        .split('/')
        .map(decodeURIComponent)
      if (sessionId && cardId)
        return literatureResultTab({ session_id: sessionId, card_id: cardId, title: '' })
    } catch {
      return null
    }
  }
  return null
}
