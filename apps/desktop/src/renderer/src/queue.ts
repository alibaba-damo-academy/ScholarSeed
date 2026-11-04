import type { TFunction } from 'i18next'
import type {
  ConfirmUnknownTurnResponse,
  QueuedMessageDeleteResponse,
  QueuedMessagePayload,
  SubmissionMode,
  TurnInputItem,
} from './api'
import { feedback, turnAdmissionMessageKey, type FeedbackDescriptor } from './contracts/feedback.ts'
import type { ConvItem, QueuedMessage } from './model'

const INITIAL_QUEUE_SEQUENCE = 0
const OPTIMISTIC_QUEUE_STATE: QueuedMessage['state'] = 'submitting'
const SETTLED_QUEUE_STATE: QueuedMessage['state'] = 'queued'
const UNKNOWN_QUEUE_STATE: QueuedMessage['state'] = 'outcome_unknown'
const TURN_CONFIRMATION_STALE = 'runtime_turn_confirmation_stale'

export async function confirmQueuedOutcome(actions: {
  confirm: () => Promise<Pick<ConfirmUnknownTurnResponse, 'ok' | 'code' | 'error'>>
  refreshQueue: () => Promise<boolean>
  refreshContext: () => Promise<unknown>
}): Promise<FeedbackDescriptor | null> {
  const result = await actions.confirm()
  const refreshed = await actions.refreshQueue()
  await actions.refreshContext()
  if (!refreshed) return feedback('components', 'composer.checkFailed')
  if (result.ok) return null
  return feedback(
    'components',
    (result.code || result.error) === TURN_CONFIRMATION_STALE
      ? 'composer.confirmStateChanged'
      : 'composer.confirmContinueFailed'
  )
}

export const QUEUE_PRESENTATION_MESSAGE_KEYS = {
  queued: 'composer.queued',
  waiting_resources: 'composer.queued',
  submitting: 'composer.queued',
  failed: 'composer.answerFailed',
  outcome_unknown: 'composer.unknownOutcome',
} as const satisfies Record<QueuedMessage['state'], string>
export const QUEUED_MESSAGE_SAFE_ERRORS = {
  SUBMISSION_NOT_APPLIED: 'queued_submission_not_applied',
  TURN_OUTCOME_UNCONFIRMED: 'turn_outcome_unconfirmed',
} as const
const QUEUE_ERROR_MESSAGE_KEYS = {
  [QUEUED_MESSAGE_SAFE_ERRORS.SUBMISSION_NOT_APPLIED]: 'composer.notSubmitted',
  runtime_resource_wait_timeout: 'composer.resourceWaitTimeout',
  runtime_host_configuration_conflict: 'composer.runtimeHostConfigurationConflict',
  runtime_resource_wait_blocked: 'composer.resourceWaitBlocked',
  runtime_resource_wait_pending_hil: 'composer.resourceWaitPendingHil',
  runtime_resource_wait_activity_unavailable: 'composer.resourceWaitActivityUnavailable',
  runtime_resource_wait_interrupted: 'composer.resourceWaitInterrupted',
  runtime_resource_queue_full: 'composer.resourceQueueFull',
  runtime_resource_cancelled: 'composer.resourceCancelled',
  runtime_turn_failed: 'composer.runtimeTurnFailed',
  windows_sandbox_setup_failed: 'composer.sandboxSetupFailed',
  windows_sandbox_setup_in_progress: 'composer.sandboxPreparing',
  windows_sandbox_setup_unknown: 'composer.sandboxUnknown',
  windows_sandbox_tool_access_failed: 'composer.sandboxToolAccessFailed',
  session_model_switch_failed: 'composer.runtimeStartFailed',
} as const
const QUEUE_ERROR_FALLBACK_MESSAGE_KEYS = {
  queued: 'composer.queueFailed',
  waiting_resources: 'composer.queueFailed',
  submitting: 'composer.queueUnknown',
  failed: 'composer.queueFailed',
  outcome_unknown: 'composer.runtimeTurnFailed',
} as const satisfies Record<QueuedMessage['state'], string>
const QUEUE_SANDBOX_ERROR_MESSAGE_KEYS = {
  windows_sandbox_tool_probe_failed: 'sandbox.toolProbeFailed',
  windows_sandbox_policy_rejected: 'sandbox.policyRejected',
  windows_sandbox_setup_cancelled: 'sandbox.setupCancelled',
} as const
const QUEUE_ADMISSION_ERROR_MESSAGE_KEYS = {
  resource_baseline_permission_denied: 'queue.permissionDenied',
  resource_baseline_failed: 'queue.baselineFailed',
} as const

export function queuedMessageErrorText(
  error: unknown,
  state: QueuedMessage['state'],
  t: TFunction<'components'>,
  details?: Record<string, string>
): string {
  const code = typeof error === 'string' ? error : ''
  // An ambiguous native submission must never be presented as safe to resend.
  if (state === 'outcome_unknown') return t('composer.runtimeTurnFailed')
  if (Object.prototype.hasOwnProperty.call(QUEUE_SANDBOX_ERROR_MESSAGE_KEYS, code)) {
    return t(
      QUEUE_SANDBOX_ERROR_MESSAGE_KEYS[code as keyof typeof QUEUE_SANDBOX_ERROR_MESSAGE_KEYS],
      {
        ns: 'conversation',
      }
    )
  }
  const admissionKey = turnAdmissionMessageKey(code)
  if (admissionKey) return t(admissionKey)
  if (Object.prototype.hasOwnProperty.call(QUEUE_ADMISSION_ERROR_MESSAGE_KEYS, code)) {
    const key =
      QUEUE_ADMISSION_ERROR_MESSAGE_KEYS[code as keyof typeof QUEUE_ADMISSION_ERROR_MESSAGE_KEYS]
    return t(key, {
      ns: 'conversation',
      path: details?.path || t('queue.projectFile', { ns: 'conversation' }),
    })
  }
  const key = Object.prototype.hasOwnProperty.call(QUEUE_ERROR_MESSAGE_KEYS, code)
    ? QUEUE_ERROR_MESSAGE_KEYS[code as keyof typeof QUEUE_ERROR_MESSAGE_KEYS]
    : QUEUE_ERROR_FALLBACK_MESSAGE_KEYS[state]
  return t(key)
}

/** Mirrors the Service admission gate: one unconfirmed outcome blocks the whole queue. */
export function queueBlockedByUnconfirmed(messages: QueuedMessage[]): boolean {
  return messages.some((message) => message.state === UNKNOWN_QUEUE_STATE)
}

const CANCELLABLE_QUEUE_STATES = new Set<QueuedMessage['state']>([
  SETTLED_QUEUE_STATE,
  'waiting_resources',
  'failed',
])

export function canCancelQueuedMessage(message: QueuedMessage): boolean {
  return CANCELLABLE_QUEUE_STATES.has(message.state)
}

const QUEUE_WITHDRAWAL_ERRORS = {
  queued_message_not_editable: 'composer.withdrawStateChanged',
  queued_message_not_found: 'composer.withdrawMissing',
  session_not_found: 'composer.withdrawUnavailable',
  session_not_live: 'composer.withdrawUnavailable',
} as const

const QUEUE_WITHDRAWAL_STATUSES = {
  401: 'composer.withdrawDenied',
  403: 'composer.withdrawDenied',
  404: 'composer.withdrawUnavailable',
  409: 'composer.withdrawStateChanged',
} as const

export function queuedWithdrawalFeedback(result: QueuedMessageDeleteResponse): FeedbackDescriptor {
  const error = result.error ?? ''
  if (Object.prototype.hasOwnProperty.call(QUEUE_WITHDRAWAL_ERRORS, error)) {
    return feedback(
      'components',
      QUEUE_WITHDRAWAL_ERRORS[error as keyof typeof QUEUE_WITHDRAWAL_ERRORS]
    )
  }
  if (Object.prototype.hasOwnProperty.call(QUEUE_WITHDRAWAL_STATUSES, result.status)) {
    return feedback(
      'components',
      QUEUE_WITHDRAWAL_STATUSES[result.status as keyof typeof QUEUE_WITHDRAWAL_STATUSES]
    )
  }
  return feedback('components', 'composer.withdrawFailed')
}

/** Idle sends read as conversation immediately; pending work keeps queue semantics. */
export function shouldOptimisticallyPresentUserMessage(
  running: boolean,
  messages: QueuedMessage[]
): boolean {
  return !running && messages.length === 0
}

/** Hide the transport placeholder once its user bubble is visible, but retain recovery UI. */
export function shouldPresentQueuedMessage(
  message: QueuedMessage,
  conversation: ConvItem[]
): boolean {
  const recoveryTurnId = message.nativeTurnId ?? message.queuedMessageId
  const hasTurnRecoveryCard = conversation.some(
    (item) =>
      item.kind === 'error' &&
      item.runtimeAction === 'confirm_turn_unknown' &&
      item.actionTurnId === recoveryTurnId
  )
  if (message.state === UNKNOWN_QUEUE_STATE && hasTurnRecoveryCard) return false
  if (message.state === 'failed' || message.state === UNKNOWN_QUEUE_STATE) return true
  return message.submissionMode === 'queued'
}

/** An accepted user turn is active in the UI before native execution starts. */
export function hasQueuedMessageAwaitingRuntime(messages: QueuedMessage[]): boolean {
  return messages.some(
    (message) =>
      message.submissionMode === 'direct' &&
      (message.state === OPTIMISTIC_QUEUE_STATE ||
        message.state === SETTLED_QUEUE_STATE ||
        message.state === 'waiting_resources')
  )
}

export function hasAcceptedMessageAwaitingRuntime(messages: QueuedMessage[]): boolean {
  return messages.some(
    (message) =>
      message.submissionMode === 'direct' &&
      message.serverPresent === true &&
      (message.state === SETTLED_QUEUE_STATE || message.state === 'waiting_resources')
  )
}

function messageText(input: TurnInputItem[]): string {
  return input
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function nextQueueSequence(messages: QueuedMessage[]): number {
  return (
    messages.reduce(
      (latest, message) => Math.max(latest, message.enqueueSeq),
      INITIAL_QUEUE_SEQUENCE
    ) + 1
  )
}

export function queuedMessageFromPayload(payload: QueuedMessagePayload): QueuedMessage {
  return {
    queuedMessageId: payload.queued_message_id,
    enqueueSeq: payload.enqueue_seq,
    operationSeq: payload.operation_seq,
    state: payload.state,
    submissionMode: payload.submission_mode,
    deadline: payload.deadline,
    purpose: payload.purpose,
    text: messageText(payload.input),
    input: payload.input,
    assistantReferences: payload.assistant_references ?? [],
    safeErrorCode: payload.safe_error,
    safeErrorDetails: payload.safe_error_details,
    serverPresent: true,
    assistantContextRevision: payload.assistant_context_revision,
    nativeTurnId: payload.native_turn_id,
  }
}

export function optimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string,
  input: TurnInputItem[],
  assistantReferences: QueuedMessage['assistantReferences'],
  assistantContextRevision?: number,
  submissionMode: SubmissionMode = 'queued',
  activeDocument?: QueuedMessage['activeDocument'],
  selectedLiteratureIds?: QueuedMessage['selectedLiteratureIds']
): QueuedMessage {
  return {
    queuedMessageId,
    enqueueSeq: nextQueueSequence(messages),
    state: OPTIMISTIC_QUEUE_STATE,
    submissionMode,
    text: messageText(input),
    input,
    assistantReferences,
    serverPresent: false,
    assistantContextRevision,
    activeDocument,
    selectedLiteratureIds: selectedLiteratureIds ? [...selectedLiteratureIds] : undefined,
  }
}

export function upsertQueuedMessage(
  messages: QueuedMessage[],
  queued: QueuedMessage
): QueuedMessage[] {
  return [
    ...messages.filter((message) => message.queuedMessageId !== queued.queuedMessageId),
    queued,
  ].sort((left, right) => left.enqueueSeq - right.enqueueSeq)
}

export function settleOptimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string,
  submissionMode?: SubmissionMode
): QueuedMessage[] {
  return messages.map((message) =>
    message.queuedMessageId === queuedMessageId &&
    message.state === OPTIMISTIC_QUEUE_STATE &&
    message.serverPresent === false
      ? {
          ...message,
          state: SETTLED_QUEUE_STATE,
          serverPresent: true,
          submissionMode: submissionMode ?? message.submissionMode,
        }
      : message
  )
}

export function markOptimisticQueueOutcomeUnknown(
  messages: QueuedMessage[],
  queuedMessageId: string
): QueuedMessage[] {
  return messages.map((message) =>
    message.queuedMessageId === queuedMessageId &&
    message.state === OPTIMISTIC_QUEUE_STATE &&
    message.serverPresent === false
      ? { ...message, state: UNKNOWN_QUEUE_STATE }
      : message
  )
}

/** A definite server rejection proves that this local placeholder was never queued. */
export function rejectOptimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string
): QueuedMessage[] {
  return messages.filter(
    (message) =>
      !(
        message.queuedMessageId === queuedMessageId &&
        message.state === OPTIMISTIC_QUEUE_STATE &&
        message.serverPresent === false
      )
  )
}
