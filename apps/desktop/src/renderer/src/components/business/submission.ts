import type { ConvItem, Thread } from '../../model'
import { artifactIsOutput } from '../../model.ts'
import { visibleMarkdownText } from '../../../../markdown/source.ts'

export function isEmptyTurn(thread: Thread, turnId: string): boolean {
  if (thread.turnOutcomes?.[turnId] !== 'completed') return false
  const turnItems = thread.conversation.filter((candidate) => candidate.turnId === turnId)
  return (
    turnItems.length > 0 &&
    !turnItems.some((candidate) => {
      if (candidate.kind === 'agent')
        return Boolean(visibleMarkdownText(candidate.text).trim() || candidate.card)
      if (candidate.kind === 'artifact')
        return artifactIsOutput(candidate.artifact) && candidate.artifact.status !== 'failed'
      return (
        candidate.kind === 'display_card' ||
        candidate.kind === 'delivery' ||
        candidate.kind === 'review' ||
        (candidate.kind === 'hil' && !candidate.resolved) ||
        candidate.kind === 'error'
      )
    })
  )
}

export function isEmptyAnswer(thread: Thread, item: Extract<ConvItem, { kind: 'agent' }>): boolean {
  return Boolean(
    item.turnId &&
    isEmptyTurn(thread, item.turnId) &&
    thread.conversation
      .filter((candidate) => candidate.turnId === item.turnId && candidate.kind === 'agent')
      .at(-1) === item
  )
}

export function canRetryEmptyTurn(thread: Thread, turnId: string): boolean {
  const index = thread.conversation.findLastIndex((candidate) => candidate.turnId === turnId)
  return Boolean(
    thread.sessionId &&
    !thread.readOnly &&
    !thread.running &&
    thread.status !== 'running' &&
    thread.status !== 'waiting' &&
    !thread.interrupting &&
    !thread.terminated &&
    !thread.recoveryPending &&
    !thread.recoveryBlocked &&
    !thread.queuedMessages?.length &&
    isEmptyTurn(thread, turnId) &&
    index >= 0 &&
    !thread.conversation.slice(index + 1).some((candidate) => candidate.kind === 'user')
  )
}

export function canRetryEmptyAnswer(
  thread: Thread,
  item: Extract<ConvItem, { kind: 'agent' }>
): boolean {
  return Boolean(
    item.turnId && isEmptyAnswer(thread, item) && canRetryEmptyTurn(thread, item.turnId)
  )
}

interface ComposerSubmissionEntry {
  sessionId: string | null
  disabled: boolean
  submit: (message: string) => Promise<boolean>
}

/** One mounted product composer, scoped to its StoreProvider rather than a window global. */
export function createComposerSubmission() {
  let entry: ComposerSubmissionEntry | null = null
  let pending = false
  const consumed = new Map<string, Set<string>>()
  const dismissed = new Map<string, Set<string>>()
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach((listener) => listener())
  const wasConsumed = (sessionId: string, actionId: string): boolean =>
    consumed.get(sessionId)?.has(actionId) ?? false
  const getSnapshot = (): string | null =>
    entry && !entry.disabled && !pending ? entry.sessionId : null

  return {
    getSnapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(next: ComposerSubmissionEntry): () => void {
      entry = next
      notify()
      return () => {
        if (entry !== next) return
        entry = null
        notify()
      }
    },
    consumed: wasConsumed,
    dismissed: (sessionId: string, turnId: string): boolean =>
      dismissed.get(sessionId)?.has(turnId) ?? false,
    dismiss(sessionId: string, turnId: string): void {
      const turns = dismissed.get(sessionId) ?? new Set<string>()
      turns.add(turnId)
      dismissed.set(sessionId, turns)
      notify()
    },
    async submit(sessionId: string, actionId: string, message: string): Promise<boolean> {
      const current = entry
      if (
        !sessionId ||
        !actionId ||
        !message.trim() ||
        pending ||
        !current ||
        current.disabled ||
        current.sessionId !== sessionId ||
        wasConsumed(sessionId, actionId)
      ) {
        return false
      }
      pending = true
      notify()
      try {
        const accepted = await current.submit(message)
        if (accepted) {
          const actions = consumed.get(sessionId) ?? new Set<string>()
          actions.add(actionId)
          consumed.set(sessionId, actions)
        }
        return accepted
      } finally {
        pending = false
        notify()
      }
    },
  }
}

export type ComposerSubmission = ReturnType<typeof createComposerSubmission>
