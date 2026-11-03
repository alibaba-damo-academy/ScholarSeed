import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import {
  pdfAiCaughtFailure,
  pdfAiFailure,
  pdfAiFailureRecovery,
  pdfAiFailureText,
} from './failure.ts'

const resources = Object.fromEntries(
  ['zh', 'en'].map((language) => [
    language,
    {
      pdf: JSON.parse(
        readFileSync(
          new URL(`../../../../../localization/locales/${language}/pdf.json`, import.meta.url),
          'utf8'
        )
      ),
    },
  ])
)

async function translator(language = 'zh') {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: false,
    ns: ['pdf'],
    defaultNS: 'pdf',
    resources,
    interpolation: { escapeValue: false },
  })
  return i18n
}

test('HTTP details, live tasks, and restored tasks retain identity across language changes', async () => {
  const i18n = await translator()
  const code = 'pdf_ai_translation_direction_mismatch'
  const sources = [
    { code, diagnostic: '' },
    { task_id: 'attempt', status: 'failed', error_code: code, error_detail: '', error: code },
    JSON.parse(
      JSON.stringify({
        task_id: 'attempt',
        status: 'failed',
        error_code: code,
        error_detail: '',
        error: code,
      })
    ),
    Object.assign(new Error(code), { code, diagnostic: '' }),
  ]
  const failures = sources.map((source) => pdfAiFailure(source)!)
  for (const failure of failures) {
    assert.deepEqual(failure, { code, diagnostic: '' })
    assert.equal(
      pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')),
      resources.zh.pdf.reading.errors.translation_direction_mismatch
    )
  }
  await i18n.changeLanguage('en')
  for (const failure of failures) {
    assert.equal(
      pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')),
      resources.en.pdf.reading.errors.translation_direction_mismatch
    )
    assert.deepEqual(failure, { code, diagnostic: '' })
  }
})

test('file limits and input budgets have distinct localized explanations and recovery', async () => {
  for (const language of ['zh', 'en']) {
    const i18n = await translator(language)
    const translate = i18n.getFixedT(null, 'pdf')
    const file = { code: 'pdf_ai_file_too_large', diagnostic: '' }
    const input = { code: 'pdf_ai_input_too_large', diagnostic: '' }
    assert.equal(
      pdfAiFailureText(file, translate),
      resources[language].pdf.reading.errors.file_too_large
    )
    assert.equal(
      pdfAiFailureText(input, translate),
      resources[language].pdf.reading.errors.input_too_large
    )
    assert.notEqual(pdfAiFailureText(file, translate), pdfAiFailureText(input, translate))
    assert.equal(pdfAiFailureRecovery(file).configure, false)
    assert.equal(pdfAiFailureRecovery(input).configure, true)
  }
})

test('every backend PDF application error code has a translation in both languages', async () => {
  const backend = readFileSync(
    new URL('../../../../../../../serve/service/literature/service/analysis.py', import.meta.url),
    'utf8'
  )
  const codes = [...backend.matchAll(/^ {4}[A-Z_]+ = "(pdf_ai_[a-z_]+)"$/gm)].map(
    (match) => match[1]
  )
  assert.ok(codes.length > 0)
  for (const language of ['zh', 'en']) {
    const i18n = await translator(language)
    for (const code of codes) {
      const rendered = pdfAiFailureText({ code, diagnostic: '' }, i18n.getFixedT(null, 'pdf'))
      assert.ok(rendered.length > 0)
      assert.ok(!rendered.includes(code), `${language}: unmapped ${code}`)
      assert.notEqual(rendered, resources[language].pdf.reading.failed)
      assert.ok(!rendered.startsWith('reading.errors.'))
    }
  }
})

test('image capability failures tell users to select a model that declares image input support', async () => {
  const expected = {
    zh: '当前模型未声明支持图片输入，请切换支持图片的模型。',
    en: 'The current model does not declare image input support. Select a model that supports images.',
  }
  for (const language of ['zh', 'en'] as const) {
    const i18n = await translator(language)
    assert.equal(
      pdfAiFailureText(
        { code: 'pdf_ai_image_input_unsupported', diagnostic: '' },
        i18n.getFixedT(null, 'pdf')
      ),
      expected[language]
    )
  }
})

test('unavailable PDF models explain login or model configuration in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    const i18n = await translator(language)
    const text = pdfAiFailureText(
      { code: 'pdf_ai_model_unavailable', diagnostic: '' },
      i18n.getFixedT(null, 'pdf')
    )
    assert.match(text, language === 'zh' ? /模型|登录/ : /model|sign in/i)
    assert.notEqual(text, resources[language].pdf.reading.failed)
  }
  assert.equal(
    pdfAiFailureRecovery({ code: 'pdf_ai_model_unavailable', diagnostic: '' }).configure,
    true
  )
})

test('unknown provider errors and known application errors retain diagnostics without displaying them', async () => {
  const i18n = await translator('en')
  const diagnostic = '供应商 <response> & details\n  original whitespace  '
  for (const source of [
    { code: 'provider_capacity', diagnostic },
    { error_code: 'provider_capacity', error_detail: diagnostic, error: diagnostic },
    new Error(diagnostic),
    diagnostic,
  ]) {
    const failure = pdfAiFailure(source)!
    assert.equal(failure.diagnostic, diagnostic)
    assert.equal(
      pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')),
      resources.en.pdf.reading.failed
    )
  }
  const known = pdfAiFailure({ code: 'pdf_ai_execution_failed', diagnostic })!
  assert.equal(
    pdfAiFailureText(known, i18n.getFixedT(null, 'pdf')),
    resources.en.pdf.reading.errors.execution_failed
  )
  for (const code of ['unknown_code', '__proto__', 'constructor']) {
    assert.equal(
      pdfAiFailureText({ code, diagnostic: '' }, i18n.getFixedT(null, 'pdf')),
      resources.en.pdf.reading.failed
    )
  }
})

test('legacy localized error text remains raw and is never used as error identity', async () => {
  const i18n = await translator('en')
  const legacy = resources.zh.pdf.reading.errors.literature_missing
  const failure = pdfAiFailure({ error: legacy })!
  assert.deepEqual(failure, { diagnostic: legacy })
  assert.equal(
    pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')),
    resources.en.pdf.reading.failed
  )
})

test('empty or malformed descriptors use the generic presentation fallback', async () => {
  const i18n = await translator('en')
  for (const source of [
    null,
    undefined,
    '',
    false,
    42,
    {},
    [],
    { code: 42, diagnostic: {} },
    { error_code: '', error_detail: '' },
  ]) {
    assert.equal(pdfAiFailure(source), undefined)
  }
  assert.equal(
    pdfAiFailureText({ diagnostic: '' }, i18n.getFixedT(null, 'pdf')),
    resources.en.pdf.reading.failed
  )
})

test('unknown codes and supplied diagnostics use generic error presentation', async () => {
  const i18n = await translator('en')
  const failure = { code: 'future_pdf_code', diagnostic: '原始诊断 <text> & {{value}}' }
  assert.equal(
    pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')),
    resources.en.pdf.reading.failed
  )
})

test('catch-only normalization preserves primitive diagnostics without inventing errors for normal tasks', () => {
  for (const cause of [null, undefined, false, true, 42, {}, []]) {
    assert.equal(pdfAiFailure(cause), undefined)
    assert.deepEqual(pdfAiCaughtFailure(cause), { diagnostic: String(cause) })
  }
  const descriptor = { code: 'future_pdf_code', diagnostic: 'raw detail' }
  assert.deepEqual(pdfAiCaughtFailure(descriptor), descriptor)
  assert.equal(pdfAiFailure({ task_id: 'task', status: 'running' }), undefined)
})

test('recovery actions distinguish selection, model configuration, and request failures', () => {
  assert.deepEqual(pdfAiFailureRecovery({ code: 'pdf_ai_task_unresolved', diagnostic: '' }), {
    configure: false,
    reselect: false,
    retry: false,
  })
  assert.deepEqual(pdfAiFailureRecovery({ code: 'pdf_ai_selection_unlocated', diagnostic: '' }), {
    configure: false,
    reselect: true,
    retry: false,
  })
  assert.deepEqual(pdfAiFailureRecovery({ code: 'pdf_ai_preparation_failed', diagnostic: '' }), {
    configure: true,
    reselect: false,
    retry: true,
  })
  assert.deepEqual(pdfAiFailureRecovery({ code: 'provider_timeout', diagnostic: 'timeout' }), {
    configure: false,
    reselect: false,
    retry: true,
  })
})
