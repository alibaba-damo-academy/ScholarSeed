export const HOST_CONFIGURATION_CONFLICT = 'runtime_host_configuration_conflict'
export const HOST_CONFIGURATION_UNCERTAIN = 'runtime_host_configuration_uncertain'
export const RECONFIGURATION_POLL_MS = 500
export const RECONFIGURATION_REQUEST_TIMEOUT_MS = 10000
export const RECONFIGURATION_MAX_FAILURES = 4
const RECONFIGURATION_BACKOFF_FACTOR = 2
const RECONFIGURATION_SERVER_ERROR_STATUS = 500
const RECONFIGURATION_RETRYABLE_STATUSES = new Set([408, 425, 429])
export const RECONFIGURATION_ERRORS = {
  stale: 'runtime_reconfiguration_stale',
  resourceWaitTimeout: 'runtime_resource_wait_timeout',
  hostBusy: 'runtime_host_busy',
} as const

export class ReconfigurationQueryError extends Error {
  constructor(readonly status?: number) {
    super('runtime_reconfiguration_unknown')
  }

  get retryable(): boolean {
    return (
      this.status !== undefined &&
      (this.status >= RECONFIGURATION_SERVER_ERROR_STATUS ||
        RECONFIGURATION_RETRYABLE_STATUSES.has(this.status))
    )
  }
}

export function reconfigurationRetryDelay(
  error: unknown,
  failureCount: number
): number | undefined {
  if (failureCount < 1 || failureCount >= RECONFIGURATION_MAX_FAILURES) return undefined
  if (error instanceof ReconfigurationQueryError && !error.retryable) return undefined
  return RECONFIGURATION_POLL_MS * RECONFIGURATION_BACKOFF_FACTOR ** (failureCount - 1)
}

const RECONFIGURATION_FAILURE_STATES = ['rejected', 'restart_required', 'unsupported'] as const
const RECONFIGURATION_STATES = ['accepted', 'applied', ...RECONFIGURATION_FAILURE_STATES] as const

export type ReconfigurationFailureState = (typeof RECONFIGURATION_FAILURE_STATES)[number]

export interface ReconfigurationOperation {
  session_id: string
  request_id: string
  model_id: string
  state: (typeof RECONFIGURATION_STATES)[number]
  error: string
}

export function readReconfigurationFailureState(
  value: unknown
): ReconfigurationFailureState | undefined {
  return RECONFIGURATION_FAILURE_STATES.find((state) => state === value)
}

export function isReconfigurationState(value: unknown): value is ReconfigurationOperation['state'] {
  return RECONFIGURATION_STATES.some((state) => state === value)
}

const REQUEST_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export const RECONFIGURATION_RECOVERY = {
  proceed: 'proceed',
  wait: 'wait',
  blocked: 'blocked',
} as const

export function reconfigurationRecovery(
  state: ReconfigurationOperation['state'] | null | undefined,
  waiting: boolean
): (typeof RECONFIGURATION_RECOVERY)[keyof typeof RECONFIGURATION_RECOVERY] {
  if (state === 'restart_required') return RECONFIGURATION_RECOVERY.blocked
  if (state === 'accepted' || (state === undefined && waiting)) return RECONFIGURATION_RECOVERY.wait
  return RECONFIGURATION_RECOVERY.proceed
}

export function readRuntimeReconfiguration(
  value: unknown,
  sessionId: string,
  requestId?: string
): ReconfigurationOperation {
  const result = value as ReconfigurationOperation | null
  if (
    !result ||
    result.session_id !== sessionId ||
    typeof result.request_id !== 'string' ||
    !REQUEST_ID_PATTERN.test(result.request_id) ||
    (requestId !== undefined && result.request_id !== requestId) ||
    typeof result.model_id !== 'string' ||
    !result.model_id ||
    typeof result.error !== 'string' ||
    !isReconfigurationState(result.state)
  ) {
    throw new ReconfigurationQueryError()
  }
  return result
}
