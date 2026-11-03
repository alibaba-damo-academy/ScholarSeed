import type { AnswerAnnotation } from '../../contracts/assistant'
import type { ConvItem } from '../../model'

const HASH_PREFIX = 'sha256:'

export const ANSWER_ANNOTATION_LOCATION = {
  AVAILABLE: 'available',
  POSITION_LOST: 'position_lost',
  UNAVAILABLE: 'unavailable',
} as const

export type AnswerAnnotationLocation =
  (typeof ANSWER_ANNOTATION_LOCATION)[keyof typeof ANSWER_ANNOTATION_LOCATION]

export interface AnswerAnnotationTarget {
  item: Extract<ConvItem, { kind: 'agent' | 'thinking' }> | null
  status: AnswerAnnotationLocation
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text))
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return `${HASH_PREFIX}${hex(digest)}`
}

function sourceAnswer(
  annotation: AnswerAnnotation,
  conversation: ConvItem[]
): Extract<ConvItem, { kind: 'agent' | 'thinking' }> | null {
  const byProductSequence = conversation.find(
    (item) =>
      (item.kind === 'agent' || item.kind === 'thinking') &&
      item.eventSeq === annotation.source_product_seq
  )
  if (byProductSequence?.kind === 'agent' || byProductSequence?.kind === 'thinking')
    return byProductSequence
  if (!annotation.source_item_id) return null
  const byRuntimeIdentity = conversation.find(
    (item) =>
      (item.kind === 'agent' || item.kind === 'thinking') &&
      item.itemId === annotation.source_item_id &&
      item.turnId === annotation.source_turn_id
  )
  return byRuntimeIdentity?.kind === 'agent' || byRuntimeIdentity?.kind === 'thinking'
    ? byRuntimeIdentity
    : null
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
  const rangeValid =
    annotation.start_utf16 >= 0 &&
    annotation.end_utf16 > annotation.start_utf16 &&
    annotation.end_utf16 <= item.text.length
  if (!rangeValid) {
    return { item, status: ANSWER_ANNOTATION_LOCATION.POSITION_LOST }
  }
  const selectedTextHash = await sha256Text(
    item.text.slice(annotation.start_utf16, annotation.end_utf16)
  )
  if (selectedTextHash !== annotation.selected_text_hash) {
    return { item, status: ANSWER_ANNOTATION_LOCATION.POSITION_LOST }
  }
  return { item, status: ANSWER_ANNOTATION_LOCATION.AVAILABLE }
}
