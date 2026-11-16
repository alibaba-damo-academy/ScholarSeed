import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfAiResult } from './analysis.ts'
import {
  mergeTranslationResult,
  nextTranslationPage,
  translationOrder,
  translationResultForTarget,
} from './sequence.ts'

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
  pages: [
    {
      page,
      blocks: [{ source_text: `source-${page}`, translated_text: translated, located: true }],
    },
  ],
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

test('cached English pages do not complete a Chinese translation run', () => {
  const cached = result(1, 'English source', 'en')
  const reusable = translationResultForTarget(cached, 'zh-CN')
  const completed = reusable?.pages?.map((page) => page.page) ?? []
  assert.equal(reusable, undefined)
  assert.equal(nextTranslationPage(1, 1, completed), 1)
  assert.equal(cached.target_language, 'en')
})

test('matching cached pages remain reusable for both explicit targets', () => {
  for (const target of ['zh-CN', 'en']) {
    const cached = result(1, 'Translated text', target)
    const reusable = translationResultForTarget(cached, target)
    assert.equal(reusable, cached)
    assert.equal(
      nextTranslationPage(1, 1, reusable?.pages?.map((page) => page.page) ?? []),
      undefined
    )
  }
})

test('missing or unidentified target caches are not current translation results', () => {
  assert.equal(translationResultForTarget(undefined, 'zh-CN'), undefined)
  assert.equal(
    translationResultForTarget({ ...result(1, 'Old text'), target_language: undefined }, 'zh-CN'),
    undefined
  )
})

test('translation results merge by page and retranslation replaces only that page', () => {
  const first = mergeTranslationResult(undefined, result(2, 'second'))
  const second = mergeTranslationResult(first, result(1, 'first'))
  const replaced = mergeTranslationResult(second, result(2, 'second-new'))
  assert.deepEqual(
    replaced.pages?.map((page) => page.page),
    [1, 2]
  )
  assert.equal(replaced.pages?.[1].blocks[0].translated_text, 'second-new')
})

test('translation results reset when the resolved target language changes', () => {
  const chinese = mergeTranslationResult(undefined, result(1, 'first'))
  const english = mergeTranslationResult(chinese, result(2, 'second', 'en'))
  assert.equal(english.target_language, 'en')
  assert.deepEqual(
    english.pages?.map((page) => page.page),
    [2]
  )
})

test('translation pages never merge across source, model or structure versions', () => {
  const current = result(1, 'old')
  for (const change of [{ revision: 'new' }, { model_key: 'new' }, { structure_version: 'v1' }]) {
    const incoming = { ...result(2, 'new'), ...change }
    assert.deepEqual(
      mergeTranslationResult(current, incoming).pages?.map((page) => page.page),
      [2]
    )
  }
})
