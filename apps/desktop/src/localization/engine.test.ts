import assert from 'node:assert/strict'
import test from 'node:test'

import zh from './locales/zh/foundation.json' with { type: 'json' }
import en from './locales/en/foundation.json' with { type: 'json' }
import zhShell from './locales/zh/shell.json' with { type: 'json' }
import enShell from './locales/en/shell.json' with { type: 'json' }
import zhLayout from './locales/zh/layout.json' with { type: 'json' }
import enLayout from './locales/en/layout.json' with { type: 'json' }
import {
  applyLocalizationLanguage,
  createLocalization,
  type LocalizationDiagnostic,
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

test('literature tab and sidebar keep the same name across language changes', async () => {
  const instance = createLocalization(
    'zh',
    {
      zh: { shell: zhShell, layout: zhLayout },
      en: { shell: enShell, layout: enLayout },
    },
    { report: () => {} }
  )

  for (const language of ['zh', 'en', 'zh'] as const) {
    await applyLocalizationLanguage(instance, language)
    assert.equal(instance.t('shell:chrome.literatureOverview'), instance.t('layout:literature'))
    assert.equal(
      instance.t('shell:chrome.literatureOverview'),
      language === 'zh' ? '文献中心' : 'Literature Center'
    )
  }
})
