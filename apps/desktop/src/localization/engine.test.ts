import assert from 'node:assert/strict'
import test from 'node:test'

import zh from './locales/zh/foundation.json' with { type: 'json' }
import en from './locales/en/foundation.json' with { type: 'json' }
import {
  applyLocalizationLanguage,
  createLocalization,
  type LocalizationDiagnostic
} from './engine.ts'

test('applying localization is silent until the language actually changes', async () => {
  const diagnostics: LocalizationDiagnostic[] = []
  const instance = createLocalization(
    'zh',
    { zh: { foundation: zh }, en: { foundation: en } },
    { report: (event) => diagnostics.push(event) }
  )
  diagnostics.length = 0

  await applyLocalizationLanguage(instance, 'zh')
  assert.deepEqual(diagnostics, [])

  await applyLocalizationLanguage(instance, 'en')
  assert.deepEqual(diagnostics, [{ kind: 'changed', language: 'en' }])
})
