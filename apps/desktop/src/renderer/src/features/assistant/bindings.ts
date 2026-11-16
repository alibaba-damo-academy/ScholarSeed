export const ANSWER_ID_PREFIX = 'answer:'
export const ITEM_ID_PREFIX = 'item:'

export function answerIdentifier(messageId?: string | null, eventSeq?: number): string | null {
  return messageId ?? (eventSeq !== undefined ? `${ANSWER_ID_PREFIX}${eventSeq}` : null)
}
