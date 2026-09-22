import { requestFailureFeedback } from './api.ts'
import { feedback, type ForegroundMessage } from './contracts/feedback.ts'
import type { TFunction } from 'i18next'

import type {
  AspEnvelope,
  ModeChangeResult,
  OperationStateData,
  PendingHIL,
  RuntimeIncidentData,
  SessionResumeFailure,
  SseConnectionState,
  UncertainOperationSnapshot
} from './api'
import type { ApplicationRequestFailure, Cognitive, ConvItem, RuntimeStatusMessage, RuntimeReadiness, SessionStatus, Thread } from './model'
import { projectHilCard, hilResolution, hilSubmissionFailure } from './hil.ts'
import { insertTurnRuntimeItem } from './transcript.ts'

const SERVICE_TRANSPORT_INCIDENT_ID = 'service-transport'
const UNKNOWN_RESPONSE_RPC_METHODS = new Set(['server-response/hil', 'server-response/tool'])
const TURN_UNKNOWN_MESSAGES: Record<string, string> = {
  runtime_rpc_timeout: '请求可能已经送达运行时，但客户端没有在时限内收到确认。',
  runtime_transport_lost: '请求提交期间与 Agent 运行时的本地连接断开，执行结果尚未确认。',
  codex_process_exit: '请求提交期间 Agent 运行时已退出，执行结果尚未确认。'
}
const TURN_UNKNOWN_MESSAGE_KEYS = {
  runtime_rpc_timeout: 'timeout',
  runtime_transport_lost: 'transportLost',
  codex_process_exit: 'processExit'
} as const
export const SESSION_RESUME_REQUEST_EVENT = 'scholarseed:session-resume-request'
const INCIDENT_MESSAGE_KEYS = {
  codex_process_exit: 'runtime.reason.codex_process_exit',
  runtime_transport_lost: 'runtime.reason.runtime_transport_lost',
  runtime_rpc_timeout: 'runtime.reason.runtime_rpc_timeout',
  codex_process_unavailable: 'runtime.reason.codex_process_unavailable',
  thread_resume_failed: 'runtime.reason.thread_resume_failed',
  codex_turn_retrying: 'runtime.reason.codex_turn_retrying',
  codex_terminal_outcome_conflict: 'runtime.reason.codex_terminal_outcome_conflict',
  codex_thread_not_loaded: 'runtime.reason.codex_thread_not_loaded',
  codex_thread_closed: 'runtime.reason.codex_thread_closed',
  // 键是 codex 适配器 PROVIDER_CREDITS_MESSAGE 原文：事件条 reason 取 safe_error（文案而非
  // 码），产品级计费文案经此登记回本地化资源；适配器改文案须同步本条目。
  'The account credit balance is exhausted.': 'runtime.reason.credit_balance_exhausted',
} as const

const MODE_FAILURE_MESSAGES: Record<string, string> = {
  permission_mode_connection_failed: '无法连接书深服务，请检查连接后重试权限切换。',
  session_permission_switch_requires_hil_resolution: '请先处理当前审批，再切换权限模式。',
  session_permission_policy_immutable: '当前运行时未能更新权限，请重新连接会话后重试。'
}
const MODE_FAILURE_FALLBACK = '权限模式切换未成功，请检查运行时连接后重试。'

export function permissionModeFailure(result: ModeChangeResult): string {
  return MODE_FAILURE_MESSAGES[result.error ?? ''] || result.detail || MODE_FAILURE_FALLBACK
}


type ThreadUpdate = Partial<Thread>

export interface SessionResumeRequestDetail {
  sessionId: string
}

export function requestSessionResume(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<SessionResumeRequestDetail>(
    SESSION_RESUME_REQUEST_EVENT,
    { detail: { sessionId } }
  ))
}

export function shouldRetrySessionResume(
  failure: SessionResumeFailure,
  attempt: number,
  maxAttempts: number
): boolean {
  return !failure.terminal && attempt < maxAttempts
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
    ...(actionable
      ? { runtimeAction: 'retry_session_resume', actionSessionId: sessionId }
      : {})
  }
}

export function projectSessionState(
  data: Extract<AspEnvelope, { type: 'session_state' }>['data']
): Pick<Thread, 'runtimeId' | 'running' | 'status'> {
  let status: SessionStatus = 'dormant'
  if (data.state === 'starting' || data.state === 'running') status = 'running'
  else if (data.state === 'waiting') status = 'waiting'
  else if (data.state === 'failed') status = 'failed'
  else if (data.state === 'interrupted') status = 'abandon'
  else if (data.state === 'closed') status = 'done'
  return {
    runtimeId: data.runtime_id,
    running: status === 'running' || status === 'waiting',
    status
  }
}

interface TurnUnknownProjection {
  sessionId: string
  turnId: string
  itemId?: string
  incidentId?: string
  message?: string
}

/** Project an ambiguous terminal once; the only action is explicit user confirmation. */
export function reportTurnUnknown(thread: Thread, data: TurnUnknownProjection): ThreadUpdate {
  const message = TURN_UNKNOWN_MESSAGES[data.message ?? '']
    ?? data.message
    ?? '请求可能已经送达 Agent 运行时，但客户端没有收到确认。'
  const card: Extract<ConvItem, { kind: 'error' }> = {
    kind: 'error',
    title: '上次任务已中断',
    turnUnknown: { reason: data.message == null ? 'unconfirmed'
      : Object.prototype.hasOwnProperty.call(TURN_UNKNOWN_MESSAGE_KEYS, data.message)
        ? TURN_UNKNOWN_MESSAGE_KEYS[data.message as keyof typeof TURN_UNKNOWN_MESSAGE_KEYS] : undefined },
    message,
    action: '是否继续对话？',
    incidentId: data.incidentId,
    runtimeAction: 'confirm_turn_unknown',
    actionSessionId: data.sessionId,
    actionTurnId: data.turnId,
    actionState: 'idle',
    turnId: data.turnId,
    itemId: data.itemId
  }
  const existingIndex = thread.conversation.findIndex((item) => (
    item.kind === 'error'
    && item.runtimeAction === 'confirm_turn_unknown'
    && item.actionTurnId === data.turnId
  ))
  const settled = thread.conversation.map((item) => (
    item.kind === 'hil'
    && item.turnId === data.turnId
    && (item.hilState === 'pending' || item.hilState === 'submitting')
      ? { ...item, hilState: 'stale' as const, ...hilResolution({ kind: 'stale' }) }
      : item
  ))
  let conversation: ConvItem[]
  if (existingIndex < 0) {
    conversation = insertTurnRuntimeItem(settled, card)
  } else {
    conversation = [...settled]
    const existing = conversation[existingIndex]
    conversation[existingIndex] = existing?.kind === 'error'
      ? {
          ...card,
          ...(existing.actionState ? { actionState: existing.actionState } : {}),
          ...(existing.actionError ? { actionError: existing.actionError, actionErrorMessage: existing.actionErrorMessage } : {})
        }
      : card
  }
  return {
    running: false,
    interrupting: false,
    status: 'abandon',
    turnOutcomes: { ...thread.turnOutcomes, [data.turnId]: 'unknown' },
    conversation
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
  let projected: Thread = { ...thread }
  for (const pending of snapshot.pendingHil) {
    const { turn_id: turnId, item_id: itemId, ...hil } = pending
    if (!hil.request_id || projected.conversation.some((item) => (
      item.kind === 'hil' && item.requestId === hil.request_id
    ))) continue
    projected = {
      ...projected,
      running: true,
      status: 'waiting',
      turnOutcomes: turnId
        ? { ...projected.turnOutcomes, [turnId]: 'running' }
        : projected.turnOutcomes,
      conversation: insertTurnRuntimeItem(
        projected.conversation,
        projectHilCard(hil, snapshot.timestamp, turnId, itemId)
      )
    }
  }
  if (snapshot.running && snapshot.activeTurnId) {
    projected = {
      ...projected,
      turnOutcomes: { ...projected.turnOutcomes, [snapshot.activeTurnId]: 'running' }
    }
  }
  for (const operation of snapshot.uncertainOperations) {
    if (operation.kind === 'turn') continue
    const hil = operation.hil
    if (!hil) continue
    if (!projected.conversation.some((item) => (
      item.kind === 'hil' && item.requestId === operation.correlation_id
    ))) {
      projected = {
        ...projected,
        conversation: insertTurnRuntimeItem(
          projected.conversation,
          projectHilCard(hil, snapshot.timestamp, operation.turn_id, operation.item_id)
        )
      }
    }
    const state = operation.state === 'executing' ? 'unknown' : operation.state
    if (state !== 'unknown' && state !== 'stale') continue
    projected = {
      ...projected,
      ...reportOperationState(projected, {
        kind: operation.kind,
        correlation_id: operation.correlation_id,
        state,
        retryable: false,
        execution_count: operation.execution_count
      }, operation.turn_id, operation.item_id)
    }
  }
  if (snapshot.unknownOutcome) {
    for (const operation of snapshot.uncertainOperations) {
      if (
        operation.kind !== 'turn'
        || (operation.state !== 'executing' && operation.state !== 'unknown')
      ) continue
      projected = {
        ...projected,
        ...reportTurnUnknown(projected, {
          sessionId: snapshot.sessionId,
          turnId: operation.correlation_id,
          incidentId: operation.incident_id,
          message: operation.safe_error || undefined
        })
      }
    }
  }
  return {
    running: projected.running,
    interrupting: projected.interrupting,
    status: projected.status,
    turnOutcomes: projected.turnOutcomes,
    conversation: projected.conversation
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
  const owned = thread.conversation.find((item) => (
    item.kind === 'hil'
    && item.requestId === data.correlation_id
    && (!turnId || item.turnId === turnId)
    && (!itemId || item.itemId === itemId)
  ))
  if (owned?.kind !== 'hil') return {}
  return {
    conversation: thread.conversation.map((item) => (
      item.kind === 'hil' && item.requestId === owned.requestId
        ? data.state === 'unknown'
          ? { ...item, hilState: 'unknown', ...hilSubmissionFailure('outcomeUnknown'), submissionRequestFailure: undefined }
          : { ...item, hilState: 'stale', ...hilResolution({ kind: 'stale' }), submissionError: undefined, submissionErrorMessage: undefined, submissionRequestFailure: undefined }
        : item
    ))
  }
}

export function reportTurnReconciled(thread: Thread, turnId: string): ThreadUpdate {
  return {
    ...(thread.running ? {} : { running: false, status: 'done' as const }),
    conversation: thread.conversation.filter((item) => !(
      item.kind === 'error'
      && item.runtimeAction === 'confirm_turn_unknown'
      && item.actionTurnId === turnId
    ))
  }
}

const TURN_UNKNOWN_REASON_KEYS = {
  timeout: 'turnUnknown.reason.timeout', transportLost: 'turnUnknown.reason.transportLost',
  processExit: 'turnUnknown.reason.processExit', unconfirmed: 'turnUnknown.reason.unconfirmed'
} as const

export function formatTurnUnknown(
  item: Extract<ConvItem, { kind: 'error' }>, t: TFunction<'conversation'>
): { title: string; message: string; action: string } {
  if (!item.turnUnknown) return item
  return {
    title: t('turnUnknown.title'),
    message: item.turnUnknown.reason ? t(TURN_UNKNOWN_REASON_KEYS[item.turnUnknown.reason]) : item.message,
    action: t('turnUnknown.action')
  }
}

export function formatApplicationRequestFailure(
  message: ApplicationRequestFailure,
  t: (key: ApplicationRequestFailure['key'] | 'request.diagnostic', values: { status: number; detail: string; message: string }) => string
): string {
  const text = message.key === 'request.httpFailure'
    ? t('request.httpFailure', { status: message.status ?? 0, detail: message.statusText || t('request.failed', { status: 0, detail: '', message: '' }), message: '' })
    : t(message.key, { status: 0, detail: '', message: '' })
  return message.diagnostic ? t('request.diagnostic', { message: text, detail: message.diagnostic, status: 0 }) : text
}

export function formatRuntimeStatus(message: RuntimeStatusMessage, t: TFunction<'conversation'>): string {
  const reason = message.reason
  const detail = reason && typeof reason !== 'string' ? formatApplicationRequestFailure(reason, t) : reason && Object.prototype.hasOwnProperty.call(INCIDENT_MESSAGE_KEYS, reason)
    ? t(INCIDENT_MESSAGE_KEYS[reason as keyof typeof INCIDENT_MESSAGE_KEYS])
    : reason
  const text = message.key === 'runtime.retryingCount' ? t('runtime.retryingCount', message)
    : message.key === 'resume.retrying' ? t('resume.retrying', message) : t(message.key)
  return text + (detail ? t('runtime.detail', { detail }) : '')
}

function runtimeIncidentText(data: RuntimeIncidentData): { text: RuntimeStatusMessage; tone: Cognitive } {
  const reason = data.safe_error
  if (data.state === 'retrying') {
    if (data.kind === 'provider_retry' || data.strategy === 'vendor_retry') {
      return { text: { key: 'runtime.providerRetrying', reason }, tone: 'inference' }
    }
    return { text: data.max_attempts > 0
      ? { key: 'runtime.retryingCount', reason, attempt: data.attempt, maximum: data.max_attempts }
      : { key: 'runtime.retrying', reason }, tone: 'inference' }
  }
  if (data.state === 'recovered') return { text: { key: 'runtime.recovered', reason }, tone: 'experience' }
  if (data.state === 'failed') {
    const recoveryFailed = data.strategy === 'auto_restart' || data.strategy === 'auto_resume'
    return { text: { key: recoveryFailed ? 'runtime.recoveryFailed' : 'runtime.failed', reason }, tone: 'tension' }
  }
  return { text: { key: 'runtime.detected', reason }, tone: 'inference' }
}

export function reportRuntimeIncident(
  thread: Thread,
  data: RuntimeIncidentData,
  turnId: string | undefined,
  itemId?: string
): ThreadUpdate {
  const description = runtimeIncidentText(data)
  const notice: ConvItem = {
    kind: 'status',
    text: description.text,
    tone: description.tone,
    incidentId: data.incident_id,
    retainOnHistoryRefresh: true,
    turnId
  }
  let baseConversation = data.state === 'recovered'
    ? thread.conversation.filter(
        (item) => item.kind !== 'error' || item.incidentId !== data.incident_id
      )
    : thread.conversation
  if (data.retryability === 'unknown_outcome' && UNKNOWN_RESPONSE_RPC_METHODS.has(data.rpc_method ?? '')) {
    const candidates = baseConversation.filter((item) => (
      item.kind === 'hil'
      && (item.hilState === 'pending' || item.hilState === 'submitting' || item.hilState === 'failed')
      && (itemId ? item.itemId === itemId : Boolean(turnId) && item.turnId === turnId)
    ))
    const owned = itemId
      ? candidates[0]
      : candidates.length === 1 ? candidates[0] : undefined
    if (owned?.kind === 'hil') {
      baseConversation = baseConversation.map((item) => (
        item.kind === 'hil' && item.requestId === owned.requestId
          ? { ...item, hilState: 'unknown', ...hilSubmissionFailure('outcomeUnknown'), submissionRequestFailure: undefined }
          : item
      ))
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
    process_state: recovered
      ? 'ready'
      : data.state === 'failed' ? 'unavailable' : 'recovering',
    process_generation: data.process_generation,
    recovery_attempt: data.attempt,
    max_recovery_attempts: data.max_attempts,
    code: recovered ? undefined : data.safe_error,
    message: recovered ? undefined : data.safe_error,
    action: data.state === 'failed' ? 'retry' : null
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
  event: { data: RuntimeIncidentData; turn_id?: string; item_id?: string }
): { threads: Record<string, Thread> } {
  if (!threadId) return state
  const thread = state.threads[threadId]
  if (!thread) return state
  const readiness = event.data.scope === 'process'
    ? { readiness: projectRuntimeIncidentReadiness(thread.readiness, event.data) ?? undefined }
    : {}
  return {
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        ...reportRuntimeIncident(thread, event.data, event.turn_id, event.item_id),
        ...readiness
      }
    }
  }
}

export function reportTransportState(thread: Thread, state: SseConnectionState): ThreadUpdate {
  const wasRetrying = thread.transportState === 'retrying'
  if (state !== 'retrying' && !(state === 'live' && wasRetrying)) {
    return { transportState: state }
  }
  const notice: ConvItem = {
    kind: 'status',
    text: { key: state === 'retrying' ? 'runtime.transportRetrying' : 'runtime.transportRecovered' },
    tone: state === 'retrying' ? 'inference' : 'experience',
    incidentId: SERVICE_TRANSPORT_INCIDENT_ID
  }
  const index = thread.conversation.findIndex(
    (item) => item.kind === 'status' && item.incidentId === SERVICE_TRANSPORT_INCIDENT_ID
  )
  if (index < 0) {
    return {
      transportState: state,
      conversation: appendRuntimeItem(thread.conversation, notice)
    }
  }
  const conversation = [...thread.conversation]
  conversation[index] = notice
  return { transportState: state, conversation }
}

export function permissionModeFeedback(result: ModeChangeResult): ForegroundMessage {
  if (result.applicationFailure) return requestFailureFeedback(result.applicationFailure)
  if (result.error === 'permission_mode_connection_failed') return feedback('shell', 'foreground.permissionConnection')
  if (result.error === 'session_permission_switch_requires_hil_resolution') return feedback('shell', 'foreground.permissionRequiresApprovalResolution')
  if (result.error === 'session_permission_policy_immutable') return feedback('shell', 'foreground.permissionImmutable')
  return result.detail || feedback('shell', 'foreground.permissionFailed')
}


const PERMISSION_MODE_LABEL_KEYS = {
  ask: 'composer.askPermission', default: 'composer.askPermission',
  safe_auto: 'composer.autoPermission', bypassPermissions: 'composer.fullPermission'
} as const

export function permissionModeLabelFeedback(mode: string): ForegroundMessage {
  return Object.prototype.hasOwnProperty.call(PERMISSION_MODE_LABEL_KEYS, mode)
    ? feedback('components', PERMISSION_MODE_LABEL_KEYS[mode as keyof typeof PERMISSION_MODE_LABEL_KEYS]) : mode
}

export function permissionModeSelectedFeedback(mode: string): ForegroundMessage {
  return feedback('components', 'composer.modeSelected', { mode: permissionModeLabelFeedback(mode) })
}
