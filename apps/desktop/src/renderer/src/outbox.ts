import type { QueuedMessage } from './model'
import { QUEUED_MESSAGE_SAFE_ERRORS } from './queue.ts'

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
    const parsed = JSON.parse(window.localStorage.getItem(QUEUE_OUTBOX_STORAGE_KEY) ?? '') as StoredOutbox
    if (parsed.version !== OUTBOX_VERSION || !parsed.sessions || typeof parsed.sessions !== 'object') {
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
    message
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

export function mergeQueuedOutbox(
  sessionId: string,
  authoritative: QueuedMessage[]
): QueuedMessage[] {
  const pending = readOutbox().sessions[sessionId] ?? []
  return pending.reduce((messages, message) => {
    if (messages.some((item) => item.queuedMessageId === message.queuedMessageId)) {
      releaseQueuedOutbox(sessionId, message.queuedMessageId)
      return messages
    }
    return upsert(messages, {
      ...message,
      state: message.state === 'failed' ? 'failed' : 'outcome_unknown',
      safeErrorCode:
        message.safeErrorCode || QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED,
      serverPresent: false
    })
  }, authoritative)
}
