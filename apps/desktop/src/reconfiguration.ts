export const HOST_CONFIGURATION_CONFLICT = 'runtime_host_configuration_conflict'
export const RECONFIGURATION_POLL_MS = 500
export const RECONFIGURATION_REQUEST_TIMEOUT_MS = 10000

export interface ReconfigurationOperation {
  session_id: string
  request_id: string
  model_id: string
  state: 'accepted' | 'applied' | 'rejected' | 'restart_required' | 'unsupported'
  error: string
}

const REQUEST_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export const RECONFIGURATION_RECOVERY = {
  proceed: 'proceed', wait: 'wait', blocked: 'blocked',
} as const

export function reconfigurationRecovery(
  state: ReconfigurationOperation['state'] | null | undefined, waiting: boolean
): typeof RECONFIGURATION_RECOVERY[keyof typeof RECONFIGURATION_RECOVERY] {
  if (state === 'restart_required') return RECONFIGURATION_RECOVERY.blocked
  if (state === 'accepted' || (state === undefined && waiting)) return RECONFIGURATION_RECOVERY.wait
  return RECONFIGURATION_RECOVERY.proceed
}

export function readRuntimeReconfiguration(
  value: unknown, sessionId: string, requestId?: string
): ReconfigurationOperation {
  const result = value as ReconfigurationOperation | null
  if (!result || result.session_id !== sessionId
    || typeof result.request_id !== 'string' || !REQUEST_ID_PATTERN.test(result.request_id)
    || (requestId !== undefined && result.request_id !== requestId)
    || typeof result.model_id !== 'string' || !result.model_id
    || typeof result.error !== 'string'
    || !['accepted', 'applied', 'rejected', 'restart_required', 'unsupported'].includes(result.state)) {
    throw new Error('runtime_reconfiguration_unknown')
  }
  return result
}
