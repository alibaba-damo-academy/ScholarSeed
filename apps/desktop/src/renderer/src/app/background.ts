import {
  TRAY_ACTION,
  TRAY_RECENT_LIMIT,
  type TrayNavigation,
  type TraySnapshot,
} from '../../../tray.ts'
import type {
  listProjects,
  listSessions,
  readNavigationSession,
  readAttentionNavigation,
} from '../api'
import { openSessionTarget } from '../navigation.ts'
import type { Actions, AppState } from '../store'
import { findSessionNode } from '../tree.ts'
import { sessionTitleFallback } from '../session.ts'

interface BackgroundReaders {
  projects: typeof listProjects
  sessions: typeof listSessions
  session: typeof readNavigationSession
  attention: typeof readAttentionNavigation
}

type BackgroundActions = Pick<
  Actions,
  'selectProject' | 'openWorkbenchView' | 'openPanelSession' | 'startPanelDraft'
>

export class BackgroundNavigation {
  private generation = 0

  begin(): () => boolean {
    const generation = ++this.generation
    return () => generation === this.generation
  }

  invalidate(): void {
    this.generation += 1
  }
}

export async function navigateAttention(
  id: string,
  readers: Pick<BackgroundReaders, 'projects' | 'attention'>,
  actions: Pick<
    Actions,
    'selectProject' | 'openWorkbenchView' | 'openPanelSession' | 'openSettings'
  >,
  context: () => Pick<AppState, 'projects' | 'sessions'>,
  publish: (projects: AppState['projects']) => void,
  current: () => boolean
): Promise<boolean> {
  if (!current()) return false
  const opened = await readers.attention(id)
  if (!current() || !opened) return false
  const latest = context()
  const known = findSessionNode(latest.sessions, opened.session_id)
  const session = {
    ...known,
    id: opened.session_id,
    title: opened.title,
    title_fallback: sessionTitleFallback(opened.title_fallback),
    workdir: opened.runtime_workdir,
    projectPath: opened.project_path,
    runtimeId: opened.runtime_id,
    status: known?.status ?? (opened.running ? ('running' as const) : ('dormant' as const)),
    tone: known?.tone ?? ('experience' as const),
    openable: true,
  }
  let projects = latest.projects
  if (session.projectPath && !projects.some((project) => project.path === session.projectPath)) {
    const listing = await readers.projects()
    if (!current()) return false
    if (listing) {
      projects = listing.projects
      publish(projects)
    }
  }
  const openedTarget = openSessionTarget(actions, session, projects, {
    requestId: opened.focus.request_id,
    turnId: opened.focus.turn_id,
    itemId: opened.focus.item_id,
    incidentId: opened.focus.incident_id,
    kind: opened.focus.kind,
  })
  if (openedTarget) actions.openSettings(null)
  return openedTarget
}

export async function loadTraySnapshot(
  projectId: string | null,
  readers: Pick<BackgroundReaders, 'projects' | 'sessions'>,
  title: (session: { title: string; title_fallback?: 'new_session' | null }) => string
): Promise<TraySnapshot | null> {
  const listing = await readers.projects()
  if (!listing) return null
  const project = listing.projects.find(
    (entry) => entry.id === projectId && entry.available !== false && entry.archived_at == null
  )
  if (!project) return { project: null, sessions: [] }
  const sessions = await readers.sessions({
    scope: 'project',
    projectPath: project.path,
    limit: TRAY_RECENT_LIMIT,
  })
  if (!sessions) return null
  return {
    project: { id: project.id, name: project.name },
    sessions: sessions
      .filter((session) => session.project_path === project.path)
      .sort(
        (left, right) =>
          (right.mtime ?? right.created_at ?? 0) - (left.mtime ?? left.created_at ?? 0) ||
          left.session_id.localeCompare(right.session_id)
      )
      .slice(0, TRAY_RECENT_LIMIT)
      .map((session) => ({ id: session.session_id, title: title(session) })),
  }
}

export async function navigateTray(
  target: TrayNavigation,
  readers: Pick<BackgroundReaders, 'projects' | 'session'>,
  actions: BackgroundActions,
  publish: (projects: NonNullable<Awaited<ReturnType<typeof listProjects>>>['projects']) => void,
  current: () => boolean
): Promise<boolean> {
  if (!current()) return false
  if (target.kind === TRAY_ACTION.literature) {
    actions.openWorkbenchView('literature')
    return true
  }
  const listing = await readers.projects()
  if (!current() || !listing) return false
  const project = listing.projects.find(
    (entry) =>
      entry.id === target.projectId && entry.available !== false && entry.archived_at == null
  )
  if (!project) return false
  if (target.kind === TRAY_ACTION.session) {
    const opened = await readers.session(target.sessionId)
    if (!current() || !opened.session_id || opened.project_path !== project.path) return false
    publish(listing.projects)
    return openSessionTarget(
      actions,
      {
        id: opened.session_id,
        title: opened.title,
        title_fallback: opened.title_fallback,
        workdir: opened.runtime_workdir,
        projectPath: opened.project_path,
        runtimeId: opened.runtime_id,
        status: opened.running ? 'running' : 'dormant',
        tone: 'experience',
        openable: true,
      },
      listing.projects
    )
  }
  publish(listing.projects)
  actions.selectProject(project.id)
  actions.openWorkbenchView('resource')
  if (target.kind === TRAY_ACTION.create)
    actions.startPanelDraft({ projectId: project.id, projectLocked: true })
  return true
}
