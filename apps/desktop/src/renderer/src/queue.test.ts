import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/components.json' with { type: 'json' }
import en from '../../localization/locales/en/components.json' with { type: 'json' }
import zhConversation from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import enConversation from '../../localization/locales/en/conversation.json' with { type: 'json' }

import {
  QUEUE_PRESENTATION_MESSAGE_KEYS,
  canCancelQueuedMessage,
  confirmQueuedOutcome,
  hasAcceptedMessageAwaitingRuntime,
  hasQueuedMessageAwaitingRuntime,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  queueBlockedByUnconfirmed,
  queuedMessageErrorText,
  queuedWithdrawalFeedback,
  queuedMessageFromPayload,
  rejectOptimisticQueuedMessage,
  settleOptimisticQueuedMessage,
  shouldOptimisticallyPresentUserMessage,
  shouldPresentQueuedMessage,
  upsertQueuedMessage,
} from './queue.ts'
import { mergeQueuedOutbox, releaseQueuedOutbox, retainQueuedOutbox } from './outbox.ts'

const input = [{ type: 'text' as const, text: '继续补充证据' }]

test('unknown confirmation refreshes authoritative state before reporting a stale or failed action', async () => {
  for (const result of [
    { ok: true },
    { ok: false, code: 'runtime_turn_confirmation_stale' },
    { ok: false, error: 'network unavailable' },
  ]) {
    const calls: string[] = []
    const message = await confirmQueuedOutcome({
      confirm: async () => {
        calls.push('confirm')
        return result
      },
      refreshQueue: async () => {
        calls.push('queue')
        return true
      },
      refreshContext: async () => {
        calls.push('context')
      },
    })
    assert.deepEqual(calls, ['confirm', 'queue', 'context'])
    assert.equal(
      message?.key,
      result.ok
        ? undefined
        : result.code
          ? 'composer.confirmStateChanged'
          : 'composer.confirmContinueFailed'
    )
  }
})

test('unknown confirmation keeps refresh failure explicit and never repeats the submission', async () => {
  let confirmations = 0
  const message = await confirmQueuedOutcome({
    confirm: async () => {
      confirmations += 1
      return { ok: false, code: 'runtime_turn_confirmation_stale' }
    },
    refreshQueue: async () => false,
    refreshContext: async () => {},
  })
  assert.equal(confirmations, 1)
  assert.equal(message?.key, 'composer.checkFailed')
})

test('host configuration conflicts explain the explicit runtime switch boundary', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: { zh: { components: zh }, en: { components: en } },
  })
  const translate = instance.getFixedT(null, 'components')
  assert.equal(
    queuedMessageErrorText('runtime_host_configuration_conflict', 'failed', translate),
    zh.composer.runtimeHostConfigurationConflict
  )
  await instance.changeLanguage('en')
  assert.equal(
    queuedMessageErrorText('runtime_host_configuration_conflict', 'failed', translate),
    en.composer.runtimeHostConfigurationConflict
  )
})

test('optimistic outbox freezes selected literature for retry', () => {
  const selectedLiteratureIds = ['selected-paper']
  const queued = optimisticQueuedMessage(
    [],
    'queued-selected',
    input,
    [],
    0,
    'queued',
    undefined,
    selectedLiteratureIds
  )
  selectedLiteratureIds.push('later-paper')
  assert.deepEqual(queued.selectedLiteratureIds, ['selected-paper'])
})

test('queued send explains pending settlement without exposing internal codes', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { components: zh }, en: { components: en } },
  })
  const cases = [
    ['turn_outcome_unconfirmed', 'turnOutcomeUnconfirmed'],
    ['previous_turn_settling', 'previousTurnSettling'],
    ['previous_turn_background_active', 'previousTurnBackgroundActive'],
    ['previous_turn_pending_hil', 'previousTurnPendingHil'],
    ['previous_turn_activity_unavailable', 'previousTurnActivityUnavailable'],
  ] as const
  for (const [language, messages] of [
    ['zh', zh],
    ['en', en],
  ] as const) {
    await instance.changeLanguage(language)
    for (const [code, key] of cases) {
      assert.equal(
        queuedMessageErrorText(code, 'queued', instance.getFixedT(null, 'components')),
        messages.composer[key]
      )
    }
  }
})

test('permission admission errors preserve paths and explain recovery in both languages', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      zh: { components: zh, conversation: zhConversation },
      en: { components: en, conversation: enConversation },
    },
  })
  const translate = instance.getFixedT(null, 'components')
  const path = 'resources/受限 <文件> & report.md'
  const queued = queuedMessageFromPayload({
    queued_message_id: 'denied',
    enqueue_seq: 1,
    state: 'failed',
    submission_mode: 'direct',
    input,
    safe_error: 'resource_baseline_permission_denied',
    safe_error_details: { path },
  })
  assert.deepEqual(queued.safeErrorDetails, { path })
  const chinese = queuedMessageErrorText(
    queued.safeErrorCode,
    queued.state,
    translate,
    queued.safeErrorDetails
  )
  assert.match(chinese, /系统拒绝读取项目文件/)
  assert.ok(chinese.includes(path))
  assert.match(chinese, /本条消息尚未提交/)
  assert.match(chinese, /处理后再重新发送/)
  assert.doesNotMatch(chinese, /resource_baseline_permission_denied/)
  await instance.changeLanguage('en')
  const english = queuedMessageErrorText(
    queued.safeErrorCode,
    queued.state,
    translate,
    queued.safeErrorDetails
  )
  assert.ok(english.includes(path))
  assert.match(english, /access permissions/)
  assert.match(english, /not been submitted/)
  assert.match(english, /send the message again/)
  assert.match(queuedMessageErrorText(queued.safeErrorCode, 'failed', translate), /project file/)
})

test('pending questions explain why a queued message cannot leave the queue', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: { components: zh },
      en: { components: en },
    },
  })
  const translate = instance.getFixedT(null, 'components')
  assert.match(
    queuedMessageErrorText('runtime_resource_wait_pending_hil', 'failed', translate),
    /待回答的问题/
  )
  assert.match(
    queuedMessageErrorText('runtime_resource_wait_activity_unavailable', 'failed', translate),
    /无法确认/
  )
  await instance.changeLanguage('en')
  assert.match(
    queuedMessageErrorText('runtime_resource_wait_pending_hil', 'failed', translate),
    /question/
  )
  assert.match(
    queuedMessageErrorText('runtime_resource_wait_activity_unavailable', 'failed', translate),
    /could not be confirmed/
  )
})

test('withdrawal feedback distinguishes conflicts, missing messages, access and uncertainty', () => {
  const cases = [
    { status: 409, error: 'queued_message_not_editable', key: 'composer.withdrawStateChanged' },
    { status: 404, error: 'queued_message_not_found', key: 'composer.withdrawMissing' },
    { status: 404, error: 'session_not_found', key: 'composer.withdrawUnavailable' },
    { status: 403, error: '', key: 'composer.withdrawDenied' },
    { status: 401, error: '', key: 'composer.withdrawDenied' },
    { status: 0, error: '', key: 'composer.withdrawFailed' },
    { status: 500, error: '', key: 'composer.withdrawFailed' },
  ]
  for (const entry of cases) {
    assert.deepEqual(queuedWithdrawalFeedback({ ok: false, ...entry }), {
      ns: 'components',
      key: entry.key,
      values: undefined,
    })
  }
})

test('shows a running-turn submission before the server acknowledges the queue', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])

  assert.equal(optimistic.queuedMessageId, 'client-1')
  assert.equal(optimistic.state, 'submitting')
  assert.equal(optimistic.text, '继续补充证据')
})

test('presents only the first idle submission as an immediate user message', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [])

  assert.equal(shouldOptimisticallyPresentUserMessage(false, []), true)
  assert.equal(shouldOptimisticallyPresentUserMessage(true, []), false)
  assert.equal(shouldOptimisticallyPresentUserMessage(false, [pending]), false)
})

test('hides a represented queue placeholder while retaining recovery states', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [], undefined, 'direct')
  const conversation = [
    {
      kind: 'user' as const,
      text: '继续补充证据',
      itemId: 'client-1',
    },
  ]

  assert.equal(shouldPresentQueuedMessage(pending, conversation), false)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'queued' }, conversation), false)
  assert.equal(
    shouldPresentQueuedMessage({ ...pending, state: 'waiting_resources' }, conversation),
    false
  )
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'submitting' }, conversation), false)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'failed' }, conversation), true)
  assert.equal(
    shouldPresentQueuedMessage({ ...pending, state: 'outcome_unknown' }, conversation),
    true
  )
  assert.equal(shouldPresentQueuedMessage(pending, []), false)
})

test('presents every transient stage of a user-queued message as one queue item', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [], undefined, 'queued')

  for (const state of ['queued', 'waiting_resources', 'submitting'] as const) {
    assert.equal(shouldPresentQueuedMessage({ ...pending, state }, []), true)
  }
})

test('hides queue recovery when the turn recovery card owns confirmation', () => {
  const pending = {
    ...optimisticQueuedMessage([], 'client-1', input, []),
    state: 'outcome_unknown' as const,
    nativeTurnId: 'turn-1',
  }
  const conversation = [
    {
      kind: 'error' as const,
      title: '上次任务已中断',
      message: '应用在任务结束前中断，部分操作可能已完成。',
      action: '是否继续对话？',
      runtimeAction: 'confirm_turn_unknown' as const,
      actionTurnId: 'turn-1',
      actionState: 'idle' as const,
    },
  ]

  assert.equal(shouldPresentQueuedMessage(pending, conversation), false)
  assert.equal(
    shouldPresentQueuedMessage({ ...pending, nativeTurnId: 'turn-2' }, conversation),
    true
  )
})

test('shows direct admission as working without treating user queue items as active', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [], undefined, 'direct')
  const queued = optimisticQueuedMessage([], 'client-2', input, [], undefined, 'queued')

  assert.equal(hasQueuedMessageAwaitingRuntime([pending]), true)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'queued' }]), true)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'waiting_resources' }]), true)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'failed' }]), false)
  assert.equal(hasQueuedMessageAwaitingRuntime([queued]), false)
  assert.equal(
    hasQueuedMessageAwaitingRuntime([{ ...queued, state: 'queued', serverPresent: true }]),
    false
  )
  assert.equal(
    hasQueuedMessageAwaitingRuntime([
      { ...queued, state: 'waiting_resources', serverPresent: true },
    ]),
    false
  )
  assert.equal(hasQueuedMessageAwaitingRuntime([]), false)
})

test('offers stopping only after the server accepts pending execution', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [], undefined, 'direct')
  const queued = optimisticQueuedMessage([], 'client-2', input, [], undefined, 'queued')

  assert.equal(hasAcceptedMessageAwaitingRuntime([pending]), false)
  assert.equal(hasAcceptedMessageAwaitingRuntime([{ ...pending, state: 'queued' }]), false)
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([{ ...pending, state: 'queued', serverPresent: true }]),
    true
  )
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([
      { ...pending, state: 'waiting_resources', serverPresent: true },
    ]),
    true
  )
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([{ ...pending, state: 'failed', serverPresent: true }]),
    false
  )
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([
      { ...pending, state: 'outcome_unknown', serverPresent: true },
    ]),
    false
  )
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([{ ...queued, state: 'queued', serverPresent: true }]),
    false
  )
  assert.equal(
    hasAcceptedMessageAwaitingRuntime([
      { ...queued, state: 'waiting_resources', serverPresent: true },
    ]),
    false
  )
})

test('uses one queue label for every internal delivery stage', () => {
  for (const state of ['queued', 'waiting_resources', 'submitting'] as const) {
    assert.equal(QUEUE_PRESENTATION_MESSAGE_KEYS[state], 'composer.queued')
  }
  assert.equal(QUEUE_PRESENTATION_MESSAGE_KEYS.failed, 'composer.answerFailed')
  assert.equal(QUEUE_PRESENTATION_MESSAGE_KEYS.outcome_unknown, 'composer.unknownOutcome')
})

test('reconciles the optimistic queue row with the authoritative event by id', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  const authoritative = queuedMessageFromPayload({
    queued_message_id: 'client-1',
    enqueue_seq: 7,
    state: 'queued',
    submission_mode: 'queued',
    input,
  })
  const reconciled = upsertQueuedMessage([optimistic], authoritative)

  assert.equal(reconciled.length, 1)
  assert.deepEqual(reconciled[0], authoritative)
})

test('preserves complete annotation audit fields from the authoritative queue', () => {
  const queued = queuedMessageFromPayload({
    queued_message_id: 'annotated-1',
    enqueue_seq: 2,
    state: 'queued',
    submission_mode: 'queued',
    input,
    assistant_references: [
      {
        kind: 'note',
        ref_id: 'note-1',
        surface: {
          selected_text: '完整选区原文',
          preview_text: '完整选区',
          comment: '补充这条依据',
        },
      },
    ],
  })

  assert.equal(queued.assistantReferences[0]?.surface?.selected_text, '完整选区原文')
  assert.equal(queued.assistantReferences[0]?.surface?.comment, '补充这条依据')
  assert.equal(queued.serverPresent, true)
})

test('a response can settle the optimistic row before its event arrives', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  const settled = settleOptimisticQueuedMessage([optimistic], 'client-1')

  assert.equal(settled[0]?.state, 'queued')
  assert.equal(settled[0]?.serverPresent, true)
  assert.equal(settled[0]?.submissionMode, 'queued')

  const serverCorrected = settleOptimisticQueuedMessage(
    [{ ...optimistic, submissionMode: 'direct' }],
    'client-1',
    'queued'
  )
  assert.equal(serverCorrected[0]?.submissionMode, 'queued')
})

test('resource waits retain deadline, purpose, request identity and frozen references', () => {
  const waiting = queuedMessageFromPayload({
    queued_message_id: 'wait-1',
    enqueue_seq: 3,
    state: 'waiting_resources',
    submission_mode: 'direct',
    deadline: 12345,
    purpose: 'turn',
    input,
    assistant_context_revision: 8,
    assistant_references: [{ ref_id: 'ref-1', label: '研究记录' }],
  })
  assert.equal(waiting.queuedMessageId, 'wait-1')
  assert.equal(waiting.deadline, 12345)
  assert.equal(waiting.purpose, 'turn')
  assert.equal(waiting.assistantContextRevision, 8)
  assert.equal(waiting.assistantReferences[0]?.ref_id, 'ref-1')
  assert.equal(canCancelQueuedMessage(waiting), true)
})

test('late admission receipts do not downgrade authoritative wait or submission events', () => {
  for (const state of ['waiting_resources', 'submitting', 'outcome_unknown'] as const) {
    const authoritative = queuedMessageFromPayload({
      queued_message_id: 'client-1',
      enqueue_seq: 1,
      state,
      submission_mode: 'queued',
      input,
    })
    assert.deepEqual(settleOptimisticQueuedMessage([authoritative], 'client-1'), [authoritative])
  }
  assert.deepEqual(settleOptimisticQueuedMessage([], 'already-started'), [])
})

test('a transport failure does not overwrite an authoritative queue state', () => {
  for (const state of ['waiting_resources', 'submitting', 'queued'] as const) {
    const authoritative = queuedMessageFromPayload({
      queued_message_id: 'client-1',
      enqueue_seq: 1,
      state,
      submission_mode: 'queued',
      input,
    })
    assert.deepEqual(markOptimisticQueueOutcomeUnknown([authoritative], 'client-1'), [
      authoritative,
    ])
  }
})

test('cancellation is available only while a request is known not to be submitting', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  for (const state of ['submitting', 'outcome_unknown'] as const) {
    assert.equal(canCancelQueuedMessage({ ...optimistic, state }), false)
  }
  for (const state of ['queued', 'waiting_resources', 'failed'] as const) {
    assert.equal(canCancelQueuedMessage({ ...optimistic, state, serverPresent: true }), true)
  }
})

test('admission settles only its own pending row and preserves another resource wait', () => {
  const pending = optimisticQueuedMessage([], 'pending-1', input, [])
  const waiting = queuedMessageFromPayload({
    queued_message_id: 'waiting-2',
    enqueue_seq: 2,
    state: 'waiting_resources',
    submission_mode: 'queued',
    input,
  })
  const settled = settleOptimisticQueuedMessage([pending, waiting], pending.queuedMessageId)
  assert.equal(settled[0].serverPresent, true)
  assert.deepEqual(settled[1], waiting)
})

test('keeps an uncertain submission visible until an authoritative refresh', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  const uncertain = markOptimisticQueueOutcomeUnknown([optimistic], 'client-1')

  assert.equal(uncertain[0]?.state, 'outcome_unknown')
})

test('removes only a locally rejected optimistic submission', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  const authoritative = queuedMessageFromPayload({
    queued_message_id: 'server-2',
    enqueue_seq: 2,
    state: 'queued',
    submission_mode: 'queued',
    input,
  })

  assert.deepEqual(rejectOptimisticQueuedMessage([optimistic, authoritative], 'client-1'), [
    authoritative,
  ])
  assert.deepEqual(rejectOptimisticQueuedMessage([authoritative], 'server-2'), [authoritative])
})

test('restores an unacknowledged local outbox row and clears it on server acknowledgement', () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  })
  const optimistic = optimisticQueuedMessage([], 'client-outbox', input, [])
  retainQueuedOutbox('session-outbox', optimistic)

  const restored = mergeQueuedOutbox('session-outbox', [])
  assert.equal(restored[0]?.state, 'outcome_unknown')
  assert.equal(restored[0]?.safeErrorCode, 'turn_outcome_unconfirmed')
  assert.equal(restored[0]?.serverPresent, false)

  const authoritative = queuedMessageFromPayload({
    queued_message_id: 'client-outbox',
    enqueue_seq: 1,
    state: 'queued',
    submission_mode: 'queued',
    input,
  })
  const beforeCandidateRestore = new Map(values)
  assert.deepEqual(mergeQueuedOutbox('session-outbox', [authoritative], false), [authoritative])
  assert.deepEqual(values, beforeCandidateRestore)
  assert.equal(mergeQueuedOutbox('session-outbox', [], false)[0]?.queuedMessageId, 'client-outbox')
  assert.deepEqual(mergeQueuedOutbox('session-outbox', [authoritative]), [authoritative])
  assert.deepEqual(mergeQueuedOutbox('session-outbox', []), [])
  releaseQueuedOutbox('session-outbox', 'client-outbox')
})

test('queue failure codes translate while unknown codes use state-specific fallbacks', async () => {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: { components: zh, conversation: zhConversation },
      en: { components: en, conversation: enConversation },
    },
  })
  const translate = instance.getFixedT(null, 'components')
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_interrupted', 'waiting_resources', translate),
    zh.composer.resourceWaitInterrupted
  )
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_timeout', 'waiting_resources', translate),
    zh.composer.resourceWaitTimeout
  )
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_blocked', 'waiting_resources', translate),
    zh.composer.resourceWaitBlocked
  )
  assert.equal(
    queuedMessageErrorText('runtime_turn_failed', 'outcome_unknown', translate),
    zh.composer.runtimeTurnFailed
  )
  assert.equal(
    queuedMessageErrorText('service supplied detail', 'failed', translate),
    zh.composer.queueFailed
  )
  assert.equal(queuedMessageErrorText('constructor', 'failed', translate), zh.composer.queueFailed)
  for (const errorCode of [
    'queued_message_not_sendable',
    'assistant_context_unavailable',
    'assistant_context_revision_conflict',
    'runtime_credential_alignment_failed',
  ]) {
    const message = queuedMessageErrorText(errorCode, 'outcome_unknown', translate)
    assert.equal(message, zh.composer.runtimeTurnFailed)
    assert.notEqual(message, errorCode)
  }
  for (const [code, key] of [
    ['windows_sandbox_setup_failed', 'sandboxSetupFailed'],
    ['windows_sandbox_setup_in_progress', 'sandboxPreparing'],
    ['windows_sandbox_setup_unknown', 'sandboxUnknown'],
    ['windows_sandbox_tool_access_failed', 'sandboxToolAccessFailed'],
    ['session_model_switch_failed', 'runtimeStartFailed'],
  ] as const) {
    assert.equal(queuedMessageErrorText(code, 'failed', translate), zh.composer[key])
    assert.equal(
      queuedMessageErrorText(code, 'outcome_unknown', translate),
      zh.composer.runtimeTurnFailed
    )
    await instance.changeLanguage('en')
    assert.equal(queuedMessageErrorText(code, 'failed', translate), en.composer[key])
    await instance.changeLanguage('zh')
  }
  for (const [code, key] of [
    ['windows_sandbox_policy_rejected', 'policyRejected'],
    ['windows_sandbox_tool_probe_failed', 'toolProbeFailed'],
    ['windows_sandbox_setup_cancelled', 'setupCancelled'],
  ] as const) {
    assert.equal(queuedMessageErrorText(code, 'failed', translate), zhConversation.sandbox[key])
    assert.equal(
      queuedMessageErrorText(code, 'outcome_unknown', translate),
      zh.composer.runtimeTurnFailed
    )
    await instance.changeLanguage('en')
    assert.equal(queuedMessageErrorText(code, 'failed', translate), enConversation.sandbox[key])
    await instance.changeLanguage('zh')
  }
  assert.ok(!zh.composer.sandboxSetupFailed.includes('完成系统授权'))
  assert.ok(!en.composer.sandboxSetupFailed.includes('Complete the system permission'))
  await instance.changeLanguage('en')
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_timeout', 'waiting_resources', translate),
    en.composer.resourceWaitTimeout
  )
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_blocked', 'waiting_resources', translate),
    en.composer.resourceWaitBlocked
  )
  assert.equal(
    queuedMessageErrorText('runtime_turn_failed', 'outcome_unknown', translate),
    en.composer.runtimeTurnFailed
  )
  assert.equal(
    queuedMessageErrorText('service supplied detail', 'failed', translate),
    en.composer.queueFailed
  )
})

test('an unconfirmed queue outcome blocks the remaining queue presentation', () => {
  const unknown = queuedMessageFromPayload({
    queued_message_id: 'unknown-1',
    enqueue_seq: 1,
    state: 'outcome_unknown',
    submission_mode: 'direct',
    safe_error: 'runtime_turn_failed',
    native_turn_id: 'native-1',
    input,
  })
  const queued = queuedMessageFromPayload({
    queued_message_id: 'queued-2',
    enqueue_seq: 2,
    state: 'queued',
    submission_mode: 'queued',
    input,
  })

  assert.equal(unknown.nativeTurnId, 'native-1')
  assert.equal(queued.nativeTurnId, undefined)
  assert.equal(queueBlockedByUnconfirmed([unknown, queued]), true)
  assert.equal(queueBlockedByUnconfirmed([queued]), false)
  assert.equal(queueBlockedByUnconfirmed([]), false)
  const failed = { ...unknown, state: 'failed' as const }
  assert.equal(queueBlockedByUnconfirmed([failed, queued]), false)
})
