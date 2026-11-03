import { onboardingEqual, sanitizeOnboarding, type OnboardingPreferences } from './onboarding.ts'
import { projectLayoutsEqual, sanitizeProjectLayouts, type ProjectLayouts } from './layout.ts'
import {
  navigationLocationsEqual,
  sanitizeNavigationLocation,
  type NavigationLocation,
} from './navigation.ts'

import {
  sanitizeSelectionPrompts,
  selectionPromptsEqual,
  type SelectionPrompts,
} from './prompts.ts'

// Shared Electron IPC contract for renderer-owned UX preferences. Session and
// project business facts stay in the service catalog; this record only keeps a
// stable shell layout and the user's per-session read watermark.

export const MAX_TRACKED_SESSION_ACTIVITY = 1_000

/** Keep enough MRU history to backfill the five visible rows after stale projects disappear. */
export const MAX_TRACKED_RECENT_FILES = 20

/** 首页「最近打开」只展示三条，多留余量是为了条目被删除后仍能补齐。 */
export const MAX_TRACKED_RECENT_LITERATURE = 10

export const MAX_SHORTCUT_OVERRIDES = 100
export const MAX_SHORTCUT_KEY_LENGTH = 32
export const MAX_MODEL_KEY_LENGTH = 512

export const LITERATURE_AI_MODEL_ACTIONS = [
  'document_translation',
  'selection_translation',
  'selection_explanation',
  'interpretation',
  'figure_explanation',
] as const

export type LiteratureAiModelAction = (typeof LITERATURE_AI_MODEL_ACTIONS)[number]
export type LiteratureAiModelPreferences = Partial<Record<LiteratureAiModelAction, string>>

const RETIRED_SHORTCUT_COMMAND_IDS = new Set([
  'workbench.globalSearch',
  'workbench.toggleModulePanel',
  'workbench.toggleAiPanel',
  'code.quickOpen',
  'code.copyLineUp',
  'code.copyLineDown',
  'code.moveLineUp',
  'code.moveLineDown',
  'code.deleteLine',
  'code.blockComment',
  'pdf.openLink',
  'pdf.toggleOutline',
  'office.save',
  'office.find',
  'office.paste',
  'office.selectAll',
  'office.bold',
  'office.copy',
  'office.italic',
  'office.underline',
  'office.cut',
  'office.undo',
  'office.redo',
])

export type PreferenceShortcutModifier = 'primary' | 'shift' | 'alt'

export interface PreferenceShortcutBinding {
  key: string
  modifiers: readonly PreferenceShortcutModifier[]
}

export type PreferenceShortcutOverrides = Record<string, PreferenceShortcutBinding | null>

const SAFE_UNMODIFIED_SHORTCUT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Enter',
  'Home',
  'PageDown',
  'PageUp',
  'Space',
  'Tab',
])

export function isPreferenceShortcutBindingAllowed(
  key: string,
  modifiers: readonly PreferenceShortcutModifier[]
): boolean {
  return (
    modifiers.includes('primary') ||
    modifiers.includes('alt') ||
    SAFE_UNMODIFIED_SHORTCUT_KEYS.has(key)
  )
}

/** Keep enough conversation history for the reference picker quick filter. */
export const MAX_TRACKED_RECENT_SESSIONS = 20

/** Renderer-owned navigation history; project ids and paths remain service-issued identities. */
export interface RecentFileEntry {
  projectId: string
  path: string
  openedAt: number
}

/** 首页「最近打开」视图的文献 MRU；id 是 service 颁发的文献身份，只存指针不存内容。 */
export interface RecentLiteratureEntry {
  id: string
  openedAt: number
}

/** Renderer-owned conversation MRU; session business facts remain in Serve. */
export interface RecentSessionEntry {
  id: string
  openedAt: number
}

/**
 * 界面语言。PRD「偏好设置」①。
 *
 * 首次运行（没有已持久化的用户选择）时按用户环境检测：时区属中国大陆 → 中文，
 * 可判定的非中国时区 → 英文，时区判定不出来 → 看 OS 系统语言，全都失败 → 中文。
 * 判定策略见 `src/locale.ts`；用户一旦手选过，后续启动不再检测，也不被时区变化覆盖。
 *
 * 只作用于产品界面文字，不翻译用户内容，也不决定 AI 回答语言（PRD ③④）。
 */
export type PreferenceLanguage = 'zh' | 'en'

/** 外观。PRD「偏好设置」⑤：首次使用默认浅色；`system` 跟随系统。 */
export type PreferenceTheme = 'dark' | 'light' | 'system'

export const PREFERENCE_LANGUAGES: readonly PreferenceLanguage[] = ['zh', 'en']

export const PREFERENCE_THEMES: readonly PreferenceTheme[] = ['light', 'dark', 'system']

export interface RendererPreferences {
  taskMessageDismissals?: Record<string, number>
  projectLayouts?: ProjectLayouts
  browserAutomationEnabled: boolean
  lastLocation: NavigationLocation | null
  onboarding?: OnboardingPreferences
  selectionPrompts: SelectionPrompts
  reasoningPreferences?: Record<string, string>
  literatureAiModels: LiteratureAiModelPreferences
  sidebarOpen: boolean
  sessionActivityInitialized: boolean
  sessionActivitySeen: Record<string, number>
  /** mac/dev 首启一次性「高级」数据位置入口是否已消费（跳过或完成），不再重弹。 */
  storageFirstLaunchSeen: boolean
  desktopNotifications: boolean
  soundAlerts: boolean
  autoDownloadUpdates: boolean
  autoSave: boolean
  formatOnSave: boolean
  editorWordWrap: boolean
  shortcutOverrides: PreferenceShortcutOverrides
  dataSharingMode: 'private'
  language: PreferenceLanguage
  theme: PreferenceTheme
  recentFiles: RecentFileEntry[]
  recentLiterature: RecentLiteratureEntry[]
  recentSessions: RecentSessionEntry[]
  recentProjectId: string | null
}

/** 各项默认值。其中 `language` 是检测链全部失败时的最终兜底，不是无条件默认值。 */
export const DEFAULT_RENDERER_PREFERENCES: RendererPreferences = {
  taskMessageDismissals: {},
  browserAutomationEnabled: true,
  lastLocation: null,
  selectionPrompts: sanitizeSelectionPrompts(undefined),
  literatureAiModels: {},
  projectLayouts: {},
  sidebarOpen: true,
  sessionActivityInitialized: false,
  sessionActivitySeen: {},
  storageFirstLaunchSeen: false,
  desktopNotifications: true,
  soundAlerts: true,
  autoDownloadUpdates: true,
  autoSave: true,
  formatOnSave: false,
  editorWordWrap: true,
  shortcutOverrides: {},
  dataSharingMode: 'private',
  language: 'zh',
  theme: 'light',
  recentFiles: [],
  recentLiterature: [],
  recentSessions: [],
  recentProjectId: null,
}

/**
 * 带语言兜底的默认偏好。用于「没有已持久化用户选择」的场景，由调用方把检测出的
 * 语言传进来；不传则退回常量里的最终兜底。返回浅拷贝，绝不改动导出的常量对象。
 */
export function defaultRendererPreferences(
  fallbackLanguage?: PreferenceLanguage
): RendererPreferences {
  return {
    ...DEFAULT_RENDERER_PREFERENCES,
    selectionPrompts: sanitizeSelectionPrompts(undefined),
    language: fallbackLanguage ?? DEFAULT_RENDERER_PREFERENCES.language,
  }
}

function activityMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
      )
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_TRACKED_SESSION_ACTIVITY)
  )
}

export function sanitizeRecentFiles(value: unknown): RecentFileEntry[] {
  if (!Array.isArray(value)) return []
  const candidates = value
    .flatMap((entry): RecentFileEntry[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const parsed = entry as Partial<RecentFileEntry>
      if (
        typeof parsed.projectId !== 'string' ||
        !parsed.projectId ||
        typeof parsed.path !== 'string' ||
        !parsed.path ||
        typeof parsed.openedAt !== 'number' ||
        !Number.isFinite(parsed.openedAt) ||
        parsed.openedAt < 0
      )
        return []
      return [
        {
          projectId: parsed.projectId,
          path: parsed.path,
          openedAt: parsed.openedAt,
        },
      ]
    })
    .sort((left, right) => right.openedAt - left.openedAt)
  const unique: RecentFileEntry[] = []
  for (const entry of candidates) {
    if (
      unique.some(
        (candidate) => candidate.projectId === entry.projectId && candidate.path === entry.path
      )
    )
      continue
    unique.push(entry)
    if (unique.length === MAX_TRACKED_RECENT_FILES) break
  }
  return unique
}

export function recentFilesEqual(
  left: readonly RecentFileEntry[],
  right: readonly RecentFileEntry[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        entry.projectId === candidate.projectId &&
        entry.path === candidate.path &&
        entry.openedAt === candidate.openedAt
      )
    })
  )
}

export function sanitizeRecentLiterature(value: unknown): RecentLiteratureEntry[] {
  if (!Array.isArray(value)) return []
  const candidates = value
    .flatMap((entry): RecentLiteratureEntry[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const parsed = entry as Partial<RecentLiteratureEntry>
      if (
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        typeof parsed.openedAt !== 'number' ||
        !Number.isFinite(parsed.openedAt) ||
        parsed.openedAt < 0
      )
        return []
      return [{ id: parsed.id, openedAt: parsed.openedAt }]
    })
    .sort((left, right) => right.openedAt - left.openedAt)
  const unique: RecentLiteratureEntry[] = []
  for (const entry of candidates) {
    if (unique.some((candidate) => candidate.id === entry.id)) continue
    unique.push(entry)
    if (unique.length === MAX_TRACKED_RECENT_LITERATURE) break
  }
  return unique
}

export function recentLiteratureEqual(
  left: readonly RecentLiteratureEntry[],
  right: readonly RecentLiteratureEntry[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.openedAt === candidate.openedAt
      )
    })
  )
}

export function sanitizeRecentSessions(value: unknown): RecentSessionEntry[] {
  if (!Array.isArray(value)) return []
  const candidates = value
    .flatMap((entry): RecentSessionEntry[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const parsed = entry as Partial<RecentSessionEntry>
      if (
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        typeof parsed.openedAt !== 'number' ||
        !Number.isFinite(parsed.openedAt) ||
        parsed.openedAt < 0
      )
        return []
      return [{ id: parsed.id, openedAt: parsed.openedAt }]
    })
    .sort((left, right) => right.openedAt - left.openedAt)
  const unique: RecentSessionEntry[] = []
  for (const entry of candidates) {
    if (unique.some((candidate) => candidate.id === entry.id)) continue
    unique.push(entry)
    if (unique.length === MAX_TRACKED_RECENT_SESSIONS) break
  }
  return unique
}

export function recentSessionsEqual(
  left: readonly RecentSessionEntry[],
  right: readonly RecentSessionEntry[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.openedAt === candidate.openedAt
      )
    })
  )
}

function preferenceRecordEqual<T extends string | number>(
  left: Readonly<Record<string, T>>,
  right: Readonly<Record<string, T>>
): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

export function sanitizeLiteratureAiModels(value: unknown): LiteratureAiModelPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    LITERATURE_AI_MODEL_ACTIONS.flatMap((action) => {
      const modelKey = source[action]
      return typeof modelKey === 'string' &&
        modelKey.length > 0 &&
        modelKey.length <= MAX_MODEL_KEY_LENGTH
        ? [[action, modelKey]]
        : []
    })
  )
}

function shortcutOverridesEqual(
  left: PreferenceShortcutOverrides,
  right: PreferenceShortcutOverrides
): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const leftBinding = left[key]
      const rightBinding = right[key]
      if (leftBinding === null || rightBinding === null) return leftBinding === rightBinding
      return (
        leftBinding?.key === rightBinding?.key &&
        leftBinding.modifiers.length === rightBinding.modifiers.length &&
        leftBinding.modifiers.every((modifier, index) => modifier === rightBinding.modifiers[index])
      )
    })
  )
}

/** Preference equality follows field meaning, never object insertion order. */
export function rendererPreferencesEqual(
  left: RendererPreferences,
  right: RendererPreferences
): boolean {
  return (
    preferenceRecordEqual(left.taskMessageDismissals ?? {}, right.taskMessageDismissals ?? {}) &&
    left.browserAutomationEnabled === right.browserAutomationEnabled &&
    left.recentProjectId === right.recentProjectId &&
    onboardingEqual(left.onboarding, right.onboarding) &&
    navigationLocationsEqual(left.lastLocation, right.lastLocation) &&
    left.sidebarOpen === right.sidebarOpen &&
    projectLayoutsEqual(left.projectLayouts, right.projectLayouts) &&
    left.sessionActivityInitialized === right.sessionActivityInitialized &&
    preferenceRecordEqual(left.sessionActivitySeen, right.sessionActivitySeen) &&
    preferenceRecordEqual(left.reasoningPreferences ?? {}, right.reasoningPreferences ?? {}) &&
    preferenceRecordEqual(left.literatureAiModels, right.literatureAiModels) &&
    left.desktopNotifications === right.desktopNotifications &&
    left.storageFirstLaunchSeen === right.storageFirstLaunchSeen &&
    left.soundAlerts === right.soundAlerts &&
    left.autoDownloadUpdates === right.autoDownloadUpdates &&
    left.autoSave === right.autoSave &&
    left.formatOnSave === right.formatOnSave &&
    left.editorWordWrap === right.editorWordWrap &&
    shortcutOverridesEqual(left.shortcutOverrides, right.shortcutOverrides) &&
    left.dataSharingMode === right.dataSharingMode &&
    left.language === right.language &&
    left.theme === right.theme &&
    selectionPromptsEqual(left.selectionPrompts, right.selectionPrompts) &&
    recentFilesEqual(left.recentFiles, right.recentFiles) &&
    recentLiteratureEqual(left.recentLiterature, right.recentLiterature) &&
    recentSessionsEqual(left.recentSessions, right.recentSessions)
  )
}

export function touchRecentFile(
  current: readonly RecentFileEntry[],
  entry: RecentFileEntry
): RecentFileEntry[] {
  return sanitizeRecentFiles([entry, ...current])
}

export function touchRecentLiterature(
  current: readonly RecentLiteratureEntry[],
  entry: RecentLiteratureEntry
): RecentLiteratureEntry[] {
  return sanitizeRecentLiterature([entry, ...current])
}

export function touchRecentSession(
  current: readonly RecentSessionEntry[],
  entry: RecentSessionEntry
): RecentSessionEntry[] {
  return sanitizeRecentSessions([entry, ...current])
}

/**
 * 语言只有在持久化记录里是 `PREFERENCE_LANGUAGES` 成员时，才算用户显式选过。
 * 缺失或非法都当作「没选过」，交回调用方传入的检测结果（首次运行即环境检测，
 * 早于 `language` 字段的旧偏好文件因此也会走检测，而不是被静默钉成中文）。
 */
function parseLanguage(value: unknown, fallback: PreferenceLanguage): PreferenceLanguage {
  return PREFERENCE_LANGUAGES.includes(value as PreferenceLanguage)
    ? (value as PreferenceLanguage)
    : fallback
}

function parseTheme(value: unknown): PreferenceTheme {
  return PREFERENCE_THEMES.includes(value as PreferenceTheme)
    ? (value as PreferenceTheme)
    : DEFAULT_RENDERER_PREFERENCES.theme
}

const SHORTCUT_MODIFIERS: readonly PreferenceShortcutModifier[] = ['primary', 'shift', 'alt']

export function sanitizeShortcutOverrides(value: unknown): PreferenceShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const overrides: PreferenceShortcutOverrides = {}
  for (const [commandId, candidate] of Object.entries(value).slice(0, MAX_SHORTCUT_OVERRIDES)) {
    if (
      !commandId ||
      commandId.length > MAX_SHORTCUT_KEY_LENGTH * 4 ||
      RETIRED_SHORTCUT_COMMAND_IDS.has(commandId)
    )
      continue
    if (candidate === null) {
      overrides[commandId] = null
      continue
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const parsed = candidate as Partial<PreferenceShortcutBinding>
    if (
      typeof parsed.key !== 'string' ||
      !parsed.key ||
      parsed.key.length > MAX_SHORTCUT_KEY_LENGTH ||
      !Array.isArray(parsed.modifiers)
    )
      continue
    const modifiers = SHORTCUT_MODIFIERS.filter((modifier) => parsed.modifiers?.includes(modifier))
    if (
      !isPreferenceShortcutBindingAllowed(parsed.key, modifiers) ||
      modifiers.length !== new Set(parsed.modifiers).size
    )
      continue
    if (
      parsed.modifiers.some(
        (modifier) => !SHORTCUT_MODIFIERS.includes(modifier as PreferenceShortcutModifier)
      )
    )
      continue
    overrides[commandId] = { key: parsed.key, modifiers }
  }
  return overrides
}

export function sanitizeRendererPreferences(
  value: unknown,
  fallbackLanguage?: PreferenceLanguage
): RendererPreferences {
  const fallback = defaultRendererPreferences(fallbackLanguage)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback
  }
  const parsed = value as Partial<RendererPreferences>
  return {
    taskMessageDismissals:
      parsed.taskMessageDismissals &&
      typeof parsed.taskMessageDismissals === 'object' &&
      !Array.isArray(parsed.taskMessageDismissals)
        ? Object.fromEntries(
            Object.entries(parsed.taskMessageDismissals).filter(
              ([key, sequence]) => key.length > 0 && Number.isSafeInteger(sequence) && sequence >= 0
            )
          )
        : {},
    browserAutomationEnabled:
      typeof parsed.browserAutomationEnabled === 'boolean'
        ? parsed.browserAutomationEnabled
        : parsed.browserAutomationEnabled === undefined
          ? DEFAULT_RENDERER_PREFERENCES.browserAutomationEnabled
          : false,
    lastLocation: sanitizeNavigationLocation(parsed.lastLocation),
    projectLayouts: sanitizeProjectLayouts(parsed.projectLayouts),
    ...(parsed.onboarding ? { onboarding: sanitizeOnboarding(parsed.onboarding) } : {}),
    selectionPrompts: sanitizeSelectionPrompts(parsed.selectionPrompts),
    reasoningPreferences:
      parsed.reasoningPreferences && typeof parsed.reasoningPreferences === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.reasoningPreferences).filter(
              ([, effort]) => typeof effort === 'string'
            )
          )
        : {},
    literatureAiModels: sanitizeLiteratureAiModels(parsed.literatureAiModels),
    sidebarOpen:
      typeof parsed.sidebarOpen === 'boolean'
        ? parsed.sidebarOpen
        : DEFAULT_RENDERER_PREFERENCES.sidebarOpen,
    sessionActivityInitialized: parsed.sessionActivityInitialized === true,
    sessionActivitySeen: activityMap(parsed.sessionActivitySeen),
    storageFirstLaunchSeen: parsed.storageFirstLaunchSeen === true,
    desktopNotifications:
      typeof parsed.desktopNotifications === 'boolean'
        ? parsed.desktopNotifications
        : DEFAULT_RENDERER_PREFERENCES.desktopNotifications,
    soundAlerts:
      typeof parsed.soundAlerts === 'boolean'
        ? parsed.soundAlerts
        : DEFAULT_RENDERER_PREFERENCES.soundAlerts,
    autoDownloadUpdates:
      typeof parsed.autoDownloadUpdates === 'boolean'
        ? parsed.autoDownloadUpdates
        : DEFAULT_RENDERER_PREFERENCES.autoDownloadUpdates,
    autoSave:
      typeof parsed.autoSave === 'boolean'
        ? parsed.autoSave
        : DEFAULT_RENDERER_PREFERENCES.autoSave,
    formatOnSave:
      typeof parsed.formatOnSave === 'boolean'
        ? parsed.formatOnSave
        : DEFAULT_RENDERER_PREFERENCES.formatOnSave,
    editorWordWrap:
      typeof parsed.editorWordWrap === 'boolean'
        ? parsed.editorWordWrap
        : DEFAULT_RENDERER_PREFERENCES.editorWordWrap,
    shortcutOverrides: sanitizeShortcutOverrides(parsed.shortcutOverrides),
    dataSharingMode: 'private',
    language: parseLanguage(parsed.language, fallback.language),
    theme: parseTheme(parsed.theme),
    recentFiles: sanitizeRecentFiles(parsed.recentFiles),
    recentLiterature: sanitizeRecentLiterature(parsed.recentLiterature),
    recentSessions: sanitizeRecentSessions(parsed.recentSessions),
    recentProjectId:
      typeof parsed.recentProjectId === 'string' && parsed.recentProjectId.trim()
        ? parsed.recentProjectId.trim()
        : null,
  }
}

export const PREFERENCES_SAVE_CHANNEL = 'scholarseed:preferences-save'
export const PREFERENCES_RECONCILE_CHANNEL = 'scholarseed:preferences-reconcile'
