import assert from 'node:assert/strict'
import test from 'node:test'

import { literatureErrorMessage, literatureTaskErrorMessage, literatureTaskStatusMessage } from './error.ts'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

test('known Zotero failures retain a language-neutral message identity', () => {
  assert.deepEqual(literatureErrorMessage('ZOTERO_UNAVAILABLE', '服务端中文提示', 'zotero.connectionFailed'), {
    key: 'operationError.ZOTERO_UNAVAILABLE'
  })
})

test('unknown errors and prototype-like codes preserve raw diagnostics', () => {
  for (const code of ['VENDOR_NEW_ERROR', '__proto__', 'toString', undefined]) {
    assert.deepEqual(literatureErrorMessage(code, 'Original 原始 diagnostic', 'zotero.importFailed'), {
      key: 'zotero.importFailed', detail: code ? `${code}: Original 原始 diagnostic` : 'Original 原始 diagnostic'
    })
  }
  assert.deepEqual(literatureErrorMessage(undefined, undefined, 'zotero.connectionFailed'), {
    key: 'zotero.connectionFailed', detail: undefined
  })
})

// Missing server diagnostics must use the localized operation message.
test('empty transport diagnostics do not replace the localized fallback', () => {
  assert.deepEqual(literatureErrorMessage('REQUEST_FAILED', '', 'pdfImport.parseFailed'), {
    key: 'pdfImport.parseFailed', detail: undefined
  })
})

test('import task status and application errors translate without rewriting task data', async () => {
  const engine = createInstance()
  await engine.init({ lng: 'zh', fallbackLng: false, resources: {
    zh: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/literature.json', import.meta.url), 'utf8')) },
    en: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/en/literature.json', import.meta.url), 'utf8')) }
  } })
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled', 'vendor_state']) {
    const key = literatureTaskStatusMessage(status)
    const zh = engine.getFixedT('zh', 'literature')(key)
    const en = engine.getFixedT('en', 'literature')(key)
    assert.notEqual(zh, en)
    assert.notEqual(en, key)
  }
  assert.equal(literatureTaskStatusMessage('__proto__'), 'importTask.status.unknown')
  const task = { status: 'failed', error_code: 'ZOTERO_UNAVAILABLE', error: '原始中文诊断' }
  const before = structuredClone(task)
  const message = literatureTaskErrorMessage(task)
  assert.deepEqual(message, { key: 'operationError.ZOTERO_UNAVAILABLE' })
  assert.notEqual(engine.getFixedT('zh', 'literature')(message.key), engine.getFixedT('en', 'literature')(message.key))
  assert.deepEqual(task, before)
  assert.deepEqual(literatureTaskErrorMessage({ error_code: 'NEW_CODE', error: '原始诊断' }), { key: 'importTask.failed', detail: 'NEW_CODE: 原始诊断' })
  assert.deepEqual(literatureTaskErrorMessage({ error_code: 'NEW_CODE' }), { key: 'importTask.failed', detail: 'NEW_CODE' })
  assert.deepEqual(literatureTaskErrorMessage({ error: '旧诊断' }), { key: 'importTask.failed', detail: '旧诊断' })
  assert.deepEqual(literatureTaskErrorMessage({ error_code: 'ZOTERO_IMPORT_FAILED', error: 'Zotero 导入失败' }), { key: 'importTask.failed' })
})
