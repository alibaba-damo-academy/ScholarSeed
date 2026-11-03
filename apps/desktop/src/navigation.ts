export const MAIN_VIEWS = [
  'home',
  'conversation',
  'projects',
  'resource',
  'literature',
  'writing',
  'browser',
  'skills',
] as const
export type MainView = (typeof MAIN_VIEWS)[number]
export const NAVIGATION_DIAGNOSTIC_PREFIX = '[navigation]'

export const SETTINGS_PAGES = [
  'prompts',
  'preferences',
  'account',
  'models',
  'model-settings',
  'skills',
  'developer',
  'browser',
  'files',
  'storage',
  'shortcuts',
  'about',
  'notifications',
  'permissions',
  'archives',
] as const
export type AccountSettingsPage = (typeof SETTINGS_PAGES)[number]

export const BROWSER_SETTINGS_SECTIONS = ['overview', 'history'] as const
export type BrowserSettingsSection = (typeof BROWSER_SETTINGS_SECTIONS)[number]

export function browserSettingsSection(
  page: string | null,
  value: unknown
): BrowserSettingsSection | null {
  return page === 'browser'
    ? BROWSER_SETTINGS_SECTIONS.includes(value as BrowserSettingsSection)
      ? (value as BrowserSettingsSection)
      : BROWSER_SETTINGS_SECTIONS[0]
    : null
}

interface NavigationRecordTarget {
  owner: 'project_asset' | 'literature_attachment'
  scope_id: string
  subject_id: string
}

interface NavigationDocumentMetadata {
  path: string
  revision?: string
  mediaType?: string
  renderKind?: string
}

export type NavigationDocument = NavigationDocumentMetadata &
  (
    | { kind: 'project'; project?: string | null; assetId?: string | null }
    | {
        kind: 'literature'
        literatureId: string
        attachmentId: string
        recordTarget: NavigationRecordTarget
      }
    | {
        kind: 'session-file'
        sessionId: string
        projectScope?: string
        recordTarget?: NavigationRecordTarget
      }
    | { kind: 'session-artifact'; sessionId: string; artifactId: string; absolutePath?: string }
    | { kind: 'runtime-file' }
    | { kind: 'builtin'; id: string }
    | { kind: 'version'; project: string; versionId: string; revision: string }
    | { kind: 'review-base'; project: string; fileId: string; reviewId: string; revision: string }
  )

export type NavigationTarget =
  | {
      kind: 'document'
      source: NavigationDocument
      viewKind: 'preview' | 'edit' | 'source'
      title: string
    }
  | { kind: 'tab'; id: string }

export interface NavigationLocation {
  view: MainView
  projectId: string | null
  sessionId: string | null
  sessionProjectId: string | null
  settingsPage: AccountSettingsPage | null
  browserSettingsSection: BrowserSettingsSection | null
  aiPanelOpen: boolean
  aiPanelCover: boolean
  target: NavigationTarget | null
}

export const HOME_LOCATION: NavigationLocation = Object.freeze({
  view: 'home',
  projectId: null,
  sessionId: null,
  sessionProjectId: null,
  settingsPage: null,
  browserSettingsSection: null,
  aiPanelOpen: false,
  aiPanelCover: false,
  target: null,
})

const DOCUMENT_IDENTITIES: Record<NavigationDocument['kind'], readonly string[]> = {
  project: [],
  literature: ['literatureId', 'attachmentId'],
  'session-file': ['sessionId'],
  'session-artifact': ['sessionId', 'artifactId'],
  'runtime-file': [],
  builtin: ['id'],
  version: ['project', 'versionId', 'revision'],
  'review-base': ['project', 'fileId', 'reviewId', 'revision'],
}
const DOCUMENT_METADATA_FIELDS = [
  'revision',
  'mediaType',
  'renderKind',
  'assetId',
  'absolutePath',
  'projectScope',
] as const
const RECORD_OWNERS = ['project_asset', 'literature_attachment'] as const
const DOCUMENT_VIEW_KINDS = ['preview', 'edit', 'source'] as const

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function identity(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function sanitizeNavigationDocument(value: unknown): NavigationDocument | null {
  const source = object(value)
  if (
    !source ||
    typeof source.kind !== 'string' ||
    !Object.prototype.hasOwnProperty.call(DOCUMENT_IDENTITIES, source.kind)
  )
    return null
  const kind = source.kind as NavigationDocument['kind']
  const path = identity(source.path)
  if (!path) return null
  const result: Record<string, unknown> = { kind, path }
  for (const field of DOCUMENT_IDENTITIES[kind]) {
    const fieldValue = identity(source[field])
    if (!fieldValue) return null
    result[field] = fieldValue
  }
  for (const field of DOCUMENT_METADATA_FIELDS) {
    if (identity(source[field])) result[field] = source[field]
  }
  if (kind === 'project') result.project = identity(source.project)
  const target = object(source.recordTarget)
  if (
    target &&
    RECORD_OWNERS.includes(target.owner as NavigationRecordTarget['owner']) &&
    identity(target.scope_id) &&
    identity(target.subject_id)
  ) {
    result.recordTarget = {
      owner: target.owner,
      scope_id: target.scope_id,
      subject_id: target.subject_id,
    }
  }
  if (kind === 'literature' && !result.recordTarget) return null
  return result as unknown as NavigationDocument
}

export function sanitizeNavigationLocation(value: unknown): NavigationLocation | null {
  const location = object(value)
  if (!location || !MAIN_VIEWS.includes(location.view as MainView)) return null
  const rawTarget = object(location.target)
  let target: NavigationTarget | null = null
  if (rawTarget?.kind === 'document') {
    const source = sanitizeNavigationDocument(rawTarget.source)
    if (
      source &&
      DOCUMENT_VIEW_KINDS.includes(rawTarget.viewKind as 'preview' | 'edit' | 'source')
    ) {
      target = {
        kind: 'document',
        source,
        viewKind: rawTarget.viewKind as 'preview' | 'edit' | 'source',
        title: identity(rawTarget.title) ?? source.path,
      }
    }
  } else if (rawTarget?.kind === 'tab' && identity(rawTarget.id)) {
    target = { kind: 'tab', id: rawTarget.id as string }
  }
  return {
    view: location.view as MainView,
    projectId: identity(location.projectId),
    sessionId: identity(location.sessionId),
    sessionProjectId: identity(location.sessionProjectId),
    settingsPage: SETTINGS_PAGES.includes(location.settingsPage as AccountSettingsPage)
      ? (location.settingsPage as AccountSettingsPage)
      : null,
    browserSettingsSection: browserSettingsSection(
      location.settingsPage as string | null,
      location.browserSettingsSection
    ),
    aiPanelOpen: location.aiPanelOpen === true,
    aiPanelCover: location.aiPanelCover === true,
    target,
  }
}

export function navigationLocationsEqual(
  left: NavigationLocation | null,
  right: NavigationLocation | null
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
