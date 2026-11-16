import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import zh from './locales/zh/foundation.json' with { type: 'json' }
import en from './locales/en/foundation.json' with { type: 'json' }
import zhShell from './locales/zh/shell.json' with { type: 'json' }
import enShell from './locales/en/shell.json' with { type: 'json' }
import zhLayout from './locales/zh/layout.json' with { type: 'json' }
import enLayout from './locales/en/layout.json' with { type: 'json' }
import zhPdf from './locales/zh/pdf.json' with { type: 'json' }
import enPdf from './locales/en/pdf.json' with { type: 'json' }
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

test('project resource labels keep consistent terminology across language changes', async () => {
  const instance = createLocalization(
    'zh',
    { zh: { layout: zhLayout }, en: { layout: enLayout } },
    { report: () => {} }
  )
  const labels = [
    ['materials', '资料', 'Resources'],
    ['emptyFiles', '暂无资料', 'No resources'],
    ['addMaterial', '添加资料', 'Add resource'],
    ['newMaterial', '新建资料', 'New resource'],
    ['importMaterial', '导入资料', 'Import resource'],
  ] as const

  for (const language of ['zh', 'en', 'zh'] as const) {
    await applyLocalizationLanguage(instance, language)
    for (const [key, chinese, english] of labels) {
      assert.equal(instance.t(`layout:${key}`), language === 'zh' ? chinese : english)
    }
  }
})

test('PDF selection and annotation actions use AI explanation labels across languages', async () => {
  const instance = createLocalization(
    'zh',
    { zh: { pdf: zhPdf }, en: { pdf: enPdf } },
    { report: () => {} }
  )

  for (const language of ['zh', 'en', 'zh'] as const) {
    await applyLocalizationLanguage(instance, language)
    const label = language === 'zh' ? 'AI解释' : 'AI explanation'
    assert.equal(instance.t('pdf:selectionExplain'), label)
    assert.equal(instance.t('pdf:pdfAnnotation.explain'), label)
    assert.equal(
      instance.t('pdf:reading.explainSelection'),
      language === 'zh' ? '解释一下' : 'Explain this'
    )
  }
})

test('expanded PDF panels use concise shrink labels across languages', async () => {
  const instance = createLocalization(
    'zh',
    { zh: { pdf: zhPdf }, en: { pdf: enPdf } },
    { report: () => {} }
  )

  for (const language of ['zh', 'en', 'zh'] as const) {
    await applyLocalizationLanguage(instance, language)
    assert.equal(instance.t('pdf:reading.shrinkPanel'), language === 'zh' ? '缩小' : 'Shrink')
    assert.equal(instance.t('pdf:reading.enlarge'), language === 'zh' ? '放大' : 'Enlarge')
  }
})

test('English interface messages consistently use resource terminology', () => {
  const directory = new URL('./locales/en/', import.meta.url)
  const inconsistent: string[] = []
  const inspect = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (/\bmaterials?\b/i.test(value)) inconsistent.push(path)
    } else if (value && typeof value === 'object') {
      for (const [key, message] of Object.entries(value)) inspect(message, `${path}.${key}`)
    }
  }

  for (const filename of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    inspect(JSON.parse(readFileSync(new URL(filename, directory), 'utf8')), filename)
  }
  assert.deepEqual(inconsistent, [])
})
