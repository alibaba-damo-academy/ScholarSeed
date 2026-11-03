import { requestFailureFeedback } from './api.ts'
import { feedback, type ForegroundMessage } from './contracts/feedback.ts'
import type { TFunction } from 'i18next'

import type {
  AspEnvelope,
  BackendHealthResp,
  ModeChangeResult,
  ModeInfo,
  OperationStateData,
  PendingHIL,
  RuntimeIncidentData,
  SessionResumeFailure,
  SessionTurnStatus,
  SseConnectionState,
  UncertainOperationSnapshot,
  getSharedRuntimeReconfiguration,
} from './api'
import type {
  ApplicationRequestFailure,
  Cognitive,
  ConvItem,
  RuntimeStatusMessage,
  RuntimeReadiness,
  SessionStatus,
  Thread,
} from './model'
import { projectHilCard, hilResolution, hilSubmissionFailure } from './hil.ts'
import { insertTurnRuntimeItem, settleInterruptedActivities } from './transcript.ts'
import { SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE } from './failures.ts'

const SERVICE_TRANSPORT_INCIDENT_ID = 'service-transport'
const UNKNOWN_RESPONSE_RPC_METHODS = new Set(['server-response/hil', 'server-response/tool'])

interface BackendAvailability {
  backendReady: boolean
  workbenchReady: boolean
  serviceInstanceId: string | null
}

export function projectBackendAvailability(
  current: BackendAvailability,
  health: BackendHealthResp | null,
  reconfiguration: Awaited<ReturnType<typeof getSharedRuntimeReconfiguration>> | null
): BackendAvailability {
  if (
    health === null &&
    current.backendReady &&
    current.workbenchReady &&
    current.serviceInstanceId &&
    reconfiguration?.state === 'accepted' &&
    reconfiguration.service_instance_id === current.serviceInstanceId
  ) {
    return {
      backendReady: current.backendReady,
      workbenchReady: current.workbenchReady,
      serviceInstanceId: current.serviceInstanceId,
    }
  }
  const ready = health?.ok === true
  return {
    backendReady: ready,
    workbenchReady: ready && health?.workbench_ready === true,
    serviceInstanceId: health?.service_instance_id ?? null,
  }
}

export function permissionModeNeedsConfirmation(
  info: ModeInfo | null,
  target: string,
  running: boolean
): boolean {
  return running && !info?.current_turn_modes?.includes(target)
}

export function permissionModeShowsNextTurn(info: ModeInfo | null): boolean {
  return Boolean(info?.next_turn_selected && info.deferred && info.active_mode)
}
const TURN_UNKNOWN_MESSAGES: Record<string, string> = {
  runtime_rpc_timeout: '请求可能已经送达运行时，但客户端没有在时限内收到确认。',
  runtime_transport_lost: '请求提交期间与 Agent 运行时的本地连接断开，执行结果尚未确认。',
  agent_runtime_exit: '请求提交期间 Agent 运行时已退出，执行结果尚未确认。',
}
const TURN_UNKNOWN_MESSAGE_KEYS = {
  runtime_rpc_timeout: 'timeout',
  runtime_transport_lost: 'transportLost',
  agent_runtime_exit: 'processExit',
} as const
export const SESSION_RESUME_REQUEST_EVENT = 'scholarseed:session-resume-request'
const SANDBOX_INCIDENT_MESSAGE_KEYS = {
  windows_sandbox_setup_failed: 'runtime.reason.windows_sandbox_setup_failed',
  windows_sandbox_setup_in_progress: 'runtime.reason.windows_sandbox_setup_in_progress',
  windows_sandbox_setup_unknown: 'runtime.reason.windows_sandbox_setup_unknown',
  windows_sandbox_policy_rejected: 'runtime.reason.windows_sandbox_policy_rejected',
  windows_sandbox_setup_cancelled: 'runtime.reason.windows_sandbox_setup_cancelled',
  windows_sandbox_tool_access_failed: 'runtime.reason.windows_sandbox_tool_access_failed',
} as const
const INCIDENT_MESSAGE_KEYS = {
  ...SANDBOX_INCIDENT_MESSAGE_KEYS,
  [SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE]: 'runtime.reason.subscription_capability_unsupported',
  agent_runtime_exit: 'runtime.reason.agent_runtime_exit',
  runtime_transport_lost: 'runtime.reason.runtime_transport_lost',
  runtime_rpc_timeout: 'runtime.reason.runtime_rpc_timeout',
  agent_runtime_unavailable: 'runtime.reason.agent_runtime_unavailable',
  thread_resume_failed: 'runtime.reason.thread_resume_failed',
  codex_turn_retrying: 'runtime.reason.codex_turn_retrying',
  codex_terminal_outcome_conflict: 'runtime.reason.codex_terminal_outcome_conflict',
  codex_thread_not_loaded: 'runtime.reason.codex_thread_not_loaded',
  codex_thread_closed: 'runtime.reason.codex_thread_closed',
  codex_repeated_tool_loop: 'runtime.reason.codex_repeated_tool_loop',
  codex_repeated_tool_interrupt_failed: 'runtime.reason.codex_repeated_tool_interrupt_failed',
  // 键是 codex 适配器 PROVIDER_CREDITS_MESSAGE 原文：事件条 reason 取 safe_error（文案而非
  // 码），产品级计费文案经此登记回本地化资源；适配器改文案须同步本条目。
  'The account credit balance is exhausted.': 'runtime.reason.credit_balance_exhausted',
} as const

const MODE_FAILURE_MESSAGES: Record<string, string> = {
  permission_mode_connection_failed: '无法连接书深服务，请检查连接后重试权限切换。',
  session_permission_switch_requires_hil_resolution: '请先处理当前审批，再切换权限模式。',
  session_permission_policy_immutable: '当前运行时未能更新权限，请重新连接会话后重试。',
}
const MODE_FAILURE_FALLBACK = '权限模式切换未成功，请检查运行时连接后重试。'

export function permissionModeFailure(result: ModeChangeResult): string {
  return MODE_FAILURE_MESSAGES[result.error ?? ''] || MODE_FAILURE_FALLBACK
}

type ThreadUpdate = Partial<Thread>

export interface SessionResumeRequestDetail {
  sessionId: string
}

export function requestSessionResume(sessionId: string): void {
  window.dispatchEvent(
    new CustomEvent<SessionResumeRequestDetail>(SESSION_RESUME_REQUEST_EVENT, {
      detail: { sessionId },
    })
  )
}

export function shouldRetrySessionResume(
  failure: SessionResumeFailure,
  attempt: number,
  maxAttempts: number
): boolean {
  return !failure.terminal && attempt < maxAttempts
}

export function projectResumeRunState(
  thread: Pick<Thread, 'running' | 'status'>
): Pick<Thread, 'running' | 'status'> {
  return { running: thread.running, status: thread.status }
}

export function recoveredTurnOutcome(
  status: SessionTurnStatus
): NonNullable<Thread['turnOutcomes']>[string] {
  if (status === 'waiting') return 'running'
  if (status === 'unknown_outcome') return 'unknown'
  if (status === 'unknown_confirmed') return 'completed'
  return status
}

export function sessionResumeStatusItem(
  sessionId: string,
  text: Extract<ConvItem, { kind: 'status' }>['text'],
  tone: Cognitive,
  actionable: boolean
): Extract<ConvItem, { kind: 'status' }> {
  return {
    kind: 'status',
    text,
    tone,
    incidentId: `session-resume:${sessionId}`,
    ...(actionable ? { runtimeAction: 'retry_session_resume', actionSessionId: sessionId } : {}),
  }
}

export function projectSessionState(
  data: Extract<AspEnvelope, { type: 'session_state' }>['data']
): Pick<
  Thread,
  'runtimeId' | 'running' | 'status' | 'activeTurnId' | 'recoveryBlocked' | 'recoveryPending'
> {
  let status: SessionStatus = 'dormant'
  if (data.state === 'starting' || data.state === 'running') status = 'running'
  else if (data.state === 'waiting') status = 'waiting'
  else if (data.state === 'failed') status = 'failed'
  else if (data.state === 'interrupted') status = 'abandon'
  else if (data.state === 'closed') status = 'done'
  if (data.recovery_blocked) status = 'failed'
  return {
    runtimeId: data.runtime_id,
    activeTurnId: data.recovery_blocked ? null : (data.active_turn_id ?? null),
    running: status === 'running' || status === 'waiting',
    status,
    ...(data.recovery_blocked !== undefined ? { recoveryBlocked: data.recovery_blocked } : {}),
    ...(data.recovery_pending !== undefined ? { recoveryPending: data.recovery_pending } : {}),
  }
}

export function canOfferTurnRecovery(
  thread: Pick<Thread, 'running' | 'status' | 'readOnly'>
): boolean {
  return (
    !thread.readOnly &&
    thread.running !== true &&
    thread.status !== 'running' &&
    thread.status !== 'waiting'
  )
}

export function canContinueFailedTurn(
  thread: Thread,
  failure: Extract<ConvItem, { kind: 'error' }>
): boolean {
  if (failure.runtimeAction === 'confirm_turn_unknown') {
    return (
      canOfferTurnRecovery(thread) &&
      !thread.recoveryPending &&
      Boolean(failure.turnId) &&
      failure.actionState !== 'submitting' &&
      failure.actionState !== 'outcome_unknown' &&
      !thread.queuedMessages?.some(
        (message) =>
          message.state !== 'outcome_unknown' ||
          ![message.nativeTurnId, message.queuedMessageId].includes(failure.turnId)
      ) &&
      [...thread.conversation].reverse().find((item) => Boolean(item.turnId))?.turnId ===
        failure.turnId
    )
  }
  if (
    !canOfferTurnRecovery(thread) ||
    thread.terminated ||
    thread.recoveryPending ||
    failure.failure?.kind === 'capability' ||
    thread.conversation.some(
      (item) =>
        item.kind === 'error' &&
        item.turnId === failure.turnId &&
        item.failure?.kind === 'capability'
    ) ||
    !failure.turnId ||
    failure.runtimeAction !== 'continue_turn' ||
    failure.actionState === 'submitting' ||
    failure.actionState === 'outcome_unknown' ||
    thread.queuedMessages?.some((message) => message.state !== 'failed')
  )
    return false
  const latest = [...thread.conversation].reverse().find((item) => Boolean(item.turnId))
  return (
    latest?.turnId === failure.turnId &&
    (thread.turnOutcomes?.[failure.turnId] ?? thread.status) === 'failed'
  )
}

export function hasCurrentTurnCapabilityFailure(thread: Pick<Thread, 'conversation'>): boolean {
  const turnId = [...thread.conversation].reverse().find((item) => Boolean(item.turnId))?.turnId
  return Boolean(
    turnId &&
    thread.conversation.some(
      (item) =>
        item.kind === 'error' && item.turnId === turnId && item.failure?.kind === 'capability'
    )
  )
}

export function catalogRunStateIsCurrent(
  catalog: { last_seq?: number; running?: boolean; waiting?: boolean },
  thread: Pick<Thread, 'lastSeq' | 'running'>
): boolean {
  if (catalog.last_seq === undefined) return true
  if (catalog.last_seq !== thread.lastSeq) return catalog.last_seq > thread.lastSeq
  return !(thread.running === false && (catalog.running === true || catalog.waiting === true))
}

const TURN_UNKNOWN_TITLE = '上次任务已中断'

interface TurnUnknownProjection {
  sessionId: string
  turnId: string
  itemId?: string
  incidentId?: string
  message?: string
  completedAt?: number
}

/** Project an ambiguous terminal once; the only action is explicit user confirmation. */
export function reportTurnUnknown(thread: Thread, data: TurnUnknownProjection): ThreadUpdate {
  const message =
    TURN_UNKNOWN_MESSAGES[data.message ?? ''] ??
    '请求可能已经送达 Agent 运行时，但客户端没有收到确认。'
  const card: Extract<ConvItem, { kind: 'error' }> = {
    kind: 'error',
    title: TURN_UNKNOWN_TITLE,
    turnUnknown: {
      reason:
        data.message &&
        Object.prototype.hasOwnProperty.call(TURN_UNKNOWN_MESSAGE_KEYS, data.message)
          ? TURN_UNKNOWN_MESSAGE_KEYS[data.message as keyof typeof TURN_UNKNOWN_MESSAGE_KEYS]
          : 'unconfirmed',
    },
    message,
    action: '是否继续任务？',
    incidentId: data.incidentId,
    runtimeAction: 'confirm_turn_unknown',
    actionSessionId: data.sessionId,
    actionTurnId: data.turnId,
    actionState: 'idle',
    turnId: data.turnId,
    itemId: data.itemId,
  }
  const existingIndex = thread.conversation.findIndex(
    (item) =>
      item.kind === 'error' &&
      item.runtimeAction === 'confirm_turn_unknown' &&
      item.actionTurnId === data.turnId
  )
  const settled = settleInterruptedActivities(
    thread.conversation,
    data.turnId,
    data.completedAt ?? Date.now()
  ).map((item) =>
    item.kind === 'hil' &&
    item.turnId === data.turnId &&
    (item.hilState === 'pending' || item.hilState === 'submitting')
      ? { ...item, hilState: 'stale' as const, ...hilResolution({ kind: 'stale' }) }
      : item
  )
  let conversation: ConvItem[]
  if (existingIndex < 0) {
    conversation = insertTurnRuntimeItem(settled, card)
  } else {
    conversation = [...settled]
    const existing = conversation[existingIndex]
    conversation[existingIndex] =
      existing?.kind === 'error'
        ? {
            ...card,
            ...(existing.actionState ? { actionState: existing.actionState } : {}),
            ...(existing.actionError
              ? {
                  actionError: existing.actionError,
                  actionErrorMessage: existing.actionErrorMessage,
                }
              : {}),
          }
        : card
  }
  return {
    running: false,
    interrupting: false,
    status: 'abandon',
    turnOutcomes: { ...thread.turnOutcomes, [data.turnId]: 'unknown' },
    conversation,
  }
}

export interface SessionRecoverySnapshot {
  sessionId: string
  running: boolean
  activeTurnId: string | null
  unknownOutcome: boolean
  pendingHil: PendingHIL[]
  uncertainOperations: UncertainOperationSnapshot[]
  timestamp: number
}

/**
 * Restore state skipped by an SSE last_seq cursor. This is a pure presentation
 * projection: it cannot submit, retry, confirm, or replay any operation.
 */
export function projectSessionRecovery(
  thread: Thread,
  snapshot: SessionRecoverySnapshot
): ThreadUpdate {
  let projected: Thread =
    snapshot.running && snapshot.activeTurnId
      ? { ...thread, running: true, status: 'running', activeTurnId: snapshot.activeTurnId }
      : { ...thread, activeTurnId: null }
  for (const pending of snapshot.pendingHil) {
    const { turn_id: turnId, item_id: itemId, ...hil } = pending
    if (!hil.request_id) continue
    const hasCard = projected.conversation.some(
      (item) => item.kind === 'hil' && item.requestId === hil.request_id
    )
    projected = {
      ...projected,
      running: hil.lifetime === 'session' ? snapshot.running : true,
      status: hil.lifetime === 'session' && !snapshot.running ? projected.status : 'waiting',
      turnOutcomes:
        turnId && (hil.lifetime !== 'session' || snapshot.activeTurnId === turnId)
          ? { ...projected.turnOutcomes, [turnId]: 'running' }
          : projected.turnOutcomes,
      conversation: hasCard
        ? projected.conversation
        : insertTurnRuntimeItem(
            projected.conversation,
            projectHilCard(hil, snapshot.timestamp, turnId, itemId)
          ),
    }
  }
  if (snapshot.running && snapshot.activeTurnId) {
    projected = {
      ...projected,
      turnOutcomes: { ...projected.turnOutcomes, [snapshot.activeTurnId]: 'running' },
    }
  }
  for (const operation of snapshot.uncertainOperations) {
    if (operation.kind === 'turn') continue
    const hil = operation.hil
    if (!hil) continue
    if (
      !projected.conversation.some(
        (item) => item.kind === 'hil' && item.requestId === operation.correlation_id
      )
    ) {
      projected = {
        ...projected,
        conversation: insertTurnRuntimeItem(
          projected.conversation,
          projectHilCard(hil, snapshot.timestamp, operation.turn_id, operation.item_id)
        ),
      }
    }
    const state = operation.state === 'executing' ? 'unknown' : operation.state
    if (state !== 'unknown' && state !== 'stale') continue
    projected = {
      ...projected,
      ...reportOperationState(
        projected,
        {
          kind: operation.kind,
          correlation_id: operation.correlation_id,
          state,
          retryable: false,
          execution_count: operation.execution_count,
        },
        operation.turn_id,
        operation.item_id
      ),
    }
  }
  if (snapshot.unknownOutcome) {
    for (const operation of snapshot.uncertainOperations) {
      if (
        operation.kind !== 'turn' ||
        (operation.state !== 'executing' && operation.state !== 'unknown')
      )
        continue
      projected = {
        ...projected,
        ...reportTurnUnknown(projected, {
          sessionId: snapshot.sessionId,
          turnId: operation.correlation_id,
          incidentId: operation.incident_id,
          message: operation.safe_error || undefined,
        }),
      }
    }
  }
  return {
    running: projected.running,
    interrupting: projected.interrupting,
    status: projected.status,
    turnOutcomes: projected.turnOutcomes,
    conversation: projected.conversation,
  }
}

function appendRuntimeItem(conversation: ConvItem[], item: ConvItem): ConvItem[] {
  return [...conversation, item]
}

export function reportOperationState(
  thread: Thread,
  data: OperationStateData,
  turnId?: string,
  itemId?: string
): ThreadUpdate {
  if (data.state !== 'unknown' && data.state !== 'stale') return {}
  const owned = thread.conversation.find(
    (item) =>
      item.kind === 'hil' &&
      item.requestId === data.correlation_id &&
      (!turnId || item.turnId === turnId) &&
      (!itemId || item.itemId === itemId)
  )
  if (owned?.kind !== 'hil') return {}
  return {
    conversation: thread.conversation.map((item) =>
      item.kind === 'hil' && item.requestId === owned.requestId
        ? data.state === 'unknown'
          ? {
              ...item,
              hilState: 'unknown',
              ...hilSubmissionFailure('outcomeUnknown'),
              submissionRequestFailure: undefined,
            }
          : {
              ...item,
              hilState: 'stale',
              ...hilResolution({ kind: 'stale' }),
              submissionError: undefined,
              submissionErrorMessage: undefined,
              submissionRequestFailure: undefined,
            }
        : item
    ),
  }
}

export function reportTurnReconciled(
  thread: Thread,
  turnId: string,
  completedAt = Date.now()
): ThreadUpdate {
  return {
    ...(thread.running ? {} : { running: false, status: 'done' as const }),
    conversation: settleInterruptedActivities(thread.conversation, turnId, completedAt).filter(
      (item) =>
        !(
          item.kind === 'error' &&
          item.runtimeAction === 'confirm_turn_unknown' &&
          item.actionTurnId === turnId
        )
    ),
  }
}

const TURN_UNKNOWN_REASON_KEYS = {
  timeout: 'turnUnknown.reason.timeout',
  transportLost: 'turnUnknown.reason.transportLost',
  processExit: 'turnUnknown.reason.processExit',
  unconfirmed: 'turnUnknown.reason.unconfirmed',
} as const

export function formatTurnUnknown(
  item: Extract<ConvItem, { kind: 'error' }>,
  t: TFunction<'conversation'>
): { title: string; message: string; action: string } {
  if (!item.turnUnknown) return item
  return {
    title: t('turnUnknown.title'),
    message: item.turnUnknown.reason
      ? t(TURN_UNKNOWN_REASON_KEYS[item.turnUnknown.reason])
      : item.message,
    action: t('turnUnknown.action'),
  }
}

export function formatApplicationRequestFailure(
  message: ApplicationRequestFailure,
  t: (
    key: ApplicationRequestFailure['key'] | 'request.diagnostic',
    values: { status: number; detail: string; message: string }
  ) => string
): string {
  return message.key === 'request.httpFailure'
    ? t('request.httpFailure', { status: message.status ?? 0, detail: '', message: '' })
    : t(message.key, { status: 0, detail: '', message: '' })
}

export function formatRuntimeStatus(
  message: RuntimeStatusMessage,
  t: TFunction<'conversation'>
): string {
  const reason = message.reason
  const detail =
    message.key === 'runtime.recovered'
      ? undefined
      : reason && typeof reason !== 'string'
        ? formatApplicationRequestFailure(reason, t)
        : reason && Object.prototype.hasOwnProperty.call(INCIDENT_MESSAGE_KEYS, reason)
          ? t(INCIDENT_MESSAGE_KEYS[reason as keyof typeof INCIDENT_MESSAGE_KEYS])
          : undefined
  const text =
    message.key === 'runtime.retryingCount'
      ? t('runtime.retryingCount', message)
      : message.key === 'resume.retrying'
        ? t('resume.retrying', message)
        : message.key === 'runtime.recoveryFailed' &&
            typeof reason === 'string' &&
            Object.prototype.hasOwnProperty.call(SANDBOX_INCIDENT_MESSAGE_KEYS, reason)
          ? t('runtime.sandboxRecoveryFailed')
          : t(message.key)
  return text + (detail ? t('runtime.detail', { detail }) : '')
}

function runtimeIncidentText(data: RuntimeIncidentData): {
  text: RuntimeStatusMessage
  tone: Cognitive
} {
  const reason =
    data.provider_error_code === SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE
      ? SUBSCRIPTION_UNSUPPORTED_CAPABILITY_CODE
      : data.safe_error
  if (data.state === 'retrying') {
    if (data.kind === 'provider_retry' || data.strategy === 'vendor_retry') {
      return { text: { key: 'runtime.providerRetrying', reason }, tone: 'inference' }
    }
    return {
      text:
        data.max_attempts > 0
          ? {
              key: 'runtime.retryingCount',
              reason,
              attempt: data.attempt,
              maximum: data.max_attempts,
            }
          : { key: 'runtime.retrying', reason },
      tone: 'inference',
    }
  }
  if (data.state === 'recovered')
    return { text: { key: 'runtime.recovered', reason }, tone: 'experience' }
  if (data.state === 'failed') {
    const recoveryFailed = data.strategy === 'auto_restart' || data.strategy === 'auto_resume'
    return {
      text: { key: recoveryFailed ? 'runtime.recoveryFailed' : 'runtime.failed', reason },
      tone: 'tension',
    }
  }
  return { text: { key: 'runtime.detected', reason }, tone: 'inference' }
}

export function reportRuntimeIncident(
  thread: Thread,
  data: RuntimeIncidentData,
  turnId: string | undefined,
  itemId?: string,
  eventSeq?: number
): ThreadUpdate {
  const description = runtimeIncidentText(data)
  const notice: ConvItem = {
    kind: 'status',
    text: description.text,
    tone: description.tone,
    incidentId: data.incident_id,
    eventSeq,
    retainOnHistoryRefresh: true,
    turnId,
  }
  let baseConversation =
    data.state === 'recovered'
      ? thread.conversation.filter(
          (item) => item.kind !== 'error' || item.incidentId !== data.incident_id
        )
      : thread.conversation
  if (
    data.retryability === 'unknown_outcome' &&
    UNKNOWN_RESPONSE_RPC_METHODS.has(data.rpc_method ?? '')
  ) {
    const candidates = baseConversation.filter(
      (item) =>
        item.kind === 'hil' &&
        (item.hilState === 'pending' ||
          item.hilState === 'submitting' ||
          item.hilState === 'failed') &&
        (itemId ? item.itemId === itemId : Boolean(turnId) && item.turnId === turnId)
    )
    const owned = itemId ? candidates[0] : candidates.length === 1 ? candidates[0] : undefined
    if (owned?.kind === 'hil') {
      baseConversation = baseConversation.map((item) =>
        item.kind === 'hil' && item.requestId === owned.requestId
          ? {
              ...item,
              hilState: 'unknown',
              ...hilSubmissionFailure('outcomeUnknown'),
              submissionRequestFailure: undefined,
            }
          : item
      )
    }
  }
  const index = baseConversation.findIndex(
    (item) => item.kind === 'status' && item.incidentId === data.incident_id
  )
  if (index < 0) {
    return { conversation: appendRuntimeItem(baseConversation, notice) }
  }
  const conversation = [...baseConversation]
  conversation[index] = notice
  return { conversation }
}

/** Project one session's process health onto that session's readiness only. */
export function projectRuntimeIncidentReadiness(
  previous: RuntimeReadiness | null | undefined,
  data: RuntimeIncidentData
): RuntimeReadiness | null {
  if (data.scope !== 'process') return previous ?? null
  const recovered = data.state === 'recovered'
  return {
    ...previous,
    ready: recovered,
    process_state: recovered ? 'ready' : data.state === 'failed' ? 'unavailable' : 'recovering',
    process_generation: data.process_generation,
    recovery_attempt: data.attempt,
    max_recovery_attempts: data.max_attempts,
    code: recovered ? undefined : data.safe_error,
    message: recovered ? undefined : data.safe_error,
    action: data.state === 'failed' ? 'retry' : null,
  }
}

/**
 * Runtime admission has four outcomes, not two.
 *
 * A bare `!readiness.ready` cannot tell an unloaded probe from a two-second process
 * restart, so it rejected drafts the durable queue would have accepted (AOne bug
 * 86998131). `unknown` must also stay closed: readiness is absent before the first
 * health response, and treating absence as permission would submit into a runtime
 * nobody has verified yet.
 */
export type ReadinessAdmission = 'ready' | 'transient' | 'blocked' | 'unknown'

const TRANSIENT_PROCESS_STATES = new Set(['starting', 'recovering'])

export function classifyReadiness(
  readiness: RuntimeReadiness | null | undefined
): ReadinessAdmission {
  if (!readiness) return 'unknown'
  if (readiness.ready) return 'ready'
  return TRANSIENT_PROCESS_STATES.has(readiness.process_state ?? '') ? 'transient' : 'blocked'
}

/** The session's own readiness outranks the runtime-wide probe for session decisions. */
export function effectiveReadiness(
  thread: Thread | null | undefined,
  global: RuntimeReadiness | null | undefined
): RuntimeReadiness | null {
  return thread?.readiness ?? global ?? null
}

export function readinessAdmission(
  thread: Thread | null | undefined,
  global: RuntimeReadiness | null | undefined
): ReadinessAdmission {
  return classifyReadiness(effectiveReadiness(thread, global))
}

/** Startup/terminal failures block the workspace; bounded recovery remains inspectable. */
export function blocksRuntimePreflight(readiness: RuntimeReadiness | null | undefined): boolean {
  return classifyReadiness(readiness) === 'blocked'
}

/**
 * Apply a runtime incident to the thread that owns it, and to nothing else.
 *
 * Returning `threads` alone is the point: a process incident belongs to one session, so
 * there is no shape in which this reducer can reach the runtime-wide readiness that other
 * sessions read. `reportRuntimeIncident` only ever yields `conversation`, so merging here
 * matches `patchThread` without needing its session-status synchronisation.
 */
export function applyRuntimeIncident(
  state: { threads: Record<string, Thread> },
  threadId: string | null,
  event: { data: RuntimeIncidentData; turn_id?: string; item_id?: string; seq?: number }
): { threads: Record<string, Thread> } {
  if (!threadId) return state
  const thread = state.threads[threadId]
  if (!thread) return state
  const readiness =
    event.data.scope === 'process'
      ? { readiness: projectRuntimeIncidentReadiness(thread.readiness, event.data) ?? undefined }
      : {}
  return {
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        ...reportRuntimeIncident(thread, event.data, event.turn_id, event.item_id, event.seq),
        ...readiness,
      },
    },
  }
}

export function reportTransportState(thread: Thread, state: SseConnectionState): ThreadUpdate {
  if (state === 'live') {
    return {
      transportState: state,
      conversation: thread.conversation.filter(
        (item) => !(item.kind === 'status' && item.incidentId === SERVICE_TRANSPORT_INCIDENT_ID)
      ),
    }
  }
  if (state !== 'retrying') {
    return { transportState: state }
  }
  const notice: ConvItem = {
    kind: 'status',
    text: {
      key: 'runtime.transportRetrying',
    },
    tone: 'inference',
    incidentId: SERVICE_TRANSPORT_INCIDENT_ID,
  }
  const index = thread.conversation.findIndex(
    (item) => item.kind === 'status' && item.incidentId === SERVICE_TRANSPORT_INCIDENT_ID
  )
  if (index < 0) {
    return {
      transportState: state,
      conversation: appendRuntimeItem(thread.conversation, notice),
    }
  }
  const conversation = [...thread.conversation]
  conversation[index] = notice
  return { transportState: state, conversation }
}

export function permissionModeFeedback(result: ModeChangeResult): ForegroundMessage {
  if (result.applicationFailure) return requestFailureFeedback(result.applicationFailure)
  if (result.error === 'permission_mode_connection_failed')
    return feedback('shell', 'foreground.permissionConnection')
  if (result.error === 'session_permission_switch_requires_hil_resolution')
    return feedback('shell', 'foreground.permissionRequiresApprovalResolution')
  if (result.error === 'session_permission_policy_immutable')
    return feedback('shell', 'foreground.permissionImmutable')
  return feedback('shell', 'foreground.permissionFailed')
}

const PERMISSION_MODE_LABEL_KEYS = {
  ask: 'composer.askPermission',
  default: 'composer.askPermission',
  safe_auto: 'composer.autoPermission',
  bypassPermissions: 'composer.fullPermission',
} as const

export function permissionModeLabelFeedback(mode: string): ForegroundMessage {
  return Object.prototype.hasOwnProperty.call(PERMISSION_MODE_LABEL_KEYS, mode)
    ? feedback(
        'components',
        PERMISSION_MODE_LABEL_KEYS[mode as keyof typeof PERMISSION_MODE_LABEL_KEYS]
      )
    : mode
}

export function permissionModeSelectedFeedback(mode: string): ForegroundMessage {
  return feedback('components', 'composer.modeSelected', {
    mode: permissionModeLabelFeedback(mode),
  })
}
