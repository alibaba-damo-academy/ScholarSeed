import type { TFunction } from 'i18next'

export type FileVersionPolicyMode = 'whitelist' | 'blacklist'

export interface FileVersionPolicy {
  mode: FileVersionPolicyMode
  max_versions_per_file: number
  max_file_size_kb: number
  include_patterns: string[]
  ignore_patterns: string[]
}

export interface FileVersionSettings extends FileVersionPolicy {
  migration_required: boolean
  common_patterns: string[]
  scan_summary: FileVersionScanSummary
}

export interface FileVersionScanSummary {
  status: 'idle' | 'scanning'
  projects: number
  managed: number
  created: number
  ignored: number
  oversized: number
  unsupported: number
  failed: number
}

export interface FileVersionRetentionPreview extends FileVersionPolicy {
  added_files: number
  removed_files: number
  added_paths: { project_id: string; path: string }[]
  removed_paths: { project_id: string; path: string }[]
  delete_versions: number
  delete_deliveries: number
  affected_files: number
  token: string
}

export type FileVersionSettingsMutation<T> =
  | { ok: true; result: T }
  | { ok: false; error: string }

export interface FileVersionSettingsChanges {
  settings: FileVersionPolicy
  limit: 'unchanged' | 'increased' | 'decreased'
  fileSizeChanged: boolean
  modeChanged: boolean
  includesChanged: boolean
  ignoresChanged: boolean
}

const base = (): string => window.scholarseed?.getApiBase() ?? ''
const FILE_VERSION_SIZE_KB_PER_MB = 1024
const FILE_VERSION_SIZE_MB_FRACTION_DIGITS = 2
export const FILE_VERSION_MIN_SIZE_MB = 1
export const FILE_VERSION_MAX_SIZE_MB = 2048
const SETTINGS_REQUEST_FAILED = 'settings_request_failed'
const VERSION_SCAN_POLL_MILLISECONDS = 200
const VERSION_SCAN_TIMEOUT_MILLISECONDS = 30_000

const wait = (milliseconds: number): Promise<void> => (
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
)

function normalizePatterns(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

export function appendVersionPattern(value: string, pattern: string): string {
  const patterns = normalizePatterns(value)
  return patterns.includes(pattern) ? patterns.join('\n') : [...patterns, pattern].join('\n')
}

function samePatterns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } }
    return payload.error?.code || payload.error?.message || SETTINGS_REQUEST_FAILED
  } catch {
    return SETTINGS_REQUEST_FAILED
  }
}

export function fileVersionSettingsChanges(
  saved: FileVersionPolicy,
  maxVersions: number,
  maxFileSizeKb: number,
  includePatterns: string,
  ignorePatterns: string,
  mode: FileVersionPolicyMode = saved.mode
): FileVersionSettingsChanges {
  const includes = normalizePatterns(includePatterns)
  const ignores = normalizePatterns(ignorePatterns)
  const limit = maxVersions < saved.max_versions_per_file
    ? 'decreased'
    : maxVersions > saved.max_versions_per_file ? 'increased' : 'unchanged'
  return {
    settings: {
      mode,
      max_versions_per_file: maxVersions,
      max_file_size_kb: maxFileSizeKb,
      include_patterns: includes,
      ignore_patterns: ignores
    },
    limit,
    fileSizeChanged: maxFileSizeKb !== saved.max_file_size_kb,
    modeChanged: mode !== saved.mode,
    includesChanged: !samePatterns(saved.include_patterns, includes),
    ignoresChanged: !samePatterns(saved.ignore_patterns, ignores)
  }
}

/** Present the KB API value in the settings page's MB unit. */
export function fileVersionSizeMbText(sizeKb: number): string {
  return String(Number((sizeKb / FILE_VERSION_SIZE_KB_PER_MB).toFixed(FILE_VERSION_SIZE_MB_FRACTION_DIGITS)))
}

/**
 * Convert an edited MB value back to the KB API value. An unedited display of a
 * saved non-integral MB value keeps its exact saved KB value.
 */
export function fileVersionSizeKb(value: string, savedKb: number): number | null {
  const text = value.trim()
  if (text === fileVersionSizeMbText(savedKb)) return savedKb
  const sizeMb = Number(text)
  if (
    !text
    || !Number.isInteger(sizeMb)
    || sizeMb < FILE_VERSION_MIN_SIZE_MB
    || sizeMb > FILE_VERSION_MAX_SIZE_MB
  ) return null
  return sizeMb * FILE_VERSION_SIZE_KB_PER_MB
}

export function fileVersionScanSummary(summary: FileVersionScanSummary, t: TFunction<'resources'>): string {
  const key = summary.status === 'scanning' ? 'fileSettings.scanning' : 'fileSettings.scanned'
  return t(key, {
    projects: summary.projects,
    managed: summary.managed,
    ignored: summary.ignored,
    oversized: summary.oversized
  })
}

export async function loadFileVersionSettings(): Promise<FileVersionSettings | null> {
  try {
    const response = await fetch(`${base()}/api/serve/settings/file-versions`, {
      credentials: 'include'
    })
    return response.ok ? await response.json() as FileVersionSettings : null
  } catch {
    return null
  }
}

/** Wait for a root-link discovery pass before the resource tree is reloaded. */
export async function waitForFileVersionScan(
  pollMilliseconds = VERSION_SCAN_POLL_MILLISECONDS,
  timeoutMilliseconds = VERSION_SCAN_TIMEOUT_MILLISECONDS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() <= deadline) {
    const settings = await loadFileVersionSettings()
    if (!settings) return false
    if (settings.scan_summary.status === 'idle') return true
    await wait(pollMilliseconds)
  }
  return false
}

export async function previewFileVersionSettings(
  maxVersions: number,
  maxFileSizeKb: number,
  includePatterns: string,
  ignorePatterns: string,
  mode: FileVersionPolicyMode
): Promise<FileVersionSettingsMutation<FileVersionRetentionPreview>> {
  try {
    const response = await fetch(`${base()}/api/serve/settings/file-versions/preview`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        max_versions_per_file: maxVersions,
        max_file_size_kb: maxFileSizeKb,
        include_patterns: includePatterns,
        ignore_patterns: ignorePatterns
      })
    })
    return response.ok
      ? { ok: true, result: await response.json() as FileVersionRetentionPreview }
      : { ok: false, error: await responseError(response) }
  } catch {
    return { ok: false, error: SETTINGS_REQUEST_FAILED }
  }
}

export async function applyFileVersionSettings(
  settings: FileVersionPolicy,
  previewToken?: string
): Promise<FileVersionSettingsMutation<FileVersionRetentionPreview>> {
  try {
    const payload: Record<string, unknown> = {
      mode: settings.mode,
      max_versions_per_file: settings.max_versions_per_file,
      max_file_size_kb: settings.max_file_size_kb,
      include_patterns: settings.include_patterns.join('\n'),
      ignore_patterns: settings.ignore_patterns.join('\n')
    }
    if (previewToken) payload.preview_token = previewToken
    const response = await fetch(`${base()}/api/serve/settings/file-versions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return response.ok
      ? { ok: true, result: await response.json() as FileVersionRetentionPreview }
      : { ok: false, error: await responseError(response) }
  } catch {
    return { ok: false, error: SETTINGS_REQUEST_FAILED }
  }
}

export async function saveFileVersionSettings(
  settings: FileVersionPolicy
): Promise<FileVersionSettingsMutation<FileVersionRetentionPreview>> {
  return applyFileVersionSettings(settings)
}
