import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import { feedback, renderFeedback } from './feedback.ts'

test('stored feedback and nested fallback resolve again after language changes', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false },
    resources: {
      zh: { components: { composer: { adjustFailed: '调整失败：{{error}}', stateChanged: '状态变化' } } },
      en: { components: { composer: { adjustFailed: 'Adjustment failed: {{error}}', stateChanged: 'State changed' } } }
    }
  })
  const message = feedback('components', 'composer.adjustFailed', {
    error: feedback('components', 'composer.stateChanged')
  })
  assert.equal(renderFeedback(instance, message), '调整失败：状态变化')
  await instance.changeLanguage('en')
  assert.equal(renderFeedback(instance, message), 'Adjustment failed: State changed')
  assert.equal(renderFeedback(instance, '诊断: ECONNRESET /user/file'), '诊断: ECONNRESET /user/file')
})

test('conversation action failures and model notices retain identity across language changes', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'zh', fallbackLng: false, resources: {
    zh: { conversation: { retry: { continueUnconfirmed: '尚未确认' }, models: { nextTurn: '下一轮生效' } } },
    en: { conversation: { retry: { continueUnconfirmed: 'Unconfirmed' }, models: { nextTurn: 'Applies next turn' } } }
  } })
  const actionError = feedback('conversation', 'retry.continueUnconfirmed')
  const notice = feedback('conversation', 'models.nextTurn')
  assert.equal(renderFeedback(instance, actionError), '尚未确认')
  assert.equal(renderFeedback(instance, notice), '下一轮生效')
  await instance.changeLanguage('en')
  assert.equal(renderFeedback(instance, actionError), 'Unconfirmed')
  assert.equal(renderFeedback(instance, notice), 'Applies next turn')
})
