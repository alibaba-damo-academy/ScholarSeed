import type { AnswerAnnotation } from '../../contracts/assistant'
import type { ConvItem } from '../../model'

const HASH_PREFIX = 'sha256:'

export const ANSWER_ANNOTATION_LOCATION = {
  AVAILABLE: 'available',
  POSITION_LOST: 'position_lost',
  UNAVAILABLE: 'unavailable'
} as const

export type AnswerAnnotationLocation =
  typeof ANSWER_ANNOTATION_LOCATION[keyof typeof ANSWER_ANNOTATION_LOCATION]

export interface AnswerAnnotationTarget {
  item: Extract<ConvItem, { kind: 'agent' }> | null
  status: AnswerAnnotationLocation
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return `${HASH_PREFIX}${hex(digest)}`
}

function sourceAnswer(
  annotation: AnswerAnnotation,
  conversation: ConvItem[]
): Extract<ConvItem, { kind: 'agent' }> | null {
  const byProductSequence = conversation.find((item) => (
    item.kind === 'agent' && item.eventSeq === annotation.source_product_seq
  ))
  if (byProductSequence?.kind === 'agent') return byProductSequence
  if (!annotation.source_item_id) return null
  const byRuntimeIdentity = conversation.find((item) => (
    item.kind === 'agent'
      && item.itemId === annotation.source_item_id
      && item.turnId === annotation.source_turn_id
  ))
  return byRuntimeIdentity?.kind === 'agent' ? byRuntimeIdentity : null
}

export async function locateAnswerAnnotation(
  annotation: AnswerAnnotation | null,
  conversation: ConvItem[]
): Promise<AnswerAnnotationTarget> {
  if (!annotation) {
    return { item: null, status: ANSWER_ANNOTATION_LOCATION.UNAVAILABLE }
  }
  const item = sourceAnswer(annotation, conversation)
  if (!item) {
    return { item: null, status: ANSWER_ANNOTATION_LOCATION.UNAVAILABLE }
  }
  const rangeValid = annotation.start_utf16 >= 0
    && annotation.end_utf16 > annotation.start_utf16
    && annotation.end_utf16 <= item.text.length
  if (!rangeValid) {
    return { item, status: ANSWER_ANNOTATION_LOCATION.POSITION_LOST }
  }
  const [answerRevision, selectedTextHash] = await Promise.all([
    sha256Text(item.text),
    sha256Text(item.text.slice(annotation.start_utf16, annotation.end_utf16))
  ])
  if (
    answerRevision !== annotation.answer_revision
    || selectedTextHash !== annotation.selected_text_hash
  ) {
    return { item, status: ANSWER_ANNOTATION_LOCATION.POSITION_LOST }
  }
  return { item, status: ANSWER_ANNOTATION_LOCATION.AVAILABLE }
}
