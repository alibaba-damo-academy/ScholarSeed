import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { translationTarget } from './language.ts'

test('translation initially chooses the opposite of the selected dominant language', () => {
  assert.equal(translationTarget('温度升高后效率降低。'), 'en')
  assert.equal(translationTarget('The efficiency falls as the temperature rises.'), 'zh')
  assert.equal(translationTarget('温度升高后效率降低。Efficiency decreased.'), 'en')
})

test('resource translation keeps current source and explicit direction on its independent API', () => {
  const suggestion = readFileSync(new URL('./Suggestion.tsx', import.meta.url), 'utf8')
  const selection = readFileSync(new URL('../workbench/Selection.tsx', import.meta.url), 'utf8')
  assert.match(selection, /w\('selection\.translate'\)/)
  assert.match(selection, /session\.capabilities\.can_edit && selection\.locator\.kind !== "pdf"/)
  assert.match(selection, /activeAction !== "translate"/)
  assert.doesNotMatch(selection, /POLISH_SUFFIX/)
  assert.match(suggestion, /target_language: target/)
  assert.match(suggestion, /\{selectedText\}/)
  assert.match(suggestion, /stream.current === abort/)
})

test('resource AI suggestions expose optional instructions and prompt settings guidance', () => {
  const suggestion = readFileSync(new URL('./Suggestion.tsx', import.meta.url), 'utf8')
  const selection = readFileSync(new URL('../workbench/Selection.tsx', import.meta.url), 'utf8')
  const guide = readFileSync(new URL('../../components/business/PromptSettingsGuide.tsx', import.meta.url), 'utf8')

  assert.match(suggestion, /label=\{t\('suggestion\.optionalInstruction'\)\}/)
  assert.match(suggestion, /placeholder=\{t\(PLACEHOLDERS\[action\]\)\}/)
  assert.match(suggestion, /disabled=\{!hasModel \|\| busy\}/)
  assert.match(suggestion, /const PROMPT_GUIDES = \{ explain: 'suggestion\.promptGuideExplain', polish: 'suggestion\.promptGuidePolish', translate: 'suggestion\.promptGuideTranslate' \}/)
  assert.match(suggestion, /<PromptSettingsGuide prefix=\{t\(PROMPT_GUIDES\[action\]\)\}/)
  assert.match(suggestion, /action === 'translate' \? <PromptSettingsGuide[^>]*PROMPT_GUIDES\.translate[\s\S]*<CopyButton/)
  assert.doesNotMatch(suggestion, /suggestion\.directionHint/)
  assert.doesNotMatch(suggestion, /action !== 'polish' \? <IconButton/)
  assert.doesNotMatch(selection, /<ResourceSuggestion[\s\S]*?toolbarRef=\{toolbarRef\}[\s\S]*?\/>/)
  assert.match(guide, /act\.openSettings\('prompts'\)/)
  assert.match(guide, /variant="link"/)
})
