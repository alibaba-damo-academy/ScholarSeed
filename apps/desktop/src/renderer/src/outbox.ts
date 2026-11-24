import type { QueuedMessage } from './model'
import {
  QUEUED_MESSAGE_SAFE_ERRORS,
  queuedSendReceiptUnknown,
  queuedSendStillUnconfirmed,
  unconfirmedQueuedSend,
} from './queue.ts'

const QUEUE_OUTBOX_STORAGE_KEY = 'scholarseed.queue-outbox.v1'
const OUTBOX_VERSION = 1

interface StoredOutbox {
  version: number
  sessions: Record<string, QueuedMessage[]>
}

function emptyOutbox(): StoredOutbox {
  return { version: OUTBOX_VERSION, sessions: {} }
}

function readOutbox(): StoredOutbox {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(QUEUE_OUTBOX_STORAGE_KEY) ?? ''
    ) as StoredOutbox
    if (
      parsed.version !== OUTBOX_VERSION ||
      !parsed.sessions ||
      typeof parsed.sessions !== 'object'
    ) {
      return emptyOutbox()
    }
    return parsed
  } catch {
    return emptyOutbox()
  }
}

function writeOutbox(outbox: StoredOutbox): void {
  try {
    window.localStorage.setItem(QUEUE_OUTBOX_STORAGE_KEY, JSON.stringify(outbox))
  } catch {
    // The visible in-memory row remains authoritative for this renderer lifetime.
  }
}

function upsert(messages: QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  return [
    ...messages.filter((item) => item.queuedMessageId !== message.queuedMessageId),
    message,
  ].sort((left, right) => left.enqueueSeq - right.enqueueSeq)
}

export function retainQueuedOutbox(sessionId: string, message: QueuedMessage): void {
  if (!sessionId) return
  const outbox = readOutbox()
  outbox.sessions[sessionId] = upsert(outbox.sessions[sessionId] ?? [], message)
  writeOutbox(outbox)
}

export function releaseQueuedOutbox(sessionId: string, queuedMessageId: string): void {
  const outbox = readOutbox()
  const remaining = (outbox.sessions[sessionId] ?? []).filter(
    (message) => message.queuedMessageId !== queuedMessageId
  )
  if (remaining.length > 0) outbox.sessions[sessionId] = remaining
  else delete outbox.sessions[sessionId]
  writeOutbox(outbox)
}

export function acknowledgeQueuedOutboxMessage(
  sessionId: string,
  authoritative: QueuedMessage,
  current: QueuedMessage | undefined,
  acknowledge: boolean
): QueuedMessage {
  const pending =
    (readOutbox().sessions[sessionId] ?? []).find(
      (message) => message.queuedMessageId === authoritative.queuedMessageId
    ) ?? current
  if (pending && queuedSendStillUnconfirmed(pending, authoritative))
    return unconfirmedQueuedSend(authoritative)
  if (acknowledge && pending) releaseQueuedOutbox(sessionId, authoritative.queuedMessageId)
  return authoritative
}

export function mergeQueuedOutbox(
  sessionId: string,
  authoritative: QueuedMessage[],
  acknowledge = true,
  current: QueuedMessage[] = []
): QueuedMessage[] {
  const pending = readOutbox().sessions[sessionId] ?? []
  const merged = pending.reduce((messages, message) => {
    const matching = messages.find((item) => item.queuedMessageId === message.queuedMessageId)
    if (matching) {
      if (queuedSendStillUnconfirmed(message, matching))
        return upsert(messages, unconfirmedQueuedSend(matching))
      // Candidate UI restoration may read this projection before native commit.
      // Retain the durable local row until the workbench can acknowledge it.
      if (acknowledge) releaseQueuedOutbox(sessionId, message.queuedMessageId)
      return messages
    }
    const owned = current.find((item) => item.queuedMessageId === message.queuedMessageId)
    if (owned?.state === 'submitting' && owned.serverPresent === false) {
      return upsert(messages, owned)
    }
    return upsert(messages, {
      ...message,
      state: message.state === 'failed' ? 'failed' : 'outcome_unknown',
      safeErrorCode: message.safeErrorCode || QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED,
      serverPresent: queuedSendReceiptUnknown(message) ? message.serverPresent : false,
    })
  }, authoritative)
  // Local storage can be unavailable while a submit is still in flight.
  return current.reduce((messages, item) => {
    const matching = messages.find((message) => message.queuedMessageId === item.queuedMessageId)
    if (matching && queuedSendStillUnconfirmed(item, matching))
      return upsert(messages, unconfirmedQueuedSend(matching))
    if (
      !matching &&
      ((item.state === 'submitting' && item.serverPresent === false) ||
        queuedSendReceiptUnknown(item))
    )
      return upsert(messages, item)
    return messages
  }, merged)
}
