import type { TFunction } from 'i18next'
import type { createFormatters } from '../../localization/format'
import type { Project } from './api'
import type { SessionNode } from './model'

const HOUR_SECONDS = 60 * 60
const DAY_SECONDS = 24 * HOUR_SECONDS

export interface ProjectSummary {
  chats: number
  activityAt: number
}

export function isProjectAvailable(project: Project): boolean {
  return project.available !== false
}

export function projectSummary(project: Project, sessions: SessionNode[]): ProjectSummary {
  const owned = sessions.filter((session) => session.projectPath === project.path)
  const sessionActivity = owned.reduce(
    (latest, session) => Math.max(latest, session.activityAt ?? session.createdAt ?? 0),
    0
  )
  return {
    chats: owned.length,
    activityAt: Math.max(project.updated_at ?? 0, project.added_at ?? 0, sessionActivity),
  }
}

export function filterProjects(projects: Project[], query: string): Project[] {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return projects
  return projects.filter(
    (project) =>
      project.name.toLocaleLowerCase().includes(keyword) ||
      project.path.toLocaleLowerCase().includes(keyword)
  )
}

export function projectTimeLabel(
  timestamp: number,
  t: TFunction<'project'>,
  format: ReturnType<typeof createFormatters>,
  now = Date.now() / 1_000
): string {
  if (!timestamp) return ''
  const seconds = Math.max(0, now - timestamp)
  if (seconds < HOUR_SECONDS) return t('cards.withinHour')
  if (seconds < DAY_SECONDS)
    return t('cards.hoursAgo', { total: Math.floor(seconds / HOUR_SECONDS) })
  if (seconds < DAY_SECONDS * 2) return t('cards.yesterday')
  if (seconds < DAY_SECONDS * 30)
    return t('cards.daysAgo', { total: Math.floor(seconds / DAY_SECONDS) })
  return format.date(timestamp * 1_000, {
    month: 'numeric',
    day: 'numeric',
  })
}

/**
 * 首页空间项目卡的「最近修改」用绝对时间戳（原型 home space 卡片形态），
 * 与项目页的相对时间 projectTimeLabel 是两套呈现，来源同为 activityAt。
 */
export function projectModifiedLabel(timestamp: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp * 1_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

export function projectFileLabel(project: Project, t: TFunction<'project'>): string {
  if (!isProjectAvailable(project)) return t('cards.unavailable')
  if (project.file_count === undefined || project.file_count === null)
    return t('cards.unknownFiles')
  return t(project.file_count_capped ? 'cards.cappedFiles' : 'cards.files', {
    total: project.file_count,
  })
}
