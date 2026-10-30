import type { Thread } from '../../model'
import type { ComposerSubmission } from '../../components/business/submission'

export const NEXT_STEPS_CARD = 'next-steps'
const LIMITS = {
  title: 500,
  label: 200,
  description: 2000,
  free_text_label: 200,
  submit_label: 100,
} as const
const MIN_OPTIONS = 2
const MAX_OPTIONS = 3

export interface NextStepOption {
  label: string
  description: string
}

export interface NextStepsContent {
  title: string
  options: NextStepOption[]
  free_text_label: string
  submit_label: string
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && Array.from(trimmed).length <= maximum ? trimmed : null
}

export function parseNextSteps(value: Record<string, unknown>): NextStepsContent | null {
  const allowed = new Set(['title', 'options', 'free_text_label', 'submit_label'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  const title = text(value.title, LIMITS.title)
  const freeText = text(value.free_text_label, LIMITS.free_text_label)
  const submit = text(value.submit_label, LIMITS.submit_label)
  if (
    !title ||
    !freeText ||
    !submit ||
    !Array.isArray(value.options) ||
    value.options.length < MIN_OPTIONS ||
    value.options.length > MAX_OPTIONS
  )
    return null
  const options: NextStepOption[] = []
  for (const option of value.options) {
    if (
      !option ||
      typeof option !== 'object' ||
      Array.isArray(option) ||
      Object.keys(option).some((key) => key !== 'label' && key !== 'description')
    )
      return null
    const label = text(option.label, LIMITS.label)
    const description = text(option.description, LIMITS.description)
    if (!label || !description || options.some((previous) => previous.label === label)) return null
    options.push({ label, description })
  }
  return { title, options, free_text_label: freeText, submit_label: submit }
}

/** The message contains only text the person actually chose on the card. */
export function nextStepMessage(option: NextStepOption): string {
  return `${option.label}\n${option.description}`
}

export function nextStepsAvailable(thread: Thread, cardId: string, turnId?: string): boolean {
  if (
    !thread.sessionId ||
    !turnId ||
    thread.turnOutcomes?.[turnId] !== 'completed' ||
    thread.running ||
    thread.status === 'running' ||
    thread.status === 'waiting' ||
    thread.interrupting ||
    thread.terminated ||
    thread.recoveryPending ||
    thread.recoveryBlocked ||
    (thread.queuedMessages?.length ?? 0) > 0
  )
    return false
  const index = thread.conversation.findIndex(
    (item) => item.kind === 'display_card' && item.card.cardId === cardId && item.turnId === turnId
  )
  return index >= 0 && !thread.conversation.slice(index + 1).some((item) => item.kind === 'user')
}

/** Freeze the card's session identity, but recheck live conversation state at click time. */
export function createNextStepSender(
  readThread: () => Thread,
  owner: { sessionId: string | null; cardId: string; turnId?: string },
  submission: ComposerSubmission
): (message: string) => Promise<boolean> {
  return (message) => {
    const thread = readThread()
    if (
      !owner.sessionId ||
      thread.sessionId !== owner.sessionId ||
      !nextStepsAvailable(thread, owner.cardId, owner.turnId)
    )
      return Promise.resolve(false)
    return submission.submit(owner.sessionId, owner.cardId, message)
  }
}
