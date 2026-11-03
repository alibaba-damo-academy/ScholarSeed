import {
  INITIAL_OFFICE_WARMUP_STATUS,
  officeWarmupRetryDelay,
  type OfficeWarmupStatus,
} from './progress.ts'

const FAILURE_CODES = {
  warmupTimeout: 'warmup-timeout',
} as const

export interface OfficeRecovery {
  status: OfficeWarmupStatus
  attempt: number
  retryAt: number | null
}

export type OfficeRecoveryEvent =
  | { type: 'status'; status: OfficeWarmupStatus; now: number }
  | { type: 'retry' }
  | { type: 'reset' }
  | { type: 'timeout' }

export const OFFICE_PROGRESS_TICK_MS = 1000
export const INITIAL_OFFICE_RECOVERY: OfficeRecovery = {
  status: INITIAL_OFFICE_WARMUP_STATUS,
  attempt: 0,
  retryAt: null,
}

export function officeRecovery(state: OfficeRecovery, event: OfficeRecoveryEvent): OfficeRecovery {
  if (event.type === 'reset') return INITIAL_OFFICE_RECOVERY
  if (event.type === 'timeout')
    return {
      ...state,
      status: {
        ...INITIAL_OFFICE_WARMUP_STATUS,
        stage: 'error',
        error: FAILURE_CODES.warmupTimeout,
      },
      retryAt: null,
    }
  if (event.type === 'retry')
    return state.retryAt === null
      ? state
      : {
          status: INITIAL_OFFICE_WARMUP_STATUS,
          attempt: state.attempt + 1,
          retryAt: null,
        }
  if (state.status.stage === 'error' && event.status.stage !== 'ready') return state
  const delay = officeWarmupRetryDelay(event.status, state.attempt)
  return { ...state, status: event.status, retryAt: delay === null ? null : event.now + delay }
}

export function officeRetrySeconds(state: OfficeRecovery, now: number): number {
  return state.retryAt === null
    ? 0
    : Math.max(0, Math.ceil((state.retryAt - now) / OFFICE_PROGRESS_TICK_MS))
}
