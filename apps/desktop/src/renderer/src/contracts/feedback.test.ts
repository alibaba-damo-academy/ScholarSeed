import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import componentsEn from '../../../localization/locales/en/components.json' with { type: 'json' }
import conversationEn from '../../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../../localization/locales/zh/components.json' with { type: 'json' }
import conversationZh from '../../../localization/locales/zh/conversation.json' with { type: 'json' }
import { RECONFIGURATION_ERRORS } from '../../../reconfiguration.ts'
import {
  feedback,
  renderFeedback,
  runtimePreparationMessageKey,
  stopFailureFeedback,
} from './feedback.ts'

test('runtime preparation distinguishes a retryable busy host from other failures', () => {
  assert.equal(
    runtimePreparationMessageKey(RECONFIGURATION_ERRORS.hostBusy),
    'runtimePreparation.busy'
  )
  assert.equal(
    runtimePreparationMessageKey(RECONFIGURATION_ERRORS.resourceWaitTimeout),
    'runtimePreparation.failed'
  )
  assert.equal(runtimePreparationMessageKey(undefined), 'runtimePreparation.failed')
})

test('stored feedback and nested fallback resolve again after language changes', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        components: { composer: { adjustFailed: '调整失败：{{error}}', stateChanged: '状态变化' } },
      },
      en: {
        components: {
          composer: { adjustFailed: 'Adjustment failed: {{error}}', stateChanged: 'State changed' },
        },
      },
    },
  })
  const message = feedback('components', 'composer.adjustFailed', {
    error: feedback('components', 'composer.stateChanged'),
  })
  assert.equal(renderFeedback(instance, message), '调整失败：状态变化')
  await instance.changeLanguage('en')
  assert.equal(renderFeedback(instance, message), 'Adjustment failed: State changed')
  assert.equal(
    renderFeedback(instance, '诊断: ECONNRESET /user/file'),
    '诊断: ECONNRESET /user/file'
  )
})

test('conversation action failures and model notices retain identity across language changes', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
      zh: {
        conversation: {
          retry: { continueUnconfirmed: '尚未确认' },
          models: { nextTurn: '下一轮生效' },
        },
      },
      en: {
        conversation: {
          retry: { continueUnconfirmed: 'Unconfirmed' },
          models: { nextTurn: 'Applies next turn' },
        },
      },
    },
  })
  const actionError = feedback('conversation', 'retry.continueUnconfirmed')
  const notice = feedback('conversation', 'models.nextTurn')
  assert.equal(renderFeedback(instance, actionError), '尚未确认')
  assert.equal(renderFeedback(instance, notice), '下一轮生效')
  await instance.changeLanguage('en')
  assert.equal(renderFeedback(instance, actionError), 'Unconfirmed')
  assert.equal(renderFeedback(instance, notice), 'Applies next turn')
})

test('stop failures keep localized reasons when the display language changes', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { components: componentsZh, conversation: conversationZh },
      en: { components: componentsEn, conversation: conversationEn },
    },
  })
  const message = stopFailureFeedback('harness_interrupt_failed')
  const unavailable = stopFailureFeedback('previous_turn_activity_unavailable')
  const fallback = stopFailureFeedback('unmapped_stop_code')
  const timedOut = stopFailureFeedback(
    'harness_interrupt_failed',
    feedback('conversation', 'request.timeout')
  )
  assert.equal(
    renderFeedback(instance, message),
    '终止请求未完成：任务状态暂时无法确认，请稍后重试。'
  )
  assert.equal(renderFeedback(instance, unavailable), renderFeedback(instance, message))
  assert.equal(renderFeedback(instance, fallback), '终止请求未完成：未知错误')
  await instance.changeLanguage('en')
  assert.equal(
    renderFeedback(instance, message),
    'Stop request did not complete: The task status could not be confirmed. Try again shortly.'
  )
  assert.equal(renderFeedback(instance, unavailable), renderFeedback(instance, message))
  assert.equal(renderFeedback(instance, fallback), 'Stop request did not complete: Unknown error')
  assert.equal(
    renderFeedback(instance, timedOut),
    'Stop request did not complete: Request timed out'
  )
})
