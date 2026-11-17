import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  initialTranslation,
  translationChoice,
  translationAllowed,
  translationDirty,
  automaticSelection,
  supportedLanguages,
  rememberChoice,
  translationModelKey,
  TRANSLATION_SERVICES,
  engineAvailable,
} from './model.ts'

test('automatic selection defaults off and disabling toolbar preserves the preference', () => {
  const state = initialTranslation()
  assert.equal(automaticSelection(state), false)
  state.selectionAutomatic = true
  assert.equal(automaticSelection(state), true)
  state.toolbar = false
  assert.equal(automaticSelection(state), false)
  assert.equal(state.selectionAutomatic, true)
  state.toolbar = true
  assert.equal(automaticSelection(state), true)
})

test('offline languages require completed packages and a supported direction', () => {
  const state = initialTranslation()
  assert.deepEqual(supportedLanguages(state, 'offline'), ['zh-CN', 'en'])
  assert.equal(
    translationAllowed(state, { engine: 'offline', source: 'auto', target: 'fr' }),
    false
  )
  state.packages.fr = 'installing'
  assert.equal(supportedLanguages(state, 'offline').includes('fr'), false)
  state.packages.fr = 'failed'
  assert.equal(supportedLanguages(state, 'offline').includes('fr'), false)
  state.packages.fr = 'installed'
  assert.equal(translationAllowed(state, { engine: 'offline', source: 'en', target: 'fr' }), true)
  assert.equal(translationAllowed(state, { engine: 'offline', source: 'fr', target: 'fr' }), false)
})

test('online services cannot be selected before successful validation', () => {
  const state = initialTranslation()
  const choice = { engine: 'deepl', source: 'auto', target: 'en' }
  for (const status of ['unconfigured', 'pending', 'failed'] as const) {
    state.services.deepl = status
    assert.equal(translationAllowed(state, choice), false)
  }
  state.services.deepl = 'configured'
  assert.equal(translationAllowed(state, choice), true)
})

test('retired Tencent service is absent from settings and pickers even with saved credentials', () => {
  const state = initialTranslation()
  assert.deepEqual(
    TRANSLATION_SERVICES.map((service) => service.id),
    ['offline', 'deepl', 'youdao', 'baidu', 'aliyun', 'volcengine', 'google', 'microsoft']
  )
  assert.equal(state.services.tencent, undefined)
  state.services.tencent = 'configured'
  assert.equal(engineAvailable(state, 'tencent'), false)
  assert.deepEqual(supportedLanguages(state, 'tencent'), [])
  assert.equal(
    translationAllowed(state, { engine: 'tencent', source: 'en', target: 'zh-CN' }),
    false
  )
})

test('document and selection preferences are isolated by document and first use follows default', () => {
  let state = initialTranslation()
  state.defaultEngine = 'offline'
  const choice = { engine: 'offline', source: 'en', target: 'zh-CN' }
  state = rememberChoice(state, 'paper-a', 'document', choice)
  assert.deepEqual(translationChoice(state, 'paper-a', 'document', 'en'), choice)
  assert.equal(translationChoice(state, 'paper-b', 'document', 'en').source, 'auto')
  assert.equal(translationChoice(state, 'paper-a', 'selection', 'en').source, 'auto')
  assert.equal(translationChoice(state, 'paper-b', 'selection', 'en').engine, 'offline')
})

test('pending choices do not overwrite applied results and dirty clears only after applying', () => {
  const applied = { engine: 'offline', source: 'auto', target: 'zh-CN' }
  const draft = { ...applied, target: 'en' }
  assert.equal(translationDirty(draft, applied), true)
  assert.equal(applied.target, 'zh-CN')
  assert.equal(translationDirty(draft, draft), false)
  assert.equal(translationDirty(draft, undefined), false)
})

test('the chosen document AI model, not another document global preference, determines the request', () => {
  const choice = { engine: 'ai:model-a', source: 'auto', target: 'en' }
  assert.equal(translationModelKey(choice, ['model-a', 'model-b']), 'model-a')
  assert.equal(translationModelKey(choice, ['model-b']), '')
  assert.equal(translationModelKey({ ...choice, engine: 'offline' }, ['model-a']), '')
})
