export type OfficeWarmupStage = 'permission' | 'catalog' | 'reading' | 'runtime' | 'ready' | 'error'
export type OfficeWarmupFailure =
  | 'font-permission'
  | 'font-catalog'
  | 'font-read'
  | 'runtime-assets'
  | 'runtime-initialization'
  | 'runtime-execution'
  | 'warmup-timeout'
  | 'document-load'

export interface OfficeWarmupStatus {
  stage: OfficeWarmupStage
  done: number
  total: number
  loadedBytes: number
  error?: OfficeWarmupFailure
  detail?: string
}

export const INITIAL_OFFICE_WARMUP_STATUS: OfficeWarmupStatus = {
  stage: 'permission',
  done: 0,
  total: 0,
  loadedBytes: 0
}

const MAX_PROGRESS = 100
export const OFFICE_WARMUP_RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const
export const OFFICE_WARMUP_MAX_RETRIES = OFFICE_WARMUP_RETRY_DELAYS_MS.length
export const OFFICE_WARMUP_SLOW_THRESHOLD_MS = 60_000
export const OFFICE_WARMUP_RECOVERY_WINDOW_MS = 600_000
const OFFICE_WARMUP_STAGES = new Set<OfficeWarmupStage>([
  'permission',
  'catalog',
  'reading',
  'runtime',
  'ready',
  'error'
])
const OFFICE_WARMUP_FAILURES = new Set<OfficeWarmupFailure>([
  'font-permission',
  'font-catalog',
  'font-read',
  'runtime-assets',
  'runtime-initialization',
  'runtime-execution',
  'warmup-timeout',
  'document-load'
])
const RECOVERABLE_OFFICE_WARMUP_FAILURES = new Set<OfficeWarmupFailure>([
  'font-catalog',
  'font-read',
  'runtime-assets',
  'runtime-initialization',
  'runtime-execution'
])

export function officeWarmupProgress(status: OfficeWarmupStatus): number | null {
  if (status.stage === 'ready') return MAX_PROGRESS
  if (status.stage !== 'reading' || status.total < 1) return null
  return Math.min(MAX_PROGRESS, Math.round(status.done / status.total * MAX_PROGRESS))
}

export function shouldShowOfficeWarmup(
  status: OfficeWarmupStatus,
  visible: boolean,
  recovering = false
): boolean {
  return visible || (status.stage === 'error' && !recovering)
}

export function shouldShowOfficeWarmupProgress(status: OfficeWarmupStatus, retrying: boolean): boolean {
  return retrying && status.stage !== 'error' && status.stage !== 'ready'
}

export function isOfficeWarmupSlow(status: OfficeWarmupStatus, elapsedMs: number): boolean {
  return status.stage !== 'ready'
    && status.stage !== 'error'
    && elapsedMs >= OFFICE_WARMUP_SLOW_THRESHOLD_MS
}

export function officeWarmupRetryDelay(
  status: OfficeWarmupStatus,
  attempt: number
): number | null {
  if (
    status.stage !== 'error'
    || !status.error
    || attempt >= OFFICE_WARMUP_MAX_RETRIES
    || !RECOVERABLE_OFFICE_WARMUP_FAILURES.has(status.error)
  ) return null
  return OFFICE_WARMUP_RETRY_DELAYS_MS[Math.max(0, attempt)]
}

export function parseOfficeWarmupStatus(message: Record<string, unknown>): OfficeWarmupStatus | null {
  const stage = String(message.stage) as OfficeWarmupStage
  if (!OFFICE_WARMUP_STAGES.has(stage)) return null
  const reportedFailure = String(message.error ?? '') as OfficeWarmupFailure
  const error = stage === 'error'
    ? OFFICE_WARMUP_FAILURES.has(reportedFailure) ? reportedFailure : 'runtime-execution'
    : undefined
  return {
    stage,
    done: Number(message.done ?? 0),
    total: Number(message.total ?? 0),
    loadedBytes: Number(message.loadedBytes ?? 0),
    ...(error ? { error } : {}),
    ...(typeof message.detail === 'string' ? { detail: message.detail } : {})
  }
}
