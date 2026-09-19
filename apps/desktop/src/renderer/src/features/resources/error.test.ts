import assert from 'node:assert/strict'
import test from 'node:test'

import { resourceErrorMessage, resourceFailureDetail } from './error.ts'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

test('known resource errors select stable messages and unknown diagnostics remain unchanged', () => {
  assert.deepEqual(resourceErrorMessage('invalid_name'), { key: 'operationError.invalid_name', detail: undefined })
  for (const code of ['vendor_failure: 原始诊断', 'toString', '__proto__']) {
    assert.deepEqual(resourceErrorMessage(code), { key: 'operationError.unknown', detail: code })
  }
  assert.deepEqual(resourceErrorMessage(), { key: 'operationError.unknown', detail: undefined })
})

test('import failure descriptors translate at display time and retain unknown diagnostics', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'zh', fallbackLng: false, resources: {
    zh: { resources: JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/resources.json', import.meta.url), 'utf8')) },
    en: { resources: JSON.parse(readFileSync(new URL('../../../../localization/locales/en/resources.json', import.meta.url), 'utf8')) }
  } })
  for (const code of ['resource_import_interrupted', 'resource_import_failed', 'invalid_name', 'name_too_long']) {
    const descriptor = resourceErrorMessage(code)
    const canonical = structuredClone(descriptor)
    await i18n.changeLanguage('zh')
    const chinese = i18n.t(descriptor.key, { ns: 'resources' })
    await i18n.changeLanguage('en')
    const english = i18n.t(descriptor.key, { ns: 'resources' })
    assert.notEqual(chinese, english)
    assert.notEqual(english, descriptor.key)
    assert.deepEqual(descriptor, canonical)
    assert.equal(descriptor.detail, undefined)
  }
  assert.deepEqual(resourceErrorMessage('vendor: 原始诊断 /tmp/原文'), { key: 'operationError.unknown', detail: 'vendor: 原始诊断 /tmp/原文' })
})

test('unknown suggestion failures keep codes with absent, duplicate, or distinct detail', () => {
  assert.equal(resourceFailureDetail('vendor_code', ''), 'vendor_code')
  assert.equal(resourceFailureDetail('vendor_code', 'vendor_code'), 'vendor_code')
  assert.equal(resourceFailureDetail('vendor_code', '原始诊断 /tmp/文档'), 'vendor_code: 原始诊断 /tmp/文档')
  assert.equal(resourceFailureDetail('', '原始诊断'), '原始诊断')
  assert.equal(resourceFailureDetail('', ''), undefined)
})
