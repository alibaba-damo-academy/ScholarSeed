import type { FileVersionPolicy, FileVersionRetentionPreview, FileVersionScanSummary, FileVersionSettings } from '../src/renderer/src/features/resources/settings.ts'
import { PREVIEW_VERSION_SETTINGS } from './versions.ts'

export const PREVIEW_FILE_SETTINGS = {
  path: '/api/serve/settings/file-versions',
  delayMs: 2_000,
  minCount: 1,
  maxCount: 1000,
  minSizeKb: 1,
  maxSizeKb: 2 * 1024 * 1024,
  writeFailure: 'preview_file_settings_unavailable',
  disposed: 'preview_file_settings_disposed',
  unsupported: 'preview_file_settings_retention_unsupported',
} as const

export interface PreviewFileSettingsPolicy { write: 'normal' | 'delayed' | 'fail-once' }
export class PreviewConfigurationError extends Error {
  readonly status: number
  constructor(code: string, status = 400) { super(code); this.status = status }
}

function patterns(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const rows = typeof value === 'string' ? value.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u) : value
  if (!Array.isArray(rows) || rows.some(row => typeof row !== 'string')) throw new PreviewConfigurationError('invalid_version_patterns')
  return rows.map(row => row.trim()).filter(Boolean)
}

function policy(value: unknown, previous: FileVersionPolicy): FileVersionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreviewConfigurationError('invalid_version_limit')
  const body = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(body, 'preview_token')) throw new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.unsupported, 501)
  const count = body.max_versions_per_file
  if (!Number.isInteger(count)) throw new PreviewConfigurationError('invalid_version_limit')
  if ((count as number) < PREVIEW_FILE_SETTINGS.minCount || (count as number) > PREVIEW_FILE_SETTINGS.maxCount) throw new PreviewConfigurationError('invalid_max_versions')
  const size = body.max_file_size_kb === undefined ? previous.max_file_size_kb : body.max_file_size_kb
  if (!Number.isInteger(size) || (size as number) < PREVIEW_FILE_SETTINGS.minSizeKb || (size as number) > PREVIEW_FILE_SETTINGS.maxSizeKb) throw new PreviewConfigurationError('invalid_max_file_size')
  if (body.mode !== 'whitelist' && body.mode !== 'blacklist') throw new PreviewConfigurationError('invalid_version_mode')
  return { mode: body.mode, max_versions_per_file: count as number, max_file_size_kb: size as number, include_patterns: patterns(body.include_patterns), ignore_patterns: patterns(body.ignore_patterns) }
}

export class PreviewConfiguration {
  private current: FileVersionPolicy = {
    mode: PREVIEW_VERSION_SETTINGS.mode,
    max_versions_per_file: PREVIEW_VERSION_SETTINGS.max_versions_per_file,
    max_file_size_kb: PREVIEW_VERSION_SETTINGS.max_file_size_kb,
    include_patterns: [...PREVIEW_VERSION_SETTINGS.include_patterns],
    ignore_patterns: [...PREVIEW_VERSION_SETTINGS.ignore_patterns],
  }
  private readonly mode: PreviewFileSettingsPolicy['write']
  private failed = false
  private disposed = false
  private readonly pending = new Set<() => void>()

  constructor(simulation: PreviewFileSettingsPolicy = { write: 'normal' }) { this.mode = simulation.write }

  read(scan: FileVersionScanSummary): FileVersionSettings {
    if (this.disposed) throw new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.disposed, 410)
    return { ...structuredClone(this.current), migration_required: false, common_patterns: [...PREVIEW_VERSION_SETTINGS.common_patterns], scan_summary: { ...scan } }
  }

  async configure(value: unknown, signal?: AbortSignal): Promise<FileVersionRetentionPreview & { migration_required: boolean }> {
    if (this.disposed || signal?.aborted) throw new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.disposed, 410)
    const next = policy(value, this.current)
    if (this.mode === 'fail-once' && !this.failed) {
      this.failed = true
      throw new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.writeFailure, 503)
    }
    if (this.mode === 'delayed') {
      await new Promise<void>((resolve, reject) => {
        const finish = (cancelled: boolean): void => {
          clearTimeout(timer)
          this.pending.delete(cancel)
          signal?.removeEventListener('abort', cancel)
          if (cancelled) reject(new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.disposed, 410))
          else resolve()
        }
        const cancel = (): void => finish(true)
        const timer = setTimeout(() => finish(false), PREVIEW_FILE_SETTINGS.delayMs)
        this.pending.add(cancel)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    if (this.disposed || signal?.aborted) throw new PreviewConfigurationError(PREVIEW_FILE_SETTINGS.disposed, 410)
    this.current = next
    return { ...structuredClone(next), migration_required: false, added_files: 0, removed_files: 0, added_paths: [], removed_paths: [], delete_versions: 0, delete_deliveries: 0, affected_files: 0, token: '' }
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
