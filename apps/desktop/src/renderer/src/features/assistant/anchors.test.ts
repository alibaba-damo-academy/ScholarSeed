import assert from 'node:assert/strict'
import test from 'node:test'

import type { AnswerAnnotation } from '../../contracts/assistant.ts'
import type { ConvItem } from '../../model.ts'
import {
  ANSWER_ANNOTATION_LOCATION,
  locateAnswerAnnotation,
  sha256Text
} from './anchors.ts'

const ANSWER_TEXT = '甲😀乙，保留这一段。'

async function annotation(overrides: Partial<AnswerAnnotation> = {}): Promise<AnswerAnnotation> {
  return {
    annotation_id: 'annotation-1',
    client_annotation_id: 'client-annotation-1',
    session_id: 'session-1',
    answer_id: 'answer:12',
    source_product_seq: 12,
    source_turn_id: 'turn-1',
    source_item_id: 'item-old',
    answer_revision: await sha256Text(ANSWER_TEXT),
    start_utf16: 1,
    end_utf16: 3,
    selected_text_hash: await sha256Text('😀'),
    preview_text: '😀',
    comment: '保留表情',
    revision: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides
  }
}

function conversation(text = ANSWER_TEXT): ConvItem[] {
  return [{
    kind: 'agent',
    text,
    eventSeq: 12,
    turnId: 'turn-restored',
    itemId: 'item-restored'
  }]
}

test('locates an immutable answer annotation by product sequence and UTF-16 hashes', async () => {
  const result = await locateAnswerAnnotation(await annotation(), conversation())
  assert.equal(result.status, ANSWER_ANNOTATION_LOCATION.AVAILABLE)
  assert.equal(result.item?.itemId, 'item-restored')
})

test('reports a lost position instead of fuzzy matching changed answer text', async () => {
  const result = await locateAnswerAnnotation(
    await annotation(),
    conversation(`前缀${ANSWER_TEXT}`)
  )
  assert.equal(result.status, ANSWER_ANNOTATION_LOCATION.POSITION_LOST)
})

test('reports an unavailable answer when the product event is not accessible', async () => {
  const result = await locateAnswerAnnotation(await annotation(), [{
    kind: 'agent',
    text: ANSWER_TEXT,
    eventSeq: 99
  }])
  assert.equal(result.status, ANSWER_ANNOTATION_LOCATION.UNAVAILABLE)
})

test('falls back to the exact runtime identity before a product sequence is projected', async () => {
  const item: ConvItem = {
    kind: 'agent',
    text: ANSWER_TEXT,
    turnId: 'turn-1',
    itemId: 'item-old'
  }
  const result = await locateAnswerAnnotation(await annotation(), [item])
  assert.equal(result.status, ANSWER_ANNOTATION_LOCATION.AVAILABLE)
})
