import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfAiResult } from './analysis.ts'
import { mergeTranslationResult, nextTranslationPage, translationOrder } from './sequence.ts'

const result = (page: number, translated: string, target = 'zh'): PdfAiResult => ({
  kind: 'document_translation',
  revision: 'revision',
  literature_id: 'paper',
  selected_text: '',
  page,
  model_key: 'model',
  source_language: 'en',
  target_language: target,
  text: '',
  pages: [{
    page,
    blocks: [{ source_text: `source-${page}`, translated_text: translated, located: true }]
  }]
})

test('translation order starts from the visible page, then wraps to earlier pages', () => {
  assert.deepEqual(translationOrder(3, 5), [3, 4, 5, 1, 2])
  assert.deepEqual(translationOrder(1, 3), [1, 2, 3])
  assert.deepEqual(translationOrder(9, 3), [3, 1, 2])
  assert.deepEqual(translationOrder(1, 0), [])
})

test('next translation page skips every completed page without changing the frozen order', () => {
  assert.equal(nextTranslationPage(3, 5, [3, 4, 1]), 5)
  assert.equal(nextTranslationPage(3, 5, [3, 4, 5, 1]), 2)
  assert.equal(nextTranslationPage(3, 5, [1, 2, 3, 4, 5]), undefined)
})

test('translation results merge by page and retranslation replaces only that page', () => {
  const first = mergeTranslationResult(undefined, result(2, 'second'))
  const second = mergeTranslationResult(first, result(1, 'first'))
  const replaced = mergeTranslationResult(second, result(2, 'second-new'))
  assert.deepEqual(replaced.pages?.map(page => page.page), [1, 2])
  assert.equal(replaced.pages?.[1].blocks[0].translated_text, 'second-new')
})

test('translation results reset when the resolved target language changes', () => {
  const chinese = mergeTranslationResult(undefined, result(1, 'first'))
  const english = mergeTranslationResult(chinese, result(2, 'second', 'en'))
  assert.equal(english.target_language, 'en')
  assert.deepEqual(english.pages?.map(page => page.page), [2])
})
