import type { TFunction } from 'i18next'
import type { QueuedMessagePayload, TurnInputItem } from './api'
import type { ConvItem, QueuedMessage } from './model'

const INITIAL_QUEUE_SEQUENCE = 0
const OPTIMISTIC_QUEUE_STATE: QueuedMessage['state'] = 'submitting'
const SETTLED_QUEUE_STATE: QueuedMessage['state'] = 'queued'
const UNKNOWN_QUEUE_STATE: QueuedMessage['state'] = 'outcome_unknown'
export const RESOURCE_WAIT_QUEUE_STATE: QueuedMessage['state'] = 'waiting_resources'
export const QUEUE_STATE_MESSAGE_KEYS = {
  queued: 'composer.queued',
  waiting_resources: 'composer.waitingResources',
  submitting: 'composer.submitting',
  failed: 'composer.submitFailed',
  outcome_unknown: 'composer.unknownOutcome'
} as const satisfies Record<QueuedMessage['state'], string>
export const QUEUED_MESSAGE_SAFE_ERRORS = {
  SUBMISSION_NOT_APPLIED: 'queued_submission_not_applied',
  TURN_OUTCOME_UNCONFIRMED: 'turn_outcome_unconfirmed'
} as const
const QUEUE_ERROR_MESSAGE_KEYS = {
  [QUEUED_MESSAGE_SAFE_ERRORS.SUBMISSION_NOT_APPLIED]: 'composer.notSubmitted',
  [QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED]: 'composer.stillUnknown',
  runtime_resource_wait_timeout: 'composer.resourceWaitTimeout',
  runtime_resource_wait_interrupted: 'composer.resourceWaitInterrupted',
  runtime_resource_queue_full: 'composer.resourceQueueFull',
  runtime_resource_cancelled: 'composer.resourceCancelled',
  runtime_turn_failed: 'composer.runtimeTurnFailed'
} as const
const QUEUE_ERROR_FALLBACK_MESSAGE_KEYS = {
  queued: 'composer.queueFailed',
  waiting_resources: 'composer.queueFailed',
  submitting: 'composer.queueUnknown',
  failed: 'composer.queueFailed',
  outcome_unknown: 'composer.stillUnknown'
} as const satisfies Record<QueuedMessage['state'], string>

export function queuedMessageErrorText(
  error: string,
  state: QueuedMessage['state'],
  t: TFunction<'components'>
): string {
  const key = Object.prototype.hasOwnProperty.call(QUEUE_ERROR_MESSAGE_KEYS, error)
    ? QUEUE_ERROR_MESSAGE_KEYS[error as keyof typeof QUEUE_ERROR_MESSAGE_KEYS]
    : QUEUE_ERROR_FALLBACK_MESSAGE_KEYS[state]
  return t(key)
}

/** Mirrors the Service admission gate: one unconfirmed outcome blocks the whole queue. */
export function queueBlockedByUnconfirmed(messages: QueuedMessage[]): boolean {
  return messages.some((message) => message.state === UNKNOWN_QUEUE_STATE)
}

const CANCELLABLE_QUEUE_STATES = new Set<QueuedMessage['state']>([
  SETTLED_QUEUE_STATE, RESOURCE_WAIT_QUEUE_STATE, 'failed'
])

export function canCancelQueuedMessage(message: QueuedMessage): boolean {
  return CANCELLABLE_QUEUE_STATES.has(message.state)
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
  const hasTurnRecoveryCard = conversation.some((item) => (
    item.kind === 'error'
    && item.runtimeAction === 'confirm_turn_unknown'
    && item.actionTurnId === recoveryTurnId
  ))
  if (message.state === UNKNOWN_QUEUE_STATE && hasTurnRecoveryCard) return false
  const hasUserBubble = conversation.some((item) => (
    item.kind === 'user' && item.itemId === message.queuedMessageId
  ))
  if (!hasUserBubble) return true
  return message.state !== OPTIMISTIC_QUEUE_STATE && message.state !== SETTLED_QUEUE_STATE
}

/** An accepted user turn is active in the UI before native execution starts. */
export function hasQueuedMessageAwaitingRuntime(
  messages: QueuedMessage[]
): boolean {
  return messages.some(
    (message) =>
      message.state === OPTIMISTIC_QUEUE_STATE ||
      message.state === SETTLED_QUEUE_STATE
  )
}

function messageText(input: TurnInputItem[]): string {
  return input
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function nextQueueSequence(messages: QueuedMessage[]): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.enqueueSeq),
    INITIAL_QUEUE_SEQUENCE
  ) + 1
}

export function queuedMessageFromPayload(payload: QueuedMessagePayload): QueuedMessage {
  return {
    queuedMessageId: payload.queued_message_id,
    enqueueSeq: payload.enqueue_seq,
    operationSeq: payload.operation_seq,
    state: payload.state,
    deadline: payload.deadline,
    purpose: payload.purpose,
    text: messageText(payload.input),
    input: payload.input,
    assistantReferences: payload.assistant_references ?? [],
    safeErrorCode: payload.safe_error,
    serverPresent: true,
    assistantContextRevision: payload.assistant_context_revision,
    nativeTurnId: payload.native_turn_id
  }
}

export function optimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string,
  input: TurnInputItem[],
  assistantReferences: QueuedMessage['assistantReferences'],
  assistantContextRevision?: number
): QueuedMessage {
  return {
    queuedMessageId,
    enqueueSeq: nextQueueSequence(messages),
    state: OPTIMISTIC_QUEUE_STATE,
    text: messageText(input),
    input,
    assistantReferences,
    serverPresent: false,
    assistantContextRevision
  }
}

export function upsertQueuedMessage(
  messages: QueuedMessage[],
  queued: QueuedMessage
): QueuedMessage[] {
  return [
    ...messages.filter((message) => message.queuedMessageId !== queued.queuedMessageId),
    queued
  ].sort((left, right) => left.enqueueSeq - right.enqueueSeq)
}

export function settleOptimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string
): QueuedMessage[] {
  return messages.map((message) => (
    message.queuedMessageId === queuedMessageId
      && message.state === OPTIMISTIC_QUEUE_STATE
      && message.serverPresent === false
      ? { ...message, state: SETTLED_QUEUE_STATE, serverPresent: true }
      : message
  ))
}

export function markOptimisticQueueOutcomeUnknown(
  messages: QueuedMessage[],
  queuedMessageId: string
): QueuedMessage[] {
  return messages.map((message) => (
    message.queuedMessageId === queuedMessageId
      && message.state === OPTIMISTIC_QUEUE_STATE
      && message.serverPresent === false
      ? { ...message, state: UNKNOWN_QUEUE_STATE }
      : message
  ))
}

/** A definite server rejection proves that this local placeholder was never queued. */
export function rejectOptimisticQueuedMessage(
  messages: QueuedMessage[],
  queuedMessageId: string
): QueuedMessage[] {
  return messages.filter((message) => !(
    message.queuedMessageId === queuedMessageId
      && message.state === OPTIMISTIC_QUEUE_STATE
      && message.serverPresent === false
  ))
}
