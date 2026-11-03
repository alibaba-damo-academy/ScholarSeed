import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { ASSISTANT_TRANSLATION_TARGETS } from '../../contracts/assistant.ts'

test('resource translation exposes only the supported target languages', () => {
  assert.deepEqual(ASSISTANT_TRANSLATION_TARGETS, ['zh-CN', 'en'])
})

test('resource translation keeps current source and exposes shared target and model pickers', () => {
  const suggestion = readFileSync(new URL('./Suggestion.tsx', import.meta.url), 'utf8')
  const selection = readFileSync(new URL('../workbench/Selection.tsx', import.meta.url), 'utf8')
  assert.match(selection, /w\('selection\.translate'\)/)
  assert.match(
    selection,
    /session\.capabilities\.can_edit\s*&&\s*selection\.locator\.kind !== ['"]pdf['"]/
  )
  assert.match(selection, /activeAction !== ['"]translate['"]/)
  assert.doesNotMatch(selection, /POLISH_SUFFIX/)
  assert.match(suggestion, /target_language: targetLanguage/)
  assert.match(suggestion, /<TranslationTargetPicker/)
  assert.match(
    suggestion,
    /defaultTranslationTarget\(i18n\.resolvedLanguage \|\| i18n\.language, selectedText\)/
  )
  assert.match(suggestion, /<ModelMenu[\s\S]*?testIdPrefix="resource-translation-model"/)
  assert.match(suggestion, /writeTranslationTarget\('resource-selection'/)
  assert.match(suggestion, /writeTranslationModel\('resource-selection'/)
  assert.match(suggestion, /const selectedModel = selectableActionModelKey/)
  assert.match(suggestion, /model_key: modelOverride,\s*client_attempt_id/)
  assert.doesNotMatch(suggestion, /suggestion\.toEnglish|suggestion\.toChinese/)
  assert.match(suggestion, /\{selectedText\}/)
  assert.match(suggestion, /stream.current === abort/)
})

test('resource AI suggestions expose optional instructions and prompt settings guidance', () => {
  const suggestion = readFileSync(new URL('./Suggestion.tsx', import.meta.url), 'utf8')
  const selection = readFileSync(new URL('../workbench/Selection.tsx', import.meta.url), 'utf8')
  const guide = readFileSync(
    new URL('../../components/business/PromptSettingsGuide.tsx', import.meta.url),
    'utf8'
  )

  assert.match(suggestion, /label=\{t\('suggestion\.optionalInstruction'\)\}/)
  assert.match(suggestion, /placeholder=\{t\(PLACEHOLDERS\[action\]\)\}/)
  assert.match(suggestion, /disabled=\{!hasModel \|\| busy\}/)
  assert.match(
    suggestion,
    /const PROMPT_GUIDES = \{\s*explain: 'suggestion\.promptGuideExplain',\s*polish: 'suggestion\.promptGuidePolish',\s*translate: 'suggestion\.promptGuideTranslate',?\s*\}/
  )
  assert.match(suggestion, /<PromptSettingsGuide\s+prefix=\{t\(PROMPT_GUIDES\[action\]\)\}/)
  assert.match(
    suggestion,
    /action === 'translate' \? \(\s*<PromptSettingsGuide[^>]*PROMPT_GUIDES\.translate[\s\S]*<CopyButton/
  )
  assert.doesNotMatch(suggestion, /suggestion\.directionHint/)
  assert.doesNotMatch(suggestion, /action !== 'polish' \? <IconButton/)
  assert.doesNotMatch(selection, /<ResourceSuggestion[\s\S]*?toolbarRef=\{toolbarRef\}[\s\S]*?\/>/)
  assert.match(guide, /act\.openSettings\('prompts'\)/)
  assert.match(guide, /variant="link"/)
})
