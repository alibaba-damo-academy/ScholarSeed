import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/components.json' with { type: 'json' }
import en from '../../localization/locales/en/components.json' with { type: 'json' }

import {
  canCancelQueuedMessage,
  hasQueuedMessageAwaitingRuntime,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  queueBlockedByUnconfirmed,
  queuedMessageErrorText,
  queuedMessageFromPayload,
  rejectOptimisticQueuedMessage,
  settleOptimisticQueuedMessage,
  shouldOptimisticallyPresentUserMessage,
  shouldPresentQueuedMessage,
  upsertQueuedMessage
} from './queue.ts'
import {
  mergeQueuedOutbox,
  releaseQueuedOutbox,
  retainQueuedOutbox
} from './outbox.ts'

const input = [{ type: 'text' as const, text: '继续补充证据' }]

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
  const pending = optimisticQueuedMessage([], 'client-1', input, [])
  const conversation = [{
    kind: 'user' as const,
    text: '继续补充证据',
    itemId: 'client-1'
  }]

  assert.equal(shouldPresentQueuedMessage(pending, conversation), false)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'queued' }, conversation), false)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'waiting_resources' }, conversation), true)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'failed' }, conversation), true)
  assert.equal(shouldPresentQueuedMessage({ ...pending, state: 'outcome_unknown' }, conversation), true)
  assert.equal(shouldPresentQueuedMessage(pending, []), true)
})

test('hides queue recovery when the turn recovery card owns confirmation', () => {
  const pending = {
    ...optimisticQueuedMessage([], 'client-1', input, []),
    state: 'outcome_unknown' as const,
    nativeTurnId: 'turn-1'
  }
  const conversation = [{
    kind: 'error' as const,
    title: '上次任务已中断',
    message: '应用在任务结束前中断，部分操作可能已完成。',
    action: '是否继续对话？',
    runtimeAction: 'confirm_turn_unknown' as const,
    actionTurnId: 'turn-1',
    actionState: 'idle' as const
  }]

  assert.equal(shouldPresentQueuedMessage(pending, conversation), false)
  assert.equal(shouldPresentQueuedMessage({ ...pending, nativeTurnId: 'turn-2' }, conversation), true)
})

test('reports only pre-runtime queue states as awaiting execution', () => {
  const pending = optimisticQueuedMessage([], 'client-1', input, [])

  assert.equal(hasQueuedMessageAwaitingRuntime([pending]), true)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'queued' }]), true)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'waiting_resources' }]), false)
  assert.equal(hasQueuedMessageAwaitingRuntime([{ ...pending, state: 'failed' }]), false)
  assert.equal(hasQueuedMessageAwaitingRuntime([]), false)
})

test('reconciles the optimistic queue row with the authoritative event by id', () => {
  const optimistic = optimisticQueuedMessage([], 'client-1', input, [])
  const authoritative = queuedMessageFromPayload({
    queued_message_id: 'client-1',
    enqueue_seq: 7,
    state: 'queued',
    input
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
    input,
    assistant_references: [{
      kind: 'note',
      ref_id: 'note-1',
      surface: {
        selected_text: '完整选区原文',
        preview_text: '完整选区',
        comment: '补充这条依据'
      }
    }]
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
})

test('resource waits retain deadline, purpose, request identity and frozen references', () => {
  const waiting = queuedMessageFromPayload({
    queued_message_id: 'wait-1',
    enqueue_seq: 3,
    state: 'waiting_resources',
    deadline: 12345,
    purpose: 'turn',
    input,
    assistant_context_revision: 8,
    assistant_references: [{ ref_id: 'ref-1', label: '研究记录' }]
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
      queued_message_id: 'client-1', enqueue_seq: 1, state, input
    })
    assert.deepEqual(
      settleOptimisticQueuedMessage([authoritative], 'client-1'),
      [authoritative]
    )
  }
  assert.deepEqual(settleOptimisticQueuedMessage([], 'already-started'), [])
})

test('a transport failure does not overwrite an authoritative queue state', () => {
  for (const state of ['waiting_resources', 'submitting', 'queued'] as const) {
    const authoritative = queuedMessageFromPayload({
      queued_message_id: 'client-1', enqueue_seq: 1, state, input
    })
    assert.deepEqual(
      markOptimisticQueueOutcomeUnknown([authoritative], 'client-1'),
      [authoritative]
    )
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
    queued_message_id: 'waiting-2', enqueue_seq: 2, state: 'waiting_resources', input
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
    queued_message_id: 'server-2', enqueue_seq: 2, state: 'queued', input
  })

  assert.deepEqual(
    rejectOptimisticQueuedMessage([optimistic, authoritative], 'client-1'),
    [authoritative]
  )
  assert.deepEqual(
    rejectOptimisticQueuedMessage([authoritative], 'server-2'),
    [authoritative]
  )
})

test('restores an unacknowledged local outbox row and clears it on server acknowledgement', () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value)
      }
    }
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
    input
  })
  assert.deepEqual(mergeQueuedOutbox('session-outbox', [authoritative]), [authoritative])
  assert.deepEqual(mergeQueuedOutbox('session-outbox', []), [])
  releaseQueuedOutbox('session-outbox', 'client-outbox')
})

test('queue failure codes translate while unknown codes use state-specific fallbacks', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'zh', fallbackLng: 'en', resources: {
    zh: { components: zh }, en: { components: en }
  } })
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
    queuedMessageErrorText('runtime_turn_failed', 'outcome_unknown', translate),
    zh.composer.runtimeTurnFailed
  )
  assert.equal(
    queuedMessageErrorText('service supplied detail', 'failed', translate),
    zh.composer.queueFailed
  )
  assert.equal(
    queuedMessageErrorText('constructor', 'failed', translate),
    zh.composer.queueFailed
  )
  for (const errorCode of [
    'session_model_switch_failed',
    'resource_baseline_failed',
    'queued_message_not_sendable',
    'assistant_context_unavailable',
    'assistant_context_revision_conflict',
    'runtime_credential_alignment_failed'
  ]) {
    const message = queuedMessageErrorText(errorCode, 'outcome_unknown', translate)
    assert.equal(message, zh.composer.stillUnknown)
    assert.notEqual(message, errorCode)
  }
  await instance.changeLanguage('en')
  assert.equal(
    queuedMessageErrorText('runtime_resource_wait_timeout', 'waiting_resources', translate),
    en.composer.resourceWaitTimeout
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
    queued_message_id: 'unknown-1', enqueue_seq: 1, state: 'outcome_unknown',
    safe_error: 'runtime_turn_failed', native_turn_id: 'native-1', input
  })
  const queued = queuedMessageFromPayload({
    queued_message_id: 'queued-2', enqueue_seq: 2, state: 'queued', input
  })

  assert.equal(unknown.nativeTurnId, 'native-1')
  assert.equal(queued.nativeTurnId, undefined)
  assert.equal(queueBlockedByUnconfirmed([unknown, queued]), true)
  assert.equal(queueBlockedByUnconfirmed([queued]), false)
  assert.equal(queueBlockedByUnconfirmed([]), false)
  const failed = { ...unknown, state: 'failed' as const }
  assert.equal(queueBlockedByUnconfirmed([failed, queued]), false)
})
