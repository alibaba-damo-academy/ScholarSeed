import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ASSISTANT_TRANSLATION_TARGETS,
  type AssistantTranslationTarget
} from '../../contracts/assistant.ts'

const EXPECTED_TARGETS: AssistantTranslationTarget[] = [
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'ru',
  'ar',
  'hi',
  'th',
  'vi',
  'id',
  'tr',
  'nl'
]

test('AI translation exposes the complete mainstream target catalog', () => {
  assert.deepEqual(ASSISTANT_TRANSLATION_TARGETS, EXPECTED_TARGETS)
  assert.equal(new Set(ASSISTANT_TRANSLATION_TARGETS).size, ASSISTANT_TRANSLATION_TARGETS.length)
})

test('AI translation card only exposes one searchable target-language control', () => {
  const source = readFileSync(new URL('./Translation.tsx', import.meta.url), 'utf8')
  const picker = readFileSync(new URL('../../components/business/Language.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /sourceLanguage|setSource|translation\.sourceLanguage/)
  assert.match(source, /TranslationTargetPicker/)
  assert.match(picker, /CommandInput/)
  assert.match(source, /translation\.targetLanguage/)
  assert.match(source, /setTranslationTarget/)
})
