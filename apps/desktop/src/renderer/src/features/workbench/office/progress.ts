export type OfficeWarmupStage = 'permission' | 'catalog' | 'reading' | 'runtime' | 'ready' | 'error'

export interface OfficeWarmupStatus {
  stage: OfficeWarmupStage
  done: number
  total: number
  loadedBytes: number
  error?: string
}

export const INITIAL_OFFICE_WARMUP_STATUS: OfficeWarmupStatus = {
  stage: 'permission',
  done: 0,
  total: 0,
  loadedBytes: 0
}

const MAX_PROGRESS = 100
const OFFICE_WARMUP_STAGES = new Set<OfficeWarmupStage>([
  'permission',
  'catalog',
  'reading',
  'runtime',
  'ready',
  'error'
])

export function officeWarmupProgress(status: OfficeWarmupStatus): number | null {
  if (status.stage === 'ready') return MAX_PROGRESS
  if (status.stage !== 'reading' || status.total < 1) return null
  return Math.min(MAX_PROGRESS, Math.round(status.done / status.total * MAX_PROGRESS))
}

export function shouldShowOfficeWarmup(status: OfficeWarmupStatus, retrying: boolean): boolean {
  return retrying || status.stage === 'error'
}

export function shouldShowOfficeWarmupProgress(status: OfficeWarmupStatus, retrying: boolean): boolean {
  return retrying && status.stage !== 'error' && status.stage !== 'ready'
}

export function parseOfficeWarmupStatus(message: Record<string, unknown>): OfficeWarmupStatus | null {
  const stage = String(message.stage) as OfficeWarmupStage
  if (!OFFICE_WARMUP_STAGES.has(stage)) return null
  return {
    stage,
    done: Number(message.done ?? 0),
    total: Number(message.total ?? 0),
    loadedBytes: Number(message.loadedBytes ?? 0),
    ...(typeof message.error === 'string' ? { error: message.error } : {})
  }
}
