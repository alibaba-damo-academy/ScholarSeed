import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ASSISTANT_TRANSLATION_TARGETS,
  type AssistantTranslationTarget
} from '../../contracts/assistant.ts'

const EXPECTED_TARGETS: AssistantTranslationTarget[] = [
  'zh-CN',
  'en'
]

test('AI translation exposes only the supported target languages', () => {
  assert.deepEqual(ASSISTANT_TRANSLATION_TARGETS, EXPECTED_TARGETS)
  assert.equal(new Set(ASSISTANT_TRANSLATION_TARGETS).size, ASSISTANT_TRANSLATION_TARGETS.length)
})

test('AI translation card only exposes one atomic target-language select', () => {
  const source = readFileSync(new URL('./Translation.tsx', import.meta.url), 'utf8')
  const picker = readFileSync(new URL('../../components/business/Language.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /sourceLanguage|setSource|translation\.sourceLanguage/)
  assert.match(source, /TranslationTargetPicker/)
  assert.match(picker, /SelectTrigger/)
  assert.match(picker, /SelectContent/)
  assert.match(picker, /SelectItem/)
  assert.doesNotMatch(picker, /CommandInput|PopoverContent/)
  assert.match(source, /translation\.targetLanguage/)
  assert.match(source, /setTranslationTarget/)
})
