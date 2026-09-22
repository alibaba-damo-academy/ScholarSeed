import type { AssistantSelectionActionInput } from '../../contracts/assistant'

export interface SelectionAttemptIdentity {
  clientActionId: string
  clientAttemptId: string
  retryOfAttemptId?: string
}

export function selectionActionKey(input: AssistantSelectionActionInput): string {
  return JSON.stringify([
    input.action,
    input.source_id,
    input.source_revision,
    input.selection.locator,
    input.selection.selected_text_hash,
    input.draft ?? null,
    input.question ?? '',
    input.target_language ?? ''
  ])
}

export function nextSelectionAttempt(
  current: SelectionAttemptIdentity | null,
  retry: boolean,
  createId: () => string
): SelectionAttemptIdentity {
  if (current && !retry) return current
  if (current) {
    return {
      clientActionId: current.clientActionId,
      clientAttemptId: createId(),
      retryOfAttemptId: current.clientAttemptId
    }
  }
  return {
    clientActionId: createId(),
    clientAttemptId: createId()
  }
}
