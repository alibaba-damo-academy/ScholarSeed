import assert from 'node:assert/strict'
import test from 'node:test'

import { resourceErrorMessage } from './error.ts'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

test('known resource errors select stable messages and unknown diagnostics use a fallback', () => {
  assert.deepEqual(resourceErrorMessage('invalid_name'), {
    key: 'operationError.invalid_name',
    detail: undefined,
  })
  assert.deepEqual(resourceErrorMessage('root_busy'), {
    key: 'operationError.root_busy',
    detail: undefined,
  })
  for (const code of ['vendor_failure: 原始诊断', 'toString', '__proto__']) {
    assert.deepEqual(resourceErrorMessage(code), {
      key: 'operationError.unknown',
      detail: undefined,
    })
  }
  assert.deepEqual(resourceErrorMessage(), { key: 'operationError.unknown', detail: undefined })
})

test('import failure descriptors translate at display time and retain unknown diagnostics', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
      zh: {
        resources: JSON.parse(
          readFileSync(
            new URL('../../../../localization/locales/zh/resources.json', import.meta.url),
            'utf8'
          )
        ),
      },
      en: {
        resources: JSON.parse(
          readFileSync(
            new URL('../../../../localization/locales/en/resources.json', import.meta.url),
            'utf8'
          )
        ),
      },
    },
  })
  for (const code of [
    'root_busy',
    'resource_import_interrupted',
    'resource_import_failed',
    'invalid_name',
    'name_too_long',
  ]) {
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
  assert.deepEqual(resourceErrorMessage('vendor: 原始诊断 /tmp/原文'), {
    key: 'operationError.unknown',
    detail: undefined,
  })
})
