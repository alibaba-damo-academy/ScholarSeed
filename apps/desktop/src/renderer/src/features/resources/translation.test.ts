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
  assert.match(selection, /session\.capabilities\.can_edit\s*&&\s*\(?\s*<Button/)
  assert.doesNotMatch(selection, /POLISH_SUFFIX/)
  assert.match(suggestion, /target_language: target/)
  assert.match(suggestion, /\{selectedText\}/)
  assert.match(suggestion, /stream.current === abort/)
})
