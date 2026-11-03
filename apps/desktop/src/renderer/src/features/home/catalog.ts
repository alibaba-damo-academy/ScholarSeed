import type { Project, ServeSession } from '../../api'
import type { createFormatters } from '../../../../localization/format'

export const HOME_TASK_LIMIT = 500
export const HOME_TASK_PAGE_SIZE = 8
export const HOME_PROJECT_PAGE_SIZE = 5
export const HOME_PIN_PAGE_SIZE = 4
export const HOME_PROJECT_PREVIEW_SIZE = 4
export const HOME_TASK_PREVIEW_SIZE = 5
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

export function activityLabel(
  value: number,
  format: Pick<ReturnType<typeof createFormatters>, 'relative'>,
  now = Date.now()
): string {
  if (!value) return '—'
  const minutes = Math.max(0, Math.floor((now / 1000 - value) / SECONDS_PER_MINUTE))
  if (minutes < MINUTES_PER_HOUR) return format.relative(-minutes, 'minute', { numeric: 'auto' })
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return format.relative(-hours, 'hour')
  return format.relative(-Math.floor(hours / HOURS_PER_DAY), 'day')
}

export function projectActivity(sessions: ServeSession[]): ReadonlyMap<string, number> {
  const activity = new Map<string, number>()
  for (const session of sessions) {
    if (!session.project_path) continue
    activity.set(
      session.project_path,
      Math.max(activity.get(session.project_path) ?? 0, session.mtime ?? session.created_at ?? 0)
    )
  }
  return activity
}

export function taskActivity(session: ServeSession): number {
  return session.mtime ?? session.created_at ?? 0
}

export function recentTasks(
  projects: Project[],
  sessions: ServeSession[],
  query: string
): ServeSession[] {
  const names = new Map(projects.map((project) => [project.path, project.name]))
  const search = query.trim().toLocaleLowerCase()
  return sessions
    .filter((session) => {
      const projectName = names.get(session.project_path ?? '')
      return (
        projectName !== undefined &&
        (!search || `${session.title} ${projectName}`.toLocaleLowerCase().includes(search))
      )
    })
    .sort(
      (left, right) =>
        taskActivity(right) - taskActivity(left) || (right.created_at ?? 0) - (left.created_at ?? 0)
    )
}

export function orderedProjects(
  projects: Project[],
  query: string,
  activity: ReadonlyMap<string, number>
): Project[] {
  const search = query.trim().toLocaleLowerCase()
  return projects
    .filter(
      (project) =>
        !search ||
        `${project.name} ${project.description ?? ''}`.toLocaleLowerCase().includes(search)
    )
    .sort(
      (left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
        (activity.get(right.path) ?? 0) - (activity.get(left.path) ?? 0) ||
        (right.added_at ?? 0) - (left.added_at ?? 0)
    )
}
