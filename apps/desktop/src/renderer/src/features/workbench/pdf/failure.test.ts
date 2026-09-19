import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { pdfAiCaughtFailure, pdfAiFailure, pdfAiFailureRecovery, pdfAiFailureText } from './failure.ts'

const resources = Object.fromEntries(['zh', 'en'].map(language => [language, {
  pdf: JSON.parse(readFileSync(new URL(`../../../../../localization/locales/${language}/pdf.json`, import.meta.url), 'utf8'))
}]))

async function translator(language = 'zh') {
  const i18n = createInstance()
  await i18n.init({ lng: language, fallbackLng: false, ns: ['pdf'], defaultNS: 'pdf', resources, interpolation: { escapeValue: false } })
  return i18n
}

test('HTTP details, live tasks, and restored tasks retain identity across language changes', async () => {
  const i18n = await translator()
  const code = 'pdf_ai_translation_direction_mismatch'
  const sources = [
    { code, diagnostic: '' },
    { task_id: 'attempt', status: 'failed', error_code: code, error_detail: '', error: code },
    JSON.parse(JSON.stringify({ task_id: 'attempt', status: 'failed', error_code: code, error_detail: '', error: code })),
    Object.assign(new Error(code), { code, diagnostic: '' }),
  ]
  const failures = sources.map(source => pdfAiFailure(source)!)
  for (const failure of failures) {
    assert.deepEqual(failure, { code, diagnostic: '' })
    assert.equal(pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')), resources.zh.pdf.reading.errors.translation_direction_mismatch)
  }
  await i18n.changeLanguage('en')
  for (const failure of failures) {
    assert.equal(pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')), resources.en.pdf.reading.errors.translation_direction_mismatch)
    assert.deepEqual(failure, { code, diagnostic: '' })
  }
})

test('every backend PDF application error code has a translation in both languages', async () => {
  const backend = readFileSync(new URL('../../../../../../../serve/service/literature/service/analysis.py', import.meta.url), 'utf8')
  const codes = [...backend.matchAll(/^    [A-Z_]+ = "(pdf_ai_[a-z_]+)"$/gm)].map(match => match[1])
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

test('unknown provider errors and known application errors preserve diagnostics verbatim', async () => {
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
    assert.equal(pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')), `${resources.en.pdf.reading.failed}\n${failure.code ? failure.code + '\n' : ''}${diagnostic}`)
  }
  const known = pdfAiFailure({ code: 'pdf_ai_execution_failed', diagnostic })!
  assert.equal(pdfAiFailureText(known, i18n.getFixedT(null, 'pdf')), `${resources.en.pdf.reading.errors.execution_failed}\n${diagnostic}`)
  for (const code of ['unknown_code', '__proto__', 'constructor']) {
    assert.equal(pdfAiFailureText({ code, diagnostic: '' }, i18n.getFixedT(null, 'pdf')), `${resources.en.pdf.reading.failed}\n${code}`)
  }
})

test('legacy localized error text remains raw and is never used as error identity', async () => {
  const i18n = await translator('en')
  const legacy = resources.zh.pdf.reading.errors.literature_missing
  const failure = pdfAiFailure({ error: legacy })!
  assert.deepEqual(failure, { diagnostic: legacy })
  assert.equal(pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')), `${resources.en.pdf.reading.failed}\n${legacy}`)
})

test('empty or malformed descriptors use the generic presentation fallback', async () => {
  const i18n = await translator('en')
  for (const source of [null, undefined, '', false, 42, {}, [], { code: 42, diagnostic: {} }, { error_code: '', error_detail: '' }]) {
    assert.equal(pdfAiFailure(source), undefined)
  }
  assert.equal(pdfAiFailureText({ diagnostic: '' }, i18n.getFixedT(null, 'pdf')), resources.en.pdf.reading.failed)
})


test('unknown codes and supplied diagnostics both survive generic error presentation', async () => {
  const i18n = await translator('en')
  const failure = { code: 'future_pdf_code', diagnostic: '原始诊断 <text> & {{value}}' }
  assert.equal(pdfAiFailureText(failure, i18n.getFixedT(null, 'pdf')), `${resources.en.pdf.reading.failed}\n${failure.code}\n${failure.diagnostic}`)
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
  assert.deepEqual(pdfAiFailureRecovery({ code: 'pdf_ai_selection_unlocated', diagnostic: '' }), {
    configure: false, reselect: true, retry: false
  })
  assert.deepEqual(pdfAiFailureRecovery({ code: 'pdf_ai_preparation_failed', diagnostic: '' }), {
    configure: true, reselect: false, retry: true
  })
  assert.deepEqual(pdfAiFailureRecovery({ code: 'provider_timeout', diagnostic: 'timeout' }), {
    configure: false, reselect: false, retry: true
  })
})
