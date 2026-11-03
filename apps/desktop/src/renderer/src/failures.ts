import type { TFunction } from 'i18next'
import type { ModelInfo } from './api'
import type { ConvItem } from './model'

export type ProviderFailureKind =
  | 'capability'
  | 'quota'
  | 'credits'
  | 'rate_limit'
  | 'auth'
  | 'request'
  | 'model_config'
  | 'unavailable'
  | 'overloaded'
  | 'content_policy'

const QUOTA_FAILURE =
  /(?:insufficient|exceeded).*(?:balance|quota|credit)|(?:balance|quota|credit).*(?:insufficient|exceeded)|余额|额度/i
const AUTH_FAILURE = /status=(?:401|403)\b|unauthori[sz]ed|forbidden|api[ _-]?key/i
const UNAVAILABLE_FAILURE =
  /status=(?:408|429|500|502|503|504)\b|timeout|timed out|connection|network|unavailable|overloaded|temporar/i
const REQUEST_FAILURE = /status=400\b|badrequest|bad request|invalid.?request/i
const PROVIDER_FRAME_EVENT = 'event:error'
const PROVIDER_FRAME_DATA = 'data:'
const ACCOUNT_AUTH_FAILURE_CODE = 'model_bridge_credential_required'
const GATEWAY_CREDENTIAL_REQUIRED_CODE = 'gateway_credential_required'
export const SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE =
  'subscription_sharing_unsupported_capability'
const RECOVERABLE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'unavailable',
  'overloaded',
  'rate_limit',
  'unknown',
])
const FAILURE_KIND_BY_CODE: Readonly<Partial<Record<string, ProviderFailureKind>>> = {
  [SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE]: 'capability',
  content_safety_blocked: 'content_policy',
  content_policy_violation: 'content_policy',
  content_filter: 'content_policy',
  insufficient_quota: 'quota',
  'throttling.allocationquota': 'quota',
  credit_balance_exhausted: 'credits',
  rate_limit_error: 'rate_limit',
  rate_limit_exceeded: 'rate_limit',
  'throttling.ratelimit': 'rate_limit',
  'throttling.requestsratelimit': 'rate_limit',
  authentication_error: 'auth',
  invalid_api_key: 'auth',
  model_bridge_credential_required: 'auth',
  permission_denied: 'auth',
  runtime_not_authenticated: 'auth',
  unauthorized: 'auth',
  bad_request: 'request',
  invalid_request_error: 'request',
  invalidparameter: 'model_config',
  model_not_found: 'model_config',
  unsupported_model: 'model_config',
  overloaded: 'overloaded',
  server_error: 'unavailable',
  server_is_overloaded: 'overloaded',
  service_unavailable: 'unavailable',
  timeout: 'unavailable',
}

function providerFrame(message: string): { code: string; message: string } | null {
  const lines = message.split(/\r?\n/)
  if (!lines.some((line) => line.trim().toLowerCase() === PROVIDER_FRAME_EVENT)) return null
  const data = lines
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(PROVIDER_FRAME_DATA))
    .map((line) => line.slice(PROVIDER_FRAME_DATA.length).trimStart())
    .join('\n')
  try {
    const parsed = JSON.parse(data) as { code?: unknown; message?: unknown }
    return {
      code: typeof parsed.code === 'string' ? parsed.code.trim() : '',
      message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    }
  } catch {
    return { code: '', message: '' }
  }
}

function fallbackKind(message: string): ProviderFailureKind | undefined {
  if (QUOTA_FAILURE.test(message)) return 'quota'
  if (AUTH_FAILURE.test(message)) return 'auth'
  if (UNAVAILABLE_FAILURE.test(message)) return 'unavailable'
  if (REQUEST_FAILURE.test(message)) return 'request'
  return undefined
}

const FAILURE_TEXT = {
  capability: { messageKey: 'failure.capability.message', actionKey: 'failure.capability.action' },
  content_policy: {
    messageKey: 'failure.contentPolicy.message',
    actionKey: 'failure.contentPolicy.message',
  },
  quota: { messageKey: 'failure.quota.message', actionKey: 'failure.quota.action' },
  credits: { messageKey: 'failure.credits.message', actionKey: 'failure.credits.action' },
  rate_limit: { messageKey: 'failure.rateLimit.message', actionKey: 'failure.rateLimit.action' },
  auth: { messageKey: 'failure.auth.message', actionKey: 'failure.auth.action' },
  unavailable: {
    messageKey: 'failure.unavailable.message',
    exhaustedKey: 'failure.unavailable.exhausted',
    actionKey: 'failure.unavailable.action',
  },
  overloaded: {
    messageKey: 'failure.overloaded.message',
    exhaustedKey: 'failure.overloaded.exhausted',
    actionKey: 'failure.overloaded.action',
  },
  request: { messageKey: 'failure.request.message', actionKey: 'failure.request.action' },
  model_config: {
    messageKey: 'failure.modelConfig.message',
    actionKey: 'failure.modelConfig.action',
  },
  unknown: { messageKey: 'failure.unknown.message', actionKey: 'failure.unknown.action' },
} as const

export function describeTurnFailure(data: {
  code?: string
  provider_error_code?: string
  message?: string
  retryable?: boolean
  automatic_retry_attempts?: number
}): Extract<ConvItem, { kind: 'error' }> {
  const rawMessage = String(data.message || '').trim()
  const frame = providerFrame(rawMessage)
  const providerCode = String(data.provider_error_code || '')
    .trim()
    .toLowerCase()
  const code =
    providerCode === SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE
      ? providerCode
      : String(data.code || frame?.code || '').trim()
  const classified = Object.prototype.hasOwnProperty.call(FAILURE_KIND_BY_CODE, code.toLowerCase())
    ? FAILURE_KIND_BY_CODE[code.toLowerCase()]
    : undefined
  const kind = classified || fallbackKind(frame ? frame.message : rawMessage) || 'unknown'
  const fallback = frame ? 'frame' : data.message ? 'raw' : 'runtime'
  const retry =
    kind === 'auth' ||
    (data.retryable === true &&
      (kind === 'rate_limit' ||
        kind === 'unavailable' ||
        kind === 'overloaded' ||
        kind === 'unknown'))
      ? { runtimeAction: 'continue_turn' as const, actionState: 'idle' as const }
      : {}
  const automaticRetryAttempts =
    Number.isInteger(data.automatic_retry_attempts) && Number(data.automatic_retry_attempts) > 1
      ? Number(data.automatic_retry_attempts)
      : undefined
  return {
    kind: 'error',
    title: '',
    action: '',
    message: kind === 'unknown' && fallback === 'raw' ? rawMessage : '',
    failure: {
      kind,
      fallback,
      ...(kind === 'auth'
        ? {
            authentication:
              code.toLowerCase() === ACCOUNT_AUTH_FAILURE_CODE
                ? ('account' as const)
                : ('model' as const),
          }
        : {}),
      ...(automaticRetryAttempts ? { automaticRetryAttempts } : {}),
    },
    ...retry,
  }
}

export function isRecoverableTurnFailure(item: Extract<ConvItem, { kind: 'error' }>): boolean {
  return (
    item.runtimeAction === 'continue_turn' &&
    !item.turnUnknown &&
    !item.applicationFailure &&
    Boolean(item.failure && RECOVERABLE_FAILURE_KINDS.has(item.failure.kind))
  )
}

export function authenticationRecoveryAction(
  failure: Extract<ConvItem, { kind: 'error' }>,
  model: Pick<ModelInfo, 'source' | 'disabled' | 'disabled_reason_code'> | undefined,
  authenticated: boolean
): 'login' | 'configure' | 'continue_turn' {
  if (
    model?.disabled_reason_code === GATEWAY_CREDENTIAL_REQUIRED_CODE ||
    (!model && !authenticated && failure.failure?.authentication === 'account')
  )
    return 'login'
  if (!model || model.disabled) return 'configure'
  return 'continue_turn'
}

export function formatTurnFailure(
  item: Extract<ConvItem, { kind: 'error' }>,
  t: TFunction<'conversation'>
): { title: string; message: string; action: string } {
  if (!item.failure) return item
  const labels = FAILURE_TEXT[item.failure.kind]
  const exhaustedKey = 'exhaustedKey' in labels ? labels.exhaustedKey : undefined
  const automaticRetryAttempts = exhaustedKey ? item.failure.automaticRetryAttempts : undefined
  return {
    title: t('failure.title'),
    action: t(labels.actionKey),
    message:
      automaticRetryAttempts !== undefined && exhaustedKey
        ? t(exhaustedKey, { count: automaticRetryAttempts })
        : item.failure.kind !== 'unknown'
          ? t(labels.messageKey)
          : item.failure.fallback === 'frame'
            ? t('failure.frame')
            : t(labels.messageKey),
  }
}

// Compatibility identities for error cards already projected by older renderer versions.
// These strings are never used to generate new UI messages.
const LEGACY_FAILURE_MESSAGES = {
  capability: SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE,
  content_policy: '',
  model_config: '',
  quota: '模型分配额度已用完。',
  credits: '积分余额已用尽，本次生成已停止。',
  rate_limit: '模型请求过于频繁，请稍后再试。',
  auth: '模型服务认证失败。',
  unavailable: '模型服务暂时不可用。',
  overloaded: '上游模型服务返回过载。',
  request: '当前请求未被模型服务接受。',
  frame: '模型服务返回了无法识别的错误。',
  runtime: '请求未能到达 Codex Runtime。',
} as const

function legacyFailureMessage(item: Extract<ConvItem, { kind: 'error' }>): string {
  if (!item.failure) return item.message
  if (item.failure.kind !== 'unknown') return LEGACY_FAILURE_MESSAGES[item.failure.kind]
  return item.failure.fallback === 'raw'
    ? item.message
    : LEGACY_FAILURE_MESSAGES[item.failure.fallback]
}

/** Compare semantic messages, without translation or descriptor object identity. */
export function sameTurnFailureMessage(
  left: Extract<ConvItem, { kind: 'error' }>,
  right: Extract<ConvItem, { kind: 'error' }>
): boolean {
  if (!left.failure || !right.failure)
    return legacyFailureMessage(left) === legacyFailureMessage(right)
  if (left.failure.kind !== right.failure.kind) return false
  return (
    left.failure.kind !== 'unknown' ||
    (left.failure.fallback === right.failure.fallback && left.message === right.message)
  )
}
