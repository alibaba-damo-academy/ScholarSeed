import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }
import { AssistantRequestError, assistantFailureDetail, assistantRequestFailure } from './failure.ts'
import { defaultExcerptName } from './names.ts'

test('application failure provenance is separate from identical upstream messages and retains diagnostics', () => {
  const generated = assistantRequestFailure(undefined)
  assert.deepEqual(generated, { error: 'request_failed', applicationFailure: { code: 'request_failed' } })
  assert.equal(assistantFailureDetail(generated), undefined)
  for (const text of ['request failed', 'request_failed', '原始诊断 <text> & {{name}}']) {
    const upstream = assistantRequestFailure(new Error(text))
    assert.deepEqual(upstream, { error: text })
    assert.equal(assistantFailureDetail(upstream), text)
    assert.equal(assistantFailureDetail(assistantRequestFailure(text)), text)
  }
})

test('excerpt creation and folder accessibility use complete current-language messages without rewriting draft data', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const t = locale.getFixedT(null, 'assistant')
  assert.equal(defaultExcerptName('', t), 'AI任务摘录_任务摘录')
  const draft = { name: defaultExcerptName('原文', t) }
  assert.equal(draft.name, '原文_任务摘录')
  const folder = '原始 <folder> & {{name}}'
  assert.equal(t('save.expandFolder', { name: folder }), `展开 ${folder}`)
  await locale.changeLanguage('en')
  assert.equal(defaultExcerptName('', t), 'AItask_conversation-excerpt')
  assert.equal(defaultExcerptName('原文', t), '原文_conversation-excerpt')
  assert.equal(draft.name, '原文_任务摘录')
  assert.equal(t('save.collapseFolder', { name: folder }), `Collapse ${folder}`)
})


test('application request errors retain provenance when normalized by another catch boundary', () => {
  const error = new AssistantRequestError()
  const normalized = assistantRequestFailure(error)
  assert.deepEqual(normalized, { error: 'request_failed', applicationFailure: { code: 'request_failed' } })
  assert.equal(assistantFailureDetail(normalized), undefined)
  const original = assistantRequestFailure(new Error(error.message))
  assert.deepEqual(original, { error: 'request_failed' })
  assert.equal(assistantFailureDetail(original), 'request_failed')
})
