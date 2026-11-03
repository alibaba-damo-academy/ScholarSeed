import type { PluginReference, PluginReport } from '../../plugins'
import { resolveContentResponse } from './app/api/content.ts'
import { feedback, type FeedbackDescriptor } from './contracts/feedback.ts'
import { apiBase, apiFetch, getJson, postJson, LIVE_CATALOG_REQUEST } from './app/api/client.ts'
import { flushApiDiagnostics, reportApiFailure } from './app/api/diagnostics.ts'
import { MODEL_PROFILES_PATH, MODEL_PROVIDERS_PATH, SESSION_CATALOG_PATH } from '../../requests.ts'
import { sessionTitleFallback } from './session.ts'
import { ATTENTION_PATH } from '../../attention.ts'
import { FEEDBACK_LIMITS, type FeedbackSubmissionResult } from '../../feedback.ts'
import type { SessionTitleFallback } from './session'
import type { ContextLabelFallback } from './contracts/assistant'
// api.ts — ASP client (HTTP/SSE) to the backend the Electron main spawned.
// Same-origin in prod (backend serves the renderer); dev uses the CORS-allowed
// Vite origin. M4 wires the live turn loop; the structure is here so wiring is
// thin. All endpoints are the /api/serve surface (proposal 12/23).

import type {
  ApplicationRequestFailure,
  AnswerSource,
  AnswerCoverage,
  SearchSource,
  EvidenceAnnotation,
  ModelRun,
  RuntimeCapabilities,
  RuntimeCapabilityRequirement,
  RuntimeReadiness,
  RuntimeSnapshot,
  SessionArtifact,
  NativeActivityCategory,
  TodoItemUI,
  WebSearchAction,
  WebSearchResult,
} from './model'
import {
  SKILL_CATALOG_CHANGED_EVENT,
  type DeviceSkillRequest,
  type SkillSurface,
} from '../../skills.ts'
import {
  mcpSettingsRequest,
  type McpSettingsRequest,
  type ConnectorAction,
} from '../../mcp-settings.ts'

const FAILURE_CODES = {
  invalidRecoveryCheck: 'invalid_recovery_check',
} as const
import {
  RECONFIGURATION_REQUEST_TIMEOUT_MS,
  readRuntimeReconfiguration,
  type ReconfigurationOperation,
} from '../../reconfiguration.ts'

// fetch 自身永不超时。恢复链路 (open + history) 是「正在恢复对话」加载态的唯一写回方,
// 请求一挂住就没人能把界面从加载态里放出来, 所以这条链路必须自己封顶。
// 但这个截止时间**不得早于服务端冷恢复自身的预算** (readiness 预检 CODEX_PREFLIGHT_TIMEOUT_SECONDS
// 10s + 整体恢复 CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS 60s = 70s): 否则一次合法但耗时 20–70s 的冷
// 恢复会先被客户端 abort, 报「signal timed out」并盲目重试, 把正常慢恢复呈现为失败 (Aone #87119853)。
// 取值与同仓参考客户端 apps/serve/service/cli/serve.py 对同一端点用的 timeout=120 对齐为单一口径;
// 「渲染端截止 >= 服务端自预算」这一不变量由 tests/contract_resume_deadline.py 守卫, 防止两侧再漂移。
const RESUME_REQUEST_TIMEOUT_MS = 120_000
const SESSION_LIST_DEFAULT_LIMIT = 60
const SESSION_LIST_DEFAULT_SCOPE: SessionListScope = 'all'
const REQUEST_TIMEOUT_MESSAGE = 'request_timeout'
const REQUEST_FAILED_MESSAGE = 'request failed'
const ATTENTION_REQUEST_TIMEOUT_MS = 10_000
const CONTINUATION_PREVIEW_TIMEOUT_MS = 10_000
const CONTINUATION_INVALID_RESPONSE = 'session_continuation_invalid'
const CONTINUATION_UNAVAILABLE = 'session_continuation_unavailable'
const BACKEND_HEALTH_PATH = '/api/healthz/backend'
const BACKEND_HEALTH_UNSUPPORTED_STATUSES = new Set([404, 405])

export { apiFetch }

/** 超时/中断与其它传输失败必须可区分，否则重试提示会把超时说成「请求失败」。 */
function describeRequestFailure(error: unknown): {
  message: string
  applicationFailure?: ApplicationRequestFailure
} {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return {
      message: REQUEST_TIMEOUT_MESSAGE,
      applicationFailure: { key: 'request.timeout', diagnostic: error.message || undefined },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return message
    ? { message }
    : { message: REQUEST_FAILED_MESSAGE, applicationFailure: { key: 'request.failed' } }
}
/** Display-only adapter: never replaces the API's error/code control values. */
export function requestFailureFeedback(
  message: ApplicationRequestFailure
): Extract<FeedbackDescriptor, { ns: 'conversation' }> {
  return message.key === 'request.httpFailure'
    ? feedback('conversation', 'request.httpFailure', { status: message.status ?? 0 })
    : feedback('conversation', message.key)
}

export interface BackendHealthResp {
  ok: boolean
  product?: string
  serve?: boolean
  stack?: string
  runtime_id: 'codex'
  service_instance_id?: string
  workbench_ready: boolean
}

export interface HealthResp extends BackendHealthResp {
  runtime: RuntimeSnapshot
  readiness: RuntimeReadiness
  capabilities: RuntimeCapabilities
}

export async function getBackendHealth(
  signal: AbortSignal = AbortSignal.timeout(RECONFIGURATION_REQUEST_TIMEOUT_MS)
): Promise<BackendHealthResp | null> {
  try {
    const response = await apiFetch(BACKEND_HEALTH_PATH, { signal })
    if (BACKEND_HEALTH_UNSUPPORTED_STATUSES.has(response.status)) return await getHealth(signal)
    if (!response.ok) return null
    return (await response.json()) as BackendHealthResp
  } catch {
    return null
  }
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResp | null> {
  try {
    const r = await apiFetch('/api/healthz', { signal })
    if (!r.ok) return null
    return (await r.json()) as HealthResp
  } catch {
    return null
  }
}

export type PendingHIL = ProductHilData & {
  turn_id?: string
  item_id?: string
}
export type UncertainOperationKind = 'turn' | 'hil_response' | 'tool_response'
export type UncertainOperationState = 'executing' | 'unknown' | 'stale'
export interface UncertainOperationSnapshot {
  kind: UncertainOperationKind
  uncertainty_kind: UncertainOperationKind
  correlation_id: string
  incident_id: string
  process_generation: number
  state: UncertainOperationState
  operation_state: UncertainOperationState
  /** Ambiguous delivery is never safe for an automatic retry. */
  retryable: false
  execution_count: number
  /** Allow-listed runtime classification used to explain a recovered ambiguous turn. */
  safe_error?: string
  turn_id?: string
  item_id?: string
  /** Service-owned, allow-listed card projection; raw arguments/responses never cross this edge. */
  hil?: ProductHilData
  resolved_at?: number | null
}
export type ContextChannelSnapshot = Record<string, unknown> & {
  channel: string
  entries: unknown[]
}
const SESSION_TURN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'unknown_outcome',
  'unknown_confirmed',
] as const
const SESSION_TURN_STATUS_VALUES: ReadonlySet<string> = new Set(SESSION_TURN_STATUSES)
export type SessionTurnStatus = (typeof SESSION_TURN_STATUSES)[number]
export interface OpenResp {
  title?: string
  title_fallback?: SessionTitleFallback
  session_id: string
  runtime_id: 'codex'
  runtime: RuntimeSnapshot
  readiness: RuntimeReadiness
  capabilities: RuntimeCapabilities
  workdir?: string
  runtime_workdir?: string
  project_path?: string | null
  resumed?: boolean
  last_seq?: number
  pending_hil?: PendingHIL[]
  /** Durable operations skipped when SSE resumes from last_seq. */
  uncertain_operations: UncertainOperationSnapshot[]
  /** Admission gate for a turn whose terminal outcome cannot be proven. */
  unknown_outcome: boolean
  /** Exact vendor turn that is still running after a process/session resume. */
  active_turn_id: string | null
  /** Full server snapshot for channels skipped by last_seq SSE resume. */
  context_channels?: ContextChannelSnapshot[]
  /** Connection ownership is frozen when the session is created. */
  billing_mode?: 'managed' | 'personal'
  /** Runtime snapshot paired with last_seq; see live.ts resume logic. */
  running: boolean
  recovery_blocked?: boolean
  recovery_incident_id?: string | null
  recovery_source_seq?: number | null
  recovery_pending?: boolean
  interrupting?: boolean
  last_interrupt_succeeded?: boolean | null
  todos?: TodoItemUI[]
  /** Turn that owns the complete plan snapshot; null means there is no plan. */
  todo_turn_id?: string | null
  /** Latest durable vendor turn and terminal status from the session catalog. */
  last_turn_id?: string | null
  last_turn_status?: SessionTurnStatus | null
  artifacts?: SessionArtifact[]
}
export interface OpenErrorResp {
  applicationFailure?: ApplicationRequestFailure
  session_id?: undefined
  last_seq?: undefined
  pending_hil?: undefined
  status: number
  error: string
  detail: string
  /** Stable Service error code. Never infer this value from localized detail text. */
  code?: string
  runtimeReadiness?: RuntimeReadiness
}

export interface AssistantContextFailureIssue {
  /** Response provenance inherited from a validated anchored Ref; anchor content is not exposed here. */
  selection_source_label?: string
  label_fallback?: ContextLabelFallback
  ref_id: string
  kind: string
  label: string
  state: string
  reason: string
}

export interface ServiceErrorDetail {
  applicationFailure?: ApplicationRequestFailure
  message: string
  code?: string
  readiness?: RuntimeReadiness
  operationState?: string
  issues?: AssistantContextFailureIssue[]
}

export async function serviceErrorDetail(r: Response): Promise<ServiceErrorDetail> {
  const fallback = r.clone()
  try {
    const j = (await r.json()) as {
      detail?: unknown
      error?: unknown
      code?: unknown
      readiness?: RuntimeReadiness
      operation?: { state?: unknown }
      issues?: unknown
    }
    const code =
      typeof j.code === 'string'
        ? j.code
        : typeof j.error === 'string'
          ? j.error
          : typeof j.detail === 'object' && j.detail !== null && 'code' in j.detail
            ? String((j.detail as { code?: unknown }).code ?? '') || undefined
            : undefined
    const message =
      typeof j.detail === 'string'
        ? j.detail
        : typeof j.error === 'string'
          ? j.error
          : j.detail != null
            ? JSON.stringify(j.detail)
            : JSON.stringify(j)
    const issues = Array.isArray(j.issues)
      ? j.issues.flatMap((value): AssistantContextFailureIssue[] => {
          if (!value || typeof value !== 'object') return []
          const issue = value as Record<string, unknown>
          if (
            typeof issue.ref_id !== 'string' ||
            typeof issue.kind !== 'string' ||
            typeof issue.label !== 'string' ||
            typeof issue.state !== 'string' ||
            typeof issue.reason !== 'string'
          )
            return []
          return [
            {
              ref_id: issue.ref_id,
              kind: issue.kind,
              label: issue.label,
              ...((issue.kind === 'selection' || issue.kind === 'literature') &&
              typeof issue.selection_source_label === 'string'
                ? { selection_source_label: issue.selection_source_label }
                : {}),
              ...(issue.kind === 'session' &&
              (issue.label_fallback === 'untitled_session' ||
                issue.label_fallback === 'new_session' ||
                issue.label_fallback === null)
                ? { label_fallback: issue.label_fallback }
                : {}),
              state: issue.state,
              reason: issue.reason,
            },
          ]
        })
      : undefined
    return {
      message,
      code,
      readiness: j.readiness,
      operationState: typeof j.operation?.state === 'string' ? j.operation.state : undefined,
      issues,
    }
  } catch {
    try {
      const text = await fallback.text()
      if (text.trim()) return { message: text.trim() }
    } catch {
      /* ignore */
    }
  }
  return {
    message: `${r.status} ${r.statusText || 'request failed'}`,
    applicationFailure: { key: 'request.httpFailure', status: r.status, statusText: r.statusText },
  }
}

export function openSessionError(o: OpenResp | OpenErrorResp | null | undefined): string {
  return o && 'error' in o ? o.error : ''
}

const SESSION_RESUME_RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429])
const SESSION_RESUME_MANUAL_READINESS_ACTIONS = new Set<NonNullable<RuntimeReadiness['action']>>([
  'install',
  'login',
  'upgrade',
  'configure',
])
const SESSION_RESUME_TERMINAL_CODES = new Set([
  'invalid_session_open_fields',
  'legacy_session_readonly',
  'resume_session_fields_immutable',
  'runtime_id_mismatch',
  'session_model_unavailable',
  'session_not_found',
])

const UNCERTAIN_OPERATION_KINDS = new Set<UncertainOperationKind>([
  'turn',
  'hil_response',
  'tool_response',
])
const UNCERTAIN_OPERATION_STATES = new Set<UncertainOperationState>([
  'executing',
  'unknown',
  'stale',
])
const INVALID_SESSION_RECOVERY_SNAPSHOT_CODE = 'invalid_session_recovery_snapshot'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : null
}

function parseSafeHil(value: unknown, correlationId: string): ProductHilData | null {
  if (!isRecord(value)) return null
  if (typeof value.request_id !== 'string' || value.request_id !== correlationId) return null
  if (typeof value.kind !== 'string' || !value.kind) return null
  const stringFields = ['tool_name', 'title', 'body', 'network_target'] as const
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null
  }
  if (value.permissions !== undefined && !isRecord(value.permissions)) return null
  if (
    value.safety_tags !== undefined &&
    (!Array.isArray(value.safety_tags) || value.safety_tags.some((tag) => typeof tag !== 'string'))
  )
    return null
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) ||
      value.options.some(
        (option) =>
          !isRecord(option) ||
          typeof option.id !== 'string' ||
          typeof option.label !== 'string' ||
          (option.description !== undefined && typeof option.description !== 'string')
      ))
  )
    return null
  return {
    request_id: value.request_id,
    kind: value.kind,
    ...(typeof value.tool_name === 'string' ? { tool_name: value.tool_name } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(typeof value.network_target === 'string' ? { network_target: value.network_target } : {}),
    ...(typeof value.target_instance_id === 'string'
      ? { target_instance_id: value.target_instance_id }
      : {}),
    ...(typeof value.target_generation === 'number' && Number.isSafeInteger(value.target_generation)
      ? { target_generation: value.target_generation }
      : {}),
    ...(isRecord(value.permissions) ? { permissions: value.permissions } : {}),
    ...(Array.isArray(value.safety_tags) ? { safety_tags: value.safety_tags as string[] } : {}),
    ...(Array.isArray(value.options)
      ? { options: value.options as { id: string; label: string; description?: string }[] }
      : {}),
  }
}

function parseUncertainOperation(value: unknown): UncertainOperationSnapshot | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  const aliasKind = value.uncertainty_kind
  const state = value.state
  const aliasState = value.operation_state
  if (
    typeof kind !== 'string' ||
    !UNCERTAIN_OPERATION_KINDS.has(kind as UncertainOperationKind) ||
    aliasKind !== kind ||
    typeof state !== 'string' ||
    !UNCERTAIN_OPERATION_STATES.has(state as UncertainOperationState) ||
    aliasState !== state ||
    typeof value.correlation_id !== 'string' ||
    !value.correlation_id ||
    typeof value.incident_id !== 'string' ||
    !Number.isInteger(value.process_generation) ||
    Number(value.process_generation) < 0 ||
    value.retryable !== false ||
    !Number.isInteger(value.execution_count) ||
    Number(value.execution_count) < 0
  )
    return null
  const turnId = optionalString(value.turn_id)
  const itemId = optionalString(value.item_id)
  const safeError = optionalString(value.safe_error)
  if (turnId === null || itemId === null || safeError === null) return null
  const typedKind = kind as UncertainOperationKind
  const hil = value.hil == null ? undefined : parseSafeHil(value.hil, value.correlation_id)
  if (typedKind !== 'turn' && !hil) return null
  if (typedKind === 'turn' && value.hil != null) return null
  if (
    value.resolved_at !== undefined &&
    value.resolved_at !== null &&
    typeof value.resolved_at !== 'number'
  ) {
    return null
  }
  return {
    kind: typedKind,
    uncertainty_kind: typedKind,
    correlation_id: value.correlation_id,
    incident_id: value.incident_id,
    process_generation: Number(value.process_generation),
    state: state as UncertainOperationState,
    operation_state: state as UncertainOperationState,
    retryable: false,
    execution_count: Number(value.execution_count),
    ...(safeError ? { safe_error: safeError } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(itemId ? { item_id: itemId } : {}),
    ...(hil ? { hil } : {}),
    ...(value.resolved_at === undefined ? {} : { resolved_at: value.resolved_at as number | null }),
  }
}

function invalidRecoverySnapshot(): OpenErrorResp {
  return {
    status: 502,
    error: INVALID_SESSION_RECOVERY_SNAPSHOT_CODE,
    detail: INVALID_SESSION_RECOVERY_SNAPSHOT_CODE,
    code: INVALID_SESSION_RECOVERY_SNAPSHOT_CODE,
    applicationFailure: { key: 'request.invalidRecovery' },
  }
}

/** Validate and normalize durable recovery fields before renderer state sees them. */
export function parseOpenSessionResponse(value: unknown): OpenResp | OpenErrorResp {
  if (!isRecord(value) || typeof value.session_id !== 'string' || !value.session_id) {
    return invalidRecoverySnapshot()
  }
  if (
    !Array.isArray(value.uncertain_operations) ||
    typeof value.unknown_outcome !== 'boolean' ||
    typeof value.running !== 'boolean' ||
    (value.recovery_blocked !== undefined && typeof value.recovery_blocked !== 'boolean') ||
    (value.recovery_incident_id != null && typeof value.recovery_incident_id !== 'string') ||
    (value.recovery_source_seq != null &&
      (typeof value.recovery_source_seq !== 'number' ||
        !Number.isSafeInteger(value.recovery_source_seq) ||
        value.recovery_source_seq < 0)) ||
    (value.recovery_pending !== undefined && typeof value.recovery_pending !== 'boolean') ||
    (value.recovery_blocked === true && (value.recovery_pending !== true || value.running)) ||
    (value.active_turn_id !== null &&
      (typeof value.active_turn_id !== 'string' || !value.active_turn_id)) ||
    (typeof value.active_turn_id === 'string' && !value.running) ||
    (value.last_turn_id !== undefined &&
      value.last_turn_id !== null &&
      (typeof value.last_turn_id !== 'string' || !value.last_turn_id)) ||
    (value.last_turn_status !== undefined &&
      value.last_turn_status !== null &&
      (typeof value.last_turn_status !== 'string' ||
        !SESSION_TURN_STATUS_VALUES.has(value.last_turn_status))) ||
    (value.last_turn_id == null) !== (value.last_turn_status == null)
  )
    return invalidRecoverySnapshot()
  const uncertainOperations = value.uncertain_operations.map(parseUncertainOperation)
  if (uncertainOperations.some((operation) => operation === null)) return invalidRecoverySnapshot()
  const hasUnknownTurn = uncertainOperations.some(
    (operation) =>
      operation?.kind === 'turn' &&
      (operation.state === 'executing' || operation.state === 'unknown')
  )
  const hasDurableUnknownTurn = uncertainOperations.some(
    (operation) => operation?.kind === 'turn' && operation.state === 'unknown'
  )
  if (
    (value.unknown_outcome && !hasUnknownTurn) ||
    (!value.unknown_outcome && hasDurableUnknownTurn)
  ) {
    return invalidRecoverySnapshot()
  }
  return {
    ...value,
    uncertain_operations: uncertainOperations as UncertainOperationSnapshot[],
    unknown_outcome: value.unknown_outcome,
    active_turn_id: value.active_turn_id,
  } as unknown as OpenResp
}

export interface SessionResumeFailure {
  applicationFailure?: ApplicationRequestFailure
  message: string
  status: number
  code?: string
  terminal: boolean
}

/** Classify resume failures only from the HTTP contract and stable Service fields. */
export function classifySessionResumeFailure(
  opened: OpenResp | OpenErrorResp | null | undefined
): SessionResumeFailure {
  if (!opened || !('error' in opened)) {
    return {
      message: '',
      code: 'request_unavailable',
      status: 0,
      terminal: false,
      applicationFailure: { key: 'request.unavailable' },
    }
  }
  const clientFailure =
    opened.status >= 400 &&
    opened.status < 500 &&
    !SESSION_RESUME_RETRYABLE_CLIENT_STATUSES.has(opened.status)
  const manualReadiness =
    opened.runtimeReadiness?.action != null &&
    SESSION_RESUME_MANUAL_READINESS_ACTIONS.has(opened.runtimeReadiness.action)
  return {
    message: opened.error || opened.detail || 'request failed',
    ...(opened.applicationFailure
      ? { applicationFailure: opened.applicationFailure }
      : !opened.error && !opened.detail
        ? { applicationFailure: { key: 'request.failed' as const } }
        : {}),
    status: opened.status,
    code: opened.code,
    terminal:
      clientFailure || manualReadiness || SESSION_RESUME_TERMINAL_CODES.has(opened.code ?? ''),
  }
}

export interface SessionContinuationPreview {
  source_session_id: string
  source_product_seq: number
  source_title: string
  project_path: string | null
  model_id: string
  messages: { role: 'user' | 'assistant'; text: string }[]
  included_messages: number
  omitted_messages: number
  omitted_characters: number
  truncated: boolean
  excluded_categories: string[]
}

function validSessionContinuation(
  value: unknown,
  sourceId: string
): value is SessionContinuationPreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as Record<string, unknown>
  const messages = preview.messages
  return (
    preview.source_session_id === sourceId &&
    typeof preview.source_title === 'string' &&
    (preview.project_path === null || typeof preview.project_path === 'string') &&
    typeof preview.model_id === 'string' &&
    Boolean(preview.model_id.trim()) &&
    typeof preview.truncated === 'boolean' &&
    [
      preview.source_product_seq,
      preview.included_messages,
      preview.omitted_messages,
      preview.omitted_characters,
    ].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) &&
    Array.isArray(messages) &&
    messages.length > 0 &&
    preview.included_messages === messages.length &&
    messages.every(
      (message: unknown) =>
        message !== null &&
        typeof message === 'object' &&
        'role' in message &&
        (message.role === 'user' || message.role === 'assistant') &&
        'text' in message &&
        typeof message.text === 'string'
    ) &&
    Array.isArray(preview.excluded_categories) &&
    preview.excluded_categories.every((category: unknown) => typeof category === 'string')
  )
}

export async function getSessionContinuation(
  sourceId: string,
  turnId?: string,
  signal?: AbortSignal
): Promise<SessionContinuationPreview> {
  const query = new URLSearchParams()
  if (turnId) query.set('turn_id', turnId)
  const suffix = query.size ? `?${query.toString()}` : ''
  const timeout = AbortSignal.timeout(CONTINUATION_PREVIEW_TIMEOUT_MS)
  const response = await apiFetch(
    `/api/serve/sessions/${encodeURIComponent(sourceId)}/continuation${suffix}`,
    { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  )
  if (!response.ok) {
    const failure = await serviceErrorDetail(response)
    throw new Error(failure.code || CONTINUATION_UNAVAILABLE)
  }
  let preview: unknown
  try {
    preview = await response.json()
  } catch {
    throw new Error(CONTINUATION_INVALID_RESPONSE)
  }
  if (!validSessionContinuation(preview, sourceId)) throw new Error(CONTINUATION_INVALID_RESPONSE)
  return preview
}

export interface SessionOpenOptions {
  projectPath?: string | null
  resumeSessionId?: string
  forkSessionId?: string
  forkTurnId?: string
  modelId?: string
  reasoningEffort?: string
  permissionMode?: string
  requiredCapabilities?: RuntimeCapabilityRequirement[]
  prepareRuntime?: boolean
  serviceInstanceId?: string
  signal?: AbortSignal
}

/** Project the frozen product-owned session-open contract at one boundary. */
export function buildSessionOpenRequest(opts: SessionOpenOptions = {}): Record<string, unknown> {
  const request: Record<string, unknown> = {}
  if (Object.prototype.hasOwnProperty.call(opts, 'projectPath'))
    request.project_path = opts.projectPath ?? null
  if (opts.resumeSessionId) request.resume_session_id = opts.resumeSessionId
  if (opts.forkSessionId) request.fork_session_id = opts.forkSessionId
  if (opts.forkTurnId) request.fork_turn_id = opts.forkTurnId
  if (opts.modelId) request.model_id = opts.modelId
  if (opts.prepareRuntime) {
    request.prepare_runtime = true
    request.service_instance_id = opts.serviceInstanceId
  }
  if (opts.reasoningEffort) request.reasoning_effort = opts.reasoningEffort
  if (opts.permissionMode) request.permission_mode = opts.permissionMode
  if (opts.requiredCapabilities?.length) {
    request.required_capabilities = [...opts.requiredCapabilities]
  }
  return request
}

export interface AttentionNavigation extends NavigationSession {
  focus: {
    request_id: string | null
    turn_id: string | null
    item_id: string | null
    incident_id?: string | null
    kind: 'waiting' | 'completed' | 'failed' | 'progress' | 'recovery'
  }
}

export async function readAttentionNavigation(id: string): Promise<AttentionNavigation | null> {
  const response = await apiFetch(`${ATTENTION_PATH}/${encodeURIComponent(id)}/navigation`, {
    cache: 'no-store',
    timeoutMs: ATTENTION_REQUEST_TIMEOUT_MS,
  })
  if (!response.ok) return null
  const opened = (await response.json()) as AttentionNavigation
  return opened.session_id && opened.focus ? opened : null
}

export interface NavigationSession {
  session_id: string
  title: string
  title_fallback: SessionTitleFallback
  runtime_workdir: string
  project_path: string | null
  runtime_id: string
  running: boolean
}

/** Navigation restores catalog metadata; only an explicit session action opens a runtime. */
export async function readNavigationSession(
  sessionId: string
): Promise<NavigationSession | OpenErrorResp> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sessionId)}/navigation`,
      { cache: 'no-store', timeoutMs: RESUME_REQUEST_TIMEOUT_MS }
    )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        status: response.status,
        error: failure.message,
        detail: failure.message,
        code: failure.code,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const value: unknown = await response.json()
    if (
      !isRecord(value) ||
      value.session_id !== sessionId ||
      !sessionId ||
      typeof value.title !== 'string' ||
      (value.title_fallback !== null && value.title_fallback !== 'new_session') ||
      typeof value.runtime_workdir !== 'string' ||
      (value.project_path !== null && typeof value.project_path !== 'string') ||
      typeof value.runtime_id !== 'string' ||
      !value.runtime_id ||
      typeof value.running !== 'boolean'
    )
      return invalidRecoverySnapshot()
    return {
      session_id: sessionId,
      title: value.title,
      title_fallback: value.title_fallback,
      runtime_workdir: value.runtime_workdir,
      project_path: value.project_path,
      runtime_id: value.runtime_id,
      running: value.running,
    }
  } catch (error) {
    const failure = describeRequestFailure(error)
    return {
      status: 0,
      error: failure.message,
      detail: failure.message,
      ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
    }
  }
}

export async function openSession(
  opts: SessionOpenOptions = {}
): Promise<OpenResp | OpenErrorResp | null> {
  try {
    const request = buildSessionOpenRequest(opts)
    const r = await apiFetch('/api/serve/sessions/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(RESUME_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(RESUME_REQUEST_TIMEOUT_MS),
    })
    if (!r.ok) {
      if (r.status === 401) {
        window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
        return {
          status: 401,
          error: 'authentication required',
          detail: 'authentication required',
          applicationFailure: { key: 'request.authentication' },
        }
      }
      const failure = await serviceErrorDetail(r)
      return {
        status: r.status,
        error: failure.message,
        detail: failure.message,
        code: failure.code,
        runtimeReadiness: failure.readiness,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    return parseOpenSessionResponse(await r.json())
  } catch (e) {
    const failure = describeRequestFailure(e)
    const error = failure.message
    return {
      status: 0,
      error,
      detail: error,
      ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      ...(e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
        ? { code: REQUEST_TIMEOUT_MESSAGE }
        : {}),
    }
  }
}

export interface ServeSession {
  archived?: boolean
  last_turn_status?: SessionTurnStatus | null
  title_fallback?: SessionTitleFallback
  session_id: string
  runtime_id: 'codex'
  runtime: RuntimeSnapshot
  readiness: RuntimeReadiness | null
  capabilities: RuntimeCapabilities
  /** Durable creation order from the serve session registry (Unix seconds). */
  created_at?: number
  /** Durable last activity used for read/unread completion projection. */
  mtime?: number
  /** Last nonempty Agent reply in the product event log (Unix seconds). */
  last_agent_reply_at?: number | null
  /** Product-event revision captured with this catalog row. */
  last_seq?: number
  workdir: string
  runtime_workdir?: string
  project_path?: string | null
  title: string
  turns: number
  live: boolean
  running?: boolean
  recovery_blocked?: boolean
  recovery_incident_id?: string | null
  recovery_source_seq?: number | null
  recovery_pending?: boolean
  /** A live run is blocked on a user question or permission decision. */
  waiting?: boolean
  pinned?: boolean
  kind?: string
  match?: {
    count?: number
    excerpt: string
    field: 'title' | 'message'
    role?: string
    turn_id?: string | null
    item_id?: string | null
  }
}

export interface ServeSessionCatalog {
  sessions: ServeSession[]
  total: number
  next_cursor?: string | null
}

export type SessionCatalogFailureKind = 'transport' | 'http' | 'schema'

export interface SessionCatalogFailure {
  kind: SessionCatalogFailureKind
  retryable: boolean
  status?: number
}

export type SessionCatalogLoadResult =
  { ok: true; catalog: ServeSessionCatalog } | { ok: false; failure: SessionCatalogFailure }

export type SessionListScope = 'all' | 'project' | 'unassigned'

export interface SessionListOptions {
  archived?: boolean
  limit?: number
  cursor?: string
  scope?: SessionListScope
  projectPath?: string
  query?: string
  includeAgentReplyAt?: boolean
}

const SESSION_CATALOG_REQUEST_TIMEOUT_STATUS = 408
const SESSION_CATALOG_RATE_LIMIT_STATUS = 429
const SESSION_CATALOG_SERVER_ERROR_MIN_STATUS = 500

export function sessionCatalogHttpFailure(status: number): SessionCatalogFailure {
  return {
    kind: 'http',
    retryable:
      status === SESSION_CATALOG_REQUEST_TIMEOUT_STATUS ||
      status === SESSION_CATALOG_RATE_LIMIT_STATUS ||
      status >= SESSION_CATALOG_SERVER_ERROR_MIN_STATUS,
    status,
  }
}

export function parseSessionCatalog(value: unknown): ServeSession[] | null {
  return parseSessionCatalogResult(value)?.sessions ?? null
}

export function parseSessionCatalogResult(value: unknown): ServeSessionCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null
  if (
    value.next_cursor !== undefined &&
    value.next_cursor !== null &&
    typeof value.next_cursor !== 'string'
  )
    return null
  const sessions = value.sessions as ServeSession[]
  return {
    sessions,
    total: typeof value.total === 'number' ? value.total : sessions.length,
    ...(value.next_cursor !== undefined ? { next_cursor: value.next_cursor as string | null } : {}),
  }
}

async function requestSessionCatalog(
  options: SessionListOptions = {},
  synchronizeRoots = false
): Promise<SessionCatalogLoadResult> {
  const startedAt = performance.now()
  let response: Response | undefined
  try {
    const query = new URLSearchParams({
      limit: String(options.limit ?? SESSION_LIST_DEFAULT_LIMIT),
      scope: options.scope ?? SESSION_LIST_DEFAULT_SCOPE,
    })
    if (options.scope === 'project' && options.projectPath) {
      query.set('project_path', options.projectPath)
    }
    if (options.query?.trim()) query.set('query', options.query.trim())
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.archived !== undefined) query.set('archived', String(options.archived))
    if (options.includeAgentReplyAt) query.set('include_last_agent_reply', 'true')
    response = await apiFetch(`${SESSION_CATALOG_PATH}?${query.toString()}`, LIVE_CATALOG_REQUEST)
    if (!response.ok) {
      // 与本文件其余请求口同一条约定: 401 要广播出去。工作台失败屏靠它区分
      // 「没登录」与「别的故障」, 并据此把动作换成登录而不是无用的重新加载。
      if (response.status === 401)
        window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return { ok: false, failure: sessionCatalogHttpFailure(response.status) }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      reportApiFailure(SESSION_CATALOG_PATH, 'GET', response.status, startedAt, 'decode', error)
      return { ok: false, failure: { kind: 'schema', retryable: false } }
    }
    const catalog = parseSessionCatalogResult(payload)
    if (!catalog) {
      reportApiFailure(SESSION_CATALOG_PATH, 'GET', response.status, startedAt, 'schema')
      return { ok: false, failure: { kind: 'schema', retryable: false } }
    }
    if (synchronizeRoots) syncSessionRoots(catalog.sessions)
    return { ok: true, catalog }
  } catch (error) {
    // apiFetch owns HTTP/transport diagnostics. A received response distinguishes
    // subsequent client processing failures without logging its body or paths.
    if (response)
      reportApiFailure(SESSION_CATALOG_PATH, 'GET', response.status, startedAt, 'projection', error)
    return { ok: false, failure: { kind: 'transport', retryable: true } }
  }
}

function syncSessionRoots(sessions: ServeSession[]): void {
  void window.scholarseed.syncAuthorizedRoots(
    'session',
    sessions.map((session) => session.runtime_workdir || session.workdir).filter(Boolean)
  )
}

export async function loadSessionCatalog(
  options: SessionListOptions = {}
): Promise<SessionCatalogLoadResult> {
  return requestSessionCatalog(options, true)
}

export async function listAllSessions(
  options: SessionListOptions = {},
  active: () => boolean = () => true,
  behavior: { synchronizeRoots?: boolean } = {}
): Promise<ServeSession[] | null> {
  const sessions = new Map<string, ServeSession>()
  const cursors = new Set<string>()
  let cursor = options.cursor
  do {
    const result = await requestSessionCatalog({ ...options, cursor })
    if (!active() || !result.ok) return null
    for (const session of result.catalog.sessions) {
      if (!sessions.has(session.session_id)) sessions.set(session.session_id, session)
    }
    cursor = result.catalog.next_cursor || undefined
    if (cursor && cursors.has(cursor)) return null
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const rows = [...sessions.values()]
  try {
    if (behavior.synchronizeRoots !== false) syncSessionRoots(rows)
    return rows
  } catch {
    return null
  }
}

export async function listSessionCatalog(
  options: SessionListOptions = {}
): Promise<ServeSessionCatalog | null> {
  const result = await loadSessionCatalog(options)
  return result.ok ? result.catalog : null
}

export async function listSessions(
  options: SessionListOptions = {},
  behavior: { synchronizeRoots?: boolean } = {}
): Promise<ServeSession[] | null> {
  const result = await requestSessionCatalog(options, behavior.synchronizeRoots ?? true)
  return result.ok ? result.catalog.sessions : null
}

export interface HistoryMessageReference {
  selection_source_label?: string | null
  label_fallback?: ContextLabelFallback
  type: string
  id: string
  title: string
  status?: string
  path?: string
  media_type?: string
  sha256?: string
  size?: number
  kind?: string
  source_id?: string
  snapshot_id?: string
  source_revision?: string | null
  estimate?: {
    lower_seconds: number
    upper_seconds: number
    sample_count: number
    confidence: 'low' | 'medium' | 'high'
    basis: 'historical_skill_turns' | 'product_baseline'
  }
  model_id?: string
  reasoning_effort?: string
  anchor?: {
    document_id?: string
    preview_text?: string
    locator?: Record<string, unknown>
  } | null
}

export interface HistoryTurn {
  model_run?: ModelRun
  turn_id?: string
  item_id?: string
  kind: string // thinking | text | tool | user
  role?: string
  origin?: 'turn' | 'steer' | 'recovery'
  phase?: 'commentary' | 'final_answer' | null
  name?: string
  text?: string
  evidence_notice?: string
  tool?: string
  // 工具调用历史 (host.history 已带): status 由是否收到匹配 tool_result 决定。
  input?: unknown
  output?: string | null
  ok?: boolean
  exit_code?: number | null
  status?: 'pending' | 'done' | 'error' | 'cancelled'
  rewind_anchor?: number
  refs?: HistoryMessageReference[]
  evidence?: EvidenceAnnotation[]
  preview?: {
    version?: number
    material_id?: string
    revision_id?: string
    path?: string
    title?: string
    media_type?: string
    render_kind?: 'markdown' | 'html' | 'text'
    size?: number
    content?: string
  }
  delivery?: {
    delivery_id?: string
    label?: string
    status?: string
    previous_delivery_id?: string | null
    members?: {
      material_id?: string
      title?: string
      workspace_path?: string
      media_type?: string
      /** Server hydrates this from the durable Material ledger before delivery reaches the renderer. */
      preview_available: boolean
      /** Session-bound preview link, issued by the service at render time. */
      preview_url?: string
      revision?: string
      version_id?: string
      previous_revision?: string | null
      is_primary?: boolean
    }[]
  }
}
export interface HistoryResult {
  turns: HistoryTurn[]
  recovery_blocked?: boolean
  recovery_incident_id?: string | null
  recovery_source_seq?: number | null
  recovery_pending?: boolean
  /** Persisted complete plan snapshot. */
  todos: TodoItemUI[]
  /** Turn that owns the persisted complete plan snapshot. */
  todo_turn_id: string | null
  /** Persisted, source-attributed session artifact snapshot. */
  artifacts: SessionArtifact[]
  /** Ordered message anchors plus durable activity used to rebuild the transcript timeline. */
  activity_events: ProductEvent[]
  /** Durable turn clock and terminal truth, projected from product events. */
  turn_activity: TurnActivitySnapshot[]
}

export interface TurnActivitySnapshot {
  turn_id: string
  started_at: number
  completed_at?: number
  outcome?: 'completed' | 'failed' | 'interrupted' | 'unknown_outcome'
}

/**
 * 历史回放 + 持久化待办。待办只在开会话时需要, 故单独一个入口不扰动 getHistory 调用方。
 * 传输/HTTP 失败返回 null: 空历史与「历史取不到」不能混为一谈, 否则恢复会把有内容的会话
 * 渲染成空白对话。
 */
export async function getHistoryWithTodos(sid: string): Promise<HistoryResult | null> {
  try {
    const r = await apiFetch(`/api/serve/history/${sid}`, { timeoutMs: RESUME_REQUEST_TIMEOUT_MS })
    if (!r.ok) return null
    const data = (await r.json()) as {
      turns?: HistoryTurn[]
      recovery_blocked?: boolean
      recovery_incident_id?: string | null
      recovery_source_seq?: number | null
      recovery_pending?: boolean
      todos?: TodoItemUI[]
      todo_turn_id?: string | null
      artifacts?: SessionArtifact[]
      activity_events?: ProductEvent[]
      turn_activity?: TurnActivitySnapshot[]
    }
    return {
      turns: data.turns ?? [],
      recovery_blocked: data.recovery_blocked === true,
      recovery_incident_id: data.recovery_incident_id ?? null,
      recovery_source_seq: data.recovery_source_seq ?? null,
      recovery_pending: data.recovery_pending === true,
      todos: Array.isArray(data.todos) ? data.todos : [],
      todo_turn_id: data.todo_turn_id ?? null,
      artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
      activity_events: Array.isArray(data.activity_events) ? data.activity_events : [],
      turn_activity: Array.isArray(data.turn_activity) ? data.turn_activity : [],
    }
  } catch {
    return null
  }
}

export interface RewindPromptResponse {
  ok?: boolean
  reason?: string
  anchor?: number
  turns?: HistoryTurn[]
}

export async function rewindToPrompt(
  sid: string,
  anchor: number
): Promise<RewindPromptResponse | null> {
  try {
    const r = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor }),
    })
    return (await r.json()) as RewindPromptResponse
  } catch {
    return null
  }
}

export interface TurnResponse {
  applicationFailure?: ApplicationRequestFailure
  ok?: boolean
  turn_id?: string
  error?: unknown
  code?: string
  /** A server response proves rejection; only a missing response leaves delivery unknown. */
  submissionOutcome?: 'rejected' | 'unknown'
  blocked?: 'interrupting'
  accepted?: boolean
  disposition?: SubmissionMode
  queued_message_id?: string
  queued_depth?: number
  issues?: AssistantContextFailureIssue[]
  preparation_error?: boolean
}

export interface SideTurnResponse {
  applicationFailure?: ApplicationRequestFailure
  ok?: boolean
  queued_depth?: number
  reason?: string
  blocked?: 'interrupting'
  unknownOutcome?: boolean
}

export interface QueuedMessageSendResponse {
  applicationFailure?: ApplicationRequestFailure
  ok?: boolean
  turn_id?: string
  queued_message_id?: string
  error?: unknown
  blocked?: 'interrupting'
}

export const BACKEND_FAILURE_EVENT = 'scholarseed:backend-failure'
export const BACKEND_ADMISSION_FAILURE = 'admission'
const SESSION_INTERRUPTING_ERROR = 'session_interrupting'
const TURN_STEER_OUTCOME_UNKNOWN_ERROR = 'runtime_turn_steer_outcome_unknown'
const QUEUED_MESSAGE_NOT_SENDABLE_ERROR = 'queued_message_not_sendable'

function turnErrorCode(error: unknown): string {
  if (typeof error === 'string') {
    try {
      return turnErrorCode(JSON.parse(error))
    } catch {
      return ''
    }
  }
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; error?: unknown; detail?: unknown }
  if (typeof record.code === 'string') return record.code
  return turnErrorCode(record.error ?? record.detail)
}

export function isQueuedMessageNotSendable(error: unknown): boolean {
  return (
    error === QUEUED_MESSAGE_NOT_SENDABLE_ERROR ||
    turnErrorCode(error) === QUEUED_MESSAGE_NOT_SENDABLE_ERROR
  )
}

function turnErrorText(error: unknown): string {
  if (typeof error === 'string') {
    const text = error.trim()
    if (!text) return ''
    try {
      // HTTP 500 wraps the same terminal SSE error in {error:{message}}.
      // Unwrap it so a fallback report has the same raw message and can be
      // deduplicated against the already-rendered SSE card.
      return turnErrorText(JSON.parse(text))
    } catch {
      return text
    }
  }
  if (error && typeof error === 'object') {
    const record = error as {
      error?: unknown
      message?: unknown
      detail?: unknown
      reason?: unknown
    }
    for (const value of [record.error, record.message, record.detail, record.reason]) {
      if (value != null) return turnErrorText(value)
    }
  }
  if (error != null) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return ''
}

export interface BackendFailureDetail {
  applicationFailure?: ApplicationRequestFailure
  sessionId: string
  message: string
  scope?: typeof BACKEND_ADMISSION_FAILURE
  code?: string
  issues?: AssistantContextFailureIssue[]
}

function publishBackendFailure(
  sessionId: string,
  error: unknown,
  scope?: typeof BACKEND_ADMISSION_FAILURE,
  applicationFailure?: ApplicationRequestFailure
): void {
  const structured =
    error && typeof error === 'object' ? (error as Partial<ServiceErrorDetail>) : null
  window.dispatchEvent(
    new CustomEvent(BACKEND_FAILURE_EVENT, {
      detail: {
        sessionId,
        message: turnErrorText(error),
        scope,
        code: typeof structured?.code === 'string' ? structured.code : undefined,
        issues: Array.isArray(structured?.issues) ? structured.issues : undefined,
        ...(applicationFailure ? { applicationFailure } : {}),
      } satisfies BackendFailureDetail,
    })
  )
}

export type TurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; path: string; version?: string }
  | {
      type: 'local_image'
      path?: string
      reference_id?: string
      name?: string
      media_type?: string
      sha256?: string
    }
  | {
      type: 'file'
      path?: string
      reference_id?: string
      name?: string
      media_type?: string
      sha256?: string
    }
  | { type: 'directory'; reference_id: string; name?: string }

export type CollaborationMode = 'default' | 'plan'
export const RESEARCH_IDEA_TASK_TYPE = 'research_idea' as const
export const PRECISE_SEARCH_TASK_TYPE = 'precise_search' as const
export const LITERATURE_REVIEW_TASK_TYPE = 'literature_review' as const
export type ProductTaskType =
  | typeof RESEARCH_IDEA_TASK_TYPE
  | typeof PRECISE_SEARCH_TASK_TYPE
  | typeof LITERATURE_REVIEW_TASK_TYPE

export interface TurnContextAdmission {
  clientUserMessageId: string
  continueTurnId?: string
  assistantContextRevision?: number
  taskType?: ProductTaskType
  activeDocument?: ActiveDocument
  selectedLiteratureIds?: string[]
  expectedModelId?: string
  serviceInstanceId?: string
}

export type ActiveDocument =
  | { kind: 'literature'; literature_id: string; attachment_id: string }
  | { kind: 'project_file'; path: string }

export async function postTurn(
  sid: string,
  input: TurnInputItem[],
  collaborationMode: CollaborationMode = 'default',
  admission?: TurnContextAdmission
): Promise<TurnResponse | null> {
  try {
    const r = await apiFetch(`/api/serve/sessions/${sid}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        collaboration_mode: collaborationMode,
        wait: false,
        ...(admission
          ? {
              client_user_message_id: admission.clientUserMessageId,
              continue_turn_id: admission.continueTurnId,
              assistant_context_revision: admission.assistantContextRevision,
              task_type: admission.taskType,
              active_document: admission.activeDocument,
              selected_literature_ids: admission.selectedLiteratureIds,
              expected_model_id: admission.expectedModelId,
              service_instance_id: admission.serviceInstanceId,
            }
          : {}),
      }),
    })
    if (!r.ok) {
      const preparation = (await r
        .clone()
        .json()
        .catch(() => null)) as { preparation_error?: boolean; error?: string } | null
      if (preparation?.preparation_error) {
        return {
          ok: false,
          error: preparation.error,
          preparation_error: true,
          submissionOutcome: 'rejected',
        }
      }
      const failure = await serviceErrorDetail(r)
      if (turnErrorCode(failure.code ?? failure.message) === SESSION_INTERRUPTING_ERROR) {
        return {
          ok: false,
          error: failure.code ?? failure.message,
          code: failure.code,
          submissionOutcome: 'rejected',
          blocked: 'interrupting',
        }
      }
      publishBackendFailure(sid, failure, BACKEND_ADMISSION_FAILURE, failure.applicationFailure)
      return {
        ok: false,
        error: failure.code ?? failure.message,
        code: failure.code,
        submissionOutcome: 'rejected',
        issues: failure.issues,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const response = (await r.json()) as TurnResponse
    if (response.ok === false || response.error != null) {
      publishBackendFailure(sid, response, BACKEND_ADMISSION_FAILURE, response.applicationFailure)
    }
    return response.ok === false || response.error != null
      ? { ...response, submissionOutcome: 'rejected' }
      : response
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    publishBackendFailure(sid, error, BACKEND_ADMISSION_FAILURE)
    return { ok: false, error, submissionOutcome: 'unknown' }
  }
}

export async function postSide(
  sid: string,
  queuedMessageId: string
): Promise<SideTurnResponse | null> {
  try {
    const r = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/side`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queued_message_id: queuedMessageId,
      }),
    })
    if (!r.ok) {
      const failure = await serviceErrorDetail(r)
      const error = failure.message
      if (turnErrorCode(error) === SESSION_INTERRUPTING_ERROR) {
        return { ok: false, reason: error, blocked: 'interrupting' }
      }
      if (turnErrorCode(error) === TURN_STEER_OUTCOME_UNKNOWN_ERROR) {
        return { ok: false, reason: TURN_STEER_OUTCOME_UNKNOWN_ERROR, unknownOutcome: true }
      }
      return {
        ok: false,
        reason: error,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const response = (await r.json()) as { ok?: boolean; queued_depth?: number; reason?: string }
    return response
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: error }
  }
}

export async function sendQueuedMessage(
  sid: string,
  queuedMessageId: string
): Promise<QueuedMessageSendResponse | null> {
  try {
    const r = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(queuedMessageId)}/send`,
      { method: 'POST' }
    )
    if (!r.ok) {
      const failure = await serviceErrorDetail(r)
      const error = failure.message
      if (turnErrorCode(error) === SESSION_INTERRUPTING_ERROR) {
        return { ok: false, error, blocked: 'interrupting' }
      }
      return {
        ok: false,
        error,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const response = (await r.json()) as QueuedMessageSendResponse
    return response
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, error }
  }
}

export interface QueuedMessagePayload {
  queued_message_id: string
  enqueue_seq: number
  operation_seq?: number
  state: 'queued' | 'waiting_resources' | 'submitting' | 'failed' | 'outcome_unknown'
  submission_mode: SubmissionMode
  deadline?: number
  purpose?: string
  input: TurnInputItem[]
  assistant_context_revision?: number
  assistant_references?: Array<{
    selection_source_label?: string | null
    label_fallback?: ContextLabelFallback
    type?: string
    id?: string
    title?: string
    label?: string
    kind?: string
    ref_id?: string
    status?: string
    state?: string
    source_id?: string
    origin?: string
    anchor?: Record<string, unknown> | null
    surface?: {
      answer_id?: string
      selected_text?: string
      preview_text?: string
      comment?: string
      start_utf16?: number
      end_utf16?: number
      [key: string]: unknown
    }
  }>
  safe_error?: string
  native_turn_id?: string
  safe_error_details?: Record<string, string>
}

export type SubmissionMode = 'direct' | 'queued'

export interface QueuedMessageReconcileResponse {
  ok?: boolean
  outcome?: 'applied' | 'not_applied' | 'still_unknown'
  queued_message_id?: string
  queue_missing?: boolean
  message?: QueuedMessagePayload
  reason?: string
  error?: string
}

export async function listQueuedMessages(sid: string): Promise<QueuedMessagePayload[] | null> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/queue`)
    if (!response.ok) return null
    const payload = (await response.json()) as { messages?: QueuedMessagePayload[] }
    return Array.isArray(payload.messages) ? payload.messages : null
  } catch {
    return null
  }
}

export interface QueuedMessageDeleteResponse {
  ok: boolean
  status: number
  error?: string
  detail?: string
  applicationFailure?: ApplicationRequestFailure
}

export async function deleteQueuedMessage(
  sid: string,
  queuedMessageId: string
): Promise<QueuedMessageDeleteResponse> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(queuedMessageId)}`,
      { method: 'DELETE' }
    )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        status: response.status,
        error: failure.code,
        detail: failure.message,
        applicationFailure: failure.applicationFailure,
      }
    }
    const payload = (await response.json()) as { ok?: boolean; error?: string }
    return { ok: payload.ok === true, status: response.status, error: payload.error }
  } catch (error) {
    const failure = describeRequestFailure(error)
    return {
      ok: false,
      status: 0,
      detail: failure.message,
      applicationFailure: failure.applicationFailure,
    }
  }
}

export async function reconcileQueuedMessage(
  sid: string,
  queuedMessageId: string
): Promise<QueuedMessageReconcileResponse | null> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(queuedMessageId)}/reconcile`,
      { method: 'POST' }
    )
    return (await response.json()) as QueuedMessageReconcileResponse
  } catch {
    return null
  }
}

export interface InterruptResponse {
  applicationFailure?: ApplicationRequestFailure
  ok: boolean
  error?: string
  idle?: boolean
  interrupting?: boolean
  interrupt_epoch?: number
}

// 让后端把「书深自动管理」那把密钥备好，否则它要等到第一次开会话才存在，用户进账号设置页
// 会看不到它。登录成功后与打开开发者页时各调一次（后者才覆盖到「开应用即已登录」的用户）。
// 幂等且只补不换：已有就原样沿用，不会轮换掉正在用的那把。
// 尽力而为——失败只是让它延后到开会话时签发，不该阻断登录，也不该挡住密钥列表。
export async function ensureSkillCredential(): Promise<boolean> {
  try {
    const r = await apiFetch('/api/serve/skill-credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return r.ok
  } catch {
    return false
  }
}

// 账号页轮换那把「书深自动管理」的密钥后通知后端：后端重签一把并把空闲会话当场对齐，
// 否则它缓存里仍是那把已失效的 key，技能会一直取不到凭据。尽力而为，失败不影响轮换本身。
export async function refreshSkillCredential(): Promise<boolean> {
  try {
    const r = await apiFetch('/api/serve/skill-credential/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return r.ok
  } catch {
    return false
  }
}

export async function interruptSession(sid: string): Promise<InterruptResponse> {
  try {
    const r = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!r.ok) {
      const failure = await serviceErrorDetail(r)
      return {
        ok: false,
        error: failure.message,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const response = (await r.json()) as InterruptResponse
    if (response.ok !== true) return { ok: false, error: turnErrorText(response.error) }
    return response
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function runCommand(
  sid: string,
  name: string,
  args = ''
): Promise<{ ok?: boolean; reason?: string } | null> {
  return postJson(`/api/serve/sessions/${sid}/command`, { name, args })
}

export interface SessionModelResponse {
  applicationFailure?: ApplicationRequestFailure
  ok: boolean
  session_id: string
  model_id: string
  default_model_id?: string
  active_model_id?: string
  reasoning_effort?: string
  active_reasoning_effort?: string
  deferred?: boolean
  runtime?: RuntimeSnapshot
  error?: string
  detail?: string
}

export type SessionModelSnapshot = Omit<SessionModelResponse, 'ok' | 'error' | 'detail'>

export const getSessionModel = (sid: string): Promise<SessionModelSnapshot | null> =>
  getJson(`/api/serve/sessions/${encodeURIComponent(sid)}/model`)

async function sessionModelFailure(
  sid: string,
  error: string,
  detail?: string,
  applicationFailure?: ApplicationRequestFailure
): Promise<SessionModelResponse> {
  // A failed attachment change can still persist the selected model. Read the
  // authority again; never publish the requested target as a saved selection.
  const current = await getSessionModel(sid)
  return {
    ...(current?.session_id === sid &&
    current.model_id &&
    current.runtime?.model_id === current.model_id
      ? current
      : { session_id: sid, model_id: '' }),
    ok: false,
    error,
    detail,
    ...(applicationFailure ? { applicationFailure } : {}),
  }
}

export interface RuntimePreparation {
  request_id: string
  session_id: null
  model_id: string
  state: ReconfigurationOperation['state']
  error: string
  service_instance_id: string
}

async function runtimePreparationRequest(
  requestId: string,
  options: { modelId: string; serviceInstanceId: string; persistDefault: boolean } | null,
  signal?: AbortSignal
): Promise<RuntimePreparation> {
  const response = await apiFetch(
    options
      ? '/api/serve/runtime/prepare'
      : `/api/serve/runtime/prepare/${encodeURIComponent(requestId)}`,
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(RECONFIGURATION_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(RECONFIGURATION_REQUEST_TIMEOUT_MS),
      ...(options
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              request_id: requestId,
              model_id: options.modelId,
              service_instance_id: options.serviceInstanceId,
              persist_default: options.persistDefault,
            }),
          }
        : {}),
    }
  )
  const payload = (await response.json()) as Partial<RuntimePreparation>
  if (!response.ok)
    throw Object.assign(new Error(payload.error || 'runtime_preparation_unknown'), {
      status: response.status,
    })
  if (
    payload.request_id !== requestId ||
    payload.session_id !== null ||
    typeof payload.model_id !== 'string' ||
    !payload.model_id ||
    typeof payload.service_instance_id !== 'string' ||
    !payload.service_instance_id ||
    typeof payload.error !== 'string' ||
    !['accepted', 'applied', 'rejected', 'restart_required', 'unsupported'].includes(
      payload.state ?? ''
    ) ||
    (options &&
      (payload.model_id !== options.modelId ||
        payload.service_instance_id !== options.serviceInstanceId))
  ) {
    throw new Error('runtime_preparation_unknown')
  }
  return payload as RuntimePreparation
}

export function prepareRuntime(
  options: {
    requestId: string
    modelId: string
    serviceInstanceId: string
    persistDefault: boolean
  },
  signal?: AbortSignal
): Promise<RuntimePreparation> {
  return runtimePreparationRequest(options.requestId, options, signal)
}

export function getRuntimePreparation(
  requestId: string,
  signal?: AbortSignal
): Promise<RuntimePreparation> {
  return runtimePreparationRequest(requestId, null, signal)
}

export async function getSharedRuntimeReconfiguration(
  signal: AbortSignal = AbortSignal.timeout(RECONFIGURATION_REQUEST_TIMEOUT_MS)
): Promise<{ state: ReconfigurationOperation['state'] | null; service_instance_id: string }> {
  const response = await apiFetch('/api/serve/runtime/reconfiguration', { signal })
  if (!response.ok) throw new Error('runtime_reconfiguration_unknown')
  const result = await response.json()
  if (
    !result ||
    typeof result.service_instance_id !== 'string' ||
    (result.state !== null &&
      !['accepted', 'applied', 'rejected', 'restart_required', 'unsupported'].includes(
        result.state
      ))
  ) {
    throw new Error('runtime_reconfiguration_unknown')
  }
  return result
}

export async function currentRuntimeReconfiguration(
  sessionId: string
): Promise<ReconfigurationOperation | undefined> {
  const response = await apiFetch(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/runtime/reconfigure`,
    { timeoutMs: RECONFIGURATION_REQUEST_TIMEOUT_MS }
  )
  if (response.status === 204) return undefined
  if (!response.ok) throw new Error('runtime_reconfiguration_unknown')
  return readRuntimeReconfiguration(await response.json(), sessionId)
}

export async function getRuntimeReconfiguration(
  sessionId: string,
  requestId: string
): Promise<ReconfigurationOperation> {
  const response = await apiFetch(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/runtime/reconfigure/${encodeURIComponent(requestId)}`,
    { timeoutMs: RECONFIGURATION_REQUEST_TIMEOUT_MS }
  )
  if (!response.ok) throw new Error('runtime_reconfiguration_unknown')
  return readRuntimeReconfiguration(await response.json(), sessionId, requestId)
}

export async function setSessionModel(
  sid: string,
  modelId: string,
  reasoningEffort = '',
  rememberDefault = false
): Promise<SessionModelResponse | null> {
  const path = `/api/serve/sessions/${encodeURIComponent(sid)}/model`
  try {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        reasoning_effort: reasoningEffort,
        ...(rememberDefault ? { remember_default: true } : {}),
      }),
    })
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return null
    }
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return sessionModelFailure(
        sid,
        failure.code ?? failure.message,
        failure.message,
        failure.applicationFailure
      )
    }
    return (await response.json()) as SessionModelResponse
  } catch (error) {
    return sessionModelFailure(sid, error instanceof Error ? error.message : String(error))
  }
}

export type ModeInfo = {
  mode: string
  modes: string[]
  active_mode?: string
  deferred?: boolean
  backend?: string
  pre_plan_mode?: string | null
  switch_warning?: string
  current_turn_modes?: string[]
  next_turn_selected?: boolean
}

export async function getMode(sid: string): Promise<ModeInfo | null> {
  const result = await getJson<ModeInfo>(`/api/serve/sessions/${sid}/mode`)
  return result?.mode ? result : null
}

export type PermissionApplication = 'auto' | 'next_turn' | 'interrupt_continue'

export async function setMode(
  sid: string,
  mode: string,
  application: PermissionApplication = 'auto',
  continuation?: TurnContextAdmission
): Promise<ModeChangeResult> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${sid}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        application,
        ...(continuation
          ? {
              continuation_context: {
                client_user_message_id: continuation.clientUserMessageId,
                assistant_context_revision: continuation.assistantContextRevision,
                active_document: continuation.activeDocument,
                selected_literature_ids: continuation.selectedLiteratureIds,
                task_type: continuation.taskType,
              },
            }
          : {}),
      }),
    })
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        error: failure.code,
        detail: failure.message,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    return (await response.json()) as ModeChangeResult
  } catch {
    return { ok: false, error: 'permission_mode_connection_failed' }
  }
}

export interface ModeChangeResult {
  applicationFailure?: ApplicationRequestFailure
  ok: boolean
  mode?: GlobalPermissionMode
  active_mode?: GlobalPermissionMode | ''
  deferred?: boolean
  switch_warning?: string
  current_turn_modes?: string[]
  next_turn_selected?: boolean
  continued?: boolean
  error?: string
  detail?: string
}

export const GLOBAL_PERMISSION_MODES = ['ask', 'safe_auto', 'bypassPermissions'] as const
export type GlobalPermissionMode = (typeof GLOBAL_PERMISSION_MODES)[number]
export const DEFAULT_GLOBAL_PERMISSION_MODE: GlobalPermissionMode = 'safe_auto'

export interface GlobalPermissionModeInfo {
  mode: GlobalPermissionMode
  modes: GlobalPermissionMode[]
}

export async function getGlobalPermissionMode(): Promise<GlobalPermissionModeInfo | null> {
  const result = await getJson<GlobalPermissionModeInfo>('/api/serve/settings/permission-mode')
  return result && GLOBAL_PERMISSION_MODES.includes(result.mode) ? result : null
}

export async function setGlobalPermissionMode(
  mode: GlobalPermissionMode
): Promise<GlobalPermissionModeInfo | null> {
  return postJson('/api/serve/settings/permission-mode', { mode })
}

export interface WorkflowCapabilityInfo {
  enabled: boolean
}

export const getWorkflowCapability = (): Promise<WorkflowCapabilityInfo | null> =>
  getJson('/api/serve/settings/workflow')

export const setWorkflowCapability = (enabled: boolean): Promise<WorkflowCapabilityInfo | null> =>
  postJson('/api/serve/settings/workflow', { enabled })

export interface AutoReviewCapabilityInfo {
  enabled: boolean
}

export const getAutoReviewCapability = (): Promise<AutoReviewCapabilityInfo | null> =>
  getJson('/api/serve/settings/auto-review')

export const setAutoReviewCapability = (
  enabled: boolean
): Promise<AutoReviewCapabilityInfo | null> =>
  postJson('/api/serve/settings/auto-review', { enabled })

export async function respondHil(
  sid: string,
  requestId: string,
  body: {
    option_id?: string
    decision?: 'deny' | 'allow_once'
    answers?: Record<string, string>
    free_text?: string
    values?: Record<string, unknown>
    state_version?: number
    cancelled?: boolean
  },
  hostOwned = false
): Promise<{
  ok: boolean
  request_id?: string
  interaction?: ProductInteraction
  error?: string
  applicationFailure?: ApplicationRequestFailure
  outcome?: 'unknown' | 'stale'
}> {
  try {
    const native = hostOwned
      ? await window.scholarseed.deviceSkills({
          operation: 'plugin-answer',
          session: sid,
          request: requestId,
          body,
        })
      : null
    const response = native
      ? new Response(native.body, {
          status: native.status,
          headers: { 'content-type': 'application/json' },
        })
      : await apiFetch(
          `/api/serve/sessions/${encodeURIComponent(sid)}/hil/${encodeURIComponent(requestId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        error: failure.message,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
        outcome: classifyHilResponseFailure(failure.code, failure.operationState),
      }
    }
    const result = (await response.json()) as {
      ok?: boolean
      request_id?: string
      interaction?: ProductInteraction
      error?: unknown
    }
    if (result.ok !== true) return { ok: false, error: turnErrorText(result.error) }
    return {
      ok: true,
      request_id: result.request_id,
      interaction: result.interaction,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const HIL_RESPONSE_NOT_RETRYABLE = 'hil_response_not_retryable'
const HIL_REQUEST_STALE = 'hil_request_stale'

export function classifyHilResponseFailure(
  code?: string,
  operationState?: string
): 'unknown' | 'stale' | undefined {
  if (code === HIL_REQUEST_STALE) return 'stale'
  if (code !== HIL_RESPONSE_NOT_RETRYABLE) return undefined
  if (operationState === 'unknown') return 'unknown'
  if (operationState === 'stale') return 'stale'
  return undefined
}

const TURN_UNKNOWN_CONFIRM_DECISION = 'continue_without_replay'

export interface RecoveryCheckResponse {
  ok: boolean
  recovery_blocked: boolean
  recovery_pending: boolean
  activity_active?: boolean
  error?: string
}

export async function checkSessionRecovery(sid: string): Promise<RecoveryCheckResponse> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sid)}/recovery/check`,
      { method: 'POST' }
    )
    if (!response.ok)
      return {
        ok: false,
        recovery_blocked: true,
        recovery_pending: true,
        error: (await serviceErrorDetail(response)).message,
      }
    const result = (await response.json()) as Partial<RecoveryCheckResponse>
    if (
      typeof result.ok !== 'boolean' ||
      typeof result.recovery_blocked !== 'boolean' ||
      typeof result.recovery_pending !== 'boolean' ||
      (result.recovery_blocked && !result.recovery_pending)
    ) {
      return {
        ok: false,
        recovery_blocked: true,
        recovery_pending: true,
        error: FAILURE_CODES.invalidRecoveryCheck,
      }
    }
    return result as RecoveryCheckResponse
  } catch (error) {
    return {
      ok: false,
      recovery_blocked: true,
      recovery_pending: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface ConfirmUnknownTurnResponse {
  applicationFailure?: ApplicationRequestFailure
  ok: boolean
  turn_id?: string
  resolution?: typeof TURN_UNKNOWN_CONFIRM_DECISION
  error?: string
  code?: string
}

/** Release the Service admission gate after human inspection; this never replays a turn. */
export async function confirmUnknownTurn(
  sid: string,
  turnId: string
): Promise<ConfirmUnknownTurnResponse> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turnId)}/confirm-unknown`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: TURN_UNKNOWN_CONFIRM_DECISION }),
      }
    )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        error: failure.message,
        code: failure.code,
        ...(failure.applicationFailure ? { applicationFailure: failure.applicationFailure } : {}),
      }
    }
    const result = (await response.json()) as ConfirmUnknownTurnResponse
    return result.ok === true
      ? result
      : {
          ok: false,
          error: result.error || 'turn unknown confirmation failed',
          code: result.code,
          ...(!result.error
            ? { applicationFailure: { key: 'retry.continueUnconfirmed' as const } }
            : {}),
        }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface RefHit {
  ref?: string
  type?: string
  id?: string
  title?: string
  cite_key?: string
  status?: string
  path?: string
  version?: string
  selectable?: boolean
  unavailable_reason?: string
}

export interface RefKind {
  kind: string
  display?: string
  tint?: string
}
interface ProductEventBase<TType extends string, TData> {
  v: 2
  seq: number
  ts: number
  type: TType
  session_id: string
  turn_id?: string
  item_id?: string
  data: TData
}

export interface ProductHilQuestion {
  plugin_installation?: PluginReport
  component?: PluginReference
  component_data?: Record<string, unknown>
  id?: string
  name?: string
  header?: string
  question: string
  options?: { id?: string; label: string; description?: string }[]
  multiSelect?: boolean
  papers?: { id: string; label: string; description?: string }[]
}

export interface ProductHilData {
  session_id?: string
  request_id: string
  lifetime?: 'turn' | 'session'
  blocking?: boolean
  kind: string
  tool_name?: string
  title?: string
  body?: string
  questions?: ProductHilQuestion[]
  options?: { id: string; label: string; description?: string }[]
  allow_free_text?: boolean
  command?: string
  cwd?: string
  path?: string
  diff?: string
  network_target?: string
  permissions?: Record<string, unknown>
  safety_tags?: string[]
  reason?: string
  suggested_prefix?: string
  prefix_kind?: string
  requested_at?: number
  method?: string
  tab_id?: string
  proof_id?: string
  target_instance_id?: string
  target_generation?: number
  tab_title?: string
  tab_url?: string
  origin?: string
  source_origin?: string | null
  destination_url?: string
  destination_origin?: string
  prepared_id?: string
  snapshot_id?: string
  element_ref?: string
  browser_action?: 'click' | 'fill' | 'submit'
  element?: { role: string; name: string }
  action?: string
  intent?: string
  expires_at?: number
  search?: string
  offset?: number
  limit?: number
  query_digest?: string
  history_revision?: number
}

export interface ProductInteraction extends ProductHilData {
  session_id: string
  turn_id?: string
  item_id?: string
  state: 'pending' | 'resolved' | 'cancelled' | 'stale' | 'unknown'
  answers?: Record<string, string>
  created_at: number
  resolved_at?: number | null
  decision?: 'deny' | 'allow_once'
  reason?: string
}

export async function getPendingInteractions(): Promise<ProductInteraction[]> {
  const result = await getJson<{ interactions?: ProductInteraction[] }>(
    '/api/serve/interactions/pending'
  )
  return result?.interactions ?? []
}

export interface ProductNativeActivityData {
  activity_id: string
  activity_type: string
  category: NativeActivityCategory
  details: Record<string, unknown>
  status: string
  success?: boolean
}

export interface ProductSkillActivityData {
  skill_id: string
  skill: string
  path: string
  status: string
  success?: boolean
  model_id?: string
  reasoning_effort?: string
  estimate?: {
    lower_seconds: number
    upper_seconds: number
    sample_count: number
    confidence: 'low' | 'medium' | 'high'
    basis: 'historical_skill_turns' | 'product_baseline'
  }
}

export interface ProductSubagentData {
  subagent_id: string
  parent_agent_id: string
  root_turn_id: string
  native_agent_session_id?: string
  agent_path?: string
  display_name?: string
  status?: string
  actor_kind: 'subagent'
  actor_id: string
  parent_actor_id: string
  details?: Record<string, unknown>
}

/**
 * AI 经 bridge 改动产品数据后广播的「过期数据域」。
 *
 * 这是粗失效: 事件只说哪个域脏了, 不说哪几条脏了, 消费方按域整片重取。于是新增一个
 * 数据域只要在这里加一个常量、在 live.ts 的映射表里加一行, 界面组件不需要声明自己读
 * 的是哪个实体。取值与 serve 的 `service/chat/service/invalidation.py` 一一对应。
 *
 * `scopes` 故意是 `string[]` 而不是常量联合: 旧界面收到新版本才有的域名时应当忽略,
 * 而不是让类型断言变成假话。
 */
export const PRODUCT_DATA_SCOPE_LITERATURE = 'literature'
export const PRODUCT_DATA_SCOPE_RESOURCES = 'resources'

export interface ProductDataChangedData {
  scopes: string[]
}

export type ProductEvent =
  | ProductEventBase<
      'session_state',
      {
        state: 'starting' | 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'closed'
        runtime_id: string
        reason?: string
        active_turn_id?: string
        recovery_blocked?: boolean
        incident_id?: string | null
        recovery_pending?: boolean
      }
    >
  | ProductEventBase<
      'session_title_updated',
      { title: string; title_fallback?: SessionTitleFallback }
    >
  | ProductEventBase<
      'user_message',
      {
        text: string
        refs: HistoryMessageReference[]
        client_turn_id: string
        binding: 'admitted' | 'bound' | 'cancelled'
        origin?: 'turn' | 'steer' | 'recovery'
      }
    >
  | ProductEventBase<
      | 'message_queued'
      | 'message_updated'
      | 'send_now_submitted'
      | 'send_now_rejected'
      | 'send_now_outcome_unknown',
      QueuedMessagePayload
    >
  | ProductEventBase<
      'message_removed' | 'send_now_accepted',
      { queued_message_id: string; reason?: string; native_turn_id?: string }
    >
  | ProductEventBase<
      'message_delta',
      {
        model_run?: ModelRun
        delta: string
        phase?: 'commentary' | 'final_answer'
      }
    >
  | ProductEventBase<
      'answer_sources',
      {
        answer_revision: string
        sources: AnswerSource[]
        search_sources?: SearchSource[]
        coverage?: AnswerCoverage
      }
    >
  | ProductEventBase<'reasoning_delta', { delta: string; summary_index?: number }>
  | ProductEventBase<'reasoning_completed', Record<string, never>>
  | ProductEventBase<
      'plan_snapshot',
      {
        items: TodoItemUI[]
        plan?: {
          source: 'structured' | 'released'
          plan_id: string
          revision: number
          timing_policy?: string
        }
      }
    >
  | ProductEventBase<'tool_started', { tool_id: string; name: string; input?: unknown }>
  | ProductEventBase<'tool_output_delta', { tool_id: string; delta: string }>
  | ProductEventBase<
      'tool_completed',
      { tool_id: string; name?: string; output?: string; success: boolean; exit_code?: number }
    >
  | ProductEventBase<
      'web_search_started',
      { search_id: string; query: string; action: WebSearchAction }
    >
  | ProductEventBase<
      'web_search_completed',
      {
        search_id: string
        query: string
        action: WebSearchAction
        results?: WebSearchResult[]
        result_count?: number
      }
    >
  | ProductEventBase<'paper_search_started', { search_id: string; query: string }>
  | ProductEventBase<'paper_search_completed', { search_id: string; query: string }>
  | ProductEventBase<'skill_started', ProductSkillActivityData>
  | ProductEventBase<'skill_completed', ProductSkillActivityData>
  | ProductEventBase<'native_activity_started', ProductNativeActivityData>
  | ProductEventBase<'native_activity_completed', ProductNativeActivityData>
  | ProductEventBase<
      | 'subagent_spawned'
      | 'subagent_started'
      | 'subagent_status_changed'
      | 'subagent_completed'
      | 'subagent_failed'
      | 'subagent_interrupted',
      ProductSubagentData
    >
  | ProductEventBase<
      'file_changed',
      { change: 'add' | 'update' | 'delete'; path: string; artifact?: SessionArtifact }
    >
  | ProductEventBase<'product_data_changed', ProductDataChangedData>
  | ProductEventBase<
      'artifact_changed',
      {
        op: 'snapshot' | 'upsert' | 'remove'
        artifact?: SessionArtifact
        artifacts?: SessionArtifact[]
      }
    >
  | ProductEventBase<'artifact_failed', { declaration_id: string; code: string }>
  | ProductEventBase<
      'artifact_library_linked',
      {
        link_id: string
        project_id: string
        artifact_id: string
        source_sha256: string
        destination: string
        target_ids: string[]
      }
    >
  | ProductEventBase<
      'review_ready',
      {
        batch_id: string
        project_id: string
        file_ids: string[]
        review_ids: string[]
        paths: string[]
      }
    >
  | ProductEventBase<
      'display_card',
      {
        card_id: string
        type: string
        content: Record<string, unknown>
        component?: PluginReference
      }
    >
  | ProductEventBase<'hil_requested', ProductHilData>
  | ProductEventBase<
      'hil_resolved',
      ProductHilData & {
        state: 'resolved' | 'cancelled' | 'stale' | 'unknown'
        answer?: string
        answers?: Record<string, string>
        decision_scope?: string
        decision?: 'deny' | 'allow_once'
        reason?: string
        resolved_at?: number | null
      }
    >
  | ProductEventBase<
      'usage_updated',
      {
        input_tokens?: number
        output_tokens?: number
        cache_read_tokens?: number
        cache_creation_tokens?: number
      }
    >
  | ProductEventBase<
      'context_compacted',
      { phase: 'started' | 'completed' | 'failed'; message?: string }
    >
  | ProductEventBase<'turn_completed', { stop_reason?: string }>
  | ProductEventBase<
      'turn_failed',
      {
        code?: string
        provider_error_code?: string
        message: string
        retryable?: boolean
        automatic_retry_attempts?: number
      }
    >
  | ProductEventBase<'turn_interrupted', { reason?: string }>
  | ProductEventBase<
      'turn_unknown',
      { code?: string; message: string; incident_id?: string; confirmed?: boolean }
    >
  | ProductEventBase<'operation_state', OperationStateData>
  | ProductEventBase<
      'turn_reconciled',
      {
        turn_id: string
        incident_id?: string
        resolution: 'user_confirmed_continue'
        outcome: 'unknown_outcome'
      }
    >
  | ProductEventBase<'runtime_incident', RuntimeIncidentData>
  | ProductEventBase<'runtime_error', { code: string; message: string; recoverable?: boolean }>

export interface RuntimeIncidentData {
  incident_id: string
  scope: 'provider' | 'turn' | 'thread' | 'process' | 'protocol' | 'capability'
  state: 'detected' | 'retrying' | 'recovered' | 'failed'
  kind: string
  strategy: 'vendor_retry' | 'auto_restart' | 'auto_resume' | 'manual_retry' | 'none'
  retryability: 'in_progress' | 'user_retryable' | 'terminal' | 'unknown_outcome'
  safe_error: string
  provider_error_code?: string
  process_generation: number
  attempt: number
  max_attempts: number
  vendor_thread_id?: string
  vendor_turn_id?: string
  rpc_method?: string
  rpc_code?: number | null
  rpc_latency_ms?: number
  process_exit_code?: number | null
  ambiguous_commit?: boolean
}

export interface OperationStateData {
  kind: 'hil_response' | 'tool_response'
  correlation_id: string
  state: 'executing' | 'unknown' | 'stale' | 'reconciled' | 'confirmed'
  retryable: boolean
  execution_count: number
}

export type AspEnvelope = ProductEvent

export const PRODUCT_EVENT_SCHEMA_VERSION = 2

export function isProductEventEnvelope(value: unknown): value is AspEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AspEnvelope>
  return (
    candidate.v === PRODUCT_EVENT_SCHEMA_VERSION &&
    typeof candidate.seq === 'number' &&
    Number.isSafeInteger(candidate.seq) &&
    candidate.seq > 0 &&
    typeof candidate.ts === 'number' &&
    Number.isFinite(candidate.ts) &&
    typeof candidate.type === 'string' &&
    Boolean(candidate.type) &&
    typeof candidate.session_id === 'string' &&
    Boolean(candidate.session_id) &&
    Boolean(candidate.data) &&
    typeof candidate.data === 'object'
  )
}

/** attach to a session's SSE event log; returns a disposer */
const SSE_RECONNECT_INITIAL_DELAY_MS = 500
const SSE_RECONNECT_MAX_DELAY_MS = 15_000
const SSE_RECONNECT_JITTER_RATIO = 0.2
const SSE_IDLE_TIMEOUT_MS = 60_000
const SSE_HEARTBEAT_EVENT = 'heartbeat'

export type SseConnectionState = 'connecting' | 'live' | 'retrying' | 'offline'
export type SseRecoveryReason = 'idle' | 'foreground' | 'projection' | 'gap'

export function streamEvents(
  sid: string,
  fromSeq: number,
  onEvent: (env: AspEnvelope) => void,
  onConnectionState?: (state: SseConnectionState) => void,
  onRecovery?: (reason: SseRecoveryReason) => void
): () => void {
  // seq 游标续流: 断连后带「最后收到的 seq」显式重开 (EventSource 内建重连会复用过期的
  // from_seq URL), 服务端按游标重放 backlog — 断连期间的帧不丢; 重放重叠帧按 seq 去重。
  let last = fromSeq
  let closed = false
  let es: EventSource | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  let idleTimer: number | null = null
  let lastFrameAt = Date.now()
  let heartbeatCount = 0
  let appliedCount = 0
  const diagnostic = (stage: string, detail: Record<string, unknown> = {}): void => {
    console.info(
      '[session-stream]',
      JSON.stringify({
        stage,
        sessionId: sid,
        sequence: last,
        heartbeatCount,
        appliedCount,
        ...detail,
      })
    )
  }
  const clearIdle = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer)
    idleTimer = null
  }
  const dispose = (): void => {
    closed = true
    clearIdle()
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = null
    es?.close()
    es = null
    window.removeEventListener('focus', foreground)
    document.removeEventListener('visibilitychange', foreground)
  }
  const retry = (reason: string): void => {
    if (closed || reconnectTimer !== null) return
    clearIdle()
    es?.close()
    es = null
    reconnectAttempt += 1
    onConnectionState?.('retrying')
    const baseDelay = Math.min(
      SSE_RECONNECT_MAX_DELAY_MS,
      SSE_RECONNECT_INITIAL_DELAY_MS * 2 ** (reconnectAttempt - 1)
    )
    const jitter = baseDelay * SSE_RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1)
    const delay = Math.max(0, baseDelay + jitter)
    diagnostic('retry', { reason, attempt: reconnectAttempt, delayMs: delay })
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }
  const recover = (reason: SseRecoveryReason): void => {
    if (closed) return
    diagnostic('recovery', { reason, idleMs: Date.now() - lastFrameAt })
    if (!onRecovery) {
      retry(reason)
      return
    }
    dispose()
    onConnectionState?.('retrying')
    onRecovery(reason)
  }
  const foreground = (): void => {
    if (
      document.visibilityState === 'visible' &&
      es !== null &&
      Date.now() - lastFrameAt >= SSE_IDLE_TIMEOUT_MS
    )
      recover('foreground')
  }
  const touch = (): void => {
    lastFrameAt = Date.now()
    clearIdle()
    idleTimer = window.setTimeout(() => recover('idle'), SSE_IDLE_TIMEOUT_MS)
  }
  const open = (): void => {
    if (closed) return
    diagnostic('connecting', { attempt: reconnectAttempt })
    onConnectionState?.(reconnectAttempt > 0 ? 'retrying' : 'connecting')
    const connection = new EventSource(
      apiBase() + `/api/serve/sessions/${sid}/events?from_seq=${last}`,
      {
        // SSE 无法带 Authorization 头, 只能靠 cookie; 跨源 (dev 期) 必须显式开凭据,
        // 否则直播通道在鉴权开启时永远 401 —— 与 api 的 CREDENTIALS 策略同源。
        withCredentials: true,
      }
    )
    es = connection
    touch()
    connection.addEventListener(SSE_HEARTBEAT_EVENT, () => {
      if (!closed && connection === es) {
        heartbeatCount += 1
        touch()
      }
    })
    connection.onopen = () => {
      if (closed || connection !== es) return
      reconnectAttempt = 0
      touch()
      diagnostic('live')
      onConnectionState?.('live')
    }
    connection.onmessage = (m) => {
      if (closed || connection !== es) return
      touch()
      let candidate: unknown
      try {
        candidate = JSON.parse(m.data)
      } catch {
        diagnostic('invalid-json')
        return
      }
      if (!isProductEventEnvelope(candidate)) {
        diagnostic('unsupported-schema')
        return
      }
      const env = candidate
      if (env.session_id !== sid) {
        diagnostic('session-mismatch', {
          receivedSessionId: env.session_id,
          receivedSequence: env.seq,
        })
        return
      }
      const seq = env.seq
      if (seq <= last) return
      if (seq !== last + 1) {
        diagnostic('sequence-gap', { receivedSequence: seq })
        recover('gap')
        return
      }
      try {
        onEvent(env)
        last = seq
        appliedCount += 1
      } catch (error) {
        diagnostic('projection-failed', {
          failedSequence: seq,
          eventType: env.type,
          errorName: error instanceof Error ? error.name : 'unknown',
        })
        recover('projection')
      }
    }
    connection.onerror = () => {
      // EventSource errors can arrive after a newer connection has been opened.
      // Only the current connection owns the retry timer and may close itself.
      if (closed || connection !== es) return
      retry('transport')
    }
  }
  window.addEventListener('focus', foreground)
  document.addEventListener('visibilitychange', foreground)
  open()
  return () => {
    diagnostic('disposed')
    dispose()
    onConnectionState?.('offline')
  }
}

// ── ScholarSeed projects ────────────────────────────────────────────────────────

export interface Project {
  description?: string
  pinned?: boolean
  /**
   * content 域的项目身份。资料 / 文献 / 搜索 / 文件事件这些接口只认它，
   * 传路径会被明确拒绝（unknown_project）。
   */
  id: string
  name: string
  /** 本机绝对路径。会话域按它登记（project_path），与 id 不可互换。 */
  path: string
  /** Registration time in seconds. */
  added_at?: number
  /** Bounded count of visible top-level entries; null means the root is unavailable. */
  file_count?: number | null
  file_count_capped?: boolean
  /** Latest real top-level entry mtime, falling back to registration time. */
  updated_at?: number
  available?: boolean
  /** 归档时间（秒）。非空即已归档，默认列表不显示。 */
  archived_at?: number | null
}
export interface ProjectsResp {
  default: string
  projects: Project[]
}
async function deleteJson<T>(path: string, timeoutMs?: number): Promise<T | null> {
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const r = await apiFetch(path, { method: 'DELETE', ...(ctl ? { signal: ctl.signal } : {}) })
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return null
    }
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  } finally {
    if (timer != null) window.clearTimeout(timer)
  }
}

/**
 * 项目列表。事实源是 content 域（proposal 47 §6.8）——chat 域那条
 * `/api/serve/projects` 已随阶段四下线。
 *
 * 这里把 `ProjectRef` 映射成 0.1 起就在用的 `Project` 形状（name/path/added_at），
 * 让首页卡片、侧栏、会话选择这些既有消费方不必同时改；`id` 一并带上，写操作按 id 走。
 *
 * 顺序由服务端给出（创建时间倒序），这里保持不动。
 */
export async function listProjects(includeArchived = false): Promise<ProjectsResp | null> {
  const query = includeArchived ? '?includeArchived=true' : ''
  const payload = await getJson<{
    projects: {
      id: string
      name: string
      root: string
      layout: string
      available: boolean
      created_at?: number | null
      archived_at?: number | null
      description?: string
      pinned?: boolean
    }[]
    current: string
    workspaceRoot: string
  }>(`/api/content/projects${query}`, undefined, LIVE_CATALOG_REQUEST)
  if (!payload) return null
  const result: ProjectsResp = {
    default: payload.workspaceRoot,
    projects: payload.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.root,
      added_at: project.created_at ?? 0,
      layout: project.layout,
      available: project.available,
      archived_at: project.archived_at ?? null,
      description: project.description ?? '',
      pinned: project.pinned ?? false,
    })),
  }
  void window.scholarseed.syncAuthorizedRoots(
    'workspace',
    [result.default, ...result.projects.map((project) => project.path)].filter(Boolean)
  )
  return result
}
/**
 * 新建项目（只填名字，proposal 47 §4/§5.2）。
 *
 * 后端在工作区容器根下生成 `<日期-短id-slug>/{资料库,文献库,.scholarseed}` 的 MANAGED
 * 目录，身份键与目录名都由后端生成——前端不提交任何本机路径。
 */
export async function createManagedProject(name: string): Promise<Project | null> {
  return submitProject('/api/content/projects', { name })
}

export async function adoptProject(path: string, name: string): Promise<Project | null> {
  return submitProject('/api/content/projects/adopt', { path, name })
}

async function submitProject(
  endpoint: string,
  payload: { name: string; path?: string }
): Promise<Project | null> {
  try {
    const response = await resolveContentResponse(
      await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    )
    if (response.status === 401) window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
    if (!response.ok) return null
    const created = (await response.json()) as { id: string; name: string; root: string }
    return {
      id: created.id,
      name: created.name,
      path: created.root,
      added_at: Math.floor(Date.now() / 1000),
    }
  } catch {
    return null
  }
}

/** 路径 → content 域的 project id。写操作按 id 走，路径只是位置。 */
async function projectIdForPath(path: string): Promise<string> {
  const listing = await listProjects()
  const found = listing?.projects.find((project) => project.path === path)
  return found?.id ?? ''
}

export interface ProjectMutation {
  ok: boolean
  error?: string
}

/** 改项目显示名；目录名不跟随改名（proposal 47 §5.2）。 */
export async function renameProject(path: string, name: string): Promise<ProjectMutation> {
  const id = await projectIdForPath(path)
  if (!id) return { ok: false, error: 'unknown_project' }
  return mutateProject('PATCH', '/api/content/projects', { id, name })
}

/**
 * 把项目从书深移除。只摘登记，**不删除本机目录与文件**。
 * 当前项目会被拒绝，调用方需提示用户先切换。
 */
export async function removeProject(path: string): Promise<ProjectMutation> {
  const id = await projectIdForPath(path)
  if (!id) return { ok: false, error: 'unknown_project' }
  return mutateProject('DELETE', `/api/content/projects/${encodeURIComponent(id)}`, undefined)
}

async function mutateProject(
  method: string,
  path: string,
  body: unknown
): Promise<ProjectMutation> {
  try {
    let response = await apiFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    response = await resolveContentResponse(response)
    const payload = (await response.json().catch(() => ({}))) as {
      detail?: string | { message?: string }
    }
    if (response.ok) return { ok: true }
    const detail = payload?.detail
    const message = typeof detail === 'string' ? detail : detail?.message
    return { ok: false, error: message || `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export interface ModelInfo {
  /** Application preset identity only when the provider label came from that preset. */
  provider_preset_id?: string
  /** Original model label before the application adds a provider prefix. */
  model_label?: string
  key: string
  label: string
  provider?: string
  /** Subscription group heading carried by the catalogue entry itself. */
  provider_label?: string
  model_name?: string
  /** Personal entries only: the model segment of the composite key. */
  model_id?: string
  context_window?: number
  /** Declared capability limits from the model catalogue. */
  limits?: { context?: number; max_input?: number; max_output?: number } | null
  /** Declared input modalities; absent means unverified. */
  modalities?: { input?: string[] | null; output?: string[] | null } | null
  capability_declared?: boolean
  capability_reason?: string
  image_input?: boolean
  source?: string
  profile_id?: string
  billing?: 'api' | 'subscription'
  reasoning_efforts?: string[] | null
  reasoning_options?: Array<{
    kind: string
    wire?: Record<string, string>
    values?: string[]
    default?: string | null
  }> | null
  reasoning?: { supported?: boolean; options?: unknown[] | null } | null
  reasoning_effort?: string
  disabled?: boolean
  disabled_reason?: string
  /** Application-owned reason identity; unknown or legacy prose remains unchanged. */
  disabled_reason_code?: string
}
/**
 * Subscription second-level grouping. The backend derives name and order from
 * the catalogue entries, so adding a subscription provider needs no UI change.
 */
export interface SubscriptionGroup {
  provider: string
  label: string
}
export interface ModelsResp {
  service_instance_id: string
  configured: boolean
  current_model: string
  available_models: ModelInfo[]
  /** Models the user hid in Model management. Never part of `available_models`. */
  hidden_models?: ModelInfo[]
  subscription_groups?: SubscriptionGroup[]
  reasoning_effort?: string
}
export const getModels = (refresh?: boolean): Promise<ModelsResp | null> =>
  getJson(refresh ? '/api/serve/models?refresh=true' : '/api/serve/models')
export const setDefaultModel = (modelKey: string): Promise<ModelsResp | null> =>
  postJson('/api/serve/models/default', { model_key: modelKey, persist: true })

/** Upstream protocol this endpoint speaks, declared rather than guessed from the URL. */
export type PersonalApiWireApi = 'chat_completions' | 'responses'

/**
 * Vendor-declared capability the backend attaches to a personal model entry.
 * It exists only to prefill the editor; it never gates execution, and the backend
 * ignores it on save (proposal 78 I3).
 */
export interface ModelCapabilityHint {
  wire_model: string
  context_window?: number
  max_output_tokens?: number
  input_modalities?: string[]
  reasoning_efforts?: string[]
  capability_provenance?: Record<string, string>
  source_url?: string
  retrieved?: string
}

/** One model the user checked on a connection. `label` is optional display text. */
export interface PersonalApiModel {
  id: string
  label: string
  reasoning_efforts?: string[] | null
  context_window?: number | null
  max_output_tokens?: number | null
  input_modalities?: string[] | null
  capability_hint?: ModelCapabilityHint
  /** Must be resubmitted when saving the connection, or the backend drops it. */
  hidden?: boolean
}

export interface PersonalApiProfile {
  image_input?: boolean
  pdf_input?: boolean
  authentication?: 'api_key' | 'oauth'
  oauth_provider?: string
  oauth?: { state: string; account_label: string; billing: string; error?: string }
  id: string
  /** Resolved label: preview_name when set, otherwise the first selected model id. */
  name: string
  preview_name: string
  /** Which endpoint preset this connection declared it came from; '' when custom. */
  preset_id: string
  provider: 'openai' | 'anthropic'
  wire_api: PersonalApiWireApi
  base_url: string
  selected_models: PersonalApiModel[]
  /** Whether this connection's selected models reach the model menu. */
  enabled: boolean
  small_model_name: string
  has_api_key: boolean
  has_headers: boolean
  /** Header values intentionally never leave the backend. */
  header_names: string[]
}

export interface PersonalApiProfilesResp {
  path: string
  profiles: PersonalApiProfile[]
  enabled_profile_ids: string[]
}
export interface PersonalApiMutationResp extends PersonalApiProfilesResp {
  profile?: PersonalApiProfile
}
export type ModelSelectionResp = ModelsResp & PersonalApiProfilesResp

export interface PersonalApiInput {
  image_input?: boolean
  pdf_input?: boolean
  preview_name: string
  preset_id: string
  provider: 'openai' | 'anthropic'
  wire_api: PersonalApiWireApi
  base_url: string
  api_key?: string
  selected_models: PersonalApiModel[]
  small_model_name: string
  /** Omit to keep the stored headers; sending an empty object deletes them. */
  headers?: Record<string, string>
}

export interface PersonalApiProbeResult {
  ok: boolean
  message: string
  /** probe 以读取模型目录代替推理, 所以成功与失败响应都带回端点声明的模型列表。 */
  models: string[]
  latency_ms: number
  error_class?: string
}

export type ProfileRequestErrorCode = 'authentication_required' | 'http_failure' | 'network_failure'
/**
 * 保存校验失败时后端回传的结构化原因。`code` 固定为 connection_validation_failed;
 * `model` 只在「真的调用了某个已选模型」时非空, `upstream` 是截断后的上游原文。
 * 有了它弹窗才能指名失败模型, 而不是只按 422 状态码归到「检查地址与 API Key」。
 */
export type PersonalApiFailureDetail = {
  code: string
  model?: string
  wire_api?: string
  error_class?: string
  upstream?: string
}
export type PersonalApiFailure = {
  ok: false
  error: string
  code?: ProfileRequestErrorCode
  status?: number
  detail?: PersonalApiFailureDetail
}
export type PersonalApiResult<T> = { ok: true; data: T } | PersonalApiFailure

/** 后端把保存校验失败回成带 `code` 的结构化 detail; 其余错误的 detail 是纯字符串。 */
function asFailureDetail(value: unknown): PersonalApiFailureDetail | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const detail = value as Record<string, unknown>
  return typeof detail.code === 'string'
    ? (detail as unknown as PersonalApiFailureDetail)
    : undefined
}

/** 端点预置：只是表单填空提示，产品不会主动连接其中任何一条。 */
export interface ModelProviderPreset {
  id: string
  label: string
  base_url: string
  wire_api: PersonalApiWireApi
  note: string
  credential_hint: string
}
export interface ModelProvidersResp {
  providers: ModelProviderPreset[]
}

/**
 * 带用户输入的连接操作必须把后端的拒绝原因带回界面: 校验细节只在 `detail` 里
 * (base_url 必填 / 缺凭据 / 协议不支持), 丢掉它用户就只能盲猜哪一栏填错了。
 */
export async function profileRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<PersonalApiResult<T>> {
  try {
    const r = await apiFetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.status === 401) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return { ok: false, error: '', code: 'authentication_required', status: r.status }
    }
    const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok) {
      // 保存校验失败回结构化 detail（含失败模型与上游原文）; 其余错误仍是不带结构的字符串。
      const detail = asFailureDetail(payload.detail)
      return {
        ok: false,
        error: detail ? detail.upstream || '' : String(payload.detail || ''),
        code: 'http_failure',
        status: r.status,
        ...(detail ? { detail } : {}),
      }
    }
    return { ok: true, data: payload as T }
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      code: 'network_failure',
    }
  }
}

export const getModelProviders = (): Promise<ModelProvidersResp | null> =>
  getJson(MODEL_PROVIDERS_PATH)
export const getPersonalApiProfiles = (): Promise<PersonalApiProfilesResp | null> =>
  getJson(MODEL_PROFILES_PATH)
export const listPersonalApiModels = (
  input: PersonalApiInput,
  profileId = ''
): Promise<PersonalApiResult<PersonalApiProbeResult>> =>
  profileRequest('POST', `${MODEL_PROFILES_PATH}/models`, { ...input, profile_id: profileId })
export const probePersonalApi = (
  input: PersonalApiInput,
  profileId = ''
): Promise<PersonalApiResult<PersonalApiProbeResult>> =>
  profileRequest('POST', `${MODEL_PROFILES_PATH}/probe`, { ...input, profile_id: profileId })
export const createPersonalApiProfile = (
  input: PersonalApiInput
): Promise<PersonalApiResult<PersonalApiMutationResp>> =>
  profileRequest('POST', MODEL_PROFILES_PATH, input)
export const updatePersonalApiProfile = (
  id: string,
  input: PersonalApiInput
): Promise<PersonalApiResult<PersonalApiMutationResp>> =>
  profileRequest('PUT', `${MODEL_PROFILES_PATH}/${encodeURIComponent(id)}`, input)
export const setPersonalApiProfileEnabled = (
  id: string,
  enabled: boolean
): Promise<PersonalApiResult<ModelSelectionResp>> =>
  profileRequest('POST', `${MODEL_PROFILES_PATH}/${encodeURIComponent(id)}/enabled`, { enabled })
export const setPersonalApiModelVisibility = (
  id: string,
  modelId: string,
  hidden: boolean
): Promise<PersonalApiResult<ModelSelectionResp>> =>
  profileRequest('POST', `${MODEL_PROFILES_PATH}/${encodeURIComponent(id)}/models/visibility`, {
    model_id: modelId,
    hidden,
  })
export const deletePersonalApiProfile = (id: string): Promise<ModelSelectionResp | null> =>
  deleteJson(`${MODEL_PROFILES_PATH}/${encodeURIComponent(id)}`)

export interface SkillAttribution {
  authors: string[]
  repository_url: string | null
  repository_name: string
  kind: string
  path: string
  revision: string
}

export interface SkillAttributionInfo {
  attribution?: SkillAttribution | null
  attributionStatus?: 'ready' | 'missing' | 'invalid' | 'unavailable'
}

export interface SkillInfo extends SkillAttributionInfo {
  installationSource?: 'upload' | 'marketplace' | 'created' | 'github' | 'unknown'
  latestVersion?: string | null
  updateStatus?: 'available' | 'current' | 'unavailable' | 'unmapped'
  labels?: SkillLabel[] | null
  labelsStatus?: 'ready' | 'unavailable' | 'unmapped'
  plugin?: boolean
  name: string
  requires_login?: boolean
  display_name?: string
  version?: string
  fingerprint?: string
  description?: string
  /** Product-owned localized card copy keyed by registered interface language. */
  descriptions?: Record<string, string> | null
  /** Product-owned enablement preference; distinct from effective runtime readiness. */
  enabled: boolean
  /** Effective runtime readiness after runtime and dependency checks. */
  active: boolean
  source?: string
  builtin?: boolean
  imported?: boolean
  allowed_tools?: string[]
  context?: 'inline' | 'fork'
  agent?: string | null
  background?: boolean | null
  model?: string | null
  effort?: string | null
  disable_model_invocation?: boolean
  user_invocable?: boolean
  path?: string
  origin?: { scope?: string; root?: string; namespace?: string } | null
  /** 技能页的两个产品受控分组：随包书深技能 / 本机用户安装。 */
  group: SkillGroup
  /** 卡片领域标签；页签只由 group 驱动。 */
  category?: string
  /** Server-owned controlled icon token (doc/search/play); unknown values use the product fallback. */
  icon?: string
  /** PRD 2.1.6 技能列表展示用的一句话中文说明（后端专供 UI，不同于给 LLM 的 description）。 */
  blurb?: string
  /** 从技能广场安装时记录的来源；本地技能为 null。 */
  hub?: {
    source?: string
    registry?: string
    namespace?: string
    slug?: string
    version?: string
    fingerprint?: string
    provider?: string
  } | null
  /** 技能目录 mtime（秒）。后端取不到时不返回，前端也就不显示「更新于」。 */
  updated_at?: number | null
  removable: boolean
  /** Whether the product permits changing enabled; false for immutable ScholarSeed skills. */
  toggleable: boolean
  dependency_status?: 'ready' | 'missing' | 'error'
  unavailable_reason?: string
  dependencies?: {
    name: string
    kind?: string
    status: 'ready' | 'missing' | 'error'
    message?: string
  }[]
}

export type SkillGroup = 'scholarseed' | 'user'

export interface SkillLabel {
  slug: string
  type: 'RECOMMENDED' | 'PRIVILEGED'
  displayName: string
}

export interface MarketplaceSkill extends SkillAttributionInfo {
  labels?: SkillLabel[] | null
  labelsStatus?: 'ready' | 'unavailable'
  namespace?: string
  slug: string
  name: string
  description: string
  version: string
  moderation: 'unknown' | 'blocked' | 'clean'
  downloads?: number | null
  provider?: string
}

export interface MarketplacePage {
  total?: number
  items: MarketplaceSkill[]
  nextCursor: string | null
  registry: string
  registryAliases?: string[]
}

export interface MarketplaceDetail extends MarketplaceSkill {
  document: string
  registry: string
  provider: string
}

const MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000
const MARKETPLACE_CACHE_MAX_ENTRIES = 64
interface MarketplaceCacheEntry<Value> {
  expiresAt: number
  pending: boolean
  promise: Promise<Value>
}
const marketplacePages = new Map<string, MarketplaceCacheEntry<MarketplacePage>>()
const marketplaceLabels = new Map<string, MarketplaceCacheEntry<SkillLabel[]>>()

function cachedMarketplace<Value>(
  cache: Map<string, MarketplaceCacheEntry<Value>>,
  key: string,
  load: () => Promise<Value>
): Promise<Value> {
  const cached = cache.get(key)
  if (cached && (cached.pending || cached.expiresAt > Date.now())) {
    cache.delete(key)
    cache.set(key, cached)
    return cached.promise
  }
  const entry: MarketplaceCacheEntry<Value> = {
    expiresAt: 0,
    pending: true,
    promise: load().then(
      (value) => {
        entry.pending = false
        entry.expiresAt = Date.now() + MARKETPLACE_CACHE_TTL_MS
        return value
      },
      (error: unknown) => {
        if (cache.get(key) === entry) cache.delete(key)
        throw error
      }
    ),
  }
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > MARKETPLACE_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  return entry.promise
}

export function clearMarketplaceCache(): void {
  marketplacePages.clear()
  marketplaceLabels.clear()
}

export async function getMarketplace(
  query = '',
  cursor = '',
  label = '',
  locale = 'en'
): Promise<MarketplacePage> {
  return cachedMarketplace(
    marketplacePages,
    JSON.stringify([query, cursor, label, locale]),
    async () => {
      const response = await deviceSkillFetch({
        operation: 'marketplace',
        query,
        cursor,
        label,
        locale,
      })
      if (!response.ok) throw new Error('marketplace_unavailable')
      return response.json() as Promise<MarketplacePage>
    }
  )
}

export async function getMarketplaceLabels(locale: string): Promise<SkillLabel[]> {
  return cachedMarketplace(marketplaceLabels, locale, async () => {
    const response = await deviceSkillFetch({ operation: 'marketplace-labels', locale })
    if (!response.ok) throw new Error('marketplace_labels_unavailable')
    const data = (await response.json()) as { labels: SkillLabel[] }
    return data.labels
  })
}

export async function getMarketplaceDetail(
  slug: string,
  version: string,
  locale = 'en'
): Promise<MarketplaceDetail> {
  const response = await deviceSkillFetch({
    operation: 'marketplace-detail',
    slug,
    version,
    locale,
  })
  if (!response.ok) throw new Error('marketplace_detail_unavailable')
  return response.json() as Promise<MarketplaceDetail>
}

export async function installMarketplaceSkill(
  slug: string,
  version: string,
  enabled = true
): Promise<SkillMutation> {
  return mutateSkillRequest({ operation: 'marketplace-install', slug, version, enabled })
}

export async function updateMarketplaceSkill(skill: SkillInfo): Promise<SkillMutation> {
  if (
    skill.group !== 'user' ||
    skill.hub?.source !== 'clawhub' ||
    skill.updateStatus !== 'available' ||
    !skill.latestVersion ||
    !skill.hub.version
  ) {
    return { ok: false, code: 'invalid_identity' }
  }
  return mutateSkillRequest({
    operation: 'marketplace-update',
    name: skill.name,
    version: skill.latestVersion,
    expectedVersion: skill.hub.version,
  })
}

export interface SkillMutation {
  ok: boolean
  name?: string
  error?: string
  /** 后端的结构化错误分类, 让 UI 按分支交互而不是匹配文案。 */
  code?: string
  /** 重名时后端回传的冲突技能名。 */
  conflictName?: string
}

/** 上传安装失败的分类, 与后端 SKILL_ERROR_* 对齐。 */
export const SKILL_ERROR_DUPLICATE = 'duplicate_name'

async function deviceSkillFetch(request: DeviceSkillRequest): Promise<Response> {
  const result = await window.scholarseed.deviceSkills(request)
  return new Response(result.body, { status: result.status })
}

/** 技能详情页展示的 SKILL.md 全文。 */
export async function getSkillDocument(name: string): Promise<string> {
  const response = await deviceSkillFetch({ operation: 'document', name })
  if (!response.ok) throw new SkillDocumentError(response.status)
  const data = (await response.json()) as { document?: string }
  return data?.document ?? ''
}

export async function deleteSkill(name: string): Promise<SkillMutation> {
  return mutateSkillRequest({ operation: 'delete', name })
}

export async function uploadSkillFile(file: File): Promise<SkillMutation> {
  return mutateSkillRequest({
    operation: 'upload',
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })
}

export interface SkillUploadPreview {
  name: string
  description: string
  document: string
  version: string
  provider: string
  plugin: boolean
}

export async function previewSkillFile(file: File): Promise<SkillUploadPreview> {
  const response = await deviceSkillFetch({
    operation: 'upload-preview',
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail?.message || 'invalid_package')
  return body.preview as SkillUploadPreview
}

export async function createSkill(input: {
  name: string
  description: string
  instructions: string
}): Promise<SkillMutation> {
  return mutateSkill('/api/capabilities/skills/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function importSkillFromGithub(url: string): Promise<SkillMutation> {
  return mutateSkill('/api/capabilities/skills/import/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

/**
 * 统一把后端的 detail 错误提上来，避免 UI 只能显示「失败」。
 *
 * 安装类接口的 detail 是结构化对象 (`{code, message, name}`)，重名分支要靠 `code` 识别；
 * 其它接口仍是纯字符串 detail，两种都要兼容。
 */
async function mutateSkill(path: string, init: RequestInit): Promise<SkillMutation> {
  return skillMutationResponse(() => apiFetch(path, init))
}

async function mutateSkillRequest(request: DeviceSkillRequest): Promise<SkillMutation> {
  return skillMutationResponse(() => deviceSkillFetch(request))
}

async function skillMutationResponse(
  fetchResponse: () => Promise<Response>
): Promise<SkillMutation> {
  try {
    const response = await fetchResponse()
    const payload = (await response.json().catch(() => ({}))) as {
      installed?: { name?: string }
      name?: string
      detail?: string | { code?: string; message?: string; name?: string }
    }
    if (!response.ok) {
      const detail = payload?.detail
      if (detail && typeof detail === 'object') {
        return {
          ok: false,
          error: detail.message || `HTTP ${response.status}`,
          code: detail.code,
          conflictName: detail.name,
        }
      }
      return { ok: false, error: detail || `HTTP ${response.status}` }
    }
    window.dispatchEvent(
      new CustomEvent(SKILL_CATALOG_CHANGED_EVENT, {
        detail: { name: payload?.installed?.name ?? payload?.name },
      })
    )
    return { ok: true, name: payload?.installed?.name ?? payload?.name }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
export class SkillDocumentError extends Error {
  constructor(readonly status: number) {
    super('skill_document_unavailable')
  }
}

export class SkillCatalogError extends Error {
  constructor(readonly status: number) {
    super('skill_catalog_unavailable')
  }
}

export async function getSkills(surface?: SkillSurface, locale?: string): Promise<SkillInfo[]> {
  const response = await deviceSkillFetch({ operation: 'list', surface, locale })
  if (!response.ok) throw new SkillCatalogError(response.status)
  const data = (await response.json()) as { skills?: SkillInfo[] }
  return data?.skills ?? []
}

export async function setSkillActive(name: string, active: boolean): Promise<boolean> {
  try {
    const response = await deviceSkillFetch({ operation: 'toggle', name, enabled: active })
    if (response.ok)
      window.dispatchEvent(new CustomEvent(SKILL_CATALOG_CHANGED_EVENT, { detail: { name } }))
    return response.ok
  } catch {
    return false
  }
}
export async function deleteSession(sid: string): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      timeoutMs: RESUME_REQUEST_TIMEOUT_MS,
    })
    if (!response.ok) return { ok: false, status: response.status }
    const payload: unknown = await response.json()
    return {
      ok: isRecord(payload) && payload.ok === true && payload.session_id === sid,
      status: response.status,
    }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function terminateSession(sid: string): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/terminate`, {
      method: 'POST',
    })
    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function setSessionArchived(
  sid: string,
  archived: boolean
): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
      timeoutMs: RESUME_REQUEST_TIMEOUT_MS,
    })
    if (!response.ok) return { ok: false, status: response.status }
    const payload: unknown = await response.json()
    return {
      ok:
        isRecord(payload) &&
        payload.ok === true &&
        payload.session_id === sid &&
        payload.archived === archived,
      status: response.status,
    }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function setSessionPinned(
  sid: string,
  pinned: boolean
): Promise<{ ok: boolean; status: number; pinned?: boolean }> {
  try {
    const response = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
    if (!response.ok) return { ok: false, status: response.status }
    const payload: unknown = await response.json()
    if (
      !isRecord(payload) ||
      payload.ok !== true ||
      payload.session_id !== sid ||
      typeof payload.pinned !== 'boolean'
    ) {
      return { ok: false, status: response.status }
    }
    return { ok: true, status: response.status, pinned: payload.pinned }
  } catch {
    return { ok: false, status: 0 }
  }
}

/** 重命名会话 (PATCH /api/serve/sessions/{id})。 */
export async function renameSession(
  sid: string,
  title: string
): Promise<{ ok: boolean; status: number; title?: string; title_fallback?: SessionTitleFallback }> {
  try {
    const r = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const payload = (await r.json().catch(() => ({}))) as {
      title?: unknown
      title_fallback?: unknown
    }
    return {
      ok: r.ok,
      status: r.status,
      ...(typeof payload.title === 'string'
        ? { title: payload.title, title_fallback: sessionTitleFallback(payload.title_fallback) }
        : {}),
    }
  } catch {
    return { ok: false, status: 0 }
  }
}

export interface FileItem {
  name: string
  dir: boolean
  size: number
  updated_at?: number
  artifact?: SessionArtifact
}
export interface FilesResp {
  root: string
  path: string
  crumbs: string[]
  items: FileItem[]
  total?: number
  offset?: number
  project_path?: string | null
  artifacts?: SessionArtifact[]
  literature?: TaskDocument[]
  has_files?: boolean
}
export interface TaskDocument {
  id: string
  title: string
  literature_id: string
  attachment_id: string | null
}
export const getTaskFiles = (
  projectPath: string,
  cursor = ''
): Promise<{
  entries: { session: ServeSession; files: FilesResp | null }[]
  next_cursor?: string | null
} | null> =>
  getJson('/api/serve/task-files?' + new URLSearchParams({ project_path: projectPath, cursor }))
export async function getWorkspaceFiles(path = '', timeoutMs?: number): Promise<FilesResp | null> {
  const result = await getJson<FilesResp>(
    '/api/research/workspace/files' + (path ? `?path=${encodeURIComponent(path)}` : ''),
    timeoutMs
  )
  if (result?.root) void window.scholarseed.addAuthorizedRoot('workspace', result.root)
  return result
}

/** Browse the immutable filesystem root bound to one product session. */
export async function getSessionFiles(
  sessionId: string,
  path = '',
  timeoutMs?: number,
  offset = 0,
  outputsOnly = false
): Promise<FilesResp | null> {
  const query = new URLSearchParams()
  if (path) query.set('path', path)
  if (offset) query.set('offset', String(offset))
  if (outputsOnly) query.set('outputs_only', 'true')
  const result = await getJson<FilesResp>(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/files` + (query.size ? `?${query}` : ''),
    timeoutMs
  )
  if (result?.root) void window.scholarseed.addAuthorizedRoot('session', result.root)
  return result
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
}
/** 读单个工作区文件正文 (全页 Tab 编辑器)。 */
export const readWorkspaceFile = (path: string): Promise<FileContent | null> =>
  getJson(`/api/research/workspace/file?path=${encodeURIComponent(path)}`)

export const readSessionFile = (sessionId: string, path: string): Promise<FileContent | null> =>
  getJson(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`
  )

/** Read a file only through its durable session-artifact identity. */
export const readSessionArtifact = (
  sessionId: string,
  artifactId: string
): Promise<FileContent | null> =>
  getJson(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`
  )

/** 工作区文件的原始字节 URL (图片等二进制内置预览用)。 */
export const workspaceFileRawUrl = (path: string): string =>
  `${apiBase()}/api/research/workspace/file/raw?path=${encodeURIComponent(path)}`

export const sessionFileRawUrl = (sessionId: string, path: string): string =>
  `${apiBase()}/api/serve/sessions/${encodeURIComponent(sessionId)}/files/raw?path=${encodeURIComponent(path)}`

/** Raw bytes for an indexed session artifact (images and other binary previews). */
export const sessionArtifactRawUrl = (sessionId: string, artifactId: string): string =>
  `${apiBase()}/api/serve/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/raw`

export interface RawFileBytes {
  bytes: Uint8Array
  mediaType: string
}

async function readRawBytes(path: string): Promise<RawFileBytes | null> {
  try {
    const response = await apiFetch(path)
    if (!response.ok) return null
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get('content-type') || 'application/octet-stream',
    }
  } catch {
    return null
  }
}

/** Authenticated raw-byte reads used by the native Save Copy flow. */
export const downloadWorkspaceFile = (path: string): Promise<RawFileBytes | null> =>
  readRawBytes(`/api/research/workspace/file/raw?path=${encodeURIComponent(path)}`)

export const downloadSessionFile = (
  sessionId: string,
  path: string
): Promise<RawFileBytes | null> =>
  readRawBytes(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/files/raw?path=${encodeURIComponent(path)}`
  )

export const downloadSessionArtifact = (
  sessionId: string,
  artifactId: string
): Promise<RawFileBytes | null> =>
  readRawBytes(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/raw`
  )

export const SESSION_DIAGNOSTIC_FILENAME = 'scholarseed-diagnostic.zip'

export interface DiagnosticPolicy {
  active: boolean
  mode: 'metadata' | 'detailed'
  revision: number
  expires_at: number
  effective_from_submission: string
}

export interface DiagnosticPreview {
  manifest: {
    content_available: boolean
    missing_blocks: number
    content_categories: string[]
    submissions: string[]
    truncated_blocks: number
    missing_reasons: string[]
  }
  bytes: number
  token: string
  confirmation: Record<string, unknown>
}

export class DiagnosticOperationError extends Error {
  constructor(readonly status: number) {
    super('diagnostic_operation_failed')
  }
}

async function diagnosticRequest(
  sessionId: string,
  suffix: string,
  init?: RequestInit
): Promise<Response> {
  const response = await apiFetch(
    `/api/serve/sessions/${encodeURIComponent(sessionId)}/${suffix}`,
    init
  )
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw typeof body?.detail === 'string'
      ? new Error(body.detail)
      : new DiagnosticOperationError(response.status)
  }
  return response
}

export async function getDiagnosticPolicy(sessionId: string): Promise<DiagnosticPolicy> {
  return (await diagnosticRequest(sessionId, 'diagnostic-policy')).json()
}

export async function setDiagnosticPolicy(
  sessionId: string,
  policy: DiagnosticPolicy,
  enabled: boolean
): Promise<DiagnosticPolicy> {
  return (
    await diagnosticRequest(sessionId, 'diagnostic-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: enabled ? 'detailed' : 'metadata',
        expected_revision: policy.revision,
      }),
    })
  ).json()
}

export async function previewDetailedDiagnostics(sessionId: string): Promise<DiagnosticPreview> {
  return (await diagnosticRequest(sessionId, 'diagnostics/preview?mode=detailed')).json()
}

export async function downloadDetailedDiagnostics(
  sessionId: string,
  preview: DiagnosticPreview
): Promise<ArrayBuffer> {
  return (
    await diagnosticRequest(sessionId, 'diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: preview.confirmation,
        token: preview.token,
        accepted: true,
      }),
    })
  ).arrayBuffer()
}

export async function clearDetailedDiagnostics(sessionId: string): Promise<void> {
  await diagnosticRequest(sessionId, 'diagnostics/content', { method: 'DELETE' })
}

export const downloadSessionDiagnostics = (sessionId: string): Promise<RawFileBytes | null> =>
  readRawBytes(`/api/serve/sessions/${encodeURIComponent(sessionId)}/diagnostics`)

export interface SystemPathResult {
  ok: boolean
  path?: string
  error?: string
  applicationFailure?: { code: 'desktop_bridge_unavailable' }
}

/** Electron-native action: open a workspace file with the system default app. */
export async function openSystemPath(path: string): Promise<SystemPathResult> {
  if (!window.scholarseed?.openPath)
    return {
      ok: false,
      error: 'desktop bridge unavailable',
      applicationFailure: { code: 'desktop_bridge_unavailable' },
    }
  try {
    return await window.scholarseed.openPath(path)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Electron-native action: reveal a workspace file in Finder or Explorer. */
export async function revealSystemPath(path: string): Promise<SystemPathResult> {
  if (!window.scholarseed?.revealPath)
    return {
      ok: false,
      error: 'desktop bridge unavailable',
      applicationFailure: { code: 'desktop_bridge_unavailable' },
    }
  try {
    return await window.scholarseed.revealPath(path)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface OpenWithApp {
  name: string
  path: string
  isDefault: boolean
  icon?: string
}

/** 「打开方式」候选应用 (系统 NSWorkspace 给出的能打开此文件的应用, 默认项置顶)。 */
export async function appsForFile(filePath: string): Promise<OpenWithApp[]> {
  if (!window.scholarseed?.appsForFile) return []
  try {
    return await window.scholarseed.appsForFile(filePath)
  } catch {
    return []
  }
}

/** 用指定应用打开工作区文件。 */
export async function openPathWith(
  path: string,
  appPath: string
): Promise<{ ok: boolean; error?: string }> {
  if (!window.scholarseed?.openPathWith) return { ok: false, error: 'desktop bridge unavailable' }
  try {
    return await window.scholarseed.openPathWith(path, appPath)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Register exact user-selected local paths for one session without copying content. */
export interface RegisteredLocalPath {
  reference_id: string
  path: string
  name: string
  kind?: 'file' | 'directory'
  media_type: string
  size?: number
}

export async function registerLocalPaths(
  sessionId: string,
  paths: string[]
): Promise<RegisteredLocalPath[] | null> {
  try {
    const response = await apiFetch(
      `/api/serve/sessions/${encodeURIComponent(sessionId)}/file-references`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      }
    )
    if (!response.ok) return null
    const payload = (await response.json()) as { references?: RegisteredLocalPath[] }
    return Array.isArray(payload.references) ? payload.references : null
  } catch {
    return null
  }
}

/** 浏览器降级和无真实路径的合成 File 仍可上传；Electron 本地文件走上面的直接引用。 */
export interface UploadedAttachment {
  path: string
  relative_path?: string
  name: string
  media_type: string
  sha256?: string
  size?: number
}

export async function uploadAttachmentFile(
  sessionId: string,
  file: File
): Promise<UploadedAttachment | null> {
  try {
    const fd = new FormData()
    fd.append('file', file)
    const r = await apiFetch(`/api/serve/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: 'POST',
      body: fd,
    })
    if (!r.ok) return null
    const uploaded = (await r.json()) as Partial<UploadedAttachment> & { absolute_path?: string }
    if (!uploaded.absolute_path) return null
    return {
      path: uploaded.absolute_path,
      relative_path: uploaded.relative_path,
      name: uploaded.name || file.name,
      media_type: uploaded.media_type || file.type || 'application/octet-stream',
      sha256: uploaded.sha256,
      size: uploaded.size,
    }
  } catch {
    return null
  }
}

// ── 问题反馈 (由宿主 bridge 提交) ──

/** 截图与日志包的上限与服务端 `MAX_IMAGES` 对齐; 超过则服务端 422。 */
export const FEEDBACK_MAX_IMAGES = FEEDBACK_LIMITS.images

export interface FeedbackInput {
  description: string
  email?: string
  /** 附带本机诊断日志。 */
  includeLogs?: boolean
  /** 附带对话 trace (含完整提问与模型输出)。默认附带、可取消; 没有勾选框的入口须由告知文案承担知情。 */
  includeTrace?: boolean
  /**
   * 当前点开的会话 id (store 的 activeSession)。serve 侧只收这一个会话的对话记录;
   * 缺省/空字串 = 无活跃会话, 就一字对话也不打包。
   */
  sessionId?: string | null
  images?: File[]
  /** 问题反馈录制器生成的结构化报告，由 serve 固定名称写入反馈包。 */
  recordingReport?: File
  /** Renderer 控制台与接口请求的有界诊断快照，由 serve 写入反馈包。 */
  rendererDiagnostics?: File
}

export interface FeedbackResult extends FeedbackSubmissionResult {
  error?: string
}

/**
 * 提交一条问题反馈。Desktop 的提交、凭据和诊断采集由 Main 持有。
 *
 * 不上报任何身份字段: 归属由 Damoclaw 拿本次请求的凭据向账号服务求证得到 ——
 * 客户端自报的手机号在管理台会被当成回访号码, 不能由这一层说了算。
 */
export async function submitFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  try {
    if (input.includeLogs) flushApiDiagnostics()
    if (
      (input.images?.length ?? 0) > FEEDBACK_LIMITS.images ||
      (input.images ?? []).reduce((total, file) => total + file.size, 0) >
        FEEDBACK_LIMITS.imagesBytes ||
      [input.recordingReport, input.rendererDiagnostics].some(
        (file) => file && file.size > FEEDBACK_LIMITS.reportBytes
      )
    )
      return { ok: false, code: 'invalid_request' }
    return await window.scholarseed.submitFeedback({
      description: input.description,
      email: input.email,
      includeLogs: Boolean(input.includeLogs),
      includeTrace: Boolean(input.includeLogs && input.includeTrace),
      sessionId: input.sessionId,
      images: await Promise.all(
        (input.images ?? []).map(async (file) => ({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }))
      ),
      recordingReport: input.recordingReport
        ? new Uint8Array(await input.recordingReport.arrayBuffer())
        : undefined,
      rendererDiagnostics: input.rendererDiagnostics
        ? new Uint8Array(await input.rendererDiagnostics.arrayBuffer())
        : undefined,
    })
  } catch {
    return { ok: false, code: 'unavailable' }
  }
}

// ── Local and hosted-account authentication ──

export type { AuthStatus, AuthUser } from './app/api/auth.ts'
export { getAuthStatus, getAuthMe, postAuthLogout } from './app/api/auth.ts'

export const createSubscriptionProfile = (): Promise<PersonalApiResult<PersonalApiMutationResp>> =>
  profileRequest('POST', MODEL_PROFILES_PATH, {
    authentication: 'oauth',
    oauth_provider: 'chatgpt',
    selected_models: [],
  })
export const saveSubscriptionModels = (
  id: string,
  models: PersonalApiModel[]
): Promise<PersonalApiResult<PersonalApiMutationResp>> =>
  profileRequest('PUT', `${MODEL_PROFILES_PATH}/${encodeURIComponent(id)}`, {
    selected_models: models,
  })
export const subscriptionModels = (
  id: string
): Promise<PersonalApiResult<{ models: PersonalApiModel[] }>> =>
  profileRequest('GET', `/api/settings/model-connections/${encodeURIComponent(id)}/models`)
export const subscriptionStatus = (
  id: string,
  transaction: string
): Promise<PersonalApiResult<{ state: string; error: string }>> =>
  profileRequest(
    'GET',
    `/api/settings/model-connections/${encodeURIComponent(id)}/login/${encodeURIComponent(transaction)}`
  )
export const cancelSubscriptionLogin = (
  id: string,
  transaction: string
): Promise<PersonalApiResult<unknown>> =>
  profileRequest(
    'DELETE',
    `/api/settings/model-connections/${encodeURIComponent(id)}/login/${encodeURIComponent(transaction)}`
  )
export const disconnectSubscription = (
  id: string
): Promise<PersonalApiResult<PersonalApiProfilesResp>> =>
  profileRequest('DELETE', `/api/settings/model-connections/${encodeURIComponent(id)}/credentials`)

// --- MCP Configuration ---

export interface McpStdioServerConfig {
  description?: string
  timeout?: number | null
  startup_timeout?: number | null
  id: string
  name: string
  enabled: boolean
  transport: 'stdio'
  command: string
  args: string[]
  cwd?: string
  environment?: Record<string, string>
}

export interface McpHttpServerConfig {
  description?: string
  timeout?: number | null
  startup_timeout?: number | null
  id: string
  name: string
  enabled: boolean
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export interface McpServerStatus {
  id: string
  state: 'pending_apply' | 'connecting' | 'auth_required' | 'ready' | 'failed' | 'disabled'
  tool_count: number | null
  safe_error: string
}

export interface McpConfigurationView {
  servers: McpServerStatus[]
  configuration: {
    revision: number
    servers: McpServerConfig[]
  }
  supported: boolean
  state: string
  safe_error: string | null
}

/** MCP 配置路由仅宿主进程可达；渲染层经主进程 IPC 代理，非桌面环境回退直连。 */
async function mcpSettingsFetch(request: McpSettingsRequest): Promise<Response | null> {
  const bridge = window.scholarseed?.mcpSettings
  if (!bridge) {
    const { path, init } = mcpSettingsRequest(request)
    try {
      return await apiFetch(path, init)
    } catch {
      return null
    }
  }
  try {
    const result = await bridge(request)
    return new Response(result.body, { status: result.status })
  } catch {
    return null
  }
}

export async function getMcpConfiguration(): Promise<McpConfigurationView | null> {
  const response = await mcpSettingsFetch({ operation: 'status' })
  if (!response || !response.ok) return null
  return (await response.json()) as McpConfigurationView
}

export interface ConnectorInfo {
  signature?: string
  management_url?: string
  revocation_scope?: 'remote' | 'local' | ''
  description?: string
  account_context?: string
  scopes?: string
  expires_at?: number | null
  tools_fetched_at?: number | null
  reauthorization?: boolean
  custom?: boolean
  configuration?: McpServerConfig
  id: string
  name: string
  source_url: string
  methods: ('key' | 'oauth')[]
  key_label: string
  help_url: string
  transport: 'http' | 'sse' | 'stdio'
  installed: boolean
  method: 'key' | 'oauth' | null
  url: string
  enabled: boolean
  authorized: boolean
  state: McpServerStatus['state'] | null
  error: string
  authorization_error: string
  version: string | null
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] | null
  attempt: { authorization_url: string; expires_at: number } | null
}

export class ConnectorError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

async function connectorResponse(request: McpSettingsRequest): Promise<unknown> {
  const response = await mcpSettingsFetch(request)
  if (!response) throw new ConnectorError('connector_network_unavailable')
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new ConnectorError(
      typeof body?.detail === 'string' ? body.detail : 'connector_service_unavailable'
    )
  return body
}

export async function getConnectors(): Promise<ConnectorInfo[]> {
  const body = (await connectorResponse({ operation: 'connectors' })) as {
    connectors: ConnectorInfo[]
  }
  return body.connectors
}

export async function updateConnector(id: string, action: ConnectorAction): Promise<ConnectorInfo> {
  return (await connectorResponse({ operation: 'connector', id, action })) as ConnectorInfo
}

export async function saveCustomConnectors(id: string, action: ConnectorAction): Promise<void> {
  await connectorResponse({ operation: 'connector', id, action })
}

export async function replaceMcpConfiguration(
  expectedRevision: number,
  servers: McpServerConfig[]
): Promise<McpConfigurationView | null> {
  const response = await mcpSettingsFetch({
    operation: 'replace',
    expectedRevision,
    servers,
  })
  if (!response || !response.ok) return null
  return (await response.json()) as McpConfigurationView
}
