import type { TFunction } from 'i18next'
import type { createFormatters } from '../../localization/format'

/** Catalog title provenance is distinct from context-reference label provenance. */
export type SessionTitleFallback = 'new_session' | null
export const CANONICAL_NEW_SESSION_TITLE = '新对话'
const LEGACY_SESSION_TITLE = '新会话'
const SESSION_PLACEHOLDER_PREFIX = 'serve:'
const SESSION_ID_PREVIEW_LENGTH = 8

export interface SessionTitle {
  title: string
  title_fallback?: SessionTitleFallback
}

export interface ArchivedTask extends SessionTitle {
  session_id: string
  project_path?: string | null
}

export function archivedTaskForProject(
  task: ArchivedTask | null,
  projectPath: string | null | undefined
): ArchivedTask | null {
  return projectPath && task?.project_path === projectPath ? task : null
}

export function sessionTitleFallback(value: unknown): SessionTitleFallback {
  return value === 'new_session' ? value : null
}

export function sessionDisplayTitle(session: SessionTitle, t: TFunction<'assistant'>): string {
  return sessionTitleFallback(session.title_fallback) ? t('panel.new') : session.title
}

export function sessionProjectName(
  session: { project_path?: string | null },
  projects: readonly { path: string; name: string }[],
  unassigned: string
): string {
  const projectPath = session.project_path
  if (!projectPath) return unassigned
  return projects.find((project) => project.path === projectPath)?.name || projectPath
}

/** An absent title in a legacy open response cannot replace a local title. */
export function openedSessionTitle(opened: {
  title?: string
  title_fallback?: unknown
}): Partial<SessionTitle> {
  return typeof opened.title === 'string'
    ? { title: opened.title, title_fallback: sessionTitleFallback(opened.title_fallback) }
    : {}
}

/** Preserve the existing catalog/local precedence while selecting the entire title pair. */
export function mergedSessionTitle(
  existing: SessionTitle | undefined,
  thread: SessionTitle,
  id: string
): SessionTitle {
  const placeholder =
    !existing?.title ||
    existing.title_fallback === 'new_session' ||
    (existing.title_fallback === undefined &&
      (existing.title === CANONICAL_NEW_SESSION_TITLE ||
        existing.title === LEGACY_SESSION_TITLE ||
        existing.title.startsWith(SESSION_PLACEHOLDER_PREFIX)))
  const selected = placeholder
    ? thread.title
      ? thread
      : existing?.title
        ? existing
        : undefined
    : existing?.title
      ? existing
      : thread.title
        ? thread
        : undefined
  return selected
    ? { title: selected.title, title_fallback: sessionTitleFallback(selected.title_fallback) }
    : { title: id.slice(0, SESSION_ID_PREVIEW_LENGTH), title_fallback: null }
}

/** New drafts retain canonical data; only the rendering layer translates it. */
export function draftSessionTitle(opened: {
  title?: string
  title_fallback?: unknown
}): SessionTitle {
  return typeof opened.title === 'string'
    ? { title: opened.title, title_fallback: sessionTitleFallback(opened.title_fallback) }
    : { title: CANONICAL_NEW_SESSION_TITLE, title_fallback: 'new_session' }
}

const SESSION_TIMESTAMP_MILLISECONDS = 1_000

/** Format catalog timestamps on display; preserve explicitly supplied labels verbatim. */
export function sessionDisplayTime(
  session: { createdAt?: number; timeLabel?: string },
  format: ReturnType<typeof createFormatters>,
  now = new Date()
): string {
  if (session.timeLabel !== undefined) return session.timeLabel
  if (session.createdAt === undefined) return ''
  const started = new Date(session.createdAt * SESSION_TIMESTAMP_MILLISECONDS)
  if (Number.isNaN(started.getTime())) return ''
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  if (started >= today) return format.date(started, { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (started >= yesterday) return format.relative(-1, 'day', { numeric: 'auto' })
  return format.date(started, { month: 'numeric', day: 'numeric' })
}
